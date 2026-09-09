import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CircuitBreaker } from "../../shared/backend.ts";
import {
  defaultGatewaySettings,
  GATEWAY_SETTING_DEFS,
  GATEWAY_SETTING_KEYS,
  type GatewaySettings,
} from "../../shared/gateway-settings.ts";
import { canonicalIp, effectiveClientIp, ipInCidr } from "../../shared/net.ts";
import { DEFAULT_DRAIN_MS, drain, onShutdown } from "../../shared/shutdown.ts";
import { AccessLogWriter } from "./accesslog.ts";
import { ArtifactCache } from "./artifacts.ts";
import { TokenCache } from "./backend-auth.ts";
import { ResponseCache } from "./cache.ts";
import { ConcurrencyGate } from "./concurrency.ts";
import { ConfigClient } from "./config-client.ts";
import { IntrospectionCache, JwksCache } from "./identity.ts";
import { handleRequest, type PipelineResult } from "./pipeline.ts";
import { QuotaCounters } from "./quota.ts";
import { problem } from "./respond.ts";
import { RateLimiter } from "./ratelimit.ts";
import { StreamRegistry, WebSocketBridge, type UpgradeIntent } from "./stream.ts";
import { InstanceTelemetry } from "./telemetry.ts";
import { BlockingBudget, Sampler, ValidationCounterSet, ValidationPool } from "./validate.ts";

/**
 * The standalone gateway (design section 8): its own process, deployed and scaled independently
 * of the control plane, and able to keep serving without it. It consumes one JSON config
 * document over HTTP and is never a source of truth.
 *
 * Design section 8.1 puts TLS, HTTP hardening and coarse edge limits on the reverse proxy in
 * front. There is none here, so `X-Forwarded-For` is replaced rather than trusted unless
 * TRUSTED_PROXY_CIDRS says otherwise, and no policy reads a client certificate.
 */
export interface DpConfig {
  port: number;
  name: string;
  cpUrl: string;
  token: string;
  cachePath: string;
  /**
   * The cadence of the channel everything else arrives on, which is why it is here and not in
   * `settings`: a mistake in it slows down its own correction. See `shared/gateway-settings.ts`.
   */
  pollIntervalMs: number;
  trustedProxyCidrs: string[];
  /**
   * What this process serves with until its first configuration document arrives — this build's
   * defaults, not anything read from the environment. Every value in it is the control plane's to
   * decide, resolved per gateway from the fleet, environment and gateway layers, and replaced
   * wholesale on activation. A test overrides it to start a plane somewhere other than the
   * defaults; a deployment does not, because there is nowhere in a compose file left to say so.
   */
  settings: GatewaySettings;
  /**
   * `SO_REUSEPORT`: several gateway processes accept on one port and the kernel spreads
   * connections across them. Bun serves HTTP from a single JavaScript thread, so one process uses
   * roughly one core however many the machine has; this is how the other cores are used.
   *
   * It is opt-in and not free. Each process keeps its **own** rate-limit counters (design section
   * 5.7 already scopes them per instance), so N processes behind one port multiply an effective
   * limit by N in the same way N instances do — except that the fleet view shows one instance, so
   * the arithmetic is no longer visible in the UI. Telemetry is unaffected: rollups are keyed by
   * `run_id`, which is already per process.
   */
  reusePort: boolean;
  /**
   * Where the access-log lines go. Unset means stdout, which is what a container whose log driver
   * collects stdout wants. A path is what an estate that ships with Logstash wants: the shipper
   * tails the file, and this process rotates it — renaming and reopening rather than truncating,
   * which is the mode a tailing shipper handles without losing the tail of a file it has not
   * finished.
   *
   * **One path per process**, which is what keeps it here rather than in `settings`: two gateways
   * handed one path would interleave their buffers and race each other's rotation, so this is a
   * fact about a container and not something a fleet can be told. Whether there are lines at all,
   * and how large the file grows, are the fleet's decisions.
   */
  accessLogPath?: string;
  /**
   * Where compiled validators and backend client certificates persist across restarts (design
   * section 8.7). Persisted rather than in memory, so a restart does not re-download the estate's
   * schemas and a control-plane outage during a rolling restart does not leave instances unable to
   * validate. One directory per process, like the config cache, for the same reason.
   */
  artifactCachePath: string;
  /**
   * The header names the reverse proxy uses to report a verified client certificate. Configurable
   * because nginx, F5 and Envoy each spell them differently, and a gateway that hard-codes one
   * vendor's spelling silently reads no certificate at all behind another's.
   *
   * Beside `trustedProxyCidrs` and not in `settings` deliberately: these two decide whether a
   * header counts as an identity, which is a fact about the network in front of one container. A
   * fleet-wide switch for it would be a fleet-wide authorization bypass.
   */
  clientCertHeaders: { dn: string; issuer: string; verify: string; fingerprint: string; san: string };
  /**
   * Whether the platform's own system trust store is unioned with the environment's registered
   * anchors (plan §8.3). Setting `tls.ca` *replaces* the default store rather than adding to it, so
   * the union is explicit — and `TRUST_SYSTEM_ROOTS=0` is available for an estate that wants only
   * its own PKI. That is a configured choice with a log line, not something to arrive at by
   * accident.
   */
  trustSystemRoots: boolean;
  /**
   * The wire version this build speaks, overridable so version skew is testable at all (plan §10).
   * Left undefined everywhere but in a test, where `CONFIG_VERSION` is what a real gateway sends.
   */
  wireVersion?: number;
  quiet?: boolean;
}

const CLIENT_CERT_HEADER_DEFAULTS = {
  dn: "x-client-cert-subject-dn",
  issuer: "x-client-cert-issuer-dn",
  verify: "x-client-cert-verify",
  fingerprint: "x-client-cert-fingerprint",
  san: "x-client-cert-san",
} as const;

/**
 * `dn=ssl-client-subject-dn,verify=ssl-client-verify` — named pairs rather than a positional list,
 * because a five-element positional list is unreadable and one misplaced entry would mean reading
 * the issuer as the subject.
 */
export function parseClientCertHeaders(raw: string | undefined): DpConfig["clientCertHeaders"] {
  const names = { ...CLIENT_CERT_HEADER_DEFAULTS };
  for (const pair of (raw ?? "").split(",")) {
    const [key, value] = pair.split("=").map((part) => part.trim().toLowerCase());
    if (!key || !value) continue;
    if (!(key in names)) {
      throw new Error(
        `TRUSTED_PROXY_CLIENT_CERT_HEADERS: "${key}" is not one of ${Object.keys(names).join(", ")}`,
      );
    }
    names[key as keyof typeof names] = value as never;
  }
  return names;
}

/** `--port`, `--name` and `--cache` are flags; the token never is (review V1-12). */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < Bun.argv.length; i++) {
    const arg = Bun.argv[i]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) return Bun.argv[i + 1];
  }
  return undefined;
}

function readToken(): string {
  const file = process.env.GATEWAY_TOKEN_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return process.env.GATEWAY_TOKEN ?? "";
}

/**
 * `settings` is merged rather than replaced, so a caller that wants one different starting value
 * does not have to restate the other fifteen.
 */
export type DpConfigOverrides = Partial<Omit<DpConfig, "settings">> & {
  settings?: Partial<GatewaySettings>;
};

/**
 * Everything a gateway container is told, which since v6 is only what a process needs before it can
 * poll: who it is, where the control plane is, where its own files go, and what the network in
 * front of it is. The ceilings, the caches and the counters are the fleet's, and arrive over the
 * poll — see `shared/gateway-settings.ts` for the entry criterion and for what stayed here.
 *
 * A variable that was moved and is still set in a compose file is a startup failure that names it
 * and says where the setting lives now, because the alternative is an operator who edited a number
 * and watched nothing happen.
 */
export function loadDpConfig(overrides: DpConfigOverrides = {}): DpConfig {
  const token = overrides.token ?? readToken();
  if (!token) {
    throw new Error(
      "GATEWAY_TOKEN (or GATEWAY_TOKEN_FILE) is required: the data plane polls the control plane " +
        "with a per-instance bearer token. Run `bun run seed` to mint the fleet's tokens; it " +
        "writes one env file per instance under .data/env/.",
    );
  }
  const name = overrides.name ?? flag("name") ?? process.env.DP_NAME ?? "dev-1";
  assertNoRetiredSettings(process.env);
  return {
    port: Number(flag("port") ?? process.env.DP_PORT ?? 8081),
    name,
    cpUrl: process.env.GATEWAY_CP_URL ?? "http://localhost:8080",
    token,
    // One cache file per process: four gateways sharing one path would interleave writes.
    cachePath: flag("cache") ?? process.env.GATEWAY_CONFIG_CACHE ?? `.data/dp-${name}-config.json`,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_SEC ?? 2) * 1000,
    trustedProxyCidrs: (process.env.TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    reusePort: process.env.DP_REUSE_PORT === "1",
    ...(process.env.DP_ACCESS_LOG_PATH ? { accessLogPath: process.env.DP_ACCESS_LOG_PATH } : {}),
    artifactCachePath: process.env.GATEWAY_ARTIFACT_CACHE ?? `.data/dp-${name}-artifacts`,
    clientCertHeaders: parseClientCertHeaders(process.env.TRUSTED_PROXY_CLIENT_CERT_HEADERS),
    trustSystemRoots: process.env.TRUST_SYSTEM_ROOTS !== "0",
    ...overrides,
    // After the spread, and merged rather than replaced: a caller changing one starting value keeps
    // the defaults for the rest.
    settings: { ...defaultGatewaySettings(), ...overrides.settings },
  };
}

/**
 * A variable that moved into the configuration document, still set on this container.
 *
 * This is a startup failure rather than a warning, and it is the whole upgrade path. The shipped
 * compose file used to set several of these to values well above the code defaults — a 48 MiB body
 * cap, an 8192-request ceiling — so ignoring them on upgrade would quietly *lower* a running
 * estate's limits, and honouring them would keep a fleet's configuration in N places, which is the
 * thing this change exists to end. Refusing names the variable, the setting that replaced it, and
 * where to set it, in the shape `runtime-configuration` requires of every configuration refusal.
 */
export function assertNoRetiredSettings(env: Record<string, string | undefined>): void {
  const found: string[] = [];
  for (const key of GATEWAY_SETTING_KEYS) {
    const variable = GATEWAY_SETTING_DEFS[key].env;
    if ((env[variable] ?? "") !== "") found.push(`${variable} is now the "${key}" gateway setting`);
  }
  if (found.length === 0) return;
  throw new Error(
    `${found.length} retired environment variable(s) are set on this gateway:\n  ${found.join("\n  ")}\n` +
      "These are decided by the control plane now and travel in the configuration document, so " +
      "every gateway in a fleet has one value and it is visible in one place. Set them on the " +
      "portal's gateway settings — fleet-wide, per environment, or on this gateway alone — and " +
      "remove them from this container's environment. Until then this gateway refuses to start " +
      "rather than serve with a limit its own compose file appears to set and does not.",
  );
}

export class DataPlane {
  readonly client: ConfigClient;
  readonly limiter = new RateLimiter();
  readonly gate: ConcurrencyGate;
  readonly telemetry: InstanceTelemetry;
  /**
   * Everything below outlives a config swap, and that is deliberate in each case: a JWKS key set,
   * an introspection verdict, a backend token and a breaker's opinion of a backend are all facts
   * about the world rather than about the configuration, and throwing them away on every revision
   * would turn a routine publish into a thundering herd. What a swap *does* invalidate — the
   * response cache, the sampler's cold-start burst, streams whose subscription is gone — the config
   * client clears explicitly.
   */
  readonly artifacts: ArtifactCache;
  readonly quota = new QuotaCounters();
  readonly jwks: JwksCache;
  readonly introspection = new IntrospectionCache();
  readonly tokens = new TokenCache();
  readonly breaker = new CircuitBreaker();
  readonly streams: StreamRegistry;
  readonly cache: ResponseCache;
  readonly sampler = new Sampler();
  readonly pool: ValidationPool;
  readonly counters = new ValidationCounterSet();
  readonly budget: BlockingBudget;
  /**
   * Absent when the `accessLog` setting is off, which is also what tells the pipeline not to build
   * a record. Not `readonly`: the setting can be turned off and on again on a running fleet, and
   * the writer holds a file handle and a flush timer, so the toggle opens and closes it rather than
   * leaving one idle.
   */
  accessLog: AccessLogWriter | null;
  /**
   * What this instance is currently enforcing. Replaced wholesale when a document is activated, so
   * every read site sees one coherent set rather than a half-applied mixture — and reported on
   * `/healthz`, so "did that change reach this replica" is answerable per process rather than
   * inferred from the digest.
   */
  settings: GatewaySettings;
  /** Whether a client-certificate policy may be activated here at all (design section 8.1). */
  readonly trustedProxyConfigured: boolean;
  /** Fresh per process, so a restart writes new rollup rows instead of replacing a window. */
  readonly runId = `run_${randomUUID().slice(0, 8)}`;
  readonly startedAt = new Date().toISOString();
  /** Requests accepted but not yet answered — the quantity memory scales with under load. */
  inFlight = 0;
  peakInFlight = 0;
  /**
   * Every request this process has answered, counted whether or not telemetry is on.
   * `requestsTotal` below is telemetry's own count and is zero when counting is off, which makes
   * it useless as a denominator for "CPU per request".
   */
  served = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly config: DpConfig) {
    const settings = config.settings;
    this.settings = settings;
    this.accessLog = this.openAccessLog(settings);
    this.gate = new ConcurrencyGate(settings.maxConcurrentRequests);
    this.telemetry = new InstanceTelemetry({
      maxSeries: settings.telemetryMaxSeries,
      maxWindowsPerReport: settings.telemetryMaxWindowsPerReport,
    });
    this.trustedProxyConfigured = config.trustedProxyCidrs.length > 0;
    this.jwks = new JwksCache({
      minRefetchMs: settings.jwksMinRefetchSec * 1000,
      log: (message) => console.warn(message),
    });
    this.artifacts = new ArtifactCache({
      directory: config.artifactCachePath,
      cpUrl: config.cpUrl,
      token: config.token,
      maxBytes: settings.artifactCacheMaxBytes,
      log: (message) => console.warn(message),
    });
    this.streams = new StreamRegistry(settings.maxConcurrentUpgrades);
    this.cache = new ResponseCache(settings.responseCacheMaxEntries, settings.responseCacheMaxBytes);
    this.pool = new ValidationPool(settings.validatePoolSize, settings.validateQueueDepth);
    this.budget = new BlockingBudget(settings.blockingBufferBudgetBytes);
    this.client = new ConfigClient({
      cpUrl: config.cpUrl,
      token: config.token,
      cachePath: config.cachePath,
      pollIntervalMs: config.pollIntervalMs,
      name: config.name,
      runId: this.runId,
      startedAt: this.startedAt,
      telemetry: this.telemetry,
      artifacts: this.artifacts,
      quota: this.quota,
      streams: this.streams,
      sampler: this.sampler,
      validation: this.counters,
      responseCache: this.cache,
      trustedProxyConfigured: this.trustedProxyConfigured,
      trustSystemRoots: config.trustSystemRoots,
      // How the document's `settings` block reaches this process, and the one way it can be
      // refused. Both are passed in rather than reached for, because the config client owns the
      // decision to activate and this is part of that decision (design section 8.5).
      settings: {
        blockerFor: (next) => this.settingsBlocker(next),
        apply: (next) => this.applySettings(next),
      },
      ...(config.wireVersion === undefined ? {} : { wireVersion: config.wireVersion }),
    });
  }

  private openAccessLog(settings: GatewaySettings): AccessLogWriter | null {
    if (this.config.quiet || !settings.accessLog) return null;
    return new AccessLogWriter({
      ...(this.config.accessLogPath ? { path: this.config.accessLogPath } : {}),
      maxBytes: settings.accessLogMaxBytes,
      keep: settings.accessLogKeep,
    });
  }

  /**
   * Why this container cannot honour these settings, or `null`.
   *
   * The activation-time twin of `assertOutboundCeiling`. That check exists because the runtime's
   * outbound queue is set by an environment variable the gateway cannot set for itself, and it runs
   * at boot — which was enough while the ceiling it guards was also an environment variable on the
   * same container. Now that the ceiling is the fleet's, an administrator setting 16,384 from a
   * browser can name a number this particular container's runtime will not honour, and the failure
   * that would follow is the one the boot check was written to prevent: one slow backend delaying
   * every other route, on the instances that happen to be smaller.
   *
   * So it is refused instead — the document is not activated, whatever is already serving keeps
   * serving, and the reason travels on the next poll and appears against this replica in the fleet
   * view. Unlike a missing trust boundary this is not fatal: correcting the setting centrally makes
   * the next poll succeed, so an instance with nothing to serve waits rather than exits.
   */
  settingsBlocker(next: GatewaySettings, env = process.env): string | null {
    const queue = Number(env.BUN_CONFIG_MAX_HTTP_REQUESTS);
    if (!Number.isInteger(queue) || queue < 1) return null;
    if (next.maxConcurrentRequests <= queue) return null;
    return (
      `the maxConcurrentRequests setting (${next.maxConcurrentRequests}) is above this container's ` +
      `BUN_CONFIG_MAX_HTTP_REQUESTS (${queue}), so the runtime's shared outbound queue would be ` +
      "reached before this gateway's own ceiling and a slow backend would be queued rather than " +
      "shed. Lower the setting, or raise the variable on this container and restart it"
    );
  }

  /**
   * Apply a resolved settings block to the live process. Every component here holds its bound as a
   * number rather than as preallocated capacity, which is what makes this a set of assignments
   * instead of a restart — and is the entry criterion for a setting existing at all.
   *
   * Nothing in flight is disturbed. A ceiling lowered below what is currently in use is not an
   * error: the gate sheds and the caches evict until they are under it, which is the same
   * behaviour as arriving at the ceiling under load.
   */
  applySettings(next: GatewaySettings): void {
    const previous = this.settings;
    this.settings = next;
    this.gate.resize(next.maxConcurrentRequests);
    this.streams.resize(next.maxConcurrentUpgrades);
    this.cache.resize(next.responseCacheMaxEntries, next.responseCacheMaxBytes);
    this.pool.resize(next.validatePoolSize, next.validateQueueDepth);
    this.budget.resize(next.blockingBufferBudgetBytes);
    this.artifacts.resize(next.artifactCacheMaxBytes);
    this.telemetry.resize(next.telemetryMaxSeries, next.telemetryMaxWindowsPerReport);
    this.jwks.setMinRefetchMs(next.jwksMinRefetchSec * 1000);
    if (next.accessLog !== previous.accessLog) {
      // A toggle is a real open or close, so the file handle and the flush timer follow the switch.
      // Logged whichever way it went: a gateway that stopped recording what it served should say
      // so once in the log that is about to end.
      if (next.accessLog) {
        this.accessLog = this.openAccessLog(next);
        console.log(`[dp] access log on (${this.accessLog?.destination ?? "off"})`);
      } else {
        console.log("[dp] access log off — configured centrally");
        this.accessLog?.close();
        this.accessLog = null;
      }
    } else {
      this.accessLog?.resize(next.accessLogMaxBytes, next.accessLogKeep);
    }
  }

  async start(): Promise<void> {
    await this.client.start();
    this.sweepTimer = setInterval(() => {
      this.limiter.sweep();
      this.quota.sweep();
      this.breaker.sweep();
    }, 60_000);
  }

  stop(): void {
    this.client.stop();
    // A stream is the one thing that outlives the request that opened it, so it is the one thing
    // shutdown has to end explicitly.
    this.streams.closeAll("shutdown");
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Last, so anything the lines above logged is on disk before the process is gone.
    this.accessLog?.close();
  }

  /**
   * Unauthenticated, and deliberately so (review V4-05): design section 8.1 puts a reverse proxy
   * in front that does not publish this path, and the body carries counters and a digest — no
   * request content, no consumer identity, no key material.
   */
  health(): Record<string, unknown> {
    const table = this.client.table;
    const staleAfterMs = Math.max(3 * this.config.pollIntervalMs, 10_000);
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    return {
      ok: !this.client.decommissioned && table !== null,
      service: "data-plane",
      name: this.config.name,
      runId: this.runId,
      environment: table?.environment ?? null,
      configDigest: table?.digest ?? null,
      routes: table?.routes.length ?? 0,
      subscriptions: table?.subscriptionCount ?? 0,
      // G4: how many certificate authorities this instance currently trusts beyond the system
      // store, so "did the anchor reach the fleet" is answerable per instance rather than inferred
      // from a backend call succeeding.
      trustAnchors: table?.trust.liveCount() ?? 0,
      trustSystemRoots: this.config.trustSystemRoots,
      lastPollAt: this.client.lastPollAt,
      stale: !this.client.lastPollAt || Date.now() - Date.parse(this.client.lastPollAt) > staleAfterMs,
      servingFromCache: this.client.fromCache,
      decommissioned: this.client.decommissioned,
      lastError: this.client.lastError,
      // Why the digest above is not the one the control plane last offered (plan `[R1-21]`).
      activationBlocked: this.client.activationBlocked,
      /**
       * What this replica is actually enforcing, as opposed to what the control plane last
       * resolved. The two agree once a document is activated, and the point of reporting them here
       * is the moment they do not: an instance that refused a document is on the previous
       * settings, and this is where that is visible without inferring it from `configDigest`.
       */
      settings: this.settings,
      // A second source for "did every request get counted" (review V1-16).
      requestsTotal: this.telemetry.requestsTotal,
      telemetry: { enabled: this.settings.telemetry, ...this.telemetry.stats() },
      // The gauge that says whether a backend is accumulating work here, and the shed counters
      // that say whether a ceiling has already fired. Both are what an operator looks at first.
      concurrency: this.gate.snapshot(),
      artifacts: this.artifacts.stats(),
      validation: {
        ...this.counters.snapshot(),
        queueDepth: this.pool.depthNow,
        poolDropped: this.pool.dropped,
        blockingBytesInUse: this.budget.inUse,
        blockingBudgetBytes: this.budget.total,
      },
      streams: this.streams.snapshot(),
      responseCache: this.cache.stats(),
      quotaKeys: this.quota.size,
      // Only the backends that are not closed, so a healthy fleet reports an empty array rather
      // than the whole estate.
      breakers: this.breaker.snapshot(),
      // The runtime's own DNS cache, which every backend call goes through. `cacheMisses` climbing
      // in step with request volume is the symptom of an estate with more backend hosts than the
      // cache holds — the one case where activation-time warming (`prefetchBackends`) stops
      // covering the request path, and which is otherwise invisible as backend latency.
      dns: Bun.dns.getCacheStats(),
      process: {
        pid: process.pid,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        uptimeSec: Math.round(process.uptime()),
        inFlight: this.inFlight,
        peakInFlight: this.peakInFlight,
        served: this.served,
      },
    };
  }

  /**
   * `UpgradeIntent` rather than a `Response` when the route is a WebSocket passthrough: the whole
   * request-side pipeline has run and decided to hand the connection over, but only the server can
   * perform the upgrade — it needs the `Server` object, which the pipeline deliberately does not
   * have (design section 5.8).
   */
  async fetch(req: Request, clientIp: string): Promise<PipelineResult> {
    const url = new URL(req.url);
    const requestId = req.headers.get("x-request-id") ?? randomUUID();

    // Reserved: a route base path may not shadow these (rejected at route-write time).
    // Counted below rather than here, so a monitoring probe never appears as traffic.
    if (url.pathname === "/healthz") return Response.json(this.health());
    if (url.pathname === "/readyz") {
      const health = this.health();
      return Response.json(health, { status: health.ok ? 200 : 503 });
    }

    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      return await this.serve(req, url, clientIp, requestId);
    } finally {
      // Resolution of this promise, not delivery of the last byte: a streamed body outlives it.
      this.inFlight--;
      this.served++;
    }
  }

  /**
   * For callers that cannot complete an upgrade — every test, and any embedding that is not a
   * `Bun.serve` handler. An upgrade reaching here is a routing mistake rather than a request
   * failure, so it throws instead of quietly answering 500.
   */
  async fetchHttp(req: Request, clientIp: string): Promise<Response> {
    const result = await this.fetch(req, clientIp);
    if (result instanceof Response) return result;
    throw new Error(
      `${result.resourceName} is a WebSocket passthrough route: it can only be served through ` +
        "startDataPlane(), which owns the upgrade",
    );
  }

  private async serve(
    req: Request,
    url: URL,
    clientIp: string,
    requestId: string,
  ): Promise<PipelineResult> {
    const started = performance.now();
    const countUnserved = (status: number, outcome: "decommissioned" | "no-config") => {
      if (!this.settings.telemetry) return;
      this.telemetry.record({
        resourceId: null,
        subscriptionId: null,
        outcome,
        status,
        durationMs: Math.round(performance.now() - started),
        bytesIn: 0,
        bytesOut: 0,
      });
    };

    if (this.client.decommissioned) {
      countUnserved(503, "decommissioned");
      return problem(
        503,
        "Service Unavailable",
        "this gateway instance's token was revoked by the control plane; it is not serving traffic",
        requestId,
      );
    }
    const table = this.client.table;
    if (!table) {
      countUnserved(503, "no-config");
      return problem(
        503,
        "Service Unavailable",
        "no gateway configuration yet: the control plane has not been reached and there is no cached config",
        requestId,
      );
    }

    return handleRequest(req, {
      table,
      limiter: this.limiter,
      quota: this.quota,
      artifacts: this.artifacts,
      jwks: this.jwks,
      introspection: this.introspection,
      tokens: this.tokens,
      breaker: this.breaker,
      cache: this.cache,
      sampler: this.sampler,
      pool: this.pool,
      counters: this.counters,
      budget: this.budget,
      streams: this.streams,
      maxBodyBytes: this.settings.maxBodyBytes,
      // The address every policy sees. Behind a trusted proxy that is the caller `X-Forwarded-For`
      // names, not the proxy — otherwise an `ipAllow` list admits everyone or nobody.
      clientIp: effectiveClientIp(
        req.headers.get("x-forwarded-for"),
        clientIp,
        this.config.trustedProxyCidrs,
      ),
      // The socket peer, which is what this gateway appends to the chain on the way out.
      // Canonicalised for the same reason `effectiveClientIp` canonicalises what it returns: a
      // dual-stack listener reports an IPv4 peer as `::ffff:a.b.c.d`, and the next hop should be
      // given the address rather than that spelling of it.
      peerIp: canonicalIp(clientIp),
      requestId,
      // Parsed once, above, where `/healthz` and `/readyz` are told apart from traffic.
      url,
      gatewayName: this.config.name,
      runId: this.runId,
      trustedPeer: this.config.trustedProxyCidrs.some((cidr) => ipInCidr(clientIp, cidr)),
      clientCertHeaders: this.config.clientCertHeaders,
      log: this.accessLog ? (record) => this.accessLog!.write(record) : undefined,
      // Absent when counting is off, which is also what tells the pipeline not to wrap the
      // response body in a counting stream.
      record:
        this.settings.telemetry ? (record) => this.telemetry.record(record) : undefined,
      gate: this.gate,
    });
  }
}

/** What travels from the upgrade decision to the socket handlers. */
interface SocketData {
  intent: UpgradeIntent;
  bridge: WebSocketBridge | null;
}

export function startDataPlane(dp: DataPlane) {
  return Bun.serve<SocketData, never>({
    port: dp.config.port,
    idleTimeout: 120,
    reusePort: dp.config.reusePort,
    /**
     * `Bun.serve` is in development mode unless it is told otherwise, and in that mode an uncaught
     * error is answered with a page carrying the message, the stack, **the source around each
     * frame and the file paths** — to whoever sent the request. That is a source-disclosure hole in
     * a process that faces the internet, so it is turned off here rather than through `NODE_ENV`:
     * an environment variable an image or a compose file forgets is a hole that reopens silently,
     * and the local stack and the tests run this same line. `tools/capacity/world.ts` already
     * starts gateways with `NODE_ENV=production`, so this also makes the deployed process match
     * the measured one.
     */
    development: false,
    /**
     * Reached only when something threw where nothing should: every failure the pipeline knows
     * about is already a `Response`. The detail is generic because the exception's message is the
     * one thing the caller must not be told; the id ties the answer to the line in the log that
     * has the message. Not counted in telemetry — an error this far out has no route and no
     * subscription to attribute, and inventing an outcome for it would put a series in the
     * dashboard that means "the gateway has a bug" rather than "this traffic happened".
     */
    error(err) {
      const requestId = randomUUID();
      console.error(`[dp] unhandled error (${requestId}):`, err);
      return problem(
        500,
        "Internal Server Error",
        "the gateway failed while handling this request",
        requestId,
      );
    },
    async fetch(req, server) {
      const result = await dp.fetch(req, server.requestIP(req)?.address ?? "0.0.0.0");
      if (result instanceof Response) return result;

      // The pipeline already authenticated, authorized, rate-limited and admitted this connection;
      // all that is left is the 101. `bridge` is filled in by `open` because the socket does not
      // exist until then.
      if (server.upgrade(req, { data: { intent: result, bridge: null } })) return undefined;

      // The client sent the upgrade headers the route required and the runtime still refused, which
      // in practice means a malformed `Sec-WebSocket-*`. Nothing was registered — the registry only
      // learns about a stream once the bridge opens it — so there is nothing to unwind.
      return problem(
        400,
        "Bad Request",
        "this route is a WebSocket passthrough and the upgrade could not be completed",
        result.requestId,
      );
    },
    websocket: {
      open(ws) {
        const bridge = new WebSocketBridge(ws, ws.data.intent, {
          registry: dp.streams,
          log: dp.accessLog ? (record) => dp.accessLog!.write(record) : undefined,
          record: !dp.settings.telemetry
            ? undefined
            : (bytesIn, bytesOut, durationMs) => {
                // Counted once, when the stream ends: a connection that is open has no duration
                // yet, and counting it at the 101 would put every stream in the sub-millisecond
                // bucket. The status is the 101 the client actually received.
                dp.telemetry.record({
                  resourceId: ws.data.intent.resourceId,
                  subscriptionId: ws.data.intent.subscriptionId,
                  outcome: "stream-closed",
                  status: 101,
                  durationMs,
                  bytesIn,
                  bytesOut,
                });
              },
        });
        ws.data.bridge = bridge;
        bridge.start();
      },
      message(ws, message) {
        ws.data.bridge?.fromClient(message);
      },
      close(ws) {
        ws.data.bridge?.clientClosed();
      },
    },
  });
}

/**
 * The runtime's own ceiling on concurrent outbound HTTP requests, per process, across every
 * origin. It applies whether or not anyone sets it, and its default is far below what a gateway
 * accepts — which makes it a single FIFO queue shared by every route, with no per-route fairness
 * and no shedding. Measured (`reports/capacity-report.md`): with the default, flooding one route
 * whose backend takes two seconds pushed an *unrelated* healthy route's median latency from
 * 0.56 ms to 1,990 ms. One slow backend became a total outage. With it raised above the gateway's
 * own ceiling, the same flood left the healthy route at 0.56 ms.
 *
 * So it is required, and required to be large enough, at the point where a gateway becomes a
 * process. Design section 11: explicit values, and a missing one is a startup failure that names
 * the variable. It cannot be set from inside the process — the runtime reads it at startup — which
 * is exactly why it has to be checked here rather than defaulted somewhere.
 */
export function assertOutboundCeiling(config: DpConfig, env = process.env): void {
  const raw = env.BUN_CONFIG_MAX_HTTP_REQUESTS;
  const wanted = config.settings.maxConcurrentRequests;
  const advice =
    `Set BUN_CONFIG_MAX_HTTP_REQUESTS to at least this gateway's maxConcurrentRequests setting ` +
    `(${wanted}) so that its own per-route ceilings bind before the runtime's shared queue does. ` +
    "`bun run seed` writes it into every gateway's env file. The setting itself is the control " +
    "plane's, so the pairing is checked again whenever a document raises it — see " +
    "`DataPlane.settingsBlocker`.";
  if (raw === undefined || raw === "") {
    throw new Error(
      `BUN_CONFIG_MAX_HTTP_REQUESTS is required: unset, the runtime queues outbound requests at a ` +
        `default far below what this gateway will accept, and one slow backend then delays every ` +
        `other route on this instance. ${advice}`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`BUN_CONFIG_MAX_HTTP_REQUESTS: expected a positive integer, got "${raw}". ${advice}`);
  }
  if (value < wanted) {
    throw new Error(
      `BUN_CONFIG_MAX_HTTP_REQUESTS (${value}) is below this gateway's maxConcurrentRequests ` +
        `(${wanted}): the runtime's shared outbound queue would be reached before this gateway's ` +
        `own ceiling, so a slow backend would be queued rather than shed. ${advice}`,
    );
  }
}

if (import.meta.main) {
  const dp = new DataPlane(loadDpConfig());
  assertOutboundCeiling(dp.config);
  await dp.start();
  const server = startDataPlane(dp);
  // Without this the runtime never receives SIGTERM at all — see `shared/shutdown.ts` for the PID 1
  // rule that makes an unhandled signal disappear. The order is the whole content of the handler:
  // stop accepting first, so nothing writes a line after `dp.stop()` has flushed and closed the
  // access log.
  onShutdown("dp", async () => {
    await drain(server, DEFAULT_DRAIN_MS);
    dp.stop();
  });
  console.log(
    `[dp] ${dp.config.name} on http://localhost:${server.port} — control plane ${dp.config.cpUrl}, ` +
      `poll ${dp.config.pollIntervalMs}ms, cache ${dp.config.cachePath}, ` +
      // The starting values. The fleet's settings arrive with the first document, and `/healthz`
      // reports what is actually in force from then on.
      `max ${dp.settings.maxConcurrentRequests} concurrent` +
      (dp.settings.accessLog ? "" : ", access log off") +
      (dp.config.reusePort ? ", reusePort (rate limits are per process)" : ""),
  );
}

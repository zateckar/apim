import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CircuitBreaker } from "../../shared/backend.ts";
import { effectiveClientIp, ipInCidr } from "../../shared/net.ts";
import { TELEMETRY_DEFAULTS } from "../../shared/telemetry.ts";
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
  pollIntervalMs: number;
  maxBodyBytes: number;
  trustedProxyCidrs: string[];
  maxSeries: number;
  maxWindowsPerReport: number;
  /**
   * `off` stops this gateway counting anything: no per-request record, and the response body is
   * handed through rather than pulled through a counting transform. It is a real operational
   * choice — counting is per byte on the response path — and it is what makes the cost
   * measurable instead of assumed. The trade is that the Telemetry view goes blank for this
   * instance.
   */
  telemetry: "on" | "off";
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
   * One JSON line per request on stdout. On by default, because a gateway that answers requests
   * without recording that it did is not operable — but `DP_ACCESS_LOG=off` exists because the
   * write is synchronous work on the request path and, unlike telemetry, it is the same cost per
   * request whatever the body size. What it costs is measured in `reports/capacity-report.md` rather
   * than guessed at.
   *
   * Until now this was reachable only from code (`quiet`), which meant a gateway started as a
   * process had no way to turn it off.
   */
  accessLog: boolean;
  /**
   * The most requests this instance will have in flight to backends at once, across every route.
   * The backstop under the per-route `concurrency` policy unit: it covers routes with no unit
   * attached, and any combination of per-route ceilings that together exceed what one process can
   * carry. At the ceiling requests are shed with 503, never queued (plan G7).
   *
   * Sized from the capacity measurements, not guessed: one process was comfortable holding about a
   * thousand parked requests, so the default leaves headroom above that and well below the point
   * where sockets and buffers become the problem.
   */
  maxConcurrentRequests: number;
  /**
   * Where compiled validators and backend client certificates persist across restarts (design
   * section 8.7). Persisted rather than in memory, so a restart does not re-download the estate's
   * schemas and a control-plane outage during a rolling restart does not leave instances unable to
   * validate. One directory per process, like the config cache, for the same reason.
   */
  artifactCachePath: string;
  artifactCacheMaxBytes: number;
  /**
   * The ceiling on bytes held for blocking validation across every in-flight request (design
   * section 8.4). The real quantity is `maxBodyBytes × concurrent blocking requests`, which with
   * the defaults would be 16 GB — so it is bounded here, and past the ceiling a request is shed
   * with 503 rather than validated half-way or let through unvalidated.
   */
  blockingBufferBudgetBytes: number;
  /** Design section 8.4's bounded pool for `warning`-mode samples, and the queue in front of it. */
  validatePoolSize: number;
  validateQueueDepth: number;
  /** Instance-wide concurrent WebSocket + SSE ceiling (design section 5.8). */
  maxConcurrentUpgrades: number;
  responseCacheMaxEntries: number;
  responseCacheMaxBytes: number;
  /**
   * The header names the reverse proxy uses to report a verified client certificate. Configurable
   * because nginx, F5 and Envoy each spell them differently, and a gateway that hard-codes one
   * vendor's spelling silently reads no certificate at all behind another's.
   */
  clientCertHeaders: { dn: string; issuer: string; verify: string; fingerprint: string; san: string };
  /**
   * How often a JWKS may be refetched when a token arrives with a `kid` this instance does not
   * hold. It bounds two opposite risks and the number is the trade between them: too high and a key
   * rotation costs that long in 401s, too low and any caller can make this gateway hammer the
   * identity provider by minting tokens with invented `kid`s.
   */
  jwksMinRefetchMs: number;
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

export function loadDpConfig(overrides: Partial<DpConfig> = {}): DpConfig {
  const token = overrides.token ?? readToken();
  if (!token) {
    throw new Error(
      "GATEWAY_TOKEN (or GATEWAY_TOKEN_FILE) is required: the data plane polls the control plane " +
        "with a per-instance bearer token. Run `bun run seed` to mint the fleet's tokens; it " +
        "writes one env file per instance under .data/env/.",
    );
  }
  const name = overrides.name ?? flag("name") ?? process.env.DP_NAME ?? "dev-1";
  return {
    port: Number(flag("port") ?? process.env.DP_PORT ?? 8081),
    name,
    cpUrl: process.env.GATEWAY_CP_URL ?? "http://localhost:8080",
    token,
    // One cache file per process: four gateways sharing one path would interleave writes.
    cachePath: flag("cache") ?? process.env.GATEWAY_CONFIG_CACHE ?? `.data/dp-${name}-config.json`,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_SEC ?? 2) * 1000,
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024),
    trustedProxyCidrs: (process.env.TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxSeries: Number(process.env.TELEMETRY_MAX_SERIES ?? TELEMETRY_DEFAULTS.maxSeries),
    maxWindowsPerReport: Number(
      process.env.TELEMETRY_MAX_WINDOWS_PER_REPORT ?? TELEMETRY_DEFAULTS.maxWindowsPerReport,
    ),
    telemetry: process.env.DP_TELEMETRY === "off" ? "off" : "on",
    reusePort: process.env.DP_REUSE_PORT === "1",
    accessLog: process.env.DP_ACCESS_LOG !== "off",
    maxConcurrentRequests: Number(process.env.MAX_CONCURRENT_REQUESTS ?? 2048),
    artifactCachePath: process.env.GATEWAY_ARTIFACT_CACHE ?? `.data/dp-${name}-artifacts`,
    artifactCacheMaxBytes: Number(process.env.ARTIFACT_CACHE_MAX_BYTES ?? 512 * 1024 * 1024),
    blockingBufferBudgetBytes: Number(
      process.env.BLOCKING_BUFFER_BUDGET_BYTES ?? 256 * 1024 * 1024,
    ),
    // Sized to cores rather than to a constant: the pool exists to keep validation off the request
    // path, and past the core count it stops being concurrency and starts being a queue.
    validatePoolSize: Number(process.env.VALIDATE_POOL_SIZE ?? 4),
    validateQueueDepth: Number(process.env.VALIDATE_QUEUE_DEPTH ?? 256),
    maxConcurrentUpgrades: Number(process.env.MAX_CONCURRENT_UPGRADES ?? 1024),
    responseCacheMaxEntries: Number(process.env.RESPONSE_CACHE_MAX_ENTRIES ?? 10_000),
    responseCacheMaxBytes: Number(process.env.RESPONSE_CACHE_MAX_BYTES ?? 64 * 1024 * 1024),
    clientCertHeaders: parseClientCertHeaders(process.env.TRUSTED_PROXY_CLIENT_CERT_HEADERS),
    jwksMinRefetchMs: Number(process.env.JWKS_MIN_REFETCH_SEC ?? 60) * 1000,
    trustSystemRoots: process.env.TRUST_SYSTEM_ROOTS !== "0",
    ...overrides,
  };
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
    this.gate = new ConcurrencyGate(config.maxConcurrentRequests);
    this.telemetry = new InstanceTelemetry({
      maxSeries: config.maxSeries,
      maxWindowsPerReport: config.maxWindowsPerReport,
    });
    this.trustedProxyConfigured = config.trustedProxyCidrs.length > 0;
    this.jwks = new JwksCache({
      minRefetchMs: config.jwksMinRefetchMs,
      log: (message) => console.warn(message),
    });
    this.artifacts = new ArtifactCache({
      directory: config.artifactCachePath,
      cpUrl: config.cpUrl,
      token: config.token,
      maxBytes: config.artifactCacheMaxBytes,
      log: (message) => console.warn(message),
    });
    this.streams = new StreamRegistry(config.maxConcurrentUpgrades);
    this.cache = new ResponseCache(config.responseCacheMaxEntries, config.responseCacheMaxBytes);
    this.pool = new ValidationPool(config.validatePoolSize, config.validateQueueDepth);
    this.budget = new BlockingBudget(config.blockingBufferBudgetBytes);
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
      ...(config.wireVersion === undefined ? {} : { wireVersion: config.wireVersion }),
    });
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
      // A second source for "did every request get counted" (review V1-16).
      requestsTotal: this.telemetry.requestsTotal,
      telemetry: { enabled: this.config.telemetry === "on", ...this.telemetry.stats() },
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
      if (this.config.telemetry === "off") return;
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
      maxBodyBytes: this.config.maxBodyBytes,
      // The address every policy sees. Behind a trusted proxy that is the caller `X-Forwarded-For`
      // names, not the proxy — otherwise an `ipAllow` list admits everyone or nobody.
      clientIp: effectiveClientIp(
        req.headers.get("x-forwarded-for"),
        clientIp,
        this.config.trustedProxyCidrs,
      ),
      // The socket peer, which is what this gateway appends to the chain on the way out.
      peerIp: clientIp,
      requestId,
      trustedPeer: this.config.trustedProxyCidrs.some((cidr) => ipInCidr(clientIp, cidr)),
      clientCertHeaders: this.config.clientCertHeaders,
      log:
        this.config.quiet || !this.config.accessLog
          ? undefined
          : (record) => console.log(JSON.stringify(record)),
      // Absent when counting is off, which is also what tells the pipeline not to wrap the
      // response body in a counting stream.
      record:
        this.config.telemetry === "off" ? undefined : (record) => this.telemetry.record(record),
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
          log:
            dp.config.quiet || !dp.config.accessLog
              ? undefined
              : (record) => console.log(JSON.stringify(record)),
          record:
            dp.config.telemetry === "off"
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
  const advice =
    `Set BUN_CONFIG_MAX_HTTP_REQUESTS to at least MAX_CONCURRENT_REQUESTS ` +
    `(${config.maxConcurrentRequests}) so that this gateway's own per-route ceilings bind before ` +
    `the runtime's shared queue does. \`bun run seed\` writes it into every gateway's env file.`;
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
  if (value < config.maxConcurrentRequests) {
    throw new Error(
      `BUN_CONFIG_MAX_HTTP_REQUESTS (${value}) is below MAX_CONCURRENT_REQUESTS ` +
        `(${config.maxConcurrentRequests}): the runtime's shared outbound queue would be reached ` +
        `before this gateway's own ceiling, so a slow backend would be queued rather than shed. ${advice}`,
    );
  }
}

if (import.meta.main) {
  const dp = new DataPlane(loadDpConfig());
  assertOutboundCeiling(dp.config);
  await dp.start();
  const server = startDataPlane(dp);
  console.log(
    `[dp] ${dp.config.name} on http://localhost:${server.port} — control plane ${dp.config.cpUrl}, ` +
      `poll ${dp.config.pollIntervalMs}ms, cache ${dp.config.cachePath}, ` +
      `max ${dp.config.maxConcurrentRequests} concurrent` +
      (dp.config.accessLog ? "" : ", access log off") +
      (dp.config.reusePort ? ", reusePort (rate limits are per process)" : ""),
  );
}

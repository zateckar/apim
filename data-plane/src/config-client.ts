import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArtifactRef } from "../../shared/artifact.ts";
import { CONFIG_VERSION, type GatewayConfig } from "../../shared/config-doc.ts";
import type { GatewaySettings } from "../../shared/gateway-settings.ts";
import { ipv4ToInt } from "../../shared/net.ts";
import type { PolicyDocument } from "../../shared/policy.ts";
import type { PollRequest, PollResponse } from "../../shared/telemetry.ts";
import type { ArtifactCache } from "./artifacts.ts";
import type { ResponseCache } from "./cache.ts";
import type { QuotaCounters } from "./quota.ts";
import { RouteTable } from "./route-table.ts";
import type { StreamRegistry } from "./stream.ts";
import type { InstanceTelemetry } from "./telemetry.ts";
import type { Sampler, ValidationCounterSet } from "./validate.ts";

/**
 * Design section 8.5, as deviation D11 reads it: the poll is bidirectional and single
 * round-trip. The request carries this instance's telemetry, the response carries config or
 * "unchanged".
 *
 * Three behaviours matter and are distinct:
 *  - fail-static: the last good config is persisted and served across restarts, for an unbounded
 *    control-plane outage. Control-plane downtime is never a traffic outage.
 *  - fail-closed on revocation: 401/403 from the poll means this instance's own token was
 *    revoked, so it stops serving. A revoked *subscription* is handled differently: it simply
 *    leaves the config document.
 *  - the instance reports the digest it has activated, not the one it is asking about.
 *
 * v3 adds a fourth: **activation is gated on availability** (design section 8.7). A config whose
 * compiled validators or client certificates this instance does not hold is not activated, because
 * activating it would mean either serving unvalidated traffic or failing every route that needs one.
 */
export interface ConfigClientOptions {
  cpUrl: string;
  token: string;
  cachePath: string;
  pollIntervalMs: number;
  name: string;
  runId: string;
  startedAt: string;
  telemetry: InstanceTelemetry;
  onChange?: (table: RouteTable) => void;
  /** Everything below is optional so a test can drive the poll loop on its own. */
  artifacts?: ArtifactCache;
  quota?: QuotaCounters;
  streams?: StreamRegistry;
  sampler?: Sampler;
  validation?: ValidationCounterSet;
  responseCache?: ResponseCache;
  /**
   * Whether `TRUSTED_PROXY_CIDRS` names at least one network. A client-certificate policy reads an
   * identity out of a header, so without a trust boundary in front it is an authorization bypass —
   * the config is refused rather than activated (design section 8.1, plan `[R1-21]`).
   */
  trustedProxyConfigured?: boolean;
  /**
   * The wire version this instance speaks. Defaults to `CONFIG_VERSION`, and exists so the
   * version-skew behaviour is testable at all: after a bump, nothing in the tree would otherwise
   * send an old version, and "a mixed-version fleet keeps serving and says so" is a claim worth a
   * test rather than a comment (plan §10, review `[P3-07]`).
   */
  wireVersion?: number;
  /**
   * Whether the system trust store is unioned with the environment's registered anchors (§8.3).
   * Carried here because the trust set is composed when a config is activated, which is here.
   */
  trustSystemRoots?: boolean;
  /**
   * How the document's `settings` block reaches the running process, and the one way it can be
   * refused (v6). Optional so a test can drive the poll loop without a whole data plane behind it;
   * absent means the block is carried and ignored, which is what an instance built only to read
   * routes should do with it.
   */
  settings?: {
    /** Why this container cannot honour these settings, or `null`. See `DataPlane.settingsBlocker`. */
    blockerFor(next: GatewaySettings): string | null;
    apply(next: GatewaySettings): void;
  };
}

export class ConfigClient {
  table: RouteTable | null = null;
  decommissioned = false;
  lastPollAt: string | null = null;
  lastError: string | null = null;
  fromCache = false;
  /**
   * Why the digest the control plane offered is not the digest being served. Reported on the poll
   * so the fleet view names the reason rather than showing an instance silently one revision behind.
   */
  activationBlocked: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startCpu = process.cpuUsage();
  /** What this build speaks. One place, so the poll body and every check cannot disagree. */
  private readonly wireVersion: number;

  constructor(private readonly options: ConfigClientOptions) {
    this.wireVersion = options.wireVersion ?? CONFIG_VERSION;
  }

  /** Serve immediately from the last-good config, before the first poll completes. */
  loadFromCache(): boolean {
    if (!existsSync(this.options.cachePath)) return false;
    try {
      const config = JSON.parse(readFileSync(this.options.cachePath, "utf8")) as GatewayConfig;
      if (config.configVersion !== this.wireVersion) return false;
      this.table = this.tableFor(config);
      /**
       * The fleet's settings come back with the routes, so a restart during a control-plane outage
       * does not quietly revert this instance to the build's defaults — which for an estate that
       * had raised its body cap would mean 413s on requests that worked before the restart.
       *
       * Unlike an activation, a settings block this container cannot honour does **not** stop the
       * cached routes being served. Fail-static exists to keep traffic flowing without the control
       * plane, and refusing to serve anything because one ceiling is unreachable here would trade
       * the outage this survives for one it does not. The reason is recorded instead, and the
       * defaults stay in force until a document arrives that this container can apply.
       */
      const refused = this.options.settings?.blockerFor(config.settings);
      if (refused) {
        this.activationBlocked = refused;
        console.error(`[dp] serving cached routes with default settings: ${refused}`);
      } else {
        this.options.settings?.apply(config.settings);
      }
      this.fromCache = true;
      return true;
    } catch (err) {
      console.error(`[dp] ignoring unreadable config cache: ${(err as Error).message}`);
      return false;
    }
  }

  /** One place that turns a document into a table, so both paths compose the trust set alike. */
  private tableFor(config: GatewayConfig): RouteTable {
    return new RouteTable(config, { trustSystemRoots: this.options.trustSystemRoots });
  }

  private body(): PollRequest {
    const cpu = process.cpuUsage(this.startCpu);
    const report = this.options.telemetry.snapshot();
    const validation = this.options.validation?.snapshot();
    if (validation) report.validation = validation;
    return {
      wireVersion: this.wireVersion,
      instance: {
        name: this.options.name,
        runId: this.options.runId,
        startedAt: this.options.startedAt,
        activeDigest: this.table?.digest ?? null,
        process: {
          rssBytes: process.memoryUsage.rss(),
          cpuUserMs: Math.round(cpu.user / 1000),
          cpuSystemMs: Math.round(cpu.system / 1000),
          uptimeSec: Math.round(process.uptime()),
        },
        requestsTotal: this.options.telemetry.requestsTotal,
        activationBlocked: this.activationBlocked,
      },
      telemetry: report,
      // Taken here rather than after a successful response: the deltas have to be *in* the body
      // being sent. Whatever happens next, they are not counted twice — the poll either has them
      // acknowledged or drops them (design section 5.7).
      quota: this.options.quota ? { deltas: this.options.quota.takeDeltas() } : undefined,
    };
  }

  async pollOnce(): Promise<"updated" | "unchanged" | "revoked" | "blocked" | "error"> {
    /**
     * Every path that does not reach `applyAggregates` goes through here. A delta handed to a poll
     * that did not complete is lost on purpose: replaying it would double-count a consumer into a
     * 403, and this design chooses under-counting over that.
     */
    const failed = (result: "error" | "revoked" | "blocked" = "error") => {
      this.options.quota?.dropInFlight();
      return result;
    };

    let response: Response;
    try {
      response = await fetch(`${this.options.cpUrl}/api/gateway/poll`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.body()),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.lastError = `poll failed: ${(err as Error).message}`;
      return failed();
    }

    this.lastPollAt = new Date().toISOString();

    if (response.status === 401 || response.status === 403) {
      // This instance is revoked. Staleness never fails closed; revocation always does.
      if (!this.decommissioned) {
        console.error(
          `[dp] control plane rejected this instance's token (${response.status}). ` +
            "Refusing to serve traffic until a valid token is configured.",
        );
      }
      this.decommissioned = true;
      this.table = null;
      this.lastError = `instance token rejected (${response.status})`;
      // Nothing may outlive a revoked instance, including streams opened before it was revoked.
      this.options.streams?.closeAll("revoked");
      return failed("revoked");
    }

    if (response.status === 413) {
      const batch = this.options.telemetry.halveBatch();
      this.lastError = `report too large; sending at most ${batch} window(s) per poll`;
      console.warn(`[dp] ${this.lastError}`);
      return failed();
    }

    if (!response.ok) {
      // A wire-version refusal is not a transient error: nothing this instance does will make the
      // next poll succeed until one side is upgraded. It is recorded as an activation block so
      // `/healthz` and the fleet view name the reason, rather than leaving an instance that is
      // still happily serving stale config looking merely slow to converge (plan §10, `[P1-07]`).
      const mismatch = await wireMismatchFrom(response, this.wireVersion);
      if (mismatch) {
        this.activationBlocked = mismatch;
        this.lastError = mismatch;
        console.error(`[dp] ${mismatch}; keeping the previous config`);
        return failed("blocked");
      }
      this.lastError = `poll returned HTTP ${response.status}`;
      return failed();
    }

    let payload: PollResponse;
    try {
      payload = (await response.json()) as PollResponse;
    } catch (err) {
      this.lastError = `poll returned invalid JSON: ${(err as Error).message}`;
      return failed();
    }
    if (payload.wireVersion !== this.wireVersion) {
      this.lastError = `wire version ${payload.wireVersion} is not supported (this build speaks ${this.wireVersion})`;
      this.activationBlocked = this.lastError;
      console.error(`[dp] ${this.lastError}; keeping the previous config`);
      return failed("blocked");
    }

    // Only what the control plane acknowledged, and only closed windows, are cleared.
    this.options.telemetry.clearAccepted(payload.acceptedWindows ?? []);
    // The validation counters are not windowed, so "accepted" is simply "the report arrived".
    this.options.validation?.clear();
    // The fleet's counts replace ours; the delta we just sent is inside them.
    this.options.quota?.applyAggregates(payload.quotaAggregates ?? []);
    this.decommissioned = false;
    this.lastError = null;

    if (payload.unchanged) return "unchanged";

    const config = payload.config as GatewayConfig | undefined;
    if (!config || config.configVersion !== this.wireVersion) {
      this.lastError = `config version ${config?.configVersion} is not supported (this build speaks ${this.wireVersion})`;
      this.activationBlocked = this.lastError;
      console.error(`[dp] ${this.lastError}; keeping the previous config`);
      return "blocked";
    }

    const blocker = await this.blockerFor(config);
    if (blocker) {
      this.activationBlocked = blocker.reason;
      // Plan section 14: a blocked config is never activated. Whatever is already serving keeps
      // serving, and the reason travels on the next poll and on /healthz rather than leaving an
      // instance silently one digest behind.
      if (this.table || !blocker.fatalWithoutConfig) {
        console.error(`[dp] config ${config.digest.slice(0, 19)}… not activated: ${blocker.reason}`);
        return "blocked";
      }
      // Nothing is serving and nothing can be: this is design section 11's self-test, run at
      // activation because a config that has not arrived cannot be checked at boot. A startup
      // failure that names the variable beats a gateway that quietly trusts a spoofable header.
      throw new Error(`refusing to serve: ${blocker.reason}`);
    }
    this.activationBlocked = null;

    this.fromCache = false;
    this.table = this.tableFor(config);
    this.persist(config);
    this.afterActivation(config);
    this.options.onChange?.(this.table);
    console.log(
      `[dp] config ${config.digest.slice(0, 19)}… activated: ${config.routes.length} route(s), ` +
        `${config.subscriptions.length} subscription(s)`,
    );
    return "updated";
  }

  /**
   * What stands between this config document and traffic. `null` means it may be activated.
   * Fetching is part of the answer: the artifacts are pulled here, and only what is still missing
   * afterwards counts as a blocker.
   *
   * `fatalWithoutConfig` separates the two kinds. A missing artifact is a race that the next poll
   * usually wins, so an instance with nothing to serve simply waits. A missing trust boundary is a
   * misconfiguration that will never resolve itself, and waiting silently would be worse than
   * refusing to start.
   */
  private async blockerFor(
    config: GatewayConfig,
  ): Promise<{ reason: string; fatalWithoutConfig: boolean } | null> {
    // First and cheapest, and before anything is fetched: a settings block this container cannot
    // honour makes the whole document unactivatable, so downloading its artifacts would be work
    // done for a configuration that is not going to serve. Not fatal without a config — correcting
    // the setting centrally makes the next poll succeed, so an instance with nothing to serve waits
    // rather than exits (v6).
    const refused = this.options.settings?.blockerFor(config.settings);
    if (refused) return { reason: refused, fatalWithoutConfig: false };

    if (this.options.trustedProxyConfigured === false) {
      const route = config.routes.find((candidate) => needsClientCertificate(candidate.policy));
      if (route) {
        return {
          reason:
            `route "${route.resourceName}" identifies callers by client certificate, but ` +
            "TRUSTED_PROXY_CIDRS is empty. The certificate arrives in a header, so with no trust " +
            "boundary in front any caller could send one. Set TRUSTED_PROXY_CIDRS to the reverse " +
            "proxy's network",
          fatalWithoutConfig: true,
        };
      }
    }

    const cache = this.options.artifacts;
    if (!cache) return null;

    const refs = new Map<string, ArtifactRef>();
    for (const route of config.routes) {
      for (const ref of route.artifacts) refs.set(ref.digest, ref);
    }
    const { missing } = await cache.prefetch([...refs.values()], config.certificates);
    if (missing.length === 0) return null;
    const shown = missing.slice(0, 3).join(", ");
    return {
      reason:
        `${missing.length} artifact(s) or certificate(s) could not be fetched: ${shown}` +
        (missing.length > 3 ? ", …" : ""),
      fatalWithoutConfig: false,
    };
  }

  /** The pieces of live state a config swap invalidates (design sections 5.1, 5.8 and 8.7). */
  private afterActivation(config: GatewayConfig): void {
    // Before the invalidation below, because two of those are the caches this may have just
    // resized: clearing a cache and then shrinking it is the same outcome in the other order, and
    // shrinking one that is about to be cleared would evict entries twice (v6).
    this.options.settings?.apply(config.settings);

    // Section 5.8: a subscription that left the document has its open streams closed here. This is
    // the only place a config update reaches backwards into work already in flight.
    const active = new Set(config.subscriptions.map((subscription) => subscription.id));
    const closed = this.options.streams?.closeRevoked(active) ?? 0;
    if (closed > 0) console.log(`[dp] closed ${closed} stream(s) whose subscription was revoked`);

    // Section 5.1: sampling is re-armed by a new revision, so a change gets the cold-start burst.
    this.options.sampler?.reset();
    // Keys carry the digest, so nothing old could be hit anyway; this reclaims the bytes.
    this.options.responseCache?.clear();
    // Not invalidation but the same shape of work: a new document names the backends this instance
    // is about to call, and activation is the moment their addresses are worth having.
    prefetchBackends(config);
  }

  private persist(config: GatewayConfig): void {
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true });
      writeFileSync(this.options.cachePath, JSON.stringify(config));
    } catch (err) {
      console.error(`[dp] could not write the fail-static cache: ${(err as Error).message}`);
    }
  }

  async start(): Promise<void> {
    this.loadFromCache();
    await this.pollOnce();
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => console.error("[dp] poll error", err));
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * How many backend hosts one activation warms. The runtime's DNS cache holds 256 entries for 30
 * seconds and every outbound connection in the process shares it — including the poll to the
 * control plane — so warming more hosts than the cache can hold would evict the ones warmed first
 * and buy nothing. Past this, the remaining backends resolve on the request path, which is what
 * every backend did before this existed.
 */
const MAX_PREFETCHED_HOSTS = 128;

/**
 * Resolve the addresses of the backends this config names, now, rather than on the first request
 * to each of them.
 *
 * The runtime resolves DNS on the request path and caches the answer for 30 seconds
 * (`BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS`), so without this the first request after an activation —
 * and one request every 30 seconds after that — waits for a lookup that has nothing to do with the
 * backend's own latency, and reports it as backend latency.
 *
 * Fire-and-forget, deliberately: `dns.prefetch` returns nothing to wait on, a name that does not
 * resolve is not an activation failure, and the request path resolves again anyway. An address
 * literal is skipped because there is nothing to look up and the entry it would take is worth more
 * to a host that has a name — which matters on the local stack, where every backend is `127.0.0.1`.
 */
function prefetchBackends(config: GatewayConfig): void {
  const seen = new Set<string>();
  for (const route of config.routes) {
    for (const entry of route.backend.pool) {
      if (seen.size >= MAX_PREFETCHED_HOSTS) return;
      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        // A backend URL this cannot parse is the config builder's problem, and the route will say
        // so on its own first request. Warming is not the place to discover it.
        continue;
      }
      const host = url.hostname;
      if (host.startsWith("[") || ipv4ToInt(host) !== null) continue;
      const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      Bun.dns.prefetch(host, port);
    }
  }
}

/**
 * Whether a refused poll was refused for speaking the wrong wire version, and what to say about
 * it. The control plane answers `problem+json` carrying `expected` and `received`, so this reads
 * the two numbers rather than matching on prose (plan §10).
 *
 * Returns `null` for every other failure: an instance that cannot tell a version skew from a
 * database error would report the wrong thing, which is worse than reporting nothing.
 */
async function wireMismatchFrom(response: Response, speaks: number): Promise<string | null> {
  if (response.status !== 400) return null;
  if (!(response.headers.get("content-type") ?? "").includes("json")) return null;
  let problem: { expected?: unknown; received?: unknown };
  try {
    problem = (await response.json()) as typeof problem;
  } catch {
    return null;
  }
  if (typeof problem.expected !== "number" || typeof problem.received !== "number") return null;
  return (
    `wire version ${speaks} is not supported by the control plane, which speaks ` +
    `${problem.expected}. This instance keeps serving the config it has; nothing new will be ` +
    "activated until this build is upgraded"
  );
}

/**
 * Every way plan section 14 says a policy can read a client certificate: authenticating with one,
 * making a precondition of one, or interpolating `${cert.*}` into a header or a rewrite. All three
 * read a header the reverse proxy is trusted to have set, so all three need that proxy to exist.
 *
 * Done over the serialised document rather than field by field, for two reasons: per-operation
 * overrides are nested under `operations["<id>"]` and would need the same walk again, and the
 * template case is a substring search anyway. It over-matches — a literal `${cert.` in a
 * precondition's canned body counts — and that is the right direction for a check whose failure
 * mode is an authorization bypass.
 */
function needsClientCertificate(policy: PolicyDocument): boolean {
  const serialised = JSON.stringify(policy);
  return (
    serialised.includes('"auth.mtls"') ||
    serialised.includes('"requireClientCert"') ||
    serialised.includes("${cert.")
  );
}

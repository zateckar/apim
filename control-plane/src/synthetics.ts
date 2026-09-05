import { gatewayAddresses, gatewaysIn } from "./api/fleet.ts";
import type { LogsConfig } from "./logs.ts";
import type { App } from "./router.ts";

/**
 * Availability history — the uptime strips on the Health screen.
 *
 * The component matrix in `uptime.ts` answers "is it up **now**". This answers "has it been up",
 * which is a different question with a different source: a strip of the last 24 hours cannot be
 * assembled from a monitor that has been running for four minutes. The estate already runs
 * Elastic Heartbeat against the gateway addresses, so the history is read from that index rather
 * than accumulated here — the control plane is not a time-series database and should not become
 * one.
 *
 * Two providers, chosen by the same `LOGS_PROVIDER` that picks the log search, because they are
 * the same cluster:
 *
 *  - `elk` — one `_search` with a `date_histogram` over `summary.status`, per monitor.
 *  - `mock` — a deterministic history derived from the gateways actually registered, so the strips
 *    and the chart are exercised before a Heartbeat index exists. Marked `simulated`, and the
 *    screen says so.
 *
 * A **bucket** is `up`, `down` or `empty`, and `empty` is not `down`: a gap in the checks means
 * nobody looked, and a strip that paints that red invents an outage.
 */

export const SYNTHETICS_RANGES = {
  "1h": { durationMs: 3_600_000, intervalMs: 120_000, esInterval: "2m" },
  "6h": { durationMs: 21_600_000, intervalMs: 600_000, esInterval: "10m" },
  "24h": { durationMs: 86_400_000, intervalMs: 1_800_000, esInterval: "30m" },
  "48h": { durationMs: 172_800_000, intervalMs: 3_600_000, esInterval: "1h" },
} as const;

export type SyntheticsRange = keyof typeof SYNTHETICS_RANGES;
export const SYNTHETICS_RANGE_KEYS = Object.keys(SYNTHETICS_RANGES) as SyntheticsRange[];

export interface SyntheticsBucket {
  /** Bucket start, ISO-8601 UTC. */
  at: string;
  status: "up" | "down" | "empty";
  /** Checks that ran in this bucket. Zero is what makes the bucket `empty`. */
  total: number;
  down: number;
  /** Mean check duration over the bucket, rounded to milliseconds. `null` when empty. */
  avgDurationMs: number | null;
}

export interface SyntheticsMonitor {
  id: string;
  /** The gateway's name within its environment — the same word the rest of the portal uses. */
  name: string;
  /** The hostname being checked. Public metadata: a host, never a path or a query. */
  host: string | null;
  buckets: SyntheticsBucket[];
  /** Share of non-empty buckets that were up, 0–1. `null` when nothing was checked at all. */
  availability: number | null;
  /** The last failure's message. Administrators only — the text can name internal hosts. */
  lastError: string | null;
}

export interface SyntheticsSnapshot {
  range: SyntheticsRange;
  intervalMs: number;
  generatedAt: string;
  /** Keyed by environment, in promotion-chain order. An environment with no gateway has none. */
  environments: Array<{ environment: string; monitors: SyntheticsMonitor[] }>;
  simulated: boolean;
}

export interface SyntheticsProvider {
  readonly kind: "elk" | "mock";
  history(range: SyntheticsRange, options: { admin: boolean; now: number }): Promise<SyntheticsSnapshot>;
}

/**
 * The Heartbeat field map, in one place, for the same reason `ELK_FIELDS` is a constant: a field
 * name that varies per deployment turns every gap in a strip into "which mapping is this cluster on".
 */
export const HEARTBEAT_FIELDS = {
  timestamp: "@timestamp",
  monitorId: "monitor.id",
  monitorName: "monitor.name",
  status: "summary.status",
  finalAttempt: "summary.final_attempt",
  durationUs: "monitor.duration.us",
  url: "url.full",
  error: "error.message",
} as const;

/**
 * Which monitor belongs to which gateway.
 *
 * `apim-<environment>-<gateway>` by convention, matched against `monitor.id`. A convention rather
 * than a tag lookup because the monitors are ours: the same script that registers a gateway
 * registers its check, and a naming rule both sides can compute needs no second source of truth.
 */
export function monitorIdFor(environment: string, gateway: string): string {
  return `apim-${environment}-${gateway}`;
}

interface GatewayMonitor {
  environment: string;
  gateway: string;
  monitorId: string;
  host: string | null;
}

/** Every gateway in the chain, as the monitor it corresponds to. The shape both providers fill in. */
export function gatewayMonitors(app: App): GatewayMonitor[] {
  const out: GatewayMonitor[] = [];
  for (const environment of app.config.promotionChain) {
    for (const target of gatewaysIn(app.db, environment)) {
      const address = gatewayAddresses(target)[0]?.url ?? null;
      out.push({
        environment,
        gateway: target.name,
        monitorId: monitorIdFor(environment, target.name),
        host: hostOf(address),
      });
    }
  }
  return out;
}

/** A hostname, or nothing. A malformed address is not a reason to lose the whole snapshot. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The bucket shells for a window, interval-aligned.
 *
 * Aligned for the same reason the log histogram is: two readers looking at the same range must see
 * a spike in the same place, and an unaligned strip shifts every time the page is opened.
 */
export function emptyBuckets(range: SyntheticsRange, now: number): SyntheticsBucket[] {
  const { durationMs, intervalMs } = SYNTHETICS_RANGES[range];
  const start = Math.floor((now - durationMs) / intervalMs) * intervalMs;
  const out: SyntheticsBucket[] = [];
  for (let at = start; at < now; at += intervalMs) {
    out.push({ at: new Date(at).toISOString(), status: "empty", total: 0, down: 0, avgDurationMs: null });
  }
  return out;
}

/**
 * Drop trailing buckets whose window has not finished *and* hold nothing.
 *
 * "No check has had a chance to run yet" is not a gap. A middle bucket that is empty after its
 * window fully elapsed is a real gap and stays grey — that distinction is the whole point.
 */
export function trimUnelapsed(buckets: SyntheticsBucket[], intervalMs: number, now: number): SyntheticsBucket[] {
  const out = [...buckets];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.status === "empty" && Date.parse(last.at) + intervalMs > now) out.pop();
    else break;
  }
  return out;
}

/** Share of the buckets that actually ran which were up. `null` when none ran. */
export function availabilityOf(buckets: SyntheticsBucket[]): number | null {
  const ran = buckets.filter((bucket) => bucket.status !== "empty");
  if (ran.length === 0) return null;
  return ran.filter((bucket) => bucket.status === "up").length / ran.length;
}

// ---------------------------------------------------------------------------- the ELK provider

export class ElkSynthetics implements SyntheticsProvider {
  readonly kind = "elk" as const;

  constructor(
    private readonly app: App,
    private readonly config: LogsConfig,
    /** Usually `heartbeat-*`; the access lines and the checks are different indices. */
    private readonly index: string,
  ) {
    if (!config.url) throw new Error("ELK_URL is required when LOGS_PROVIDER=elk");
  }

  async history(
    range: SyntheticsRange,
    options: { admin: boolean; now: number },
  ): Promise<SyntheticsSnapshot> {
    const monitors = gatewayMonitors(this.app);
    const { intervalMs } = SYNTHETICS_RANGES[range];
    const byMonitor = new Map<string, any>();
    if (monitors.length > 0) {
      const body = await this.post(`/${encodeURIComponent(this.index)}/_search`, {
        ...buildSyntheticsQuery(
          range,
          monitors.map((monitor) => monitor.monitorId),
          options.now,
        ),
      });
      for (const bucket of body?.aggregations?.monitors?.buckets ?? []) {
        byMonitor.set(String(bucket.key), bucket);
      }
    }
    return {
      range,
      intervalMs,
      generatedAt: new Date(options.now).toISOString(),
      simulated: false,
      environments: groupByEnvironment(
        this.app,
        monitors.map((monitor) => ({
          monitor,
          built: reshapeMonitor(byMonitor.get(monitor.monitorId), range, options),
        })),
      ),
    };
  }

  private async post(path: string, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.apiKey) headers.authorization = `ApiKey ${this.config.apiKey}`;
      else if (this.config.username !== null) {
        const basic = Buffer.from(
          `${this.config.username}:${this.config.password ?? ""}`,
        ).toString("base64");
        headers.authorization = `Basic ${basic}`;
      }
      const response = await fetch(`${this.config.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `the uptime index answered ${response.status}: ${text.slice(0, 400) || response.statusText}`,
        );
      }
      return JSON.parse(text);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`the uptime index did not answer within ${this.config.timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The query, as a pure function so it can be asserted without a cluster.
 *
 * `summary.final_attempt` filters to one document per check: Heartbeat writes a document per
 * retry, and counting those would report a flapping monitor as busier than a healthy one.
 */
export function buildSyntheticsQuery(
  range: SyntheticsRange,
  monitorIds: string[],
  now: number,
): Record<string, unknown> {
  const F = HEARTBEAT_FIELDS;
  const { durationMs, esInterval } = SYNTHETICS_RANGES[range];
  const from = now - durationMs;
  return {
    size: 0,
    query: {
      bool: {
        filter: [
          { terms: { [F.monitorId]: monitorIds } },
          { term: { [F.finalAttempt]: true } },
          { range: { [F.timestamp]: { gte: from, lt: now, format: "epoch_millis" } } },
        ],
      },
    },
    aggs: {
      monitors: {
        terms: { field: F.monitorId, size: Math.max(10, monitorIds.length) },
        aggs: {
          url: { terms: { field: F.url, size: 1 } },
          last_error: {
            filter: { term: { [F.status]: "down" } },
            aggs: {
              latest: {
                top_hits: { size: 1, sort: [{ [F.timestamp]: "desc" }], _source: [F.error] },
              },
            },
          },
          timeline: {
            date_histogram: {
              field: F.timestamp,
              fixed_interval: esInterval,
              min_doc_count: 0,
              // Padded to the full window, so a gap renders as a grey "no data" mark rather than
              // silently shortening the strip and making an outage look like a shorter history.
              extended_bounds: { min: from, max: now - 1 },
            },
            aggs: {
              down: { filter: { term: { [F.status]: "down" } } },
              duration: { avg: { field: F.durationUs } },
            },
          },
        },
      },
    },
  };
}

/** One monitor's aggregation bucket into this system's shape. A missing bucket is an empty strip. */
export function reshapeMonitor(
  raw: any,
  range: SyntheticsRange,
  options: { admin: boolean; now: number },
): { buckets: SyntheticsBucket[]; lastError: string | null; host: string | null } {
  const { intervalMs } = SYNTHETICS_RANGES[range];
  if (!raw) {
    return { buckets: trimUnelapsed(emptyBuckets(range, options.now), intervalMs, options.now), lastError: null, host: null };
  }
  const buckets: SyntheticsBucket[] = (raw.timeline?.buckets ?? []).map((bucket: any) => {
    const total = bucket.doc_count ?? 0;
    const down = bucket.down?.doc_count ?? 0;
    const avg = bucket.duration?.value;
    return {
      at: new Date(bucket.key).toISOString(),
      status: total === 0 ? "empty" : down > 0 ? "down" : "up",
      total,
      down,
      // Heartbeat records microseconds; the rest of the portal speaks milliseconds.
      avgDurationMs: typeof avg === "number" && Number.isFinite(avg) ? Math.round(avg / 1000) : null,
    };
  });
  const message = raw.last_error?.latest?.hits?.hits?.[0]?._source?.error?.message;
  return {
    buckets: trimUnelapsed(buckets, intervalMs, options.now),
    // Only for administrators: a check's error text quotes the URL it failed against, which is
    // internal topology rather than something a subscription bought.
    lastError: options.admin && typeof message === "string" ? message : null,
    host: hostOf(raw.url?.buckets?.[0]?.key ?? null),
  };
}

// ---------------------------------------------------------------------------- the mock provider

/**
 * A deterministic history for each registered gateway.
 *
 * A pure function of (monitor, bucket start), so the strip does not reshuffle on reload and the
 * availability figure under it matches the marks above it. Mostly up with occasional short
 * outages, because a flat green strip tells the reader nothing about whether the widget works.
 */
export class MockSynthetics implements SyntheticsProvider {
  readonly kind = "mock" as const;

  constructor(private readonly app: App) {}

  async history(
    range: SyntheticsRange,
    options: { admin: boolean; now: number },
  ): Promise<SyntheticsSnapshot> {
    const { intervalMs } = SYNTHETICS_RANGES[range];
    const monitors = gatewayMonitors(this.app);
    return {
      range,
      intervalMs,
      generatedAt: new Date(options.now).toISOString(),
      simulated: true,
      environments: groupByEnvironment(
        this.app,
        monitors.map((monitor) => {
          const shells = trimUnelapsed(emptyBuckets(range, options.now), intervalMs, options.now);
          let lastError: string | null = null;
          for (const bucket of shells) {
            const rng = mulberry32(hash(`${monitor.monitorId}|${bucket.at}`));
            const checks = Math.max(1, Math.round(intervalMs / 30_000));
            const roll = rng();
            // Roughly 2% of buckets carry a failure — a believable strip, not a broken estate.
            const down = roll > 0.98 ? Math.max(1, Math.round(checks * (0.2 + rng() * 0.8))) : 0;
            bucket.total = checks;
            bucket.down = down;
            bucket.status = down > 0 ? "down" : "up";
            bucket.avgDurationMs = Math.round(35 + rng() * 180 + (down > 0 ? 900 : 0));
            if (down > 0) lastError = "connection reset by peer (simulated)";
          }
          return { monitor, built: { buckets: shells, lastError: options.admin ? lastError : null, host: monitor.host } };
        }),
      ),
    };
  }
}

// ---------------------------------------------------------------------------- shared

function groupByEnvironment(
  app: App,
  built: Array<{
    monitor: GatewayMonitor;
    built: { buckets: SyntheticsBucket[]; lastError: string | null; host: string | null };
  }>,
): Array<{ environment: string; monitors: SyntheticsMonitor[] }> {
  return app.config.promotionChain
    .map((environment) => ({
      environment,
      monitors: built
        .filter((entry) => entry.monitor.environment === environment)
        .map(
          (entry): SyntheticsMonitor => ({
            id: entry.monitor.monitorId,
            name: entry.monitor.gateway,
            // The gateway's registered address wins over whatever the index recorded: the portal
            // knows where it published the gateway, and a stale monitor URL should not rename it.
            host: entry.monitor.host ?? entry.built.host,
            buckets: entry.built.buckets,
            availability: availabilityOf(entry.built.buckets),
            lastError: entry.built.lastError,
          }),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.monitors.length > 0);
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSynthetics(app: App): SyntheticsProvider {
  return app.config.logs.provider === "elk"
    ? new ElkSynthetics(app, app.config.logs, app.config.logs.uptimeIndex)
    : new MockSynthetics(app);
}

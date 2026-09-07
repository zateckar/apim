/**
 * Gateway telemetry (design section 8.5's upward half, plan G4).
 *
 * Deviation D15/D16: the design sends OTEL to ELK and keeps no usage-accounting store. There is
 * no ELK here and the goal asks for the numbers in the control plane, so instances pre-aggregate
 * counters and report them on the poll they were already making — no new channel, no new
 * protocol. It is bounded the way design section 5.7 bounds `usage_counter`, and it is not a
 * per-call ledger.
 */
import type { QuotaAggregate, QuotaDelta } from "./quota.ts";

/**
 * One value per pipeline exit, so "what did each policy actually do" is answerable by grouping.
 * Closed: an unknown outcome from an instance is folded rather than stored.
 */
export const OUTCOMES = [
  "ok",
  "upstream-error",
  "no-route",
  "no-config",
  "decommissioned",
  "no-key",
  "bad-key",
  "not-in-product",
  "rate-limited",
  "precondition",
  "content-type",
  "soap-mismatch",
  "body-too-large",
  "backend-timeout",
  "backend-unreachable",
  // Shed, not failed: the gateway refused to start upstream work because too much was already in
  // flight. Two values rather than one, because which ceiling fired is the whole diagnosis —
  // `route-saturated` says one backend is sick, `instance-saturated` says the process as a whole
  // is past what it agreed to hold.
  "route-saturated",
  "instance-saturated",
  /**
   * The caller went away before the backend answered. Distinct from `backend-timeout` on purpose:
   * both end with an aborted upstream call, but one is the backend's fault and one is not, and
   * folding them together would inflate the 504 count with requests nobody was waiting for.
   */
  "client-gone",

  // ---- v3. Every one of these is a distinct diagnosis, which is why none of them is folded into
  // an existing value: "the breaker is doing its job" and "the network is broken" are different
  // lines on a dashboard, and so are "we rejected traffic" and "we observed non-conforming traffic".
  /** Blocking validation rejected the request or the response (design section 5.1). */
  "validation-rejected",
  /** A route's compiled validator could not be fetched, so it failed closed (design section 8.7). */
  "validation-unavailable",
  /** Blocking validation would have exceeded the instance's buffer budget, so the request was shed. */
  "validate-budget",
  /** The fleet quota for this subscription is exhausted (design section 5.7). */
  "quota-exceeded",
  /** Every backend in the pool is open at the circuit breaker (goal G7). */
  "pool-open",
  /** Refused by an ipAllow range. */
  "ip-denied",
  /** Authentication failed for a method other than the subscription key. */
  "bad-credential",
  /** A JSON-RPC method or tool this contract does not declare (plan sections 9, 10). */
  "rpc-unknown-method",
  /**
   * A path and method under a REST route's base path that its definition does not declare. The
   * same diagnosis as `rpc-unknown-method`, for the variant that addresses operations by URL —
   * kept separate from `no-route`, which means no route matched the host and path at all. On a
   * dashboard they are different problems: `no-route` is usually a caller with a stale address,
   * `no-operation` is usually a definition that has fallen behind its backend.
   */
  "no-operation",
  /** The upstream answered a JSON-RPC error: a tool saying "no" is not the gateway failing. */
  "rpc-error",
  /** Served from the per-instance response cache. */
  "cache-hit",
  /** A stream upgrade the route's own ceiling refused. */
  "upgrade-rejected",
  /** A stream upgrade the instance-wide ceiling refused. */
  "upgrade-saturated",
  /** A WebSocket or SSE stream that ran to completion or was closed by a ceiling. */
  "stream-closed",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/**
 * Outcomes that are a *served* request rather than a refused one, even though none of them is the
 * plain `ok` of a proxied 2xx.
 *
 * Named explicitly, because the three-number summary used to be derived by excluding `ok` and
 * `upstream-error` — which silently reclassified every v3 outcome as a rejection the moment it was
 * added. A cached response, a completed stream and a tool answering "no" are not the gateway
 * refusing traffic, and counting them that way made a well-cached API look like it was rejecting
 * most of its calls.
 *
 *  - `cache-hit` — the consumer got their response; it came from memory.
 *  - `stream-closed` — the stream ran and ended. Its *reason* is on the log record, and a stream a
 *    ceiling cut short is `upgrade-rejected` / `upgrade-saturated`, which are refusals.
 *  - `rpc-error` — HTTP 200 carrying a JSON-RPC error. The server answered; it said no. Folding it
 *    into `upstreamErrors` would report an MCP tool's ordinary "not found" as an HTTP failure.
 *
 * Each stays a distinct value in the outcome breakdown, so nothing is hidden by this grouping.
 */
export const SERVED_OUTCOMES: readonly Outcome[] = ["ok", "cache-hit", "stream-closed", "rpc-error"];

/**
 * Outcomes the gateway itself produced: the caller was refused, or upstream work was shed or cut
 * short. Everything that is neither served nor the backend's own >= 400.
 */
export const GATEWAY_REJECTIONS: readonly Outcome[] = OUTCOMES.filter(
  (o) => o !== "upstream-error" && !SERVED_OUTCOMES.includes(o),
);

/**
 * Fixed boundaries in milliseconds, last bucket unbounded. Percentiles are interpolated inside
 * the containing bucket, which is honest for a dashboard and stated as approximate wherever it
 * is shown.
 */
export const BUCKET_BOUNDS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000,
] as const;
export const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1;

export function bucketIndex(durationMs: number): number {
  for (let i = 0; i < BUCKET_BOUNDS_MS.length; i++) {
    if (durationMs <= BUCKET_BOUNDS_MS[i]!) return i;
  }
  return BUCKET_BOUNDS_MS.length;
}

export function emptyBuckets(): number[] {
  return new Array(BUCKET_COUNT).fill(0);
}

export function addBuckets(into: number[], from: number[]): number[] {
  for (let i = 0; i < BUCKET_COUNT; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
  return into;
}

/**
 * Linear interpolation inside the containing bucket. `null` when there is nothing to compute
 * from — a dashboard that renders 0 for "no data" lies about the fast case.
 */
export function percentile(buckets: number[], q: number): number | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = q * total;
  let cumulative = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const count = buckets[i] ?? 0;
    if (cumulative + count >= target) {
      const low = i === 0 ? 0 : BUCKET_BOUNDS_MS[i - 1]!;
      const high = i === BUCKET_BOUNDS_MS.length ? BUCKET_BOUNDS_MS[i - 1]! * 2 : BUCKET_BOUNDS_MS[i]!;
      if (count === 0) return high;
      const within = (target - cumulative) / count;
      return Math.round(low + (high - low) * within);
    }
    cumulative += count;
  }
  return BUCKET_BOUNDS_MS[BUCKET_BOUNDS_MS.length - 1]!;
}

/** The minute a request is attributed to. Attribution is by *completion*, so a window that has
 * closed can never reopen — which is what makes replace-on-flush safe (review V1-01). */
export function windowStartOf(atMs: number): string {
  return new Date(Math.floor(atMs / 60_000) * 60_000).toISOString();
}

export interface TelemetrySeries {
  /** `""` when no route matched. Never null: SQLite treats NULLs in a primary key as distinct. */
  resourceId: string;
  /** `""` when the request was not authenticated. */
  subscriptionId: string;
  outcome: Outcome | "overflow";
  status: number;
  count: number;
  durationMsSum: number;
  durationMsMax: number;
  /** Bytes actually read from the client, so a rejection before the proxy reports 0. */
  bytesIn: number;
  bytesOut: number;
  buckets: number[];
}

export interface TelemetryWindow {
  windowStart: string;
  series: TelemetrySeries[];
}

/**
 * Validation counters, reported alongside the rollup. Two counters rather than one, always:
 * "we rejected traffic" and "we observed non-conforming traffic" are different signals, and the
 * second is a sampled observation that must never be read as a gateway-enforced control.
 */
export interface ValidationCounters {
  rejected: number;
  observed: number;
  sampleDropped: number;
  unavailable: number;
  budgetShed: number;
}

export function emptyValidationCounters(): ValidationCounters {
  return { rejected: 0, observed: 0, sampleDropped: 0, unavailable: 0, budgetShed: 0 };
}

export interface TelemetryReport {
  droppedSeries: number;
  droppedWindows: number;
  windows: TelemetryWindow[];
  validation?: ValidationCounters;
}

export interface InstanceProcess {
  rssBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  uptimeSec: number;
}

/** The poll request body (deviation D11: one bidirectional round trip, as design section 8.5 says). */
export interface PollRequest {
  wireVersion: number;
  instance: {
    name: string;
    /** Fresh per process, so a restart writes new rows instead of replacing (review V2-01). */
    runId: string;
    startedAt: string;
    /** The digest this instance has *activated*, not the one it is asking about. */
    activeDigest: string | null;
    process: InstanceProcess;
    requestsTotal: number;
    /**
     * Set when a config was received and deliberately not activated — a missing artifact, or a
     * client-cert policy with no trusted-proxy boundary. The fleet view shows it rather than
     * leaving an instance silently one digest behind (design section 8.7, plan `[R1-21]`).
     */
    activationBlocked?: string | null;
  };
  telemetry: TelemetryReport;
  /**
   * Quota deltas since the last poll. Best-effort: a lost report under-counts and is never
   * retried, because a retried delta would double-count a consumer into a 403 (design section 8.5).
   */
  quota?: { deltas: QuotaDelta[] };
}

export interface PollResponse {
  wireVersion: number;
  unchanged: boolean;
  digest: string;
  /** Closed windows the control plane took responsibility for; the instance clears exactly these. */
  acceptedWindows: string[];
  config?: unknown;
  /** The fleet's quota counts as of this poll, for the subscriptions this environment carries. */
  quotaAggregates?: QuotaAggregate[];
}

export const TELEMETRY_DEFAULTS = {
  maxSeries: 2000,
  maxWindowsPerReport: 15,
  maxReportBytes: 1024 * 1024,
  maxRunsPerInstanceWindow: 16,
  flushIntervalSec: 10,
  retentionHours: 48,
  jobRetentionHours: 168,
  maxInstancesPerTarget: 16,
} as const;

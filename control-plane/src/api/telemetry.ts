import {
  addBuckets,
  emptyBuckets,
  GATEWAY_REJECTIONS,
  percentile,
  SERVED_OUTCOMES,
} from "../../../shared/telemetry.ts";
import { badRequest, json, Router, requireAdmin, requireUser, type Ctx } from "../router.ts";

/**
 * Reading telemetry back (plan G4).
 *
 * Two rules that are policy, not implementation detail:
 *  - reads are application-scoped, because traffic volumes are a consumer relationship, not a discovery
 *    surface. The `''` (no-route) bucket is admin-only: it is the estate's 404 traffic and
 *    belongs to nobody.
 *  - every surface reports **three numbers**, never one "errors" figure. A 429 we produced and a
 *    500 the backend produced are different signals (review V1-25).
 */
const REJECTION_SET = new Set<string>(GATEWAY_REJECTIONS);
const SERVED = new Set<string>(SERVED_OUTCOMES);

export interface Row {
  window_start: string;
  resource_id: string;
  subscription_id: string;
  instance_id: string;
  outcome: string;
  status: number;
  count: number;
  duration_ms_sum: number;
  duration_ms_max: number;
  bytes_in: number;
  bytes_out: number;
  buckets_json: string;
}

/** Aggregating in the process keeps the bucket maths in one place; the window bounds the scan. */
export const MAX_SCANNED_ROWS = 200_000;

function environmentOf(ctx: Ctx): string {
  const environment = ctx.url.searchParams.get("environment") ?? ctx.app.config.promotionChain[0]!;
  if (!ctx.app.config.promotionChain.includes(environment)) {
    throw badRequest(`unknown environment "${environment}"`);
  }
  return environment;
}

function sinceOf(ctx: Ctx): { sinceIso: string; sinceMin: number } {
  const raw = ctx.url.searchParams.get("sinceMin");
  const sinceMin = raw ? Number(raw) : 60;
  if (!Number.isInteger(sinceMin) || sinceMin < 1 || sinceMin > 60 * 24 * 7) {
    throw badRequest("sinceMin: expected an integer between 1 and 10080");
  }
  return { sinceIso: new Date(Date.now() - sinceMin * 60_000).toISOString(), sinceMin };
}

/**
 * The rollup rows one screen may see. Exported because the dashboard reads traffic through this
 * same function: two screens that computed "how much traffic" separately would eventually
 * disagree, and the one that disagreed would be the one somebody was looking at (plan §6.2).
 *
 * `untilIso` bounds the window from above, which is what makes the dashboard's `previous` block
 * the *same* aggregation over the preceding window rather than a second implementation.
 */
export function rowsFor(ctx: Ctx, environment: string, sinceIso: string, untilIso?: string): Row[] {
  const user = requireUser(ctx);
  const rows = ctx.app.db
    .query<Row, [string, string, string, number]>(
      `SELECT window_start, resource_id, subscription_id, instance_id, outcome, status,
              count, duration_ms_sum, duration_ms_max, bytes_in, bytes_out, buckets_json
         FROM telemetry_rollup
        WHERE environment = ? AND window_start >= ? AND window_start < ?
        ORDER BY window_start
        LIMIT ?`,
    )
    .all(environment, sinceIso, untilIso ?? "9999-12-31T23:59:59.999Z", MAX_SCANNED_ROWS);

  if (user.isAdmin) return rows;

  const visible = new Set(
    ctx.app.db
      .query<{ id: string }, never[]>("SELECT id, application_id FROM resource")
      .all()
      .filter((r) => user.applications.includes((r as unknown as { application_id: string }).application_id))
      .map((r) => r.id),
  );
  // The no-route bucket has no owning application, so it is admin-only rather than everyone's.
  return rows.filter((row) => row.resource_id !== "" && visible.has(row.resource_id));
}

export interface Totals {
  requests: number;
  ok: number;
  gatewayRejections: number;
  upstreamErrors: number;
  bytesIn: number;
  bytesOut: number;
  durationMsSum: number;
  durationMsMax: number;
  buckets: number[];
}

export function emptyTotals(): Totals {
  return {
    requests: 0,
    ok: 0,
    gatewayRejections: 0,
    upstreamErrors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMsSum: 0,
    durationMsMax: 0,
    buckets: emptyBuckets(),
  };
}

export function fold(into: Totals, row: Row): Totals {
  into.requests += row.count;
  // Three buckets, and every outcome lands in exactly one. `served` is wider than the literal `ok`
  // outcome: a cache hit, a completed stream and a JSON-RPC error are all requests that got an
  // answer, and the detail survives in the outcome breakdown either way.
  if (SERVED.has(row.outcome)) into.ok += row.count;
  else if (REJECTION_SET.has(row.outcome)) into.gatewayRejections += row.count;
  else into.upstreamErrors += row.count;
  into.bytesIn += row.bytes_in;
  into.bytesOut += row.bytes_out;
  into.durationMsSum += row.duration_ms_sum;
  into.durationMsMax = Math.max(into.durationMsMax, row.duration_ms_max);
  addBuckets(into.buckets, JSON.parse(row.buckets_json) as number[]);
  return into;
}

/** Percentiles are interpolated inside a bucket, so they are labelled approximate everywhere. */
export function summarise(totals: Totals) {
  return {
    requests: totals.requests,
    ok: totals.ok,
    gatewayRejections: totals.gatewayRejections,
    upstreamErrors: totals.upstreamErrors,
    errorRate: totals.requests === 0 ? 0 : 1 - totals.ok / totals.requests,
    bytesIn: totals.bytesIn,
    bytesOut: totals.bytesOut,
    avgMs: totals.requests === 0 ? null : Math.round(totals.durationMsSum / totals.requests),
    maxMs: totals.durationMsMax,
    p50Ms: percentile(totals.buckets, 0.5),
    p95Ms: percentile(totals.buckets, 0.95),
    p99Ms: percentile(totals.buckets, 0.99),
    approximate: true,
  };
}

export function groupBy(rows: Row[], key: (row: Row) => string): Map<string, Totals> {
  const groups = new Map<string, Totals>();
  for (const row of rows) {
    const id = key(row);
    let totals = groups.get(id);
    if (!totals) {
      totals = emptyTotals();
      groups.set(id, totals);
    }
    fold(totals, row);
  }
  return groups;
}

/**
 * The estate view is admin-only, and said here rather than only in the sidebar.
 *
 * `rowsFor` scopes rows to the caller's applications, so a member reading these endpoints was
 * never seeing somebody else's *traffic* — but the screen they are for is the estate's, "By
 * gateway" names every replica behind the proxy, and a nav that gates a screen while its API
 * answers anyone is a gate that is not there (finding 2). The member-facing use of this data is
 * the dashboard, which calls `rowsFor` directly and is unaffected.
 */
function requireEstateReader(ctx: Ctx): void {
  requireAdmin(ctx, "estate-wide telemetry is admin-only; your own traffic is on the dashboard");
}

export function registerTelemetryRoutes(router: Router): void {
  router.add("GET", "/api/telemetry/summary", "session", (ctx) => {
    requireEstateReader(ctx);
    const environment = environmentOf(ctx);
    const { sinceIso, sinceMin } = sinceOf(ctx);
    const rows = rowsFor(ctx, environment, sinceIso);

    const totals = rows.reduce(fold, emptyTotals());
    const perMinute = groupBy(rows, (row) => row.window_start);
    const outcomes = new Map<string, number>();
    const statuses = new Map<number, number>();
    for (const row of rows) {
      outcomes.set(row.outcome, (outcomes.get(row.outcome) ?? 0) + row.count);
      statuses.set(row.status, (statuses.get(row.status) ?? 0) + row.count);
    }

    return json({
      environment,
      sinceMin,
      totals: summarise(totals),
      series: [...perMinute.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([windowStart, t]) => ({
          windowStart,
          requests: t.requests,
          ok: t.ok,
          gatewayRejections: t.gatewayRejections,
          upstreamErrors: t.upstreamErrors,
          p95Ms: percentile(t.buckets, 0.95),
        })),
      outcomes: [...outcomes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, count]) => ({ outcome, count })),
      statuses: [...statuses.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => ({ status, count })),
      truncated: rows.length >= MAX_SCANNED_ROWS,
    });
  });

  router.add("GET", "/api/telemetry/resources", "session", (ctx) => {
    requireEstateReader(ctx);
    const environment = environmentOf(ctx);
    const { sinceIso, sinceMin } = sinceOf(ctx);
    const rows = rowsFor(ctx, environment, sinceIso);
    const groups = groupBy(rows, (row) => row.resource_id);

    const names = new Map(
      ctx.app.db
        .query<{ id: string; name: string; api_version: string; kind: string }, never[]>(
          "SELECT id, name, api_version, kind FROM resource",
        )
        .all()
        .map((r) => [r.id, r]),
    );

    return json({
      environment,
      sinceMin,
      items: [...groups.entries()]
        .map(([resourceId, totals]) => {
          const resource = names.get(resourceId);
          return {
            resourceId,
            name: resource?.name ?? (resourceId === "" ? "(no route matched)" : "(deleted)"),
            apiVersion: resource?.api_version ?? null,
            kind: resource?.kind ?? null,
            ...summarise(totals),
          };
        })
        .sort((a, b) => b.requests - a.requests),
    });
  });

  router.add("GET", "/api/telemetry/consumers", "session", (ctx) => {
    requireEstateReader(ctx);
    const environment = environmentOf(ctx);
    const { sinceIso, sinceMin } = sinceOf(ctx);
    const rows = rowsFor(ctx, environment, sinceIso).filter((row) => row.subscription_id !== "");
    const groups = groupBy(rows, (row) => row.subscription_id);

    const labels = new Map(
      ctx.app.db
        .query<{ id: string; application: string; product: string; application_id: string }, never[]>(
          `SELECT s.id, a.name AS application, p.name AS product, a.id AS application_id
             FROM subscription s
             JOIN application a ON a.id = s.application_id
             JOIN product p     ON p.id = s.product_id`,
        )
        .all()
        .map((r) => [r.id, r]),
    );

    return json({
      environment,
      sinceMin,
      items: [...groups.entries()]
        .map(([subscriptionId, totals]) => {
          const label = labels.get(subscriptionId);
          return {
            subscriptionId,
            application: label?.application ?? "(deleted)",
            product: label?.product ?? "(deleted)",
            applicationId: label?.application_id ?? null,
            ...summarise(totals),
          };
        })
        .sort((a, b) => b.requests - a.requests),
    });
  });

  router.add("GET", "/api/telemetry/instances", "session", (ctx) => {
    requireEstateReader(ctx);
    const environment = environmentOf(ctx);
    const { sinceIso, sinceMin } = sinceOf(ctx);
    const rows = rowsFor(ctx, environment, sinceIso);
    const groups = groupBy(rows, (row) => row.instance_id);

    const instances = ctx.app.db
      .query<
        {
          id: string;
          name: string;
          config_digest: string | null;
          last_seen_at: string | null;
          revoked_at: string | null;
          process_json: string | null;
        },
        [string]
      >(
        `SELECT gi.id, gi.name, gi.config_digest, gi.last_seen_at, gi.revoked_at, gi.process_json
           FROM gateway_instance gi JOIN target t ON t.id = gi.target_id
          WHERE t.environment = ? ORDER BY gi.name`,
      )
      .all(environment);

    const total = [...groups.values()].reduce((sum, t) => sum + t.requests, 0);
    return json({
      environment,
      sinceMin,
      items: instances.map((instance) => {
        const totals = groups.get(instance.id) ?? emptyTotals();
        return {
          instanceId: instance.id,
          name: instance.name,
          configDigest: instance.config_digest,
          lastSeenAt: instance.last_seen_at,
          revoked: Boolean(instance.revoked_at),
          process: instance.process_json
            ? (JSON.parse(instance.process_json) as Record<string, unknown>)
            : null,
          share: total === 0 ? 0 : totals.requests / total,
          ...summarise(totals),
        };
      }),
    });
  });
}

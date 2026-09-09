import { percentile } from "../../shared/telemetry.ts";
import { START_HERE_CODES, type AttentionRow } from "../../shared/attention.ts";
import {
  consumerAttention,
  consumerSubscriptions,
  ownerAttention,
  platformAttention,
  quotaFor,
  scopeFor,
  startHere,
  subscriptionLabel,
  type ConfigError,
  type Scope,
} from "./attention.ts";
import { healthFor } from "./api/fleet.ts";
import {
  emptyTotals,
  fold,
  groupBy,
  MAX_SCANNED_ROWS,
  rowsFor,
  summarise,
  type Row,
  type Totals,
} from "./api/telemetry.ts";
import { requireUser, type Ctx } from "./router.ts";

/**
 * `GET /api/dashboard` (G2, plan §6).
 *
 * One endpoint with a block per hat, because the alternative — five endpoints a screen fans out to
 * — is five chances for two numbers on one page to disagree about what "now" means.
 *
 * Rules the shape obeys, each of which is a decision rather than an implementation detail:
 *
 *  - **three numbers, never one.** `ok`, `gatewayRejections` and `upstreamErrors`, with `errorRate`
 *    defined beside them: a 429 the gateway produced and a 500 the backend produced are different
 *    signals and a single "errors" figure hides which one is happening.
 *  - **`previous` is null rather than wrong.** A trend needs twice the window inside retention;
 *    when it is not there the field is null, `trendAvailable` says so, and the UI omits the delta.
 *  - **every list is bounded** with a truncation count beside it `[P1-13]`.
 *  - **`hats` describes data, not navigation** `[P1-26]`: an application that owns nothing still has the
 *    "publish an API" screen, or it could never publish its first one.
 */

/** ≤ 50 rows per attention block, ≤ 10 top APIs, ≤ 50 subscriptions listed (plan §6.1). */
const MAX_ATTENTION = 50;
const MAX_TOP_APIS = 10;
const MAX_SUBSCRIPTIONS_LISTED = 50;

export interface DashboardQuery {
  environment: string;
  sinceMin: number;
  applicationId?: string;
}

function bounded(rows: AttentionRow[]): { attention: AttentionRow[]; attentionTruncated: number } {
  // The three start-here codes are produced only into `startHere`. Asserted here rather than
  // trusted, because a rule that leaked one would put "publish your first API" on an application with
  // fifty `[P2-09]`.
  const usable = rows.filter((row) => !START_HERE_CODES.includes(row.code));
  return {
    attention: usable.slice(0, MAX_ATTENTION),
    attentionTruncated: Math.max(0, usable.length - MAX_ATTENTION),
  };
}

export function buildDashboard(ctx: Ctx, query: DashboardQuery) {
  const user = requireUser(ctx);
  const app = ctx.app;
  const now = Date.now();
  const scope: Scope = { ...scopeFor(app, user, query.environment), now, configErrors: new Map() };
  // dashboard-health: the selected application's figures must match the lists they open.
  if (query.applicationId) scope.applications = [query.applicationId];

  // The platform block first: it builds each environment's config document, and seeding the
  // memo from it is what stops `config-error` rebuilding the same document a second time.
  const platform = platformBlock(ctx, scope);

  const traffic = trafficFor(ctx, scope, query.sinceMin, now);
  const owner = {
    apis: apiCounts(ctx, scope),
    traffic: traffic.summary,
    topApis: traffic.topApis,
    ...bounded(ownerAttention(app, scope)),
  };

  const subscriptions = consumerSubscriptions(app, scope);
  const consumer = {
    applications: applications(ctx, scope),
    subscriptions: subscriptions.slice(0, MAX_SUBSCRIPTIONS_LISTED).map((subscription) => {
      const quota = quotaFor(app, subscription, now);
      return {
        id: subscription.id,
        name: subscriptionLabel(subscription),
        environment: subscription.environment,
        state: subscription.state,
        productId: subscription.product_id,
        // "No quota" is a different statement from "0 of 0" (plan §6.2), so the limit stays null
        // and the UI says so in words.
        quota: quota.limit === null ? null : quota,
        keyAgeDays: Math.floor(
          (now - Date.parse(subscription.key_rotated_at ?? subscription.created_at)) / 86_400_000,
        ),
        keyRotatedAt: subscription.key_rotated_at,
      };
    }),
    subscriptionsTruncated: Math.max(0, subscriptions.length - MAX_SUBSCRIPTIONS_LISTED),
    ...bounded(consumerAttention(app, scope)),
  };

  const hats: string[] = [];
  if (owner.apis.total > 0) hats.push("owner");
  if (subscriptions.length > 0) hats.push("consumer");
  if (user.isAdmin) hats.push("platform");

  return {
    generatedAt: new Date(now).toISOString(),
    environment: query.environment,
    sinceMin: query.sinceMin,
    // False exactly when `previous` is null, so one meaning has one field `[P2-11]`.
    trendAvailable: traffic.trendAvailable,
    hats,
    owner,
    consumer,
    platform,
    startHere: startHere(app, user, scope),
  };
}

// --------------------------------------------------------------------------- owner

function apiCounts(ctx: Ctx, scope: Scope) {
  const applications = scope.applications;
  if (applications !== null && applications.length === 0) {
    return { total: 0, byLifecycle: {}, liveByEnvironment: {} };
  }
  const where = applications === null ? "" : ` WHERE application_id IN (${applications.map(() => "?").join(", ")})`;
  const args = (applications ?? []) as string[];

  const byLifecycle: Record<string, number> = {};
  let total = 0;
  for (const row of ctx.app.db
    .query<{ lifecycle: string; n: number }, string[]>(
      `SELECT lifecycle, COUNT(*) AS n FROM resource${where} GROUP BY lifecycle`,
    )
    .all(...args)) {
    byLifecycle[row.lifecycle] = row.n;
    total += row.n;
  }

  const liveByEnvironment: Record<string, number> = {};
  for (const environment of scope.environments) liveByEnvironment[environment] = 0;
  const applicationJoin = applications === null ? "" : ` AND r.application_id IN (${applications.map(() => "?").join(", ")})`;
  for (const row of ctx.app.db
    .query<{ environment: string; n: number }, string[]>(
      `SELECT rel.environment, COUNT(*) AS n
         FROM release rel JOIN resource r ON r.id = rel.resource_id
        WHERE rel.state = 'converged'
          AND rel.environment IN (${scope.environments.map(() => "?").join(", ")})${applicationJoin}
        GROUP BY rel.environment`,
    )
    .all(...scope.environments, ...args)) {
    liveByEnvironment[row.environment] = row.n;
  }

  return { total, byLifecycle, liveByEnvironment };
}

/**
 * Traffic, the series, and the same window one step back. Read through `rowsFor`, the function
 * `/api/telemetry/*` already uses, so the dashboard and the traffic screen cannot disagree.
 */
function trafficFor(ctx: Ctx, scope: Scope, sinceMin: number, now: number) {
  const sinceIso = new Date(now - sinceMin * 60_000).toISOString();
  const previousSinceIso = new Date(now - 2 * sinceMin * 60_000).toISOString();
  const retentionMin = ctx.app.config.telemetryRetentionHours * 60;
  const trendAvailable = 2 * sinceMin <= retentionMin;

  const rows: Row[] = [];
  const previousRows: Row[] = [];
  let truncated = false;
  for (const environment of scope.environments) {
    const current = rowsFor(ctx, environment, sinceIso);
    truncated ||= current.length >= MAX_SCANNED_ROWS;
    rows.push(...current);
    if (trendAvailable) previousRows.push(...rowsFor(ctx, environment, previousSinceIso, sinceIso));
  }

  const totals = rows.reduce(fold, emptyTotals());
  const perMinute = groupBy(rows, (row) => row.window_start);
  const byResource = groupBy(rows, (row) => row.resource_id);
  const names = new Map(
    ctx.app.db
      .query<{ id: string; name: string; api_version: string }, never[]>(
        "SELECT id, name, api_version FROM resource",
      )
      .all()
      .map((row) => [row.id, row]),
  );

  return {
    trendAvailable,
    summary: {
      ...summarise(totals),
      truncated,
      series: [...perMinute.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([windowStart, group]: [string, Totals]) => ({
          windowStart,
          requests: group.requests,
          ok: group.ok,
          gatewayRejections: group.gatewayRejections,
          upstreamErrors: group.upstreamErrors,
          p95Ms: percentile(group.buckets, 0.95),
        })),
      // Null rather than a number computed over a window retention cannot cover.
      previous: trendAvailable ? summarise(previousRows.reduce(fold, emptyTotals())) : null,
    },
    topApis: [...byResource.entries()]
      .map(([resourceId, group]) => {
        const resource = names.get(resourceId);
        return {
          resourceId,
          // The `''` bucket is the estate's 404 traffic; `rowsFor` only shows it to an admin.
          name: resource
            ? `${resource.name} ${resource.api_version}`
            : resourceId === ""
              ? "(no route matched)"
              : "(deleted)",
          requests: group.requests,
          ok: group.ok,
          gatewayRejections: group.gatewayRejections,
          upstreamErrors: group.upstreamErrors,
          errorRate: group.requests === 0 ? 0 : 1 - group.ok / group.requests,
          p95Ms: percentile(group.buckets, 0.95),
        };
      })
      .sort((a, b) => b.requests - a.requests)
      .slice(0, MAX_TOP_APIS),
  };
}

// --------------------------------------------------------------------------- consumer

function applications(ctx: Ctx, scope: Scope) {
  const applications = scope.applications;
  if (applications !== null && applications.length === 0) return [];
  const where = applications === null ? "" : ` WHERE a.id IN (${applications.map(() => "?").join(", ")})`;
  return ctx.app.db
    .query<{ id: string; name: string; application_id: string; subscriptions: number }, string[]>(
      `SELECT a.id, a.name, a.id AS application_id,
              (SELECT COUNT(*) FROM subscription s
                WHERE s.application_id = a.id AND s.state = 'active') AS subscriptions
         FROM application a${where}
        ORDER BY a.name LIMIT ${MAX_SUBSCRIPTIONS_LISTED}`,
    )
    .all(...((applications ?? []) as string[]))
    .map((row) => ({
      id: row.id,
      name: row.name,
      applicationId: row.application_id,
      subscriptions: row.subscriptions,
    }));
}

// --------------------------------------------------------------------------- platform

function platformBlock(ctx: Ctx, scope: Scope) {
  const user = requireUser(ctx);
  const now = scope.now ?? Date.now();
  const soon = new Date(now + 30 * 86_400_000).toISOString();
  const nowIso = new Date(now).toISOString();

  const environments = scope.environments.map((environment) => {
    const health = healthFor(ctx, environment);
    if (health) {
      // Seeding the memo here is what stops `config-error` rebuilding this document again.
      scope.configErrors?.set(environment, health.errors as ConfigError[]);
    }
    const anchors = ctx.app.db
      .query<{ live: number; expiring: number }, [string, string, string]>(
        `SELECT COUNT(*) AS live,
                SUM(CASE WHEN not_after <= ? THEN 1 ELSE 0 END) AS expiring
           FROM trust_anchor
          WHERE environment = ? AND removed_at IS NULL AND not_after > ?`,
      )
      .get(soon, environment, nowIso)!;
    const activeTlsExceptions = ctx.app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM tls_exception
          WHERE environment = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(environment, nowIso)!.n;

    return {
      environment,
      hasTarget: health !== null,
      instances: health?.instances.length ?? 0,
      live: health?.liveInstances ?? 0,
      inSync: health?.inSync ?? false,
      configDigest: health?.configDigest ?? null,
      activeTlsExceptions,
      trustAnchors: anchors.live,
      expiringAnchors: anchors.expiring ?? 0,
      configErrors: health?.configErrors ?? 0,
    };
  });

  return {
    environments,
    ...bounded(platformAttention(ctx.app, scope, { jobs: user.isAdmin })),
    // Absent rather than empty for a non-admin: an empty block reads as "nothing is wrong".
    admin: user.isAdmin ? adminCounts(ctx) : null,
  };
}

function adminCounts(ctx: Ctx) {
  const one = (sql: string, args: string[] = []) =>
    ctx.app.db.query<{ n: number }, string[]>(sql).get(...args)!.n;
  return {
    failedJobs: one("SELECT COUNT(*) AS n FROM job WHERE state = 'failed'"),
    staleReleases: one("SELECT COUNT(*) AS n FROM release WHERE state IN ('failed', 'stale')"),
    downgrades: one(
      `SELECT COUNT(*) AS n FROM policy_entry
        WHERE unit_key = 'validate'
          AND json_extract(value_json, '$.request') IS NOT NULL
          AND json_extract(value_json, '$.request') <> 'blocking'`,
    ),
  };
}

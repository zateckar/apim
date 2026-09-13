import {
  ATTENTION_SEVERITY,
  sortAttention,
  type AttentionCode,
  type AttentionRow,
  type AttentionSubject,
} from "../../shared/attention.ts";
import { AUTH_UNITS, operationUnitKey } from "../../shared/policy.ts";
import type { User } from "./auth.ts";
import { buildRoutes, limitsFor } from "./config-build.ts";
import { denyRulesFor } from "./deny-rules.ts";
import type { DB } from "./db.ts";
import type { App } from "./router.ts";

/**
 * The one evaluator (plan §6.3, review `[P1-04]`).
 *
 * Called by `GET /api/dashboard` and by `GET /api/resources/:id`, so the API page's banner and the
 * dashboard's list are literally the same rows — a user cannot be told two different things about
 * one API depending on which screen they are looking at.
 *
 * **It is a fixed set of SQL queries returning candidates, never a load-everything loop**
 * `[P2-03]`. Every query is anti-joined, environment-scoped, application-scoped and `LIMIT`ed, so an application
 * with five hundred APIs costs the same shape of work as an application with five. The one place that
 * leaves SQL is `config-error`, which asks the config builder — the same function the poll uses —
 * because "is this route being served" has exactly one correct answer and it lives there.
 */

/** Per rule. The endpoint truncates to its own, smaller bound; this stops one bad rule dominating. */
const RULE_LIMIT = 200;

/** How long before a certificate, an anchor or a TLS exception is worth mentioning. */
const EXPIRY_WINDOW_DAYS = 30;
const TLS_EXCEPTION_WINDOW_DAYS = 7;
const KEY_AGE_DAYS = 90;

export interface ConfigError {
  resourceId: string;
  resourceName: string;
  detail: string;
}

export interface Scope {
  /** Which environments to consider — one, or the whole chain for `environment=all`. */
  environments: string[];
  /** The caller's applications, or `null` for an admin: null means "no application filter at all". */
  applications: string[] | null;
  /** One resource, for the API page's banner. */
  resourceId?: string;
  now?: number;
  /**
   * A memo for `config-error`, the one rule that leaves SQL. The dashboard needs the same answer
   * twice — as rows in the owner block and as a count per environment — and rebuilding the config
   * document twice for one request would be paying for the same work twice.
   */
  configErrors?: Map<string, ConfigError[]>;
}

export function scopeFor(app: App, user: User, environment: string, resourceId?: string): Scope {
  return {
    environments: environment === "all" ? [...app.config.promotionChain] : [environment],
    applications: user.isAdmin ? null : user.applications,
    ...(resourceId ? { resourceId } : {}),
  };
}

function row(
  code: AttentionCode,
  subject: AttentionSubject,
  detail: string,
  href: string,
  environment?: string,
): AttentionRow {
  return {
    code,
    severity: ATTENTION_SEVERITY[code],
    subject,
    ...(environment ? { environment } : {}),
    detail: sentence(detail),
    href,
  };
}

/**
 * Several rows end in text somebody else wrote — a release's reason, an instance's activation
 * failure — and a reason rarely ends in a full stop. The rule that every row is a sentence is
 * enforced here rather than hoped for at each call site.
 */
function sentence(detail: string): string {
  const trimmed = detail.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * `IN (?, ?, …)` with one placeholder per value. Built here rather than interpolated because these
 * lists come from the session and the promotion chain, and a query builder that concatenates values
 * is one refactor away from concatenating a parameter.
 */
function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

interface Filter {
  sql: string;
  args: string[];
}

/** The application and resource filters every owner query carries, as one reusable fragment. */
function ownerFilter(scope: Scope, alias = "r"): Filter {
  const parts: string[] = [];
  const args: string[] = [];
  if (scope.applications !== null) {
    if (scope.applications.length === 0) return { sql: " AND 0 = 1", args: [] };
    parts.push(`${alias}.application_id IN (${placeholders(scope.applications)})`);
    args.push(...scope.applications);
  }
  if (scope.resourceId) {
    parts.push(`${alias}.id = ?`);
    args.push(scope.resourceId);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", args };
}

function apiName(name: string, apiVersion: string): string {
  return `${name} ${apiVersion}`;
}

// --------------------------------------------------------------------------- owner rules

interface ResourceRow {
  id: string;
  name: string;
  api_version: string;
  application_id: string;
}

interface EnvResourceRow extends ResourceRow {
  environment: string;
}

export function ownerAttention(app: App, scope: Scope): AttentionRow[] {
  const { db } = app;
  const envs = scope.environments;
  const owner = ownerFilter(scope);
  const rows: AttentionRow[] = [];
  const now = scope.now ?? Date.now();

  // --- an API that cannot serve traffic yet -------------------------------------------------

  // No definition: there is nothing to publish, so nothing else about it is worth saying.
  const noDefinition = db
    .query<ResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id
         FROM resource r
        WHERE NOT EXISTS (SELECT 1 FROM revision v WHERE v.resource_id = r.id)${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...owner.args);
  const undefinedIds = new Set(noDefinition.map((r) => r.id));
  for (const r of noDefinition) {
    rows.push(
      row(
        "no-definition",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        "This API has no definition yet, so there is nothing to publish. Import an OpenAPI or WSDL file, or point at a URL.",
        `/apis/${r.id}/definition`,
      ),
    );
  }

  /**
   * A route or a binding is reported **only for an environment the API has begun to occupy** —
   * one where the other half of the pair, or a release, already exists. Otherwise every new API
   * would carry "no route in PROD" from the minute it was created, which is noise rather than
   * attention.
   */
  const noRoute = db
    .query<EnvResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, e.environment
         FROM resource r
         JOIN (SELECT resource_id, environment FROM binding
               UNION SELECT resource_id, environment FROM release) e ON e.resource_id = r.id
        WHERE e.environment IN (${placeholders(envs)})
          AND NOT EXISTS (SELECT 1 FROM route rt WHERE rt.resource_id = r.id AND rt.environment = e.environment)
          ${owner.sql}
        GROUP BY r.id, e.environment
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of noRoute) {
    rows.push(
      row(
        "no-route",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `No route in ${r.environment.toUpperCase()}: nothing tells the gateway which host and path this API answers on.`,
        `/apis/${r.id}/publish?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  const noBinding = db
    .query<EnvResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, e.environment
         FROM resource r
         JOIN (SELECT resource_id, environment FROM route
               UNION SELECT resource_id, environment FROM release) e ON e.resource_id = r.id
        WHERE e.environment IN (${placeholders(envs)})
          AND NOT EXISTS (SELECT 1 FROM binding b WHERE b.resource_id = r.id AND b.environment = e.environment)
          ${owner.sql}
        GROUP BY r.id, e.environment
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of noBinding) {
    rows.push(
      row(
        "no-binding",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `No backend in ${r.environment.toUpperCase()}: the gateway would have nowhere to send the request.`,
        `/apis/${r.id}/publish?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  // Never released anywhere in scope. Not per environment: "not in PROD yet" is the promotion
  // screen's job, and saying it here for every API in every environment would drown the list.
  const neverReleased = db
    .query<ResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id
         FROM resource r
        WHERE EXISTS (SELECT 1 FROM revision v WHERE v.resource_id = r.id)
          AND NOT EXISTS (
                SELECT 1 FROM release rel
                 WHERE rel.resource_id = r.id AND rel.environment IN (${placeholders(envs)})
              )${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of neverReleased) {
    rows.push(
      row(
        "never-released",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        "This API has a definition but has never been published, so nobody can call it yet.",
        `/apis/${r.id}/publish`,
      ),
    );
  }

  // The newest release per (resource, environment) that did not land. An older failure that has
  // since been superseded is history, not attention.
  const failed = db
    .query<EnvResourceRow & { state: string; reason: string | null; rev: number }, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, rel.environment, rel.state, rel.reason, v.rev
         FROM release rel
         JOIN resource r  ON r.id = rel.resource_id
         JOIN revision v  ON v.id = rel.revision_id
        WHERE rel.environment IN (${placeholders(envs)})
          AND rel.state IN ('failed', 'stale')
          AND rel.released_at = (
                SELECT MAX(released_at) FROM release x
                 WHERE x.resource_id = rel.resource_id AND x.environment = rel.environment
              )${owner.sql}
        ORDER BY rel.released_at DESC LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of failed) {
    const code = r.state === "failed" ? "release-failed" : "release-stale";
    rows.push(
      row(
        code,
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        r.state === "failed"
          ? `Publishing revision ${r.rev} to ${r.environment.toUpperCase()} failed: ${r.reason ?? "no reason was recorded"}.`
          : `The plan for revision ${r.rev} in ${r.environment.toUpperCase()} changed before it was applied, so nothing was published. Review it and confirm again.`,
        `/apis/${r.id}/publish?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  // A route the gateway is not serving. Asked of the config builder rather than re-derived, so
  // this row and the gateway's own `errors` block can never disagree `[P3-02]`.
  for (const environment of envs) {
    for (const error of configErrorsFor(app, environment, scope)) {
      if (scope.resourceId && error.resourceId !== scope.resourceId) continue;
      if (!ownedByScope(db, scope, error.resourceId)) continue;
      rows.push(
        row(
          "config-error",
          { kind: "resource", id: error.resourceId, name: error.resourceName },
          `${error.detail} Until it is fixed, callers get a 404 in ${environment.toUpperCase()}.`,
          `/apis/${error.resourceId}/policy?environment=${environment}`,
          environment,
        ),
      );
    }
  }

  // --- an API that serves traffic without a control somebody would expect ---------------------

  // Both of these are anti-joins over the two policy tiers: a unit attached to the environment's
  // global tier counts, because the effective document is what the gateway runs `[R2-17]`.
  //
  // A unit the resource has switched off does not count either. It is attached and it is stored,
  // and it is not running — which is exactly the state this rule exists to notice, so reading
  // "attached" from the row alone would let somebody disable the only authentication on a route
  // and have the estate go quiet about it.
  const notDisabled = `AND NOT EXISTS (
                SELECT 1 FROM policy_entry d, json_each(d.value_json) je
                 WHERE d.resource_id = r.id AND d.environment = rel.environment
                   AND d.unit_key = 'disabled' AND je.value = %UNIT%
              )`;
  const openRoutes = db
    .query<EnvResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, rel.environment
         FROM release rel
         JOIN resource r ON r.id = rel.resource_id
        WHERE rel.state = 'converged' AND rel.environment IN (${placeholders(envs)})
          AND NOT EXISTS (
                SELECT 1 FROM policy_entry p
                 WHERE p.resource_id = r.id AND p.environment = rel.environment
                   AND p.unit_key IN (${placeholders(AUTH_UNITS)})
                   ${notDisabled.replace("%UNIT%", "p.unit_key")}
              )
          AND NOT EXISTS (
                SELECT 1 FROM global_policy_entry g
                 WHERE g.environment = rel.environment
                   AND g.unit_key IN (${placeholders(AUTH_UNITS)})
                   ${notDisabled.replace("%UNIT%", "g.unit_key")}
              )${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...AUTH_UNITS, ...AUTH_UNITS, ...owner.args);
  for (const r of openRoutes) {
    rows.push(
      row(
        "no-auth-policy",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `Anyone who can reach the gateway can call this API in ${r.environment.toUpperCase()}: no authentication is attached, so its traffic is not attributable to anyone.`,
        `/apis/${r.id}/policy?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  const noCeiling = db
    .query<EnvResourceRow, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, rel.environment
         FROM release rel
         JOIN resource r ON r.id = rel.resource_id
        WHERE rel.state = 'converged' AND rel.environment IN (${placeholders(envs)})
          AND NOT EXISTS (
                SELECT 1 FROM policy_entry p
                 WHERE p.resource_id = r.id AND p.environment = rel.environment AND p.unit_key = 'concurrency'
                   ${notDisabled.replace("%UNIT%", "p.unit_key")}
              )
          AND NOT EXISTS (
                SELECT 1 FROM global_policy_entry g
                 WHERE g.environment = rel.environment AND g.unit_key = 'concurrency'
                   ${notDisabled.replace("%UNIT%", "g.unit_key")}
              )${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of noCeiling) {
    rows.push(
      row(
        "no-concurrency-ceiling",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `No concurrency limit in ${r.environment.toUpperCase()}: if this backend stops answering, requests pile up on every gateway instead of being shed.`,
        `/apis/${r.id}/policy?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  // The same rule `GET /api/validation/downgrades` applies: a `request` that is set and is not
  // blocking. `json_extract` returns NULL when the key is absent, and NULL fails the comparison.
  const downgraded = db
    .query<EnvResourceRow & { request: string }, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, p.environment,
              json_extract(p.value_json, '$.request') AS request
         FROM policy_entry p
         JOIN resource r ON r.id = p.resource_id
        WHERE p.unit_key = 'validate' AND p.environment IN (${placeholders(envs)})
          AND json_extract(p.value_json, '$.request') IS NOT NULL
          AND json_extract(p.value_json, '$.request') <> 'blocking'${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...owner.args);
  for (const r of downgraded) {
    rows.push(
      row(
        "validation-downgraded",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `Request validation is "${r.request}" in ${r.environment.toUpperCase()}, which observes and never rejects — so an invalid request reaches the backend.`,
        `/apis/${r.id}/policy?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  // The *newest* revision is not the one live anywhere in scope: an edit somebody has not
  // published. Anchored on `MAX(rev)` in a subquery rather than grouped, because grouping over the
  // unreleased revisions would report the newest *old* one and call a current API out of date.
  const unreleased = db
    .query<ResourceRow & { rev: number }, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, v.rev
         FROM revision v
         JOIN resource r ON r.id = v.resource_id
        WHERE v.pruned_at IS NULL
          AND v.rev = (
                SELECT MAX(x.rev) FROM revision x
                 WHERE x.resource_id = r.id AND x.pruned_at IS NULL
              )
          AND EXISTS (
                SELECT 1 FROM release rel
                 WHERE rel.resource_id = r.id AND rel.state = 'converged'
                   AND rel.environment IN (${placeholders(envs)})
              )
          AND NOT EXISTS (
                SELECT 1 FROM release rel
                 WHERE rel.revision_id = v.id AND rel.state = 'converged'
                   AND rel.environment IN (${placeholders(envs)})
              )${owner.sql}
        ORDER BY r.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, ...envs, ...owner.args);
  for (const r of unreleased) {
    rows.push(
      row(
        "unreleased-revision",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        `Revision ${r.rev} has never been published, so what callers see is an older definition.`,
        `/apis/${r.id}/revisions`,
      ),
    );
  }

  // --- credentials and exceptions with a date on them ----------------------------------------

  const nowIso = new Date(now).toISOString();
  const exceptionSoon = new Date(now + TLS_EXCEPTION_WINDOW_DAYS * 86_400_000).toISOString();
  const exceptions = db
    .query<EnvResourceRow & { mode: string; expires_at: string; reason: string }, string[]>(
      `SELECT r.id, r.name, r.api_version, r.application_id, x.environment, x.mode, x.expires_at, x.reason
         FROM tls_exception x
         JOIN resource r ON r.id = x.resource_id
        WHERE x.revoked_at IS NULL AND x.expires_at > ? AND x.environment IN (${placeholders(envs)})${owner.sql}
        ORDER BY x.expires_at LIMIT ${RULE_LIMIT}`,
    )
    .all(nowIso, ...envs, ...owner.args);
  for (const r of exceptions) {
    const expiring = r.expires_at <= exceptionSoon;
    rows.push(
      row(
        expiring ? "tls-exception-expiring" : "tls-exception-active",
        { kind: "resource", id: r.id, name: apiName(r.name, r.api_version) },
        expiring
          ? `The TLS exception on this backend in ${r.environment.toUpperCase()} expires on ${day(r.expires_at)}. When it does, the gateway verifies the certificate again and calls fail unless the backend has been fixed.`
          : `This backend's certificate is not fully verified in ${r.environment.toUpperCase()} (${r.mode}), until ${day(r.expires_at)}. Registering the issuing authority under Trust removes the need for it.`,
        // The backend's own screen: an exception is a property of where this API forwards to.
        `/apis/${r.id}/routing?environment=${r.environment}`,
        r.environment,
      ),
    );
  }

  const certSoon = new Date(now + EXPIRY_WINDOW_DAYS * 86_400_000).toISOString();
  const certApplication =
    scope.applications === null
      ? { sql: "", args: [] as string[] }
      : {
          sql:
            scope.applications.length === 0 ? " AND 0 = 1" : ` AND c.application_id IN (${placeholders(scope.applications)})`,
          args: scope.applications,
        };
  // Not on one API's page: a certificate belongs to an application and an environment, and several APIs
  // may present it, so it is the application's row rather than any single API's.
  const certificates = scope.resourceId
    ? []
    : db
        .query<
          { id: string; name: string; environment: string; not_after: string },
          string[]
        >(
          `SELECT c.id, c.name, c.environment, c.not_after
             FROM certificate c
            WHERE c.not_after <= ? AND c.environment IN (${placeholders(envs)})${certApplication.sql}
            ORDER BY c.not_after LIMIT ${RULE_LIMIT}`,
        )
        .all(certSoon, ...envs, ...certApplication.args);
  for (const c of certificates) {
    rows.push(
      row(
        "certificate-expiring",
        { kind: "certificate", id: c.id, name: c.name },
        c.not_after <= nowIso
          ? `The client certificate "${c.name}" expired on ${day(c.not_after)}, so every backend that presents it is failing now.`
          : `The client certificate "${c.name}" expires on ${day(c.not_after)}. Upload the replacement before then — the gateway waits for it, so nothing breaks at the moment of upload.`,
        `/trust?environment=${c.environment}`,
        c.environment,
      ),
    );
  }

  return sortAttention(rows);
}

/** One row's worth of ownership, for the rules that do not carry the application through their own SQL. */
function ownedByScope(db: DB, scope: Scope, resourceId: string): boolean {
  if (scope.applications === null) return true;
  if (scope.applications.length === 0) return false;
  const owner = db
    .query<{ application_id: string }, [string]>("SELECT application_id FROM resource WHERE id = ?")
    .get(resourceId);
  return owner !== null && scope.applications.includes(owner.application_id);
}

/**
 * The routes this environment is *not* serving, from the config builder itself — so this list and
 * the `errors` block the gateways receive are the same list. Memoised through the scope when the
 * caller passes one.
 */
export function configErrorsFor(app: App, environment: string, scope?: Scope): ConfigError[] {
  const cached = scope?.configErrors?.get(environment);
  if (cached) return cached;
  const { errors } = buildRoutes(
    app.db,
    environment,
    limitsFor(app.config.integrations),
    denyRulesFor(app.db, app.config.publicUrl),
  );
  const list = errors ?? [];
  scope?.configErrors?.set(environment, list);
  return list;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

// --------------------------------------------------------------------------- consumer rules

interface SubscriptionRow {
  id: string;
  environment: string;
  state: string;
  product_id: string;
  created_at: string;
  key_rotated_at: string | null;
  primary_key_at: string | null;
  secondary_key_at: string | null;
  secondary_key_enc: string | null;
  primary_key_expired_at: string | null;
  secondary_key_expired_at: string | null;
  application_name: string;
  product_name: string;
}

/** ≤ this many of the caller's subscriptions are examined; the list is bounded everywhere. */
const MAX_SUBSCRIPTIONS = 200;

export function consumerSubscriptions(app: App, scope: Scope): SubscriptionRow[] {
  const applications = scope.applications;
  if (applications !== null && applications.length === 0) return [];
  const applicationSql = applications === null ? "" : ` AND a.id IN (${placeholders(applications)})`;
  return app.db
    .query<SubscriptionRow, string[]>(
      `SELECT s.id, s.environment, s.state, s.product_id, s.created_at, s.key_rotated_at,
              s.primary_key_at, s.secondary_key_at, s.secondary_key_enc,
              s.primary_key_expired_at, s.secondary_key_expired_at,
              a.name AS application_name, p.name AS product_name
         FROM subscription s
         JOIN application a ON a.id = s.application_id
         JOIN product p     ON p.id = s.product_id
        WHERE s.environment IN (${placeholders(scope.environments)})${applicationSql}
        ORDER BY s.created_at DESC LIMIT ${MAX_SUBSCRIPTIONS}`,
    )
    .all(...scope.environments, ...(applications ?? []));
}

export function subscriptionLabel(subscription: SubscriptionRow): string {
  return `${subscription.application_name} → ${subscription.product_name}`;
}

export interface QuotaView {
  /** null when no `quota` unit applies: "no quota", never `0 / 0` (plan §6.2). */
  limit: number | null;
  used: number;
  fraction: number | null;
  resetsInSec: number | null;
  periodSec: number | null;
}

/**
 * What this subscription has spent against its quota. `usage_counter` is enforcement state and a
 * floor rather than a ledger (D15), so the number is reported as such wherever it is shown.
 */
export function quotaFor(app: App, subscription: SubscriptionRow, now: number): QuotaView {
  const counters = app.db
    .query<
      { scope_kind: string; scope_id: string; period_sec: number; window_start: string; count: number },
      [string, string]
    >(
      `SELECT scope_kind, scope_id, period_sec, window_start, count
         FROM usage_counter
        WHERE subscription_id = ? AND environment = ?
        ORDER BY window_start DESC LIMIT 100`,
    )
    .all(subscription.id, subscription.environment);

  let worst: QuotaView = { limit: null, used: 0, fraction: null, resetsInSec: null, periodSec: null };
  for (const counter of counters) {
    const endsAt = Date.parse(counter.window_start) + counter.period_sec * 1000;
    if (endsAt <= now) continue;
    const limit = quotaLimit(app, subscription, counter.scope_kind, counter.scope_id);
    const fraction = limit === null ? null : counter.count / limit;
    if (fraction === null) {
      if (worst.limit === null && counter.count > worst.used) worst = { ...worst, used: counter.count };
      continue;
    }
    if (worst.fraction === null || fraction > worst.fraction) {
      worst = {
        limit,
        used: counter.count,
        fraction,
        resetsInSec: Math.max(0, Math.round((endsAt - now) / 1000)),
        periodSec: counter.period_sec,
      };
    }
  }
  return worst;
}

/**
 * The `quota` unit the counter was counting against, found the way the gateway keyed it (D31's
 * `applyQuota`): a `route` counter's scope id is the resource, a `product` counter's is the
 * product, and an `operation` counter's is `<resourceId>:<operationId>` and reads the
 * operation-scoped unit.
 */
function quotaLimit(
  app: App,
  subscription: SubscriptionRow,
  scopeKind: string,
  scopeId: string,
): number | null {
  if (scopeKind === "operation") {
    const separator = scopeId.lastIndexOf(":");
    if (separator > 0) {
      const resourceId = scopeId.slice(0, separator);
      const operationId = scopeId.slice(separator + 1);
      const scoped = unitCalls(app, resourceId, subscription.environment, operationUnitKey(operationId, "quota"));
      if (scoped !== null) return scoped;
      // An operation counter under a route-level unit is legitimate: the override may have been
      // removed while a window it opened is still counting.
      return unitCalls(app, resourceId, subscription.environment, "quota");
    }
  }

  const resourceIds =
    scopeKind === "route"
      ? [scopeId]
      : app.db
          .query<{ resource_id: string }, [string]>(
            "SELECT resource_id FROM product_member WHERE product_id = ?",
          )
          .all(scopeKind === "product" ? scopeId : subscription.product_id)
          .map((r) => r.resource_id);

  for (const resourceId of resourceIds) {
    const calls = unitCalls(app, resourceId, subscription.environment, "quota");
    if (calls !== null) return calls;
  }
  const global = app.db
    .query<{ calls: number | null }, [string]>(
      `SELECT json_extract(value_json, '$.calls') AS calls
         FROM global_policy_entry WHERE environment = ? AND unit_key = 'quota'`,
    )
    .get(subscription.environment);
  return global?.calls ?? null;
}

function unitCalls(app: App, resourceId: string, environment: string, unitKey: string): number | null {
  const row = app.db
    .query<{ calls: number | null }, [string, string, string]>(
      `SELECT json_extract(value_json, '$.calls') AS calls
         FROM policy_entry WHERE resource_id = ? AND environment = ? AND unit_key = ?`,
    )
    .get(resourceId, environment, unitKey);
  return row?.calls ?? null;
}

export function consumerAttention(app: App, scope: Scope): AttentionRow[] {
  const now = scope.now ?? Date.now();
  const rows: AttentionRow[] = [];
  const subscriptions = consumerSubscriptions(app, scope).filter((s) => s.state === "active");

  for (const subscription of subscriptions) {
    const subject: AttentionSubject = {
      kind: "subscription",
      id: subscription.id,
      name: subscriptionLabel(subscription),
    };
    const href = `/subscriptions/${subscription.id}`;

    const quota = quotaFor(app, subscription, now);
    if (quota.fraction !== null && quota.fraction >= 1) {
      rows.push(
        row(
          "quota-exhausted",
          subject,
          `This subscription has used its whole quota in ${subscription.environment.toUpperCase()} (${quota.used} of ${quota.limit}). Calls are being refused until the window resets.`,
          href,
          subscription.environment,
        ),
      );
    } else if (quota.fraction !== null && quota.fraction >= 0.8) {
      rows.push(
        row(
          "quota-80",
          subject,
          `${Math.round(quota.fraction * 100)}% of this subscription's quota in ${subscription.environment.toUpperCase()} is used (${quota.used} of ${quota.limit}).`,
          href,
          subscription.environment,
        ),
      );
    }

    // Per slot, and against the estate's own thresholds rather than a constant. The old rule read
    // `key_rotated_at`, which is written by a rotation of *either* key — so rotating the secondary,
    // the very move that leaves the primary old, silenced the warning about the primary.
    const expireDays = app.config.subscriptionKeyExpireDays;
    const warnDays = app.config.subscriptionKeyWarnDays;
    for (const which of ["primary", "secondary"] as const) {
      const present =
        which === "primary" ? true : subscription.secondary_key_enc !== null;
      if (!present) continue;
      const expiredAt =
        which === "primary"
          ? subscription.primary_key_expired_at
          : subscription.secondary_key_expired_at;
      if (expiredAt !== null) {
        rows.push(
          row(
            "key-expired",
            subject,
            `This subscription's ${which} key expired on ${day(expiredAt)} and the gateway no longer accepts it. Rotate it to mint a replacement — the other key is unaffected.`,
            href,
            subscription.environment,
          ),
        );
        continue;
      }
      const mintedAt =
        (which === "primary" ? subscription.primary_key_at : subscription.secondary_key_at) ??
        subscription.created_at;
      const ageDays = Math.floor((now - Date.parse(mintedAt)) / 86_400_000);
      if (ageDays >= warnDays) {
        rows.push(
          row(
            "key-ageing",
            subject,
            `This subscription's ${which} key is ${ageDays} days old and stops working at ${expireDays}. Rotating gives you a second key first, so nothing breaks while callers move across.`,
            href,
            subscription.environment,
          ),
        );
      }
    }
  }

  // One query for every lifecycle warning, rather than one per subscription.
  const ids = subscriptions.map((s) => s.id);
  if (ids.length > 0) {
    const byId = new Map(subscriptions.map((s) => [s.id, s]));
    const lifecycle = app.db
      .query<
        { subscription_id: string; resource_id: string; name: string; api_version: string; lifecycle: string; sunset_at: string | null },
        string[]
      >(
        `SELECT s.id AS subscription_id, r.id AS resource_id, r.name, r.api_version, r.lifecycle, r.sunset_at
           FROM subscription s
           JOIN product_member pm ON pm.product_id = s.product_id
           JOIN resource r        ON r.id = pm.resource_id
          WHERE s.id IN (${placeholders(ids)}) AND r.lifecycle <> 'active'
          ORDER BY r.lifecycle DESC LIMIT ${RULE_LIMIT}`,
      )
      .all(...ids);
    for (const entry of lifecycle) {
      const subscription = byId.get(entry.subscription_id)!;
      const subject: AttentionSubject = {
        kind: "subscription",
        id: subscription.id,
        name: subscriptionLabel(subscription),
      };
      const api = apiName(entry.name, entry.api_version);
      rows.push(
        entry.lifecycle === "retired"
          ? row(
              "subscribed-api-retired",
              subject,
              `${api} has been retired. It is no longer served, so calls to it fail — move to a newer version.`,
              `/apis/${entry.resource_id}`,
              subscription.environment,
            )
          : row(
              "subscribed-api-deprecated",
              subject,
              entry.sunset_at
                ? `${api} is deprecated and is planned to stop serving on ${day(entry.sunset_at)}. Move to a newer version before then.`
                : `${api} is deprecated: it still works, but a newer version exists and this one will stop at some point.`,
              `/apis/${entry.resource_id}`,
              subscription.environment,
            ),
      );
    }
  }

  return sortAttention(rows);
}

// --------------------------------------------------------------------------- platform rules

/**
 * The estate's own rows. `gateway-*` is shown to everyone — "my API is live but nobody is serving
 * it" is an owner's question before it is an operator's — while a failed background job carries an
 * internal message and belongs to whoever can act on it, so it is admin-only.
 */
export function platformAttention(app: App, scope: Scope, options: { jobs: boolean }): AttentionRow[] {
  const { db } = app;
  const now = scope.now ?? Date.now();
  const rows: AttentionRow[] = [];
  const envs = scope.environments;

  const staleBefore = new Date(now - app.config.instanceStaleAfterSec * 1000).toISOString();
  const instances = db
    .query<
      {
        id: string;
        name: string;
        environment: string;
        last_seen_at: string | null;
        process_json: string | null;
        blocked: string | null;
      },
      string[]
    >(
      `SELECT gi.id, gi.name, t.environment, gi.last_seen_at, gi.process_json,
              json_extract(gi.process_json, '$.activationBlocked') AS blocked
         FROM gateway_instance gi
         JOIN target t ON t.id = gi.target_id
        WHERE gi.revoked_at IS NULL AND t.environment IN (${placeholders(envs)})
          AND (gi.last_seen_at IS NULL OR gi.last_seen_at < ?
               OR json_extract(gi.process_json, '$.activationBlocked') IS NOT NULL)
        ORDER BY t.environment, gi.name LIMIT ${RULE_LIMIT}`,
    )
    .all(...envs, staleBefore);
  for (const instance of instances) {
    const subject: AttentionSubject = { kind: "instance", id: instance.id, name: instance.name };
    const href = `/fleet?environment=${instance.environment}`;
    const stale = !instance.last_seen_at || instance.last_seen_at < staleBefore;
    if (stale) {
      rows.push(
        row(
          "gateway-stale",
          subject,
          instance.last_seen_at
            ? `Gateway ${instance.name} in ${instance.environment.toUpperCase()} last reported at ${instance.last_seen_at}. It is either stopped or cannot reach the portal — it keeps serving the configuration it already has.`
            : `Gateway ${instance.name} in ${instance.environment.toUpperCase()} has never reported. Its token was minted but no gateway has used it.`,
          href,
          instance.environment,
        ),
      );
    }
    // Both can be true at once, and they mean different things: an instance can be stale *and*
    // have refused the last configuration it did manage to fetch.
    if (instance.blocked) {
      rows.push(
        row(
          "gateway-activation-blocked",
          subject,
          `Gateway ${instance.name} in ${instance.environment.toUpperCase()} refused the current configuration and is still serving the previous one: ${instance.blocked}`,
          href,
          instance.environment,
        ),
      );
    }
  }

  const anchorSoon = new Date(now + EXPIRY_WINDOW_DAYS * 86_400_000).toISOString();
  const anchors = db
    .query<{ id: string; name: string; environment: string; not_after: string }, string[]>(
      `SELECT id, name, environment, not_after
         FROM trust_anchor
        WHERE removed_at IS NULL AND not_after <= ? AND environment IN (${placeholders(envs)})
        ORDER BY not_after LIMIT ${RULE_LIMIT}`,
    )
    .all(anchorSoon, ...envs);
  for (const anchor of anchors) {
    rows.push(
      row(
        "trust-anchor-expiring",
        { kind: "anchor", id: anchor.id, name: anchor.name },
        new Date(anchor.not_after).getTime() <= now
          ? `The certificate authority "${anchor.name}" expired on ${day(anchor.not_after)} and has stopped being sent to gateways, so backends it signed no longer verify.`
          : `The certificate authority "${anchor.name}" expires on ${day(anchor.not_after)}. Register its replacement before then — both can be trusted at once.`,
        `/trust?environment=${anchor.environment}`,
        anchor.environment,
      ),
    );
  }

  const jobs = options.jobs
    ? db
        .query<{ id: string; kind: string; attempts: number; result: string | null }, []>(
          `SELECT id, kind, attempts, result FROM job
            WHERE state = 'failed' ORDER BY updated_at DESC LIMIT ${RULE_LIMIT}`,
        )
        .all()
    : [];
  for (const job of jobs) {
    rows.push(
      row(
        "job-failed",
        { kind: "job", id: job.id, name: job.kind },
        `A background ${job.kind} job gave up after ${job.attempts} attempt(s): ${job.result ?? "no reason was recorded"}`,
        // The fleet screen: the reconciler's work belongs beside the gateways it is reconciling.
        "/fleet",
      ),
    );
  }

  return sortAttention(rows);
}

// --------------------------------------------------------------------------- the empty estate

/**
 * The same evaluator's empty branch `[P1-21]`. Present **exactly when** the caller owns no resource
 * and holds no subscription, which is the one moment a portal has to explain itself.
 */
export function startHere(app: App, user: User, scope: Scope): AttentionRow[] | null {
  const applications = scope.applications;
  const applicationSql = applications === null ? "" : ` WHERE application_id IN (${placeholders(applications ?? [])})`;
  if (applications !== null && applications.length === 0) return null;

  const owned = app.db
    .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM resource${applicationSql}`)
    .get(...(applications ?? []))!.n;
  const subscribed = app.db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM subscription s JOIN application a ON a.id = s.application_id${
        applications === null ? "" : ` WHERE a.id IN (${placeholders(applications)})`
      }`,
    )
    .get(...(applications ?? []))!.n;
  if (owned > 0 || subscribed > 0) return null;

  const rows: AttentionRow[] = [
    row(
      "start-here-subscribe",
      { kind: "portal", id: "subscribe", name: "Call an API" },
      "Find an API somebody has already published, subscribe an application to it, and call it from the browser — no code, and no key to copy anywhere.",
      "/catalog",
    ),
    row(
      "start-here-publish",
      { kind: "portal", id: "publish", name: "Publish an API" },
      "Publish an API you own: import its definition, say where its backend is, and release it to DEV. Nothing is visible to consumers until you release it.",
      "/apis/new",
    ),
  ];
  if (user.isAdmin) {
    rows.push(
      row(
        "start-here-operate",
        { kind: "portal", id: "operate", name: "Check the estate" },
        "Check that each environment has a gateway reporting in, and register the certificate authorities your internal backends are signed by.",
        "/fleet",
      ),
    );
  }
  return rows;
}

// --------------------------------------------------------------------------- one resource

/** The API page's banner: the owner rules, for one API, across the whole chain (plan §6.3). */
export function resourceAttention(app: App, user: User, resourceId: string): AttentionRow[] {
  return ownerAttention(app, scopeFor(app, user, "all", resourceId));
}

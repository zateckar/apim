import { matchingDenyRule, type DenyRule, type EgressScope, type Integrations } from "./egress.ts";
import { readBackendPool } from "../../shared/backend.ts";
import type { DB } from "./db.ts";
import { displayNames } from "./principals.ts";

/**
 * The administrator-stated half of the egress boundary (`egress-governance`).
 *
 * `denyCidrs` in INTEGRATIONS_FILE says which **networks** nothing may reach and stays in a file
 * where nothing clickable can widen it. This module owns the other half: which **hosts** the estate
 * does not reach, stated in the portal with a reason, an author and an audit line, because that is
 * the half that changes often enough that a file edit and a restart per change is what made the old
 * allowlist unusable.
 *
 * Two readers, and the difference between them is the whole design:
 *
 *  - `denyRulesFor` — at **write** time, so an owner is refused with an explanation when they save
 *    a backend, import a specification, or discover an MCP or A2A endpoint;
 *  - the same list at **config-build** time, where a route whose backend matches is omitted from
 *    the environment's document. That is what makes a rule retroactive: a route already running
 *    stops within one poll, rather than a rule applying only to what is written next.
 *
 * Nothing here travels to a gateway. A route omitted from the document is a route no instance can
 * serve, so the data plane needs no rule of its own and `CONFIG_VERSION` is unchanged.
 */

/** Every rule is evaluated against every pool member on every write and every build. */
export const DEFAULT_MAX_DENY_RULES = 64;

export class DenyRuleError extends Error {}

/**
 * Rules are read on every binding write and on every configuration build — which the dashboard and
 * the attention query each trigger — so they are cached per database and invalidated on write, the
 * same shape `controlPlaneCaBundle` uses for the same reason.
 */
const CACHE = new WeakMap<DB, DenyRule[]>();

export function invalidateDenyRules(db: DB): void {
  CACHE.delete(db);
}

interface RuleRow {
  id: string;
  environment: string | null;
  scheme: string | null;
  host_pattern: string;
  ports_json: string | null;
  port_range_json: string | null;
  reason: string;
}

/**
 * Every live rule, estate-wide ones included. Filtering by environment is `matchingDenyRule`'s job,
 * because a fetch that belongs to no environment yet — a specification import at publish time —
 * consults the estate-wide ones and has to see them in the same list.
 */
export function liveDenyRules(db: DB): DenyRule[] {
  const cached = CACHE.get(db);
  if (cached) return cached;
  const rules = db
    .query<RuleRow, []>(
      `SELECT id, environment, scheme, host_pattern, ports_json, port_range_json, reason
         FROM egress_deny_rule
        WHERE removed_at IS NULL
        ORDER BY created_at, id`,
    )
    .all()
    .map(toRule);
  CACHE.set(db, rules);
  return rules;
}

function toRule(row: RuleRow): DenyRule {
  return {
    id: row.id,
    environment: row.environment,
    scheme: row.scheme === "http" || row.scheme === "https" ? row.scheme : null,
    hostPattern: row.host_pattern,
    reason: row.reason,
    ...(row.ports_json ? { ports: JSON.parse(row.ports_json) as number[] } : {}),
    ...(row.port_range_json
      ? { portRange: JSON.parse(row.port_range_json) as [number, number] }
      : {}),
  };
}

/**
 * The live rules plus the one the platform states about itself.
 *
 * The control plane's own origin is denied without an administrator having written it down: a route
 * pointed back at the portal's API would let a gateway proxy to it, and it is the case nobody thinks
 * of. It is synthesised rather than seeded so that it follows `PUBLIC_URL` when that changes,
 * and so that it cannot be removed from the screen.
 *
 * The address *gateways* reach the control plane on is `GATEWAY_CP_URL`, set per gateway container
 * and not knowable from here — schema-013 ships a rule for the compose service name instead.
 */
export function denyRulesFor(db: DB, publicUrl: string): DenyRule[] {
  const rules = liveDenyRules(db);
  const own = selfRule(publicUrl);
  return own ? [own, ...rules] : rules;
}

export const SELF_RULE_ID = "deny-public-url-self";

function selfRule(publicUrl: string): DenyRule | null {
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  return {
    id: SELF_RULE_ID,
    environment: null,
    scheme: null,
    hostPattern: host,
    reason:
      "The portal's own address (PUBLIC_URL). A route pointed back at the control plane would let " +
      "a gateway proxy to this API, which is neither a backend nor something a subscription should " +
      "reach. This rule is stated by the platform and cannot be removed.",
  };
}

/**
 * What an owner-supplied URL is checked against: the denied ranges, plus the rules for the
 * environment this URL would be used in. `environment: null` is a fetch that belongs to no
 * environment yet — a specification import or an MCP/A2A discovery at publish time — and consults
 * the estate-wide rules only.
 *
 * The boot checks deliberately do **not** use this: see `assertIssuerAllowed`.
 */
export function egressScope(
  db: DB,
  config: { integrations: Integrations; publicUrl: string },
  environment: string | null,
): EgressScope {
  return {
    integrations: config.integrations,
    rules: denyRulesFor(db, config.publicUrl),
    environment,
  };
}

export interface DenyRuleView extends DenyRule {
  createdBy: string;
  /** The author's display name, resolved here because a member reading Trust cannot read the directory. */
  createdByName: string;
  createdAt: string;
}

/**
 * The rules as a screen shows them: the matching fields plus who wrote each one and when.
 *
 * Separate from `liveDenyRules` on purpose — that one feeds `matchingDenyRule`, and a matcher has
 * no business carrying an author. Not cached, because it is read by one admin screen rather than by
 * every binding write.
 */
export function listDenyRules(db: DB): DenyRuleView[] {
  const rows = db
    .query<RuleRow & { created_by: string; created_at: string }, []>(
      `SELECT id, environment, scheme, host_pattern, ports_json, port_range_json, reason,
              created_by, created_at
         FROM egress_deny_rule
        WHERE removed_at IS NULL
        ORDER BY created_at, id`,
    )
    .all();
  const names = displayNames(db, rows.map((row) => row.created_by));
  return rows.map((row) => ({
    ...toRule(row),
    createdBy: row.created_by,
    createdByName: names.get(row.created_by) ?? row.created_by,
    createdAt: row.created_at,
  }));
}

export interface BlockedRoute {
  resourceId: string;
  resourceName: string;
  applicationId: string;
  environment: string;
  backendUrl: string;
}

/**
 * Which released routes a rule takes out of service — the dry run's answer, and the governance
 * report's.
 *
 * Asked of the released bindings directly rather than of `buildRoutes`, because this has to be
 * answerable for a rule that does **not** exist yet. The consequence worth stating: a route the
 * builder is already omitting for another reason — an invalid effective document — appears here
 * too. That over-reports rather than under-reports, which is the right direction for a screen whose
 * job is to show an administrator the blast radius before they commit to it.
 */
export function routesMatchingRule(
  db: DB,
  rule: Pick<DenyRule, "environment" | "scheme" | "hostPattern" | "ports" | "portRange">,
): BlockedRoute[] {
  const candidate: DenyRule = { id: "draft", reason: "", ...rule };
  const rows = db
    .query<
      {
        resource_id: string;
        resource_name: string;
        api_version: string;
        application_id: string;
        environment: string;
        backend_json: string;
      },
      []
    >(
      `SELECT r.id           AS resource_id,
              r.name         AS resource_name,
              r.api_version,
              r.application_id,
              rel.environment,
              b.backend_json
         FROM release rel
         JOIN resource r ON r.id = rel.resource_id
         JOIN binding b  ON b.resource_id = r.id AND b.environment = rel.environment
        WHERE rel.state = 'converged'
        ORDER BY r.name, rel.environment`,
    )
    .all();

  const blocked: BlockedRoute[] = [];
  for (const row of rows) {
    for (const entry of readBackendPool(JSON.parse(row.backend_json)).pool) {
      if (!matchingDenyRule(entry.url, [candidate], row.environment)) continue;
      blocked.push({
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        applicationId: row.application_id,
        environment: row.environment,
        backendUrl: entry.url,
      });
      break; // One blocked member takes the route out; listing it once is the honest count.
    }
  }
  return blocked;
}

export interface DenyRuleDraft {
  environment: string | null;
  scheme: "http" | "https" | null;
  hostPattern: string;
  ports?: number[];
  portRange?: [number, number];
  reason: string;
}

/** The same minimum a TLS exception carries: a control justified with `x` cannot be reviewed later. */
export const MIN_REASON_LENGTH = 20;

/**
 * Validate a draft before it is written or dry-run.
 *
 * Every refusal here is a rule that would otherwise be quietly wrong: a pattern with a scheme or a
 * path in it matches nothing and reads as though it matches something, and a bare `*` takes the
 * whole estate off the air in one click.
 */
export function parseDenyRuleDraft(input: Partial<DenyRuleDraft>): DenyRuleDraft {
  const raw = typeof input.hostPattern === "string" ? input.hostPattern.trim().toLowerCase() : "";
  if (raw.length === 0) throw new DenyRuleError("hostPattern: expected a host, or *.suffix");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw) || raw.includes("/")) {
    throw new DenyRuleError(
      `hostPattern: "${raw}" looks like a URL. A rule matches a host — write ` +
        "`backend.example.com` or `*.example.com`, and put the port in the port field",
    );
  }
  if (raw.includes(":")) {
    throw new DenyRuleError(
      `hostPattern: "${raw}" contains a port. Ports are a separate field, so one rule can cover ` +
        "several of them",
    );
  }
  if (raw === "*" || raw === "*." || raw === "**") {
    throw new DenyRuleError(
      "hostPattern: a rule matching every host would take every route in the estate out of " +
        "service at the next configuration build. Name the hosts, or a suffix",
    );
  }
  if (raw.startsWith("[") || raw.endsWith("]")) {
    throw new DenyRuleError(
      "hostPattern: an IPv6 literal cannot be a rule — the platform refuses those outright " +
        "wherever a URL is written, because denyCidrs cannot check them",
    );
  }
  if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(raw)) {
    throw new DenyRuleError(
      `hostPattern: "${raw}" is not a host or a *.suffix pattern. Letters, digits, dots and ` +
        "hyphens, optionally led by `*.`",
    );
  }

  const scheme = input.scheme ?? null;
  if (scheme !== null && scheme !== "http" && scheme !== "https") {
    throw new DenyRuleError('scheme: expected "http", "https", or nothing for both');
  }

  const environment =
    typeof input.environment === "string" && input.environment.trim().length > 0
      ? input.environment.trim()
      : null;

  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new DenyRuleError(
      `reason: at least ${MIN_REASON_LENGTH} characters. This is the sentence somebody reads ` +
        "months from now when a route will not start — name the ticket and what would have to be " +
        "true to remove the rule",
    );
  }

  const draft: DenyRuleDraft = { environment, scheme, hostPattern: raw, reason };

  if (input.ports !== undefined && input.ports !== null) {
    if (!Array.isArray(input.ports) || input.ports.length === 0) {
      throw new DenyRuleError("ports: expected a non-empty list, or nothing for every port");
    }
    for (const port of input.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new DenyRuleError(`ports: ${String(port)} is not a port number`);
      }
    }
    draft.ports = [...new Set(input.ports)].sort((a, b) => a - b);
  }
  if (input.portRange !== undefined && input.portRange !== null) {
    const range = input.portRange;
    if (!Array.isArray(range) || range.length !== 2) {
      throw new DenyRuleError("portRange: expected [from, to]");
    }
    const [from, to] = range;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || from > to) {
      throw new DenyRuleError("portRange: expected [from, to] within 1–65535, with from ≤ to");
    }
    draft.portRange = [from, to];
  }
  return draft;
}

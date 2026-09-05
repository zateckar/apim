import { digestOf } from "../../shared/canonical.ts";
import { validateDocument } from "../../shared/policy.ts";
import { REACHED_FLEET_STATES } from "../../shared/types.ts";
import { nowIso, type DB } from "./db.ts";
import type { App } from "./router.ts";

/**
 * Promotion (design section 6). Two tiers: the contract is promoted along the chain, everything
 * else is edited in place. This module owns the gate, the plan and the per-unit merge; the data
 * plane never learns that environments have an order.
 */

export interface PolicyPlanEntry {
  unit: string;
  value?: unknown;
  from?: string;
  reason?: string;
}

export interface Blocker {
  code: "no-route" | "no-binding" | "chain" | "no-target" | "invalid-merge";
  detail: string;
}

export interface ReleasePlan {
  resourceId: string;
  resourceName: string;
  apiVersion: string;
  revisionId: string;
  rev: number;
  from: string | null;
  to: string;
  isRollback: boolean;
  /** Recorded so the job recomputes the plan the same way it was first computed. */
  skipChain: boolean;
  blockers: Blocker[];
  policy: {
    create: PolicyPlanEntry[];
    keep: PolicyPlanEntry[];
    localOnly: PolicyPlanEntry[];
  };
  warnings: string[];
}

export function predecessorOf(chain: string[], environment: string): string | null {
  const index = chain.indexOf(environment);
  if (index <= 0) return null;
  return chain[index - 1]!;
}

/**
 * Design section 6.2: permitted if the target is the first link, or the revision has **at some
 * point** reached the predecessor. "At some point", not "currently", is what makes rollback work.
 *
 * `superseded` and `withdrawn` are reachable only from `converged` — a trigger enforces it — so
 * those three states together mean "this revision reached the fleet here" (review V2-02).
 */
export function reachedFleet(db: DB, revisionId: string, environment: string): boolean {
  const placeholders = REACHED_FLEET_STATES.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM release
        WHERE revision_id = ? AND environment = ? AND state IN (${placeholders})`,
    )
    .get(revisionId, environment, ...REACHED_FLEET_STATES);
  return (row?.n ?? 0) > 0;
}

/** How far along the chain this revision has ever got — what a rejection names. */
export function furthestPoint(db: DB, revisionId: string, chain: string[]): string | null {
  let furthest: string | null = null;
  for (const environment of chain) {
    if (reachedFleet(db, revisionId, environment)) furthest = environment;
  }
  return furthest;
}

function unitsIn(db: DB, resourceId: string, environment: string): Map<string, unknown> {
  const rows = db
    .query<{ unit_key: string; value_json: string }, [string, string]>(
      "SELECT unit_key, value_json FROM policy_entry WHERE resource_id = ? AND environment = ? ORDER BY unit_key",
    )
    .all(resourceId, environment);
  return new Map(rows.map((row) => [row.unit_key, JSON.parse(row.value_json)]));
}

export interface PlanInput {
  resource: { id: string; name: string; api_version: string; kind: string; application_id: string };
  revision: { id: string; rev: number };
  environment: string;
  skipChain?: boolean;
}

export function computePlan(app: App, input: PlanInput): ReleasePlan {
  const { db } = app;
  const chain = app.config.promotionChain;
  const to = input.environment;
  const from = predecessorOf(chain, to);
  const blockers: Blocker[] = [];
  const warnings: string[] = [];

  // Route and binding are NOT seeded from the predecessor: design section 6.1 puts them in the
  // edited-in-place tier, and a TEST backend guessed from DEV is the mistake that tier prevents.
  const hasRoute = db
    .query("SELECT 1 FROM route WHERE resource_id = ? AND environment = ?")
    .get(input.resource.id, to);
  if (!hasRoute) {
    blockers.push({ code: "no-route", detail: `${to} has no route (host and base path)` });
  }
  const hasBinding = db
    .query("SELECT 1 FROM binding WHERE resource_id = ? AND environment = ?")
    .get(input.resource.id, to);
  if (!hasBinding) blockers.push({ code: "no-binding", detail: `${to} has no backend binding` });

  const target = db.query("SELECT 1 FROM target WHERE environment = ?").get(to);
  if (!target) blockers.push({ code: "no-target", detail: `no gateway for ${to}` });

  if (from && !input.skipChain && !reachedFleet(db, input.revision.id, from)) {
    const furthest = furthestPoint(db, input.revision.id, chain);
    blockers.push({
      code: "chain",
      detail:
        `revision ${input.revision.rev} has not reached ${from}, which precedes ${to} in ` +
        `PROMOTION_CHAIN (${chain.join(" -> ")}). Furthest point so far: ${furthest ?? "nowhere"}.`,
    });
  }

  const targetUnits = unitsIn(db, input.resource.id, to);
  const sourceUnits = from ? unitsIn(db, input.resource.id, from) : new Map<string, unknown>();

  // Design section 6.3's table, per unit, on every release from a predecessor.
  const create: PolicyPlanEntry[] = [];
  const keep: PolicyPlanEntry[] = [];
  const localOnly: PolicyPlanEntry[] = [];
  for (const [unit, value] of sourceUnits) {
    if (targetUnits.has(unit)) {
      keep.push({ unit, value: targetUnits.get(unit), reason: `present in ${to}` });
    } else {
      create.push({ unit, value, from: from! });
    }
  }
  for (const [unit, value] of targetUnits) {
    // Removal never propagates: a deletion upstream is a local act per environment.
    if (!sourceUnits.has(unit)) {
      localOnly.push({ unit, value, reason: from ? `absent in ${from}, kept` : "no predecessor" });
    }
  }

  const merged: Record<string, unknown> = Object.fromEntries(targetUnits);
  for (const entry of create) merged[entry.unit] = entry.value;
  const mergeErrors = validateDocument(merged, { kind: input.resource.kind });
  if (mergeErrors.length > 0) {
    blockers.push({
      code: "invalid-merge",
      detail: `the merged policy document would be invalid: ${mergeErrors.join("; ")}`,
    });
  }
  if (merged["auth.subscriptionKey"] === undefined) {
    warnings.push(
      `no authentication policy attached in ${to}: this route is open to anyone who can reach the gateway`,
    );
  }

  const live = db
    .query<{ rev: number }, [string, string]>(
      `SELECT rev.rev FROM release rel JOIN revision rev ON rev.id = rel.revision_id
        WHERE rel.resource_id = ? AND rel.environment = ? AND rel.state = 'converged'`,
    )
    .get(input.resource.id, to);
  const isRollback = live !== null && live !== undefined && live.rev > input.revision.rev;
  if (isRollback && create.length > 0 && from) {
    warnings.push(
      `this is a rollback to revision ${input.revision.rev}, but the merge still seeds policy from ` +
        `${from} as it is today — not as it was when that revision was current`,
    );
  }

  return {
    resourceId: input.resource.id,
    resourceName: input.resource.name,
    apiVersion: input.resource.api_version,
    revisionId: input.revision.id,
    rev: input.revision.rev,
    from,
    to,
    isRollback,
    skipChain: input.skipChain === true,
    blockers,
    policy: { create, keep, localOnly },
    warnings,
  };
}

/**
 * The decided content of the plan and nothing volatile, so a second dry run a minute later
 * matches while a policy, route, binding or revision change does not (review V1-04).
 */
export function planDigest(plan: ReleasePlan): string {
  return digestOf({
    resourceId: plan.resourceId,
    revisionId: plan.revisionId,
    from: plan.from,
    to: plan.to,
    create: plan.policy.create.map((e) => ({ unit: e.unit, value: e.value })),
    keep: plan.policy.keep.map((e) => ({ unit: e.unit, value: e.value })),
    localOnly: plan.policy.localOnly.map((e) => e.unit),
    blockers: plan.blockers.map((b) => b.code),
  });
}

/**
 * Writes the seeded units. Called by the reconcile job inside the same transaction that moves
 * `release.state`, so a release that fails or goes stale changes no policy at all (review V1-03).
 */
export function applySeededUnits(db: DB, plan: ReleasePlan, actor: string): number {
  const at = nowIso();
  for (const entry of plan.policy.create) {
    db.run(
      `INSERT INTO policy_entry
         (resource_id, environment, unit_key, value_json, origin, seeded_from_env, seeded_at,
          updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'seeded', ?, ?, ?, ?)
       ON CONFLICT (resource_id, environment, unit_key) DO NOTHING`,
      [plan.resourceId, plan.to, entry.unit, JSON.stringify(entry.value), entry.from ?? null, at, actor, at],
    );
  }
  return plan.policy.create.length;
}

// ------------------------------------------------------------------------ divergence (section 6.4)

export type DivergenceCategory = "pending" | "local-addition" | "value-drift" | "aligned";

export interface DivergenceUnit {
  unit: string;
  category: DivergenceCategory;
  here?: unknown;
  there?: unknown;
  origin?: string;
  updatedBy?: string;
  updatedAt?: string;
  /** An auth unit present upstream and absent here means less protection than what was tested. */
  warning?: string;
}

export interface DivergenceEnvironment {
  environment: string;
  predecessor: string | null;
  units: DivergenceUnit[];
  route: { here: unknown; there: unknown } | null;
  binding: { here: unknown; there: unknown } | null;
}

export function divergence(app: App, resourceId: string): DivergenceEnvironment[] {
  const { db } = app;
  const chain = app.config.promotionChain;

  const meta = db
    .query<
      { environment: string; unit_key: string; origin: string; updated_by: string; updated_at: string },
      [string]
    >(
      "SELECT environment, unit_key, origin, updated_by, updated_at FROM policy_entry WHERE resource_id = ?",
    )
    .all(resourceId);
  const metaFor = new Map(meta.map((m) => [`${m.environment}|${m.unit_key}`, m]));

  const routeOf = (environment: string) =>
    db
      .query<{ host: string; base_path: string }, [string, string]>(
        "SELECT host, base_path FROM route WHERE resource_id = ? AND environment = ?",
      )
      .get(resourceId, environment) ?? null;
  const bindingOf = (environment: string) => {
    const row = db
      .query<{ backend_json: string }, [string, string]>(
        "SELECT backend_json FROM binding WHERE resource_id = ? AND environment = ?",
      )
      .get(resourceId, environment);
    return row ? (JSON.parse(row.backend_json) as unknown) : null;
  };

  return chain.map((environment) => {
    const predecessor = predecessorOf(chain, environment);
    const here = unitsIn(db, resourceId, environment);
    const there = predecessor ? unitsIn(db, resourceId, predecessor) : new Map<string, unknown>();
    const units: DivergenceUnit[] = [];

    for (const unit of new Set([...here.keys(), ...there.keys()])) {
      const info = metaFor.get(`${environment}|${unit}`);
      const common = {
        unit,
        origin: info?.origin,
        updatedBy: info?.updated_by,
        updatedAt: info?.updated_at,
      };
      if (!here.has(unit)) {
        units.push({
          ...common,
          category: "pending",
          there: there.get(unit),
          warning: unit.startsWith("auth.")
            ? `${environment} is less protected than ${predecessor}: ${unit} is absent here`
            : undefined,
        });
      } else if (!there.has(unit)) {
        units.push({ ...common, category: "local-addition", here: here.get(unit) });
      } else if (digestOf(here.get(unit)) !== digestOf(there.get(unit))) {
        units.push({ ...common, category: "value-drift", here: here.get(unit), there: there.get(unit) });
      } else {
        units.push({ ...common, category: "aligned", here: here.get(unit) });
      }
    }
    units.sort((a, b) => a.unit.localeCompare(b.unit));

    return {
      environment,
      predecessor,
      units,
      // Host and backend differences are expected between environments and are shown greyed.
      route: predecessor ? { here: routeOf(environment), there: routeOf(predecessor) } : null,
      binding: predecessor ? { here: bindingOf(environment), there: bindingOf(predecessor) } : null,
    };
  });
}

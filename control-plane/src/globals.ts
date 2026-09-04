import { assembleDocument, isGloballyAttachable, type PolicyDocument } from "../../shared/policy.ts";
import type { DB } from "./db.ts";

/**
 * The global policy tier (goal G2, deviation D18).
 *
 * The design has no environment-wide tier: policy is per resource and per environment (§5, §6.1).
 * This adds one, and the addition is deliberately the **weaker** side of every conflict:
 *
 *     effective(resource, environment)[unit] = resource's value  if the resource has that unit
 *                                             the environment's value otherwise
 *
 * Whole units, never field-wise — the same rule §5 states for the promotion merge, for the same
 * reason: half a `rateLimit` is never a `rateLimit` anyone wrote.
 *
 * Two consequences are load-bearing:
 *  - only an allowlisted set of units may be attached globally (`isGloballyAttachable`), so a unit
 *    added later is not globally attachable until somebody decides it should be;
 *  - it is never promoted, so `copy-from` between environments is an explicit, diffed act.
 */

export interface UnitOrigin {
  unitKey: string;
  value: unknown;
  origin: "resource" | "global";
}

export function globalUnits(db: DB, environment: string): Map<string, unknown> {
  const rows = db
    .query<{ unit_key: string; value_json: string }, [string]>(
      "SELECT unit_key, value_json FROM global_policy_entry WHERE environment = ? ORDER BY unit_key",
    )
    .all(environment);
  return new Map(rows.map((row) => [row.unit_key, JSON.parse(row.value_json)]));
}

export function globalDocument(db: DB, environment: string): PolicyDocument {
  const rows = db
    .query<{ unit_key: string; value_json: string }, [string]>(
      "SELECT unit_key, value_json FROM global_policy_entry WHERE environment = ? ORDER BY unit_key",
    )
    .all(environment);
  return assembleDocument(rows);
}

export function resourceUnits(db: DB, resourceId: string, environment: string): Map<string, unknown> {
  const rows = db
    .query<{ unit_key: string; value_json: string }, [string, string]>(
      "SELECT unit_key, value_json FROM policy_entry WHERE resource_id = ? AND environment = ? ORDER BY unit_key",
    )
    .all(resourceId, environment);
  return new Map(rows.map((row) => [row.unit_key, JSON.parse(row.value_json)]));
}

/**
 * The document the gateway is given and the document every write is validated against. One
 * function, so a resource write, a global write, a release plan and the config build cannot
 * disagree about what an API's policy actually is.
 */
export function effectiveDocument(
  db: DB,
  resourceId: string,
  environment: string,
  overrides?: Map<string, unknown>,
): PolicyDocument {
  const own = overrides ?? resourceUnits(db, resourceId, environment);
  const merged: Record<string, unknown> = {};
  for (const [unit, value] of globalUnits(db, environment)) {
    if (isGloballyAttachable(unit)) merged[unit] = value;
  }
  for (const [unit, value] of own) merged[unit] = value;
  return merged as PolicyDocument;
}

/** The same merge, but keeping where each unit came from — what the policy screen renders. */
export function effectiveWithOrigin(
  db: DB,
  resourceId: string,
  environment: string,
): UnitOrigin[] {
  const own = resourceUnits(db, resourceId, environment);
  const out = new Map<string, UnitOrigin>();
  for (const [unitKey, value] of globalUnits(db, environment)) {
    if (isGloballyAttachable(unitKey)) out.set(unitKey, { unitKey, value, origin: "global" });
  }
  for (const [unitKey, value] of own) out.set(unitKey, { unitKey, value, origin: "resource" });
  return [...out.values()].sort((a, b) => a.unitKey.localeCompare(b.unitKey));
}

/** Every resource that has any per-environment state in this environment — what a global write affects. */
export function resourcesInEnvironment(
  db: DB,
  environment: string,
): Array<{ id: string; name: string; kind: string; api_version: string }> {
  return db
    .query<{ id: string; name: string; kind: string; api_version: string }, [string, string, string]>(
      `SELECT DISTINCT r.id, r.name, r.kind, r.api_version
         FROM resource r
        WHERE EXISTS (SELECT 1 FROM route      t WHERE t.resource_id = r.id AND t.environment = ?)
           OR EXISTS (SELECT 1 FROM policy_entry p WHERE p.resource_id = r.id AND p.environment = ?)
           OR EXISTS (SELECT 1 FROM release    l WHERE l.resource_id = r.id AND l.environment = ?)
        ORDER BY r.name, r.api_version`,
    )
    .all(environment, environment, environment);
}

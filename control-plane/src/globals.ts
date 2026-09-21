import {
  assembleDocument,
  disabledUnits,
  DISABLED_KEY,
  isGloballyAttachable,
  type PolicyDocument,
} from "../../shared/policy.ts";
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

/**
 * The globals that actually reach a resource's document — `globalUnits` narrowed to the
 * allowlist, which is the same narrowing `effectiveDocument` does.
 *
 * Separate from `globalUnits` because the difference matters wherever the question is "did this
 * unit come from the environment": a row for a unit that is not globally attachable is inert, and
 * treating it as inherited would refuse an owner's edit to a unit that is entirely their own.
 */
export function inheritedUnits(db: DB, environment: string): Map<string, unknown> {
  return new Map(
    [...globalUnits(db, environment)].filter(([unit]) => isGloballyAttachable(unit)),
  );
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

// ------------------------------------------------------------------ overriding the global tier

/** One way a resource's document departs from what the environment says that unit is. */
export interface GlobalOverride {
  unitKey: string;
  /** `changed` — the resource gives the unit its own value. `disabled` — the resource switches it off. */
  how: "changed" | "disabled";
}

/**
 * Overriding a global unit is an **administrator's** act, not the owning application's.
 *
 * A unit attached to the environment is a decision about the whole estate, and the three things an
 * API's own workspace can do about it — give it a different value, name it in `disabled`, or delete
 * the deviation somebody was granted — all end with that API running something other than what the
 * environment says. Whoever may do that may exempt their own API from an environment-wide
 * `auth.jwt`, `ipAllow` or `rateLimit`, which is the whole point of having attached one.
 *
 * So the tier and every per-API departure from it belong to the same person. The owner keeps every
 * unit the environment does not define, which is almost all of them.
 *
 * Removing a global unit by *omission* is refused for everybody, administrators included, and that
 * is a different rule for a different reason — see `readPublishInput` in `operations.ts`.
 */
export function globalOverrides(
  environmentWide: Map<string, unknown>,
  document: Record<string, unknown>,
): GlobalOverride[] {
  const out: GlobalOverride[] = [];
  for (const unitKey of environmentWide.keys()) {
    const state = globalUnitState(environmentWide, document, unitKey);
    if (state.how !== null) out.push({ unitKey, how: state.how });
  }
  return out.sort((a, b) => a.unitKey.localeCompare(b.unitKey));
}

/**
 * What one globally attached unit actually is in a document: the value that would reach the
 * gateway, and whether that departs from the environment. `signature` is the whole of it, so
 * "did this write touch this unit" is a string comparison rather than a second set of rules.
 */
function globalUnitState(
  environmentWide: Map<string, unknown>,
  document: Record<string, unknown>,
  unitKey: string,
): { how: "changed" | "disabled" | null; signature: string } {
  // `disabled` is itself globally attachable, so it is compared as a value like any other unit
  // rather than read as a list here; the units it *names* are the caller's other iterations.
  const off =
    unitKey !== DISABLED_KEY && disabledUnits(document as PolicyDocument).includes(unitKey);
  const own = document[unitKey];
  const value = own === undefined ? environmentWide.get(unitKey) : own;
  const how = off
    ? ("disabled" as const)
    : own !== undefined && JSON.stringify(own) !== JSON.stringify(environmentWide.get(unitKey))
      ? ("changed" as const)
      : null;
  return { how, signature: `${off ? "off" : "on"}:${JSON.stringify(value) ?? "undefined"}` };
}

/**
 * The globally attached units this write would move, whichever direction it moves them: attaching
 * an override, editing one somebody was already granted, switching a unit off, or putting any of
 * that back. All four are the same permission question, so they are one comparison rather than
 * four rules that can disagree — the third and fourth matter because an exception an administrator
 * granted is the administrator's to revise, and an owner who could revise it could first widen it.
 *
 * A unit nobody touched compares equal, which is what makes this usable at all: the policy editor
 * sends the whole effective document back on every save, including the inherited parts.
 */
export function globalUnitChanges(
  environmentWide: Map<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): GlobalOverride[] {
  const out: GlobalOverride[] = [];
  for (const unitKey of environmentWide.keys()) {
    const was = globalUnitState(environmentWide, before, unitKey);
    const now = globalUnitState(environmentWide, after, unitKey);
    if (was.signature === now.signature) continue;
    out.push({ unitKey, how: now.how ?? was.how ?? "changed" });
  }
  return out.sort((a, b) => a.unitKey.localeCompare(b.unitKey));
}

/**
 * The sentence a refused owner reads. It names the units, says where the decision lives and names
 * the two ways forward, because "403" on a policy screen teaches nobody who to ask. One sentence
 * for all four directions: attaching an override, editing one, switching a unit off, putting any
 * of that back.
 */
export function globalOverrideRefusal(environment: string, overrides: GlobalOverride[]): string {
  const units = overrides.map((o) => o.unitKey).join(", ");
  const plural = overrides.length > 1;
  const it = plural ? "them" : "it";
  return (
    `${units}: ${plural ? "these units are" : "this unit is"} set for the whole of ` +
    `${environment.toUpperCase()}, and how ${it} applies to one API is a platform ` +
    `administrator's decision. Ask an administrator for an exception, or change ${it} for every ` +
    "API on the Global policy screen."
  );
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

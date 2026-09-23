import {
  activeDocument,
  DISABLED_KEY,
  disabledUnits,
  GLOBAL_UNITS,
  isGloballyAttachable,
  lintDocument,
  UNIT_CATALOGUE,
  validateDocument,
  validateUnit,
} from "../../../shared/policy.ts";
import { writeAudit } from "../audit.ts";
import { policyFor } from "../config-build.ts";
import { nowIso } from "../db.ts";
import { displayNames } from "../principals.ts";
import { namesPlatformRef } from "../operations.ts";
import {
  effectiveWithOrigin,
  globalDocument,
  resourcesInEnvironment,
  resourceUnits,
} from "../globals.ts";
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  readJson,
  requireAdmin,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import { environmentOf, getResource } from "./common.ts";

/**
 * The global policy tier (goal G2, deviation D18) and the governance reads that go with it.
 *
 * The design has no environment-wide tier at all, so this is an addition rather than a
 * reinterpretation, and it is built to be the **weaker** side of every conflict:
 *
 *  - a resource's own unit always wins. Whole units, never field-wise — half a `rateLimit` is not a
 *    `rateLimit` anybody wrote;
 *  - only an allowlisted set of units may be attached globally, so a unit added to the vocabulary
 *    later is not globally attachable until somebody decides it should be;
 *  - it is **admin-only**, because it changes every API in an environment at once;
 *  - it is **never promoted**. Copying dev's globals to prod is an explicit, diffed act, because
 *    the two environments differ in exactly the ways a global policy is used to express;
 *  - and the API's own policy screen names the origin of every unit. Otherwise "why is this API
 *    rate limited" stops being answerable from the API's own page, which is the failure mode that
 *    makes estate-wide policy hated wherever it exists.
 *
 * A global write is validated against **every affected resource's effective document**, not against
 * itself. A global `rateLimit` is invalid if any API in that environment would end up with a rate
 * limit and no subscription key — and the refusal names the API, because "it is invalid somewhere"
 * is not actionable.
 */

// `requireAdmin` moved to `router.ts` in v5, where all seven admin carve-outs now live.

function assertEnvironment(ctx: Ctx, environment: string): void {
  if (!ctx.app.config.promotionChain.includes(environment)) {
    throw notFound(`unknown environment "${environment}"`);
  }
}

/**
 * Whether this global document leaves every resource in the environment valid. Returns the first
 * few failures with the resource named, because a global write that says only "invalid" leaves an
 * admin to guess which of forty APIs it broke.
 */
function conflictsFor(
  ctx: Ctx,
  environment: string,
  globals: Map<string, unknown>,
): Array<{ resourceId: string; resourceName: string; errors: string[] }> {
  const out: Array<{ resourceId: string; resourceName: string; errors: string[] }> = [];
  for (const resource of resourcesInEnvironment(ctx.app.db, environment)) {
    const own = resourceUnits(ctx.app.db, resource.id, environment);
    const merged: Record<string, unknown> = {};
    for (const [unit, value] of globals) {
      if (isGloballyAttachable(unit)) merged[unit] = value;
    }
    for (const [unit, value] of own) merged[unit] = value;
    const errors = validateDocument(merged, { kind: resource.kind });
    if (errors.length > 0) {
      out.push({
        resourceId: resource.id,
        resourceName: `${resource.name} ${resource.api_version}`,
        errors,
      });
    }
  }
  return out;
}

export function registerPolicyRoutes(router: Router): void {
  // ---------------------------------------------------------------- the global tier

  router.add("GET", "/api/policy/global", "session", (ctx) => {
    const environment = environmentOf(ctx);
    assertEnvironment(ctx, environment);
    const rows = ctx.app.db
      .query<
        { unit_key: string; value_json: string; updated_by: string; updated_at: string },
        [string]
      >(
        `SELECT unit_key, value_json, updated_by, updated_at
           FROM global_policy_entry WHERE environment = ? ORDER BY unit_key`,
      )
      .all(environment);

    const affected = resourcesInEnvironment(ctx.app.db, environment);
    // Resolved here because a member may read this screen and may not read the directory, so the
    // browser has no way to turn `updated_by` into a person (`[P2-03]`, as the audit log does).
    const names = displayNames(ctx.app.db, rows.map((row) => row.updated_by));
    return json({
      environment,
      document: globalDocument(ctx.app.db, environment),
      units: rows.map((row) => ({
        unitKey: row.unit_key,
        value: JSON.parse(row.value_json),
        updatedBy: row.updated_by,
        updatedByName: names.get(row.updated_by) ?? row.updated_by,
        updatedAt: row.updated_at,
        // How many APIs currently override this unit, which is the number that says whether the
        // global value is doing anything.
        overriddenBy: overrideCount(ctx, environment, row.unit_key),
      })),
      // The blast radius, stated on the screen that edits it.
      affectedResources: affected.length,
      attachable: UNIT_CATALOGUE.filter((unit) => unit.global).map((unit) => unit.key),
      warnings: lintDocument(globalDocument(ctx.app.db, environment) as Record<string, unknown>, {
        environment,
      }),
      canEdit: ctx.user?.isAdmin === true,
    });
  });

  router.add("PUT", "/api/policy/global/units/:unitKey", "session", async (ctx) => {
    const user = requireAdmin(
      ctx,
      "the global policy tier is admin-only: it changes every API in the environment at once",
    );
    const environment = environmentOf(ctx);
    assertEnvironment(ctx, environment);
    const unitKey = ctx.params.unitKey!;
    if (!isGloballyAttachable(unitKey)) {
      throw badRequest(
        `"${unitKey}" may not be attached globally (globally attachable: ${GLOBAL_UNITS.join(", ")}). ` +
          "A unit is not globally attachable until somebody decides it should be, because an " +
          "environment-wide default is a different decision from a per-API one",
      );
    }

    const body = await readJson<{ value?: unknown }>(ctx);
    const unitErrors = validateUnit(unitKey, body.value);
    if (unitErrors.length > 0) throw badRequest(unitErrors.join("; "));
    // Not even here: a global unit reaches every API in the environment, and the portal's own key is
    // presented only on the APIs the portal generates (kafka-rest-proxy).
    if (namesPlatformRef(body.value)) {
      throw forbidden(`${unitKey}: a "platform:" reference is the portal's own credential and only the portal writes one`);
    }

    const globals = globalUnitsOf(ctx, environment);
    globals.set(unitKey, body.value);
    const conflicts = conflictsFor(ctx, environment, globals);
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      throw conflict(
        `attaching ${unitKey} globally would leave ${conflicts.length} API(s) with an invalid ` +
          `effective policy, starting with ${first.resourceName}: ${first.errors.join("; ")}`,
      );
    }

    const at = nowIso();
    ctx.app.db.run(
      `INSERT INTO global_policy_entry (environment, unit_key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (environment, unit_key) DO UPDATE SET
         value_json = excluded.value_json, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [environment, unitKey, JSON.stringify(body.value), user.id, at],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "global-policy.set",
      subject: `environment:${environment}`,
      outcome: "ok",
      detail: { environment, unitKey, value: body.value },
    });
    return json({
      environment,
      unitKey,
      value: body.value,
      updatedAt: at,
      affectedResources: resourcesInEnvironment(ctx.app.db, environment).length,
      overriddenBy: overrideCount(ctx, environment, unitKey),
    });
  });

  router.add("DELETE", "/api/policy/global/units/:unitKey", "session", (ctx) => {
    const user = requireAdmin(ctx, "the global policy tier is admin-only");
    const environment = environmentOf(ctx);
    assertEnvironment(ctx, environment);
    const unitKey = ctx.params.unitKey!;

    // Detaching can invalidate too: an API relying on a global `auth.subscriptionKey` to satisfy
    // its own `rateLimit` loses it here, and finding that out at the next poll would be worse.
    const globals = new Map([...globalUnitsOf(ctx, environment)].filter(([key]) => key !== unitKey));
    const conflicts = conflictsFor(ctx, environment, globals);
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      throw conflict(
        `detaching ${unitKey} would leave ${conflicts.length} API(s) with an invalid effective ` +
          `policy, starting with ${first.resourceName}: ${first.errors.join("; ")}`,
      );
    }

    ctx.app.db.run("DELETE FROM global_policy_entry WHERE environment = ? AND unit_key = ?", [
      environment,
      unitKey,
    ]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "global-policy.delete",
      subject: `environment:${environment}`,
      outcome: "ok",
      detail: { environment, unitKey },
    });
    return new Response(null, { status: 204 });
  });

  /**
   * Copy one environment's global tier to another. The global tier is never promoted with a
   * revision — the two environments differ in exactly the ways a global policy expresses — so
   * moving it is this: explicit, diffed, and refused if it would break an API in the destination.
   */
  router.add("POST", "/api/policy/global/copy-from", "session", async (ctx) => {
    const user = requireAdmin(ctx, "the global policy tier is admin-only");
    const environment = environmentOf(ctx);
    assertEnvironment(ctx, environment);
    const body = await readJson<{ from?: string; dryRun?: boolean }>(ctx);
    const from = body.from ?? "";
    assertEnvironment(ctx, from);
    if (from === environment) throw badRequest("from: must be a different environment");

    const source = globalUnitsOf(ctx, from);
    const target = globalUnitsOf(ctx, environment);
    const changes: Array<{ unitKey: string; before: unknown; after: unknown }> = [];
    for (const [unitKey, after] of source) {
      const before = target.get(unitKey);
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ unitKey, before, after });
    }
    // Units the destination has and the source does not are left alone: this is a copy, not a
    // synchronisation, and silently deleting somebody's prod-only global would be the worse default.
    const conflicts = conflictsFor(ctx, environment, new Map([...target, ...source]));

    if (body.dryRun !== false && conflicts.length === 0 && changes.length === 0) {
      return json({ environment, from, changes, conflicts, applied: false });
    }
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      throw conflict(
        `copying ${from}'s global policy into ${environment} would leave ${conflicts.length} ` +
          `API(s) invalid, starting with ${first.resourceName}: ${first.errors.join("; ")}`,
      );
    }
    if (body.dryRun !== false) {
      return json({ environment, from, changes, conflicts, applied: false });
    }

    const at = nowIso();
    const apply = ctx.app.db.transaction(() => {
      for (const change of changes) {
        ctx.app.db.run(
          `INSERT INTO global_policy_entry (environment, unit_key, value_json, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (environment, unit_key) DO UPDATE SET
             value_json = excluded.value_json, updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
          [environment, change.unitKey, JSON.stringify(change.after), user.id, at],
        );
      }
    });
    apply();
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "global-policy.copy-from",
      subject: `environment:${environment}`,
      outcome: "ok",
      detail: { from, units: changes.map((c) => c.unitKey) },
    });
    return json({ environment, from, changes, conflicts: [], applied: true });
  });

  // ---------------------------------------------------------------- effective policy, per resource

  /**
   * The document that will actually be served, with the origin of every unit. The whole reason the
   * global tier is tolerable: an API's own page answers "why is this API rate limited".
   */
  router.add("GET", "/api/resources/:id/policy/effective", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const environment = environmentOf(ctx);
    assertEnvironment(ctx, environment);
    const units = effectiveWithOrigin(ctx.app.db, row.id, environment);
    const stored = policyFor(ctx.app.db, row.id, environment);
    // `document` is what the gateway will be served, which is the question this endpoint exists to
    // answer, so a unit the API has switched off is not in it. `disabled` says which those are,
    // because "off" and "never configured" look identical from the document alone and are not the
    // same fact about a route.
    const document = activeDocument(stored as Record<string, unknown>);
    return json({
      environment,
      document,
      disabled: disabledUnits(stored as Record<string, unknown>),
      units: units.filter((unit) => unit.unitKey !== DISABLED_KEY),
      warnings: lintDocument(document, { environment }),
      // What an owner may do about a global unit: override it on this API, and nothing else.
      globalUnits: units.filter((unit) => unit.origin === "global").map((unit) => unit.unitKey),
    });
  });

  // ---------------------------------------------------------------- validation governance

  /**
   * Every route in the estate that is not validating at the default, with the reason its owner
   * gave. The list design section 5.1 asks for: a downgrade is allowed, and being on this list is
   * the price.
   */
  router.add("GET", "/api/validation/downgrades", "session", (ctx) => {
    requireUser(ctx);
    const environment = ctx.url.searchParams.get("environment");
    const rows = ctx.app.db
      .query<
        {
          resource_id: string;
          resource_name: string;
          api_version: string;
          kind: string;
          environment: string;
          value_json: string;
          updated_by: string;
          updated_at: string;
        },
        []
      >(
        `SELECT p.resource_id, r.name AS resource_name, r.api_version, r.kind, p.environment,
                p.value_json, p.updated_by, p.updated_at
           FROM policy_entry p JOIN resource r ON r.id = p.resource_id
          WHERE p.unit_key = 'validate'
          ORDER BY r.name, p.environment`,
      )
      .all();

    const items = [];
    const names = displayNames(ctx.app.db, rows.map((row) => row.updated_by));
    for (const row of rows) {
      if (environment !== null && row.environment !== environment) continue;
      let unit: { request?: string; response?: string; downgradeReason?: string };
      try {
        unit = JSON.parse(row.value_json);
      } catch {
        continue;
      }
      if (unit.request === undefined || unit.request === "blocking") continue;
      items.push({
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        kind: row.kind,
        environment: row.environment,
        request: unit.request,
        response: unit.response ?? "disabled",
        downgradeReason: unit.downgradeReason ?? null,
        updatedBy: row.updated_by,
        updatedByName: names.get(row.updated_by) ?? row.updated_by,
        updatedAt: row.updated_at,
      });
    }

    // Operations that cannot be validated at all, whatever the state — an unsupported schema
    // keyword or a WSDL construct outside the implemented subset. Different from a downgrade
    // somebody chose, and listed separately for that reason (plan `[R1-14]`, `[R1-15]`).
    //
    // One row per (API, operation), from that API's **newest** revision. It used to join every
    // revision, so an API edited three times listed the same unvalidatable operation three times
    // with nothing on the row to tell the copies apart (finding 12) — and the older copies were
    // stale anyway: whether an operation can be validated is a fact about the definition in force,
    // and a fixed contract should leave this list rather than sit in it beside its own fix.
    const unvalidatable = ctx.app.db
      .query<
        { resource_id: string; resource_name: string; api_version: string; index_json: string },
        []
      >(
        `SELECT v.resource_id, r.name AS resource_name, r.api_version, v.index_json
           FROM revision v JOIN resource r ON r.id = v.resource_id
          WHERE v.index_json IS NOT NULL
            AND v.rev = (SELECT MAX(rev) FROM revision WHERE resource_id = v.resource_id)
          ORDER BY r.name, r.api_version`,
      )
      .all()
      .flatMap((row) => {
        let operations: Array<{ id: string; schemaState: string }>;
        try {
          operations = JSON.parse(row.index_json);
        } catch {
          return [];
        }
        return operations
          .filter((operation) => operation.schemaState !== "ok")
          .map((operation) => ({
            resourceId: row.resource_id,
            resourceName: `${row.resource_name} ${row.api_version}`,
            operationId: operation.id,
            schemaState: operation.schemaState,
          }));
      });

    return json({ items, unvalidatable });
  });
}

function globalUnitsOf(ctx: Ctx, environment: string): Map<string, unknown> {
  const rows = ctx.app.db
    .query<{ unit_key: string; value_json: string }, [string]>(
      "SELECT unit_key, value_json FROM global_policy_entry WHERE environment = ? ORDER BY unit_key",
    )
    .all(environment);
  return new Map(rows.map((row) => [row.unit_key, JSON.parse(row.value_json)]));
}

/** How many APIs in this environment attach the same unit themselves, and so ignore the global. */
function overrideCount(ctx: Ctx, environment: string, unitKey: string): number {
  const row = ctx.app.db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM policy_entry WHERE environment = ? AND unit_key = ?",
    )
    .get(environment, unitKey);
  return row?.n ?? 0;
}

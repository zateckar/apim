import { validateDocument, validateUnit, POLICY_UNITS } from "../../../shared/policy.ts";
import { writeAudit } from "../audit.ts";
import { policyFor } from "../config-build.ts";
import { newId, nowIso } from "../db.ts";
import { enqueueJob, runDueJobs } from "../jobs.ts";
import {
  computePlan,
  divergence,
  furthestPoint,
  planDigest,
  predecessorOf,
  reachedFleet,
  type ReleasePlan,
} from "../promotion.ts";
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  readJson,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import { assertCan, getResource } from "./common.ts";

/**
 * Promotion endpoints (design section 6.2, 6.3, 6.4).
 *
 * The release path lives here rather than beside the other resource routes because promotion is
 * the thing that gives a release its meaning: the gate, the plan and the per-unit merge are one
 * decision, and splitting them across files is how they drift.
 */
function revisionFor(ctx: Ctx, resourceId: string, rev?: number) {
  const db = ctx.app.db;
  const revision = rev
    ? db
        .query<{ id: string; rev: number; version_digest: string; pruned_at: string | null }, [string, number]>(
          "SELECT id, rev, version_digest, pruned_at FROM revision WHERE resource_id = ? AND rev = ?",
        )
        .get(resourceId, rev)
    : db
        .query<{ id: string; rev: number; version_digest: string; pruned_at: string | null }, [string]>(
          `SELECT id, rev, version_digest, pruned_at FROM revision
            WHERE resource_id = ? ORDER BY rev DESC LIMIT 1`,
        )
        .get(resourceId);
  if (!revision) throw notFound(`no revision ${rev ?? "(latest)"} for this resource`);
  // A tombstone (plan §7.4): the row is here so releases and audit still resolve, but there is no
  // definition to publish. Refusing here is the difference between a clear conflict and a
  // gateway serving a route with no operations.
  if (revision.pruned_at) {
    throw conflict(
      `revision ${revision.rev} was pruned on ${revision.pruned_at} — its definition is no longer ` +
        "stored, so it cannot be released. Release a newer revision, or upload the definition again",
    );
  }
  return revision;
}

function environmentIn(ctx: Ctx, environment: string): string {
  if (!ctx.app.config.promotionChain.includes(environment)) {
    throw badRequest(
      `unknown environment "${environment}" (PROMOTION_CHAIN is ${ctx.app.config.promotionChain.join(",")})`,
    );
  }
  return environment;
}

function persistPlan(ctx: Ctx, plan: ReleasePlan, actor: string): { id: string; digest: string } {
  const id = newId("plan");
  const digest = planDigest(plan);
  ctx.app.db.run(
    `INSERT INTO release_plan (id, resource_id, revision_id, environment, plan_json, plan_digest,
                               computed_by, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, plan.resourceId, plan.revisionId, plan.to, JSON.stringify(plan), digest, actor, nowIso()],
  );
  return { id, digest };
}

export function registerPromotionRoutes(router: Router): void {
  /** The chain at a glance: what is live where, and how far this revision has travelled. */
  router.add("GET", "/api/resources/:id/promotion", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const chain = ctx.app.config.promotionChain;
    const db = ctx.app.db;

    const latest = db
      .query<{ id: string; rev: number }, [string]>(
        "SELECT id, rev FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT 1",
      )
      .get(row.id);

    return json({
      chain,
      latestRev: latest?.rev ?? null,
      furthest: latest ? furthestPoint(db, latest.id, chain) : null,
      items: chain.map((environment) => {
        const live = db
          .query<{ rev: number; released_at: string; state: string }, [string, string]>(
            `SELECT rev.rev, rel.released_at, rel.state
               FROM release rel JOIN revision rev ON rev.id = rel.revision_id
              WHERE rel.resource_id = ? AND rel.environment = ? AND rel.state = 'converged'`,
          )
          .get(row.id, environment);
        const hasRoute = Boolean(
          db.query("SELECT 1 FROM route WHERE resource_id = ? AND environment = ?").get(row.id, environment),
        );
        const hasBinding = Boolean(
          db.query("SELECT 1 FROM binding WHERE resource_id = ? AND environment = ?").get(row.id, environment),
        );
        return {
          environment,
          predecessor: predecessorOf(chain, environment),
          liveRev: live?.rev ?? null,
          releasedAt: live?.released_at ?? null,
          hasRoute,
          hasBinding,
          // Whether the *latest* revision could go here right now, which is what the button asks.
          eligible: latest
            ? predecessorOf(chain, environment) === null ||
              reachedFleet(db, latest.id, predecessorOf(chain, environment)!)
            : false,
        };
      }),
    });
  });

  router.add("GET", "/api/resources/:id/divergence", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    return json({ resourceId: row.id, environments: divergence(ctx.app, row.id) });
  });

  router.add("POST", "/api/resources/:id/releases", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "publish this resource");

    const body = await readJson<{
      revision?: number;
      environment?: string;
      planId?: string;
      skipChain?: boolean;
      reason?: string;
    }>(ctx);
    const environment = environmentIn(
      ctx,
      body.environment ?? ctx.url.searchParams.get("environment") ?? ctx.app.config.promotionChain[0]!,
    );
    const revision = revisionFor(ctx, row.id, body.revision);
    const db = ctx.app.db;

    // Break-glass is admin-only and recorded, both in the release and in the audit log.
    if (body.skipChain) {
      if (!user.isAdmin) throw forbidden("skipChain is admin-only (design section 6.2 break-glass)");
      if (!body.reason || body.reason.trim().length === 0) {
        throw badRequest("skipChain requires a reason, which is recorded on the release and audited");
      }
    }

    const plan = computePlan(ctx.app, {
      resource: row,
      revision,
      environment,
      skipChain: body.skipChain === true,
    });

    if (ctx.url.searchParams.get("dryRun") === "1") {
      const stored = persistPlan(ctx, plan, user.id);
      return json({ planId: stored.id, planDigest: stored.digest, plan });
    }

    if (plan.blockers.length > 0) {
      throw conflict(plan.blockers.map((b) => b.detail).join("; "), { blockers: plan.blockers });
    }

    // A promotion must be confirmed against a plan someone saw; the first link has no merge, so
    // it may release without one and gets a freshly computed plan instead.
    let planId = body.planId;
    if (!planId) {
      if (plan.from !== null && !body.skipChain) {
        throw badRequest(
          `releasing into ${environment} promotes from ${plan.from}, so it needs a planId: ` +
            `POST this endpoint with ?dryRun=1 first and confirm the plan you were shown`,
        );
      }
      planId = persistPlan(ctx, plan, user.id).id;
    } else {
      const stored = db
        .query<
          { id: string; resource_id: string; revision_id: string; environment: string },
          [string]
        >("SELECT id, resource_id, revision_id, environment FROM release_plan WHERE id = ?")
        .get(planId);
      if (!stored) throw notFound(`no release plan ${planId}`);
      if (
        stored.resource_id !== row.id ||
        stored.environment !== environment ||
        stored.revision_id !== revision.id
      ) {
        throw badRequest("that plan was computed for a different resource, revision or environment");
      }
      // Single-use: a plan already confirmed cannot be replayed (review V2-03).
      const used = db
        .query<{ id: string; state: string }, [string]>(
          "SELECT id, state FROM release WHERE plan_id = ? AND state <> 'stale'",
        )
        .get(planId);
      if (used) throw conflict(`plan ${planId} has already been confirmed by release ${used.id}`);
    }

    // Any of the environment's gateways as the job's handle; the reconciler puts the release on
    // every gateway the resource is bound to, or on all of them when nothing has said otherwise.
    const target = db
      .query<{ id: string }, [string]>("SELECT id FROM target WHERE environment = ? ORDER BY name")
      .get(environment);
    if (!target) throw conflict(`no gateway is configured for ${environment}`);

    const releaseId = newId("rel");
    db.run(
      `INSERT INTO release (id, resource_id, revision_id, environment, state, reason, version_digest,
                            released_by, released_at, plan_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        releaseId,
        row.id,
        revision.id,
        environment,
        body.skipChain ? `skipChain: ${body.reason}` : null,
        revision.version_digest,
        user.id,
        nowIso(),
        planId,
      ],
    );
    // A revision freezes on its first release to any environment (design section 4).
    db.run("UPDATE revision SET frozen_at = COALESCE(frozen_at, ?) WHERE id = ?", [
      nowIso(),
      revision.id,
    ]);

    const jobId = enqueueJob(
      db,
      "reconcile",
      { targetId: target.id, resourceId: row.id, releaseId, planId, intent: "apply" },
      `reconcile:apply:${target.id}:${releaseId}`,
    );
    writeAudit(db, {
      actor: user.id,
      action: body.skipChain ? "release.skipChain" : "release.request",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: {
        environment,
        rev: revision.rev,
        releaseId,
        planId,
        from: plan.from,
        reason: body.reason ?? null,
      },
    });

    // Event-driven first (design section 7): the runner is in-process, so kick it now.
    runDueJobs(ctx.app);

    const state = db
      .query<{ state: string; reason: string | null }, [string]>(
        "SELECT state, reason FROM release WHERE id = ?",
      )
      .get(releaseId);

    return json(
      {
        releaseId,
        jobId,
        planId,
        rev: revision.rev,
        environment,
        from: plan.from,
        isRollback: plan.isRollback,
        seededUnits: plan.policy.create.map((e) => e.unit),
        state: state?.state ?? "pending",
        reason: state?.reason ?? null,
        warnings: plan.warnings,
      },
      { status: 202 },
    );
  });

  /**
   * Design section 6.3: aligning environments is always an explicit act. Without a unit list
   * this would be "copy everything", which is how an environment gets silently flattened.
   */
  router.add("POST", "/api/resources/:id/policy/copy-from", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "edit policy for this resource");

    const body = await readJson<{ fromEnvironment?: string; environment?: string; units?: string[] }>(ctx);
    const from = environmentIn(ctx, body.fromEnvironment ?? "");
    const to = environmentIn(ctx, body.environment ?? "");
    if (from === to) throw badRequest("fromEnvironment and environment must differ");
    const units = body.units ?? [];
    if (units.length === 0) {
      throw badRequest(
        "units: name the units to copy; copying everything is how an environment gets flattened",
      );
    }
    for (const unit of units) {
      if (!POLICY_UNITS.includes(unit as never)) throw badRequest(`unknown policy unit "${unit}"`);
    }

    const source = policyFor(ctx.app.db, row.id, from) as Record<string, unknown>;
    const before = policyFor(ctx.app.db, row.id, to) as Record<string, unknown>;
    const after = { ...before };
    for (const unit of units) {
      if (source[unit] === undefined) delete after[unit];
      else after[unit] = source[unit];
    }
    const errors = validateDocument(after, { kind: row.kind });
    if (errors.length > 0) throw conflict(`the result would be invalid: ${errors.join("; ")}`);

    const at = nowIso();
    const write = ctx.app.db.transaction(() => {
      for (const unit of units) {
        if (source[unit] === undefined) {
          ctx.app.db.run(
            "DELETE FROM policy_entry WHERE resource_id = ? AND environment = ? AND unit_key = ?",
            [row.id, to, unit],
          );
          continue;
        }
        const unitErrors = validateUnit(unit, source[unit]);
        if (unitErrors.length > 0) throw badRequest(unitErrors.join("; "));
        ctx.app.db.run(
          `INSERT INTO policy_entry (resource_id, environment, unit_key, value_json, origin,
                                     updated_by, updated_at)
           VALUES (?, ?, ?, ?, 'local', ?, ?)
           ON CONFLICT (resource_id, environment, unit_key) DO UPDATE SET
             value_json = excluded.value_json, origin = 'local',
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          [row.id, to, unit, JSON.stringify(source[unit]), user.id, at],
        );
      }
    });
    write();

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "policy.copyFrom",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { from, to, units },
    });
    // An explicit act, so everything it writes is `local` and will never be overwritten by a merge.
    return json({ from, to, units, before, after });
  });
}

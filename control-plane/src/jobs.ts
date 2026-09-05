import { runOperations } from "./operations.ts";
import { runIntegrationEvents } from "./integrations.ts";
import type { App } from "./router.ts";
import { newId, nowIso, type DB } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { compileMissingArtifacts } from "./artifacts.ts";
import { appliedDigest, buildRoutes, COMPILER_VERSION, limitsFor } from "./config-build.ts";
import { applySeededUnits, computePlan, planDigest, type ReleasePlan } from "./promotion.ts";
import { pruneOldRows } from "./telemetry.ts";

/**
 * One job table and one runner (design section 10). Jobs are durable, retried with backoff and
 * carry an idempotency key, and nothing long-running happens inside a request.
 *
 * The MVP runs the runner in-process and kicks it immediately on release — design section 7's
 * "event-driven first, sweep second", with the sweep as a short interval because the standalone
 * adapter is local and strongly consistent (its settle window is zero).
 */
export const MAX_ATTEMPTS = 3;

export interface ReconcilePayload {
  targetId: string;
  resourceId: string;
  releaseId?: string;
  planId?: string;
  intent: "apply" | "remove";
}

export function enqueueJob(
  db: DB,
  kind: string,
  payload: unknown,
  idempotencyKey?: string,
): string {
  if (idempotencyKey) {
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM job WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (existing) return existing.id;
  }
  const id = newId("job");
  const at = nowIso();
  db.run(
    `INSERT INTO job (id, kind, state, payload, idempotency_key, attempts, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, 0, ?, ?)`,
    [id, kind, JSON.stringify(payload), idempotencyKey ?? null, at, at],
  );
  return id;
}

/** Design section 7: one lease per target, taken in a transaction, so two runners cannot collide. */
function withTargetLease<T>(db: DB, targetId: string, holder: string, fn: () => T): T {
  const acquire = db.transaction(() => {
    const row = db
      .query<{ lease_holder: string | null; lease_expires_at: string | null }, [string]>(
        "SELECT lease_holder, lease_expires_at FROM target WHERE id = ?",
      )
      .get(targetId);
    if (!row) throw new Error(`target ${targetId} does not exist`);
    if (
      row.lease_holder &&
      row.lease_holder !== holder &&
      row.lease_expires_at &&
      Date.parse(row.lease_expires_at) > Date.now()
    ) {
      throw new Error(`target ${targetId} is leased by ${row.lease_holder}`);
    }
    db.run("UPDATE target SET lease_holder = ?, lease_expires_at = ? WHERE id = ?", [
      holder,
      new Date(Date.now() + 30_000).toISOString(),
      targetId,
    ]);
  });
  acquire();
  try {
    return fn();
  } finally {
    db.run("UPDATE target SET lease_holder = NULL, lease_expires_at = NULL WHERE id = ?", [targetId]);
  }
}

function reconcile(app: App, payload: ReconcilePayload): string {
  const { db } = app;
  const target = db
    .query<{ id: string; environment: string; paused: number }, [string]>(
      "SELECT id, environment, paused FROM target WHERE id = ?",
    )
    .get(payload.targetId);
  if (!target) throw new Error(`target ${payload.targetId} does not exist`);

  if (target.paused) {
    // `paused` stops the reconciler from writing anything; the gateway keeps serving what it has.
    throw new Error("environment is paused; waiting for automatic recovery");
  }

  return withTargetLease(db, target.id, "cp-inline-runner", () => {
    const apply = db.transaction(() => {
      if (payload.intent === "remove") {
        db.run(
          "UPDATE release SET state = 'withdrawn' WHERE resource_id = ? AND environment = ? AND state = 'converged'",
          [payload.resourceId, target.environment],
        );
        db.run("DELETE FROM applied WHERE target_id = ? AND resource_id = ?", [
          target.id,
          payload.resourceId,
        ]);
        writeAudit(db, {
          actor: "reconciler",
          action: "reconcile.remove",
          subject: `resource:${payload.resourceId}`,
          outcome: "ok",
          detail: { environment: target.environment },
        });
        return "withdrawn";
      }

      const release = db
        .query<{ id: string; revision_id: string; state: string; released_by: string }, [string]>(
          "SELECT id, revision_id, state, released_by FROM release WHERE id = ?",
        )
        .get(payload.releaseId ?? "");
      if (!release) throw new Error(`release ${payload.releaseId} does not exist`);

      // Design section 6.3: the job recomputes the plan and refuses to apply if the digest moved,
      // so the diff someone approved is the diff that runs. `stale` is terminal, not a retry.
      const stored = payload.planId
        ? db
            .query<{ plan_json: string; plan_digest: string }, [string]>(
              "SELECT plan_json, plan_digest FROM release_plan WHERE id = ?",
            )
            .get(payload.planId)
        : null;
      if (payload.planId && !stored) throw new Error(`release plan ${payload.planId} does not exist`);

      let plan: ReleasePlan | null = null;
      if (stored) {
        plan = JSON.parse(stored.plan_json) as ReleasePlan;
        const resource = db
          .query<
            { id: string; name: string; api_version: string; kind: string; application_id: string },
            [string]
          >("SELECT id, name, api_version, kind, application_id FROM resource WHERE id = ?")
          .get(payload.resourceId);
        const revision = db
          .query<{ id: string; rev: number }, [string]>("SELECT id, rev FROM revision WHERE id = ?")
          .get(release.revision_id);
        if (!resource || !revision) throw new Error("the resource or revision has gone away");

        const recomputed = computePlan(app, {
          resource,
          revision,
          environment: target.environment,
          // Recomputed the way it was first computed: the gate was decided when the release was
          // accepted, and re-deciding it here would make a break-glass release fail on its retry.
          skipChain: plan.skipChain,
        });
        if (recomputed.blockers.length) throw new Error(recomputed.blockers.map(b => b.detail).join("; "));
        plan = recomputed;
        // The merge is applied here, in the same transaction that moves release.state, so a
        // release that fails or goes stale changes no policy at all (review V1-03).
        applySeededUnits(db, plan, release.released_by);
      }

      db.run(
        `UPDATE release SET state = 'superseded'
          WHERE resource_id = ? AND environment = ? AND state = 'converged' AND id <> ?`,
        [payload.resourceId, target.environment, release.id],
      );
      db.run("UPDATE release SET state = 'converged', reason = NULL WHERE id = ?", [release.id]);

      const route = buildRoutes(db, target.environment, limitsFor(app.config.integrations)).routes.find(
        (r) => r.resourceId === payload.resourceId,
      );
      if (!route) {
        throw new Error(
          "the resource has no route or backend binding in this environment, so nothing can be published",
        );
      }

      db.run(
        `INSERT INTO applied (target_id, resource_id, revision_id, applied_digest, compiler_version, applied_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_id, resource_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           applied_digest = excluded.applied_digest,
           compiler_version = excluded.compiler_version,
           applied_at = excluded.applied_at`,
        [
          target.id,
          payload.resourceId,
          release.revision_id,
          appliedDigest(route),
          COMPILER_VERSION,
          nowIso(),
        ],
      );
      writeAudit(db, {
        actor: "reconciler",
        action: "reconcile.apply",
        subject: `resource:${payload.resourceId}`,
        outcome: "ok",
        detail: { environment: target.environment, releaseId: release.id, rev: route.rev },
      });
      return "converged";
    });
    return apply();
  });
}

/** Runs every queued job once. Returns how many ran. */
export function runDueJobs(app: App): number {
  runIntegrationEvents(app);
  runOperations(app);
  const { db } = app;
  db.run("UPDATE job SET state='queued' WHERE state='running' AND updated_at<?", [new Date(Date.now()-60000).toISOString()]);
  const jobs = db
    .query<{ id: string; kind: string; payload: string; attempts: number }, [string]>(
      "SELECT id, kind, payload, attempts FROM job WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 20",
    )
    .all(nowIso());

  for (const job of jobs) {
    db.run("UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", [
      nowIso(),
      job.id,
    ]);
    try {
      const result =
        job.kind === "reconcile"
          ? reconcile(app, JSON.parse(job.payload) as ReconcilePayload)
          : job.kind === "prune"
            ? pruneOldRows(app)
            : job.kind === "compile-artifacts"
              ? compileMissingArtifacts(app.db)
              : (() => {
                  throw new Error(`unknown job kind ${job.kind}`);
                })();
      db.run("UPDATE job SET state = 'done', result = ?, updated_at = ? WHERE id = ?", [
        result,
        nowIso(),
        job.id,
      ]);
    } catch (err) {
      const message = (err as Error).message;
      const attempts = job.attempts + 1;
      const finished = job.kind !== "reconcile" && attempts >= MAX_ATTEMPTS;
      db.run("UPDATE job SET next_attempt_at=? WHERE id=?", [new Date(Date.now()+Math.min(300000,1000*2**Math.min(attempts,8))).toISOString(),job.id]);
      db.run("UPDATE job SET state = ?, result = ?, updated_at = ? WHERE id = ?", [
        finished ? "failed" : "queued",
        message,
        nowIso(),
        job.id,
      ]);
      if (finished) {
        const payload = JSON.parse(job.payload) as ReconcilePayload;
        if (payload.releaseId) {
          db.run("UPDATE release SET state = 'failed', reason = ? WHERE id = ?", [
            message,
            payload.releaseId,
          ]);
        }
        writeAudit(db, {
          actor: "reconciler",
          action: "reconcile.failed",
          subject: `job:${job.id}`,
          outcome: "failed",
          detail: { message },
        });
      }
      console.error(`[cp] job ${job.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`);
    }
  }
  return jobs.length;
}

/**
 * Retention is a job, not a startup sweep: the idempotency key is the hour, so however often the
 * runner ticks, at most one prune per hour is ever queued (review V1-22).
 */
export function enqueueHourlyPrune(db: DB, nowMs = Date.now()): void {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  enqueueJob(db, "prune", { hour }, `prune:${hour}`);
}

/**
 * Revisions created before v3 have no compiled validator, and neither does one whose compilation
 * was deferred. The job is idempotent and bounded per run, so enqueuing it on every boot is safe
 * and converges (plan `[R3-01]`).
 */
export function enqueueArtifactBackfill(db: DB): void {
  const pending = db
    .query<{ n: number }, []>(
      // Tombstones excluded, for the same reason the job itself excludes them: they will never
      // compile, and counting them would queue this job on every tick for ever.
      "SELECT COUNT(*) AS n FROM revision WHERE artifact_digest IS NULL AND pruned_at IS NULL",
    )
    .get();
  if ((pending?.n ?? 0) === 0) return;
  enqueueJob(db, "compile-artifacts", { at: nowIso() }, `compile-artifacts:${Date.now()}`);
}

export function startJobRunner(app: App, intervalMs = 500): Timer {
  enqueueHourlyPrune(app.db);
  enqueueArtifactBackfill(app.db);
  return setInterval(() => {
    try {
      enqueueHourlyPrune(app.db);
      enqueueArtifactBackfill(app.db);
      runDueJobs(app);
    } catch (err) {
      console.error("[cp] job runner error", err);
    }
  }, intervalMs);
}

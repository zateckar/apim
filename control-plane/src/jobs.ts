import { runOperations } from "./operations.ts";
import { runIntegrationEvents } from "./integrations.ts";
import { runKeyExpiry } from "./key-expiry.ts";
import type { App } from "./router.ts";
import { newId, nowIso, type DB } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { compileMissingArtifacts } from "./artifacts.ts";
import { appliedDigest, buildRoutes, COMPILER_VERSION, limitsFor } from "./config-build.ts";
import { denyRulesFor } from "./deny-rules.ts";
import { applySeededUnits, computePlan, planDigest, type ReleasePlan } from "./promotion.ts";
import { pruneOldRows } from "./telemetry.ts";
import { REACHED_FLEET_STATES } from "../../shared/types.ts";

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
  /** The job's scope; `targetId` is only a handle into it. Absent on a job queued before it existed. */
  environment?: string;
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

/**
 * A reconcile that can never succeed. Retrying it would only hide it, so it fails at once and is
 * shown as a failed job — unlike everything else a reconcile throws, which is a condition that
 * clears (a paused gateway, a missing route) and is retried until it does.
 */
export class Unrecoverable extends Error {}

/**
 * Who holds a lease: this process. It was the constant `"cp-inline-runner"`, shared by every runner,
 * so the holder check below compared a string with itself and let a second control plane on the
 * same database straight through the lease that exists to stop it (control-plane-surface, "Two
 * runners reach the same target").
 */
const LEASE_HOLDER = `cp-${process.pid}-${newId("run")}`;

/** Design section 7: one lease per target, taken in a transaction, so two runners cannot collide. */
function withTargetLease<T>(db: DB, targetId: string, fn: () => T): T {
  const holder = LEASE_HOLDER;
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
    // Only our own: a lease that expired under a slow job and was taken by another runner is theirs.
    db.run(
      "UPDATE target SET lease_holder = NULL, lease_expires_at = NULL WHERE id = ? AND lease_holder = ?",
      [targetId, holder],
    );
  }
}

function reconcile(app: App, payload: ReconcilePayload): string {
  const { db } = app;
  const release = payload.releaseId
    ? db
        .query<{ environment: string }, [string]>("SELECT environment FROM release WHERE id = ?")
        .get(payload.releaseId)
    : null;
  // Deleting the API cascades its releases away. Nothing is left to apply, and a job that retried
  // "does not exist" every five minutes for ever would only bury the jobs that are really stuck.
  if (payload.releaseId && !release) return "nothing to apply: the release no longer exists";

  // `targetId` is a handle, not the scope: the job's scope is the environment. The handle can be
  // deleted while the job waits (a gateway with no route yet is removable), so the environment is
  // carried on the payload, and read from the release for a job queued before it was.
  const handle = db
    .query<{ id: string; environment: string }, [string]>("SELECT id, environment FROM target WHERE id = ?")
    .get(payload.targetId);
  const environment = handle?.environment ?? payload.environment ?? release?.environment;
  if (!environment) {
    throw new Unrecoverable(
      `gateway ${payload.targetId} no longer exists and this job does not say which environment it was for`,
    );
  }

  /**
   * Every gateway the job will write for, and all of them must be taking changes. It used to ask
   * only the handle, so a release onto `managed` and `onprem` with `onprem` paused went out to
   * `onprem` too — the spine already refused that (control-plane-surface, "The environment cannot
   * take the change"), and a release must not mean something the spine refuses.
   */
  const bound = db
    .query<{ target_id: string }, [string, string]>(
      "SELECT target_id FROM route_gateway WHERE resource_id = ? AND environment = ?",
    )
    .all(payload.resourceId, environment)
    .map((r) => r.target_id);
  const affected = db
    .query<{ id: string; name: string; paused: number }, [string]>(
      "SELECT id, name, paused FROM target WHERE environment = ? ORDER BY name",
    )
    .all(environment)
    .filter((t) => payload.intent === "remove" || bound.length === 0 || bound.includes(t.id));
  if (payload.intent === "apply" && affected.length === 0) {
    throw new Error(`${environment.toUpperCase()} has no gateway to publish on; deployment will resume automatically`);
  }
  const paused = affected.filter((t) => t.paused);
  if (paused.length > 0) {
    // `paused` stops the reconciler from writing anything; the gateway keeps serving what it has.
    throw new Error(
      `${paused.map((t) => `${environment}/${t.name}`).join(", ")} ${paused.length === 1 ? "is" : "are"} ` +
        "paused; deployment will resume automatically when resumed",
    );
  }
  const target = { id: handle?.id ?? affected[0]?.id ?? payload.targetId, environment };

  return withTargetLease(db, target.id, () => {
    const apply = db.transaction(() => {
      if (payload.intent === "remove") {
        db.run(
          "UPDATE release SET state = 'withdrawn' WHERE resource_id = ? AND environment = ? AND state = 'converged'",
          [payload.resourceId, target.environment],
        );
        // And every release of it here still waiting to apply: its job would otherwise converge it
        // when its backoff expires and publish the API again after somebody withdrew it. The
        // withdrawal is the later act, and it wins (api-versioning-and-stage).
        db.run(
          "UPDATE release SET state = 'stale', reason = ? WHERE resource_id = ? AND environment = ? AND state = 'pending'",
          [
            `withdrawn from ${target.environment.toUpperCase()} before it was applied; release it again to publish it`,
            payload.resourceId,
            target.environment,
          ],
        );
        // Every gateway in the environment, not just the one that happened to be the job's handle:
        // "withdrawn from TEST" cannot mean "withdrawn from half of TEST".
        db.run(
          `DELETE FROM applied WHERE resource_id = ?
             AND target_id IN (SELECT id FROM target WHERE environment = ?)`,
          [payload.resourceId, target.environment],
        );
        db.run("DELETE FROM route_gateway WHERE resource_id = ? AND environment = ?", [
          payload.resourceId,
          target.environment,
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
      if (!release) return "nothing to apply: the release no longer exists";

      /**
       * Only a `pending` release is applied. Anything else is one of two things, and both are
       * no-ops:
       *
       *  - A replay. The job is marked `done` by `runDueJobs` after this transaction commits, and a
       *    job left `running` is re-queued a minute later, so a process that died between the two
       *    runs this again for a release it already applied. Everything the first run did committed
       *    with it — and doing it again is harmful: it would converge a release since superseded or
       *    withdrawn, or (below) mark one `stale` that reached the fleet, which the promotion gate
       *    reads as "never got here".
       *  - A release a withdrawal already made `stale` (the `remove` branch above).
       *
       * `formal/Formal/Release.lean` is the model of this function; its `reconcile` and `goStale`
       * steps both require `pending`.
       */
      if (release.state !== "pending") return `nothing to apply: release is ${release.state}`;

      /**
       * A release whose job has been retrying — a paused environment, a missing route — is not
       * cancelled when a release confirmed after it reaches the fleet here. Converging it when its
       * backoff expires would supersede the newer one and roll the environment back without anyone
       * having asked; a rollback is a *new* release of the older revision (api-versioning-and-stage,
       * "Never let an earlier release overtake one that reached the fleet after it"). So it
       * goes `stale`, which is terminal: the job is done, nothing is published and no policy is
       * seeded, because this is checked before the plan is.
       *
       * "After it" is `rowid`, the insertion order both writers of `release` share (this job and
       * the operation spine). `formal/Formal/Release.lean` proves that this guard is what keeps the
       * live release the newest one to have reached the fleet, and shows the trace that broke it
       * without the guard (`older_release_resurrects`).
       */
      const overtakenBy = db
        .query<{ id: string }, string[]>(
          `SELECT id FROM release
            WHERE resource_id = ? AND environment = ?
              AND state IN (${REACHED_FLEET_STATES.map(() => "?").join(", ")})
              AND rowid > (SELECT rowid FROM release WHERE id = ?)
            ORDER BY rowid LIMIT 1`,
        )
        .get(payload.resourceId, target.environment, ...REACHED_FLEET_STATES, release.id);
      if (overtakenBy) {
        db.run("UPDATE release SET state = 'stale', reason = ? WHERE id = ?", [
          `release ${overtakenBy.id} was confirmed after this one and reached ` +
            `${target.environment.toUpperCase()} first; release this revision again to roll back to it`,
          release.id,
        ]);
        writeAudit(db, {
          actor: "reconciler",
          action: "reconcile.stale",
          subject: `resource:${payload.resourceId}`,
          outcome: "ok",
          detail: { environment: target.environment, releaseId: release.id, overtakenBy: overtakenBy.id },
        });
        return "stale";
      }

      // The job recomputes the plan and applies the current one; a plan with blockers is retried.
      // Design section 6.3 had a moved digest mark the release `stale` instead, which ae9a9ce
      // dropped: a promotion is one business action, not a confirm the publisher has to repeat
      // after their own edit (api-versioning-and-stage, "The plan changed between review and apply").
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

      const route = buildRoutes(
        db,
        target.environment,
        limitsFor(app.config.integrations),
        denyRulesFor(db, app.config.publicUrl),
      ).routes.find((r) => r.resourceId === payload.resourceId);
      if (!route) {
        throw new Error(
          "the resource has no route or backend binding in this environment, so nothing can be published — " +
            "or its backend is blocked by a deny rule, which the environment's configuration says in as many words",
        );
      }

      // Which gateways it goes on. A release that came through the promotion API has already said
      // so; one that arrived any other way lands on every gateway the environment has, which is
      // what "released into TEST" meant before an environment could hold more than one.
      let bound = db
        .query<{ target_id: string }, [string, string]>(
          "SELECT target_id FROM route_gateway WHERE resource_id = ? AND environment = ?",
        )
        .all(payload.resourceId, target.environment)
        .map((r) => r.target_id);
      if (bound.length === 0) {
        bound = db
          .query<{ id: string }, [string]>("SELECT id FROM target WHERE environment = ?")
          .all(target.environment)
          .map((r) => r.id);
        for (const id of bound) {
          db.run(
            "INSERT INTO route_gateway (resource_id, environment, target_id) VALUES (?, ?, ?)",
            [payload.resourceId, target.environment, id],
          );
        }
      }
      for (const id of bound) {
        db.run(
          `INSERT INTO applied (target_id, resource_id, revision_id, applied_digest, compiler_version, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (target_id, resource_id) DO UPDATE SET
             revision_id = excluded.revision_id,
             applied_digest = excluded.applied_digest,
             compiler_version = excluded.compiler_version,
             applied_at = excluded.applied_at`,
          [
            id,
            payload.resourceId,
            release.revision_id,
            appliedDigest(route),
            COMPILER_VERSION,
            nowIso(),
          ],
        );
      }
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
  // Before the operations pass reads the fleet's digests, not after: retiring a key changes the
  // environment's configuration document, and running it afterwards would leave one whole cycle in
  // which the control plane had decided a key was dead and the gateways had not been told.
  runKeyExpiry(app);
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
      // A reconcile is retried until it applies, however long that takes (ae9a9ce: giving up would
      // abandon desired state and hand a technical retry back to the publisher); it is shown as
      // stuck from `MAX_ATTEMPTS` on instead (attention, `job-retrying`). Only one that can never
      // succeed fails. Every other kind stops after `MAX_ATTEMPTS`.
      const finished =
        err instanceof Unrecoverable || (job.kind !== "reconcile" && attempts >= MAX_ATTEMPTS);
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
          // Guarded: only a release still waiting can fail. Unguarded, a job that failed after its
          // release converged would turn a revision that reached the fleet into one the promotion
          // gate reads as "never got here" (formal/Formal/Release.lean, `reached_monotone`).
          db.run("UPDATE release SET state = 'failed', reason = ? WHERE id = ? AND state = 'pending'", [
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

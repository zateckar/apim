import { writeAudit } from "./audit.ts";
import { nowIso, type DB } from "./db.ts";
import type { App } from "./router.ts";

/**
 * Revision retention and its consequences (design section 4.1, G3, plan §7.4).
 *
 * Called by the existing hourly `prune` job rather than being a job of its own: `prune` already
 * deletes by age under an hour-scoped idempotency key, and design section 10 lists revision
 * pruning as part of the same work `[P2-04]`.
 *
 * Three things make this safe to run unattended:
 *
 *  - **the bound is the tighter of the two.** A revision survives on age only if it is *also*
 *    within the newest `REVISION_KEEP_COUNT`, which is how design section 4.1 states it — reading
 *    it as a union would keep everything anybody uploaded in the last year `[P1-27]`.
 *  - **three exceptions keep a revision at any age**: it is released somewhere now, it is the
 *    previous released revision of an environment (the rollback target §6 promises), or a release
 *    or a *live* plan still points at it.
 *  - **nothing is deleted.** The row stays as a tombstone — id, rev, digests, author, timestamps —
 *    so releases, audit rows and foreign keys still resolve. Only the bytes go.
 */

export interface RevisionPruneResult {
  tombstoned: number;
  artifactsDropped: number;
}

/**
 * The revisions whose content may go. Returned rather than deleted so the caller can log them and
 * a test can assert the decision apart from the write.
 *
 * Every clause is SQL over indexed columns: an estate with a hundred thousand revisions costs the
 * same shape of work as one with ten.
 */
export function prunableRevisions(
  db: DB,
  options: { keepCount: number; keepDays: number; planRetentionHours: number; now?: number },
): Array<{ id: string; resource_id: string; rev: number }> {
  const now = options.now ?? Date.now();
  const ageCutoff = new Date(now - options.keepDays * 86_400_000).toISOString();
  const planCutoff = new Date(now - options.planRetentionHours * 3_600_000).toISOString();

  return db
    .query<{ id: string; resource_id: string; rev: number }, [number, string, string]>(
      `WITH ranked AS (
         SELECT id, resource_id, rev, created_at,
                ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY rev DESC) AS rank
           FROM revision
          WHERE pruned_at IS NULL
       ),
       -- The newest two releases that ever reached the fleet, per environment: the one that is
       -- live and the one a rollback would return to (design section 6).
       recent_releases AS (
         SELECT revision_id,
                ROW_NUMBER() OVER (
                  PARTITION BY resource_id, environment ORDER BY released_at DESC
                ) AS recency
           FROM release
          WHERE state IN ('converged', 'superseded', 'withdrawn')
       )
       SELECT id, resource_id, rev
         FROM ranked
        WHERE (rank > ? OR created_at < ?)
          AND id NOT IN (SELECT revision_id FROM recent_releases WHERE recency <= 2)
          AND id NOT IN (
                SELECT revision_id FROM release
                 WHERE state IN ('pending', 'converging', 'converged')
              )
          AND id NOT IN (SELECT revision_id FROM release_plan WHERE computed_at >= ?)
        ORDER BY resource_id, rev`,
    )
    .all(options.keepCount, ageCutoff, planCutoff);
}

/**
 * Empty the content of every prunable revision and drop the artifacts nothing references any more.
 *
 * The reference count is a `COUNT` over `revision.artifact_digest` **excluding tombstones** (D29):
 * one column already carries the reference, and excluding tombstones is what lets the count reach
 * zero at all `[P1-03]`. `''` is not a reference — v3 writes it deliberately for a revision that
 * declares no schemas, and treating the sentinel as a reference would keep a phantom for ever
 * `[P2-12]`.
 */
export function pruneRevisions(app: App): RevisionPruneResult {
  const { db, config } = app;
  const doomed = prunableRevisions(db, {
    keepCount: config.revisionKeepCount,
    keepDays: config.revisionKeepDays,
    planRetentionHours: config.jobRetentionHours,
  });
  if (doomed.length === 0) return { tombstoned: 0, artifactsDropped: 0 };

  const at = nowIso();
  const result = db.transaction(() => {
    for (const revision of doomed) {
      // `model` and `original` are NOT NULL, so a tombstone carries the empty string. `''` reads
      // as "there was a document here and it is gone", which is what the UI renders greyed.
      db.run(
        "UPDATE revision SET model = '', original = '', index_json = NULL, pruned_at = ? WHERE id = ?",
        [at, revision.id],
      );
    }
    const artifacts = db.run(
      `DELETE FROM artifact
        WHERE digest NOT IN (
          SELECT artifact_digest FROM revision
           WHERE artifact_digest IS NOT NULL AND artifact_digest <> '' AND pruned_at IS NULL
        )`,
    );
    return { tombstoned: doomed.length, artifactsDropped: artifacts.changes };
  })();

  writeAudit(db, {
    actor: "system",
    action: "revision.prune",
    subject: "retention",
    outcome: "ok",
    detail: {
      tombstoned: result.tombstoned,
      artifactsDropped: result.artifactsDropped,
      keepCount: config.revisionKeepCount,
      keepDays: config.revisionKeepDays,
      revisions: doomed.slice(0, 20).map((revision) => `${revision.resource_id}#${revision.rev}`),
    },
  });
  return result;
}

/**
 * The playground's history (G1, D27). A user's scratchpad, not a call ledger, so it goes by age —
 * `PLAYGROUND_HISTORY_RETENTION_DAYS` — as well as by the per-resource cap the write path applies.
 */
export function prunePlaygroundHistory(app: App, now = Date.now()): number {
  const cutoff = new Date(now - app.config.playgroundHistoryRetentionDays * 86_400_000).toISOString();
  return app.db.run("DELETE FROM playground_call WHERE created_at < ?", [cutoff]).changes;
}

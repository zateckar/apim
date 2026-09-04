import { addBuckets, emptyBuckets, windowStartOf, type TelemetryReport } from "../../shared/telemetry.ts";
import { writeAudit } from "./audit.ts";
import { nowIso, type DB } from "./db.ts";
import { prunePlaygroundHistory, pruneRevisions } from "./retention.ts";
import type { App } from "./router.ts";

/**
 * Telemetry aggregation (plan G4, deviation D15).
 *
 * Design section 5.7's rule for `usage_counter` applies here for the same reason: N instances x
 * active subscriptions x poll rate against a single SQLite writer is a steady write load. So
 * reports accumulate in memory and are flushed on a slower cadence in one batched transaction.
 *
 * The report is **absolute per (window, series), never a delta**, and the flush **replaces**.
 * That is what makes a re-sent report idempotent, which matters because a lost response is the
 * normal outcome of a control-plane restart — exactly when someone is looking at the dashboard
 * (review V1-01). Two supporting rules: a request is counted in the minute it *completed*, so a
 * closed window never reopens; and the instance clears a window only once it is closed and
 * acknowledged.
 */
interface BufferedSeries {
  environment: string;
  instanceId: string;
  runId: string;
  windowStart: string;
  resourceId: string;
  subscriptionId: string;
  outcome: string;
  status: number;
  count: number;
  durationMsSum: number;
  durationMsMax: number;
  bytesIn: number;
  bytesOut: number;
  buckets: number[];
}

const OVERFLOW_RUN = "overflow";

export class TelemetryAggregator {
  private buffer = new Map<string, BufferedSeries>();
  /** `${instanceId}|${windowStart}` → run ids seen, so a crash loop cannot multiply rows. */
  private runsSeen = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  foldedRuns = 0;

  constructor(
    private readonly db: DB,
    private readonly maxRunsPerInstanceWindow: number,
  ) {}

  /**
   * Takes responsibility for the report's **closed** windows and returns exactly those, so the
   * instance knows what it may clear. The current partial minute is deliberately not accepted:
   * it will be re-sent, and replaced, until it closes.
   */
  accept(
    environment: string,
    instanceId: string,
    runId: string,
    report: TelemetryReport,
    nowMs = Date.now(),
  ): string[] {
    const currentWindow = windowStartOf(nowMs);
    const accepted: string[] = [];

    for (const window of report.windows ?? []) {
      const effectiveRun = this.runFor(instanceId, window.windowStart, runId);
      for (const series of window.series ?? []) {
        const key = [
          environment,
          instanceId,
          effectiveRun,
          window.windowStart,
          series.resourceId,
          series.subscriptionId,
          series.outcome,
          series.status,
        ].join("|");

        const existing = this.buffer.get(key);
        if (existing && effectiveRun === OVERFLOW_RUN) {
          // Folded runs are several processes sharing one key, so their counts add rather than
          // replace — otherwise the last one to report would erase the others.
          existing.count += series.count;
          existing.durationMsSum += series.durationMsSum;
          existing.durationMsMax = Math.max(existing.durationMsMax, series.durationMsMax);
          existing.bytesIn += series.bytesIn;
          existing.bytesOut += series.bytesOut;
          addBuckets(existing.buckets, series.buckets ?? []);
          continue;
        }
        this.buffer.set(key, {
          environment,
          instanceId,
          runId: effectiveRun,
          windowStart: window.windowStart,
          resourceId: series.resourceId ?? "",
          subscriptionId: series.subscriptionId ?? "",
          outcome: series.outcome,
          status: series.status,
          count: series.count,
          durationMsSum: series.durationMsSum,
          durationMsMax: series.durationMsMax,
          bytesIn: series.bytesIn,
          bytesOut: series.bytesOut,
          buckets: addBuckets(emptyBuckets(), series.buckets ?? []),
        });
      }
      if (window.windowStart < currentWindow) accepted.push(window.windowStart);
    }
    return accepted;
  }

  private runFor(instanceId: string, windowStart: string, runId: string): string {
    const key = `${instanceId}|${windowStart}`;
    let runs = this.runsSeen.get(key);
    if (!runs) {
      runs = new Set();
      this.runsSeen.set(key, runs);
    }
    if (runs.has(runId)) return runId;
    if (runs.size >= this.maxRunsPerInstanceWindow) {
      this.foldedRuns++;
      return OVERFLOW_RUN;
    }
    runs.add(runId);
    return runId;
  }

  /** Writes everything buffered. Called on a timer and, by tests, directly — never slept on. */
  flushNow(): number {
    if (this.buffer.size === 0) {
      this.forgetOldRunWindows();
      return 0;
    }
    const pending = [...this.buffer.values()];
    this.buffer.clear();

    /*
     * Ids are stored as reported, including ones whose resource has since been deleted. There is
     * deliberately no foreign key here (`''` has no referent), so a dangling id cannot fail a
     * batch — and keeping it means a deleted API's traffic stays attributable to that API for the
     * retention window instead of being dumped into the no-route bucket, which would report
     * requests as having matched no route when they plainly did.
     *
     * The consequence is that such rows become admin-only, because team scoping resolves through
     * `resource.team_id` and there is no longer a row to resolve.
     */
    const upsert = this.db.query(
      `INSERT INTO telemetry_rollup
         (environment, instance_id, run_id, window_start, resource_id, subscription_id,
          outcome, status, count, duration_ms_sum, duration_ms_max, bytes_in, bytes_out, buckets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment, instance_id, run_id, window_start, resource_id, subscription_id,
                    outcome, status)
       DO UPDATE SET count = excluded.count,
                     duration_ms_sum = excluded.duration_ms_sum,
                     duration_ms_max = excluded.duration_ms_max,
                     bytes_in = excluded.bytes_in,
                     bytes_out = excluded.bytes_out,
                     buckets_json = excluded.buckets_json`,
    );

    const write = this.db.transaction((rows: BufferedSeries[]) => {
      for (const row of rows) {
        upsert.run(
          row.environment,
          row.instanceId,
          row.runId,
          row.windowStart,
          row.resourceId,
          row.subscriptionId,
          row.outcome,
          row.status,
          row.count,
          row.durationMsSum,
          row.durationMsMax,
          row.bytesIn,
          row.bytesOut,
          JSON.stringify(row.buckets),
        );
      }
    });
    write(pending);
    this.forgetOldRunWindows();
    return pending.length;
  }

  /** The run-tracking map is only needed while a window can still be reported into. */
  private forgetOldRunWindows(nowMs = Date.now()): void {
    const cutoff = windowStartOf(nowMs - 60 * 60_000);
    for (const key of this.runsSeen.keys()) {
      const windowStart = key.slice(key.indexOf("|") + 1);
      if (windowStart < cutoff) this.runsSeen.delete(key);
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      try {
        this.flushNow();
      } catch (err) {
        console.error("[cp] telemetry flush failed", err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get pending(): number {
    return this.buffer.size;
  }
}

/**
 * Three subjects, one job (review V1-22). `audit` is never pruned: dropping its triggers is a
 * separate, logged act the design puts out of scope here.
 */
export function pruneOldRows(app: App): string {
  const { db, config } = app;
  const telemetryCutoff = new Date(
    Date.now() - config.telemetryRetentionHours * 3_600_000,
  ).toISOString();
  const jobCutoff = new Date(Date.now() - config.jobRetentionHours * 3_600_000).toISOString();

  const removed = db.transaction(() => {
    const telemetry = db.run("DELETE FROM telemetry_rollup WHERE window_start < ?", [telemetryCutoff]);
    const jobs = db.run("DELETE FROM job WHERE state IN ('done','failed') AND updated_at < ?", [
      jobCutoff,
    ]);
    const plans = db.run(
      `DELETE FROM release_plan
        WHERE computed_at < ?
          AND id NOT IN (SELECT plan_id FROM release WHERE plan_id IS NOT NULL)`,
      [jobCutoff],
    );
    return {
      telemetry: telemetry.changes,
      jobs: jobs.changes,
      plans: plans.changes,
    };
  })();

  // v4: the same job, two more subjects (plan §7.4). Ordered after the plan delete on purpose —
  // a plan the prune job has already removed protects no revision, and saying so is better than
  // implying a guarantee this schedule takes away `[P1-15]`.
  const revisions = pruneRevisions(app);
  const playground = prunePlaygroundHistory(app);
  // v5: sign-ins and sessions `[P1-19]`. Both tables grow with use and neither is ever read again
  // once it is past its horizon — an abandoned sign-in is dead 120 seconds after it started, and a
  // revoked or expired session is dead the moment it is. Left alone, `auth_flow` in particular
  // grows by one row per user who opens the sign-in page and changes their mind.
  const auth = pruneAuthRows(app);

  const summary =
    `pruned ${removed.telemetry} telemetry rows, ${removed.jobs} jobs, ${removed.plans} plans, ` +
    `${revisions.tombstoned} revisions (${revisions.artifactsDropped} artifacts), ` +
    `${playground} playground history entries, ${auth.flows} abandoned sign-ins, ` +
    `${auth.sessions} dead sessions`;
  const total =
    removed.telemetry +
    removed.jobs +
    removed.plans +
    revisions.tombstoned +
    revisions.artifactsDropped +
    playground +
    auth.flows +
    auth.sessions;
  if (total > 0) {
    writeAudit(db, {
      actor: "system",
      action: "prune",
      subject: "retention",
      outcome: "ok",
      detail: {
        ...removed,
        revisionsTombstoned: revisions.tombstoned,
        artifactsDropped: revisions.artifactsDropped,
        playgroundEntries: playground,
        authFlows: auth.flows,
        sessions: auth.sessions,
        telemetryCutoff,
        jobCutoff,
        at: nowIso(),
      },
    });
  }
  return summary;
}

/**
 * Abandoned sign-ins and dead sessions.
 *
 * A session is deleted rather than left revoked because it is not evidence: the audit log records
 * who signed in and who signed out, and the session row's only job is to answer "is this cookie
 * still good". `SESSION_PRUNE_AFTER_DAYS` past its own expiry is a horizon generous enough that
 * "my other devices" still lists a laptop somebody has not opened this week.
 */
function pruneAuthRows(app: App): { flows: number; sessions: number } {
  const { db, config } = app;
  const now = nowIso();
  const sessionCutoff = new Date(
    Date.now() - config.sessionPruneAfterDays * 86_400_000,
  ).toISOString();
  return db.transaction(() => {
    const flows = db.run("DELETE FROM auth_flow WHERE expires_at < ?", [now]);
    const sessions = db.run(
      `DELETE FROM session
        WHERE expires_at < ?
           OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      [sessionCutoff, sessionCutoff],
    );
    return { flows: flows.changes, sessions: sessions.changes };
  })();
}

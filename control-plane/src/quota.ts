import {
  MAX_QUOTA_ENTRIES,
  quotaKeyString,
  type QuotaAggregate,
  type QuotaDelta,
  type QuotaScope,
} from "../../shared/quota.ts";
import type { DB } from "./db.ts";

/**
 * The fleet side of design section 5.7. Instances count locally and report deltas on the poll they
 * already make; this adds them up and hands the total back, so `aggregate + own delta since` is
 * what each instance enforces against.
 *
 * Three properties are load-bearing:
 *
 *  - **Enforcement only, never a ledger** (deviation D15). These counters exist so a quota can be
 *    enforced; they are not billing records, they are dropped when their window closes, and a lost
 *    report under-counts rather than being reconciled. Anything that needs an audit trail reads
 *    telemetry, which has different guarantees and says so.
 *  - **Batched writes, so the flush interval *is* the RPO.** A poll adds to memory; a timer writes
 *    to SQLite. A control-plane crash loses at most one interval's counts, which is stated as
 *    `USAGE_FLUSH_INTERVAL_SEC` rather than discovered. Writing per poll would make the quota
 *    counter the busiest table in the database for no accuracy that matters at this resolution.
 *  - **The reply is the environment's live windows, not an echo of what was reported.** An instance
 *    that saw no traffic for a key this interval still needs that key's fleet count, because other
 *    instances did. Echoing deltas back would leave an idle instance enforcing against a stale
 *    total.
 */

interface Pending {
  environment: string;
  subscriptionId: string;
  scopeKind: QuotaScope;
  scopeId: string;
  periodSec: number;
  windowStart: string;
  delta: number;
}

export class QuotaService {
  /** Counted but not yet written. Bounded by the same ceiling the wire is. */
  private pending = new Map<string, Pending>();
  /** Deltas that arrived past the ceiling, so the truncation is visible rather than silent. */
  droppedDeltas = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DB,
    private readonly maxEntries = MAX_QUOTA_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Takes one instance's report. Rejects nothing on grounds of size — the poll body is already
   * bounded by `MAX_REPORT_BYTES` — but stops accumulating new keys past the ceiling, because an
   * unbounded map here is a control-plane memory leak driven by data-plane traffic.
   */
  accept(environment: string, deltas: QuotaDelta[] | undefined): void {
    for (const delta of deltas ?? []) {
      if (!Number.isFinite(delta.count) || delta.count <= 0) continue;
      if (!isScope(delta.scopeKind)) continue;
      const id = `${environment}|${quotaKeyString(delta)}`;
      const existing = this.pending.get(id);
      if (existing) {
        existing.delta += delta.count;
        continue;
      }
      if (this.pending.size >= this.maxEntries) {
        this.droppedDeltas++;
        continue;
      }
      this.pending.set(id, {
        environment,
        subscriptionId: delta.subscriptionId,
        scopeKind: delta.scopeKind,
        scopeId: delta.scopeId,
        periodSec: delta.periodSec,
        windowStart: delta.windowStart,
        delta: delta.count,
      });
    }
  }

  /**
   * The fleet's count for every window in this environment that has not closed yet, including
   * whatever is still pending — an instance must not be told a smaller number than it just
   * reported.
   */
  aggregatesFor(environment: string): QuotaAggregate[] {
    const at = this.now();
    const totals = new Map<string, QuotaAggregate>();

    const rows = this.db
      .query<
        {
          subscription_id: string;
          scope_kind: string;
          scope_id: string;
          period_sec: number;
          window_start: string;
          count: number;
        },
        [string, number]
      >(
        `SELECT subscription_id, scope_kind, scope_id, period_sec, window_start, count
           FROM usage_counter
          WHERE environment = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(environment, this.maxEntries);

    for (const row of rows) {
      const aggregate: QuotaAggregate = {
        subscriptionId: row.subscription_id,
        scopeKind: row.scope_kind as QuotaScope,
        scopeId: row.scope_id,
        periodSec: row.period_sec,
        windowStart: row.window_start,
        count: row.count,
      };
      if (!isLive(aggregate, at)) continue;
      totals.set(quotaKeyString(aggregate), aggregate);
    }

    for (const entry of this.pending.values()) {
      if (entry.environment !== environment) continue;
      const key = quotaKeyString(entry);
      const existing = totals.get(key);
      if (existing) existing.count += entry.delta;
      else if (totals.size < this.maxEntries) {
        totals.set(key, { ...entry, count: entry.delta });
      }
    }

    return [...totals.values()];
  }

  /** Writes what has accumulated. Called on a timer; the interval is the RPO. */
  flush(): number {
    if (this.pending.size === 0) return 0;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    // The injected clock, not the wall clock: `updated_at` is what `sweep` compares against, so a
    // service given a clock has to use it for both or the two disagree.
    const at = new Date(this.now()).toISOString();
    const write = this.db.transaction(() => {
      for (const entry of batch) {
        this.db.run(
          `INSERT INTO usage_counter
             (subscription_id, environment, scope_kind, scope_id, period_sec, window_start, count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (subscription_id, environment, scope_kind, scope_id, period_sec, window_start)
           DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`,
          [
            entry.subscriptionId,
            entry.environment,
            entry.scopeKind,
            entry.scopeId,
            entry.periodSec,
            entry.windowStart,
            entry.delta,
            at,
          ],
        );
      }
    });
    write();
    return batch.length;
  }

  /**
   * A window that has closed can never be counted against again, so keeping it would only grow the
   * table. One hour of grace covers an instance whose clock is behind and is still reporting into
   * a window this one considers finished.
   */
  sweep(): number {
    const cutoff = new Date(this.now() - 3_600_000).toISOString();
    const rows = this.db
      .query<{ subscription_id: string; environment: string; scope_kind: string; scope_id: string; period_sec: number; window_start: string }, [string]>(
        `SELECT subscription_id, environment, scope_kind, scope_id, period_sec, window_start
           FROM usage_counter WHERE updated_at < ?`,
      )
      .all(cutoff);

    const at = this.now();
    let removed = 0;
    for (const row of rows) {
      const end = Date.parse(row.window_start) + row.period_sec * 1000;
      if (end + 3_600_000 > at) continue;
      this.db.run(
        `DELETE FROM usage_counter
          WHERE subscription_id = ? AND environment = ? AND scope_kind = ? AND scope_id = ?
            AND period_sec = ? AND window_start = ?`,
        [row.subscription_id, row.environment, row.scope_kind, row.scope_id, row.period_sec, row.window_start],
      );
      removed++;
    }
    return removed;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch (err) {
        // A failed flush loses that interval's counts, which is the RPO this design already
        // accepts. It must not stop the timer, or the loss would be unbounded instead.
        console.error("[cp] quota flush failed", err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats(): { pending: number; droppedDeltas: number } {
    return { pending: this.pending.size, droppedDeltas: this.droppedDeltas };
  }
}

function isScope(value: unknown): value is QuotaScope {
  return value === "route" || value === "product" || value === "operation";
}

function isLive(key: { windowStart: string; periodSec: number }, atMs: number): boolean {
  const start = Date.parse(key.windowStart);
  if (Number.isNaN(start)) return false;
  return start + key.periodSec * 1000 > atMs;
}

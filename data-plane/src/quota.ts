import {
  quotaKeyString,
  windowStart,
  MAX_QUOTA_ENTRIES,
  type QuotaAggregate,
  type QuotaDelta,
  type QuotaKey,
  type QuotaScope,
} from "../../shared/quota.ts";

/**
 * Quota on the instance (design section 5.7).
 *
 * Each instance counts locally per `(subscription, scope, window)`. On each config poll it reports
 * its delta and receives the fleet aggregate back, and enforcement is
 * `aggregate_at_last_poll + own_delta_since >= calls`. Worst-case overshoot before convergence is
 * the fleet's traffic in one poll interval.
 *
 * Failure behaviour is deliberately permissive:
 *
 *  - **A restart loses the unreported delta**, which under-counts. Losing a restart's worth of
 *    counts beats double-counting a consumer into a 403.
 *  - **A lost report is never retried**, for the same reason: a retried delta would double-count.
 *  - **A control-plane outage keeps enforcing** against the frozen aggregate and drifts permissive.
 */

interface Counter {
  /** Counted here since the last accepted report. */
  delta: number;
  /** The fleet's count as of the last poll — everything every instance had contributed by then. */
  aggregate: number;
  key: QuotaKey;
  touchedAtMs: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetSec: number;
}

export class QuotaCounters {
  private readonly counters = new Map<string, Counter>();
  /** Deltas handed to a poll and not yet acknowledged. Dropped on failure, never retried. */
  private inFlight = new Map<string, number>();

  constructor(
    private readonly maxKeys = MAX_QUOTA_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  private counter(key: QuotaKey): Counter {
    const id = quotaKeyString(key);
    let counter = this.counters.get(id);
    if (!counter) {
      // Bounded: a fleet with more live windows than this drops the oldest rather than growing.
      if (this.counters.size >= this.maxKeys) this.evictOldest();
      counter = { delta: 0, aggregate: 0, key, touchedAtMs: this.now() };
      this.counters.set(id, counter);
    }
    counter.touchedAtMs = this.now();
    return counter;
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, counter] of this.counters) {
      if (counter.touchedAtMs < oldestAt) {
        oldestAt = counter.touchedAtMs;
        oldestId = id;
      }
    }
    if (oldestId) this.counters.delete(oldestId);
  }

  keyFor(
    subscriptionId: string,
    scopeKind: QuotaScope,
    scopeId: string,
    periodSec: number,
  ): QuotaKey {
    return {
      subscriptionId,
      scopeKind,
      scopeId,
      periodSec,
      windowStart: windowStart(periodSec, this.now()),
    };
  }

  /** Reads without counting — what a preflight or a usage endpoint needs. */
  peek(key: QuotaKey, calls: number): QuotaVerdict {
    const counter = this.counters.get(quotaKeyString(key));
    const used = (counter?.aggregate ?? 0) + (counter?.delta ?? 0);
    return this.verdict(key, calls, used, used < calls);
  }

  /**
   * Counts one call and answers whether it is allowed.
   *
   * A rejected call is **not** counted. It consumed no allowance, and counting it would mean a
   * client retrying against a 403 kept digging: the window would never come back even after the
   * fleet stopped making real calls.
   */
  check(key: QuotaKey, calls: number): QuotaVerdict {
    const counter = this.counter(key);
    const used = counter.aggregate + counter.delta;
    if (used >= calls) return this.verdict(key, calls, used, false);
    counter.delta++;
    return this.verdict(key, calls, used + 1, true);
  }

  private verdict(key: QuotaKey, calls: number, used: number, allowed: boolean): QuotaVerdict {
    const period = key.periodSec * 1000;
    const start = Date.parse(key.windowStart);
    return {
      allowed,
      limit: calls,
      used,
      remaining: Math.max(0, calls - used),
      resetSec: Math.max(0, Math.ceil((start + period - this.now()) / 1000)),
    };
  }

  /** The deltas to send on this poll. Moves them aside so double reporting is impossible. */
  takeDeltas(): QuotaDelta[] {
    const deltas: QuotaDelta[] = [];
    this.inFlight = new Map();
    for (const [id, counter] of this.counters) {
      if (counter.delta === 0) continue;
      deltas.push({ ...counter.key, count: counter.delta });
      this.inFlight.set(id, counter.delta);
      counter.delta = 0;
    }
    return deltas.slice(0, MAX_QUOTA_ENTRIES);
  }

  /**
   * The control plane accepted the report and answered with the fleet's counts. The aggregate
   * replaces what we knew; our own in-flight delta is now inside it, so it is discarded rather
   * than added back.
   */
  applyAggregates(aggregates: QuotaAggregate[]): void {
    for (const aggregate of aggregates) {
      const id = quotaKeyString(aggregate);
      const counter = this.counters.get(id) ?? this.counter(aggregate);
      counter.aggregate = aggregate.count;
    }
    this.inFlight = new Map();
  }

  /**
   * The poll failed. The delta we handed over is lost — deliberately: retrying it would
   * double-count a consumer into a 403, and under-counting is the failure this design chooses.
   */
  dropInFlight(): void {
    this.inFlight = new Map();
  }

  /** Windows that closed long ago cannot receive traffic, so they are not worth remembering. */
  sweep(): void {
    const now = this.now();
    for (const [id, counter] of this.counters) {
      const end = Date.parse(counter.key.windowStart) + counter.key.periodSec * 1000;
      if (end < now - 60_000) this.counters.delete(id);
    }
  }

  get size(): number {
    return this.counters.size;
  }
}

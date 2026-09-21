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

  /**
   * The deltas to send on this poll, zeroed as they are taken so double reporting is impossible.
   *
   * Zeroing *is* the whole mechanism, and it is also why the report is not retried on a failed
   * poll: the delta is gone the moment it is handed over, which under-counts by one poll rather
   * than risking a consumer double-counted into a 403.
   *
   * The cap is applied before the counters are zeroed, not after. Taken the other way round, a
   * delta past the cap would be zeroed here and dropped from the returned slice — counted by
   * nobody. `counter()` already bounds the map at `maxKeys`, so with the default this cannot bite;
   * it is written this way so that a smaller `maxKeys` defers counts instead of destroying them.
   */
  takeDeltas(): QuotaDelta[] {
    const deltas: QuotaDelta[] = [];
    for (const counter of this.counters.values()) {
      if (counter.delta === 0) continue;
      if (deltas.length >= MAX_QUOTA_ENTRIES) break;
      deltas.push({ ...counter.key, count: counter.delta });
      counter.delta = 0;
    }
    return deltas;
  }

  /**
   * The control plane accepted the report and answered with the fleet's counts. The aggregate
   * replaces what we knew; the delta we reported is already inside it, and was zeroed when it was
   * taken, so nothing is added back.
   */
  applyAggregates(aggregates: QuotaAggregate[]): void {
    for (const aggregate of aggregates) {
      const id = quotaKeyString(aggregate);
      const counter = this.counters.get(id) ?? this.counter(aggregate);
      counter.aggregate = aggregate.count;
    }
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

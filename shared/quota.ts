/**
 * Quota (design section 5.7) — fleet-wide, aggregated on the poll that already exists.
 *
 * A per-instance monthly quota is not a quota: 100,000 calls × 6 instances is 600,000. So each
 * instance counts locally, reports its delta on the config poll and receives the fleet aggregate
 * back, and enforcement is `aggregate_at_last_poll + own_delta_since >= calls`. Worst-case
 * overshoot before convergence is the fleet's traffic in one poll interval. No shared datastore,
 * no protocol, one arithmetic sum on the control plane.
 *
 * Rate limiting is the other half and shares none of this: it is per instance, in memory,
 * uncoordinated, and needs nothing from the control plane at all.
 */

/**
 * Fixed windows aligned to `periodSec` from the UNIX epoch, not rolling — so "when does my quota
 * reset" is answerable without explaining a sliding window.
 */
export function windowStart(periodSec: number, atMs: number = Date.now()): string {
  const period = Math.max(1, Math.floor(periodSec)) * 1000;
  return new Date(Math.floor(atMs / period) * period).toISOString();
}

export function windowResetSec(periodSec: number, atMs: number = Date.now()): number {
  const period = Math.max(1, Math.floor(periodSec)) * 1000;
  const start = Math.floor(atMs / period) * period;
  return Math.ceil((start + period - atMs) / 1000);
}

export type QuotaScope = "route" | "product" | "operation";

export interface QuotaKey {
  subscriptionId: string;
  scopeKind: QuotaScope;
  scopeId: string;
  periodSec: number;
  windowStart: string;
}

export function quotaKeyString(key: QuotaKey): string {
  return `${key.subscriptionId}|${key.scopeKind}|${key.scopeId}|${key.periodSec}|${key.windowStart}`;
}

/** What an instance reports upward on the poll. */
export interface QuotaDelta extends QuotaKey {
  count: number;
}

/** What the control plane sends back: the fleet's count as of this poll. */
export interface QuotaAggregate extends QuotaKey {
  count: number;
}

/** Bounds the poll payload in both directions, so a large fleet cannot inflate one round trip. */
export const MAX_QUOTA_ENTRIES = 2000;

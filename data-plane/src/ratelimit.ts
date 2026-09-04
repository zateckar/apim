/**
 * Design section 5.7: per instance, no coordination, nothing persisted, nothing reported.
 * Its job is to stop abuse and runaway clients, not to meter — so an instance enforces correctly
 * on its first request after boot, and the fleet ceiling is `calls x instances`, which the UI
 * states rather than hides.
 *
 * Fixed windows aligned to `periodSec` from the UTC epoch, so "when does my limit reset" is
 * answerable without explaining a sliding window.
 */
export interface RateVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Window end, epoch seconds. */
  reset: number;
  retryAfter: number;
}

interface Window {
  start: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** Every request that reaches this step counts; the `calls + 1`-th in a window is rejected. */
  check(key: string, calls: number, periodSec: number, nowMs = Date.now()): RateVerdict {
    const periodMs = periodSec * 1000;
    const start = Math.floor(nowMs / periodMs) * periodMs;
    const existing = this.windows.get(key);
    const window = existing && existing.start === start ? existing : { start, count: 0 };
    window.count += 1;
    this.windows.set(key, window);

    const end = start + periodMs;
    return {
      allowed: window.count <= calls,
      limit: calls,
      remaining: Math.max(0, calls - window.count),
      reset: Math.floor(end / 1000),
      retryAfter: Math.max(1, Math.ceil((end - nowMs) / 1000)),
    };
  }

  /** Windows are per (subscription, route), so the map is bounded but not self-clearing. */
  sweep(nowMs = Date.now(), maxAgeMs = 3_600_000): void {
    for (const [key, window] of this.windows) {
      if (nowMs - window.start > maxAgeMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

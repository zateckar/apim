/**
 * The backend pool (goal G7): several backends per API, a load-balancing rule, and a circuit
 * breaker per instance per backend.
 *
 * Design section 5.3 puts backends in `binding`, per environment, never in policy — an owner names
 * a pool and a rule, and the URLs pass the egress allowlist at write time. What lives here is the
 * shape both planes agree on and the selection rules, so "which backend does this request go to"
 * has one answer written once.
 */
import type { BackendEntry } from "./config-doc.ts";

export const MAX_POOL_SIZE = 8;
export const MAX_WEIGHT = 10;

export interface BackendPool {
  pool: BackendEntry[];
  rule: "round-robin" | "failover";
  clientCertRef?: string;
}

/**
 * Reads a `binding.backend_json` of either shape. v2 wrote `{"urls":[…]}`; v3 writes a pool. The
 * migration is at read time rather than in SQL, so an unreleased environment does not need a data
 * migration to keep serving, and the first v3 write stores the new shape.
 */
export function readBackendPool(raw: unknown): BackendPool {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (Array.isArray(value.pool)) {
    const pool = value.pool
      .map((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const url = typeof e.url === "string" ? e.url : "";
        const weight = typeof e.weight === "number" ? e.weight : undefined;
        return url ? { url, ...(weight === undefined ? {} : { weight }) } : null;
      })
      .filter((e): e is BackendEntry => e !== null);
    return {
      pool,
      rule: value.rule === "round-robin" ? "round-robin" : "failover",
      ...(typeof value.clientCertRef === "string" ? { clientCertRef: value.clientCertRef } : {}),
    };
  }
  const urls = Array.isArray(value.urls) ? value.urls.filter((u): u is string => typeof u === "string") : [];
  // A v2 binding is a pool of one — or, where somebody wrote several, an ordered failover list,
  // which is the reading that changes no behaviour for the first entry.
  return { pool: urls.map((url) => ({ url })), rule: "failover" };
}

/**
 * The order this request tries backends in. `failover` is the pool as written, first healthy wins
 * — "primary first" is that rule with the primary first in the list. `round-robin` rotates a
 * per-instance cursor, weighted by expanding an entry into the rotation `weight` times.
 *
 * Unhealthy backends are moved to the back rather than removed, so a pool whose every member is
 * open still has an order to report and one to probe with.
 */
export function selectionOrder(
  pool: BackendEntry[],
  rule: "round-robin" | "failover",
  cursor: number,
  isHealthy: (url: string) => boolean,
): BackendEntry[] {
  const expanded: BackendEntry[] = [];
  for (const entry of pool) {
    const weight = rule === "round-robin" ? Math.min(Math.max(entry.weight ?? 1, 1), MAX_WEIGHT) : 1;
    for (let i = 0; i < weight; i++) expanded.push(entry);
  }
  if (expanded.length === 0) return [];

  const ordered =
    rule === "failover"
      ? expanded
      : expanded.slice(cursor % expanded.length).concat(expanded.slice(0, cursor % expanded.length));

  // Distinct URLs, healthy first, order otherwise preserved.
  const seen = new Set<string>();
  const healthy: BackendEntry[] = [];
  const unhealthy: BackendEntry[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    (isHealthy(entry.url) ? healthy : unhealthy).push(entry);
  }
  return [...healthy, ...unhealthy];
}

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerSettings {
  failures: number;
  windowSec: number;
  openSec: number;
  halfOpenProbes: number;
}

interface BreakerEntry {
  failures: number[];
  state: BreakerState;
  openedAtMs: number;
  probesInFlight: number;
}

/**
 * Per instance, per `(resource, backend)` — never fleet-wide, so one instance's connectivity fault
 * cannot trip the fleet (design section 8.5).
 *
 * A "failure" is a connection error, a timeout, or a 5xx the route's `retries.on` names. A 4xx is
 * never a failure: a backend rejecting bad requests is working.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  private entry(key: string): BreakerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: [], state: "closed", openedAtMs: 0, probesInFlight: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** `closed` and `half-open` both count as healthy for selection. */
  state(key: string, settings: BreakerSettings | null): BreakerState {
    if (!settings) return "closed";
    const entry = this.entries.get(key);
    if (!entry) return "closed";
    if (entry.state === "open" && this.now() - entry.openedAtMs >= settings.openSec * 1000) {
      entry.state = "half-open";
      entry.probesInFlight = 0;
    }
    return entry.state;
  }

  /** Whether a request may be sent, and (for half-open) reserves one of the probe slots. */
  tryAcquire(key: string, settings: BreakerSettings | null): boolean {
    if (!settings) return true;
    const state = this.state(key, settings);
    if (state === "open") return false;
    if (state === "half-open") {
      const entry = this.entry(key);
      if (entry.probesInFlight >= settings.halfOpenProbes) return false;
      entry.probesInFlight++;
    }
    return true;
  }

  onSuccess(key: string, settings: BreakerSettings | null): void {
    if (!settings) return;
    const entry = this.entry(key);
    entry.probesInFlight = Math.max(0, entry.probesInFlight - 1);
    entry.failures = [];
    entry.state = "closed";
  }

  onFailure(key: string, settings: BreakerSettings | null): void {
    if (!settings) return;
    const entry = this.entry(key);
    entry.probesInFlight = Math.max(0, entry.probesInFlight - 1);
    const now = this.now();
    if (entry.state === "half-open") {
      entry.state = "open";
      entry.openedAtMs = now;
      entry.failures = [];
      return;
    }
    const cutoff = now - settings.windowSec * 1000;
    entry.failures = entry.failures.filter((at) => at > cutoff);
    entry.failures.push(now);
    if (entry.failures.length >= settings.failures) {
      entry.state = "open";
      entry.openedAtMs = now;
      entry.failures = [];
    }
  }

  /** Milliseconds until an open breaker may be probed — what `Retry-After` is derived from. */
  reopensInMs(key: string, settings: BreakerSettings | null): number {
    if (!settings) return 0;
    const entry = this.entries.get(key);
    if (!entry || entry.state !== "open") return 0;
    return Math.max(0, settings.openSec * 1000 - (this.now() - entry.openedAtMs));
  }

  snapshot(): Array<{ key: string; state: BreakerState }> {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.state !== "closed")
      .map(([key, entry]) => ({ key, state: entry.state }));
  }

  /** Bounded: entries for backends nobody has called in a while are dropped. */
  sweep(): void {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      if (entry.state === "closed" && entry.failures.length === 0) this.entries.delete(key);
    }
  }
}

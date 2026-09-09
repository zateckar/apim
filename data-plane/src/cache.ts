import type { CacheUnit } from "../../shared/policy.ts";

/**
 * The response cache of design section 5: per instance, in memory, bounded, default off.
 *
 * Two decisions are load-bearing:
 *
 *  - **Keyed under the active config digest**, so activating a new config empties it by
 *    construction. There is no invalidation logic, which is the same trick design section 8.7 uses
 *    for artifacts: a name that changes meaning needs invalidating, a name that does not, does not.
 *  - **`varyBySubscription` defaults to off but is linted loudly**, because caching without it
 *    serves one consumer's response to another. Right for public reference data, wrong otherwise —
 *    and it is a judgement the control plane cannot make, so it warns rather than decides.
 */

export interface CachedResponse {
  status: number;
  headers: Array<[string, string]>;
  /** Always a buffer this process allocated: `Response` refuses a shared-memory view. */
  body: Uint8Array<ArrayBuffer>;
  storedAtMs: number;
  expiresAtMs: number;
}

export interface CacheKeyInput {
  configDigest: string;
  routeId: string;
  method: string;
  /** The inbound path and query, before any rewrite: the rewrite is a pure function of it. */
  pathAndQuery: string;
  subscriptionId: string | null;
  vary: string[];
  headers: Headers;
  unit: CacheUnit;
}

export function cacheKeyFor(input: CacheKeyInput): string {
  const parts = [
    input.configDigest,
    input.routeId,
    input.method.toUpperCase(),
    input.pathAndQuery,
  ];
  if (input.unit.varyBySubscription) parts.push(`sub=${input.subscriptionId ?? "-"}`);
  for (const name of input.vary) parts.push(`${name.toLowerCase()}=${input.headers.get(name) ?? ""}`);
  return parts.join("|");
}

export class ResponseCache {
  private readonly entries = new Map<string, CachedResponse>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(
    private maxEntries: number,
    private maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Both bounds are the fleet's decision and change when a document is activated. Lowering one
   * evicts here rather than waiting for the next `set`: the bytes are the reason somebody lowered
   * it, so holding them until the next cacheable response would be the wrong half of the change.
   */
  resize(maxEntries: number, maxBytes: number): void {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  get(key: string): CachedResponse | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.drop(key);
      this.misses++;
      return null;
    }
    // Re-insertion makes the Map's own insertion order an LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: CachedResponse): void {
    const existing = this.entries.get(key);
    if (existing) this.bytes -= existing.body.byteLength;
    this.entries.set(key, entry);
    this.bytes += entry.body.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.body.byteLength;
    this.entries.delete(key);
  }

  /** A config swap empties the cache: keys carry the digest, so nothing old can ever be hit. */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { entries: number; bytes: number; hits: number; misses: number } {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  }
}

/** `Cache-Control` for the client, from the unit's `downstream` shaping. */
export function downstreamCacheControl(unit: CacheUnit): string | null {
  if (unit.downstream === "none" || unit.downstream === undefined) return null;
  const parts = [unit.downstream, `max-age=${unit.ttlSec}`];
  if (unit.mustRevalidate) parts.push("must-revalidate");
  return parts.join(", ");
}

/** Only safe, cacheable methods; anything else is a miss that is never stored. */
export function isCacheable(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

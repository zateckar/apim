import { badRequest } from "./router.ts";
import { checkEgress, type Integrations } from "./egress.ts";
import { MAX_POOL_SIZE, MAX_WEIGHT } from "../../shared/backend.ts";
import type { BackendEntry } from "../../shared/config-doc.ts";

export interface PoolInput {
  /** The shape that can carry weights. */
  pool?: unknown;
  /** An ordered `failover` pool, which is what a single-backend binding already means. */
  urls?: unknown;
  rule?: unknown;
}
export interface ReadPool {
  pool: BackendEntry[];
  rule: "failover" | "round-robin";
}

/**
 * One reader for the two write paths that set a backend pool — `PUT /api/resources/:id/binding` and
 * the native `configure`/`promote` commands. They validated the same thing separately once, which
 * is how a pool set through one and a pool set through the other came to mean slightly different
 * things; a caller should not be able to reach a state through one door that the other refuses.
 *
 * Every URL passes the egress allowlist at write time (design section 5.3), because a pool is
 * exactly as safe as its least-checked member.
 */
export async function readPool(
  body: PoolInput,
  integrations: Integrations,
): Promise<ReadPool | null> {
  const pool: BackendEntry[] = [];
  if (Array.isArray(body.pool)) {
    for (const [index, raw] of body.pool.entries()) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (typeof entry.url !== "string" || entry.url.length === 0)
        throw badRequest(`pool[${index}].url: expected a backend URL`);
      if (entry.weight !== undefined) {
        const weight = Number(entry.weight);
        if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT)
          throw badRequest(
            `pool[${index}].weight: expected an integer from 1 to ${MAX_WEIGHT}`,
          );
      }
      pool.push({
        url: entry.url,
        ...(entry.weight === undefined ? {} : { weight: Number(entry.weight) }),
      });
    }
  } else if (Array.isArray(body.urls)) {
    for (const url of body.urls) pool.push({ url: String(url) });
  } else if (body.rule === undefined) return null;

  if (pool.length === 0) throw badRequest("expected a non-empty `pool` or `urls` array");
  if (pool.length > MAX_POOL_SIZE)
    throw badRequest(
      `a pool may hold at most ${MAX_POOL_SIZE} backends. Past that, the breaker's per-backend ` +
        "state and the retry budget stop being reasonable to reason about; put a load balancer behind one URL",
    );
  const seen = new Set<string>();
  for (const entry of pool) {
    if (seen.has(entry.url))
      throw badRequest(`${entry.url} appears twice; use \`weight\` instead`);
    seen.add(entry.url);
    const errors = await checkEgress(entry.url, integrations, "pool");
    if (errors.length > 0) throw badRequest(errors.join("; "));
  }

  // `failover` is the default because it is what a single-backend binding already means, so an
  // unchanged caller gets unchanged behaviour.
  const rule = body.rule === undefined ? "failover" : String(body.rule);
  if (rule !== "failover" && rule !== "round-robin")
    throw badRequest('rule: expected "failover" (primary first) or "round-robin"');
  if (rule === "failover" && pool.some((entry) => entry.weight !== undefined))
    throw badRequest(
      "weights only mean something under round-robin: failover tries the pool in the order it is " +
        "written, so a weight would be silently ignored",
    );
  return { pool, rule };
}

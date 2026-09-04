import { hashToken, mintInstanceToken } from "./crypto.ts";
import { newId, nowIso } from "./db.ts";
import { DEV_TEAMS, ensureDevDirectory } from "./principals.ts";
import type { App } from "./router.ts";

/** The dev provider's two teams. They live with the directory; this is the name history used. */
export const SEED_TEAMS = DEV_TEAMS;

/** The fleet the demo and the load harness expect: two in DEV, one each in TEST and PROD. */
export const SEED_FLEET: Array<{ environment: string; name: string; port: number }> = [
  { environment: "dev", name: "dev-1", port: 8081 },
  { environment: "dev", name: "dev-2", port: 8082 },
  { environment: "test", name: "test-1", port: 8083 },
  { environment: "prod", name: "prod-1", port: 8084 },
];

export interface SeededInstance {
  id: string;
  name: string;
  environment: string;
  port: number;
  token: string;
}

/**
 * The fleet's tokens, because a token hash cannot be reversed into the token the data plane needs.
 *
 * Who the people are is no longer this function's business: since v5 the directory owns that, and
 * `createApp` has already called `ensureDevDirectory` by the time this runs. It is called again
 * here — it is idempotent, and a no-op unless the `dev` provider is enabled — so that
 * `scripts/seed.ts` still leaves a working development world in one command.
 */
export function seedBaseline(
  app: App,
  fleet: Array<{ environment: string; name: string; port: number }> = SEED_FLEET,
): { instances: SeededInstance[]; token: string } {
  const { db } = app;
  ensureDevDirectory(app);

  const instances: SeededInstance[] = [];
  for (const entry of fleet) {
    if (!app.config.promotionChain.includes(entry.environment)) continue;
    const target = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM target WHERE environment = ? AND adapter = 'standalone'",
      )
      .get(entry.environment);
    if (!target) throw new Error(`no standalone target for ${entry.environment} (check TARGETS_FILE)`);

    const token = mintInstanceToken();
    const existing = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM gateway_instance WHERE target_id = ? AND name = ?",
      )
      .get(target.id, entry.name);
    let id: string;
    if (existing) {
      id = existing.id;
      db.run("UPDATE gateway_instance SET token_hash = ?, revoked_at = NULL WHERE id = ?", [
        hashToken(token),
        id,
      ]);
    } else {
      id = newId("gwi");
      db.run(
        `INSERT INTO gateway_instance (id, target_id, name, token_hash, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'seed')`,
        [id, target.id, entry.name, hashToken(token), nowIso()],
      );
    }
    instances.push({ id, name: entry.name, environment: entry.environment, port: entry.port, token });
  }

  // Convenience for tests and single-gateway use: the first instance's token.
  return { instances, token: instances[0]?.token ?? "" };
}

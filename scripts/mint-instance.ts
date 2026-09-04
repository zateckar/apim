/**
 * Mint one gateway instance token, for a deployment with no browser.
 *
 *   bun run scripts/mint-instance.ts <environment> <name>
 *
 * The same mint the Gateways screen performs: capped per target, audited, and shown exactly once
 * because only the hash is stored. It talks to the database directly rather than to the API,
 * because the caller is standing in the container and has no session — and because inventing an
 * enrolment secret so that a gateway could enrol itself would be a second credential to protect,
 * with no owner and no revocation story.
 *
 * The token goes to **stdout, alone**. Everything else goes to stderr, so
 *
 *   docker compose run --rm control-plane bun run scripts/mint-instance.ts dev dev-1 > .secrets/dev-1
 *
 * writes a file containing the token and nothing else.
 */
import { writeAudit } from "../control-plane/src/audit.ts";
import { loadConfig } from "../control-plane/src/config.ts";
import { hashToken, mintInstanceToken } from "../control-plane/src/crypto.ts";
import { newId, nowIso } from "../control-plane/src/db.ts";
import { createApp } from "../control-plane/src/server.ts";

const [environment, name] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!environment || !name) {
  fail(
    "usage: bun run scripts/mint-instance.ts <environment> <name>\n" +
      "  environment  one of PROMOTION_CHAIN — the stage this gateway serves\n" +
      "  name         lower-case letters, digits and hyphens, unique within the environment",
  );
}
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
  fail(`name "${name}": expected lower-case letters, digits and hyphens, e.g. "dev-2"`);
}

// `AUTH_PROVIDERS` is required by `loadConfig` and is irrelevant here — this script authenticates
// nobody. Supplied rather than demanded of the operator, so minting a token does not force a
// decision about how humans sign in.
const config = loadConfig({ authProviders: ["local"] });
if (!config.promotionChain.includes(environment)) {
  fail(
    `unknown environment "${environment}" (PROMOTION_CHAIN is ${config.promotionChain.join(",")})`,
  );
}

const app = createApp(config);
try {
  const target = app.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM target WHERE environment = ? AND adapter = 'standalone'",
    )
    .get(environment);
  if (!target) fail(`no standalone target for ${environment} — check TARGETS_FILE`);

  const live = app.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM gateway_instance WHERE target_id = ? AND revoked_at IS NULL",
    )
    .get(target!.id)!.n;
  if (live >= config.maxInstancesPerTarget) {
    fail(
      `${environment} already has ${live} live instances (MAX_INSTANCES_PER_TARGET is ` +
        `${config.maxInstancesPerTarget}); revoke one first`,
    );
  }
  const clash = app.db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM gateway_instance WHERE target_id = ? AND name = ? AND revoked_at IS NULL",
    )
    .get(target!.id, name!);
  if (clash) {
    fail(
      `an instance named "${name}" already exists in ${environment}. Revoke it from the Gateways ` +
        "screen first, or pick another name — two gateways with one name make the fleet view a lie.",
    );
  }

  const token = mintInstanceToken();
  const id = newId("gwi");
  app.db.run(
    `INSERT INTO gateway_instance (id, target_id, name, token_hash, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'mint-instance')`,
    [id, target!.id, name!, hashToken(token), nowIso()],
  );
  writeAudit(app.db, {
    actor: "mint-instance",
    action: "instance.mint",
    subject: `instance:${id}`,
    outcome: "ok",
    detail: { environment, name, by: "scripts/mint-instance.ts" },
  });

  console.error(
    `[mint] ${name} (${environment}) — id ${id}. Only the hash is stored, so this token cannot be ` +
      "recovered. Put it where the gateway's GATEWAY_TOKEN_FILE points, 0600.",
  );
  console.log(token);
} finally {
  app.db.close();
}

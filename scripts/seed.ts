/**
 * Seeds the control plane and writes:
 *   .env.local          shared settings, loaded automatically by Bun from the repository root
 *   .data/env/<name>    one file per gateway, each with its own token and port
 *
 * A token never reaches argv (review V1-12), so `stack.ps1` starts each gateway with
 * `bun --env-file=.data/env/<name>`. Re-runnable: it mints fresh tokens each time.
 *
 * Since v6 the gateways' ceilings are seeded into the *database* as fleet settings rather than
 * into those files, because that is where they live now.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../control-plane/src/config.ts";
import { DEV_USERS } from "../control-plane/src/principals.ts";
import { seedBaseline, SEED_APPLICATIONS } from "../control-plane/src/seed.ts";
import { createApp } from "../control-plane/src/server.ts";
import { writeSettingOverrides } from "../control-plane/src/settings.ts";

const config = loadConfig({ authProviders: ["dev"] });
const app = createApp(config);
const { instances } = seedBaseline(app);

const shared = [
  "# written by scripts/seed.ts - Bun loads this automatically from the repository root",
  "# The local stack signs in through the development bypass: three named users, no passwords.",
  "# A deployment sets AUTH_PROVIDERS=oidc or local,oidc instead - see README.md.",
  "AUTH_PROVIDERS=dev",
  "PORT=8080",
  "PUBLIC_URL=http://localhost:8080",
  "DB_PATH=.data/apim.sqlite",
  "KEK_PATH=.data/kek.key",
  `PROMOTION_CHAIN=${config.promotionChain.join(",")}`,
  "TARGETS_FILE=config/targets.json",
  "INTEGRATIONS_FILE=config/integrations.json",
  "UI_DIST=ui/dist",
  "UI_DEV_ORIGIN=http://localhost:5173",
  "INSTANCE_STALE_AFTER_SEC=30",
  "MAX_SPEC_BYTES=5242880",
  "TELEMETRY_FLUSH_INTERVAL_SEC=5",
  "TELEMETRY_RETENTION_HOURS=48",
  "",
  "# shared data-plane settings; per-gateway token and port live in .data/env/<name>",
  "GATEWAY_CP_URL=http://localhost:8080",
  "POLL_INTERVAL_SEC=2",
  "TRUSTED_PROXY_CIDRS=",
  "# The runtime's own outbound queue, which must not bind before the gateway's ceilings do.",
  "# Left at its default, one slow backend delays every other route (reports/capacity-report.md).",
  "# It stays here rather than becoming a fleet setting because the runtime reads it at startup:",
  "# nothing the control plane sends can change it. It must be at least the maxConcurrentRequests",
  "# setting seeded into the database below.",
  "BUN_CONFIG_MAX_HTTP_REQUESTS=16384",
  "",
  "# The ceilings, the caches and the counters are the control plane's since v6, and are seeded",
  "# into the database rather than written here - one place for the whole fleet, changeable from",
  "# the portal without restarting anything. Setting one of them here is a startup failure that",
  "# names it and says where it went.",
  "",
  "# upstreams the demo publishes: REST/SOAP/SSE/WebSocket, an MCP server, an A2A agent",
  "BACKEND_PORT=9080",
  "BACKEND_SEED=1",
  "MCP_PORT=9085",
  "A2A_PORT=9086",
  "",
].join("\n");
writeFileSync(".env.local", shared);

/**
 * The fleet's settings, seeded once so a local stack behaves the way the env files used to make it
 * behave: a 48 MiB body cap and an 8192-request ceiling, both well above the code defaults and both
 * chosen in `reports/capacity-report.md`.
 *
 * Fleet scope, so every gateway in every environment inherits them and the Settings screen shows
 * one row per value rather than four identical ones. Overriding one for a single environment or a
 * single gateway is what the other two layers are for.
 */
writeSettingOverrides(
  app.db,
  {
    scope: "fleet",
    scopeId: "",
    values: {
      // Per gateway, not per route: raising it for one large-upload API raises it for every API
      // that gateway serves.
      maxBodyBytes: 50 * 1024 * 1024,
      // At least (peak rps x the worst backend latency you intend to absorb rather than shed).
      // 2000 rps against a backend degraded to 4 s is 8000 requests held at once.
      maxConcurrentRequests: 8192,
      // What blocking validation may hold at once: past it a request is shed with 503 rather than
      // let through unvalidated. It bounds `maxBodyBytes x concurrent blocking requests`, which
      // with the numbers above would otherwise be far more memory than a process has.
      blockingBufferBudgetBytes: 256 * 1024 * 1024,
      // Warning-mode validation: concurrency, and the queue in front of it. Past the queue a
      // sample is dropped and counted — it is an observation, and a backlog of observations is not
      // worth a request's latency.
      validatePoolSize: 4,
      validateQueueDepth: 256,
      // Streams held per gateway, on top of each route's own `maxConcurrentConnections`. A stream
      // holds a client socket and an upstream socket for its whole life, so this counts against
      // `nofile` too.
      maxConcurrentUpgrades: 1024,
    },
  },
  "seed",
  app.config.promotionChain,
);

mkdirSync(".data/env", { recursive: true });
for (const instance of instances) {
  writeFileSync(
    `.data/env/${instance.name}`,
    [
      `# gateway ${instance.name} (${instance.environment}) - written by scripts/seed.ts`,
      `DP_NAME=${instance.name}`,
      `DP_PORT=${instance.port}`,
      "GATEWAY_CP_URL=http://localhost:8080",
      `GATEWAY_TOKEN=${instance.token}`,
      `GATEWAY_CONFIG_CACHE=.data/dp-${instance.name}-config.json`,
      // Per gateway, and it must be: two processes sharing one artifact cache directory would race
      // on the same file names, and the key material beside it is written 0600 (deviation D22).
      `GATEWAY_ARTIFACT_CACHE=.data/dp-${instance.name}-artifacts`,
      "POLL_INTERVAL_SEC=2",
      "TRUSTED_PROXY_CIDRS=",
      // At least the fleet's maxConcurrentRequests setting, seeded below. Read by the runtime at
      // startup, so it cannot travel in the configuration document with the setting it pairs with.
      "BUN_CONFIG_MAX_HTTP_REQUESTS=16384",
      "",
    ].join("\n"),
  );
}

console.log(
  `seeded ${SEED_APPLICATIONS.length} applications, ${DEV_USERS.length} dev users, ` +
    `${config.promotionChain.length} environments (${config.promotionChain.join(" -> ")})`,
);
console.log("");
console.log("gateway            environment  port  env file");
for (const instance of instances) {
  console.log(
    `${instance.name.padEnd(18)} ${instance.environment.padEnd(12)} ${String(instance.port).padEnd(5)} .data/env/${instance.name}`,
  );
}
console.log("");
console.log("next:  pwsh -File scripts/stack.ps1 -Up     (4 upstreams + control plane + 4 gateways)");
console.log("       pwsh -File scripts/demo.ps1          (the walkthrough)");
app.db.close();

/**
 * Seeds the control plane and writes:
 *   .env.local          shared settings, loaded automatically by Bun from the repository root
 *   .data/env/<name>    one file per gateway, each with its own token and port
 *
 * A token never reaches argv (review V1-12), so `stack.ps1` starts each gateway with
 * `bun --env-file=.data/env/<name>`. Re-runnable: it mints fresh tokens each time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../control-plane/src/config.ts";
import { DEV_USERS } from "../control-plane/src/principals.ts";
import { seedBaseline, SEED_TEAMS } from "../control-plane/src/seed.ts";
import { createApp } from "../control-plane/src/server.ts";

const config = loadConfig({ authProviders: ["dev"] });
const app = createApp(config);
const { instances } = seedBaseline(app);

const shared = [
  "# written by scripts/seed.ts - Bun loads this automatically from the repository root",
  "# The local stack signs in through the development bypass: three named users, no passwords.",
  "# A deployment sets AUTH_PROVIDERS=oidc or local,oidc instead - see docs/deployment.md.",
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
  "# Sized for the largest request body any route must accept. This is per instance, not per",
  "# route: raising it for one large-upload API raises it for every API on the gateway.",
  "MAX_BODY_BYTES=50331648",
  "TRUSTED_PROXY_CIDRS=",
  "# At least (peak rps x the worst backend latency you intend to absorb rather than shed).",
  "# 2000 rps against a backend degraded to 4 s is 8000 requests held at once.",
  "MAX_CONCURRENT_REQUESTS=8192",
  "# The runtime's own outbound queue, which must not bind before the gateway's ceilings do.",
  "# Left at its default, one slow backend delays every other route (docs/capacity-report.md).",
  "BUN_CONFIG_MAX_HTTP_REQUESTS=16384",
  "",
  "# v3 - validation and streaming. The memory blocking validation may hold at once: past it a",
  "# request is shed with 503 rather than let through unvalidated. The real quantity it bounds is",
  "# always.maxBodyBytes x concurrent blocking requests, which with the defaults would be far more.",
  "BLOCKING_BUFFER_BUDGET_BYTES=268435456",
  "# Warning-mode validation: concurrency and queue depth. Past the queue, work is dropped and",
  "# counted - it is an observation, and a backlog of observations is not worth a request's latency.",
  "VALIDATE_POOL_SIZE=4",
  "VALIDATE_QUEUE_DEPTH=256",
  "# Streams held per instance, on top of each route's own maxConcurrentConnections. A stream holds",
  "# a client socket and an upstream socket for its whole life, so this counts against nofile too.",
  "MAX_CONCURRENT_UPGRADES=1024",
  "",
  "# upstreams the demo publishes: REST/SOAP/SSE/WebSocket, an MCP server, an A2A agent",
  "BACKEND_PORT=9080",
  "BACKEND_SEED=1",
  "MCP_PORT=9085",
  "A2A_PORT=9086",
  "",
].join("\n");
writeFileSync(".env.local", shared);

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
      "MAX_BODY_BYTES=50331648",
      "TRUSTED_PROXY_CIDRS=",
      "MAX_CONCURRENT_REQUESTS=8192",
      "BUN_CONFIG_MAX_HTTP_REQUESTS=16384",
      "BLOCKING_BUFFER_BUDGET_BYTES=268435456",
      "VALIDATE_POOL_SIZE=4",
      "VALIDATE_QUEUE_DEPTH=256",
      "MAX_CONCURRENT_UPGRADES=1024",
      "",
    ].join("\n"),
  );
}

console.log(
  `seeded ${SEED_TEAMS.length} teams, ${DEV_USERS.length} dev users, ` +
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

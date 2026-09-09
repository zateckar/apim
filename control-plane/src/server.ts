import { registerKafkaRoutes } from "./kafka.ts";
import { registerOperationRoutes } from "./operations.ts";
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import {
  assertAuthConfig,
  assertGatewayUrlsAllowed,
  assertIssuerAllowed,
  assertLogsUrlAllowed,
  loadConfig,
  type CpConfig,
  type TargetDef,
} from "./config.ts";
import { ensureBootstrapAdmin } from "./auth-local.ts";
import { loadOrCreateKek } from "./crypto.ts";
import { newId, openDb } from "./db.ts";
import { startJobRunner } from "./jobs.ts";
import { ensureDevDirectory } from "./principals.ts";
import { QuotaService } from "./quota.ts";
import { dispatch, Router, type App } from "./router.ts";
import { TelemetryAggregator } from "./telemetry.ts";
import { registerAdminRoutes } from "./api/admin.ts";
import { registerAuthRoutes } from "./api/auth.ts";
import { registerCatalogRoutes } from "./api/catalog.ts";
import { registerDashboardRoutes } from "./api/dashboard.ts";
import { registerFleetRoutes } from "./api/fleet.ts";
import { registerGatewayRoutes } from "./api/gateway.ts";
import { registerHealthRoutes, uptimeMonitorFor } from "./api/health.ts";
import { registerLogRoutes } from "./api/logs.ts";
import { registerMarketRoutes } from "./api/market.ts";
import { registerPlaygroundRoutes } from "./api/playground.ts";
import { registerPolicyRoutes } from "./api/policy.ts";
import { registerPromotionRoutes } from "./api/promotion.ts";
import { registerResourceRoutes } from "./api/resources.ts";
import { registerSettingsRoutes } from "./api/settings.ts";
import { registerTelemetryRoutes } from "./api/telemetry.ts";
import { registerTrustRoutes } from "./api/trust.ts";
import { registerUserRoutes } from "./api/users.ts";

import { ensureApplicationMetadata, registerIntegrationRoutes } from "./integrations.ts";
import { registerNotificationRoutes } from "./notifications.ts";

export function createRouter(): Router {
  const router = new Router();
  registerGatewayRoutes(router);
  registerAuthRoutes(router);
  registerAdminRoutes(router);
  registerUserRoutes(router);
  registerFleetRoutes(router);
  registerSettingsRoutes(router);
  registerTelemetryRoutes(router);
  registerResourceRoutes(router);
  registerPromotionRoutes(router);
  registerCatalogRoutes(router);
  registerMarketRoutes(router);
  registerPolicyRoutes(router);
  registerPlaygroundRoutes(router);
  registerDashboardRoutes(router);
  registerLogRoutes(router);
  registerHealthRoutes(router);
  registerTrustRoutes(router);
  registerIntegrationRoutes(router);
  registerNotificationRoutes(router);
  registerOperationRoutes(router);
  registerKafkaRoutes(router);
  return router;
}

export function createApp(config: CpConfig): App {
  const db = openDb(config.dbPath);
  const kek = loadOrCreateKek(config.kekPath);
  const telemetry = new TelemetryAggregator(db, config.maxRunsPerInstanceWindow);
  const quota = new QuotaService(db, config.maxQuotaEntries);
  const app: App = { db, config, kek, telemetry, quota };
  syncTargets(app);
  // The directory has to exist before anything can sign in, and both of these are idempotent and
  // no-ops unless their provider is enabled — so `AUTH_PROVIDERS=dev` on an empty database is
  // self-sufficient, and a `local` deployment comes up with exactly one account.
  ensureDevDirectory(app);
  // Business metadata is quoted from LeanIX, so every application it has not been asked about gets
  // one queued lookup. Idempotent, and the outbox owns the retry.
  ensureApplicationMetadata(app);
  return app;
}

/**
 * TARGETS_FILE is the source of truth for which targets exist (design section 11).
 *
 * Keyed on (environment, name) since v8, because an environment may hold several gateways and the
 * adapter no longer tells them apart. The name defaults to the adapter, so a file written before
 * gateways had names still matches the rows it created.
 *
 * The addresses, the label and the category are the exception, and deliberately: they are what an
 * administrator sets on the Gateways screen, and a file that reasserted them at every boot would
 * undo that without saying so. They are seeded on insert and left alone afterwards.
 */
function syncTargets(app: App): void {
  for (const target of app.config.targets) {
    const name = target.name ?? target.adapter;
    const existing =
      app.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM target WHERE environment = ? AND name = ?",
        )
        .get(target.environment, name) ?? adopt(app, target, name);
    if (existing) {
      app.db.run("UPDATE target SET enforce = ?, paused = ?, config_json = ? WHERE id = ?", [
        target.enforce ? 1 : 0,
        target.paused ? 1 : 0,
        JSON.stringify(target.config ?? {}),
        existing.id,
      ]);
    } else {
      app.db.run(
        `INSERT INTO target (id, environment, name, category, adapter, config_json, enforce, paused,
                             public_url, intranet_url, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          // Random rather than derived from the name: a gateway can be renamed, and an id that
          // spelled its old name would collide with the row that later takes it.
          newId("tgt"),
          target.environment,
          name,
          target.category ?? "other",
          target.adapter,
          JSON.stringify(target.config ?? {}),
          target.enforce ? 1 : 0,
          target.paused ? 1 : 0,
          target.publicUrl ?? null,
          target.intranetUrl ?? null,
          target.label ?? null,
        ],
      );
    }
  }
}

/**
 * The gateway this file entry named before gateways had names.
 *
 * schema-008 had to give every existing target a name and could not read TARGETS_FILE, so it
 * used the label where there was one and the adapter otherwise. An installation whose target row
 * predates `label` therefore comes out called `standalone` while the file now says `local` — and
 * without this, the very next boot would create a *second* gateway beside the one holding every
 * replica and every route, and an administrator would find their estate apparently split in half.
 *
 * So: exactly one gateway in the environment, still carrying the migration's fallback name, and
 * no file entry has claimed it — then this entry is what created it, and it is renamed rather
 * than duplicated. Addresses and labels are filled in only where the row has none, because a
 * `NULL` there means "nobody has ever set this" and an upgrade is the one moment a seed can still
 * land without overwriting a decision.
 */
function adopt(app: App, target: TargetDef, name: string): { id: string } | null {
  const rows = app.db
    .query<{ id: string; name: string; adapter: string }, [string]>(
      "SELECT id, name, adapter FROM target WHERE environment = ?",
    )
    .all(target.environment);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.name !== row.adapter || row.adapter !== target.adapter) return null;
  // Two file entries for one environment must not both adopt the same row.
  if (app.config.targets.filter((t) => t.environment === target.environment).length !== 1) {
    return null;
  }
  app.db.run(
    `UPDATE target
        SET name = ?,
            category     = CASE WHEN category = 'other' THEN ? ELSE category END,
            public_url   = COALESCE(public_url, ?),
            intranet_url = COALESCE(intranet_url, ?),
            label        = COALESCE(label, ?)
      WHERE id = ?`,
    [
      name,
      target.category ?? "other",
      target.publicUrl ?? null,
      target.intranetUrl ?? null,
      target.label ?? null,
      row.id,
    ],
  );
  console.log(
    `[cp] adopted the ${target.environment} gateway as "${name}" (it was named after its adapter)`,
  );
  return { id: row.id };
}

/**
 * Anything not here is served from `uiDist`, which answers `index.html` for an unknown path so the
 * SPA can route it. `/auth` has to be on this list `[P2-04]`: without it `/auth/login` returns the
 * SPA with a 200 and the sign-in button appears to do nothing at all.
 */
const API_PREFIXES = ["/api", "/auth", "/healthz", "/readyz"];

function serveStatic(pathname: string, uiDist: string): Response {
  const root = resolve(uiDist);
  const requested = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (requested !== root && !requested.startsWith(root + sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (existsSync(requested) && statSync(requested).isFile()) {
    return new Response(Bun.file(requested));
  }
  const index = join(root, "index.html");
  if (existsSync(index)) return new Response(Bun.file(index));
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Integration Portal</title>
     <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
     <h1>UI is not built</h1>
     <p>The control-plane API is running. Build the SPA with:</p>
     <pre style="background:#f4f4f5;padding:1rem;border-radius:.5rem">bun run build:ui</pre>
     <p>Or run it in dev mode with <code>bun run dev:ui</code> (http://localhost:5173).</p>
     </body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function startServer(app: App, router = createRouter()) {
  const server = Bun.serve({
    port: app.config.port,
    idleTimeout: 60,
    /**
     * The same reason as the gateway's (`data-plane/src/server.ts`): the runtime's development
     * mode answers an uncaught error with the source around each frame and the file paths. Every
     * `/api/**` failure is already shaped by `dispatch`, but the static branch below is outside it,
     * and this is the plane that holds the database.
     */
    development: false,
    fetch: (req) => {
      const url = new URL(req.url);
      if (API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
        return dispatch(app, router, req);
      }
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return serveStatic(url.pathname, app.config.uiDist);
    },
  });
  return server;
}

if (import.meta.main) {
  const config = loadConfig();
  assertAuthConfig(config);
  // The playground's targets and the identity provider are both admin configuration, so they are
  // checked against the egress allowlist here — once, loudly — rather than on the request path
  // (plan §11). Neither check touches the network: a control plane that would not start while
  // Keycloak restarts is an availability coupling nobody asked for `[P1-15]`.
  await assertGatewayUrlsAllowed(config);
  await assertIssuerAllowed(config);
  await assertLogsUrlAllowed(config);
  const app = createApp(config);
  await ensureBootstrapAdmin(app);
  const server = startServer(app);
  startJobRunner(app);
  app.telemetry.start(config.telemetryFlushIntervalSec * 1000);
  app.quota.start(config.usageFlushIntervalSec * 1000);
  // Started here rather than in `createApp`, because it makes outbound requests: a test world that
  // merely opens a database must not start probing gateway addresses on a timer.
  uptimeMonitorFor(app).start();
  console.log(
    `[cp] control plane on http://localhost:${server.port} — db ${config.dbPath}, ` +
      `environments ${config.promotionChain.join(",")}, UI from ${config.uiDist}, ` +
      `sign-in ${config.authProviders.join("+")}` +
      `${config.oidc ? ` (${config.oidc.issuer})` : ""}, ` +
      `telemetry flush ${config.telemetryFlushIntervalSec}s / retain ${config.telemetryRetentionHours}h, ` +
      `quota flush ${config.usageFlushIntervalSec}s (the quota RPO), ` +
      `logs from ${config.logs.provider === "elk" ? `${config.logs.url} index ${config.logs.index}` : "a simulated index"}`,
  );
  // Said once, for the same reason the sign-in bypass is: a screen full of plausible request logs
  // that nobody observed should not be something an operator has to infer from a chip in the UI.
  if (config.logs.provider === "mock") {
    console.warn(
      "[cp] request logs are SIMULATED: LOGS_PROVIDER=mock generates deterministic traffic from " +
        "the published estate. Nothing on the Logs screen is an observation. Set LOGS_PROVIDER=elk " +
        "with ELK_URL to read the real index.",
    );
  }
  // Said once, loudly, on purpose: an operator reading a log should not have to infer that this
  // process will hand out an administrator session to anybody who asks.
  if (config.authProviders.includes("dev")) {
    console.warn(
      "[cp] the DEVELOPMENT SIGN-IN BYPASS is enabled: anybody who can reach this control plane " +
        "can become any of its development users without a password. Never in a deployment that " +
        "holds anything real.",
    );
  }
}

import { runIntegrationEvents } from '../control-plane/src/integrations.ts';
import { runOperations } from '../control-plane/src/operations.ts';
import { buildConfig } from '../control-plane/src/config-build.ts';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataPlane, loadDpConfig, type DpConfigOverrides } from "../data-plane/src/server.ts";
import { CONFIG_VERSION, type GatewayConfig } from "../shared/config-doc.ts";
import { domainPrefix } from "../shared/domains.ts";
import type { GatewaySettings } from "../shared/gateway-settings.ts";
import { writeSettingOverrides } from "../control-plane/src/settings.ts";
import {
  TELEMETRY_DEFAULTS,
  type PollResponse,
  type TelemetryReport,
} from "../shared/telemetry.ts";
import { loadConfig } from "../control-plane/src/config.ts";
import { newId, nowIso } from "../control-plane/src/db.ts";
import { invalidateDenyRules } from "../control-plane/src/deny-rules.ts";
import { dispatch, type App, type Router } from "../control-plane/src/router.ts";
import { seedBaseline } from "../control-plane/src/seed.ts";
import { createApp, createRouter, startServer } from "../control-plane/src/server.ts";

export const ORIGIN = "http://localhost:8080";

export interface CallOptions {
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  origin?: string | null;
}

export interface TestCp {
  app: App;
  router: Router;
  token: string;
  instances: import("../control-plane/src/seed.ts").SeededInstance[];
  dir: string;
  call(method: string, path: string, options?: CallOptions): Promise<Response>;
  login(userId: string): Promise<string>;
  /**
   * Close every handle and open the same database and KEK again, the way a process restart does.
   * Sessions, queued operations and the outbox are on disk, so what survives this is exactly what
   * survives a deployment — and `app`, `call` and `login` all go on addressing the live process.
   */
  restart(): void;
  close(): void;
}

/** An in-process control plane on a temp SQLite file: every test gets a pristine world. */
export function makeCp(overrides: Record<string, unknown> = {}): TestCp {
  const dir = mkdtempSync(join(tmpdir(), "apim-test-"));
  const config = loadConfig({
    dbPath: join(dir, "db.sqlite"),
    kekPath: join(dir, "kek.key"),
    uiDist: join(dir, "ui"),
    publicUrl: ORIGIN,
    // The default test world signs in through the development bypass, which is what `login()`
    // below drives. A test that wants the local or OIDC provider overrides this.
    authProviders: ["dev"],
    port: 0,
    ...overrides,
  });
  // Reassigned by `restart()`, so everything below reads the *current* process rather than
  // capturing the first one — a test that restarts keeps calling `cp.call` and `cp.app`.
  let app = createApp(config);
  const { token, instances } = seedBaseline(app);
  const router = createRouter();

  const call = async (method: string, path: string, options: CallOptions = {}) => {
    const headers = new Headers(options.headers ?? {});
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.cookie) headers.set("cookie", options.cookie);
    if (options.origin !== null && !headers.has("origin")) {
      headers.set("origin", options.origin ?? ORIGIN);
    }
    return dispatch(
      app,
      router,
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
  };

  return {
    get app() {
      return app;
    },
    router,
    token,
    instances,
    dir,
    call,
    async login(userId: string) {
      const response = await call("POST", "/api/auth/dev-login", { body: { userId } });
      const cookie = response.headers.get("set-cookie");
      if (!cookie) throw new Error(`dev-login failed: ${response.status} ${await response.text()}`);
      return cookie.split(";")[0]!;
    },
    restart() {
      app.db.close();
      app = createApp(config);
    },
    close() {
      app.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The same control plane, reachable over HTTP, for tests where the data plane must really poll. */
export function serveCp(cp: TestCp) {
  const server = startServer(cp.app, cp.router);
  return { server, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

/** A backend that records what actually arrived, so header and path assertions are real. */
export function startBackend(
  handler?: (req: Request, recorded: RecordedRequest) => Response | Promise<Response>,
) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(req.headers),
        body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
      };
      requests.push(recorded);
      if (handler) return handler(req, recorded);
      return Response.json({ ok: true, saw: recorded.path + recorded.query });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    requests,
    stop: () => server.stop(true),
  };
}

export interface PollOptions {
  token?: string;
  activeDigest?: string | null;
  runId?: string;
  name?: string;
  telemetry?: TelemetryReport;
  requestsTotal?: number;
  /** An older gateway build, for the version-skew half of plan §10. Defaults to this build's. */
  wireVersion?: number;
  activationBlocked?: string | null;
}

/** The instance protocol as a test helper: one bidirectional round trip (deviation D11). */
export async function poll(cp: TestCp, options: PollOptions = {}) {
  const response = await cp.call("POST", "/api/gateway/poll", {
    headers: { authorization: `Bearer ${options.token ?? cp.token}` },
    body: {
      wireVersion: options.wireVersion ?? CONFIG_VERSION,
      instance: {
        name: options.name ?? "test-1",
        runId: options.runId ?? "run_test",
        startedAt: new Date().toISOString(),
        activeDigest: options.activeDigest ?? null,
        process: { rssBytes: 1, cpuUserMs: 1, cpuSystemMs: 1, uptimeSec: 1 },
        requestsTotal: options.requestsTotal ?? 0,
        ...(options.activationBlocked === undefined
          ? {}
          : { activationBlocked: options.activationBlocked }),
      },
      telemetry: options.telemetry ?? { droppedSeries: 0, droppedWindows: 0, windows: [] },
    },
  });
  const payload =
    response.status === 200 ? ((await response.json()) as PollResponse) : null;
  return { response, payload, config: (payload?.config ?? null) as GatewayConfig | null };
}

/** A data plane wired to a control plane over HTTP, with its own telemetry and cache file. */
export function makeDp(cpUrl: string, token: string, dir: string, overrides: DpConfigOverrides = {}) {
  return new DataPlane(
    loadDpConfig({
      port: 0,
      name: overrides.name ?? "test-1",
      cpUrl,
      token,
      cachePath: join(dir, `dp-${overrides.name ?? "test-1"}-config.json`),
      // Inside the per-test temp directory: the artifact cache is persistent by design, so a
      // shared path would carry one test's compiled schemas into the next one's assertions.
      artifactCachePath: join(dir, `dp-${overrides.name ?? "test-1"}-artifacts`),
      pollIntervalMs: 50,
      trustedProxyCidrs: [],
      quiet: true,
      ...overrides,
    }),
  );
}

/**
 * Set a gateway setting fleet-wide on a test control plane, the way the settings screen does.
 *
 * This rather than a `DpConfig` override, and the difference is the point: since v6 a ceiling is
 * the control plane's, so a test that starts a plane with one value and then polls a control plane
 * with another would be asserting against a configuration no deployment can produce. Call it
 * before the plane's first poll.
 */
export function setFleetSettings(cp: TestCp, values: Partial<GatewaySettings>): void {
  writeSettingOverrides(
    cp.app.db,
    { scope: "fleet", scopeId: "", values },
    "test",
    cp.app.config.promotionChain,
  );
}

/**
 * An administrator's egress deny rule, written straight into the table.
 *
 * The cache `liveDenyRules` keeps is per database and invalidated on write, so a test that inserts
 * a row has to say so — otherwise a rule added after the first binding write would not be seen, and
 * the test would pass for the wrong reason.
 */
export function denyRule(
  cp: TestCp,
  rule: {
    hostPattern: string;
    reason: string;
    environment?: string | null;
    scheme?: "http" | "https" | null;
    ports?: number[];
  },
): void {
  cp.app.db.run(
    `INSERT INTO egress_deny_rule
       (id, environment, scheme, host_pattern, ports_json, reason, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      newId("deny"),
      rule.environment ?? null,
      rule.scheme ?? null,
      rule.hostPattern,
      rule.ports ? JSON.stringify(rule.ports) : null,
      rule.reason,
      "test",
      nowIso(),
    ],
  );
  invalidateDenyRules(cp.app.db);
}

export interface PublishOptions {
  backendUrl: string;
  basePath?: string;
  host?: string;
  spec?: unknown;
  policy?: Record<string, unknown>;
  subscribe?: boolean;
  kind?: "rest" | "soap";
  apiVersion?: string;
  name?: string;
  domain?: string;
  subdomain?: string | null;
}

/** The taxonomy every fixture lands in unless it says otherwise. */
export const FIXTURE_DOMAIN = "IT";
export const FIXTURE_SUBDOMAIN = "Solution";

/**
 * Every published path starts with its domain, so a fixture that asks for `/orders` means
 * `/it/solution/orders`. Spelling the prefix out at 150 call sites would test the test suite's
 * ability to concatenate strings; a fixture that already carries the prefix is left alone.
 */
export function underDomain(basePath: string, domain: string, subdomain?: string | null): string {
  const prefix = domainPrefix(domain, subdomain);
  if (basePath === prefix || basePath.startsWith(`${prefix}/`)) return basePath;
  return `${prefix}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
}

export const MINI_SPEC = {
  swagger: "2.0",
  info: { title: "mini", version: "1.0.0" },
  host: "example.test",
  basePath: "/v2",
  schemes: ["https"],
  paths: {
    "/store/inventory": { get: { operationId: "getInventory", responses: { "200": { description: "ok" } } } },
    "/pet": {
      post: { operationId: "addPet", responses: { "200": { description: "ok" } } },
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
    },
    "/pet/{petId}": { get: { operationId: "getPet", responses: { "200": { description: "ok" } } } },
    /*
     * The throwaway paths the fixtures reach for when the test is about something other than
     * routing — a rate limit's second and third call, a header rule, a breaker. They have to be
     * *declared* now that the gateway refuses a path its contract does not name, and declaring
     * them is more honest than the wildcard that would hide which ones a test actually uses.
     */
    "/x": { get: { operationId: "getX", responses: { "200": { description: "ok" } } } },
    "/a": { get: { operationId: "getA", responses: { "200": { description: "ok" } } } },
    "/b": { get: { operationId: "getB", responses: { "200": { description: "ok" } } } },
    "/c": { get: { operationId: "getC", responses: { "200": { description: "ok" } } } },
  },
};

/** The G2 + G3 walkthrough, as a fixture: create, import, route, bind, policy, publish, subscribe. */
export async function publishApi(cp: TestCp, options: PublishOptions) {
  const pavel = await cp.login("pavel");
  const clara = await cp.login("clara");
  const name = options.name ?? `api-${Math.random().toString(36).slice(2, 8)}`;

  const domain = options.domain ?? FIXTURE_DOMAIN;
  const subdomain = options.subdomain === undefined ? FIXTURE_SUBDOMAIN : options.subdomain;

  const resource = await (
    await cp.call("POST", "/api/resources", {
      cookie: pavel,
      body: {
        kind: options.kind ?? "rest",
        name,
        applicationId: "application_platform",
        apiVersion: options.apiVersion ?? "v1",
        domain,
        subdomain,
      },
    })
  ).json();
  const resourceId = resource.id as string;
  const basePath = underDomain(options.basePath ?? `/${name}`, domain, subdomain);

  await cp.call("POST", `/api/resources/${resourceId}/revisions`, {
    cookie: pavel,
    body: { spec: options.spec ?? MINI_SPEC },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie: pavel,
    body: { environment: "dev", host: options.host ?? "*", basePath },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie: pavel,
    body: { environment: "dev", urls: [options.backendUrl] },
  });

  for (const [unitKey, value] of Object.entries(options.policy ?? {})) {
    // `undefined` means "do not attach this unit", so a caller can spread over a helper's default
    // and end up with the API carrying no such unit — which is a state worth being able to test,
    // and the one a hand-published API is in.
    if (value === undefined) continue;
    const response = await cp.call(
      "PUT",
      `/api/resources/${resourceId}/policy/units/${encodeURIComponent(unitKey)}`,
      { cookie: pavel, body: { value } },
    );
    if (!response.ok) throw new Error(`policy ${unitKey}: ${response.status} ${await response.text()}`);
  }

  const product = await (
    await cp.call("POST", "/api/products", {
      cookie: pavel,
      body: { name: `${name}-product`, applicationId: "application_platform", resourceIds: [resourceId] },
    })
  ).json();

  const release = await (
    await cp.call("POST", `/api/resources/${resourceId}/releases`, {
      cookie: pavel,
      body: { revision: 1, environment: "dev" },
    })
  ).json();

  let key: string | null = null;
  let subscriptionId: string | null = null;
  if (options.subscribe !== false) {
    const subscription = await activeSubscription(cp, clara, product.id);
    key = subscription.primaryKey;
    subscriptionId = subscription.id;
  }

  return {
    resourceId,
    name,
    basePath,
    domain,
    subdomain,
    productId: product.id as string,
    release,
    key,
    subscriptionId,
    pavel,
    clara,
  };
}

/**
 * Promote a revision one link along the chain, the way the UI does it: dry run, then confirm the
 * plan that was shown. Returns the plan and the release response.
 */
export async function promote(
  cp: TestCp,
  cookie: string,
  resourceId: string,
  environment: string,
  revision = 1,
) {
  const dry = await cp.call("POST", `/api/resources/${resourceId}/releases?dryRun=1`, {
    cookie,
    body: { revision, environment },
  });
  const plan = await dry.json();
  const confirm = await cp.call("POST", `/api/resources/${resourceId}/releases`, {
    cookie,
    body: { revision, environment, planId: plan.planId },
  });
  return { plan, status: confirm.status, release: await confirm.json() };
}

/** Route + binding for an environment, which promotion deliberately does not seed. */
export async function prepareEnvironment(
  cp: TestCp,
  cookie: string,
  resourceId: string,
  environment: string,
  basePath: string,
  backendUrl: string,
) {
  const row = cp.app.db
    .query<{ domain: string | null; subdomain: string | null }, [string]>(
      "SELECT domain, subdomain FROM resource WHERE id = ?",
    )
    .get(resourceId);
  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie,
    body: {
      environment,
      host: "*",
      basePath: row?.domain ? underDomain(basePath, row.domain, row.subdomain) : basePath,
    },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie,
    body: { environment, urls: [backendUrl] },
  });
}

/** Provision a consumer fixture through the real approval and gateway acknowledgment protocol. */
export async function activeSubscription(cp: TestCp, cookie: string, productId: string, applicationId = "application_orders", environment = "dev") {
 const response = await cp.call("POST", "/api/subscriptions", {cookie, body:{productId, applicationId, environment, purpose:"Integration test consumer"}});
 const sub = await response.json();
 if(response.status!==201) throw new Error(`subscribe fixture: ${JSON.stringify(sub)}`);
 runIntegrationEvents(cp.app);
 if(sub.state==="pending") {
  const event=cp.app.db.query<{id:string},[string]>("SELECT id FROM integration_event WHERE subject=? AND integration='skonet'").get(sub.id)!;
  const decision=await cp.call("POST",`/api/integration-events/${event.id}/decision`,{cookie:await cp.login("alice"),body:{decision:"approved"}});
  if(!decision.ok)throw new Error(await decision.text());
 }
 const digest=buildConfig(cp.app.db,cp.app.kek,environment,cp.app.config).digest;
 for(const instance of cp.instances.filter(i=>i.environment===environment)) {
  const ack=await cp.call("POST","/api/gateway/poll",{headers:{authorization:`Bearer ${instance.token}`},body:{wireVersion:CONFIG_VERSION,instance:{name:instance.name,runId:"fixture",startedAt:new Date().toISOString(),activeDigest:digest,requestsTotal:0,process:{}}}});
  if(!ack.ok)throw new Error(await ack.text());
 }
 runOperations(cp.app);
 const keys=await cp.call("POST",`/api/subscriptions/${sub.id}/reveal`,{cookie});
 if(!keys.ok)throw new Error(await keys.text());
 return {...sub,...await keys.json(),state:"active"};
}

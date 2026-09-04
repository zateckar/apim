import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataPlane, loadDpConfig, type DpConfig } from "../data-plane/src/server.ts";
import { CONFIG_VERSION, type GatewayConfig } from "../shared/config-doc.ts";
import {
  TELEMETRY_DEFAULTS,
  type PollResponse,
  type TelemetryReport,
} from "../shared/telemetry.ts";
import { loadConfig } from "../control-plane/src/config.ts";
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
  dir: string;
  call(method: string, path: string, options?: CallOptions): Promise<Response>;
  login(userId: string): Promise<string>;
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
  const app = createApp(config);
  const { token } = seedBaseline(app);
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
    app,
    router,
    token,
    dir,
    call,
    async login(userId: string) {
      const response = await call("POST", "/api/auth/dev-login", { body: { userId } });
      const cookie = response.headers.get("set-cookie");
      if (!cookie) throw new Error(`dev-login failed: ${response.status} ${await response.text()}`);
      return cookie.split(";")[0]!;
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
export function makeDp(cpUrl: string, token: string, dir: string, overrides: Partial<DpConfig> = {}) {
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
      maxBodyBytes: 8 * 1024 * 1024,
      trustedProxyCidrs: [],
      maxSeries: TELEMETRY_DEFAULTS.maxSeries,
      maxWindowsPerReport: TELEMETRY_DEFAULTS.maxWindowsPerReport,
      quiet: true,
      ...overrides,
    }),
  );
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
}

export const MINI_SPEC = {
  swagger: "2.0",
  info: { title: "mini", version: "1.0.0" },
  host: "example.test",
  basePath: "/v2",
  schemes: ["https"],
  paths: {
    "/store/inventory": { get: { operationId: "getInventory", responses: { "200": { description: "ok" } } } },
    "/pet": { post: { operationId: "addPet", responses: { "200": { description: "ok" } } } },
  },
};

/** The G2 + G3 walkthrough, as a fixture: create, import, route, bind, policy, publish, subscribe. */
export async function publishApi(cp: TestCp, options: PublishOptions) {
  const pavel = await cp.login("pavel");
  const clara = await cp.login("clara");
  const name = options.name ?? `api-${Math.random().toString(36).slice(2, 8)}`;

  const resource = await (
    await cp.call("POST", "/api/resources", {
      cookie: pavel,
      body: {
        kind: options.kind ?? "rest",
        name,
        teamId: "team_platform",
        apiVersion: options.apiVersion ?? "v1",
      },
    })
  ).json();
  const resourceId = resource.id as string;

  await cp.call("POST", `/api/resources/${resourceId}/revisions`, {
    cookie: pavel,
    body: { spec: options.spec ?? MINI_SPEC },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie: pavel,
    body: { environment: "dev", host: options.host ?? "*", basePath: options.basePath ?? `/${name}` },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie: pavel,
    body: { environment: "dev", urls: [options.backendUrl] },
  });

  for (const [unitKey, value] of Object.entries(options.policy ?? {})) {
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
      body: { name: `${name}-product`, teamId: "team_platform", resourceIds: [resourceId] },
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
    const application = await (
      await cp.call("POST", "/api/applications", {
        cookie: clara,
        body: { name: `${name}-app`, teamId: "team_orders" },
      })
    ).json();
    const subscription = await (
      await cp.call("POST", "/api/subscriptions", {
        cookie: clara,
        body: { productId: product.id, applicationId: application.id, environment: "dev" },
      })
    ).json();
    key = subscription.primaryKey;
    subscriptionId = subscription.id;
  }

  return { resourceId, name, productId: product.id as string, release, key, subscriptionId, pavel, clara };
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
  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie,
    body: { environment, host: "*", basePath },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie,
    body: { environment, urls: [backendUrl] },
  });
}

import { provisionHarnessSubscription } from '../harness-subscription.ts';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../control-plane/src/config.ts";
import { seedBaseline } from "../../control-plane/src/seed.ts";
import { createApp, createRouter } from "../../control-plane/src/server.ts";
import { dispatch, type App, type Router } from "../../control-plane/src/router.ts";

/**
 * The capacity world, and the one thing that separates it from `tools/loadgen`: **every piece is
 * its own operating-system process, and the gateway is pinned to a fixed set of cores.**
 *
 * The load harness in `tools/loadgen` runs the generator, the control plane, the backend and the
 * gateways inside one Bun process. That is the right shape for measuring a *difference* — both
 * sides of the subtraction suffer the same contention — and the wrong shape for measuring a
 * *limit*, because a limit is an absolute number and the four of them are fighting over one JS
 * thread. Nothing measured that way can answer "how much traffic will this take".
 *
 * So here: separate processes, an explicit CPU budget for the gateway, and everything else pushed
 * onto cores the gateway is not allowed to touch.
 */

/** A logical-CPU bitmask, Windows `ProcessorAffinity`. */
export interface CoreLayout {
  /** The cores under test. Their SMT siblings are deliberately left idle — see `describe`. */
  gateway: number;
  /** Load generator, control plane, backend: the cores the gateway may not use. */
  harness: number;
  gatewayCores: number[];
  harnessCores: number[];
  note: string;
}

function maskOf(cores: number[]): number {
  return cores.reduce((mask, core) => mask | (1 << core), 0);
}

/**
 * On this class of Intel part the logical CPUs enumerate as SMT pairs (0/1 are one physical core,
 * 2/3 the next) with the efficiency cores last. Giving the gateway four *even* CPUs hands it four
 * whole physical cores and leaves their siblings unused, so "4 CPUs" means four cores that nothing
 * else is on — the strict reading. Handing it 0,1,2,3 instead would be the cloud reading of
 * "4 vCPU": four hyperthreads on two physical cores, worth roughly 60% as much.
 */
export function coreLayout(totalCpus: number, budget: number): CoreLayout {
  const gatewayCores: number[] = [];
  for (let i = 0; gatewayCores.length < budget && i < totalCpus; i += 2) gatewayCores.push(i);
  const reserved = new Set([...gatewayCores, ...gatewayCores.map((c) => c + 1)]);
  const harnessCores: number[] = [];
  for (let i = 0; i < totalCpus; i++) if (!reserved.has(i)) harnessCores.push(i);
  return {
    gateway: maskOf(gatewayCores),
    harness: maskOf(harnessCores),
    gatewayCores,
    harnessCores,
    note:
      `gateway on CPUs ${gatewayCores.join(",")} (${budget} physical cores; their SMT siblings ` +
      `${gatewayCores.map((c) => c + 1).join(",")} left idle so the budget is exact), ` +
      `everything else on ${harnessCores.join(",")}`,
  };
}

/**
 * `Bun.spawn`, retried.
 *
 * A 30-minute run died at phase 5 with `ENOENT` on the Bun binary — a 88 MB executable that
 * exists, that had already been spawned dozens of times in the same run, and that was present
 * again a moment later. A virus scanner holding the file is the likeliest explanation. Whatever
 * the cause, losing half an hour of measurement to a transient open() is not acceptable, and a
 * retry is cheaper than being right about the cause.
 */
function spawnWithRetry(cmd: string[], options: Parameters<typeof Bun.spawn>[1]): Bun.Subprocess {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return Bun.spawn(cmd, options) as Bun.Subprocess;
    } catch (error) {
      last = error;
      Bun.sleepSync(200 * (attempt + 1));
    }
  }
  throw new Error(`could not start ${cmd[1] ?? cmd[0]} after 4 attempts: ${last}`);
}

/** Windows has no cgroups; `ProcessorAffinity` is the CPU budget. Verified, never assumed. */
export function pin(pid: number, mask: number): void {
  // Retried for the same reason spawning is: `pwsh` on this machine intermittently returns
  // nothing at all, and an empty answer here reads as affinity 0. The assertion stays — a run
  // whose CPU budget was not applied is not a run — but it should fire for a real failure and not
  // for a flaky shell.
  let applied = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = Bun.spawnSync([
      "pwsh",
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = ${mask}; ` +
        `(Get-Process -Id ${pid}).ProcessorAffinity.ToInt64()`,
    ]);
    applied = Number(result.stdout.toString().trim());
    if (applied === mask) return;
    Bun.sleepSync(250 * (attempt + 1));
  }
  throw new Error(
    `could not pin pid ${pid} to mask ${mask} after 3 attempts (last answer ${applied}): every ` +
      `number in this report depends on the CPU budget actually being applied`,
  );
}

export interface Piece {
  name: string;
  proc: Bun.Subprocess;
  url: string;
  pid: number;
}

export interface GatewayHandle {
  /** One per process. A client that cycles these is a load balancer, which is the fleet model. */
  urls: string[];
  pids: number[];
  procs: Bun.Subprocess[];
  /** True when the processes share a single port instead of having one each. */
  sharedPort: boolean;
}

export interface CapacityWorld {
  dir: string;
  layout: CoreLayout;
  backendUrl: string;
  cpUrl: string;
  cookie: string;
  gateway: GatewayHandle;
  apis: Map<string, { basePath: string; key: string | null; resourceId: string }>;
  /**
   * Restart the gateway as N processes. `separate` gives each its own instance, token and port —
   * the fleet the product already models, addressed by a client that cycles the URLs. `shared`
   * puts every process on one port via SO_REUSEPORT.
   */
  scaleGateway(
    processes: number,
    mode?: "separate" | "shared",
    settings?: GatewaySettings,
  ): Promise<GatewayHandle>;
  stop(): void;
}

/** Per-request side effects that are configuration rather than code, so their cost is measurable. */
export interface GatewaySettings {
  accessLog?: boolean;
  telemetry?: "on" | "off";
  /**
   * `BUN_CONFIG_MAX_HTTP_REQUESTS` — the runtime's own ceiling on concurrent outbound HTTP
   * requests, per process, across every origin. It exists whether or not anyone sets it, and if it
   * is lower than the work the gateway accepts it becomes an invisible shared queue: one slow
   * backend fills it and every other route waits behind it. Varying it is how the report
   * establishes that that is what is happening.
   */
  maxHttpRequests?: number;
  /** The instance-wide ceiling, per restart, so the isolation phase can vary it. */
  maxConcurrentRequests?: number;
}

const SPEC = {
  swagger: "2.0",
  info: { title: "petstore", version: "1.0.0" },
  host: "127.0.0.1",
  basePath: "/v2",
  schemes: ["http"],
  paths: {
    "/pet/{petId}": {
      get: {
        operationId: "getPetById",
        parameters: [{ name: "petId", in: "path", required: true, type: "integer" }],
        responses: { "200": { description: "ok" } },
      },
    },
    // A real body schema: the validation workloads need something to check, and a `post` with
    // nothing declared would measure the pipeline deciding there is nothing to do.
    "/pet": {
      post: {
        operationId: "addPet",
        parameters: [{ name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/store/inventory": { get: { operationId: "getInventory", responses: { "200": { description: "ok" } } } },
    "/echo": { get: { operationId: "echo", responses: { "200": { description: "ok" } } } },
  },
  definitions: {
    Pet: {
      type: "object",
      required: ["name", "photoUrls"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        status: { type: "string", enum: ["available", "pending", "sold"] },
        photoUrls: { type: "array", items: { type: "string" } },
        tags: {
          type: "array",
          items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
        },
      },
    },
  },
};

/** A body the schema above accepts, so the validation workloads measure success rather than a 400. */
export const VALID_PET = JSON.stringify({
  id: 7,
  name: "doggie",
  status: "available",
  photoUrls: ["https://example.test/1.png", "https://example.test/2.png"],
  tags: [
    { id: 1, name: "friendly" },
    { id: 2, name: "small" },
  ],
});

/** Instances (and ports) seeded up front, so the scaling phase never has to reseed. */
const MAX_GATEWAY_PROCESSES = 8;

const RATE_LIMIT = {
  calls: 1_000_000_000,
  periodSec: 3600,
  per: "instance",
  by: "subscription",
  scope: "route",
  emitHeaders: true,
};

/**
 * A few shapes, not eleven: this harness sweeps concurrency, so each API is measured at eight load
 * levels and the matrix multiplies. `tools/loadgen` is where per-policy cost is isolated — the
 * exception being validation, which design section 13 calls the dominant sizing variable and which
 * therefore belongs on a *capacity* chart rather than only in a latency delta.
 */
export const CAPACITY_APIS = [
  { name: "bare", policy: { rewrite: { stripBasePath: true } } },
  {
    name: "typical",
    subscribe: true,
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rateLimit: RATE_LIMIT,
      "headers.request": { set: { "X-Subscription-Name": "${subscription.name}" } },
      timeoutMs: 60_000,
    },
  },
  {
    name: "full",
    subscribe: true,
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rateLimit: RATE_LIMIT,
      preconditions: [
        {
          requireHeader: { name: "X-Request-Origin", equals: "loadgen" },
          deny: { status: 403, reason: "missing X-Request-Origin" },
        },
      ],
      "headers.request": {
        set: { "X-Subscription-Name": "${subscription.name}", "X-Env": "${environment}" },
        remove: ["X-Drop-Me"],
        append: { "X-Trace": "${request.id}" },
      },
      timeoutMs: 60_000,
    },
  },
  {
    name: "soap",
    kind: "soap" as const,
    policy: { rewrite: { stripBasePath: true }, timeoutMs: 60_000 },
  },
  // The three validation states on one contract and one body. `validate-off` is the floor, not
  // zero: the `always` block runs in every state.
  {
    name: "validate-off",
    policy: {
      rewrite: { stripBasePath: true },
      timeoutMs: 60_000,
      validate: {
        request: "disabled",
        response: "disabled",
        downgradeReason: "capacity harness: the floor the other two states are measured against",
      },
    },
  },
  {
    name: "validate-block",
    policy: {
      rewrite: { stripBasePath: true },
      timeoutMs: 60_000,
      validate: { request: "blocking", response: "disabled" },
    },
  },
  {
    name: "validate-warn",
    policy: {
      rewrite: { stripBasePath: true },
      timeoutMs: 60_000,
      validate: {
        request: "warning",
        response: "disabled",
        downgradeReason: "capacity harness: measuring what warning mode takes from the request path",
        // Sampled at 1.0, so this is the worst case for the state rather than the usual one.
        sample: { rate: 1 },
      },
    },
  },
];

async function call(
  app: App,
  router: Router,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  // The origin has to be the configured public URL, not a hard-coded localhost:8080: this world
  // runs on an ephemeral port and the section 9 CSRF check compares against PUBLIC_URL.
  const origin = app.config.publicUrl;
  const headers = new Headers({ origin });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await dispatch(
    app,
    router,
    new Request(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
}

async function waitFor(
  url: string,
  what: string,
  ready: (body: any) => boolean = (body) => body?.ok !== false,
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : null;
      if (response.ok && ready(body)) return body;
      last = `status ${response.status} ${JSON.stringify(body)?.slice(0, 200) ?? ""}`;
    } catch (error) {
      last = String(error);
    }
    await Bun.sleep(200);
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs}ms (${last})`);
}

/** Bind to 0, note what the kernel gave, release it: a port a child process can then take. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port ?? 0;
  server.stop(true);
  if (!port) throw new Error("could not obtain an ephemeral port");
  return port;
}

export interface WorldOptions {
  /** How many CPUs the gateway is allowed. The whole point of the exercise. */
  cpuBudget: number;
  totalCpus: number;
  telemetry?: "on" | "off";
  /**
   * Effectively off by default here. The instance-wide ceiling is a real protection, but a
   * capacity sweep exists to find where throughput stops rising, and a ceiling would put a floor
   * under that answer. The isolation phase sets it deliberately.
   */
  maxConcurrentRequests?: number;
  logDir?: string;
}

/**
 * Remove worlds a previous run left behind. `stop()` cleans up after itself, but a run that is
 * killed — or that dies on a full disk — never reaches it, and the leftovers are not small.
 */
function sweepStaleWorlds(): void {
  let reclaimed = 0;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("apim-capacity-")) continue;
    const path = join(tmpdir(), name);
    try {
      // Anything older than an hour cannot belong to a run that is still going.
      if (Date.now() - statSync(path).mtimeMs < 60 * 60 * 1000) continue;
      rmSync(path, { recursive: true, force: true });
      reclaimed++;
    } catch {
      // In use, or gone already. Neither is worth failing a run over.
    }
  }
  if (reclaimed > 0) console.log(`[capacity] removed ${reclaimed} abandoned world(s) from a previous run`);
}

export async function buildCapacityWorld(options: WorldOptions): Promise<CapacityWorld> {
  sweepStaleWorlds();
  const layout = coreLayout(options.totalCpus, options.cpuBudget);
  const dir = mkdtempSync(join(tmpdir(), "apim-capacity-"));
  const logDir = options.logDir ?? join(dir, "logs");
  mkdirSync(logDir, { recursive: true });

  const cpPort = await freePort();
  const backendPort = await freePort();
  const gatewayPorts: number[] = [];
  for (let i = 0; i < MAX_GATEWAY_PROCESSES; i++) gatewayPorts.push(await freePort());
  const gatewayPort = gatewayPorts[0]!;
  const cpUrl = `http://127.0.0.1:${cpPort}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  // --- seed in-process, then hand the database file to a real control-plane process ------------
  // Seeding over HTTP would be several hundred round trips of code that already exists here.
  const dbPath = join(dir, "capacity.sqlite");
  const config = loadConfig({
    dbPath,
    kekPath: join(dir, "kek.key"),
    uiDist: join(dir, "ui"),
    publicUrl: cpUrl,
    authProviders: ["dev"],
    port: cpPort,
    promotionChain: ["dev", "test", "prod"],
    telemetryFlushIntervalSec: 5,
  });
  const app = createApp(config);
  const { instances } = seedBaseline(
    app,
    gatewayPorts.map((port, index) => ({ environment: "dev", name: `gw-${index + 1}`, port })),
  );
  const router = createRouter();

  const pavelLogin = await call(app, router, "", "POST", "/api/auth/dev-login", { userId: "pavel" });
  const pavel = pavelLogin.headers.get("set-cookie")!.split(";")[0]!;
  const claraLogin = await call(app, router, "", "POST", "/api/auth/dev-login", { userId: "clara" });
  const clara = claraLogin.headers.get("set-cookie")!.split(";")[0]!;


  const wsdl = await Bun.file("tools/backend/petstore.wsdl").text();
  const apis = new Map<string, { basePath: string; key: string | null; resourceId: string }>();

  const publish = async (spec: {
    name: string;
    kind?: "rest" | "soap";
    policy: Record<string, unknown>;
    subscribe?: boolean;
  }): Promise<void> => {
    const basePath = `/${spec.name}`;
    const resource = await (
      await call(app, router, pavel, "POST", "/api/resources", {
        kind: spec.kind ?? "rest",
        name: spec.name,
        applicationId: "application_platform",
      })
    ).json();
    await call(app, router, pavel, "POST", `/api/resources/${resource.id}/revisions`, {
      spec: spec.kind === "soap" ? wsdl : SPEC,
    });
    await call(app, router, pavel, "PUT", `/api/resources/${resource.id}/routes`, {
      environment: "dev",
      host: "*",
      basePath,
    });
    await call(app, router, pavel, "PUT", `/api/resources/${resource.id}/binding`, {
      environment: "dev",
      urls: [spec.kind === "soap" ? `${backendUrl}/soap/petstore` : `${backendUrl}/v2`],
    });
    for (const [unit, value] of Object.entries(spec.policy)) {
      await call(
        app,
        router,
        pavel,
        "PUT",
        `/api/resources/${resource.id}/policy/units/${encodeURIComponent(unit)}`,
        { value },
      );
    }
    const product = await (
      await call(app, router, pavel, "POST", "/api/products", {
        name: `${spec.name}-product`,
        applicationId: "application_platform",
        resourceIds: [resource.id],
      })
    ).json();
    await call(app, router, pavel, "POST", `/api/resources/${resource.id}/releases`, {
      revision: 1,
      environment: "dev",
    });
    let key: string | null = null;
    if (spec.subscribe) {
      key = await provisionHarnessSubscription(app, router, clara, pavel, product.id, instances);
    }
    apis.set(spec.name, { basePath, key, resourceId: resource.id as string });
  };

  for (const spec of CAPACITY_APIS) await publish(spec);

  // Releases converge synchronously on the write path, so nothing is left queued; the control
  // plane process opens the same file next.
  app.telemetry.stop();
  app.db.close();

  // --- now the processes -----------------------------------------------------------------------
  const pieces: Piece[] = [];
  /**
   * stdout discarded, stderr kept.
   *
   * stdout is the gateway's access log — one JSON line per request — and at the rates this harness
   * drives that is gigabytes. A single sweep wrote about 4 GB, and the runs that were killed before
   * their cleanup ran left theirs behind: 18.6 GB of orphaned temp directories, and eventually a
   * full disk that failed a sweep at phase 5. It was also a confound, since every phase was paying
   * for disk writes that have nothing to do with what it measures.
   *
   * The consequence for the one phase that *does* measure logging: "access log on" is then the cost
   * of formatting a line and writing it to a discarded sink, which is a lower bound on what it
   * costs against a real log driver. Stated in the report rather than left implicit.
   */
  const open = (name: string) => ({
    stdout: "ignore" as const,
    stderr: Bun.file(join(logDir, `${name}.err.log`)),
  });

  const backendProc = spawnWithRetry(
    [process.execPath, "tools/backend/server.ts", `--port=${backendPort}`, "--seed=1"],
    { env: { ...process.env, NODE_ENV: "production" }, ...open("backend") },
  );
  pin(backendProc.pid, layout.harness);
  pieces.push({ name: "backend", proc: backendProc, url: backendUrl, pid: backendProc.pid });
  await waitFor(`${backendUrl}/healthz`, "the petstore backend");

  const cpEnv = {
    ...process.env,
    AUTH_PROVIDERS: "dev",
    PORT: String(cpPort),
    DB_PATH: dbPath,
    KEK_PATH: join(dir, "kek.key"),
    PUBLIC_URL: cpUrl,
    PROMOTION_CHAIN: "dev,test,prod",
    UI_DIST: join(dir, "ui"),
    TELEMETRY_FLUSH_INTERVAL_SEC: "5",
    TARGETS_FILE: "config/targets.json",
    INTEGRATIONS_FILE: "config/integrations.json",
  };
  const cpProc = spawnWithRetry([process.execPath, "control-plane/src/server.ts"], {
    env: cpEnv,
    ...open("control-plane"),
  });
  pin(cpProc.pid, layout.harness);
  pieces.push({ name: "control-plane", proc: cpProc, url: cpUrl, pid: cpProc.pid });
  await waitFor(`${cpUrl}/healthz`, "the control plane");

  let generation = 0;
  const startGateway = async (
    index: number,
    shared: boolean,
    settings: GatewaySettings = {},
  ): Promise<Bun.Subprocess> => {
    // In `shared` mode every process is the same instance on the same port; in `separate` mode
    // each is its own seeded instance with its own token and port, which is the fleet the control
    // plane already models.
    const instance = shared ? instances[0]! : instances[index]!;
    const port = shared ? gatewayPort : gatewayPorts[index]!;
    const instanceCeiling =
      settings.maxConcurrentRequests ?? options.maxConcurrentRequests ?? 100_000;
    const proc = spawnWithRetry([process.execPath, "data-plane/src/server.ts"], {
      env: {
        ...process.env,
        DP_NAME: instance.name,
        DP_PORT: String(port),
        GATEWAY_CP_URL: cpUrl,
        GATEWAY_TOKEN: instance.token,
        // One cache file per process: two processes sharing a path would interleave writes.
        GATEWAY_CONFIG_CACHE: join(dir, `dp-${generation}-${index}.json`),
        POLL_INTERVAL_SEC: "2",
        // Above the largest payload measured, so a size row reports what the gateway did with the
        // body rather than how fast it can write a 413.
        MAX_BODY_BYTES: String(64 * 1024 * 1024),
        TRUSTED_PROXY_CIDRS: "",
        DP_TELEMETRY: settings.telemetry ?? options.telemetry ?? "on",
        DP_ACCESS_LOG: settings.accessLog === false ? "off" : "on",
        DP_REUSE_PORT: shared ? "1" : "0",
        MAX_CONCURRENT_REQUESTS: String(instanceCeiling),
        // At least the instance ceiling, which is what the launcher requires: the gateway's own
        // per-route accounting has to bind before the runtime's shared queue does.
        BUN_CONFIG_MAX_HTTP_REQUESTS: String(settings.maxHttpRequests ?? instanceCeiling),
        NODE_ENV: "production",
      },
      ...open(`gateway-${generation}-${index}`),
    });
    pin(proc.pid, layout.gateway);
    return proc;
  };

  const first = await startGateway(0, false);
  // Not "is it listening" but "has it got its configuration": a gateway answers /healthz before
  // its first poll, and measuring it in that state would measure a cold start.
  await waitFor(`http://127.0.0.1:${gatewayPort}/healthz`, "the gateway", (body) => body?.routes > 0);
  const gateway: GatewayHandle = {
    urls: [`http://127.0.0.1:${gatewayPort}`],
    pids: [first.pid],
    procs: [first],
    sharedPort: false,
  };

  const login = await fetch(`${cpUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: cpUrl },
    body: JSON.stringify({ userId: "alice" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  writeFileSync(
    join(logDir, "world.json"),
    JSON.stringify({ dir, cpUrl, backendUrl, gatewayPorts, layout }, null, 2),
  );

  const world: CapacityWorld = {
    dir,
    layout,
    backendUrl,
    cpUrl,
    cookie,
    gateway,
    apis,
    async scaleGateway(
      processes: number,
      mode: "separate" | "shared" = "separate",
      settings: GatewaySettings = {},
    ): Promise<GatewayHandle> {
      if (processes > MAX_GATEWAY_PROCESSES) {
        throw new Error(`only ${MAX_GATEWAY_PROCESSES} gateway instances were seeded`);
      }
      for (const proc of gateway.procs.splice(0)) proc.kill();
      gateway.pids.length = 0;
      gateway.urls.length = 0;
      // Windows holds a listening socket briefly after the process dies; rebinding too soon is
      // an intermittent EADDRINUSE that would look like a capacity result.
      await Bun.sleep(1000);
      generation++;

      const shared = mode === "shared";
      for (let i = 0; i < processes; i++) {
        const proc = await startGateway(i, shared, settings);
        gateway.procs.push(proc);
        gateway.pids.push(proc.pid);
      }
      gateway.sharedPort = shared;
      gateway.urls.push(
        ...(shared
          ? [`http://127.0.0.1:${gatewayPort}`]
          : gatewayPorts.slice(0, processes).map((port) => `http://127.0.0.1:${port}`)),
      );
      // Every process must have its configuration before the first measured request. In shared
      // mode only one of them can be addressed, so the evidence is their cache files.
      for (const url of gateway.urls) {
        await waitFor(`${url}/healthz`, `gateway on ${url}`, (body) => body?.routes > 0);
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const written = await Promise.all(
          gateway.pids.map((_, i) => Bun.file(join(dir, `dp-${generation}-${i}.json`)).exists()),
        );
        if (written.every(Boolean)) break;
        await Bun.sleep(250);
      }
      return gateway;
    },
    stop() {
      for (const proc of gateway.procs) proc.kill();
      for (const piece of pieces) piece.proc.kill();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows holds the SQLite file briefly after the process exits; the temp directory is
        // not worth failing a completed run over.
      }
    },
  };
  return world;
}

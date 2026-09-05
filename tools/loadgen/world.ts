import { provisionHarnessSubscription } from '../harness-subscription.ts';
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thumbprintOf } from "../../control-plane/src/certificates.ts";
import { loadConfig, readIntegrations } from "../../control-plane/src/config.ts";
import { seedBaseline } from "../../control-plane/src/seed.ts";
import { createApp, createRouter, startServer } from "../../control-plane/src/server.ts";
import { dispatch, type App, type Router } from "../../control-plane/src/router.ts";
import { DataPlane, loadDpConfig, startDataPlane } from "../../data-plane/src/server.ts";
import { PetstoreBackend, startBackend } from "../backend/server.ts";
import { generateCertificate } from "../../test/x509.ts";
import { publishedPath } from "../../shared/domains.ts";

/**
 * The load harness builds its **own** world rather than measuring whatever happens to be running:
 * a temp database, ephemeral ports, a fixed seed. That is what makes two runs comparable, and it
 * means `bun run perf` never collides with a stack a developer has up (review V1-15).
 */
export interface PerfWorld {
  backendUrl: string;
  cpUrl: string;
  gateways: string[];
  /** The last gateway, started with counting off, so its cost can be measured not assumed. */
  gatewayWithoutTelemetry: string;
  app: App;
  dataPlanes: DataPlane[];
  apis: Map<string, { basePath: string; key: string | null }>;
  stop(): void;
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
    // A real body schema, because validation cost is a function of the schema and the body — a
    // `post` with nothing declared would measure the pipeline deciding there is nothing to check.
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

/** A body that satisfies the schema above, so the validation scenarios measure success, not a 400. */
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

const WSDL_PATH = "tools/backend/petstore.wsdl";

/** One API per policy shape, so each unit's cost is isolated against the same baseline. */
export interface ApiSpec {
  name: string;
  policy: Record<string, unknown>;
  kind?: "rest" | "soap";
  subscribe?: boolean;
  /**
   * Which backend to bind. `tls` is the HTTPS petstore whose certificate is signed by a CA this
   * environment has registered as a trust anchor — the G4 path (plan §8.3).
   */
  backend?: "http" | "tls";
  /**
   * An admin-created TLS exception on this route, so what one *costs* is published rather than
   * asserted. `pin` and `skip-hostname` install a custom `checkServerIdentity`, which is the
   * option that defeats Bun's connection pool: measured at 51 handshakes for 51 requests against
   * 1 for the anchor path (review `[P1-02]`).
   */
  tls?: { mode: "pin" | "skip-hostname" | "insecure" };
}

export const PERF_APIS: ApiSpec[] = [
  { name: "baseline", policy: { rewrite: { stripBasePath: true } } },
  {
    name: "auth",
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
    },
    subscribe: true,
  },
  {
    name: "precondition",
    policy: {
      rewrite: { stripBasePath: true },
      preconditions: [
        {
          requireHeader: { name: "X-Request-Origin", equals: "loadgen" },
          deny: { status: 403, reason: "missing X-Request-Origin" },
        },
      ],
    },
  },
  {
    name: "pattern",
    policy: {
      rewrite: { stripBasePath: true },
      preconditions: [
        {
          requireHeader: { name: "X-Request-Origin", pattern: "^load[a-z]{3}$" },
          deny: { status: 403, reason: "bad X-Request-Origin" },
        },
      ],
    },
  },
  {
    name: "ratelimit",
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rateLimit: {
        calls: 1_000_000,
        periodSec: 3600,
        per: "instance",
        by: "subscription",
        scope: "route",
        emitHeaders: true,
      },
    },
    subscribe: true,
  },
  {
    name: "ratelimit-tight",
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rateLimit: {
        calls: 2,
        periodSec: 3600,
        per: "instance",
        by: "subscription",
        scope: "route",
        emitHeaders: true,
      },
    },
    subscribe: true,
  },
  {
    name: "headers",
    policy: {
      rewrite: { stripBasePath: true },
      "headers.request": {
        set: { "X-Subscription-Name": "${subscription.name}", "X-Env": "${environment}" },
        remove: ["X-Drop-Me"],
        append: { "X-Trace": "${request.id}" },
      },
    },
  },
  {
    name: "all-policies",
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rateLimit: {
        calls: 1_000_000,
        periodSec: 3600,
        per: "instance",
        by: "subscription",
        scope: "route",
        emitHeaders: true,
      },
      preconditions: [
        {
          requireHeader: { name: "X-Request-Origin", equals: "loadgen" },
          deny: { status: 403, reason: "missing X-Request-Origin" },
        },
      ],
      "headers.request": { set: { "X-Subscription-Name": "${subscription.name}" } },
      timeoutMs: 60_000,
    },
    subscribe: true,
  },
  /*
   * The three validation states, on one contract and one body, so the difference between the rows
   * is the state and nothing else. `disabled` is the floor and is *not* free — the `always` block
   * (content type, size, depth, duplicate keys) is enforced in every state, which is the whole
   * point of it — so the honest reading is `blocking − disabled` for what schema checking costs,
   * and `warning − disabled` for what the sampled, asynchronous variant costs the request path
   * (deviation D19: it is not isolated from it).
   */
  {
    name: "validate-blocking",
    policy: {
      rewrite: { stripBasePath: true },
      validate: { request: "blocking", response: "disabled" },
    },
  },
  {
    name: "validate-warning",
    policy: {
      rewrite: { stripBasePath: true },
      validate: {
        request: "warning",
        response: "disabled",
        downgradeReason: "perf harness: measuring what warning mode costs the request path",
        // Every request sampled. A rate of 0.1 would measure the sampler, not the validator.
        sample: { rate: 1 },
      },
    },
  },
  {
    name: "validate-disabled",
    policy: {
      rewrite: { stripBasePath: true },
      validate: {
        request: "disabled",
        response: "disabled",
        downgradeReason: "perf harness: the floor the other two states are measured against",
      },
    },
  },
  {
    name: "slow",
    policy: { rewrite: { stripBasePath: true }, timeoutMs: 60_000 },
  },
  {
    name: "impatient",
    policy: { rewrite: { stripBasePath: true }, timeoutMs: 5_000 },
  },
  {
    name: "soap",
    kind: "soap",
    policy: { rewrite: { stripBasePath: true } },
  },
  /*
   * The two ways to reach a backend whose certificate a public store has never heard of. Same
   * backend, same policy, same body: the only difference between the rows is how TLS is settled,
   * which is what makes the pair worth publishing (plan §8.3).
   */
  {
    name: "trust-anchor",
    policy: { rewrite: { stripBasePath: true } },
    backend: "tls",
  },
  {
    name: "tls-exception-pin",
    policy: { rewrite: { stripBasePath: true } },
    backend: "tls",
    tls: { mode: "pin" },
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
  const headers = new Headers({ origin: "http://localhost:8080" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return dispatch(
    app,
    router,
    new Request(`http://localhost:8080${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function buildWorld(gatewayCount = 2): Promise<PerfWorld> {
  const dir = mkdtempSync(join(tmpdir(), "apim-perf-"));
  const backend = new PetstoreBackend({ port: 0, seed: 1 });
  const backendServer = startBackend(backend);
  const backendUrl = `http://127.0.0.1:${backendServer.port}`;

  // The G4 backend: HTTPS, with a certificate signed by a CA generated for this run. Nothing on
  // the machine trusts it, which is the situation a trust anchor exists to resolve.
  const backendCa = generateCertificate({ cn: "apim-perf-ca", ca: true });
  const backendLeaf = generateCertificate({
    cn: "petstore.internal",
    issuer: backendCa,
    dnsNames: ["localhost"],
    ipAddresses: ["127.0.0.1"],
  });
  const tlsBackend = new PetstoreBackend({
    port: 0,
    seed: 1,
    tls: { certPem: backendLeaf.certPem, keyPem: backendLeaf.keyPem },
  });
  const tlsBackendServer = startBackend(tlsBackend);
  const tlsBackendUrl = `https://127.0.0.1:${tlsBackendServer.port}`;

  // The shipped allowlist permits only http on loopback, and a run must not need the file edited.
  const integrations = readIntegrations(process.env.INTEGRATIONS_FILE ?? "config/integrations.json");
  integrations.egressAllowlist.push({
    scheme: "https",
    hostPattern: "127.0.0.1",
    portRange: [1024, 65535],
  });

  const config = loadConfig({
    dbPath: join(dir, "perf.sqlite"),
    kekPath: join(dir, "kek.key"),
    uiDist: join(dir, "ui"),
    publicUrl: "http://localhost:8080",
    authProviders: ["dev"],
    port: 0,
    // Explicit, not inherited: a run must not depend on whatever `.env.local` happens to say,
    // or two runs on two machines are not comparable.
    promotionChain: ["dev", "test", "prod"],
    // Flush often, so a run's telemetry is readable while it is still interesting.
    telemetryFlushIntervalSec: 2,
    integrations,
  });
  const app = createApp(config);
  const { instances } = seedBaseline(app, [
    { environment: "dev", name: "dev-1", port: 0 },
    { environment: "dev", name: "dev-2", port: 0 },
    // One more, run with DP_TELEMETRY=off, purely so the counting cost is measurable.
    { environment: "dev", name: "dev-quiet", port: 0 },
  ]);
  const router = createRouter();
  const cpServer = startServer(app, router);
  const cpUrl = `http://localhost:${cpServer.port}`;

  const pavelResponse = await call(app, router, "", "POST", "/api/auth/dev-login", { userId: "pavel" });
  const pavel = pavelResponse.headers.get("set-cookie")!.split(";")[0]!;
  const claraResponse = await call(app, router, "", "POST", "/api/auth/dev-login", { userId: "clara" });
  const clara = claraResponse.headers.get("set-cookie")!.split(";")[0]!;
  // The trust store and TLS exceptions are admin-only, so the harness needs an admin session.
  const aliceResponse = await call(app, router, "", "POST", "/api/auth/dev-login", { userId: "alice" });
  const alice = aliceResponse.headers.get("set-cookie")!.split(";")[0]!;

  const anchor = await call(app, router, alice, "POST", "/api/trust/anchors", {
    environment: "dev",
    name: "perf-backend-ca",
    pem: backendCa.certPem,
  });
  if (!anchor.ok) throw new Error(`registering the perf trust anchor failed: ${await anchor.text()}`);


  const wsdl = await Bun.file(WSDL_PATH).text();
  const apis = new Map<string, { basePath: string; key: string | null }>();

  for (const spec of PERF_APIS) {
    // The harness publishes through the same taxonomy every other API goes through, so the paths
    // it measures are the paths the estate actually serves.
    const basePath = publishedPath({ domain: "IT", subdomain: "Solution", name: spec.name });
    const resource = await (
      await call(app, router, pavel, "POST", "/api/resources", {
        kind: spec.kind ?? "rest",
        name: spec.name,
        applicationId: "application_platform",
        domain: "IT",
        subdomain: "Solution",
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
    const base = spec.backend === "tls" ? tlsBackendUrl : backendUrl;
    await call(app, router, pavel, "PUT", `/api/resources/${resource.id}/binding`, {
      environment: "dev",
      urls: [spec.kind === "soap" ? `${base}/soap/petstore` : `${base}/v2`],
    });
    if (spec.tls) {
      const exception = await call(app, router, alice, "POST", "/api/trust/exceptions", {
        resourceId: resource.id,
        environment: "dev",
        mode: spec.tls.mode,
        ...(spec.tls.mode === "pin"
          ? { pinThumbprint: thumbprintOf(new X509Certificate(backendLeaf.certPem)) }
          : {}),
        reason: "perf harness: measuring what a TLS exception costs against a registered anchor",
        days: 1,
      });
      if (!exception.ok) throw new Error(`${spec.name}: exception failed ${await exception.text()}`);
    }
    for (const [unit, value] of Object.entries(spec.policy)) {
      const response = await call(
        app,
        router,
        pavel,
        "PUT",
        `/api/resources/${resource.id}/policy/units/${encodeURIComponent(unit)}`,
        { value },
      );
      if (!response.ok) throw new Error(`${spec.name}/${unit}: ${await response.text()}`);
    }

    const product = await (
      await call(app, router, pavel, "POST", "/api/products", {
        name: `${spec.name}-product`,
        applicationId: "application_platform",
        resourceIds: [resource.id],
      })
    ).json();
    const release = await call(app, router, pavel, "POST", `/api/resources/${resource.id}/releases`, {
      revision: 1,
      environment: "dev",
    });
    if (!release.ok) throw new Error(`${spec.name}: release failed ${await release.text()}`);

    let key: string | null = null;
    if (spec.subscribe) {
      key = await provisionHarnessSubscription(app, router, clara, pavel, product.id, instances);
    }
    apis.set(spec.name, { basePath, key });
  }

  const dataPlanes: DataPlane[] = [];
  const gateways: string[] = [];
  const quiet = instances.find((instance) => instance.name === "dev-quiet")!;
  const counting = instances.filter((instance) => instance.name !== "dev-quiet");

  const start = async (
    instance: { name: string; token: string },
    telemetry: "on" | "off",
  ): Promise<string> => {
    const dp = new DataPlane(
      loadDpConfig({
        port: 0,
        name: instance.name,
        cpUrl,
        token: instance.token,
        cachePath: join(dir, `dp-${instance.name}.json`),
        pollIntervalMs: 1000,
        maxBodyBytes: 8 * 1024 * 1024,
        trustedProxyCidrs: [],
        maxSeries: 2000,
        maxWindowsPerReport: 15,
        telemetry,
        quiet: true,
      }),
    );
    await dp.start();
    const server = startDataPlane(dp);
    dataPlanes.push(dp);
    (dp as unknown as { server: unknown }).server = server;
    return `http://127.0.0.1:${server.port}`;
  };

  for (const instance of counting.slice(0, gatewayCount)) {
    gateways.push(await start(instance, "on"));
  }
  const gatewayWithoutTelemetry = await start(quiet, "off");

  return {
    backendUrl,
    cpUrl,
    gateways,
    gatewayWithoutTelemetry,
    app,
    dataPlanes,
    apis,
    stop() {
      for (const dp of dataPlanes) {
        dp.stop();
        (dp as unknown as { server?: { stop(force: boolean): void } }).server?.stop(true);
      }
      cpServer.stop(true);
      backendServer.stop(true);
      tlsBackendServer.stop(true);
      app.telemetry.stop();
      app.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

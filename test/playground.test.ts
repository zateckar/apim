import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { A2A_PROTOCOL_VERSION } from "../shared/a2a.ts";
import type { TargetDef } from "../control-plane/src/config.ts";
import { prunePlaygroundHistory } from "../control-plane/src/retention.ts";
import { startDataPlane } from "../data-plane/src/server.ts";
import { PetstoreBackend, startBackend as startPetstore } from "../tools/backend/server.ts";
import {
  makeCp,
  makeDp,
  publishApi,
  serveCp,
  startBackend,
  type RecordedRequest,
  type TestCp,
} from "./helpers.ts";

/**
 * G1: a consumer calls a subscribed API from the portal, through the control plane, with history.
 *
 * Three properties are the whole design, and each one is asserted below rather than assumed:
 *
 *  - **the browser never sends or receives a key.** It posts a `subscriptionId`; the control plane
 *    resolves and injects the key, and what comes back is the header set *without* it.
 *  - **there is no field in which a caller can name a host.** The target is composed from
 *    `TARGETS_FILE`'s gateway URLs and the published route, so this endpoint cannot be turned into
 *    a request forger — and the composed URL is egress-checked anyway.
 *  - **the call is an ordinary gateway request.** It reaches a real listening gateway, spends the
 *    subscription's rate limit, and is refused by the same policies as any other caller's traffic.
 *
 * Every world here therefore runs a *listening* data plane: an in-process `fetchHttp` would prove
 * the composition and none of the sending.
 */

const SPEC = {
  swagger: "2.0",
  info: { title: "playground", version: "1.0.0" },
  host: "example.test",
  basePath: "/v2",
  schemes: ["https"],
  paths: {
    "/echo": {
      get: {
        operationId: "getEcho",
        parameters: [{ name: "verbose", in: "query", type: "string" }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/pets": {
      post: {
        operationId: "addPet",
        parameters: [
          {
            name: "body",
            in: "body",
            required: true,
            schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPetById",
        parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

/** The same contract with `getEcho` gone: what a history entry can outlive. */
const SPEC_WITHOUT_ECHO = {
  ...SPEC,
  paths: { "/other": { get: { operationId: "getOther", responses: { "200": { description: "ok" } } } } },
};

const KEY_IN_HEADER = { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } };
const STRIP = { rewrite: { stripBasePath: true } };

// --------------------------------------------------------------------------- the world

interface World {
  cp: TestCp;
  api: Awaited<ReturnType<typeof publishApi>>;
  backend: ReturnType<typeof startBackend>;
  gatewayUrl: string;
}

let cleanup: Array<() => void> = [];
let seq = 0;

afterEach(() => {
  for (const stop of cleanup.reverse()) stop();
  cleanup = [];
});

/**
 * A backend that can be asked to misbehave, because the playground outcomes worth testing are the
 * ones that are not a tidy 200: a slow answer, an oversized one, and one that is not text at all.
 */
async function simBackend(req: Request, recorded: RecordedRequest): Promise<Response> {
  const delay = Number(req.headers.get("x-sim-delay-ms") ?? "0");
  if (delay > 0) await Bun.sleep(delay);
  const bytes = Number(req.headers.get("x-sim-bytes") ?? "0");
  if (bytes > 0) return new Response("a".repeat(bytes), { headers: { "content-type": "text/plain" } });
  if (req.headers.get("x-sim-binary")) {
    return new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  return Response.json({ ok: true, saw: recorded.path + recorded.query });
}

async function world(
  options: {
    policy?: Record<string, unknown>;
    subscribe?: boolean;
    host?: string;
    spec?: unknown;
  } = {},
): Promise<World> {
  const backend = startBackend(simBackend);
  cleanup.push(() => backend.stop());
  const cp = makeCp();
  cleanup.push(() => cp.close());
  const served = serveCp(cp);
  cleanup.push(() => served.stop());

  const api = await publishApi(cp, {
    backendUrl: `${backend.url}/v2`,
    spec: options.spec ?? SPEC,
    ...(options.host ? { host: options.host } : {}),
    policy: options.policy ?? { ...STRIP, ...KEY_IN_HEADER },
    ...(options.subscribe === false ? { subscribe: false } : {}),
  });

  const gatewayUrl = await startGateway(cp, served.url);
  return { cp, api, backend, gatewayUrl };
}

/**
 * A listening gateway, and the target list that names it. The port is only known once the gateway
 * is up, so `config.gatewayUrls` is completed here — in the shape `TARGETS_FILE` has (plan §11).
 */
async function startGateway(cp: TestCp, cpUrl: string): Promise<string> {
  const dp = makeDp(cpUrl, cp.token, cp.dir, { name: `pg-${++seq}` });
  await dp.start();
  cleanup.push(() => dp.stop());
  if (!dp.client.table) throw new Error(`config did not activate: ${dp.client.activationBlocked}`);
  const gateway = startDataPlane(dp);
  cleanup.push(() => gateway.stop(true));
  const gatewayUrl = `http://127.0.0.1:${gateway.port}`;
  cp.app.config.targets = targets(gatewayUrl);
  return gatewayUrl;
}

function targets(gatewayUrl: string): TargetDef[] {
  const target = (environment: string, config: Record<string, unknown>): TargetDef => ({
    environment,
    adapter: "standalone",
    enforce: true,
    paused: false,
    config,
  });
  return [
    target("dev", {
      gatewayUrls: [
        { label: "dev-1", url: gatewayUrl },
        { label: "dev-2", url: gatewayUrl },
      ],
    }),
    target("test", { gatewayUrls: [{ label: "test-1", url: gatewayUrl }] }),
    // PROD deliberately has none: an environment without a gateway URL has no playground, and the
    // endpoint says exactly that rather than failing to connect to something.
    target("prod", {}),
  ];
}

// --------------------------------------------------------------------------- the two shapes

interface Sent {
  request: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    gateway: { label: string; url: string };
    keyKind: string;
    subscriptionId: string | null;
    droppedHeaders: string[];
    warnings: string[];
  };
  response: {
    status: number | null;
    statusText: string | null;
    durationMs: number;
    headers: Record<string, string>;
    body: string | null;
    encoding: string;
    truncated: boolean;
    bytes: number;
    error: string | null;
  };
  note: string;
}

interface Problem {
  status: number;
  detail: string;
  fix?: { screen: string; resourceId: string; environment: string };
  needsSubscription?: boolean;
  streaming?: string;
  command?: string;
  retryAfterSec?: number;
}

function post(w: World, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return w.cp.call("POST", "/api/playground", { cookie, body });
}

/** A send the test expects to reach the gateway. A refusal fails here, carrying its own reason. */
async function send(w: World, cookie: string, body: Record<string, unknown>): Promise<Sent> {
  const response = await post(w, cookie, body);
  const payload = (await response.json()) as Sent & Problem;
  if (response.status !== 200) {
    throw new Error(`the playground refused: ${response.status} ${payload.detail}`);
  }
  return payload;
}

/** A send the test expects to be refused, with the status and the problem+json members. */
async function refused(w: World, cookie: string, body: Record<string, unknown>): Promise<Problem> {
  const response = await post(w, cookie, body);
  const payload = (await response.json()) as Problem;
  if (response.status === 200) throw new Error("expected a refusal, but the call was sent");
  return { ...payload, status: response.status };
}

interface HistoryItem {
  id: string;
  environment: string;
  subscriptionId: string | null;
  keyKind: string;
  operationId: string | null;
  method: string;
  path: string;
  query: Array<{ name: string; value: string }>;
  headers: Record<string, string>;
  body: string | null;
  gateway: string;
  status: number | null;
  durationMs: number | null;
  responsePreview: string | null;
  responseEncoding: string | null;
  responseTruncated: boolean;
  error: string | null;
  replayable: boolean;
  reason: string | null;
}

async function history(w: World, cookie: string): Promise<{ items: HistoryItem[]; cap: number }> {
  const response = await w.cp.call("GET", `/api/playground/history?resourceId=${w.api.resourceId}`, {
    cookie,
  });
  if (!response.ok) throw new Error(`history: ${response.status} ${await response.text()}`);
  return (await response.json()) as { items: HistoryItem[]; cap: number };
}

/** The request the browser posts: an operation and a subscription, never a URL. */
function call(w: World, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: w.api.resourceId,
    environment: "dev",
    subscriptionId: w.api.subscriptionId,
    operationId: "getEcho",
    ...over,
  };
}

// --------------------------------------------------------------------------- composition

describe("the caller names an operation and the platform names the host", () => {
  test("the composed request reaches the gateway, and the gateway reaches the backend", async () => {
    const w = await world();
    const sent = await send(
      w,
      w.api.clara,
      call(w, { query: [{ name: "verbose", value: "1", enabled: true }] }),
    );

    expect(sent.response.status).toBe(200);
    expect(sent.request.method).toBe("GET");
    expect(sent.request.path).toBe(`${w.api.basePath}/echo`);
    expect(sent.request.query).toBe("verbose=1");
    expect(sent.request.gateway).toEqual({ label: "dev-1", url: w.gatewayUrl });
    // Through the whole pipeline rather than to the backend: base path stripped, query carried.
    expect(w.backend.requests.at(-1)!.path).toBe("/v2/echo");
    expect(w.backend.requests.at(-1)!.query).toBe("?verbose=1");
    // Said in the response, not only in the UI (§5.3).
    expect(sent.note).toContain("rate limit and quota");
  });

  test("the method comes from the operation, and there is no field to override it", async () => {
    const w = await world();
    const sent = await send(
      w,
      w.api.clara,
      call(w, { operationId: "addPet", method: "GET", body: JSON.stringify({ name: "doggie" }) }),
    );
    expect(sent.request.method).toBe("POST");
    expect(sent.response.status).toBe(200);
    expect(w.backend.requests.at(-1)!.method).toBe("POST");
    expect(w.backend.requests.at(-1)!.body).toContain("doggie");
  });

  test("an operation the served revision does not have is refused, naming it", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, call(w, { operationId: "deleteEverything" }));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("deleteEverything");
    expect(w.backend.requests).toHaveLength(0);
  });

  test("a path parameter is substituted and percent-encoded; a missing one is refused", async () => {
    const w = await world();
    const sent = await send(
      w,
      w.api.clara,
      call(w, { operationId: "getPetById", pathParams: { petId: "a b/c" } }),
    );
    // Encoded, so a path parameter cannot introduce a path segment of its own.
    expect(sent.request.path).toBe(`${w.api.basePath}/pets/a%20b%2Fc`);
    expect(w.backend.requests.at(-1)!.path).toBe("/v2/pets/a%20b%2Fc");

    const problem = await refused(w, w.api.clara, call(w, { operationId: "getPetById" }));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain('"petId"');
  });

  test("an omitted gateway label uses the first, and the response says which", async () => {
    const w = await world();
    expect((await send(w, w.api.clara, call(w))).request.gateway.label).toBe("dev-1");
    expect(
      (await send(w, w.api.clara, call(w, { gatewayLabel: "dev-2" }))).request.gateway.label,
    ).toBe("dev-2");

    const problem = await refused(w, w.api.clara, call(w, { gatewayLabel: "somewhere-else" }));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain('unknown gateway "somewhere-else"');
    expect(problem.detail).toContain("dev-1, dev-2");
  });

  test("an environment outside the promotion chain is refused by name", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, call(w, { environment: "staging" }));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("PROMOTION_CHAIN");
  });

  test("an environment the API is not published in points at the publish screen", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, call(w, { environment: "test", subscriptionId: null }));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("not published in TEST yet");
    expect(problem.fix).toEqual({ screen: "publish", resourceId: w.api.resourceId, environment: "test" });
  });

  test("published is not the same as served: a route the gateway omits is refused first", async () => {
    const w = await world();
    // v3 omits a route whose effective policy document is invalid and records it in `errors`. The
    // playground applies the same test, so a caller sees the reason rather than a 404 that reads as
    // a platform fault (review `[P3-02]`). Written straight to the table because both write paths
    // validate — this is the restored-backup case.
    w.cp.app.db.run(
      `INSERT INTO policy_entry (resource_id, environment, unit_key, value_json, origin, updated_by, updated_at)
       VALUES (?, 'dev', 'rateLimit', ?, 'local', 'test', '2026-01-01T00:00:00.000Z')`,
      [w.api.resourceId, JSON.stringify({ calls: 5 })],
    );
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("not currently being served");
    expect(problem.detail).toContain("rateLimit.periodSec");
    expect(problem.fix).toEqual({ screen: "policy", resourceId: w.api.resourceId, environment: "dev" });
    expect(w.backend.requests).toHaveLength(0);
  });

  test("an environment with no gateway URL says so, and names TARGETS_FILE", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, call(w, { environment: "prod" }));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("no gateway URL is configured for PROD");
    expect(problem.detail).toContain("TARGETS_FILE");
  });

  test("a host-bound route is addressed by its own host, which a caller cannot forge", async () => {
    const w = await world({ host: "gw.test" });
    const sent = await send(
      w,
      w.api.clara,
      call(w, { headers: [{ name: "Host", value: "evil.test", enabled: true }] }),
    );
    // `route.host` is how the gateway selects a host-bound route, so it is set from the route and a
    // caller-supplied Host is dropped and named (review `[P1-05]`). The 200 is the proof: the
    // gateway matched a route it only serves under that host.
    expect(sent.request.headers.host).toBe("gw.test");
    expect(sent.request.droppedHeaders).toEqual(["Host"]);
    expect(sent.response.status).toBe(200);
  });
});

// --------------------------------------------------------------------------- the key

describe("the key never touches the browser", () => {
  test("it is injected server-side and appears nowhere in the answer", async () => {
    const w = await world();
    const sent = await send(w, w.api.clara, call(w));

    // A 200 is the proof that it was injected: the route requires the key.
    expect(sent.response.status).toBe(200);
    expect(JSON.stringify(sent)).not.toContain(w.api.key!);
    expect(Object.keys(sent.request.headers)).not.toContain("x-api-key");
    expect(sent.request.keyKind).toBe("primary");
    // The gateway consumed it rather than forwarding it to the backend.
    expect(w.backend.requests.at(-1)!.headers["x-api-key"]).toBeUndefined();
  });

  test("another application's subscription is 403, and an unknown one is indistinguishable from it", async () => {
    const w = await world();
    // pavel owns the API; the application belongs to clara's application. Owning an API is not being a
    // caller, and the two refusals must not let anyone probe for subscription ids.
    const foreign = await refused(w, w.api.pavel, call(w));
    const nonsense = await refused(w, w.api.pavel, call(w, { subscriptionId: "sub_nope" }));
    expect(foreign.status).toBe(403);
    expect(nonsense.status).toBe(403);
    expect(nonsense.detail).toBe(foreign.detail);
  });

  test("a route with no auth.subscriptionKey is callable with no subscription at all", async () => {
    const w = await world({ policy: STRIP, subscribe: false });
    const sent = await send(w, w.api.pavel, call(w, { subscriptionId: null }));
    // Whether a subscription is required is decided by the route, not by who is asking (review
    // `[P2-02]`), and a route that reads no key is worth being able to try.
    expect(sent.response.status).toBe(200);
    expect(sent.request.keyKind).toBe("none");
    expect(sent.request.subscriptionId).toBeNull();
  });

  test("sending a subscription to a route that reads no key is refused rather than ignored", async () => {
    const w = await world({ policy: STRIP });
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("does not require a subscription key");
  });

  test("a key-protected route with no subscription names the next action", async () => {
    const w = await world();
    const problem = await refused(w, w.api.pavel, call(w, { subscriptionId: null }));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("requires a subscription key in X-Api-Key");
    // The cheapest moment to teach the product/application model is the moment it is needed.
    expect(problem.needsSubscription).toBe(true);
  });

  test("keyKind secondary with no secondary key is refused rather than falling back", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, call(w, { keyKind: "secondary" }));
    // "Test the secondary before I rotate" is the only reason that control exists, so a silent
    // fallback to the primary would defeat the point `[P3-01]`.
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("no secondary key");
    expect(problem.detail).toContain("Rotate key");
  });

  test("a revoked subscription stops working immediately", async () => {
    const w = await world();
    w.cp.app.db.run("UPDATE subscription SET state = 'revoked' WHERE id = ?", [w.api.subscriptionId!]);
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("revoked");
    expect(w.backend.requests).toHaveLength(0);
  });

  test("a subscription for another environment says which one it is for", async () => {
    const w = await world();
    w.cp.app.db.run("UPDATE subscription SET environment = 'test' WHERE id = ?", [w.api.subscriptionId!]);
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("this subscription is for TEST");
    expect(problem.detail).toContain("per environment");
  });

  test("a subscription to a product that does not contain this API is refused with the reason", async () => {
    const w = await world();
    const second = await publishApi(w.cp, { backendUrl: `${w.backend.url}/v2`, spec: SPEC });
    const problem = await refused(w, w.api.clara, call(w, { subscriptionId: second.subscriptionId }));
    // Otherwise the gateway answers 403 and the reason looks like a platform fault.
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("does not include");
    expect(w.backend.requests).toHaveLength(0);
  });

  test("the key can travel in the query string, and is still not reported or stored", async () => {
    const w = await world({
      policy: { ...STRIP, "auth.subscriptionKey": { in: "query", name: "apikey" } },
    });
    const sent = await send(
      w,
      w.api.clara,
      call(w, { query: [{ name: "verbose", value: "1", enabled: true }] }),
    );
    expect(sent.response.status).toBe(200);
    // What is reported is the query the caller wrote; the key is not in it.
    expect(sent.request.query).toBe("verbose=1");
    expect(JSON.stringify(sent)).not.toContain(w.api.key!);
    expect(JSON.stringify(await history(w, w.api.clara))).not.toContain(w.api.key!);
    // It did reach the gateway, or the call would not have been authorised.
    expect(w.backend.requests.at(-1)!.query).toBe("?verbose=1");
  });

  test("hop-by-hop headers and the key header are dropped, and named", async () => {
    const w = await world();
    const sent = await send(
      w,
      w.api.clara,
      call(w, {
        headers: [
          { name: "Accept", value: "application/json", enabled: true },
          { name: "X-Api-Key", value: "not-my-key", enabled: true },
          { name: "Connection", value: "close", enabled: true },
          { name: "Proxy-Authorization", value: "Basic nope", enabled: true },
          { name: "X-Disabled", value: "no", enabled: false },
        ],
      }),
    );
    // Named rather than silently removed, so nobody debugs a header they believe they sent (§5.2).
    expect(sent.request.droppedHeaders).toEqual(["X-Api-Key", "Connection", "Proxy-Authorization"]);
    expect(sent.request.headers.accept).toBe("application/json");
    expect(sent.request.headers["x-disabled"]).toBeUndefined();
    expect(sent.response.status).toBe(200);
    expect(w.backend.requests.at(-1)!.headers.accept).toBe("application/json");
  });
});

// --------------------------------------------------------------------------- limits and outcomes

describe("limits and outcomes", () => {
  test("a body over PLAYGROUND_MAX_BODY_BYTES is refused before anything is sent", async () => {
    const w = await world();
    w.cp.app.config.playgroundMaxBodyBytes = 512;
    const problem = await refused(w, w.api.clara, call(w, { operationId: "addPet", body: "x".repeat(513) }));
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("PLAYGROUND_MAX_BODY_BYTES");
    expect(w.backend.requests).toHaveLength(0);
  });

  test("the console's rate limit is the portal's own, and says so", async () => {
    const w = await world();
    w.cp.app.config.playgroundRatePerMin = 3;
    for (let i = 0; i < 3; i++) {
      const sent = await send(
        w,
        w.api.clara,
        call(w, { query: [{ name: "verbose", value: String(i), enabled: true }] }),
      );
      expect(sent.response.status).toBe(200);
    }
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(429);
    expect(problem.detail).toContain("PLAYGROUND_RATE_PER_MIN");
    // The distinction that matters: this is not the consumer's quota (review `[P1-17]`).
    expect(problem.detail).toContain("not your subscription's");
    expect(problem.retryAfterSec).toBeGreaterThan(0);
  });

  test("a response past the cap is truncated, flagged, and counted", async () => {
    const w = await world();
    w.cp.app.config.playgroundMaxResponseBytes = 64;
    const sent = await send(
      w,
      w.api.clara,
      call(w, { headers: [{ name: "X-Sim-Bytes", value: "4096", enabled: true }] }),
    );
    expect(sent.response.status).toBe(200);
    expect(sent.response.truncated).toBe(true);
    expect(sent.response.bytes).toBe(64);
    expect(sent.response.body).toBe("a".repeat(64));
  });

  test("a body that is not valid UTF-8 comes back base64 rather than mangled", async () => {
    const w = await world();
    const sent = await send(
      w,
      w.api.clara,
      call(w, { headers: [{ name: "X-Sim-Binary", value: "1", enabled: true }] }),
    );
    expect(sent.response.encoding).toBe("base64");
    expect(Buffer.from(sent.response.body!, "base64")).toEqual(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  });

  test("a timeout is an outcome on the entry, not an error banner", async () => {
    const w = await world();
    w.cp.app.config.playgroundTimeoutMs = 150;
    const sent = await send(
      w,
      w.api.clara,
      call(w, { headers: [{ name: "X-Sim-Delay-Ms", value: "1500", enabled: true }] }),
    );
    // The request happened; this is what happened to it (§5.3).
    expect(sent.response.status).toBeNull();
    expect(sent.response.error).toContain("no response within 150 ms");

    const items = (await history(w, w.api.clara)).items;
    expect(items[0]!.status).toBeNull();
    expect(items[0]!.error).toContain("no response within");
  });

  test("the call spends the subscription's own rate limit, like any other call", async () => {
    const w = await world({
      policy: {
        ...STRIP,
        ...KEY_IN_HEADER,
        rateLimit: { calls: 1, periodSec: 3600, per: "instance", by: "subscription", scope: "route" },
      },
    });
    expect((await send(w, w.api.clara, call(w))).response.status).toBe(200);
    const second = await send(
      w,
      w.api.clara,
      call(w, { query: [{ name: "verbose", value: "2", enabled: true }] }),
    );
    // Refused by the gateway rather than by the console: a playground call is a real call (D31),
    // and what comes back is the gateway's own answer.
    expect(second.response.status).toBe(429);
  });
});

// --------------------------------------------------------------------------- history and audit

describe("history is the caller's own", () => {
  test("newest first, de-duplicated, per user, and never carrying a key", async () => {
    const w = await world();
    await send(w, w.api.clara, call(w));
    await send(w, w.api.clara, call(w));
    // Identical to the newest entry: it replaces rather than adds, so hammering Send does not
    // evict the history (§5.5).
    expect((await history(w, w.api.clara)).items).toHaveLength(1);

    await send(w, w.api.clara, call(w, { operationId: "addPet", body: JSON.stringify({ name: "x" }) }));
    const listed = await history(w, w.api.clara);
    expect(listed.items.map((item) => item.operationId)).toEqual(["addPet", "getEcho"]);
    expect(listed.items[0]!.environment).toBe("dev");
    expect(listed.items[0]!.gateway).toBe("dev-1");
    expect(listed.items[0]!.replayable).toBe(true);
    expect(listed.items[0]!.status).toBe(200);
    expect(JSON.stringify(listed)).not.toContain(w.api.key!);

    // pavel's history is his own, and it is empty: a request body is the caller's test data.
    expect((await history(w, w.api.pavel)).items).toEqual([]);
  });

  test("the cap drops the oldest on write", async () => {
    const w = await world();
    w.cp.app.config.playgroundHistoryPerResource = 3;
    for (const n of ["1", "2", "3", "4", "5"]) {
      await send(w, w.api.clara, call(w, { query: [{ name: "verbose", value: n, enabled: true }] }));
    }
    const items = (await history(w, w.api.clara)).items;
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.query[0]!.value)).toEqual(["5", "4", "3"]);
  });

  test("what is sent and what is kept are different questions", async () => {
    const w = await world();
    w.cp.app.config.playgroundHistoryBodyBytes = 64;
    const body = JSON.stringify({ name: "x".repeat(500) });
    await send(w, w.api.clara, call(w, { operationId: "addPet", body }));

    const item = (await history(w, w.api.clara)).items[0]!;
    // The whole body was sent; only a bounded prefix is stored (review `[P3-03]`).
    expect(w.backend.requests.at(-1)!.body).toBe(body);
    expect(Buffer.byteLength(item.body!, "utf8")).toBeLessThanOrEqual(64);
  });

  test("an entry whose operation is gone stays listed, with the reason", async () => {
    const w = await world();
    await send(w, w.api.clara, call(w));
    await w.cp.call("POST", `/api/resources/${w.api.resourceId}/revisions`, {
      cookie: w.api.pavel,
      body: { spec: SPEC_WITHOUT_ECHO },
    });
    const release = await w.cp.call("POST", `/api/resources/${w.api.resourceId}/releases`, {
      cookie: w.api.pavel,
      body: { revision: 2, environment: "dev" },
    });
    expect(release.status).toBeLessThan(300);

    const item = (await history(w, w.api.clara)).items[0]!;
    // Still history, and still says why it cannot be loaded back into the form `[P1-22]`.
    expect(item.replayable).toBe(false);
    expect(item.reason).toContain("getEcho");
    expect(item.reason).toContain("DEV");
  });

  test("an entry whose subscription was revoked says that instead", async () => {
    const w = await world();
    await send(w, w.api.clara, call(w));
    w.cp.app.db.run("UPDATE subscription SET state = 'revoked' WHERE id = ?", [w.api.subscriptionId!]);
    const item = (await history(w, w.api.clara)).items[0]!;
    expect(item.replayable).toBe(false);
    expect(item.reason).toContain("revoked");
  });

  test("the caller can delete one entry or all of them, and only their own", async () => {
    const w = await world();
    await send(w, w.api.clara, call(w));
    const id = (await history(w, w.api.clara)).items[0]!.id;

    // An id is not a capability: pavel can neither delete clara's entry nor learn that it exists.
    const foreign = await w.cp.call("DELETE", `/api/playground/history/${id}`, { cookie: w.api.pavel });
    expect(foreign.status).toBe(404);
    const own = await w.cp.call("DELETE", `/api/playground/history/${id}`, { cookie: w.api.clara });
    expect(own.status).toBe(204);
    expect((await history(w, w.api.clara)).items).toEqual([]);

    await send(w, w.api.clara, call(w));
    const cleared = await w.cp.call(
      "DELETE",
      `/api/playground/history?resourceId=${w.api.resourceId}`,
      { cookie: w.api.clara },
    );
    expect(await cleared.json()).toEqual({ removed: 1 });
  });

  test("retention deletes history past PLAYGROUND_HISTORY_RETENTION_DAYS", async () => {
    const w = await world();
    await send(w, w.api.clara, call(w));
    w.cp.app.db.run("UPDATE playground_call SET created_at = '2020-01-01T00:00:00.000Z'");
    // A scratchpad, not a call ledger: the audit row is what survives (D27).
    expect(prunePlaygroundHistory(w.cp.app)).toBe(1);
    expect((await history(w, w.api.clara)).items).toEqual([]);
  });

  test("every call writes an audit row, and none of them carries a body, a header or a query", async () => {
    const w = await world();
    await send(
      w,
      w.api.clara,
      call(w, {
        operationId: "addPet",
        body: JSON.stringify({ name: "secret-pet-name" }),
        headers: [{ name: "X-Trace", value: "trace-me", enabled: true }],
        query: [{ name: "q", value: "query-value", enabled: true }],
      }),
    );
    const row = w.cp.app.db
      .query<{ actor: string; subject: string; outcome: string; detail: string }, []>(
        "SELECT actor, subject, outcome, detail FROM audit WHERE action = 'playground.call'",
      )
      .get();
    expect(row!.actor).toBe("clara");
    expect(row!.subject).toBe(`resource:${w.api.resourceId}`);
    expect(row!.outcome).toBe("ok");

    const detail = JSON.parse(row!.detail) as Record<string, unknown>;
    expect(detail.operationId).toBe("addPet");
    expect(detail.status).toBe(200);
    expect(detail.subscriptionId).toBe(w.api.subscriptionId);
    expect(detail.gateway).toBe("dev-1");
    expect(detail.bytesIn).toBeGreaterThan(0);
    // `audit` is append-only and never pruned, so a body in it is a body kept for ever `[P1-11]`.
    expect(row!.detail).not.toContain("secret-pet-name");
    expect(row!.detail).not.toContain("trace-me");
    expect(row!.detail).not.toContain("query-value");
    expect(row!.detail).not.toContain(w.api.key!);
  });
});

// --------------------------------------------------------------------------- per variant

describe("per variant", () => {
  test("a streaming route is refused with the command that does work", async () => {
    const w = await world({ policy: { ...STRIP, ...KEY_IN_HEADER, passthrough: { sse: true } } });
    const problem = await refused(w, w.api.clara, call(w));
    expect(problem.status).toBe(409);
    expect(problem.streaming).toBe("sse");
    // Holding a stream open through the control plane and back into a browser is a second
    // streaming implementation on the wrong tier (§2), so the console hands over a curl line.
    expect(problem.command).toContain("curl -N");
    expect(problem.command).toContain(`${w.gatewayUrl}${w.api.basePath}`);
    expect(problem.command).toContain("$KEY");
  });

  test("an ipAllow route is flagged before sending rather than after the 403", async () => {
    const w = await world({ policy: { ...STRIP, ...KEY_IN_HEADER, ipAllow: ["10.9.9.0/24"] } });
    const sent = await send(w, w.api.clara, call(w));
    // The gateway's 403 is correct, and reads as a platform bug without this warning `[P1-23]`.
    expect(sent.request.warnings.join(" ")).toContain("ipAllow");
    expect(sent.request.warnings.join(" ")).toContain("portal's address");
    expect(sent.response.status).toBe(403);
  });

  test("a soap call is one POST to the endpoint, with the envelope as the body", async () => {
    const petstore = new PetstoreBackend({ port: 0, seed: 1 });
    const server = startPetstore(petstore);
    cleanup.push(() => server.stop(true));
    const backend = startBackend(simBackend);
    cleanup.push(() => backend.stop());
    const cp = makeCp();
    cleanup.push(() => cp.close());
    const served = serveCp(cp);
    cleanup.push(() => served.stop());

    const api = await publishApi(cp, {
      name: "petstore-soap",
      kind: "soap",
      spec: readFileSync("tools/backend/petstore.wsdl", "utf8"),
      backendUrl: `http://127.0.0.1:${server.port}/soap/petstore`,
      basePath: "/petstore-soap",
      policy: { ...STRIP, ...KEY_IN_HEADER },
    });
    const gatewayUrl = await startGateway(cp, served.url);
    const w: World = { cp, api, backend, gatewayUrl };

    const sent = await send(w, api.clara, {
      resourceId: api.resourceId,
      environment: "dev",
      subscriptionId: api.subscriptionId,
      operationId: "GetPet",
      // The console prefills these two from the operation; the platform decides everything else.
      headers: [{ name: "SOAPAction", value: '"urn:apim:petstore:GetPet"', enabled: true }],
      body:
        '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<s:Body><tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId>' +
        "</tns:GetPetRequest></s:Body></s:Envelope>",
    });

    // Every SOAP operation is a POST to the one endpoint, so the path is the base path itself —
    // not the base path with the template's slash appended to it.
    expect(sent.request.method).toBe("POST");
    expect(sent.request.path).toBe(api.basePath);
    // The content type comes from the variant, so a caller cannot get it wrong by omission.
    expect(sent.request.headers["content-type"]).toBe("text/xml; charset=utf-8");
    expect(sent.response.status).toBe(200);
    expect(sent.response.body).toContain("GetPetResponse");
    expect(sent.response.body).toContain("doggie");
  });

  test("an a2a agent card is fetched from the path the gateway serves it on", async () => {
    const backend = startBackend(simBackend);
    cleanup.push(() => backend.stop());
    const cp = makeCp();
    cleanup.push(() => cp.close());
    const served = serveCp(cp);
    cleanup.push(() => served.stop());

    const pavel = await cp.login("pavel");
    const created = (await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: {
          kind: "a2a",
          name: "greeter",
          applicationId: "application_platform",
          apiVersion: "v1",
          domain: "IT",
          subdomain: "Solution",
        },
      })
    ).json()) as { id: string };
    await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: {
        spec: {
          protocolVersion: A2A_PROTOCOL_VERSION,
          name: "Greeter",
          version: "0.1.0",
          url: backend.url,
          capabilities: {},
          skills: [{ id: "greet", name: "Greet", tags: ["hello"] }],
        },
      },
    });
    await cp.call("PUT", `/api/resources/${created.id}/routes`, {
      cookie: pavel,
      body: { environment: "dev", host: "*", basePath: "/it/solution/greeter" },
    });
    await cp.call("PUT", `/api/resources/${created.id}/binding`, {
      cookie: pavel,
      body: { environment: "dev", urls: [backend.url] },
    });
    const release = await cp.call("POST", `/api/resources/${created.id}/releases`, {
      cookie: pavel,
      body: { revision: 1, environment: "dev" },
    });
    expect(release.status).toBeLessThan(300);
    await startGateway(cp, served.url);

    const response = await cp.call("POST", "/api/playground", {
      cookie: pavel,
      body: { resourceId: created.id, environment: "dev", agentCard: true },
    });
    const sent = (await response.json()) as Sent & Problem;
    expect(response.status).toBe(200);
    // The card path in the config document already contains the base path, so composing it must
    // not add a second one.
    expect(sent.request.path).toBe("/it/solution/greeter/.well-known/agent-card.json");
    expect(sent.request.method).toBe("GET");
    expect(sent.response.status).toBe(200);
    // The card the gateway serves is the gateway's own — the point of publishing an agent.
    expect(sent.response.body).toContain("/greeter");
  });

  test("agentCard on an API that is not an agent is refused by name", async () => {
    const w = await world();
    const problem = await refused(w, w.api.clara, {
      resourceId: w.api.resourceId,
      environment: "dev",
      subscriptionId: w.api.subscriptionId,
      agentCard: true,
    });
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("a2a");
  });
});

// --------------------------------------------------------------------------- the form (§5.4)

interface Form {
  kind: string;
  rev: number;
  basePath: string;
  gateways: Array<{ label: string; url: string }>;
  key: { in: string; name: string } | null;
  subscriptions: Array<{ id: string; name: string; hasSecondary: boolean }>;
  needsSubscription: boolean;
  operations: Array<{
    id: string;
    method: string;
    template: string;
    pathParams: Array<{ name: string; required: boolean; value: string }>;
    query: Array<{ name: string; required: boolean; value: string }>;
    headers: Array<{ name: string; required: boolean; value: string }>;
    body: string | null;
    bodyKind: string | null;
    schemaState: string;
    selector?: string;
  }>;
  agentCard: { path: string } | null;
  streaming: { kind: string; command: string } | null;
  warnings: string[];
  limits: { maxBodyBytes: number; ratePerMin: number };
  note: string;
}

async function form(w: World, cookie: string, environment = "dev"): Promise<Form> {
  const response = await w.cp.call(
    "GET",
    `/api/playground/form?resourceId=${w.api.resourceId}&environment=${environment}`,
    { cookie },
  );
  if (!response.ok) throw new Error(`form: ${response.status} ${await response.text()}`);
  return (await response.json()) as Form;
}

describe("the form the console draws", () => {
  test("offers exactly the operations the environment is serving, and a send of each is accepted", async () => {
    const w = await world();
    const drawn = await form(w, w.api.clara);
    expect(drawn.operations.map((operation) => operation.id).sort()).toEqual([
      "addPet",
      "getEcho",
      "getPetById",
    ]);
    expect(drawn.rev).toBe(1);
    expect(drawn.basePath).toBe(w.api.basePath);

    // The property that makes one endpoint worth having: what is offered is what is accepted.
    for (const operation of drawn.operations) {
      const sent = await send(
        w,
        w.api.clara,
        call(w, {
          operationId: operation.id,
          pathParams: Object.fromEntries(
            operation.pathParams.map((parameter) => [parameter.name, parameter.value || "1"]),
          ),
          ...(operation.body === null ? {} : { body: operation.body }),
        }),
      );
      expect(sent.request.method, operation.id).toBe(operation.method);
      expect(sent.response.status, operation.id).toBe(200);
    }
  });

  test("names the key header the route requires, and the caller's own usable subscriptions", async () => {
    const w = await world();
    const drawn = await form(w, w.api.clara);
    expect(drawn.key).toEqual({ in: "header", name: "X-Api-Key" });
    expect(drawn.subscriptions.map((subscription) => subscription.id)).toEqual([
      w.api.subscriptionId!,
    ]);
    expect(drawn.subscriptions[0]!.name).toContain("→");
    // Nothing to rotate to yet: the console disables "secondary" rather than falling back `[P3-01]`.
    expect(drawn.subscriptions[0]!.hasSecondary).toBe(false);
    expect(drawn.needsSubscription).toBe(false);
  });

  test("a route with no key unit says so rather than asking for a subscription", async () => {
    // Whether a key is needed is the route's decision, not the caller's `[P2-02]`.
    const w = await world({ policy: STRIP, subscribe: false });
    const drawn = await form(w, w.api.clara);
    expect(drawn.key).toBeNull();
    expect(drawn.subscriptions).toEqual([]);
    expect(drawn.needsSubscription).toBe(false);
  });

  test("the owner path: a key is required and this caller holds none", async () => {
    const w = await world({ subscribe: false });
    const drawn = await form(w, w.api.pavel);
    expect(drawn.key).not.toBeNull();
    expect(drawn.subscriptions).toEqual([]);
    // `[P1-10]`: one control — "subscribe an application to try this" — rather than a dead form.
    expect(drawn.needsSubscription).toBe(true);
  });

  test("prefills a body from the request schema, and path parameters from theirs", async () => {
    const w = await world();
    const drawn = await form(w, w.api.clara);
    const addPet = drawn.operations.find((operation) => operation.id === "addPet")!;
    expect(addPet.bodyKind).toBe("json");
    expect(JSON.parse(addPet.body!)).toEqual({ name: "string" });
    expect(addPet.headers.find((header) => header.name === "content-type")?.value).toContain("json");

    const byId = drawn.operations.find((operation) => operation.id === "getPetById")!;
    expect(byId.pathParams.map((parameter) => parameter.name)).toEqual(["petId"]);
    expect(byId.pathParams[0]!.required).toBe(true);
    expect(byId.body).toBeNull();

    const echo = drawn.operations.find((operation) => operation.id === "getEcho")!;
    expect(echo.query.map((parameter) => parameter.name)).toEqual(["verbose"]);
  });

  test("a recursive schema is bounded rather than followed forever", async () => {
    const w = await world({
      spec: {
        openapi: "3.0.0",
        info: { title: "deep", version: "1" },
        paths: {
          "/node": {
            post: {
              operationId: "addNode",
              requestBody: {
                required: true,
                content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          schemas: {
            Node: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" }, child: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    });
    const drawn = await form(w, w.api.clara);
    const body = JSON.parse(drawn.operations[0]!.body!) as { name: string; child: unknown };
    expect(body.name).toBe("string");
    // The cycle stops rather than recursing: a partial example beats a hung request `[P1-08]`.
    expect(body.child).toBeNull();
  });

  test("a soap operation is a POST with an envelope and the SOAPAction the WSDL declares", async () => {
    const backend = startBackend(simBackend);
    cleanup.push(() => backend.stop());
    const cp = makeCp();
    cleanup.push(() => cp.close());
    const served = serveCp(cp);
    cleanup.push(() => served.stop());
    const api = await publishApi(cp, {
      name: "petstore-soap",
      kind: "soap",
      spec: readFileSync("tools/backend/petstore.wsdl", "utf8"),
      backendUrl: `${backend.url}/soap`,
      basePath: "/petstore-soap",
      policy: { ...STRIP, ...KEY_IN_HEADER },
    });
    const gatewayUrl = await startGateway(cp, served.url);
    const w: World = { cp, api, backend, gatewayUrl };

    const drawn = await form(w, api.clara);
    expect(drawn.kind).toBe("soap");
    const getPet = drawn.operations.find((operation) => operation.id === "GetPet")!;
    expect(getPet.method).toBe("POST");
    expect(getPet.bodyKind).toBe("xml");
    expect(getPet.body).toContain("<soap:Envelope");
    expect(getPet.body).toContain("GetPetRequest");
    // Set from the WSDL and shown read-only: getting it wrong is design §5.1's routing bypass.
    const action = getPet.headers.find((header) => header.name === "SOAPAction")!;
    expect(action.value).toBe('"urn:apim:petstore:GetPet"');
    expect(action.required).toBe(true);
  });

  test("a streaming route is listed with the command rather than a form that cannot send", async () => {
    const w = await world({ policy: { ...STRIP, ...KEY_IN_HEADER, passthrough: { websocket: true } } });
    const drawn = await form(w, w.api.clara);
    expect(drawn.streaming?.kind).toBe("websocket");
    expect(drawn.streaming?.command).toContain("websocat");
    expect(drawn.streaming?.command).toContain("ws://");
  });

  test("an ipAllow route is warned about before anything is sent", async () => {
    const w = await world({ policy: { ...STRIP, ...KEY_IN_HEADER, ipAllow: ["10.9.9.0/24"] } });
    const drawn = await form(w, w.api.clara);
    expect(drawn.warnings.join(" ")).toContain("IP address");
  });

  test("refuses with the same sentence the send would, and names the screen that fixes it", async () => {
    const w = await world();
    const response = await w.cp.call(
      "GET",
      `/api/playground/form?resourceId=${w.api.resourceId}&environment=test`,
      { cookie: w.api.clara },
    );
    expect(response.status).toBe(409);
    const problem = (await response.json()) as Problem;
    expect(problem.detail).toContain("not published in TEST");
    expect(problem.fix?.screen).toBe("publish");
  });

  test("an unknown environment is refused before anything is looked up", async () => {
    const w = await world();
    const response = await w.cp.call(
      "GET",
      `/api/playground/form?resourceId=${w.api.resourceId}&environment=nowhere`,
      { cookie: w.api.clara },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as Problem).detail).toContain("PROMOTION_CHAIN");
  });

  test("carries the limits the console must enforce before sending", async () => {
    const w = await world();
    const drawn = await form(w, w.api.clara);
    expect(drawn.limits.maxBodyBytes).toBe(w.cp.app.config.playgroundMaxBodyBytes);
    expect(drawn.limits.ratePerMin).toBe(w.cp.app.config.playgroundRatePerMin);
    // The one sentence a consumer must read before pressing send (§5.3).
    expect(drawn.note).toContain("rate limit and quota");
    expect(drawn.gateways.map((gateway) => gateway.label)).toEqual(["dev-1", "dev-2"]);
  });
});

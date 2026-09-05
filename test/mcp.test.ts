import { activeSubscription } from './helpers.ts';
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, makeDp, serveCp, type TestCp } from "./helpers.ts";
import { McpServer, startMcpServer } from "../tools/mcp/server.ts";
import type { DataPlane } from "../data-plane/src/server.ts";
import type { Integrations } from "../control-plane/src/egress.ts";
import { MCP_PROTOCOL_VERSION, MCP_SESSION_HEADER } from "../shared/mcp.ts";

/**
 * Goal 4: publish an existing MCP server and subscribe to it like an API.
 *
 * "Like an API" is the claim under test, so almost nothing here is MCP-specific: the same
 * resource, revision, product, subscription, route, binding and policy every other variant uses.
 * What *is* specific is the two ends — how the contract is discovered, since an MCP server has no
 * document to upload, and how the operation is resolved, since a single-endpoint RPC protocol
 * keeps it inside the body.
 */

let cp: TestCp;
let seq = 0;

function integrations(): Integrations {
  return {
    egressAllowlist: [
      { scheme: "http", hostPattern: "127.0.0.1", portRange: [1024, 65535] },
      { scheme: "http", hostPattern: "localhost", portRange: [1024, 65535] },
    ],
    denyCidrs: ["169.254.0.0/16"],
  } as Integrations;
}

beforeEach(() => {
  cp = makeCp({ integrations: integrations() });
});
afterEach(() => {
  cp.close();
});

function startServer(options: Partial<ConstructorParameters<typeof McpServer>[0]> = {}) {
  const server = new McpServer({ port: 0, ...options });
  const listening = startMcpServer(server);
  return { server, url: `http://127.0.0.1:${listening.port}/mcp`, stop: () => listening.stop(true) };
}

async function publishMcp(discoverUrl: string) {
  const pavel = await cp.login("pavel");
  const created = await (
    await cp.call("POST", "/api/resources", {
      cookie: pavel,
      body: { kind: "mcp", name: `mcp-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
    })
  ).json();
  const response = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
    cookie: pavel,
    body: { discoverUrl },
  });
  return { pavel, resourceId: created.id as string, response };
}

// --------------------------------------------------------------------------- discovery

describe("discovery", () => {
  test("a handshake is the import: tools, resources and prompts become the contract", async () => {
    const origin = startServer();
    try {
      const { response, resourceId } = await publishMcp(origin.url);
      expect(response.status).toBe(201);
      const revision = await response.json();

      expect(revision.format).toBe("mcp-manifest");
      expect(revision.discoveredFrom).toBe(origin.url);
      expect(revision.model.title).toBe("petstore-mcp");
      expect(revision.model.mcp.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(revision.model.mcp.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "addPet",
        "getPet",
        "listInventory",
      ]);

      // One operation per tool, plus one per protocol method the server said it supports. The
      // tool operations are what per-tool policy and per-tool validation attach to.
      const ids = revision.model.operations.map((op: { operationId: string }) => op.operationId);
      expect(ids).toContain("tools/call:getPet");
      expect(ids).toContain("tools/list");
      expect(ids).toContain("resources/read");
      expect(ids).toContain("prompts/get");
      // Nothing beyond what the protocol defines and the server declared: a method invented here
      // would be an operation the server answers -32601 to, published as if it worked.
      expect(ids).not.toContain("sampling/createMessage");
      expect(ids).not.toContain("completion/complete");

      // The handshake really happened, and the session it minted was carried on every later call.
      expect(origin.server.stats.sessions).toBe(1);
      expect(origin.server.stats.calls["tools/list"]).toBe(1);
      expect(origin.server.stats.calls["notifications/initialized"]).toBe(1);

      // Where it came from, so `regenerate` knows what to re-ask.
      const detail = await (await cp.call("GET", `/api/resources/${resourceId}`, {
        cookie: await cp.login("pavel"),
      })).json();
      expect(detail.revisions[0].original_format).toBe("mcp-manifest");
    } finally {
      origin.stop();
    }
  });

  test("a paging server is followed to the end", async () => {
    const origin = startServer({ pageSize: 2 });
    try {
      const { response } = await publishMcp(origin.url);
      expect(response.status).toBe(201);
      const revision = await response.json();
      expect(revision.model.mcp.tools.length).toBe(3);
      // Two pages of tools, and one each for the other two lists.
      expect(origin.server.stats.calls["tools/list"]).toBe(2);
    } finally {
      origin.stop();
    }
  });

  test("the manifest is stored verbatim as the original", async () => {
    const origin = startServer();
    try {
      const { pavel, response } = await publishMcp(origin.url);
      const revision = await response.json();
      const stored = await cp.call("GET", `/api/revisions/${revision.id}/spec?format=original`, {
        cookie: pavel,
      });
      expect(stored.headers.get("x-original-format")).toBe("mcp-manifest");
      const original = JSON.parse(await stored.text());
      expect(original.serverInfo.name).toBe("petstore-mcp");
      expect(original.originUrl).toBe(origin.url);
      // Verbatim means the tool's own schema, not a rewritten one: that is what a publisher reads
      // years later to answer "what did this server say when we published it".
      expect(original.tools.find((t: { name: string }) => t.name === "getPet").inputSchema).toEqual({
        type: "object",
        required: ["petId"],
        additionalProperties: false,
        properties: { petId: { type: "integer", minimum: 1, description: "The pet's id" } },
      });
    } finally {
      origin.stop();
    }
  });

  test("a URL outside the egress allowlist is refused before anything is fetched", async () => {
    const { response } = await publishMcp("http://mcp.example.com:8080/mcp");
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("not in the egress allowlist");
  });

  test("discoverUrl on a rest API says what to use instead", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: `r-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
      })
    ).json();
    const response = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: { discoverUrl: "http://127.0.0.1:9999/mcp" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("use specUrl or spec");
  });

  test("an uploaded manifest works too, and a non-manifest is refused", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "mcp", name: `mcp-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
      })
    ).json();

    const wrong = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: { spec: { openapi: "3.0.0", info: { title: "no", version: "1" }, paths: {} } },
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).detail).toContain("serverInfo and capabilities");

    const right = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: {
        spec: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "hand-written", version: "0.1.0" },
          capabilities: { tools: {} },
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
      },
    });
    expect(right.status).toBe(201);
    expect((await right.json()).model.operations.map((op: { operationId: string }) => op.operationId))
      .toContain("tools/call:echo");
  });
});

// --------------------------------------------------------------------------- regenerate

describe("regenerate", () => {
  test("an unchanged server produces no revision; a changed one produces an unreleased revision", async () => {
    const origin = startServer();
    try {
      const { pavel, resourceId } = await publishMcp(origin.url);

      const same = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, { cookie: pavel });
      expect(same.status).toBe(200);
      expect((await same.json()).unchanged).toBe(true);

      // The server gains a tool. That is a contract change, so it is a new revision that nobody
      // has released — not a silent edit under the consumers who subscribed to the old one.
      origin.server.options.pageSize = 2;
      const changed = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, {
        cookie: pavel,
      });
      // Paging changes nothing about the contract, so this is still "unchanged": the assertion is
      // that the digest is over the *model*, not over how it was fetched.
      expect(changed.status).toBe(200);
      expect((await changed.json()).unchanged).toBe(true);
    } finally {
      origin.stop();
    }
  });

  test("a server that renames a tool is a new revision, and the old one is untouched", async () => {
    const first = startServer({ name: "petstore-mcp" });
    const { pavel, resourceId } = await publishMcp(first.url);
    first.stop();

    // The "same" server, at a new address, now calling itself something else. Only the manifest
    // matters — the digest is over the model, so a new name is a new contract.
    const second = startServer({ name: "petstore-mcp", version: "2.0.0" });
    try {
      const response = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, {
        cookie: pavel,
        body: {},
      });
      // The stored discovery URL is the old one, which is gone. Regeneration fails loudly rather
      // than inventing a contract — and as a 502, because the request was fine and the endpoint
      // somebody registered is what is down.
      expect(response.status).toBe(502);
      expect((await response.json()).detail).toContain("could not be reached");

      // Point it at the live one and it succeeds with rev 2.
      const rediscovered = await cp.call("POST", `/api/resources/${resourceId}/revisions`, {
        cookie: pavel,
        body: { discoverUrl: second.url },
      });
      expect(rediscovered.status).toBe(201);
      const revision = await rediscovered.json();
      expect(revision.rev).toBe(2);
      expect(revision.model.version).toBe("2.0.0");

      // And the next regenerate re-asks the *new* address.
      const again = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, { cookie: pavel });
      expect(again.status).toBe(200);
      expect((await again.json()).unchanged).toBe(true);
    } finally {
      second.stop();
    }
  });

  test("regenerating an uploaded contract says there is nothing to re-ask", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "mcp", name: `mcp-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
      })
    ).json();
    await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: {
        spec: {
          serverInfo: { name: "hand-written" },
          capabilities: { tools: {} },
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
      },
    });
    const response = await cp.call("POST", `/api/resources/${created.id}/regenerate`, {
      cookie: pavel,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("not published from a live endpoint");
  });
});

// --------------------------------------------------------------------------- serving

interface McpWorld {
  dp: DataPlane;
  origin: ReturnType<typeof startServer>;
  key: string;
  basePath: string;
  resourceId: string;
  stop: () => void;
}

async function world(policy: Record<string, unknown> = {}): Promise<McpWorld> {
  const origin = startServer();
  const basePath = `/m-${++seq}`;
  const { pavel, resourceId, response } = await publishMcp(origin.url);
  if (response.status !== 201) throw new Error(`publish failed: ${await response.text()}`);

  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie: pavel,
    body: { environment: "dev", host: "*", basePath },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie: pavel,
    body: { environment: "dev", urls: [new URL(origin.url).origin] },
  });
  // `rewrite.path` rather than `stripBasePath`: the origin serves JSON-RPC at /mcp and the route's
  // base path is where consumers find it here. One endpoint, two names.
  const units: Record<string, unknown> = {
    rewrite: { stripBasePath: true, path: "/mcp" },
    "auth.subscriptionKey": { in: "header", name: "x-api-key" },
    ...policy,
  };
  for (const [unitKey, value] of Object.entries(units)) {
    const written = await cp.call(
      "PUT",
      `/api/resources/${resourceId}/policy/units/${encodeURIComponent(unitKey)}`,
      { cookie: pavel, body: { value } },
    );
    if (!written.ok) throw new Error(`policy ${unitKey}: ${written.status} ${await written.text()}`);
  }

  const product = await (
    await cp.call("POST", "/api/products", {
      cookie: pavel,
      body: { name: `mcp-product-${seq}`, applicationId: "application_platform", resourceIds: [resourceId] },
    })
  ).json();
  await cp.call("POST", `/api/resources/${resourceId}/releases`, {
    cookie: pavel,
    body: { revision: 1, environment: "dev" },
  });

  const clara = await cp.login("clara");
  const subscription = await activeSubscription(cp, clara, product.id);

  const cpServer = serveCp(cp);
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `m-${seq}` });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);

  return {
    dp,
    origin,
    key: subscription.primaryKey as string,
    basePath,
    resourceId,
    stop: () => {
      dp.stop();
      cpServer.stop();
      origin.stop();
    },
  };
}

/** One JSON-RPC call through the gateway. */
async function rpc(
  w: McpWorld,
  body: unknown,
  init: { key?: string | null; headers?: Record<string, string> } = {},
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  const key = init.key === undefined ? w.key : init.key;
  if (key) headers["x-api-key"] = key;
  const response = await w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}`, { method: "POST", headers, body: JSON.stringify(body) }),
    "127.0.0.1",
  );
  const text = await response.text();
  return { response, payload: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/**
 * The handshake, as a header to carry. The demo server requires the session it minted on every
 * later call — as a real one does — so this is also the assertion that `Mcp-Session-Id` survives
 * both directions of the proxy without the gateway knowing what it is (plan `[R2-14]`).
 */
async function session(w: McpWorld): Promise<Record<string, string>> {
  const init = await rpc(w, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
  });
  const id = init.response.headers.get(MCP_SESSION_HEADER);
  if (!id) throw new Error(`initialize minted no session (HTTP ${init.response.status})`);
  return { [MCP_SESSION_HEADER]: id };
}

describe("serving", () => {
  test("initialize, tools/list and tools/call all work through the gateway", async () => {
    const w = await world();
    try {
      const init = await rpc(w, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
      });
      expect(init.response.status).toBe(200);
      const session = init.response.headers.get(MCP_SESSION_HEADER);
      // The session header is copied both ways with no special handling — it is just a header the
      // proxy does not consider hop-by-hop (plan `[R2-14]`).
      expect(session).toBeTruthy();
      expect((init.payload.result as Record<string, unknown>).serverInfo).toEqual({
        name: "petstore-mcp",
        version: "1.0.0",
      });

      const listed = await rpc(
        w,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { headers: { [MCP_SESSION_HEADER]: session! } },
      );
      expect(listed.response.status).toBe(200);
      const tools = (listed.payload.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["addPet", "getPet", "listInventory"]);

      const called = await rpc(
        w,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "getPet", arguments: { petId: 1 } },
        },
        { headers: { [MCP_SESSION_HEADER]: session! } },
      );
      expect(called.response.status).toBe(200);
      const content = (called.payload.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0]!.text)).toEqual({ id: 1, name: "doggie", status: "available" });
    } finally {
      w.stop();
    }
  });

  test("a rejection is a JSON-RPC error, not problem+json", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(
        w,
        { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
        { key: null },
      );
      // The status is real, because an edge proxy reads nothing else — and the body is JSON-RPC,
      // because an MCP client reads nothing else (plan section 9.3, `[R4-05]`).
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(payload.jsonrpc).toBe("2.0");
      expect((payload.error as { code: number }).code).toBe(-32001);
      expect(payload.type).toBeUndefined();
      // The id is the request's, because the body had already been parsed when the rejection was
      // decided… except here it had not: authentication is step 6 and parsing is step 11.
      expect(payload.id).toBeNull();
      expect(w.origin.server.stats.calls["tools/list"]).toBe(1); // discovery only
    } finally {
      w.stop();
    }
  });

  test("each tool's inputSchema is enforced before the server is reached", async () => {
    const w = await world();
    try {
      const before = w.origin.server.stats.calls["tools/call"] ?? 0;
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "getPet", arguments: { petId: "one" } },
      });
      expect(response.status).toBe(400);
      const error = payload.error as { code: number; message: string; data?: Record<string, unknown> };
      expect(error.code).toBe(-32602);
      expect(error.message).toContain("petId");
      // Rejected here, so the server never saw it — which is the whole reason validation is at the
      // gateway rather than in every server.
      expect(w.origin.server.stats.calls["tools/call"] ?? 0).toBe(before);
      // The id is the request's now, because the body was parsed before the rejection was decided.
      expect(payload.id).toBe(4);
    } finally {
      w.stop();
    }
  });

  test("an unknown tool and an unknown method are -32601 and never reach the server", async () => {
    const w = await world();
    try {
      const before = w.origin.server.stats.calls["tools/call"] ?? 0;
      const unknownTool = await rpc(w, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "deletePet", arguments: {} },
      });
      expect(unknownTool.response.status).toBe(404);
      expect((unknownTool.payload.error as { code: number }).code).toBe(-32601);
      expect((unknownTool.payload.error as { message: string }).message).toContain("tools/call:deletePet");

      const unknownMethod = await rpc(w, { jsonrpc: "2.0", id: 6, method: "sampling/createMessage" });
      expect(unknownMethod.response.status).toBe(404);
      expect((unknownMethod.payload.error as { code: number }).code).toBe(-32601);

      expect(w.origin.server.stats.calls["tools/call"] ?? 0).toBe(before);
      expect(w.origin.server.stats.calls["sampling/createMessage"]).toBeUndefined();
    } finally {
      w.stop();
    }
  });

  test("a batch is refused rather than partly applied", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]);
      expect(response.status).toBe(400);
      expect((payload.error as { message: string }).message).toContain("batched JSON-RPC");
    } finally {
      w.stop();
    }
  });

  test("a JSON-RPC error from the server is 200 and counted as rpc-error, not upstream-error", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(
        w,
        { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "pet://nope" } },
        { headers: await session(w) },
      );
      // The server is working correctly; the answer is "no". Both facts have to survive.
      expect(response.status).toBe(200);
      expect((payload.error as { code: number }).code).toBe(-32602);

      const outcomes = w.dp.telemetry
        .snapshot()
        .windows.flatMap((window) => window.series)
        .filter((series) => series.resourceId === w.resourceId);
      expect(outcomes.some((s) => s.outcome === "rpc-error" && s.status === 200)).toBe(true);
      expect(outcomes.some((s) => s.outcome === "upstream-error")).toBe(false);
    } finally {
      w.stop();
    }
  });

  test("per-operation policy is per tool", async () => {
    const w = await world({
      'operations["tools/call:getPet"].rateLimit': {
        calls: 1,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      },
    });
    try {
      const headers = await session(w);
      const call = () =>
        rpc(
          w,
          {
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "getPet", arguments: { petId: 1 } },
          },
          { headers },
        );
      expect((await call()).response.status).toBe(200);
      const limited = await call();
      expect(limited.response.status).toBe(429);
      expect((limited.payload.error as { code: number }).code).toBe(-32003);

      // A different tool on the same route is unaffected: the limit is the operation's.
      const other = await rpc(
        w,
        { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "listInventory", arguments: {} } },
        { headers },
      );
      expect(other.response.status).toBe(200);
    } finally {
      w.stop();
    }
  });

  test("GET and DELETE need passthrough.sse, and say so when it is missing", async () => {
    const w = await world();
    try {
      const refused = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}`, {
          headers: { "x-api-key": w.key, accept: "text/event-stream" },
        }),
        "127.0.0.1",
      );
      expect(refused.status).toBe(405);
      const payload = await refused.json();
      expect((payload.error as { message: string }).message).toContain("passthrough.sse");
    } finally {
      w.stop();
    }
  });

  test("with passthrough.sse the server→client stream is proxied and DELETE ends the session", async () => {
    const w = await world({ passthrough: { sse: true } });
    try {
      const stream = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}`, {
          headers: { "x-api-key": w.key, accept: "text/event-stream" },
        }),
        "127.0.0.1",
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(": open\n\n");
      expect(w.dp.streams.snapshot().open).toBe(1);
      await reader.cancel();

      const ended = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}`, {
          method: "DELETE",
          headers: { "x-api-key": w.key, [MCP_SESSION_HEADER]: "whatever" },
        }),
        "127.0.0.1",
      );
      expect(ended.status).toBe(204);
    } finally {
      w.stop();
    }
  });
});

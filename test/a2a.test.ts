import { activeSubscription } from './helpers.ts';
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, makeDp, serveCp, type TestCp } from "./helpers.ts";
import { A2aAgent, startA2aAgent } from "../tools/a2a/agent.ts";
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from "../shared/a2a.ts";
import type { DataPlane } from "../data-plane/src/server.ts";
import type { Integrations } from "../control-plane/src/egress.ts";

/**
 * Goal 5: publish an existing A2A agent and subscribe to it like an API.
 *
 * The card is what makes this variant different from every other. An Agent Card is not only a
 * contract, it is an *advertisement* — it names a URL, and consumers follow it. So the assertion
 * that matters is not "the card is served" but "the card the gateway serves is not the origin's":
 * publishing an agent means consumers talk to us, and a card that still pointed past us would send
 * every one of them around every policy (plan `[R1-16]`).
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

function startAgent(options: Partial<ConstructorParameters<typeof A2aAgent>[0]> = {}) {
  const agent = new A2aAgent({ port: 0, ...options });
  const server = startA2aAgent(agent);
  return { agent, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function publishA2a(discoverUrl: string) {
  const pavel = await cp.login("pavel");
  const created = await (
    await cp.call("POST", "/api/resources", {
      cookie: pavel,
      body: { kind: "a2a", name: `a2a-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
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
  test("the card becomes the contract: skills, capabilities and the methods they imply", async () => {
    const origin = startAgent();
    try {
      const { response } = await publishA2a(origin.url);
      expect(response.status).toBe(201);
      const revision = await response.json();

      expect(revision.format).toBe("a2a-agent-card");
      expect(revision.model.title).toBe("Shelter agent");
      expect(revision.model.a2a.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
      expect(revision.model.a2a.originUrl).toBe(origin.url);
      expect(revision.model.a2a.skills.map((s: { id: string }) => s.id)).toEqual([
        "pet-lookup",
        "adoption-advice",
      ]);
      // The binding can be prefilled from the card the way a WSDL's soap:address prefills one.
      expect(revision.model.servers).toEqual([origin.url]);

      const ids = revision.model.operations.map((op: { operationId: string }) => op.operationId);
      expect(ids).toContain("message/send");
      // `capabilities.streaming` is true, so the streaming methods exist as operations.
      expect(ids).toContain("message/stream");
      expect(ids).toContain("tasks/resubscribe");
      // `pushNotifications` is false, so those do not — an operation the agent would refuse is
      // worse than no operation, because it reads as supported in the catalog.
      expect(ids).not.toContain("tasks/pushNotificationConfig/set");
      expect(origin.agent.stats.cardsServed).toBe(1);
    } finally {
      origin.stop();
    }
  });

  test("a base URL, the card's own URL and the pre-0.3 location all work", async () => {
    const origin = startAgent();
    try {
      const direct = await publishA2a(`${origin.url}${AGENT_CARD_PATH}`);
      expect(direct.response.status).toBe(201);
      // A trailing slash is the same endpoint, not a second one.
      const trailing = await publishA2a(`${origin.url}/`);
      expect(trailing.response.status).toBe(201);
      expect(origin.agent.stats.cardsServed).toBe(2);
    } finally {
      origin.stop();
    }
  });

  test("an agent with no card says where one should be", async () => {
    // A server that answers 404 everywhere: the card is missing rather than the host unreachable,
    // and those two read differently to whoever is fixing it.
    const bare = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    try {
      const { response } = await publishA2a(`http://127.0.0.1:${bare.port}`);
      expect(response.status).toBe(400);
      const detail = (await response.json()).detail as string;
      expect(detail).toContain("no agent card was found");
      expect(detail).toContain(AGENT_CARD_PATH);
    } finally {
      bare.stop(true);
    }
  });

  test("an unreachable agent is 502, not a complaint about the request", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);
    const { response } = await publishA2a(`http://127.0.0.1:${port}`);
    expect(response.status).toBe(502);
    expect((await response.json()).detail).toContain("could not be reached");
  });

  test("a URL outside the egress allowlist is refused before anything is fetched", async () => {
    const { response } = await publishA2a("http://agent.example.com:8080");
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("not in the egress allowlist");
  });

  test("an uploaded card works, and something that is not a card is refused", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "a2a", name: `a2a-${++seq}`, applicationId: "application_platform", apiVersion: "v1" },
      })
    ).json();

    const wrong = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: { spec: { openapi: "3.0.0", info: { title: "no", version: "1" }, paths: {} } },
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).detail).toContain("Agent Card");

    const right = await cp.call("POST", `/api/resources/${created.id}/revisions`, {
      cookie: pavel,
      body: {
        spec: {
          protocolVersion: A2A_PROTOCOL_VERSION,
          name: "Hand-written agent",
          version: "0.1.0",
          url: "http://127.0.0.1:9999",
          capabilities: {},
          skills: [{ id: "greet", name: "Greet", tags: ["hello"] }],
        },
      },
    });
    expect(right.status).toBe(201);
    const revision = await right.json();
    const ids = revision.model.operations.map((op: { operationId: string }) => op.operationId);
    expect(ids).toContain("message/send");
    // No streaming capability, so no streaming operations.
    expect(ids).not.toContain("message/stream");
  });

  test("regenerate follows a card that changed", async () => {
    const first = startAgent({ version: "1.0.0" });
    const { pavel, resourceId } = await publishA2a(first.url);
    const unchanged = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, {
      cookie: pavel,
    });
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).unchanged).toBe(true);

    // The agent ships a new version of itself at the same address.
    first.agent.options.version = "2.0.0";
    const changed = await cp.call("POST", `/api/resources/${resourceId}/regenerate`, { cookie: pavel });
    try {
      expect(changed.status).toBe(201);
      const revision = await changed.json();
      expect(revision.rev).toBe(2);
      expect(revision.model.version).toBe("2.0.0");

      // Unreleased: what consumers get is still rev 1 until somebody decides otherwise.
      const detail = await (
        await cp.call("GET", `/api/resources/${resourceId}`, { cookie: pavel })
      ).json();
      expect(detail.releases.length).toBe(0);
    } finally {
      first.stop();
    }
  });
});

// --------------------------------------------------------------------------- serving

interface A2aWorld {
  dp: DataPlane;
  origin: ReturnType<typeof startAgent>;
  key: string;
  basePath: string;
  resourceId: string;
  stop: () => void;
}

async function world(
  options: { policy?: Record<string, unknown>; visibility?: "listed" | "unlisted" } = {},
): Promise<A2aWorld> {
  const origin = startAgent();
  const basePath = `/a-${++seq}`;
  const { pavel, resourceId, response } = await publishA2a(origin.url);
  if (response.status !== 201) throw new Error(`publish failed: ${await response.text()}`);

  if (options.visibility) {
    const current = await cp.call("GET", `/api/resources/${resourceId}`, { cookie: pavel });
    const patched = await cp.call("PATCH", `/api/resources/${resourceId}`, {
      cookie: pavel,
      headers: { "if-match": current.headers.get("etag")! },
      body: { visibility: options.visibility },
    });
    if (!patched.ok) throw new Error(`visibility: ${patched.status} ${await patched.text()}`);
  }

  await cp.call("PUT", `/api/resources/${resourceId}/routes`, {
    cookie: pavel,
    body: { environment: "dev", host: "*", basePath },
  });
  await cp.call("PUT", `/api/resources/${resourceId}/binding`, {
    cookie: pavel,
    body: { environment: "dev", urls: [origin.url] },
  });
  const units: Record<string, unknown> = {
    rewrite: { stripBasePath: true },
    "auth.subscriptionKey": { in: "header", name: "x-api-key" },
    ...options.policy,
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
      body: { name: `a2a-product-${seq}`, applicationId: "application_platform", resourceIds: [resourceId] },
    })
  ).json();
  await cp.call("POST", `/api/resources/${resourceId}/releases`, {
    cookie: pavel,
    body: { revision: 1, environment: "dev" },
  });

  const clara = await cp.login("clara");
  const subscription = await activeSubscription(cp, clara, product.id);

  const cpServer = serveCp(cp);
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `a-${seq}` });
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

async function rpc(
  w: A2aWorld,
  body: unknown,
  init: { key?: string | null } = {},
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = init.key === undefined ? w.key : init.key;
  if (key) headers["x-api-key"] = key;
  const response = await w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}`, { method: "POST", headers, body: JSON.stringify(body) }),
    "127.0.0.1",
  );
  const text = await response.text();
  return { response, payload: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function getCard(w: A2aWorld, key?: string): Promise<Response> {
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}${AGENT_CARD_PATH}`, {
      headers: key ? { "x-api-key": key } : {},
    }),
    "127.0.0.1",
  );
}

describe("the card the gateway serves", () => {
  test("is the origin's, with the URL and the security schemes replaced by ours", async () => {
    const w = await world();
    try {
      const response = await getCard(w);
      expect(response.status).toBe(200);
      const card = await response.json();

      // The whole point. A consumer that follows this card reaches the gateway.
      expect(card.url).toBe(`http://gw${w.basePath}`);
      expect(card.url).not.toContain(new URL(w.origin.url).port);
      // And presents the key we issued, not a token the origin would have wanted.
      expect(card.securitySchemes).toEqual({
        subscriptionKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "A subscription key issued by the Integration Portal for this product.",
        },
      });
      expect(card.security).toEqual([{ subscriptionKey: [] }]);

      // Everything that describes what the agent *does* survives untouched: this is the same
      // agent, reachable somewhere else.
      expect(card.name).toBe("Shelter agent");
      expect(card.capabilities).toEqual({ streaming: true });
      expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["pet-lookup", "adoption-advice"]);
      expect(card.provider.organization).toBe("Petstore Shelter");

      // Answered from config: the origin was never asked (it served exactly one card, at publish).
      expect(w.origin.agent.stats.cardsServed).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("is public for a listed agent and needs the key for an unlisted one", async () => {
    const listed = await world();
    try {
      expect((await getCard(listed)).status).toBe(200);
    } finally {
      listed.stop();
    }

    const unlisted = await world({ visibility: "unlisted" });
    try {
      // Discovery precedes credentials, but only for something meant to be discovered (`[R1-17]`).
      expect((await getCard(unlisted)).status).toBe(401);
      const withKey = await getCard(unlisted, unlisted.key);
      expect(withKey.status).toBe(200);
      expect((await withKey.json()).name).toBe("Shelter agent");
    } finally {
      unlisted.stop();
    }
  });

  test("is served under the route's base path only", async () => {
    const w = await world();
    try {
      const elsewhere = await w.dp.fetchHttp(
        new Request(`http://gw${AGENT_CARD_PATH}`),
        "127.0.0.1",
      );
      expect(elsewhere.status).toBe(404);
    } finally {
      w.stop();
    }
  });

  test("ipAllow still applies to it, because it is served after step 5", async () => {
    const w = await world({ policy: { ipAllow: ["10.0.0.0/8"] } });
    try {
      const denied = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}${AGENT_CARD_PATH}`),
        "127.0.0.1",
      );
      expect(denied.status).toBe(403);
      const allowed = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}${AGENT_CARD_PATH}`),
        "10.1.2.3",
      );
      expect(allowed.status).toBe(200);
    } finally {
      w.stop();
    }
  });
});

describe("serving", () => {
  test("message/send is proxied, validated and counted", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            role: "user",
            kind: "message",
            messageId: "m1",
            parts: [{ kind: "text", text: "is doggie available?" }],
          },
        },
      });
      expect(response.status).toBe(200);
      const status = (payload.result as { status: { message: { parts: Array<{ text: string }> } } })
        .status;
      expect(status.message.parts[0]!.text).toBe("doggie is available.");
      expect(w.origin.agent.stats.calls["message/send"]).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("a malformed message is rejected here, with the JSON pointer that failed", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        // `role` is required and `parts` must have at least one entry.
        params: { message: { kind: "message", parts: [] } },
      });
      expect(response.status).toBe(400);
      const error = payload.error as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toMatch(/role|parts/);
      expect(w.origin.agent.stats.calls["message/send"]).toBeUndefined();
    } finally {
      w.stop();
    }
  });

  test("message/stream without passthrough.sse is refused rather than buffered", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 3,
        method: "message/stream",
        params: {
          message: { role: "user", kind: "message", parts: [{ kind: "text", text: "kitty?" }] },
        },
      });
      // A gateway that proxied this would read the whole stream before answering, turning a
      // stream into a single late response. Saying no is the honest answer.
      expect(response.status).toBe(503);
      expect((payload.error as { code: number }).code).toBe(-32004);
      expect((payload.error as { message: string }).message).toContain("streaming is not enabled");
      expect(w.origin.agent.stats.calls["message/stream"]).toBeUndefined();
    } finally {
      w.stop();
    }
  });

  test("message/stream with passthrough.sse streams, event by event", async () => {
    const w = await world({ policy: { passthrough: { sse: true } } });
    try {
      const response = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": w.key },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "message/stream",
            params: {
              message: { role: "user", kind: "message", parts: [{ kind: "text", text: "kitty?" }] },
            },
          }),
        }),
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(w.dp.streams.snapshot().open).toBe(1);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      // Two states, in order, each a whole JSON-RPC response — a stream of answers rather than one
      // answer delivered in pieces.
      expect(text.indexOf('"working"')).toBeGreaterThan(-1);
      expect(text.indexOf('"completed"')).toBeGreaterThan(text.indexOf('"working"'));
      expect(text).toContain("kitty is pending.");
      expect(w.dp.streams.snapshot().open).toBe(0);
    } finally {
      w.stop();
    }
  });

  test("tasks/cancel on an unknown task is a JSON-RPC error, counted as rpc-error", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 5,
        method: "tasks/cancel",
        params: { id: "no-such-task" },
      });
      // The agent is working; the answer is "no such task". A 200 carrying an error, counted as
      // the agent's answer rather than as the gateway's failure.
      expect(response.status).toBe(200);
      expect((payload.error as { code: number }).code).toBe(-32001);
      const series = w.dp.telemetry
        .snapshot()
        .windows.flatMap((window) => window.series)
        .filter((entry) => entry.resourceId === w.resourceId);
      expect(series.some((entry) => entry.outcome === "rpc-error" && entry.status === 200)).toBe(true);
    } finally {
      w.stop();
    }
  });

  test("a method the card never implied is -32601 and never reaches the agent", async () => {
    const w = await world();
    try {
      const { response, payload } = await rpc(w, {
        jsonrpc: "2.0",
        id: 6,
        method: "tasks/pushNotificationConfig/set",
        params: { taskId: "t", pushNotificationConfig: { url: "http://elsewhere.invalid/hook" } },
      });
      expect(response.status).toBe(404);
      expect((payload.error as { code: number }).code).toBe(-32601);
      expect(w.origin.agent.stats.calls["tasks/pushNotificationConfig/set"]).toBeUndefined();
    } finally {
      w.stop();
    }
  });

  test("GET on an a2a route that is not the card is 405, not the card", async () => {
    const w = await world();
    try {
      const response = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/anything`, { headers: { "x-api-key": w.key } }),
        "127.0.0.1",
      );
      expect(response.status).toBe(405);
      expect((await response.json()).error.message).toContain("accepts POST");
    } finally {
      w.stop();
    }
  });
});

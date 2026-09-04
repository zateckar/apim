import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";
import { startDataPlane, type DataPlane, type DpConfig } from "../data-plane/src/server.ts";
import { PetstoreBackend, startBackend as startPetstore } from "../tools/backend/server.ts";

/**
 * Goal 3, design section 5.8: `passthrough` — WebSocket and SSE — and the stream registry.
 *
 * A stream is the one thing in this gateway that outlives the request that created it, so it is
 * the one thing whose limits cannot be expressed as "per request". Everything here is therefore
 * about *ending* a stream: a byte budget, an idle timeout, a lifetime, a revocation, and the two
 * concurrency ceilings. The exclusion table is tested at write time rather than at request time,
 * because a route that buffers is not a route that streams and there is no useful behaviour to
 * define for the combination — only a config error.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "feed", version: "1.0.0" },
  paths: {
    "/events": { get: { operationId: "streamEvents", responses: { "200": { description: "ok" } } } },
    "/ws": { get: { operationId: "openSocket", responses: { "200": { description: "ok" } } } },
  },
};

let cp: TestCp;
let seq = 0;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

// --------------------------------------------------------------------------- small helpers

async function until(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** The comment every real SSE server sends first, so the headers are on the wire before an event. */
const PREAMBLE = ": open\n\n";

/**
 * A backend-side event stream the test drives by hand, one event at a time.
 *
 * The preamble is not decoration. A response whose body has been produced but never written keeps
 * its headers in the sender's buffer, so the gateway's own `fetch` would not resolve and the test
 * would deadlock against its own event — which is exactly the mistake a real SSE backend makes
 * once and then never again.
 */
function eventSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Already closed by the gateway cancelling its end, which is most of what this file tests.
    }
  };
  const send = (text: string) => guard(() => controller.enqueue(encoder.encode(text)));
  send(PREAMBLE);
  return {
    stream,
    send,
    end: () => guard(() => controller.close()),
    fail: () => guard(() => controller.error(new Error("the backend stopped mid-stream"))),
    response: () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      }),
  };
}

/**
 * One chunk, or a failure that names what was being waited for. Never leaves a read pending: a
 * second `read()` on a reader that already has one in flight throws, and half these tests read
 * again after the stream has been closed from the other side.
 */
async function chunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 3000,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([reader.read(), expired]);
    if (result === "timeout") throw new Error(`no chunk within ${timeoutMs}ms`);
    return result.done ? null : new TextDecoder().decode(result.value);
  } finally {
    clearTimeout(timer);
  }
}

/** `null` for a clean end, `"error"` for a stream the gateway tore down under the consumer. */
async function ending(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  try {
    return await chunk(reader);
  } catch {
    return "error";
  }
}

function seriesFor(dp: DataPlane, outcome: string) {
  return dp.telemetry
    .snapshot()
    .windows.flatMap((window) => window.series)
    .filter((series) => series.outcome === outcome);
}

// --------------------------------------------------------------------------- the SSE world

interface SseWorld {
  dp: DataPlane;
  key: string;
  basePath: string;
  backend: ReturnType<typeof startBackend>;
  subscriptionId: string;
  clara: string;
  stop: () => void;
}

async function sseWorld(
  passthrough: Record<string, unknown>,
  handler: (req: Request) => Response | Promise<Response>,
  options: { dp?: Partial<DpConfig>; policy?: Record<string, unknown> } = {},
): Promise<SseWorld> {
  const basePath = `/s-${++seq}`;
  const backend = startBackend(handler);
  const cpServer = serveCp(cp);
  const api = await publishApi(cp, {
    backendUrl: backend.url,
    basePath,
    spec: SPEC,
    policy: {
      rewrite: { stripBasePath: true },
      "auth.subscriptionKey": { in: "header", name: "x-api-key" },
      passthrough,
      ...options.policy,
    },
  });
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `s-${seq}`, ...options.dp });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
  return {
    dp,
    key: api.key!,
    basePath,
    backend,
    subscriptionId: api.subscriptionId!,
    clara: api.clara,
    stop: () => {
      dp.stop();
      cpServer.stop();
      backend.stop();
    },
  };
}

function openSse(w: SseWorld, path = "/events", key = w.key): Promise<Response> {
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}${path}`, { headers: { "x-api-key": key } }),
    "127.0.0.1",
  );
}

/** Opens the stream and consumes the preamble, so a test's first `chunk` is its first event. */
async function openEvents(w: SseWorld) {
  const response = await openSse(w);
  const reader = response.body!.getReader();
  const first = await chunk(reader);
  if (first !== PREAMBLE) {
    throw new Error(`expected the SSE preamble first, got ${JSON.stringify(first)}`);
  }
  return { response, reader };
}

// --------------------------------------------------------------------------- the WebSocket world

interface WsWorld {
  dp: DataPlane;
  url: string;
  key: string;
  basePath: string;
  backend: ReturnType<typeof wsBackend>;
  subscriptionId: string;
  clara: string;
  stop: () => void;
}

/** A backend that speaks WebSocket, and records the upgrade request so headers stay assertable. */
function wsBackend() {
  const upgrades: Array<Record<string, string>> = [];
  const received: string[] = [];
  const sockets: Array<ServerWebSocket<undefined>> = [];
  const server = Bun.serve<undefined, never>({
    port: 0,
    idleTimeout: 30,
    fetch(req, server) {
      upgrades.push({ ...Object.fromEntries(req.headers), ":path": new URL(req.url).pathname });
      if (server.upgrade(req)) return undefined;
      return new Response("expected a websocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(ws, message) {
        received.push(String(message));
        ws.send(`echo:${message}`);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    upgrades,
    received,
    sockets,
    stop: () => server.stop(true),
  };
}

async function wsWorld(
  passthrough: Record<string, unknown>,
  options: { dp?: Partial<DpConfig>; policy?: Record<string, unknown> } = {},
): Promise<WsWorld> {
  const basePath = `/w-${++seq}`;
  const backend = wsBackend();
  const cpServer = serveCp(cp);
  const api = await publishApi(cp, {
    backendUrl: backend.url,
    basePath,
    spec: SPEC,
    policy: {
      rewrite: { stripBasePath: true },
      // In the query rather than a header: a browser cannot set headers on a WebSocket handshake,
      // so this is the only shape that works for the callers this feature exists for.
      "auth.subscriptionKey": { in: "query", name: "key" },
      passthrough,
      ...options.policy,
    },
  });
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `w-${seq}`, ...options.dp });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
  const server = startDataPlane(dp);
  return {
    dp,
    url: `ws://127.0.0.1:${server.port}${basePath}`,
    key: api.key!,
    basePath,
    backend,
    subscriptionId: api.subscriptionId!,
    clara: api.clara,
    stop: () => {
      server.stop(true);
      dp.stop();
      cpServer.stop();
      backend.stop();
    },
  };
}

interface WsClient {
  socket: WebSocket;
  messages: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

function wsClient(url: string): WsClient {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(typeof event.data === "string" ? event.data : "<binary>");
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the upgrade was refused")));
    socket.addEventListener("close", (event) =>
      reject(new Error(`closed before opening: ${event.code} ${event.reason}`)),
    );
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
  // Nothing else awaits `opened` on the rejection paths, and an unobserved rejection is noise.
  opened.catch(() => {});
  return { socket, messages, opened, closed };
}

/** An upgrade request that is *answered*, so the rejection body can be read (plan `[R3-09]`). */
function probeUpgrade(w: WsWorld, query = `?key=${w.key}`, ip = "127.0.0.1"): Promise<Response> {
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}/ws${query}`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    }),
    ip,
  );
}

// --------------------------------------------------------------------- the exclusion table

describe("§5.8's exclusion table, at write time", () => {
  async function draft(kind: "rest" | "soap" = "rest") {
    const cookie = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie,
        body: { kind, name: `x-${++seq}`, teamId: "team_platform", apiVersion: "v1" },
      })
    ).json();
    return { id: created.id as string, cookie };
  }

  function put(id: string, cookie: string, unitKey: string, value: unknown) {
    return cp.call("PUT", `/api/resources/${id}/policy/units/${encodeURIComponent(unitKey)}`, {
      cookie,
      body: { value },
    });
  }

  test("a passthrough unit that enables neither protocol is refused", async () => {
    const { id, cookie } = await draft();
    const response = await put(id, cookie, "passthrough", { streamIdleTimeoutSec: 30 });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("expected websocket or sse to be true");
  });

  test("websocket forbids request validation, whichever unit is written second", async () => {
    const first = await draft();
    expect((await put(first.id, first.cookie, "passthrough", { websocket: true })).status).toBe(200);
    const late = await put(first.id, first.cookie, "validate", { request: "blocking" });
    expect(late.status).toBe(400);
    expect((await late.json()).detail).toContain("no complete message to validate");

    // The check is on the assembled document, not on the unit being written, so the other order
    // has to fail too — otherwise the same pair of units is legal or not depending on typing order.
    const second = await draft();
    expect((await put(second.id, second.cookie, "validate", { request: "blocking" })).status).toBe(200);
    const reverse = await put(second.id, second.cookie, "passthrough", { websocket: true });
    expect(reverse.status).toBe(400);
    expect((await reverse.json()).detail).toContain("no complete message to validate");
  });

  test("websocket forbids the cache, and so does sse", async () => {
    const ws = await draft();
    expect((await put(ws.id, ws.cookie, "cache", { ttlSec: 30 })).status).toBe(200);
    const wsCache = await put(ws.id, ws.cookie, "passthrough", { websocket: true });
    expect(wsCache.status).toBe(400);
    expect((await wsCache.json()).detail).toContain("passthrough.websocket: cache cannot be attached");

    const sse = await draft();
    expect((await put(sse.id, sse.cookie, "cache", { ttlSec: 30 })).status).toBe(200);
    const sseCache = await put(sse.id, sse.cookie, "passthrough", { sse: true });
    expect(sseCache.status).toBe(400);
    expect((await sseCache.json()).detail).toContain("passthrough.sse: cache cannot be attached");
  });

  test("sse forbids response validation — blocking would have to buffer the stream", async () => {
    const { id, cookie } = await draft();
    expect((await put(id, cookie, "passthrough", { sse: true })).status).toBe(200);
    const response = await put(id, cookie, "validate", { response: "blocking" });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("would have to buffer the stream");
  });

  test("sse forbids a response transform", async () => {
    // On a soap API, because `soap-to-json` is the only response transform there is and it is
    // rejected outright anywhere else — which would test the wrong rule.
    const { id, cookie } = await draft("soap");
    expect((await put(id, cookie, "transform", { response: "soap-to-json" })).status).toBe(200);
    const response = await put(id, cookie, "passthrough", { sse: true });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("passthrough.sse: transform.response must be none");
  });

  test("a websocket route's request validation is disabled by the build, not by the author", async () => {
    // Nobody wrote `validate` at all. The default is `blocking`, and after the upgrade there is no
    // complete message to block on, so config-build resolves it to `disabled` explicitly rather
    // than leaving the gateway to work it out (design section 5.1, `[V3-03]`).
    const w = await wsWorld({ websocket: true });
    try {
      const route = w.dp.client.table!.routes.find((r) => r.basePath === w.basePath)!;
      expect(route.policy.validate!.request).toBe("disabled");
      expect(route.policy.passthrough).toEqual({ websocket: true });
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- SSE

describe("passthrough.sse", () => {
  test("an event reaches the client before the backend has finished the stream", async () => {
    const source = eventSource();
    const w = await sseWorld({ sse: true }, () => source.response());
    try {
      const { response, reader } = await openEvents(w);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      // The whole point: the response is readable while the backend is still holding the stream
      // open. A gateway that buffered would deadlock here rather than fail an assertion.
      source.send("data: one\n\n");
      expect(await chunk(reader)).toBe("data: one\n\n");
      source.send("data: two\n\n");
      expect(await chunk(reader)).toBe("data: two\n\n");
      expect(w.dp.streams.snapshot().open).toBe(1);

      source.end();
      expect(await chunk(reader)).toBeNull();
      await until(() => w.dp.streams.snapshot().open === 0, "the stream to be reaped");
      expect(w.dp.streams.snapshot().closed.backend).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("nothing on the response side buffers: no cache, no validation, no transform", async () => {
    const source = eventSource();
    const w = await sseWorld({ sse: true }, () => source.response());
    try {
      const { reader } = await openEvents(w);
      source.send("data: live\n\n");
      expect(await chunk(reader)).toBe("data: live\n\n");
      // A blocking response check would have reserved from the buffer budget and a cache would
      // have held the body; a streamed response does neither, which is what lets it be infinite.
      expect(w.dp.cache.stats().entries).toBe(0);
      expect(w.dp.budget.inUse).toBe(0);
      expect(w.dp.counters.snapshot().observed).toBe(0);
      source.end();
      await ending(reader);
    } finally {
      w.stop();
    }
  });

  test("the byte budget ends the stream and the over-budget chunk is not delivered", async () => {
    const source = eventSource();
    const w = await sseWorld({ sse: true, maxBytesPerConnection: 32 }, () => source.response());
    try {
      const { reader } = await openEvents(w);
      source.send("data: one\n\n");
      expect(await chunk(reader)).toBe("data: one\n\n");

      source.send(`data: ${"x".repeat(100)}\n\n`);
      // Not truncated to the budget — a half-event is worse than no event, so the chunk that
      // crosses the line is dropped whole and the stream ends.
      let delivered = "";
      for (;;) {
        const next = await ending(reader);
        if (next === null || next === "error") break;
        delivered += next;
      }
      expect(delivered).not.toContain("xxx");
      await until(
        () => w.dp.streams.snapshot().closed["byte-budget"] === 1,
        "the byte budget to fire",
      );
      expect(w.dp.streams.snapshot().open).toBe(0);
    } finally {
      w.stop();
    }
  });

  test("the idle timeout bounds silence, not the whole stream", async () => {
    const source = eventSource();
    const w = await sseWorld({ sse: true, streamIdleTimeoutSec: 1 }, () => source.response());
    try {
      const { reader } = await openEvents(w);
      source.send("data: one\n\n");
      expect(await chunk(reader)).toBe("data: one\n\n");
      // Half the timeout later, an event re-arms it — so a busy stream is never closed for being
      // long, only for being quiet.
      await Bun.sleep(500);
      source.send("data: two\n\n");
      expect(await chunk(reader)).toBe("data: two\n\n");
      expect(w.dp.streams.snapshot().open).toBe(1);

      await until(() => w.dp.streams.snapshot().closed.idle === 1, "the idle timeout to fire");
      await ending(reader);
    } finally {
      w.stop();
    }
  });

  test("maxConnectionSec closes a stream that is still busy", async () => {
    const source = eventSource();
    const w = await sseWorld(
      { sse: true, maxConnectionSec: 1, streamIdleTimeoutSec: 30 },
      () => source.response(),
    );
    try {
      const { reader } = await openEvents(w);
      const heartbeat = setInterval(() => source.send(": ping\n\n"), 100);
      try {
        expect(await chunk(reader)).toContain("ping");
        // Busy the whole time, so only the lifetime can end it. That is what makes a revoked
        // credential eventually stop working on a connection nothing re-authenticates.
        await until(
          () => w.dp.streams.snapshot().closed["max-connection"] === 1,
          "the connection lifetime to fire",
        );
      } finally {
        clearInterval(heartbeat);
      }
      await ending(reader);
    } finally {
      w.stop();
    }
  });

  test("a revoked subscription's stream is closed at the next poll", async () => {
    const source = eventSource();
    const w = await sseWorld({ sse: true }, () => source.response());
    try {
      const { reader } = await openEvents(w);
      source.send("data: one\n\n");
      expect(await chunk(reader)).toBe("data: one\n\n");

      const revoked = await cp.call("DELETE", `/api/subscriptions/${w.subscriptionId}`, {
        cookie: w.clara,
      });
      expect(revoked.status).toBe(200);
      // The one place a config update reaches backwards into work already in flight.
      await until(
        () => w.dp.streams.snapshot().closed.revoked === 1,
        "the poll to close the revoked stream",
      );
      await ending(reader);
      expect(w.dp.streams.snapshot().open).toBe(0);
    } finally {
      w.stop();
    }
  });

  test("a stream that breaks mid-way is not retried — the first byte has already gone", async () => {
    let calls = 0;
    const sources: Array<ReturnType<typeof eventSource>> = [];
    const w = await sseWorld(
      { sse: true },
      () => {
        calls++;
        const source = eventSource();
        sources.push(source);
        return source.response();
      },
      { policy: { retries: { attempts: 2, on: ["502", "503", "504"], idempotentOnly: true } } },
    );
    try {
      const { reader } = await openEvents(w);
      sources[0]!.send("data: one\n\n");
      expect(await chunk(reader)).toBe("data: one\n\n");

      sources[0]!.fail();
      await ending(reader);
      await until(() => w.dp.streams.snapshot().open === 0, "the broken stream to be reaped");
      // Retries live before the response headers. Once a byte has been delivered the request is
      // no longer replayable — re-running it would repeat every event the client already saw.
      expect(calls).toBe(1);
      expect(w.dp.streams.snapshot().closed.backend).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("a retryable failure before the first byte still retries", async () => {
    let calls = 0;
    const w = await sseWorld(
      { sse: true },
      () => {
        calls++;
        if (calls === 1) return new Response("busy", { status: 503 });
        const source = eventSource();
        source.send("data: after the retry\n\n");
        source.end();
        return source.response();
      },
      { policy: { retries: { attempts: 2, on: ["503"], idempotentOnly: true } } },
    );
    try {
      const response = await openSse(w);
      expect(response.status).toBe(200);
      // Read to the end rather than event by event: this backend produces the whole stream before
      // the gateway ever reads it, so the chunk boundaries are the sender's, not the protocol's.
      expect(await response.text()).toContain("data: after the retry");
      expect(calls).toBe(2);
    } finally {
      w.stop();
    }
  });

  test("the route's connection ceiling and the instance's are different answers", async () => {
    const sources: Array<ReturnType<typeof eventSource>> = [];
    const w = await sseWorld({ sse: true, maxConcurrentConnections: 1 }, () => {
      const source = eventSource();
      sources.push(source);
      return source.response();
    });
    try {
      const { reader } = await openEvents(w);
      expect(w.dp.streams.snapshot().open).toBe(1);

      const second = await openSse(w);
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("5");
      const detail = (await second.json()).detail as string;
      // Which ceiling fired is the whole diagnosis: one says "buy more instances", the other says
      // "raise this route's limit" (plan `[R3-09]`).
      expect(detail).toContain("this route is at its concurrent-connection ceiling");
      expect(w.dp.streams.snapshot().open).toBe(1);

      await ending(reader);
    } finally {
      w.stop();
      for (const source of sources) source.end();
    }
  });

  test("the instance ceiling names the instance", async () => {
    const sources: Array<ReturnType<typeof eventSource>> = [];
    const w = await sseWorld(
      { sse: true },
      () => {
        const source = eventSource();
        sources.push(source);
        return source.response();
      },
      { dp: { maxConcurrentUpgrades: 1 } },
    );
    try {
      const { reader } = await openEvents(w);

      const second = await openSse(w);
      expect(second.status).toBe(503);
      expect((await second.json()).detail).toContain(
        "this gateway instance is at its concurrent-stream ceiling",
      );
      await ending(reader);
    } finally {
      w.stop();
      for (const source of sources) source.end();
    }
  });
});

// --------------------------------------------------------------------------- WebSocket

describe("passthrough.websocket", () => {
  test("the upgrade runs the request pipeline first: no key, no socket", async () => {
    const w = await wsWorld({ websocket: true });
    try {
      const refused = await probeUpgrade(w, "");
      expect(refused.status).toBe(401);
      // Nothing reached the backend and nothing was registered: an upgrade that is refused costs
      // exactly one rejection, not a connection.
      expect(w.backend.upgrades.length).toBe(0);
      expect(w.dp.streams.snapshot().open).toBe(0);

      const client = wsClient(`${w.url}/ws`);
      await expect(client.opened).rejects.toThrow();
    } finally {
      w.stop();
    }
  });

  test("ipAllow and rateLimit are enforced before the 101", async () => {
    const w = await wsWorld(
      { websocket: true },
      {
        policy: {
          ipAllow: ["10.0.0.0/8"],
          rateLimit: { calls: 1, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
        },
      },
    );
    try {
      const blocked = await probeUpgrade(w, `?key=${w.key}`, "127.0.0.1");
      expect(blocked.status).toBe(403);
      expect(w.backend.upgrades.length).toBe(0);

      // From an allowed address the pipeline runs to the end and hands back an upgrade instead of
      // a response — which `fetchHttp` refuses to serve, and which is therefore the proof that
      // steps 1–14 all passed rather than being skipped for a streaming route.
      await expect(probeUpgrade(w, `?key=${w.key}`, "10.1.2.3")).rejects.toThrow(
        "WebSocket passthrough route",
      );
      // That attempt was still counted: an upgrade spends a rate-limit token like any other
      // request, because the connection it asks for is far more expensive than the request is.
      const limited = await probeUpgrade(w, `?key=${w.key}`, "10.1.2.3");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    } finally {
      w.stop();
    }
  });

  test("bytes flow both ways and the connection is counted once, when it ends", async () => {
    const w = await wsWorld({ websocket: true });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      await until(() => w.dp.streams.snapshot().open === 1, "the bridge to register");

      client.socket.send("hello");
      await until(() => client.messages.length === 1, "the echo to come back");
      expect(client.messages[0]).toBe("echo:hello");
      expect(w.backend.received).toEqual(["hello"]);
      // The upgrade was proxied to the rewritten path, with this gateway's own forwarding headers.
      // The address is whatever the socket reported, which on a dual-stack listener is the
      // IPv4-mapped form — replaced rather than trusted, since no proxy is configured here.
      expect(w.backend.upgrades[0]![":path"]).toBe("/ws");
      expect(w.backend.upgrades[0]!["x-forwarded-for"]).toContain("127.0.0.1");
      expect(w.backend.upgrades[0]!["x-forwarded-proto"]).toBe("http");

      client.socket.close();
      await client.closed;
      await until(() => w.dp.streams.snapshot().open === 0, "the bridge to unregister");
      expect(w.dp.streams.snapshot().closed.client).toBe(1);
      expect(w.dp.streams.snapshot().peak).toBe(1);

      // One record, at the 101 the client actually received, with both directions counted.
      const closed = seriesFor(w.dp, "stream-closed");
      expect(closed.length).toBe(1);
      expect(closed[0]!.status).toBe(101);
      expect(closed[0]!.count).toBe(1);
      expect(closed[0]!.bytesIn).toBe(5);
      expect(closed[0]!.bytesOut).toBe(10);
      expect(closed[0]!.subscriptionId).toBe(w.subscriptionId);
    } finally {
      w.stop();
    }
  });

  test("a revoked subscription is closed with 1008 at the next poll", async () => {
    const w = await wsWorld({ websocket: true });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      await until(() => w.dp.streams.snapshot().open === 1, "the bridge to register");

      expect(
        (await cp.call("DELETE", `/api/subscriptions/${w.subscriptionId}`, { cookie: w.clara })).status,
      ).toBe(200);

      const end = await client.closed;
      // 1008 is "policy violation", which is what a revocation is from the client's side — as
      // opposed to 1000, which would read as "the server is done".
      expect(end.code).toBe(1008);
      expect(end.reason).toBe("revoked");
      expect(w.dp.streams.snapshot().closed.revoked).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("maxConnectionSec forces the reconnect that re-authenticates", async () => {
    const w = await wsWorld({ websocket: true, maxConnectionSec: 1 });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      const end = await client.closed;
      expect(end.code).toBe(1000);
      expect(end.reason).toBe("max-connection");
      expect(w.dp.streams.snapshot().closed["max-connection"]).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("the idle timeout closes a silent socket and traffic re-arms it", async () => {
    const w = await wsWorld({ websocket: true, streamIdleTimeoutSec: 1 });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      await Bun.sleep(500);
      client.socket.send("still here");
      await until(() => client.messages.length === 1, "the echo to come back");
      // Re-armed by that exchange, so the socket outlives the first timeout.
      await Bun.sleep(700);
      expect(w.dp.streams.snapshot().open).toBe(1);

      const end = await client.closed;
      expect(end.reason).toBe("idle");
      expect(w.dp.streams.snapshot().closed.idle).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("the byte budget counts both directions together", async () => {
    // 24 bytes: "hello" in and "echo:hello" back is 15, so the second exchange crosses it.
    const w = await wsWorld({ websocket: true, maxBytesPerConnection: 24 });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      await until(() => w.dp.streams.snapshot().open === 1, "the bridge to register");
      client.socket.send("hello");
      await until(() => client.messages.length === 1, "the first echo");
      client.socket.send("hello");

      const end = await client.closed;
      expect(end.reason).toBe("byte-budget");
      expect(w.dp.streams.snapshot().closed["byte-budget"]).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("both upgrade ceilings, and they say which one fired", async () => {
    const w = await wsWorld({ websocket: true, maxConcurrentConnections: 1 });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      // The bridge registers the stream before its own upstream handshake completes, so waiting
      // for the backend is what makes "the backend saw exactly one upgrade" a real assertion.
      await until(() => w.backend.upgrades.length === 1, "the backend to see the upgrade");
      expect(w.dp.streams.snapshot().open).toBe(1);

      const full = await probeUpgrade(w);
      expect(full.status).toBe(503);
      expect((await full.json()).detail).toContain("this route is at its concurrent-connection ceiling");
      // A refused upgrade never reaches the backend, so the ceiling protects the backend too.
      expect(w.backend.upgrades.length).toBe(1);

      // A real client sees the same refusal as a failed handshake.
      const rejected = wsClient(`${w.url}/ws?key=${w.key}`);
      await expect(rejected.opened).rejects.toThrow();
      client.socket.close();
    } finally {
      w.stop();
    }
  });

  test("the instance ceiling is separate from the route's", async () => {
    const w = await wsWorld({ websocket: true }, { dp: { maxConcurrentUpgrades: 1 } });
    try {
      const client = wsClient(`${w.url}/ws?key=${w.key}`);
      await client.opened;
      await until(() => w.dp.streams.snapshot().open === 1, "the bridge to register");

      const full = await probeUpgrade(w);
      expect(full.status).toBe(503);
      expect((await full.json()).detail).toContain(
        "this gateway instance is at its concurrent-stream ceiling",
      );
      expect(w.dp.streams.snapshot().maxTotal).toBe(1);
      client.socket.close();
    } finally {
      w.stop();
    }
  });

  test("shutdown closes every open stream", async () => {
    const w = await wsWorld({ websocket: true });
    const client = wsClient(`${w.url}/ws?key=${w.key}`);
    await client.opened;
    await until(() => w.dp.streams.snapshot().open === 1, "the bridge to register");

    // A stream is the one thing that outlives the request that opened it, so it is the one thing
    // shutdown has to end explicitly rather than letting the process exit take it.
    w.dp.stop();
    const end = await client.closed;
    expect(end.reason).toBe("shutdown");
    expect(w.dp.streams.snapshot().open).toBe(0);
    w.stop();
  });
});

// --------------------------------------------------------------- the shipped demo backend

/**
 * The same two protocols against `tools/backend`, over a real socket, through a real
 * `startDataPlane`. The tests above drive the pipeline directly with hand-built streams, which is
 * how the timers and budgets become assertable; this one exists so the thing the README tells
 * somebody to run is the thing that was tested.
 */
describe("the demo backend's own streams", () => {
  const DEMO_SPEC = {
    openapi: "3.0.0",
    info: { title: "petstore-streams", version: "1.0.0" },
    paths: {
      "/v2/events": { get: { operationId: "events", responses: { "200": { description: "ok" } } } },
      "/v2/socket": { get: { operationId: "socket", responses: { "200": { description: "ok" } } } },
      "/v2/store/inventory": {
        get: { operationId: "getInventory", responses: { "200": { description: "ok" } } },
      },
    },
  };

  async function demoWorld(passthrough: Record<string, unknown>) {
    const petstore = new PetstoreBackend({ port: 0, seed: 1, instance: "demo-1" });
    const origin = startPetstore(petstore);
    const cpServer = serveCp(cp);
    const basePath = `/d-${++seq}`;
    const api = await publishApi(cp, {
      backendUrl: `http://127.0.0.1:${origin.port}`,
      basePath,
      spec: DEMO_SPEC,
      policy: {
        rewrite: { stripBasePath: true },
        "auth.subscriptionKey": { in: "query", name: "key" },
        passthrough,
      },
    });
    const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `d-${seq}` });
    await dp.start();
    if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
    const gateway = startDataPlane(dp);
    return {
      petstore,
      dp,
      key: api.key!,
      http: `http://127.0.0.1:${gateway.port}${basePath}`,
      ws: `ws://127.0.0.1:${gateway.port}${basePath}`,
      stop: () => {
        gateway.stop(true);
        dp.stop();
        cpServer.stop();
        origin.stop(true);
      },
    };
  }

  test("a bounded event stream arrives event by event and closes itself", async () => {
    const w = await demoWorld({ sse: true });
    try {
      const response = await fetch(`${w.http}/v2/events?count=3&intervalMs=20&key=${w.key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body.startsWith(": open\n\n")).toBe(true);
      expect(body).toContain("event: pet");
      expect(body).toContain('"seq":3');
      expect(w.petstore.stats.sseTotal).toBe(1);
      await until(() => w.petstore.stats.sseOpen === 0, "the origin to release the stream");
      // Which copy of the petstore answered — the header the load-balancing demo reads.
      expect(response.headers.get("x-backend-instance")).toBe("demo-1");
    } finally {
      w.stop();
    }
  });

  test("a socket reaches the origin and the echo comes back through the gateway", async () => {
    const w = await demoWorld({ websocket: true });
    try {
      const client = wsClient(`${w.ws}/v2/socket?key=${w.key}`);
      await client.opened;
      await until(() => w.petstore.stats.socketsOpen === 1, "the origin to accept the socket");
      client.socket.send("ping");
      await until(() => client.messages.length === 1, "the echo to come back");
      expect(JSON.parse(client.messages[0]!)).toEqual({ seq: 1, echo: "ping" });

      client.socket.close();
      await client.closed;
      await until(() => w.petstore.stats.socketsOpen === 0, "the origin to release the socket");
      expect(w.petstore.stats.socketsTotal).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("a plain REST call still names the backend that served it", async () => {
    const w = await demoWorld({ sse: true });
    try {
      const response = await fetch(`${w.http}/v2/store/inventory?key=${w.key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-backend-instance")).toBe("demo-1");
      expect(await response.json()).toEqual({ available: 1, pending: 1, sold: 1 });
    } finally {
      w.stop();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccessLogWriter,
  bodyExcerpt,
  logTimestamp,
  redactBody,
  redactQuery,
  REDACTED,
} from "../data-plane/src/accesslog.ts";
import { traceContextFrom, traceStateFor } from "../data-plane/src/trace.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { runOperations } from "../control-plane/src/operations.ts";
import { CONFIG_VERSION, MAX_LOGGED_BODY_BYTES } from "../shared/config-doc.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * The access log: one line per request, for every request, because the estate keeps these lines to
 * answer "who called what, when" for compliance.
 *
 * Which makes the interesting assertions the *negative* ones. A log that is never sampled and never
 * switched off is a log that will contain whatever the pipeline hands it, forever, in an index more
 * people can read than can read the backend — so the tests that matter here are the ones proving
 * what does not reach a line: no header ever, no credential-shaped query value, no body unless
 * somebody deliberately opened an hour for it, and no more than 8 KiB of one when they did.
 */

let cp: TestCp;
let cpServer: ReturnType<typeof serveCp>;
let backend: ReturnType<typeof startBackend>;
let published: Awaited<ReturnType<typeof publishApi>>;
/**
 * An API bound to a backend that is stopped once it has been published, so reaching it fails
 * below HTTP. Published against a listener that is really there because the binding is
 * egress-checked when it is written — which is the right check, and means "a port nothing is on"
 * is not something this API could have been created with.
 */
let deadBackend: ReturnType<typeof startBackend>;
let dead: Awaited<ReturnType<typeof publishApi>>;
let logDir: string;
let gatewayCount = 0;

/** The key is a *query* parameter here, which is the case redaction has to get right by name. */
const KEY_PARAM = "sk";

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "apim-accesslog-"));
  backend = startBackend();
  cp = makeCp();
  const policy = {
    "auth.subscriptionKey": { in: "query", name: KEY_PARAM },
    rewrite: { stripBasePath: true },
  };
  published = await publishApi(cp, { backendUrl: backend.url, policy });
  // No subscription and no key on this one: the estate's seeded instances have acknowledged a
  // digest by now, so a second release has real gateways to wait for, and it is simpler to
  // acknowledge it directly than to route a consumer through an API that cannot answer.
  deadBackend = startBackend();
  dead = await publishApi(cp, { backendUrl: deadBackend.url, subscribe: false });
  await converge();
  cpServer = serveCp(cp);
});

afterAll(() => {
  cpServer.stop();
  cp.close();
  backend.stop();
  rmSync(logDir, { recursive: true, force: true });
});

/**
 * A gateway writing to a file of its own, and the lines it wrote.
 *
 * Through the real `RotatingFileSink` rather than a stub: the buffering and the flush are half of
 * what this file is testing, and a stub that recorded records would pass whether or not a line ever
 * reached disk.
 */
async function withGateway(
  run: (gw: {
    call(path: string, init?: RequestInit): Promise<Response>;
    lines(): Array<Record<string, any>>;
    dp: ReturnType<typeof makeDp>;
  }) => Promise<void>,
): Promise<void> {
  const name = `log-${++gatewayCount}`;
  const path = join(logDir, `${name}.log`);
  const dp = makeDp(cpServer.url, cp.token, cp.dir, {
    name,
    quiet: false,
    accessLogPath: path,
  });
  try {
    await dp.start();
    await run({
      dp,
      call: (p, init) => dp.fetchHttp(new Request(`http://gw${p}`, init), "203.0.113.7"),
      lines() {
        dp.accessLog!.flush();
        if (!existsSync(path)) return [];
        return readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
      },
    });
  } finally {
    dp.stop();
  }
}

/**
 * Acknowledge the current document as every seeded instance, and run the operation queue — which
 * is what turns a release into `converged` and therefore into a route the fleet is served.
 */
async function converge(): Promise<void> {
  // Twice around: the queued release has to be applied before there is a digest to acknowledge,
  // and acknowledged before the operation can complete.
  runOperations(cp.app);
  const digest = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations).digest;
  for (const instance of cp.instances.filter((i) => i.environment === "dev")) {
    const ack = await cp.call("POST", "/api/gateway/poll", {
      headers: { authorization: `Bearer ${instance.token}` },
      body: {
        wireVersion: CONFIG_VERSION,
        instance: {
          name: instance.name,
          runId: "fixture",
          startedAt: new Date().toISOString(),
          activeDigest: digest,
          requestsTotal: 0,
          process: {},
        },
      },
    });
    if (!ack.ok) throw new Error(`converge: ${await ack.text()}`);
  }
  runOperations(cp.app);
}

/** The route's path with the subscription key attached, plus whatever else the test wants. */
function callPath(query = ""): string {
  return `${published.basePath}/pet?${KEY_PARAM}=${published.key}${query}`;
}

/** Wait for the fleet to pick up a control-plane change, on the real poll rather than a fixed sleep. */
async function waitForConfig(
  dp: ReturnType<typeof makeDp>,
  predicate: (route: any) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const route = dp.client.table?.routes.find((r) => r.resourceId === published.resourceId);
    if (route && predicate(route)) return;
    await Bun.sleep(25);
  }
  throw new Error("the gateway never activated a configuration matching the predicate");
}

describe("redaction, before anything is written down", () => {
  test("the route's own key parameter is redacted, and so is anything credential-shaped", () => {
    const query = redactQuery("?sk=secret&token=abc&api_key=xyz&sort_key=name&page=2", "sk");
    const params = new URLSearchParams(query);
    expect(params.get("sk")).toBe(REDACTED);
    expect(params.get("token")).toBe(REDACTED);
    expect(params.get("api_key")).toBe(REDACTED);
    // Matched whole and case-insensitively: `sort_key` is not a key, and a substring rule would
    // have redacted it and made the rest of the query useless for debugging.
    expect(params.get("sort_key")).toBe("name");
    expect(params.get("page")).toBe("2");
  });

  test("a query with nothing to redact is left exactly as it arrived", () => {
    expect(redactQuery("?a=1&b=2")).toBe("?a=1&b=2");
    expect(redactQuery("")).toBe("");
    expect(redactQuery("?")).toBe("");
  });

  test("credential members are redacted inside a body, and inside a truncated one", () => {
    const whole = redactBody('{"user":"pavel","password":"hunter2","note":"ok"}');
    expect(whole).toContain('"password":"***"');
    expect(whole).toContain('"user":"pavel"');
    // A fragment is what a truncated capture actually is, and a parser would refuse it.
    expect(redactBody('{"a":1,"access_token":"abc","b')).toContain('"access_token":"***"');
  });

  test("an excerpt stops at the cap and says that it did", () => {
    const small = bodyExcerpt('{"ok":true}');
    expect(small.truncated).toBe(false);
    const large = bodyExcerpt("x".repeat(MAX_LOGGED_BODY_BYTES * 2));
    expect(large.truncated).toBe(true);
    expect(Buffer.byteLength(large.body, "utf8")).toBeLessThanOrEqual(MAX_LOGGED_BODY_BYTES);
  });

  test("the cached timestamp is exactly what a Date would have formatted", () => {
    for (const ms of [0, 1_000, 1_700_000_000_123, Date.now()]) {
      expect(logTimestamp(ms)).toBe(new Date(ms).toISOString());
    }
  });
});

describe("W3C Trace Context", () => {
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const SPAN = "00f067aa0ba902b7";

  test("a well-formed traceparent is continued, with a fresh span for this hop", () => {
    const context = traceContextFrom(`00-${TRACE}-${SPAN}-01`);
    expect(context.continued).toBe(true);
    expect(context.traceId).toBe(TRACE);
    expect(context.parentSpanId).toBe(SPAN);
    expect(context.spanId).not.toBe(SPAN);
    expect(context.header).toBe(`00-${TRACE}-${context.spanId}-01`);
  });

  test("nothing, an unknown version, or an all-zero id starts a new trace instead", () => {
    for (const header of [
      null,
      "",
      "not-a-traceparent",
      `01-${TRACE}-${SPAN}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
    ]) {
      const context = traceContextFrom(header);
      expect(context.continued).toBe(false);
      expect(context.parentSpanId).toBeNull();
      expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(context.traceId).not.toBe("0".repeat(32));
    }
  });

  test("tracestate travels only on a continued trace, and only within its bound", () => {
    const continued = traceContextFrom(`00-${TRACE}-${SPAN}-01`);
    expect(traceStateFor(continued, "vendor=1")).toBe("vendor=1");
    // A new trace has no vendor state to carry: forwarding one would attach another system's
    // state to a trace id that system has never seen.
    expect(traceStateFor(traceContextFrom(null), "vendor=1")).toBeNull();
    expect(traceStateFor(continued, "x".repeat(600))).toBeNull();
  });
});

describe("the file the shipper tails", () => {
  test("rotates by renaming, so a tailing reader finishes the file it is on", () => {
    const path = join(logDir, "rotate", "access.log");
    // A tiny cap and no buffer, so every write is a candidate for rotation.
    const writer = new AccessLogWriter({ path, maxBytes: 512, keep: 2, highWaterMark: 1, flushIntervalMs: 0 });
    for (let i = 0; i < 60; i++) writer.write({ n: i, filler: "x".repeat(64) });
    writer.close();

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    // `keep: 2` and not one more: the log's disk is (keep + 1) x maxBytes and nothing beyond it.
    expect(existsSync(`${path}.3`)).toBe(false);

    // What survives is the newest generations, unbroken and in order, ending at the last line
    // written — which is what renaming buys. Truncating in place would have left the reader
    // holding an inode that no longer grows and a gap it can never account for.
    const kept = [`${path}.2`, `${path}.1`, path]
      .filter((p) => existsSync(p))
      .flatMap((p) => readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0))
      .map((line) => JSON.parse(line).n as number);
    expect(kept.at(-1)).toBe(59);
    expect(kept).toEqual([...Array(kept.length).keys()].map((i) => kept[0]! + i));
    // Bounded, and by the two numbers the operator set rather than by luck.
    expect(kept.length).toBeLessThan(60);
  });

  test("a directory that does not exist yet is created rather than losing the log", () => {
    const path = join(logDir, "deep", "nested", "access.log");
    const writer = new AccessLogWriter({ path, flushIntervalMs: 0 });
    writer.write({ hello: "world" });
    writer.close();
    expect(JSON.parse(readFileSync(path, "utf8").trim()).hello).toBe("world");
  });
});

describe("what a line carries", () => {
  test("one line per request, whatever the answer was", async () => {
    await withGateway(async (gw) => {
      expect((await gw.call(callPath())).status).toBe(200);
      // Refused at the key check, before a subscription exists.
      expect((await gw.call(`${published.basePath}/pet`)).status).toBe(401);
      // Refused before a route exists at all.
      expect((await gw.call("/nothing-published-here")).status).toBe(404);

      const lines = gw.lines();
      expect(lines).toHaveLength(3);
      expect(lines.map((line) => line.status)).toEqual([200, 401, 404]);
      // The route fields are absent-as-null on the two refusals rather than the line being
      // absent: "a call arrived and was rejected" is the compliance question, more often than not.
      expect(lines[0]!.resourceId).toBe(published.resourceId);
      expect(lines[2]!.resourceId).toBeNull();
      expect(lines[2]!.operationId).toBeNull();
    });
  });

  test("no header ever reaches a line, and the query is redacted", async () => {
    await withGateway(async (gw) => {
      await gw.call(callPath("&token=abc&sort_key=name"), {
        headers: {
          authorization: "Bearer super-secret-jwt",
          "x-api-key": "another-secret",
          cookie: "session=abc",
        },
      });
      const line = gw.lines()[0]!;
      const rendered = JSON.stringify(line);
      expect(rendered).not.toContain("super-secret-jwt");
      expect(rendered).not.toContain("another-secret");
      expect(rendered).not.toContain(published.key);
      // Not "no credential header" — no header at all. There is no field for one.
      expect(rendered).not.toContain("authorization");
      expect(rendered).not.toContain("headers");

      const query = new URLSearchParams(line.query);
      expect(query.get(KEY_PARAM)).toBe(REDACTED);
      expect(query.get("token")).toBe(REDACTED);
      expect(query.get("sort_key")).toBe("name");
    });
  });

  test("the line says where, who, what and how long", async () => {
    await withGateway(async (gw) => {
      await gw.call(callPath());
      const line = gw.lines()[0]!;
      expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(line.environment).toBe("dev");
      expect(line.gateway).toBe(gw.dp.config.name);
      expect(line.instance).toBe(gw.dp.runId);
      expect(line.method).toBe("GET");
      expect(line.path).toBe(`${published.basePath}/pet`);
      expect(line.clientIp).toBe("203.0.113.7");
      // The telemetry vocabulary, not a second one: a line and a dashboard cell describing the
      // same request have to agree about what happened to it.
      expect(line.outcome).toBe("ok");
      expect(line.subscriptionId).toBe(published.subscriptionId);
      expect(line.applicationId).toBe("application_orders");
      expect(line.operationId).toBe("listPets");
      expect(line.backendStatus).toBe(200);
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
      expect(line.backendMs).toBeGreaterThanOrEqual(0);
      expect(line.requestId).toBeTruthy();
    });
  });

  test("a trace is continued and a fresh span is what the backend is told about", async () => {
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const caller = "00f067aa0ba902b7";
    await withGateway(async (gw) => {
      const before = backend.requests.length;
      await gw.call(callPath(), { headers: { traceparent: `00-${trace}-${caller}-01` } });
      const line = gw.lines()[0]!;
      expect(line.traceId).toBe(trace);
      expect(line.parentSpanId).toBe(caller);
      expect(line.spanId).not.toBe(caller);

      const forwarded = backend.requests[before]!.headers["traceparent"];
      expect(forwarded).toBe(`00-${trace}-${line.spanId}-01`);
    });
  });

  test("a trace is started when the caller brings none", async () => {
    await withGateway(async (gw) => {
      await gw.call(callPath());
      const line = gw.lines()[0]!;
      expect(line.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(line.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(line.parentSpanId).toBeNull();
    });
  });
});

describe("bodies", () => {
  const SECRET_BODY = JSON.stringify({ name: "Rex", password: "hunter2" });
  const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };

  /** Open a capture window through the real endpoint, and wait for the fleet to have it. */
  async function openWindow(dp: ReturnType<typeof makeDp>): Promise<void> {
    const response = await cp.call("POST", "/api/logs/body-capture", {
      cookie: published.pavel,
      body: {
        resourceId: published.resourceId,
        environment: "dev",
        reason: "INC-9902: the create call fails for one consumer and we cannot reproduce it",
      },
    });
    if (response.status !== 201) throw new Error(`open window: ${await response.text()}`);
    await waitForConfig(dp, (route) => route.logBodiesUntil !== undefined);
  }

  async function closeWindows(): Promise<void> {
    const page = await (
      await cp.call("GET", "/api/logs/body-capture", { cookie: published.pavel })
    ).json();
    for (const item of page.items) {
      await cp.call("DELETE", `/api/logs/body-capture/${item.id}`, { cookie: published.pavel });
    }
  }

  test("no window means no body, on either side", async () => {
    await withGateway(async (gw) => {
      await gw.call(callPath(), { ...JSON_POST, body: SECRET_BODY });
      const line = gw.lines()[0]!;
      expect(line.requestBody).toBeUndefined();
      expect(line.responseBody).toBeUndefined();
      expect(JSON.stringify(line)).not.toContain("hunter2");
    });
  });

  test("inside a window both bodies appear, redacted, and the call still works", async () => {
    await withGateway(async (gw) => {
      await openWindow(gw.dp);
      try {
        const response = await gw.call(callPath(), { ...JSON_POST, body: SECRET_BODY });
        expect(response.status).toBe(200);
        // The body still reached the backend in full: taking a prefix for the log must not be
        // taking it away from the request.
        expect(backend.requests.at(-1)!.body).toBe(SECRET_BODY);

        const line = gw.lines()[0]!;
        expect(line.requestBody).toContain('"name":"Rex"');
        expect(line.requestBody).toContain(`"password":"${REDACTED}"`);
        expect(line.requestBody).not.toContain("hunter2");
        expect(line.requestBodyTruncated).toBe(false);
        expect(line.responseBody).toBeTruthy();
      } finally {
        await closeWindows();
      }
    });
  });

  test("a large body is cut at the cap and marked", async () => {
    await withGateway(async (gw) => {
      await openWindow(gw.dp);
      try {
        const big = JSON.stringify({ blob: "z".repeat(MAX_LOGGED_BODY_BYTES * 2) });
        await gw.call(callPath(), { ...JSON_POST, body: big });
        const line = gw.lines()[0]!;
        expect(line.requestBodyTruncated).toBe(true);
        expect(Buffer.byteLength(line.requestBody, "utf8")).toBeLessThanOrEqual(MAX_LOGGED_BODY_BYTES);
        expect(backend.requests.at(-1)!.body).toBe(big);
      } finally {
        await closeWindows();
      }
    });
  });

  test("closing the window stops the capture on the next poll", async () => {
    await withGateway(async (gw) => {
      await openWindow(gw.dp);
      await closeWindows();
      await waitForConfig(gw.dp, (route) => route.logBodiesUntil === undefined);
      await gw.call(callPath(), { ...JSON_POST, body: SECRET_BODY });
      expect(gw.lines().at(-1)!.requestBody).toBeUndefined();
    });
  });
});

describe("a failure below HTTP", () => {
  test("the reason is written down whether or not a window is open", async () => {
    // Gone by the time the request arrives: the connection is refused before any HTTP exists,
    // which is exactly the case a status code alone cannot explain.
    deadBackend.stop();
    await withGateway(async (gw) => {
      const response = await gw.call(`${dead.basePath}/pet`);
      expect(response.status).toBe(502);

      const line = gw.lines().at(-1)!;
      expect(line.outcome).toBe("backend-unreachable");
      // The name, the message and the backend that was being reached — the three things that end
      // the investigation, and none of them are the caller's data.
      expect(line.error).toContain(new URL(deadBackend.url).origin);
      expect(line.error!.length).toBeGreaterThan(10);
      // No window is open, and the reason is in the response body field anyway: it is the
      // gateway's own sentence about its own failure.
      expect(line.responseBody).toBeTruthy();
      expect(line.responseBodyTruncated).toBe(false);
    });
  });
});

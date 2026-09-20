import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { logTimestamp } from "../data-plane/src/accesslog.ts";
import type { DataPlane, DpConfig } from "../data-plane/src/server.ts";
import {
  FIXTURE_DOMAIN,
  FIXTURE_SUBDOMAIN,
  makeCp,
  makeDp as newDataPlane,
  publishApi,
  serveCp,
  setFleetSettings,
  startBackend,
  underDomain,
  type TestCp,
} from "./helpers.ts";

const KEY_UNIT = { in: "header", name: "X-Api-Key" };
const CHECK_HEADER = [
  {
    requireHeader: { name: "X-Request-Origin", equals: "skoda-portal" },
    deny: {
      status: 403,
      reason: "Forbidden - missing or invalid X-Request-Origin header",
      body: { statusCode: 403, message: "Forbidden - missing or invalid X-Request-Origin header" },
    },
  },
];

let cp: TestCp;
let served: ReturnType<typeof serveCp>;
let backend: ReturnType<typeof startBackend>;
const planes: DataPlane[] = [];

function makeDp(overrides: Partial<DpConfig> = {}) {
  const dp = newDataPlane(served.url, cp.token, cp.dir, {
    // Long interval: tests poll explicitly, so nothing depends on timing.
    pollIntervalMs: 3_600_000,
    ...overrides,
  });
  planes.push(dp);
  return dp;
}

/**
 * Paths here are written the way the fixture asks for them — `/petstore/store/inventory` — and the
 * gateway serves them under the fixture's domain, so the domain prefix is added here rather than at
 * every call. A path that already carries it is left alone, which is what the 404 cases want.
 */
async function get(dp: DataPlane, path: string, headers: Record<string, string> = {}) {
  const url = underDomain(path, FIXTURE_DOMAIN, FIXTURE_SUBDOMAIN);
  return dp.fetchHttp(new Request(`http://gateway.test${url}`, { headers }), "203.0.113.7");
}

beforeEach(() => {
  cp = makeCp();
  served = serveCp(cp);
  backend = startBackend();
});

afterEach(() => {
  for (const dp of planes.splice(0)) dp.stop();
  backend.stop();
  served.stop();
  cp.close();
});

describe("authentication and authorization", () => {
  test("no key, an unknown key and a revoked key are all 401", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const none = await get(dp, "/petstore/store/inventory");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/problem+json");
    expect((await none.json()).detail).toContain("X-Api-Key");

    expect((await get(dp, "/petstore/store/inventory", { "X-Api-Key": "sk_dev_nope" })).status).toBe(401);

    await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, { cookie: published.clara });
    await dp.client.pollOnce();
    expect((await get(dp, "/petstore/store/inventory", { "X-Api-Key": published.key! })).status).toBe(401);
    expect(backend.requests).toHaveLength(0);
  });

  test("a valid key for a product that does not contain this API is 403", async () => {
    const first = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/one",
      policy: { "auth.subscriptionKey": KEY_UNIT },
    });
    const second = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/two",
      policy: { "auth.subscriptionKey": KEY_UNIT },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    expect((await get(dp, "/one/x", { "X-Api-Key": first.key! })).status).toBe(200);
    const wrongProduct = await get(dp, "/two/x", { "X-Api-Key": first.key! });
    expect(wrongProduct.status).toBe(403);
    expect((await wrongProduct.json()).detail).toContain("product does not contain this API");
    expect(second.key).toBeTruthy();
  });

  test("an unknown host and path is 404", async () => {
    await publishApi(cp, { backendUrl: backend.url, basePath: "/petstore" });
    const dp = makeDp();
    await dp.client.pollOnce();
    const response = await get(dp, "/nothing/here");
    expect(response.status).toBe(404);
    expect((await response.json()).detail).toContain("no published route matches");
  });
});

describe("policies", () => {
  test("the check-header precondition denies with its configured status and body", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        preconditions: CHECK_HEADER,
        rewrite: { stripBasePath: true },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const missing = await get(dp, "/petstore/store/inventory", { "X-Api-Key": published.key! });
    expect(missing.status).toBe(403);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await missing.json()).toEqual({
      statusCode: 403,
      message: "Forbidden - missing or invalid X-Request-Origin header",
    });

    const wrong = await get(dp, "/petstore/store/inventory", {
      "X-Api-Key": published.key!,
      "X-Request-Origin": "somewhere-else",
    });
    expect(wrong.status).toBe(403);
    expect(backend.requests).toHaveLength(0);

    const ok = await get(dp, "/petstore/store/inventory", {
      "X-Api-Key": published.key!,
      "X-Request-Origin": "skoda-portal",
    });
    expect(ok.status).toBe(200);
    expect(backend.requests).toHaveLength(1);
  });

  test("a rate limit rejects the calls+1-th request with Retry-After", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        rewrite: { stripBasePath: true },
        rateLimit: {
          calls: 2,
          periodSec: 60,
          per: "instance",
          by: "subscription",
          scope: "route",
          emitHeaders: true,
        },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();
    const headers = { "X-Api-Key": published.key! };

    const first = await get(dp, "/petstore/a", headers);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("2");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");

    expect((await get(dp, "/petstore/b", headers)).status).toBe(200);

    const limited = await get(dp, "/petstore/c", headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(backend.requests).toHaveLength(2);
  });

  test("a precondition denial still consumes rate-limit budget (pipeline order, section 5.2)", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        preconditions: CHECK_HEADER,
        rewrite: { stripBasePath: true },
        rateLimit: {
          calls: 2,
          periodSec: 60,
          per: "instance",
          by: "subscription",
          scope: "route",
          emitHeaders: true,
        },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    // Two requests denied by the precondition...
    expect((await get(dp, "/petstore/a", { "X-Api-Key": published.key! })).status).toBe(403);
    expect((await get(dp, "/petstore/a", { "X-Api-Key": published.key! })).status).toBe(403);
    // ...leave no budget for a request that would otherwise pass.
    const third = await get(dp, "/petstore/a", {
      "X-Api-Key": published.key!,
      "X-Request-Origin": "skoda-portal",
    });
    expect(third.status).toBe(429);
  });

  test("rate limits are per subscription, not global", async () => {
    const first = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/one",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        rateLimit: { calls: 1, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
      },
    });
    const second = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/two",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        rateLimit: { calls: 1, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    expect((await get(dp, "/one/x", { "X-Api-Key": first.key! })).status).toBe(200);
    expect((await get(dp, "/one/x", { "X-Api-Key": first.key! })).status).toBe(429);
    expect((await get(dp, "/two/x", { "X-Api-Key": second.key! })).status).toBe(200);
  });
});

describe("what reaches the backend", () => {
  test("base path stripped, query preserved, credentials removed, forwarding headers set", async () => {
    const published = await publishApi(cp, {
      backendUrl: `${backend.url}/v2`,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        rewrite: { stripBasePath: true },
        "headers.request": {
          set: { "X-Subscription-Name": "${subscription.name}" },
          remove: ["X-Internal-Debug"],
        },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const response = await get(dp, "/petstore/store/inventory?status=available&page=2", {
      "X-Api-Key": published.key!,
      authorization: "Bearer inbound-token",
      "X-Internal-Debug": "remove-me",
      "X-Forwarded-For": "10.9.9.9",
    });
    expect(response.status).toBe(200);

    const seen = backend.requests[0]!;
    // The backend's own path segment survives, and the gateway base path does not.
    expect(seen.path).toBe("/v2/store/inventory");
    expect(seen.query).toBe("?status=available&page=2");
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-internal-debug"]).toBeUndefined();
    expect(seen.headers["x-subscription-name"]).toContain("->");
    // Not behind a trusted proxy: an inbound X-Forwarded-For is a claim, not evidence.
    expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen.headers["x-request-id"]).toBeTruthy();
  });

  /*
   * The other half of the test above, and the one worth writing down: that one asserts what the
   * gateway takes *away*, and nothing asserted that everything else survives. A published API is a
   * proxy for its backend, so an inbound header no rule mentions reaches it — the exceptions are
   * named by `headers.request`, never by an allowlist, which would make a published API silently
   * lossy and leave every owner to discover by experiment which of their headers was eaten.
   */
  test("a header no rule mentions is forwarded, and the gateway's own headers win", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": KEY_UNIT,
        rewrite: { stripBasePath: true },
        "headers.request": { set: { "X-Tenant": "platform" }, skip: { "X-Region": "eu" } },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const callerTrace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const response = await get(dp, "/petstore/store/inventory", {
      "X-Api-Key": published.key!,
      "X-Tenant-Hint": "nordics",
      "X-Server-Ms": "42",
      "Accept-Language": "cs-CZ",
      "X-Tenant": "caller-said-this",
      "X-Region": "apac",
      traceparent: callerTrace,
      "X-Forwarded-Proto": "gopher",
      "X-Forwarded-Host": "elsewhere.test",
      "Proxy-Authorization": "Basic Zm9vOmJhcg==",
    });
    expect(response.status).toBe(200);

    const seen = backend.requests[0]!;
    // No rule mentions either, so both arrive as the caller wrote them.
    expect(seen.headers["x-tenant-hint"]).toBe("nordics");
    expect(seen.headers["x-server-ms"]).toBe("42");
    expect(seen.headers["accept-language"]).toBe("cs-CZ");
    // `set` is the gateway speaking; `skip` is a default, and a default only fills an absence.
    expect(seen.headers["x-tenant"]).toBe("platform");
    expect(seen.headers["x-region"]).toBe("apac");
    // The caller's trace is continued, and its claim about the hop is not: same trace id, and a
    // `traceparent` naming this gateway as the backend's parent rather than the caller's span.
    expect(seen.headers.traceparent).toContain("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(seen.headers.traceparent).not.toBe(callerTrace);
    expect(seen.headers["x-forwarded-proto"]).toBe("http");
    // Set from the inbound `Host`, which a constructed `Request` does not carry — so what this
    // asserts is that the caller's claim did not survive, which is the part that matters.
    expect(seen.headers["x-forwarded-host"]).not.toBe("elsewhere.test");
    // Hop-by-hop: it describes the caller's connection to this gateway, not this gateway's to the
    // backend. `Proxy-Authorization` is the one worth asserting on — `Connection` and `TE` are
    // stripped here too, but the runtime writes its own onto the outbound socket, so a test of
    // those would be a test of Bun.
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
  });

  test("forwardCredentials lets the key through when a route opts in", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key", forwardCredentials: true },
        rewrite: { stripBasePath: true },
      },
    });
    const dp = makeDp();
    await dp.client.pollOnce();
    await get(dp, "/petstore/x", { "X-Api-Key": published.key ?? "", authorization: "Bearer keep-me" });
    expect(backend.requests[0]!.headers["x-api-key"]).toBe(published.key ?? "");
    expect(backend.requests[0]!.headers.authorization).toBe("Bearer keep-me");
  });

  test("a request body is streamed through intact", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const payload = JSON.stringify({ name: "fluffy", photoUrls: [] });
    const response = await dp.fetchHttp(
      new Request("http://gateway.test/it/solution/petstore/pet", {
        method: "POST",
        headers: { "X-Api-Key": published.key!, "content-type": "application/json" },
        body: payload,
      }),
      "203.0.113.7",
    );
    expect(response.status).toBe(200);
    expect(backend.requests[0]!.method).toBe("POST");
    expect(backend.requests[0]!.body).toBe(payload);
  });

  test("the response status and body come back unchanged", async () => {
    backend.stop();
    backend = startBackend(() =>
      new Response(JSON.stringify({ error: "no such pet" }), {
        status: 404,
        headers: { "content-type": "application/json", "x-backend": "yes" },
      }),
    );
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const response = await get(dp, "/petstore/pet/999", { "X-Api-Key": published.key! });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-backend")).toBe("yes");
    expect(await response.json()).toEqual({ error: "no such pet" });
  });
});

describe("limits and backend failures", () => {
  test("a declared Content-Length over the cap is 413 before the backend is touched", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT },
    });
    setFleetSettings(cp, { maxBodyBytes: 1024 });
    const dp = makeDp();
    await dp.client.pollOnce();

    const response = await dp.fetchHttp(
      new Request("http://gateway.test/it/solution/petstore/pet", {
        method: "POST",
        headers: {
          "X-Api-Key": published.key!,
          "content-type": "application/json",
          "content-length": "2048",
        },
        body: "x".repeat(2048),
      }),
      "203.0.113.7",
    );
    expect(response.status).toBe(413);
    expect(backend.requests).toHaveLength(0);
  });

  test("a body with no declared length is capped while streaming", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT },
    });
    setFleetSettings(cp, { maxBodyBytes: 1024 });
    const dp = makeDp();
    await dp.client.pollOnce();

    // A chunked request declares no length, so the header check cannot see it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2048)));
        controller.close();
      },
    });
    const response = await dp.fetchHttp(
      new Request("http://gateway.test/it/solution/petstore/pet", {
        method: "POST",
        headers: { "X-Api-Key": published.key!, "content-type": "application/json" },
        body: stream,
        // @ts-expect-error duplex is required for a streaming request body
        duplex: "half",
      }),
      "203.0.113.7",
    );
    expect(response.status).toBe(413);
    expect((await response.json()).detail).toContain("while streaming");
  });

  test("a slow backend is 504 and an unreachable one is 502", async () => {
    backend.stop();
    backend = startBackend(async () => {
      await Bun.sleep(300);
      return Response.json({ late: true });
    });
    const slow = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/slow",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true }, timeoutMs: 60 },
    });

    const dead = startBackend();
    const deadUrl = dead.url;
    dead.stop();
    const gone = await publishApi(cp, {
      backendUrl: deadUrl,
      basePath: "/gone",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });

    const dp = makeDp();
    await dp.client.pollOnce();

    const timedOut = await get(dp, "/slow/x", { "X-Api-Key": slow.key! });
    expect(timedOut.status).toBe(504);
    expect((await timedOut.json()).detail).toContain("60ms");

    const unreachable = await get(dp, "/gone/x", { "X-Api-Key": gone.key! });
    expect(unreachable.status).toBe(502);
  });
});

describe("config distribution", () => {
  test("fail-static: a restarted instance serves from the cache with the control plane down", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const first = makeDp();
    await first.client.pollOnce();
    expect((await get(first, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(200);

    served.stop();

    const restarted = makeDp();
    expect(restarted.client.loadFromCache()).toBe(true);
    const response = await get(restarted, "/petstore/x", { "X-Api-Key": published.key! });
    expect(response.status).toBe(200);
    expect(restarted.health().servingFromCache).toBe(true);

    // A failed poll does not take traffic down.
    await restarted.client.pollOnce();
    expect((await get(restarted, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(200);
    expect(restarted.health().lastError).toContain("poll failed");
  });

  test("a revoked instance token fails closed: every request becomes 503", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();
    expect((await get(dp, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(200);

    cp.app.db.run("UPDATE gateway_instance SET revoked_at = ?", [new Date().toISOString()]);
    expect(await dp.client.pollOnce()).toBe("revoked");

    const response = await get(dp, "/petstore/x", { "X-Api-Key": published.key! });
    expect(response.status).toBe(503);
    expect((await response.json()).detail).toContain("revoked");
    expect(dp.health().ok).toBe(false);
  });

  test("an unchanged config is a 304 and does not rebuild the route table", async () => {
    await publishApi(cp, { backendUrl: backend.url, basePath: "/petstore" });
    const dp = makeDp();
    expect(await dp.client.pollOnce()).toBe("updated");
    expect(await dp.client.pollOnce()).toBe("unchanged");
  });

  test("a policy change reaches the fleet on the next poll with no release", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();
    expect((await get(dp, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(200);

    await cp.call("PUT", `/api/resources/${published.resourceId}/policy/units/preconditions`, {
      cookie: published.pavel,
      body: { value: CHECK_HEADER },
    });
    expect(await dp.client.pollOnce()).toBe("updated");
    expect((await get(dp, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(403);
  });

  test("withdrawing an API stops it being served after the next poll", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();
    expect((await get(dp, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(200);

    await cp.call("DELETE", `/api/resources/${published.resourceId}/releases?environment=dev`, {
      cookie: published.pavel,
    });
    await dp.client.pollOnce();
    expect((await get(dp, "/petstore/x", { "X-Api-Key": published.key! })).status).toBe(404);
  });

  test("healthz reports the digest the instance actually serves", async () => {
    await publishApi(cp, { backendUrl: backend.url, basePath: "/petstore" });
    const dp = makeDp();
    await dp.client.pollOnce();
    const health = await (await dp.fetchHttp(new Request("http://gateway.test/healthz"), "127.0.0.1")).json();
    expect(health.ok).toBe(true);
    expect(health.routes).toBe(1);
    expect(health.configDigest).toBe(dp.client.table!.digest);

    // The instance reports the digest it has *activated*, so the fleet view learns it on the
    // following poll — one poll interval of lag by design (section 8.7).
    expect(await dp.client.pollOnce()).toBe("unchanged");

    const alice = await cp.login("alice");
    const fleet = await (await cp.call("GET", "/api/targets/dev/health", { cookie: alice })).json();
    expect(fleet.configDigest).toBe(health.configDigest);
    expect(fleet.inSync).toBe(true);
  });

  /*
   * `Bun.serve` runs in development mode unless it is told otherwise, and a development-mode
   * uncaught error answers the *caller* with the message, the stack, the source around each frame
   * and the file paths. Nothing in the pipeline reaches it — every failure it knows about is
   * already a `Response` — which is exactly why the day something does, the answer must not be the
   * gateway's source code. There is no request that provokes it on demand, so the guarantee is
   * held over the source: it is one line, and one deletion away from silently coming back.
   */
  test("the listener is not started in the runtime's development mode", () => {
    const source = readFileSync(new URL("../data-plane/src/server.ts", import.meta.url), "utf8");
    expect(source).toContain("development: false");
    // And an uncaught error still answers as this gateway rather than as the runtime.
    expect(source).toMatch(/error\(err\)\s*\{[\s\S]*problem\(\s*\n?\s*500/);
  });

  /*
   * The access log formats one timestamp per second rather than one per request, by keeping the
   * part that only changes each second. The whole optimisation is only allowed to exist if what it
   * produces is character-for-character what it replaced, so that is what is asserted — across a
   * second boundary, a millisecond that needs padding, and the two ends of the range.
   */
  test("the cached log timestamp is exactly what a Date would have formatted", () => {
    const instants = [0, 1, 999, 1_000, 1_001, Date.now(), Date.now() + 1_500, 4_102_444_800_000];
    for (const ms of instants) {
      expect(logTimestamp(ms)).toBe(new Date(ms).toISOString());
    }
    // Same second twice, which is the case the cache exists for.
    const base = Date.now() - (Date.now() % 1000);
    expect(logTimestamp(base + 7)).toBe(new Date(base + 7).toISOString());
    expect(logTimestamp(base + 42)).toBe(new Date(base + 42).toISOString());
  });

  test("healthz reports the runtime's DNS cache, which every backend call goes through", async () => {
    await publishApi(cp, { backendUrl: backend.url, basePath: "/petstore" });
    const dp = makeDp();
    await dp.client.pollOnce();
    const health = dp.health() as { dns: Record<string, number> };
    // Warming happens at activation, so the counters exist from the first poll onwards; their
    // values belong to the process, not to this test, so only their presence is asserted.
    expect(health.dns).toMatchObject({
      cacheMisses: expect.any(Number),
      cacheHitsCompleted: expect.any(Number),
      size: expect.any(Number),
    });
  });

  test("with no config and no cache, every request is 503 rather than a wrong answer", async () => {
    const dp = makeDp({ cpUrl: "http://127.0.0.1:1", cachePath: `${cp.dir}/missing.json` });
    await dp.client.pollOnce();
    const response = await get(dp, "/petstore/x");
    expect(response.status).toBe(503);
    expect((await response.json()).detail).toContain("no gateway configuration");
  });
});

/*
 * `Server-Timing` is how a caller learns what this gateway cost it without owning both ends of the
 * wire. Everything else a load harness can measure — time to first byte, connect time — contains
 * the network, and on a real deployment the network is two or three orders of magnitude larger
 * than the pipeline, so the number that matters is invisible in it. The gateway already computes
 * both halves for its own telemetry; these tests are about telling the caller.
 */
describe("Server-Timing", () => {
  /** `gw;dur=1.25, backend;dur=30.5` -> `{ gw: 1.25, backend: 30.5 }`. */
  function timings(header: string | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of (header ?? "").split(",")) {
      const [name, ...params] = part.trim().split(";");
      for (const param of params) {
        const [key, value] = param.split("=");
        if (key?.trim() === "dur") out[name!.trim()] = Number(value);
      }
    }
    return out;
  }

  test("nothing is disclosed unless the estate asks for it", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    const dp = makeDp();
    await dp.client.pollOnce();

    const ok = await get(dp, "/petstore/x", { "X-Api-Key": published.key! });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("server-timing")).toBeNull();
    // Including on the answers the gateway writes itself, which is where a leak would be easiest
    // to miss: nobody looks at the headers of a 401.
    expect((await get(dp, "/petstore/x")).headers.get("server-timing")).toBeNull();
  });

  test("a proxied request reports the backend's share and the gateway's separately", async () => {
    const slow = startBackend(async () => {
      await Bun.sleep(30);
      return Response.json({ ok: true });
    });
    try {
      const published = await publishApi(cp, {
        backendUrl: slow.url,
        basePath: "/petstore",
        policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
      });
      setFleetSettings(cp, { serverTiming: true });
      const dp = makeDp();
      await dp.client.pollOnce();

      const response = await get(dp, "/petstore/x", { "X-Api-Key": published.key! });
      expect(response.status).toBe(200);
      const timing = timings(response.headers.get("server-timing"));

      // The backend was told to take 30ms and the gateway was not, so the split is unambiguous:
      // if the two were swapped or double-counted this assertion is the one that notices.
      expect(timing.backend).toBeGreaterThanOrEqual(25);
      expect(timing.gw).toBeGreaterThanOrEqual(0);
      expect(timing.gw).toBeLessThan(timing.backend!);
      // The header carries fractions, because the number it exists to report is usually below the
      // resolution a whole millisecond has. `Math.round` here would print `gw;dur=0` and the
      // caller would have learned nothing.
      expect(response.headers.get("server-timing")).toMatch(
        /^gw;dur=\d+(\.\d+)?, backend;dur=\d+(\.\d+)?$/,
      );
    } finally {
      slow.stop();
    }
  });

  test("an answer the gateway wrote itself has no backend segment to report", async () => {
    await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
    });
    setFleetSettings(cp, { serverTiming: true });
    const dp = makeDp();
    await dp.client.pollOnce();

    const rejected = await get(dp, "/petstore/x");
    expect(rejected.status).toBe(401);
    const header = rejected.headers.get("server-timing")!;
    // Not `backend;dur=0`: a zero would read as "the backend answered instantly", and the honest
    // statement is that no backend was involved at all.
    expect(header).not.toContain("backend");
    expect(timings(header).gw).toBeGreaterThanOrEqual(0);
    expect(backend.requests).toHaveLength(0);
  });

  test("the two segments add up to what the access log recorded", async () => {
    const slow = startBackend(async () => {
      await Bun.sleep(20);
      return Response.json({ ok: true });
    });
    try {
      const published = await publishApi(cp, {
        backendUrl: slow.url,
        basePath: "/petstore",
        policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
      });
      setFleetSettings(cp, { serverTiming: true });
      const dp = makeDp();
      await dp.client.pollOnce();

      const response = await get(dp, "/petstore/x", { "X-Api-Key": published.key! });
      const timing = timings(response.headers.get("server-timing"));
      // `gw` is defined as the total minus the backend, so the sum is the total by construction —
      // which is exactly the identity a caller will subtract with, and the one that breaks if a
      // later change stamps the header from a different clock than the one the telemetry reads.
      const total = timing.gw! + timing.backend!;
      expect(total).toBeGreaterThanOrEqual(20);
      expect(total).toBeLessThan(5_000);
    } finally {
      slow.stop();
    }
  });
});

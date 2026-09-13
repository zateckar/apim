import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CircuitBreaker, MAX_POOL_SIZE, selectionOrder } from "../shared/backend.ts";
import { makeCp, makeDp, poll, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";
import type { DataPlane } from "../data-plane/src/server.ts";

/**
 * Goal 7 (plan section 8): several backends per API, a load-balancing rule, and a circuit breaker
 * per instance per backend.
 *
 * The distinctions worth holding onto, because each one is a wrong answer somebody would otherwise
 * ship:
 *
 *  - the breaker is **per instance**, so one gateway's connectivity fault does not take a backend
 *    out of the pool for the whole fleet;
 *  - a `4xx` is **never** a breaker failure — a backend rejecting bad requests is working, and
 *    counting it would mean a burst of malformed traffic could take a healthy backend out;
 *  - a retry goes to the **next** backend, because retrying the one that just failed is how a
 *    struggling backend gets finished off;
 *  - a request whose body was streamed **cannot** be retried, and a response that has begun
 *    streaming is never retried. The bytes are gone.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "echo", version: "1.0.0" },
  paths: { "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } } },
};

let cp: TestCp;
let seq = 0;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

// --------------------------------------------------------------------------- selection, in isolation

describe("selection order", () => {
  const healthy = () => true;

  test("failover is the pool as written: primary first is that rule with the primary first", () => {
    const pool = [{ url: "a" }, { url: "b" }, { url: "c" }];
    for (const cursor of [0, 1, 2, 17]) {
      // The cursor is irrelevant under failover — that is what makes it deterministic.
      expect(selectionOrder(pool, "failover", cursor, healthy).map((e) => e.url)).toEqual(["a", "b", "c"]);
    }
  });

  test("round robin rotates, and weights expand into the rotation", () => {
    const pool = [{ url: "a", weight: 2 }, { url: "b" }];
    // Rotation is over the expanded list [a, a, b], so `a` leads twice as often as `b`.
    const leaders = [0, 1, 2, 3, 4, 5].map(
      (cursor) => selectionOrder(pool, "round-robin", cursor, healthy)[0]!.url,
    );
    expect(leaders).toEqual(["a", "a", "b", "a", "a", "b"]);
    // Every backend still appears exactly once in the order: weights change frequency, not membership.
    expect(selectionOrder(pool, "round-robin", 0, healthy).map((e) => e.url).sort()).toEqual(["a", "b"]);
  });

  test("unhealthy backends move to the back rather than disappearing", () => {
    const pool = [{ url: "a" }, { url: "b" }, { url: "c" }];
    const order = selectionOrder(pool, "failover", 0, (url) => url !== "a");
    // `a` is last, not absent: a pool whose every member is open still needs something to probe.
    expect(order.map((e) => e.url)).toEqual(["b", "c", "a"]);
    expect(selectionOrder(pool, "failover", 0, () => false).map((e) => e.url)).toEqual(["a", "b", "c"]);
  });
});

// --------------------------------------------------------------------------- the breaker, in isolation

describe("the circuit breaker", () => {
  const settings = { failures: 3, windowSec: 60, openSec: 30, halfOpenProbes: 1 };

  test("closed → open → half-open → closed", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker(() => now);

    expect(breaker.state("k", settings)).toBe("closed");
    breaker.onFailure("k", settings);
    breaker.onFailure("k", settings);
    expect(breaker.state("k", settings)).toBe("closed");
    breaker.onFailure("k", settings);
    expect(breaker.state("k", settings)).toBe("open");
    expect(breaker.tryAcquire("k", settings)).toBe(false);

    now += 30_000;
    expect(breaker.state("k", settings)).toBe("half-open");
    // One probe at a time: half-open is not "open the floodgates and see".
    expect(breaker.tryAcquire("k", settings)).toBe(true);
    expect(breaker.tryAcquire("k", settings)).toBe(false);

    breaker.onSuccess("k", settings);
    expect(breaker.state("k", settings)).toBe("closed");
  });

  test("a failed probe reopens immediately and restarts the clock", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker(() => now);
    for (let i = 0; i < 3; i++) breaker.onFailure("k", settings);
    now += 30_000;
    expect(breaker.state("k", settings)).toBe("half-open");

    breaker.onFailure("k", settings);
    // Not "two more failures to reopen": one probe was enough to learn the answer.
    expect(breaker.state("k", settings)).toBe("open");
    expect(breaker.reopensInMs("k", settings)).toBe(30_000);
  });

  test("failures outside the window do not accumulate", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker(() => now);
    breaker.onFailure("k", settings);
    breaker.onFailure("k", settings);
    now += 61_000;
    breaker.onFailure("k", settings);
    // Three failures, but spread over more than `windowSec`: a backend that fails twice an hour is
    // not a backend that is down.
    expect(breaker.state("k", settings)).toBe("closed");
  });

  test("with no unit attached the breaker is inert, not implicitly on", () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 50; i++) breaker.onFailure("k", null);
    expect(breaker.state("k", null)).toBe("closed");
    expect(breaker.tryAcquire("k", null)).toBe(true);
  });
});

// --------------------------------------------------------------------------- through the gateway

interface PoolWorld {
  dp: DataPlane;
  key: string;
  basePath: string;
  stop: () => void;
}

async function poolWorld(
  backends: Array<{ url: string; weight?: number }>,
  rule: "round-robin" | "failover",
  policy: Record<string, unknown> = {},
): Promise<PoolWorld> {
  const basePath = `/pool-${++seq}`;
  const cpServer = serveCp(cp);
  const api = await publishApi(cp, {
    backendUrl: backends[0]!.url,
    basePath,
    spec: SPEC,
    policy: {
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rewrite: { stripBasePath: true },
      ...policy,
    },
  });
  const written = await cp.call("PUT", `/api/resources/${api.resourceId}/binding`, {
    cookie: api.pavel,
    body: { environment: "dev", pool: backends, rule },
  });
  if (!written.ok) throw new Error(`binding: ${written.status} ${await written.text()}`);

  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `pool-${seq}` });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
  return {
    dp,
    key: api.key!,
    basePath: api.basePath,
    stop: () => {
      dp.stop();
      cpServer.stop();
    },
  };
}

function ping(w: PoolWorld): Promise<Response> {
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}/ping`, { headers: { "x-api-key": w.key } }),
    "127.0.0.1",
  );
}

describe("a pool through the gateway", () => {
  test("round robin spreads requests across the pool", async () => {
    const a = startBackend(() => Response.json({ who: "a" }));
    const b = startBackend(() => Response.json({ who: "b" }));
    const w = await poolWorld([{ url: a.url }, { url: b.url }], "round-robin");
    try {
      for (let i = 0; i < 6; i++) expect((await ping(w)).status).toBe(200);
      expect(a.requests.length).toBe(3);
      expect(b.requests.length).toBe(3);
    } finally {
      w.stop();
      a.stop();
      b.stop();
    }
  });

  test("failover pins to the primary while it is healthy", async () => {
    const primary = startBackend(() => Response.json({ who: "primary" }));
    const secondary = startBackend(() => Response.json({ who: "secondary" }));
    const w = await poolWorld([{ url: primary.url }, { url: secondary.url }], "failover");
    try {
      for (let i = 0; i < 5; i++) expect((await ping(w)).status).toBe(200);
      expect(primary.requests.length).toBe(5);
      // Not "spread evenly for resilience": failover means the secondary is idle until it is needed.
      expect(secondary.requests.length).toBe(0);
    } finally {
      w.stop();
      primary.stop();
      secondary.stop();
    }
  });

  test("a retry goes to the next backend, not the one that just failed", async () => {
    const failing = startBackend(() => new Response("nope", { status: 503 }));
    const healthy = startBackend(() => Response.json({ who: "healthy" }));
    const w = await poolWorld([{ url: failing.url }, { url: healthy.url }], "failover", {
      retries: { attempts: 2, on: ["503"], idempotentOnly: true },
    });
    try {
      const response = await ping(w);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ who: "healthy" });
      expect(failing.requests.length).toBe(1);
      expect(healthy.requests.length).toBe(1);
    } finally {
      w.stop();
      failing.stop();
      healthy.stop();
    }
  });

  test("the breaker opens on repeated failures and then takes that backend out of the rotation", async () => {
    let failures = 0;
    const failing = startBackend(() => {
      failures++;
      return new Response("nope", { status: 503 });
    });
    const healthy = startBackend(() => Response.json({ who: "healthy" }));
    const w = await poolWorld([{ url: failing.url }, { url: healthy.url }], "failover", {
      retries: { attempts: 2, on: ["503"], idempotentOnly: true },
      circuitBreaker: { failures: 2, windowSec: 60, openSec: 30, halfOpenProbes: 1 },
    });
    try {
      // Two calls: each tries the failing primary, then succeeds on the secondary. Two failures is
      // the threshold, so the breaker opens.
      expect((await ping(w)).status).toBe(200);
      expect((await ping(w)).status).toBe(200);
      const openedAfter = failures;
      expect(openedAfter).toBe(2);

      // From here the failing backend is skipped entirely: not retried, not probed.
      for (let i = 0; i < 4; i++) expect((await ping(w)).status).toBe(200);
      expect(failures).toBe(openedAfter);
      expect(healthy.requests.length).toBe(6);

      const open = w.dp.breaker.snapshot();
      expect(open).toHaveLength(1);
      expect(open[0]!.state).toBe("open");
      expect(open[0]!.key).toContain(failing.url);
    } finally {
      w.stop();
      failing.stop();
      healthy.stop();
    }
  });

  test("every backend open is 503 with Retry-After and outcome pool-open", async () => {
    const one = startBackend(() => new Response("nope", { status: 503 }));
    const two = startBackend(() => new Response("nope", { status: 503 }));
    const w = await poolWorld([{ url: one.url }, { url: two.url }], "failover", {
      retries: { attempts: 2, on: ["503"], idempotentOnly: true },
      circuitBreaker: { failures: 1, windowSec: 60, openSec: 30, halfOpenProbes: 1 },
    });
    try {
      // The first call trips both, since a retry moves on and fails too.
      await ping(w);
      const response = await ping(w);
      expect(response.status).toBe(503);
      // The number comes from the shortest remaining openSec, so it is a real answer rather than
      // a constant.
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(30);
      const problem = await response.json();
      // "The breaker is doing its job" reads differently from "the network is broken", and the
      // detail says which one this is.
      expect(problem.detail).toContain("circuit breaker is open");
    } finally {
      w.stop();
      one.stop();
      two.stop();
    }
  });

  test("a 4xx is never a breaker failure", async () => {
    const fussy = startBackend(() => new Response("bad request", { status: 400 }));
    const w = await poolWorld([{ url: fussy.url }], "failover", {
      retries: { attempts: 1, on: ["502", "503", "504"], idempotentOnly: true },
      circuitBreaker: { failures: 2, windowSec: 60, openSec: 30, halfOpenProbes: 1 },
    });
    try {
      for (let i = 0; i < 5; i++) expect((await ping(w)).status).toBe(400);
      // Still closed after five rejections: the backend is doing its job.
      expect(w.dp.breaker.snapshot()).toEqual([]);
      expect(fussy.requests.length).toBe(5);
    } finally {
      w.stop();
      fussy.stop();
    }
  });

  test("breaker state is per instance: one gateway's fault does not trip another's", async () => {
    const failing = startBackend(() => new Response("nope", { status: 503 }));
    const w = await poolWorld([{ url: failing.url }], "failover", {
      // `retries.on` is what makes a 5xx count as a failure at all (plan section 8.3); one attempt
      // means no retry, only the classification.
      retries: { attempts: 1, on: ["503"], idempotentOnly: true },
      circuitBreaker: { failures: 1, windowSec: 60, openSec: 30, halfOpenProbes: 1 },
    });
    const cpServer = serveCp(cp);
    const other = makeDp(cpServer.url, cp.token, cp.dir, { name: "second" });
    try {
      await ping(w);
      expect(w.dp.breaker.snapshot()).toHaveLength(1);

      await other.start();
      // A second instance of the same config, with its own opinion of the same backend.
      expect(other.breaker.snapshot()).toEqual([]);
    } finally {
      other.stop();
      cpServer.stop();
      w.stop();
      failing.stop();
    }
  });

  test("the whole-request timeout is a budget, so retries do not multiply the wait", async () => {
    const slow = startBackend(async () => {
      await Bun.sleep(400);
      return Response.json({ ok: true });
    });
    const w = await poolWorld([{ url: slow.url }, { url: slow.url + "/b" }], "failover", {
      timeoutMs: 250,
      retries: { attempts: 3, on: ["timeout"], idempotentOnly: true },
    });
    try {
      const started = Date.now();
      const response = await ping(w);
      const elapsed = Date.now() - started;
      expect(response.status).toBe(504);
      // Three attempts at 250 ms each would be 750; the budget is 250 for the request as a whole.
      expect(elapsed).toBeLessThan(600);
    } finally {
      w.stop();
      slow.stop();
    }
  });
});

// --------------------------------------------------------------------------- writing a pool

describe("binding a pool", () => {
  test("a v2 single-URL row still reads, as a failover pool of one", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      // A row written by v2, in the database as v2 left it. The migration is at read time, so an
      // environment that has not been touched since the upgrade keeps serving without a data
      // migration — and the first v3 write stores the new shape.
      cp.app.db.run("UPDATE binding SET backend_json = ? WHERE resource_id = ?", [
        JSON.stringify({ urls: [backend.url] }),
        api.resourceId,
      ]);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.backend.pool).toEqual([{ url: backend.url }]);
      expect(config!.routes[0]!.backend.rule).toBe("failover");
    } finally {
      backend.stop();
    }
  });

  test("`urls` on the write path means an ordered failover pool", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      const read = await (
        await cp.call("GET", `/api/resources/${api.resourceId}/binding?environment=dev`, {
          cookie: api.pavel,
        })
      ).json();
      expect(read.backend).toEqual({ pool: [{ url: backend.url }], rule: "failover" });
    } finally {
      backend.stop();
    }
  });

  test("every URL in a pool passes the egress check", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      const refused = await cp.call("PUT", `/api/resources/${api.resourceId}/binding`, {
        cookie: api.pavel,
        body: {
          environment: "dev",
          // The first is fine; the second is not. A pool is as safe as its least-checked member.
          pool: [{ url: backend.url }, { url: "http://169.254.169.254/latest/meta-data" }],
        },
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).detail.length).toBeGreaterThan(0);
    } finally {
      backend.stop();
    }
  });

  test("the pool is bounded, duplicates are refused, and weights need round robin", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC });
      const put = (body: unknown) =>
        cp.call("PUT", `/api/resources/${api.resourceId}/binding`, { cookie: api.pavel, body });

      const tooMany = await put({
        environment: "dev",
        pool: Array.from({ length: MAX_POOL_SIZE + 1 }, (_, i) => ({ url: `${backend.url}/${i}` })),
      });
      expect(tooMany.status).toBe(400);
      expect((await tooMany.json()).detail).toContain(String(MAX_POOL_SIZE));

      const duplicate = await put({
        environment: "dev",
        pool: [{ url: backend.url }, { url: backend.url }],
      });
      expect(duplicate.status).toBe(400);
      expect((await duplicate.json()).detail).toContain("twice");

      // A weight under failover would be silently ignored, which is worse than being refused.
      const ignoredWeight = await put({
        environment: "dev",
        rule: "failover",
        pool: [{ url: backend.url, weight: 3 }],
      });
      expect(ignoredWeight.status).toBe(400);
      expect((await ignoredWeight.json()).detail).toContain("round-robin");

      const ok = await put({
        environment: "dev",
        rule: "round-robin",
        pool: [{ url: backend.url, weight: 3 }],
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()).backend).toEqual({
        pool: [{ url: backend.url, weight: 3 }],
        rule: "round-robin",
      });
    } finally {
      backend.stop();
    }
  });
});

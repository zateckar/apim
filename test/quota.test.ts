import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QuotaCounters } from "../data-plane/src/quota.ts";
import { QuotaService } from "../control-plane/src/quota.ts";
import { windowStart, windowResetSec } from "../shared/quota.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";
import type { DataPlane } from "../data-plane/src/server.ts";

/**
 * Design section 5.7: quota is fleet-wide, and that is the whole reason it exists separately from
 * rate limiting.
 *
 * A per-instance monthly quota is not a quota — 100,000 calls times six instances is 600,000, and a
 * consumer told they have 100,000 would be wrong by a factor of the fleet size. So each instance
 * counts locally, reports its delta on the poll that already exists, and receives the fleet's total
 * back. Enforcement is `aggregate_at_last_poll + own_delta_since >= calls`.
 *
 * What that buys and what it costs, both stated:
 *
 *  - no shared datastore, no new protocol, no coordination on the request path;
 *  - worst-case overshoot before convergence is the fleet's traffic in one poll interval;
 *  - a lost report **under-counts**, deliberately. Replaying a delta would double-count a consumer
 *    into a 403 they did not earn, and this design would rather let a few calls through.
 *
 * Rate limiting shares none of this: per instance, in memory, uncoordinated, nothing from the
 * control plane at all.
 */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "meter", version: "1.0.0" },
  paths: { "/tick": { get: { operationId: "tick", responses: { "200": { description: "ok" } } } } },
};

let cp: TestCp;
let seq = 0;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

// --------------------------------------------------------------------------- windows

describe("fixed windows", () => {
  test("windows align to the UNIX epoch, so 'when does my quota reset' has an answer", () => {
    // Not rolling: a sliding window cannot be explained to a consumer without explaining a sliding
    // window, and "the first of the month at midnight UTC" can.
    expect(windowStart(3600, Date.parse("2026-09-02T13:47:11Z"))).toBe("2026-09-02T13:00:00.000Z");
    expect(windowStart(86_400, Date.parse("2026-09-02T13:47:11Z"))).toBe("2026-09-02T00:00:00.000Z");
    expect(windowStart(60, Date.parse("2026-09-02T13:47:11Z"))).toBe("2026-09-02T13:47:00.000Z");

    // Every instance computes the same boundary from the same clock, with nothing exchanged:
    // 13:47:11 to the top of the hour is 12m49s.
    expect(windowResetSec(3600, Date.parse("2026-09-02T13:47:11Z"))).toBe(12 * 60 + 49);
  });
});

// --------------------------------------------------------------------------- the instance counter

describe("the per-instance counter", () => {
  test("enforcement is the fleet aggregate plus this instance's own delta since", () => {
    const counters = new QuotaCounters();
    const key = counters.keyFor("sub_1", "route", "res_1", 3600);

    // The fleet has already used 8 of 10, as of the last poll.
    counters.applyAggregates([{ ...key, count: 8 }]);
    expect(counters.peek(key, 10).used).toBe(8);

    expect(counters.check(key, 10).allowed).toBe(true); // 9
    expect(counters.check(key, 10).allowed).toBe(true); // 10
    const over = counters.check(key, 10);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
    // The reset is a real number, so a 403 can say when to come back.
    expect(over.resetSec).toBeGreaterThan(0);
  });

  test("a delta is handed over once, and an acknowledged aggregate absorbs it", () => {
    const counters = new QuotaCounters();
    const key = counters.keyFor("sub_1", "route", "res_1", 3600);
    for (let i = 0; i < 3; i++) counters.check(key, 100);

    const deltas = counters.takeDeltas();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.count).toBe(3);
    // Moved aside, so a second poll cannot send them again.
    expect(counters.takeDeltas()).toHaveLength(0);

    // The control plane's answer already contains our three.
    counters.applyAggregates([{ ...key, count: 3 }]);
    expect(counters.peek(key, 100).used).toBe(3);
  });

  test("a lost report under-counts rather than double-counting", () => {
    const counters = new QuotaCounters();
    const key = counters.keyFor("sub_1", "route", "res_1", 3600);
    for (let i = 0; i < 5; i++) counters.check(key, 100);
    counters.takeDeltas();

    // The poll failed. The five calls are gone from the fleet's total, on purpose: replaying them
    // after a partially-successful poll would count them twice and 403 a consumer who was inside
    // their quota.
    counters.dropInFlight();
    counters.applyAggregates([{ ...key, count: 0 }]);
    expect(counters.peek(key, 100).used).toBe(0);
  });

  test("enforcement continues through a control-plane outage, at the last known aggregate", () => {
    const counters = new QuotaCounters();
    const key = counters.keyFor("sub_1", "route", "res_1", 3600);
    counters.applyAggregates([{ ...key, count: 9 }]);

    // No further polls; this instance keeps counting on top of what it last knew. Staleness makes
    // it permissive, never blind.
    expect(counters.check(key, 10).allowed).toBe(true);
    expect(counters.check(key, 10).allowed).toBe(false);
  });

  test("the counter table is bounded and old windows are swept", () => {
    let now = Date.parse("2026-09-02T12:00:00Z");
    const counters = new QuotaCounters(3, () => now);
    for (let i = 0; i < 5; i++) counters.check(counters.keyFor(`sub_${i}`, "route", "r", 60), 10);
    expect(counters.size).toBeLessThanOrEqual(3);

    now += 3 * 3_600_000;
    counters.sweep();
    // A window that closed an hour ago cannot receive traffic, so remembering it is only cost.
    expect(counters.size).toBe(0);
  });
});

// --------------------------------------------------------------------------- the fleet aggregate

describe("the control-plane aggregate", () => {
  test("deltas from several instances add up, and the total comes back", () => {
    const service = new QuotaService(cp.app.db);
    const key = {
      subscriptionId: "sub_1",
      scopeKind: "route" as const,
      scopeId: "res_1",
      periodSec: 3600,
      windowStart: windowStart(3600),
    };

    service.accept("dev", [{ ...key, count: 4 }]);
    service.accept("dev", [{ ...key, count: 7 }]);
    // Pending counts before it is flushed: an instance must never be told a smaller number than it
    // just reported.
    expect(service.aggregatesFor("dev")[0]!.count).toBe(11);

    expect(service.flush()).toBe(1);
    const afterFlush = service.aggregatesFor("dev");
    expect(afterFlush).toHaveLength(1);
    expect(afterFlush[0]!.count).toBe(11);

    // A second flush cycle adds rather than replaces.
    service.accept("dev", [{ ...key, count: 2 }]);
    service.flush();
    expect(service.aggregatesFor("dev")[0]!.count).toBe(13);
  });

  test("environments do not see each other's counts", () => {
    const service = new QuotaService(cp.app.db);
    const key = {
      subscriptionId: "sub_1",
      scopeKind: "route" as const,
      scopeId: "res_1",
      periodSec: 3600,
      windowStart: windowStart(3600),
    };
    service.accept("dev", [{ ...key, count: 5 }]);
    service.accept("prod", [{ ...key, count: 90 }]);
    service.flush();

    expect(service.aggregatesFor("dev")[0]!.count).toBe(5);
    expect(service.aggregatesFor("prod")[0]!.count).toBe(90);
  });

  test("a closed window is not reported back, and is swept", () => {
    let now = Date.parse("2026-09-02T12:30:00Z");
    const service = new QuotaService(cp.app.db, 2000, () => now);
    service.accept("dev", [
      {
        subscriptionId: "sub_1",
        scopeKind: "route" as const,
        scopeId: "res_1",
        periodSec: 3600,
        windowStart: windowStart(3600, now),
        count: 3,
      },
    ]);
    service.flush();
    expect(service.aggregatesFor("dev")).toHaveLength(1);

    now += 3 * 3_600_000;
    // Nothing can be counted against a window that closed, so sending it would only cost bytes.
    expect(service.aggregatesFor("dev")).toHaveLength(0);
    expect(service.sweep()).toBe(1);
  });

  test("the payload is bounded in both directions, and the truncation is counted", () => {
    const service = new QuotaService(cp.app.db, 2);
    const deltas = [1, 2, 3, 4].map((n) => ({
      subscriptionId: `sub_${n}`,
      scopeKind: "route" as const,
      scopeId: "res_1",
      periodSec: 3600,
      windowStart: windowStart(3600),
      count: 1,
    }));
    service.accept("dev", deltas);
    expect(service.stats().pending).toBe(2);
    // Silent truncation would read as "that traffic did not happen".
    expect(service.stats().droppedDeltas).toBe(2);
  });
});

// --------------------------------------------------------------------------- end to end

interface World {
  dp: DataPlane;
  key: string;
  basePath: string;
  stop: () => void;
}

async function world(policy: Record<string, unknown>, name = `q-${++seq}`): Promise<World> {
  const basePath = `/meter-${seq}`;
  const backend = startBackend(() => Response.json({ ok: true }));
  const cpServer = serveCp(cp);
  const api = await publishApi(cp, {
    backendUrl: backend.url,
    basePath,
    spec: SPEC,
    policy: {
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      rewrite: { stripBasePath: true },
      ...policy,
    },
  });
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name });
  await dp.start();
  if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
  return {
    dp,
    key: api.key!,
    basePath: api.basePath,
    stop: () => {
      dp.stop();
      cpServer.stop();
      backend.stop();
    },
  };
}

function tick(w: World): Promise<Response> {
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}/tick`, { headers: { "x-api-key": w.key } }),
    "127.0.0.1",
  );
}

describe("quota through the gateway", () => {
  test("past the quota the answer is 403 with a reset, not 429", async () => {
    const w = await world({
      quota: { calls: 3, periodSec: 3600, per: "fleet", by: "subscription", scope: "route" },
    });
    try {
      for (let i = 0; i < 3; i++) expect((await tick(w)).status).toBe(200);
      const over = await tick(w);
      // 403 rather than 429: a rate limit says "slow down", a quota says "you have spent your
      // allowance", and only one of those is fixed by waiting a second.
      expect(over.status).toBe(403);
      const problem = await over.json();
      expect(problem.limit).toBe(3);
      expect(problem.resetSec).toBeGreaterThan(0);
    } finally {
      w.stop();
    }
  });

  test("two instances share one allowance once they have both polled", async () => {
    const backend = startBackend(() => Response.json({ ok: true }));
    const cpServer = serveCp(cp);
    const basePath = "/shared";
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      basePath,
      spec: SPEC,
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        rewrite: { stripBasePath: true },
        quota: { calls: 4, periodSec: 3600, per: "fleet", by: "subscription", scope: "route" },
      },
    });
    const one = makeDp(cpServer.url, cp.token, cp.dir, { name: "one" });
    const two = makeDp(cpServer.url, cp.token, cp.dir, { name: "two" });
    try {
      await one.start();
      await two.start();
      const call = (dp: DataPlane) =>
        dp.fetchHttp(
          new Request(`http://gw${api.basePath}/tick`, { headers: { "x-api-key": api.key! } }),
          "127.0.0.1",
        );

      // Three on one instance, one on the other: four in total, which is the whole allowance.
      for (let i = 0; i < 3; i++) expect((await call(one)).status).toBe(200);
      expect((await call(two)).status).toBe(200);

      // Both report; the control plane sums; both receive the total.
      expect(await one.client.pollOnce()).not.toBe("error");
      expect(await two.client.pollOnce()).not.toBe("error");
      cp.app.quota.flush();
      expect(await one.client.pollOnce()).not.toBe("error");
      expect(await two.client.pollOnce()).not.toBe("error");

      // Neither instance had counted four itself. Without the exchange, each would still think it
      // had three left — which is exactly the "times the fleet size" bug.
      expect((await call(one)).status).toBe(403);
      expect((await call(two)).status).toBe(403);
    } finally {
      one.stop();
      two.stop();
      cpServer.stop();
      backend.stop();
    }
  });

  test("product scope shares one allowance across every API in the product", async () => {
    const backend = startBackend(() => Response.json({ ok: true }));
    const cpServer = serveCp(cp);
    try {
      const quota = { calls: 2, periodSec: 3600, per: "fleet", by: "subscription", scope: "product" };
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/prod-a",
        spec: SPEC,
        name: "alpha",
        policy: {
          "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
          rewrite: { stripBasePath: true },
          quota,
        },
      });
      const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "prod-scope" });
      await dp.start();
      try {
        const call = () =>
          dp.fetchHttp(
            new Request(`http://gw${api.basePath}/tick`, { headers: { "x-api-key": api.key! } }),
            "127.0.0.1",
          );
        expect((await call()).status).toBe(200);
        expect((await call()).status).toBe(200);
        expect((await call()).status).toBe(403);

        // The counter is keyed by the product, not the route, which is what makes it shared.
        const deltas = dp.quota.takeDeltas();
        expect(deltas[0]!.scopeKind).toBe("product");
        expect(deltas[0]!.scopeId).toBe(api.productId);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("deltas ride the poll that already exists, and the aggregate comes back on it", async () => {
    const w = await world({
      quota: { calls: 100, periodSec: 3600, per: "fleet", by: "subscription", scope: "route" },
    });
    try {
      for (let i = 0; i < 5; i++) await tick(w);
      expect(await w.dp.client.pollOnce()).not.toBe("error");

      // Not a second channel and not a second round trip: one POST carries telemetry and quota up
      // and config and aggregates down.
      cp.app.quota.flush();
      const stored = cp.app.db
        .query<{ count: number; scope_kind: string }, []>(
          "SELECT count, scope_kind FROM usage_counter",
        )
        .get();
      expect(stored!.count).toBe(5);
      expect(stored!.scope_kind).toBe("route");

      expect(await w.dp.client.pollOnce()).not.toBe("error");
      const key = w.dp.quota.keyFor(
        w.dp.client.table!.subscriptionCount > 0 ? storedSubscriptionId(cp) : "",
        "route",
        w.dp.client.table!.routes[0]!.resourceId,
        3600,
      );
      expect(w.dp.quota.peek(key, 100).used).toBe(5);
    } finally {
      w.stop();
    }
  });

  test("a quota with no subscription to attribute is not enforced", async () => {
    // `by: "subscription"` needs one; an anonymous route has nothing to count against, and
    // counting it against the route would meter every consumer together.
    const w = await world({
      quota: { calls: 1, periodSec: 3600, per: "fleet", by: "subscription", scope: "route" },
    });
    try {
      const anonymous = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/tick`),
        "127.0.0.1",
      );
      // Refused for want of a key, before quota is even reached.
      expect(anonymous.status).toBe(401);
      expect(w.dp.quota.size).toBe(0);
    } finally {
      w.stop();
    }
  });
});

function storedSubscriptionId(cp: TestCp): string {
  return cp.app.db.query<{ id: string }, []>("SELECT id FROM subscription LIMIT 1").get()!.id;
}

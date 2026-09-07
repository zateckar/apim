import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ElkLogSearch,
  emptyBuckets,
  intervalFor,
  MockLogSearch,
  readableResourceIds,
  type LogQuery,
} from "../control-plane/src/logs.ts";
import { resetLogSearchCache } from "../control-plane/src/api/logs.ts";
import { makeCp, MINI_SPEC, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * The Logs capability, which is a *read* over an external index and nothing else.
 *
 * Two things are worth holding still. Authorization is applied by turning the caller into a list
 * of resource ids before a query exists, so there is no shape of request that reaches somebody
 * else's traffic. And the mock is a pure function of (resource, minute) — the list and the
 * histogram have to agree, or the screen shows a spike the table cannot produce.
 */

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;
let published: Awaited<ReturnType<typeof publishApi>>;

/** Every `operationId` the published fixture declares, read off the fixture itself. */
const OPERATION_IDS = Object.values(MINI_SPEC.paths).flatMap((methods) =>
  Object.values(methods as Record<string, { operationId: string }>).map((op) => op.operationId),
);

beforeAll(async () => {
  backend = startBackend();
  cp = makeCp();
  published = await publishApi(cp, { backendUrl: backend.url });
  resetLogSearchCache();
});

afterAll(() => {
  cp.close();
  backend.stop();
});

function query(over: Partial<LogQuery> = {}): LogQuery {
  const to = new Date("2026-09-05T12:00:00.000Z");
  return {
    environment: "dev",
    resourceIds: [published.resourceId],
    from: new Date(to.getTime() - 6 * 3600_000),
    to,
    limit: 50,
    offset: 0,
    ...over,
  };
}

describe("bucket arithmetic", () => {
  test("the interval is snapped to a readable unit, never a raw division", () => {
    const from = new Date("2026-09-05T00:00:00Z");
    // Six hours over 48 buckets is 450 s ideal; the next round unit up is ten minutes.
    expect(intervalFor(from, new Date("2026-09-05T06:00:00Z"), 48)).toBe(600);
    // One hour over 48 is 75 s ideal → five minutes.
    expect(intervalFor(from, new Date("2026-09-05T01:00:00Z"), 48)).toBe(300);
    // A very wide window saturates at a week rather than inventing a unit.
    expect(intervalFor(from, new Date("2027-09-05T00:00:00Z"), 4)).toBe(604800);
  });

  test("buckets are aligned to the interval, so two windows agree about where an instant sits", () => {
    const interval = 600;
    const a = emptyBuckets(new Date("2026-09-05T10:07:00Z"), new Date("2026-09-05T11:00:00Z"), interval);
    const b = emptyBuckets(new Date("2026-09-05T10:23:00Z"), new Date("2026-09-05T11:00:00Z"), interval);
    const shared = a.map((x) => x.at).filter((at) => b.some((y) => y.at === at));
    expect(shared.length).toBeGreaterThan(0);
    for (const at of shared) expect(Date.parse(at) % (interval * 1000)).toBe(0);
  });
});

describe("the simulated index", () => {
  test("is deterministic: the same window twice is the same evidence", async () => {
    const provider = new MockLogSearch(cp.app);
    const first = await provider.search(query());
    const second = await new MockLogSearch(cp.app).search(query());
    expect(first.items.length).toBeGreaterThan(0);
    expect(second.items.map((e) => e.id)).toEqual(first.items.map((e) => e.id));
  });

  test("marks itself simulated on every response", async () => {
    const provider = new MockLogSearch(cp.app);
    expect((await provider.search(query())).simulated).toBe(true);
    expect((await provider.histogram(query(), 24)).simulated).toBe(true);
    expect((await provider.probe()).detail).toContain("simulated");
  });

  test("the histogram totals what the list contains", async () => {
    const provider = new MockLogSearch(cp.app);
    const all = await provider.search(query({ limit: 200, offset: 0 }));
    const histogram = await provider.histogram(query(), 36);
    const counted = histogram.buckets.reduce((sum, b) => sum + b.total, 0);
    // The list is paged; `total` is the whole window, and that is what the histogram sums to.
    expect(counted).toBe(all.total);
    for (const bucket of histogram.buckets) {
      expect(bucket.ok + bucket.clientError + bucket.serverError).toBe(bucket.total);
    }
  });

  test("paging is stable and does not repeat or drop an entry", async () => {
    const provider = new MockLogSearch(cp.app);
    const whole = await provider.search(query({ limit: 60 }));
    const firstHalf = await provider.search(query({ limit: 30, offset: 0 }));
    const secondHalf = await provider.search(query({ limit: 30, offset: 30 }));
    expect([...firstHalf.items, ...secondHalf.items].map((e) => e.id)).toEqual(
      whole.items.map((e) => e.id),
    );
  });

  test("entries are newest first and inside the window", async () => {
    const q = query();
    const items = (await new MockLogSearch(cp.app).search(q)).items;
    for (let i = 1; i < items.length; i++) {
      expect(Date.parse(items[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(items[i]!.at));
    }
    for (const entry of items) {
      expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(q.from.getTime());
      expect(Date.parse(entry.at)).toBeLessThanOrEqual(q.to.getTime());
    }
  });

  test("is derived from the estate: the real base path and the real operations", async () => {
    const items = (await new MockLogSearch(cp.app).search(query({ limit: 200 }))).items;
    expect(items.length).toBeGreaterThan(0);
    for (const entry of items) {
      expect(entry.path.startsWith(published.basePath)).toBe(true);
      expect(entry.resourceName).toBe(published.name);
      // Derived from the fixture rather than restated, which is what this test is about: the two
      // hard-coded names it used to carry went stale the moment the fixture grew an operation.
      if (entry.operationId) expect(OPERATION_IDS).toContain(entry.operationId);
    }
  });

  test("filters compose, and a filter that matches nothing returns nothing rather than everything", async () => {
    const provider = new MockLogSearch(cp.app);
    const serverErrors = await provider.search(query({ statusClass: "5xx", limit: 200 }));
    for (const entry of serverErrors.items) expect(entry.status).toBeGreaterThanOrEqual(500);
    const impossible = await provider.search(query({ pathContains: "/no-such-segment", limit: 200 }));
    expect(impossible.items).toHaveLength(0);
    expect(impossible.total).toBe(0);
  });

  test("no readable resources means no rows, not every row", async () => {
    const page = await new MockLogSearch(cp.app).search(query({ resourceIds: [] }));
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});

describe("authorization is applied before a query exists", () => {
  test("a publisher sees their own API; a consumer of it does not", () => {
    const pavel = { id: "pavel", name: "Pavel", roles: [], applications: ["application_platform"], isAdmin: false };
    const clara = { id: "clara", name: "Clara", roles: [], applications: ["application_orders"], isAdmin: false };
    const alice = { id: "alice", name: "Alice", roles: [], applications: [], isAdmin: true };
    expect(readableResourceIds(cp.app, pavel, "dev")).toContain(published.resourceId);
    // Clara holds an active subscription to this API and still may not read its access lines:
    // the line carries the publisher's backend latency and error text.
    expect(readableResourceIds(cp.app, clara, "dev")).not.toContain(published.resourceId);
    expect(readableResourceIds(cp.app, alice, "dev")).toContain(published.resourceId);
    expect(readableResourceIds(cp.app, null, "dev")).toHaveLength(0);
  });

  test("naming somebody else's resource narrows to nothing rather than widening", () => {
    const clara = { id: "clara", name: "Clara", roles: [], applications: ["application_orders"], isAdmin: false };
    expect(readableResourceIds(cp.app, clara, "dev", published.resourceId)).toHaveLength(0);
  });
});

describe("the HTTP surface", () => {
  test("refuses a window wider than the configured ceiling, naming the variable", async () => {
    const cookie = await cp.login("pavel");
    const response = await cp.call("GET", "/api/logs?environment=dev&sinceMin=99999999", { cookie });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("LOGS_MAX_RANGE_HOURS");
  });

  test("refuses an unknown status class and an unknown environment", async () => {
    const cookie = await cp.login("pavel");
    expect((await cp.call("GET", "/api/logs?environment=dev&status=6xx", { cookie })).status).toBe(400);
    expect((await cp.call("GET", "/api/logs?environment=nowhere", { cookie })).status).toBe(400);
  });

  test("answers the list and the histogram, and says which provider answered", async () => {
    const cookie = await cp.login("pavel");
    const list = await cp.call("GET", "/api/logs?environment=dev&sinceMin=360&limit=20", { cookie });
    expect(list.status).toBe(200);
    const page = await list.json();
    expect(page.provider).toBe("mock");
    expect(page.simulated).toBe(true);
    expect(page.window.from).toBeTruthy();
    expect(page.items.length).toBeLessThanOrEqual(20);

    const chart = await cp.call("GET", "/api/logs/histogram?environment=dev&sinceMin=360&buckets=24", {
      cookie,
    });
    expect(chart.status).toBe(200);
    const histogram = await chart.json();
    expect(histogram.provider).toBe("mock");
    expect(histogram.intervalSec).toBeGreaterThan(0);
    expect(histogram.buckets.length).toBeGreaterThan(0);
  });

  test("is refused without a session", async () => {
    expect((await cp.call("GET", "/api/logs?environment=dev")).status).toBe(401);
  });
});

describe("the ELK client", () => {
  test("passes the caller's substring as a literal, never as a pattern", async () => {
    let captured: any = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured = await req.json();
        return Response.json({ hits: { total: { value: 0, relation: "eq" }, hits: [] } });
      },
    });
    const provider = new ElkLogSearch({
      provider: "elk",
      url: `http://localhost:${server.port}`,
      index: "apim-access-*",
      apiKey: "k",
      username: null,
      password: null,
      timeoutMs: 5000,
      maxResultWindow: 10_000,
      maxRangeHours: 720,
    });
    await provider.search(query({ pathContains: "a*b" }));
    const clauses = captured.query.bool.filter;
    const wildcard = clauses.find((c: any) => c.wildcard);
    expect(wildcard.wildcard["url.path"].value).toBe("*a\\*b*");
    // The resource scope is a terms clause built from the authorized list, not from the request.
    expect(clauses.find((c: any) => c.terms).terms["apim.resource_id"]).toEqual([published.resourceId]);
    server.stop(true);
  });

  test("refuses a page past the result window instead of letting the cluster refuse it", async () => {
    const provider = new ElkLogSearch({
      provider: "elk",
      url: "http://localhost:1",
      index: "i",
      apiKey: "k",
      username: null,
      password: null,
      timeoutMs: 100,
      maxResultWindow: 100,
      maxRangeHours: 720,
    });
    await expect(provider.search(query({ offset: 200 }))).rejects.toThrow("result window");
  });

  test("reports an unreachable cluster rather than throwing", async () => {
    const provider = new ElkLogSearch({
      provider: "elk",
      url: "http://127.0.0.1:1",
      index: "i",
      apiKey: "k",
      username: null,
      password: null,
      timeoutMs: 250,
      maxResultWindow: 100,
      maxRangeHours: 720,
    });
    const probe = await provider.probe();
    expect(probe.reachable).toBe(false);
    expect(probe.detail.length).toBeGreaterThan(0);
  });
});

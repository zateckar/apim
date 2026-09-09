import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ElkLogSearch,
  emptyBuckets,
  intervalFor,
  MockLogSearch,
  readableResourceIds,
  type LogQuery,
} from "../control-plane/src/logs.ts";
import { MAX_BODY_CAPTURE_MINUTES, resetLogSearchCache } from "../control-plane/src/api/logs.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { MAX_LOGGED_BODY_BYTES } from "../shared/config-doc.ts";
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

/**
 * Body capture: the one write in this capability, and the only thing the portal can change about
 * what a log line contains.
 *
 * The property that matters most is the last one here. The *instant* travels in the configuration
 * document, not a flag — so a window ends on the gateway's own clock whatever happens to the
 * control plane, and a revoked or spent window is simply absent from the document rather than
 * present-and-off. Everything else on this screen is a guard around how easy it is to open one.
 */
describe("body capture", () => {
  const REASON = "INC-4471: the order POST returns 400 for one consumer only";

  /** What the fleet would be handed right now for this API's route. */
  function routeInConfig() {
    const config = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations);
    return config.routes.find((route) => route.resourceId === published.resourceId)!;
  }

  const open = (cookie: string, body: Record<string, unknown> = {}) =>
    cp.call("POST", "/api/logs/body-capture", {
      cookie,
      body: { resourceId: published.resourceId, environment: "dev", reason: REASON, ...body },
    });

  beforeEach(() => {
    // Each test starts with no window, however the previous one left it.
    cp.app.db.run("DELETE FROM body_capture");
  });

  test("no window means no instruction: the document says nothing about bodies", () => {
    expect(routeInConfig().logBodiesUntil).toBeUndefined();
  });

  test("an owner opens an hour, and the instant reaches the document", async () => {
    const before = Date.now();
    const response = await open(published.pavel);
    expect(response.status).toBe(201);
    const window = await response.json();
    expect(window.maxBytes).toBe(MAX_LOGGED_BODY_BYTES);

    const until = Date.parse(window.expiresAt);
    // The default is the cap: somebody opening a window under pressure should not have to name a
    // number, and the number they would name is the one they are allowed.
    expect(until).toBeGreaterThan(before + (MAX_BODY_CAPTURE_MINUTES - 1) * 60_000);
    expect(until).toBeLessThanOrEqual(before + MAX_BODY_CAPTURE_MINUTES * 60_000 + 1000);
    expect(routeInConfig().logBodiesUntil).toBe(window.expiresAt);
  });

  test("the window is refused past an hour, and refused without a real reason", async () => {
    const tooLong = await open(published.pavel, { minutes: MAX_BODY_CAPTURE_MINUTES + 1 });
    expect(tooLong.status).toBe(400);
    // Refused rather than clamped: a silently shortened window is one somebody believes is longer.
    expect((await tooLong.json()).detail).toContain(String(MAX_BODY_CAPTURE_MINUTES));
    expect(routeInConfig().logBodiesUntil).toBeUndefined();

    const thin = await open(published.pavel, { reason: "debug" });
    expect(thin.status).toBe(400);
    expect((await thin.json()).detail).toContain("reason");
  });

  test("a second window is refused while one is open, naming the one that is", async () => {
    expect((await open(published.pavel)).status).toBe(201);
    const second = await open(published.pavel);
    expect(second.status).toBe(409);
    const detail = (await second.json()).detail;
    expect(detail).toContain("pavel");
    expect(detail).toContain("dev");
  });

  test("a consumer of the API cannot capture its bodies", async () => {
    const response = await open(published.clara);
    expect(response.status).toBe(403);
    expect(routeInConfig().logBodiesUntil).toBeUndefined();
  });

  test("an administrator can, because an administrator may change anything", async () => {
    const alice = await cp.login("alice");
    expect((await open(alice)).status).toBe(201);
    expect(routeInConfig().logBodiesUntil).toBeTruthy();
  });

  test("closing early dates the row rather than deleting it, and the document stops asking", async () => {
    const window = await (await open(published.pavel)).json();
    expect(routeInConfig().logBodiesUntil).toBeTruthy();

    const closed = await cp.call("DELETE", `/api/logs/body-capture/${window.id}`, {
      cookie: published.pavel,
    });
    expect(closed.status).toBe(204);
    expect(routeInConfig().logBodiesUntil).toBeUndefined();

    // Gone from the document, still on the record — which is the whole reason the column exists.
    const live = await (await cp.call("GET", "/api/logs/body-capture", { cookie: published.pavel })).json();
    expect(live.items).toHaveLength(0);
    const all = await (
      await cp.call("GET", "/api/logs/body-capture?includeSpent=1", { cookie: published.pavel })
    ).json();
    expect(all.items).toHaveLength(1);
    expect(all.items[0].revokedAt).toBeTruthy();
    expect(all.items[0].reason).toBe(REASON);
    expect(all.items[0].openedBy).toBe("pavel");
  });

  test("a window that has run out simply is not in the document", async () => {
    const window = await (await open(published.pavel)).json();
    cp.app.db.run("UPDATE body_capture SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      window.id,
    ]);
    expect(routeInConfig().logBodiesUntil).toBeUndefined();
    // And the next one is allowed, because nothing is holding the slot.
    expect((await open(published.pavel)).status).toBe(201);
  });

  test("the record is readable by anyone signed in, not only by the owner", async () => {
    await open(published.pavel);
    const response = await cp.call("GET", "/api/logs/body-capture?environment=dev", {
      cookie: published.clara,
    });
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].remainingSec).toBeGreaterThan(0);
    expect(page.maxMinutes).toBe(MAX_BODY_CAPTURE_MINUTES);
    expect(page.maxBytes).toBe(MAX_LOGGED_BODY_BYTES);
    expect((await cp.call("GET", "/api/logs/body-capture")).status).toBe(401);
  });

  test("opening and closing are both audited, with the reason and the expiry", async () => {
    const window = await (await open(published.pavel)).json();
    await cp.call("DELETE", `/api/logs/body-capture/${window.id}`, { cookie: published.pavel });
    // By this window's id rather than by action: earlier tests in this block have opened windows
    // of their own, and an audit table that accumulates is the point of an audit table.
    const rows = cp.app.db
      .query<{ action: string; actor: string; detail: string }, [string, string]>(
        `SELECT action, actor, detail FROM audit
          WHERE action LIKE 'body-capture.%' AND (detail LIKE ? OR detail LIKE ?)
          ORDER BY rowid`,
      )
      .all(`%${window.expiresAt}%`, `%${window.id}%`);
    expect(rows.map((row) => row.action)).toEqual(["body-capture.open", "body-capture.close"]);
    expect(rows[0]!.actor).toBe("pavel");
    const detail = JSON.parse(rows[0]!.detail);
    expect(detail.reason).toBe(REASON);
    expect(detail.expiresAt).toBe(window.expiresAt);
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

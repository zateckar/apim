import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rollup, UptimeMonitor, type HealthItem } from "../control-plane/src/uptime.ts";
import {
  availabilityOf,
  buildSyntheticsQuery,
  emptyBuckets,
  hostOf,
  monitorIdFor,
  reshapeMonitor,
  SYNTHETICS_RANGES,
  trimUnelapsed,
  type SyntheticsBucket,
} from "../control-plane/src/synthetics.ts";
import { makeCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * The Health screen's two reads.
 *
 * What is worth asserting here is not "the probe returned up" — that is a network round trip
 * somebody else owns. It is the *distinctions*: `disabled` is not `down`, an empty bucket is not a
 * failed one, a probe that throws does not overwrite the last real observation, and the estate-wide
 * components are not folded into every environment's verdict.
 */

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;

beforeAll(() => {
  cp = makeCp();
  backend = startBackend();
});
afterAll(() => {
  backend.stop();
  cp.close();
});

function item(over: Partial<HealthItem>): HealthItem {
  return {
    id: "x",
    label: "X",
    kind: "gateway",
    environment: "dev",
    status: "up",
    latencyMs: null,
    checkedAt: new Date().toISOString(),
    message: null,
    tag: null,
    simulated: false,
    ...over,
  };
}

describe("rolling components up into an environment verdict", () => {
  test("all up is healthy, a mix is degraded, all down is down", () => {
    expect(rollup("dev", [item({}), item({})]).status).toBe("healthy");
    expect(rollup("dev", [item({}), item({ status: "down" })]).status).toBe("degraded");
    expect(rollup("dev", [item({ status: "down" }), item({ status: "down" })]).status).toBe("down");
  });

  test("disabled is not down — it does not colour the verdict", () => {
    // A gateway with no address registered is not broken; nobody has said where it is. Counting it
    // as down produces a red environment nobody can fix.
    const result = rollup("dev", [item({}), item({ status: "disabled" })]);
    expect(result.status).toBe("healthy");
    expect(result.disabled).toBe(1);
    expect(result.up).toBe(1);
  });

  test("an environment with nothing probeable is unknown, not healthy", () => {
    expect(rollup("prod", []).status).toBe("unknown");
    expect(rollup("prod", [item({ status: "disabled" })]).status).toBe("unknown");
  });

  test("estate-wide components are excluded, so one shared failure does not redden every stage", () => {
    const items = [item({ environment: "dev" }), item({ environment: null, status: "down", kind: "log-index" })];
    expect(rollup("dev", items).status).toBe("healthy");
    expect(rollup("dev", items).total).toBe(1);
  });

  test("the verdict names what is down, so the hero can list it", () => {
    const result = rollup("dev", [
      item({ label: "managed replicas", status: "down" }),
      item({ label: "managed address" }),
    ]);
    expect(result.impact).toEqual(["managed replicas"]);
  });
});

describe("the component matrix", () => {
  test("it lists the control plane, its database, every gateway and the external systems", async () => {
    const monitor = new UptimeMonitor(cp.app);
    await monitor.refreshAll();
    const snapshot = monitor.snapshot();
    const kinds = new Set(snapshot.items.map((row) => row.kind));
    expect(kinds).toContain("control-plane");
    expect(kinds).toContain("database");
    expect(kinds).toContain("fleet");
    expect(kinds).toContain("log-index");
    expect(kinds).toContain("integration");
    // The six mocks are all there and all badged, so nothing on the screen can be mistaken for an
    // observation of a real system.
    const simulated = snapshot.items.filter((row) => row.kind === "integration");
    expect(simulated.length).toBe(6);
    expect(simulated.every((row) => row.simulated && row.tag === "Simulated")).toBeTrue();
  });

  test("a gateway with no published address is disabled with the reason, never down", async () => {
    const fresh = makeCp();
    try {
      // Nobody has said where this gateway answers. That is not a broken gateway, and painting it
      // red would put a whole environment in the red before it was deployed.
      fresh.app.db.run("UPDATE target SET public_url = NULL, intranet_url = NULL");
      const monitor = new UptimeMonitor(fresh.app);
      await monitor.refreshAll();
      const address = monitor.snapshot().items.find((row) => row.kind === "gateway");
      expect(address).toBeDefined();
      expect(address!.status).toBe("disabled");
      expect(address!.message).toContain("no address");
      // And it is kept out of the arithmetic entirely rather than counted as a failure.
      const verdict = monitor.snapshot().environments.find((row) => row.environment === "dev")!;
      expect(verdict.disabled).toBeGreaterThan(0);
      expect(verdict.up + verdict.down + verdict.disabled).toBe(verdict.total);
      expect(verdict.impact).not.toContain(address!.label);
    } finally {
      fresh.close();
    }
  });

  test("replica liveness is answered from what the replicas reported, with no outbound call", async () => {
    const monitor = new UptimeMonitor(cp.app);
    await monitor.refreshAll();
    const fleet = monitor.snapshot().items.find((row) => row.kind === "fleet");
    expect(fleet).toBeDefined();
    // The seeded world mints replicas but they have never polled, so they are stale — that is
    // `down`, and it is a fact the control plane holds first-hand.
    expect(["up", "down"]).toContain(fleet!.status);
    expect(fleet!.tag).toBe("Reported");
  });

  test("an unreadable database is reported by name rather than thrown at the caller", async () => {
    const fresh = makeCp();
    try {
      const monitor = new UptimeMonitor(fresh.app);
      await monitor.refreshAll();
      const before = monitor.snapshot();
      expect(before.items.find((row) => row.id === "database")!.status).toBe("up");

      const original = fresh.app.db.query.bind(fresh.app.db);
      (fresh.app.db as { query: unknown }).query = () => {
        throw new Error("attempt to read a readonly database");
      };
      let after: ReturnType<typeof monitor.snapshot>;
      try {
        // Neither the refresh nor the snapshot may throw: the screen that is supposed to explain
        // the outage must not be the second thing the outage takes down.
        await monitor.refreshAll();
        after = monitor.snapshot();
      } finally {
        (fresh.app.db as { query: unknown }).query = original;
      }
      const database = after.items.find((row) => row.id === "database")!;
      expect(database.status).toBe("down");
      expect(database.message).toContain("readonly");
      // The probe set could not be rebuilt either, so the previous one is kept — an estate that
      // loses its component list at the moment it breaks has nothing to show.
      expect(after.items.length).toBe(before.items.length);
    } finally {
      fresh.close();
    }
  });

  test("the summary counts every item exactly once", async () => {
    const monitor = new UptimeMonitor(cp.app);
    await monitor.refreshAll();
    const snapshot = monitor.snapshot();
    expect(snapshot.summary.total).toBe(snapshot.items.length);
    expect(snapshot.summary.up + snapshot.summary.down + snapshot.summary.disabled).toBe(
      snapshot.items.length,
    );
  });
});

describe("GET /api/health/uptime", () => {
  test("it needs a session", async () => {
    expect((await cp.call("GET", "/api/health/uptime")).status).toBe(401);
  });

  test("a cold read probes once so the first visit is not an empty matrix", async () => {
    const fresh = makeCp();
    try {
      const alice = await fresh.login("alice");
      const response = await fresh.call("GET", "/api/health/uptime", { cookie: alice });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(5);
      expect(body.warming).toBeFalse();
      expect(body.intervalMs).toBeGreaterThan(0);
      expect(body.environments.map((row: { environment: string }) => row.environment)).toEqual(
        fresh.app.config.promotionChain,
      );
    } finally {
      fresh.close();
    }
  });

  test("a developer sees it too — promotion depends on it", async () => {
    const pavel = await cp.login("pavel");
    const response = await cp.call("GET", "/api/health/uptime", { cookie: pavel });
    expect(response.status).toBe(200);
  });
});

describe("uptime history buckets", () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);

  test("the shells cover the window and are interval-aligned", () => {
    const buckets = emptyBuckets("6h", now);
    const { intervalMs, durationMs } = SYNTHETICS_RANGES["6h"];
    expect(buckets.length).toBe(durationMs / intervalMs);
    // Aligned, so two readers looking at the same range see a spike in the same place.
    for (const bucket of buckets) expect(Date.parse(bucket.at) % intervalMs).toBe(0);
    expect(buckets.every((bucket) => bucket.status === "empty")).toBeTrue();
  });

  test("a trailing bucket whose window has not elapsed is dropped, a middle gap is kept", () => {
    const interval = 60_000;
    const at = (offset: number) => new Date(now + offset).toISOString();
    const buckets: SyntheticsBucket[] = [
      { at: at(-180_000), status: "up", total: 2, down: 0, avgDurationMs: 40 },
      // A fully-elapsed window with no checks in it: a real gap, and it stays grey.
      { at: at(-120_000), status: "empty", total: 0, down: 0, avgDurationMs: null },
      { at: at(-60_000), status: "up", total: 2, down: 0, avgDurationMs: 41 },
      // The current window: no check has had a chance to run, which is not a gap.
      { at: at(-30_000), status: "empty", total: 0, down: 0, avgDurationMs: null },
    ];
    const trimmed = trimUnelapsed(buckets, interval, now);
    expect(trimmed.length).toBe(3);
    expect(trimmed[1]!.status).toBe("empty");
  });

  test("availability counts only the buckets that ran", () => {
    const bucket = (status: SyntheticsBucket["status"]): SyntheticsBucket => ({
      at: new Date(now).toISOString(),
      status,
      total: status === "empty" ? 0 : 1,
      down: status === "down" ? 1 : 0,
      avgDurationMs: null,
    });
    // Three ran, one failed: 2/3. The two empties are not evidence either way.
    expect(availabilityOf([bucket("up"), bucket("up"), bucket("down"), bucket("empty"), bucket("empty")])).toBeCloseTo(
      2 / 3,
    );
    expect(availabilityOf([bucket("empty")])).toBeNull();
    expect(availabilityOf([])).toBeNull();
  });
});

describe("the Elasticsearch uptime query", () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);

  test("it filters to final attempts, so a flapping monitor is not counted several times", () => {
    const query = buildSyntheticsQuery("24h", ["apim-dev-managed"], now) as any;
    const filters = query.query.bool.filter;
    expect(filters).toContainEqual({ term: { "summary.final_attempt": true } });
    expect(filters).toContainEqual({ terms: { "monitor.id": ["apim-dev-managed"] } });
  });

  test("the histogram is padded to the window, so a gap is a grey mark rather than a short strip", () => {
    const query = buildSyntheticsQuery("1h", ["m"], now) as any;
    const histogram = query.aggs.monitors.aggs.timeline.date_histogram;
    expect(histogram.min_doc_count).toBe(0);
    expect(histogram.fixed_interval).toBe(SYNTHETICS_RANGES["1h"].esInterval);
    expect(histogram.extended_bounds).toEqual({
      min: now - SYNTHETICS_RANGES["1h"].durationMs,
      max: now - 1,
    });
  });

  test("the monitor id is derived from the gateway, so both sides can compute it", () => {
    expect(monitorIdFor("prod", "onprem")).toBe("apim-prod-onprem");
  });
});

describe("reshaping one monitor's aggregation", () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const bucketAt = (offset: number, docs: number, down: number, avgUs: number | null) => ({
    key: now - offset,
    doc_count: docs,
    down: { doc_count: down },
    duration: { value: avgUs },
  });

  test("a bucket with no documents is empty, one with a failure is down", () => {
    const raw = {
      timeline: {
        buckets: [
          bucketAt(7_200_000, 4, 0, 42_000),
          bucketAt(5_400_000, 0, 0, null),
          bucketAt(3_600_000, 4, 1, 1_200_000),
        ],
      },
    };
    const { buckets } = reshapeMonitor(raw, "24h", { admin: false, now });
    expect(buckets.map((bucket) => bucket.status)).toEqual(["up", "empty", "down"]);
    // Heartbeat records microseconds; the rest of the portal speaks milliseconds.
    expect(buckets[0]!.avgDurationMs).toBe(42);
    expect(buckets[2]!.avgDurationMs).toBe(1200);
    expect(buckets[1]!.avgDurationMs).toBeNull();
  });

  test("the failure text is administrators-only", () => {
    const raw = {
      timeline: { buckets: [bucketAt(3_600_000, 1, 1, 900_000)] },
      last_error: {
        latest: { hits: { hits: [{ _source: { error: { message: "dial tcp 10.1.2.3:443: refused" } } } ] } },
      },
    };
    // The text quotes an internal address, which is topology rather than anything a subscription
    // bought — so it is gated on the server rather than hidden in the browser.
    expect(reshapeMonitor(raw, "24h", { admin: false, now }).lastError).toBeNull();
    expect(reshapeMonitor(raw, "24h", { admin: true, now }).lastError).toContain("10.1.2.3");
  });

  test("a monitor the index knows nothing about is an empty strip, not a crash", () => {
    const { buckets, lastError } = reshapeMonitor(undefined, "1h", { admin: true, now });
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((bucket) => bucket.status === "empty")).toBeTrue();
    expect(lastError).toBeNull();
  });

  test("a malformed monitor URL costs the host, not the snapshot", () => {
    expect(hostOf("https://gw.example.test:8443/x")).toBe("gw.example.test");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("GET /api/health/synthetics", () => {
  test("it needs a session, and refuses a range it does not have an interval for", async () => {
    expect((await cp.call("GET", "/api/health/synthetics")).status).toBe(401);
    const alice = await cp.login("alice");
    const bad = await cp.call("GET", "/api/health/synthetics?range=7d", { cookie: alice });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("1h");
  });

  test("the mock answers one monitor per registered gateway, marked simulated", async () => {
    const alice = await cp.login("alice");
    const response = await cp.call("GET", "/api/health/synthetics?range=1h", { cookie: alice });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.simulated).toBeTrue();
    expect(body.range).toBe("1h");
    const dev = body.environments.find((group: { environment: string }) => group.environment === "dev");
    expect(dev).toBeDefined();
    expect(dev.monitors.length).toBeGreaterThan(0);
    expect(dev.monitors[0].buckets.length).toBeGreaterThan(0);
    expect(dev.monitors[0].availability).not.toBeNull();
  });

  test("the simulated history is stable, so a reload does not reshuffle the evidence", async () => {
    const alice = await cp.login("alice");
    const read = async () =>
      (await (await cp.call("GET", "/api/health/synthetics?range=48h", { cookie: alice })).json())
        .environments[0].monitors[0].buckets.slice(0, 20)
        .map((bucket: { status: string }) => bucket.status);
    expect(await read()).toEqual(await read());
  });

  test("a developer gets the strips but not the failure text", async () => {
    const pavel = await cp.login("pavel");
    const body = await (
      await cp.call("GET", "/api/health/synthetics?range=48h", { cookie: pavel })
    ).json();
    for (const group of body.environments) {
      for (const monitor of group.monitors) expect(monitor.lastError).toBeNull();
    }
  });
});

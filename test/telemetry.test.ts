import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pruneOldRows } from "../control-plane/src/telemetry.ts";
import {
  emptyBuckets,
  GATEWAY_REJECTIONS,
  OUTCOMES,
  percentile,
  SERVED_OUTCOMES,
  windowStartOf,
  type Outcome,
  type TelemetryReport,
} from "../shared/telemetry.ts";
import {
  makeCp,
  makeDp,
  poll,
  publishApi,
  serveCp,
  startBackend,
  type TestCp,
} from "./helpers.ts";

/**
 * G4. The decision that everything else rests on: a report is **absolute per (window, series)**
 * and the flush **replaces**, so a re-sent report is idempotent — which matters because a lost
 * response is the normal outcome of a control-plane restart (review V1-01).
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

const CLOSED_WINDOW = windowStartOf(Date.now() - 120_000);

function report(count: number, overrides: Record<string, unknown> = {}): TelemetryReport {
  const buckets = emptyBuckets();
  buckets[6] = count;
  return {
    droppedSeries: 0,
    droppedWindows: 0,
    windows: [
      {
        windowStart: CLOSED_WINDOW,
        series: [
          {
            resourceId: "",
            subscriptionId: "",
            outcome: "ok",
            status: 200,
            count,
            durationMsSum: count * 60,
            durationMsMax: 90,
            bytesIn: 0,
            bytesOut: count * 100,
            buckets,
            ...overrides,
          },
        ],
      },
    ],
  };
}

async function summary(sinceMin = 60) {
  const alice = await cp.login("alice");
  return (
    await cp.call(`GET`, `/api/telemetry/summary?environment=dev&sinceMin=${sinceMin}`, {
      cookie: alice,
    })
  ).json();
}

describe("the report and the flush", () => {
  test("a closed window is accepted, flushed, and shows up in the summary", async () => {
    const first = await poll(cp, { telemetry: report(5) });
    expect(first.payload!.acceptedWindows).toEqual([CLOSED_WINDOW]);

    cp.app.telemetry.flushNow();
    const body = await summary();
    expect(body.totals.requests).toBe(5);
    expect(body.totals.ok).toBe(5);
    expect(body.totals.gatewayRejections).toBe(0);
    expect(body.totals.upstreamErrors).toBe(0);
    expect(body.totals.errorRate).toBe(0);
    expect(body.totals.approximate).toBe(true);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].windowStart).toBe(CLOSED_WINDOW);
  });

  test("the current partial minute is never acknowledged, so it can still grow", async () => {
    const open = windowStartOf(Date.now());
    const result = await poll(cp, {
      telemetry: {
        droppedSeries: 0,
        droppedWindows: 0,
        windows: [
          {
            windowStart: open,
            series: [
              {
                resourceId: "",
                subscriptionId: "",
                outcome: "ok",
                status: 200,
                count: 1,
                durationMsSum: 1,
                durationMsMax: 1,
                bytesIn: 0,
                bytesOut: 0,
                buckets: emptyBuckets(),
              },
            ],
          },
        ],
      },
    });
    expect(result.payload!.acceptedWindows).toEqual([]);
  });

  test("re-sending a window does not double-count", async () => {
    await poll(cp, { telemetry: report(5) });
    cp.app.telemetry.flushNow();
    expect((await summary()).totals.requests).toBe(5);

    // The instance never saw the response, so it sends the same absolute window again.
    await poll(cp, { telemetry: report(5) });
    cp.app.telemetry.flushNow();
    expect((await summary()).totals.requests).toBe(5);

    // And a genuinely larger absolute count replaces rather than adds.
    await poll(cp, { telemetry: report(9) });
    cp.app.telemetry.flushNow();
    expect((await summary()).totals.requests).toBe(9);
  });

  test("a restart writes new rows instead of replacing the minute's earlier counts", async () => {
    await poll(cp, { runId: "run_a", telemetry: report(4) });
    cp.app.telemetry.flushNow();
    await poll(cp, { runId: "run_b", telemetry: report(3) });
    cp.app.telemetry.flushNow();

    // Same instance, same minute, two processes: 4 + 3, not 3 (review V2-01).
    expect((await summary()).totals.requests).toBe(7);
  });

  test("runs past the cap fold into one, so a crash loop cannot multiply rows", async () => {
    const small = makeCp({ maxRunsPerInstanceWindow: 2 });
    try {
      for (let i = 0; i < 6; i++) {
        await poll(small, { runId: `run_${i}`, telemetry: report(1) });
      }
      small.app.telemetry.flushNow();
      const rows = small.app.db
        .query("SELECT DISTINCT run_id FROM telemetry_rollup ORDER BY run_id")
        .all() as Array<{ run_id: string }>;
      expect(rows.map((r) => r.run_id)).toEqual(["overflow", "run_0", "run_1"]);
      expect(small.app.telemetry.foldedRuns).toBe(4);
    } finally {
      small.close();
    }
  });

  test("a deleted API's traffic stays attributed to it, and does not pollute the no-route bucket", async () => {
    const api = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    await poll(cp, { telemetry: report(2, { resourceId: api.resourceId }) });
    cp.app.telemetry.flushNow();

    // Delete the API. Its rollup rows survive: there is no foreign key, deliberately.
    cp.app.db.run("DELETE FROM resource WHERE id = ?", [api.resourceId]);
    await poll(cp, { runId: "run_b", telemetry: report(3, { resourceId: api.resourceId }) });
    cp.app.telemetry.flushNow();

    const alice = await cp.login("alice");
    const resources = await (
      await cp.call("GET", "/api/telemetry/resources?environment=dev", { cookie: alice })
    ).json();
    const deleted = resources.items.find((i: { resourceId: string }) => i.resourceId === api.resourceId);
    expect(deleted.name).toBe("(deleted)");
    expect(deleted.requests).toBe(5);

    // The no-route bucket means exactly that, and nothing has been dumped into it.
    expect(resources.items.find((i: { resourceId: string }) => i.resourceId === "")).toBeUndefined();
  });

  test("an oversize report is 413, which tells the instance to send less", async () => {
    const tiny = makeCp({ maxReportBytes: 512 });
    try {
      const big = report(1);
      big.windows[0]!.series = Array.from({ length: 50 }, (_, i) => ({
        ...big.windows[0]!.series[0]!,
        status: 200 + i,
      }));
      const response = await poll(tiny, { telemetry: big });
      expect(response.response.status).toBe(413);
    } finally {
      tiny.close();
    }
  });

  test("prune removes telemetry past the retention window, and terminal jobs", () => {
    cp.app.db.run(
      `INSERT INTO telemetry_rollup (environment, instance_id, run_id, window_start, resource_id,
        subscription_id, outcome, status, count, duration_ms_sum, duration_ms_max, bytes_in,
        bytes_out, buckets_json)
       SELECT 'dev', id, 'run_old', '2020-01-01T00:00:00.000Z', '', '', 'ok', 200, 1, 1, 1, 0, 0, '[]'
         FROM gateway_instance LIMIT 1`,
    );
    cp.app.db.run(
      `INSERT INTO job (id, kind, state, payload, created_at, updated_at)
       VALUES ('job_old', 'reconcile', 'done', '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    );

    const summaryLine = pruneOldRows(cp.app);
    expect(summaryLine).toContain("1 telemetry rows");
    expect(summaryLine).toContain("1 jobs");
    expect(
      (cp.app.db.query("SELECT COUNT(*) AS n FROM telemetry_rollup").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("reading telemetry back", () => {
  test("the three numbers are reported separately, never summed into one", async () => {
    const buckets = emptyBuckets();
    buckets[5] = 1;
    const mixed: TelemetryReport = {
      droppedSeries: 0,
      droppedWindows: 0,
      windows: [
        {
          windowStart: CLOSED_WINDOW,
          series: [
            { resourceId: "", subscriptionId: "", outcome: "ok", status: 200, count: 10, durationMsSum: 100, durationMsMax: 20, bytesIn: 0, bytesOut: 0, buckets },
            { resourceId: "", subscriptionId: "", outcome: "rate-limited", status: 429, count: 3, durationMsSum: 3, durationMsMax: 2, bytesIn: 0, bytesOut: 0, buckets },
            { resourceId: "", subscriptionId: "", outcome: "upstream-error", status: 500, count: 2, durationMsSum: 40, durationMsMax: 30, bytesIn: 0, bytesOut: 0, buckets },
          ],
        },
      ],
    };
    await poll(cp, { telemetry: mixed });
    cp.app.telemetry.flushNow();

    const body = await summary();
    expect(body.totals.requests).toBe(15);
    expect(body.totals.ok).toBe(10);
    expect(body.totals.gatewayRejections).toBe(3);
    expect(body.totals.upstreamErrors).toBe(2);
    expect(body.totals.errorRate).toBeCloseTo(1 / 3, 5);
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toContain("rate-limited");
    expect(body.statuses.map((s: { status: number }) => s.status).sort()).toEqual([200, 429, 500]);
  });

  /**
   * A cached response, a completed stream and a tool answering "no" are requests that got an
   * answer. They used to be counted as gateway rejections, because the rejection set was derived
   * by excluding `ok` and `upstream-error` — so every outcome added in v3 became a "rejection" by
   * default, and a well-cached API read as though the gateway were refusing most of its traffic.
   */
  test("a cache hit, a closed stream and an rpc-error are served requests, not rejections", async () => {
    const buckets = emptyBuckets();
    buckets[4] = 1;
    const line = (outcome: Outcome, status: number, count: number) => ({
      resourceId: "",
      subscriptionId: "",
      outcome,
      status,
      count,
      durationMsSum: count,
      durationMsMax: 2,
      bytesIn: 0,
      bytesOut: 0,
      buckets,
    });

    await poll(cp, {
      telemetry: {
        droppedSeries: 0,
        droppedWindows: 0,
        windows: [
          {
            windowStart: CLOSED_WINDOW,
            series: [
              line("ok", 200, 1),
              line("cache-hit", 200, 4),
              line("stream-closed", 200, 2),
              line("rpc-error", 200, 3),
              // The refusals that surround them, so this is a classification test and not just a
              // "nothing is a rejection" test: a stream a ceiling cut short *is* a refusal.
              line("upgrade-rejected", 503, 5),
              line("quota-exceeded", 429, 6),
              line("upstream-error", 502, 7),
            ],
          },
        ],
      },
    });
    cp.app.telemetry.flushNow();

    const body = await summary();
    expect(body.totals.requests).toBe(28);
    expect(body.totals.ok).toBe(10);
    expect(body.totals.gatewayRejections).toBe(11);
    expect(body.totals.upstreamErrors).toBe(7);
    // The grouping hides nothing: each value is still its own row in the breakdown.
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome).sort()).toEqual([
      "cache-hit",
      "ok",
      "quota-exceeded",
      "rpc-error",
      "stream-closed",
      "upgrade-rejected",
      "upstream-error",
    ]);
  });

  test("every outcome is classified, so adding one cannot silently default to 'rejection'", () => {
    const served = new Set<string>(SERVED_OUTCOMES);
    const rejected = new Set<string>(GATEWAY_REJECTIONS);
    for (const outcome of OUTCOMES) {
      const groups = [served.has(outcome), rejected.has(outcome), outcome === "upstream-error"];
      expect([outcome, groups.filter(Boolean).length]).toEqual([outcome, 1]);
    }
  });

  test("reads are application-scoped, and the no-route bucket is admin-only", async () => {
    const api = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    await poll(cp, { telemetry: report(7, { resourceId: api.resourceId }) });
    await poll(cp, { runId: "run_b", telemetry: report(4) });
    cp.app.telemetry.flushNow();

    const asAdmin = await summary();
    expect(asAdmin.totals.requests).toBe(11);

    // Pavel owns the API, so he sees its traffic but not the estate's unmatched traffic.
    const asPavel = await (
      await cp.call("GET", "/api/telemetry/summary?environment=dev", { cookie: api.pavel })
    ).json();
    expect(asPavel.totals.requests).toBe(7);

    // Clara is in another application and owns none of it.
    const asClara = await (
      await cp.call("GET", "/api/telemetry/summary?environment=dev", { cookie: api.clara })
    ).json();
    expect(asClara.totals.requests).toBe(0);
  });

  test("per-resource, per-consumer and per-instance views agree with the totals", async () => {
    const api = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    await poll(cp, {
      telemetry: report(6, { resourceId: api.resourceId, subscriptionId: api.subscriptionId }),
    });
    cp.app.telemetry.flushNow();
    const alice = await cp.login("alice");

    const resources = await (
      await cp.call("GET", "/api/telemetry/resources?environment=dev", { cookie: alice })
    ).json();
    expect(resources.items[0].resourceId).toBe(api.resourceId);
    expect(resources.items[0].requests).toBe(6);
    expect(resources.items[0].apiVersion).toBe("v1");

    const consumers = await (
      await cp.call("GET", "/api/telemetry/consumers?environment=dev", { cookie: alice })
    ).json();
    expect(consumers.items[0].subscriptionId).toBe(api.subscriptionId);
    expect(consumers.items[0].requests).toBe(6);

    const instances = await (
      await cp.call("GET", "/api/telemetry/instances?environment=dev", { cookie: alice })
    ).json();
    expect(instances.items[0].requests).toBe(6);
    expect(instances.items[0].share).toBe(1);
    expect(instances.items[0].process.rssBytes).toBe(1);
  });

  test("percentiles interpolate inside a bucket and are null with no data", () => {
    expect(percentile(emptyBuckets(), 0.5)).toBeNull();
    const buckets = emptyBuckets();
    buckets[0] = 100; // everything at or under 1 ms
    expect(percentile(buckets, 0.5)).toBe(1);
    const spread = emptyBuckets();
    spread[6] = 90; // <= 100 ms
    spread[9] = 10; // <= 1000 ms
    const p95 = percentile(spread, 0.95)!;
    expect(p95).toBeGreaterThan(500);
    expect(p95).toBeLessThanOrEqual(1000);
  });
});

describe("the gateway counts what it serves", () => {
  test("client requests, requestsTotal and the control plane's sum all agree", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/counted",
        policy: {
          "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
          rewrite: { stripBasePath: true },
        },
      });
      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      try {
        await dp.start();

        // A mix of exits, so "one series per exit" is actually exercised.
        await dp.fetchHttp(new Request("http://gw/counted/pet", { headers: { "x-api-key": api.key! } }), "127.0.0.1");
        await dp.fetchHttp(new Request("http://gw/counted/pet", { headers: { "x-api-key": api.key! } }), "127.0.0.1");
        await dp.fetchHttp(new Request("http://gw/counted/pet"), "127.0.0.1");
        await dp.fetchHttp(new Request("http://gw/nowhere"), "127.0.0.1");

        const sent = 4;
        expect(dp.telemetry.requestsTotal).toBe(sent);
        const health = dp.health();
        expect(health.requestsTotal).toBe(sent);

        await dp.client.pollOnce();
        cp.app.telemetry.flushNow();

        // Read as an admin, after a flush: both qualifiers are load-bearing (review V4-04).
        const body = await summary();
        expect(body.totals.requests).toBe(sent);
        expect(body.totals.ok).toBe(2);
        expect(body.totals.gatewayRejections).toBe(2);

        const outcomes = Object.fromEntries(
          body.outcomes.map((o: { outcome: string; count: number }) => [o.outcome, o.count]),
        );
        expect(outcomes["no-key"]).toBe(1);
        expect(outcomes["no-route"]).toBe(1);
        expect(outcomes.ok).toBe(2);

        // Bytes out are counted off the streamed body, because Content-Length was stripped.
        expect(body.totals.bytesOut).toBeGreaterThan(0);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("response bytes come from Content-Length when it can be trusted, and are counted when it cannot", async () => {
    const body = "y".repeat(5000);
    const gzipped = Bun.gzipSync(new TextEncoder().encode(body));
    const backend = startBackend((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/gzip")) {
        // The trap: Content-Length describes the compressed bytes, the body arrives expanded.
        return new Response(gzipped, {
          headers: { "content-encoding": "gzip", "content-length": String(gzipped.byteLength) },
        });
      }
      if (path.endsWith("/chunked")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
        );
      }
      return new Response(body, { headers: { "content-length": String(body.length) } });
    });
    const cpServer = serveCp(cp);
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/sized",
        policy: { rewrite: { stripBasePath: false } },
      });
      const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "sized" });
      try {
        await dp.start();
        for (const path of ["/sized/plain", "/sized/gzip", "/sized/chunked"]) {
          const response = await dp.fetchHttp(new Request(`http://gw${path}`), "127.0.0.1");
          expect(response.status).toBe(200);
          // Whichever path counted it, the client still gets the whole decoded body.
          expect((await response.text()).length).toBe(5000);
        }

        const series = dp.telemetry.snapshot().windows.flatMap((w) => w.series);
        const total = series.reduce((sum, s) => sum + s.bytesOut, 0);
        // 5000 three times: the declared length once, and the real streamed length twice — never
        // the 30-odd compressed bytes the gzip response declared.
        expect(total).toBe(15_000);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("DP_ACCESS_LOG=off stops the per-request line without stopping the counting", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    const original = console.log;
    const written: string[] = [];
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/logged",
        policy: { rewrite: { stripBasePath: true } },
      });
      // `quiet: false` is the shipped default; the switch under test is `accessLog`, which until
      // now was reachable only from code and so could not be turned off in a running process.
      const dp = makeDp(cpServer.url, cp.token, cp.dir, {
        name: "unlogged",
        quiet: false,
        accessLog: false,
      });
      try {
        await dp.start();
        console.log = (...args: unknown[]) => void written.push(args.map(String).join(" "));
        const response = await dp.fetchHttp(new Request("http://gw/logged/pet"), "127.0.0.1");
        console.log = original;
        expect(response.status).toBe(200);
        expect(written.filter((line) => line.startsWith("{"))).toEqual([]);
        // Counting is a separate switch, and it is still on.
        expect(dp.telemetry.requestsTotal).toBe(1);
        // `served` is counted independently of telemetry, and health probes are not traffic.
        expect((dp.health().process as { served: number }).served).toBe(1);
      } finally {
        console.log = original;
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("DP_TELEMETRY=off serves traffic and counts nothing", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/quiet",
        policy: { rewrite: { stripBasePath: true } },
      });
      expect(api.resourceId).toBeTruthy();
      const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "quiet", telemetry: "off" });
      try {
        await dp.start();
        const response = await dp.fetchHttp(new Request("http://gw/quiet/pet"), "127.0.0.1");
        expect(response.status).toBe(200);
        // The body still arrives intact; it is simply not pulled through a counting transform.
        expect(await response.text()).toContain("ok");

        expect(dp.telemetry.requestsTotal).toBe(0);
        expect((dp.health().telemetry as { enabled: boolean }).enabled).toBe(false);

        await dp.client.pollOnce();
        cp.app.telemetry.flushNow();
        expect((await summary()).totals.requests).toBe(0);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("past the series cap, further keys fold into one and the drop is counted", async () => {
    // The status is taken from the path, so four requests are four distinct series.
    const backend = startBackend((req) => {
      const status = Number(new URL(req.url).pathname.split("/").pop());
      return new Response("x", { status: Number.isInteger(status) ? status : 200 });
    });
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/folding",
        policy: { rewrite: { stripBasePath: true } },
      });
      expect(api.resourceId).toBeTruthy();
      const dp = makeDp(cpServer.url, cp.token, cp.dir, { maxSeries: 2 });
      try {
        await dp.start();
        // Distinct statuses would be distinct series; the cap folds them instead.
        for (const status of [200, 404, 500, 503]) {
          await dp.fetchHttp(new Request(`http://gw/folding/${status}`), "127.0.0.1");
        }
        expect(dp.telemetry.droppedSeries).toBeGreaterThan(0);
        const stats = dp.telemetry.stats();
        expect(stats.series).toBeLessThanOrEqual(3);
        expect(dp.telemetry.requestsTotal).toBe(4);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });
});

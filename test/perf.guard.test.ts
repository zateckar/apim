import { describe, expect, test } from "bun:test";
import { cpus } from "node:os";
import { runTarget } from "../tools/loadgen/runner.ts";
import { buildWorld } from "../tools/loadgen/world.ts";

/**
 * The fast half of G6: a guardrail that runs on every `bun test`, not a benchmark.
 *
 * It asserts only *relative* and *structural* properties, because absolute throughput on a
 * developer laptop measures the laptop and would make the suite flaky. It builds its own world on
 * ephemeral ports with a temp database, so it cannot collide with a stack someone has running
 * (review V1-15). `PERF_GUARD=0` skips it, and it skips itself on a small machine.
 */
const ENOUGH_CORES = cpus().length >= 4;
const ENABLED = process.env.PERF_GUARD !== "0" && ENOUGH_CORES;

describe.skipIf(!ENABLED)("performance guardrail", () => {
  test(
    "the gateway serves a short load with no errors, bounded overhead and exact counts",
    async () => {
      const world = await buildWorld(1);
      try {
        const api = world.apis.get("all-policies")!;
        const headers = {
          "X-Api-Key": api.key!,
          "X-Request-Origin": "loadgen",
        };
        const options = { concurrency: 8, durationMs: 2000, warmup: 50 };

        const direct = await runTarget(
          {
            base: world.backendUrl,
            path: "/v2/pet/1",
            method: "GET",
            headers: {},
            bodyBytes: 0,
          },
          options,
        );
        const gateway = await runTarget(
          {
            base: world.gateways[0]!,
            path: `${api.basePath}/pet/1`,
            method: "GET",
            headers,
            bodyBytes: 0,
          },
          options,
        );

        expect(gateway.errors).toBe(0);
        expect(gateway.completed).toBeGreaterThan(200);
        expect(Object.keys(gateway.statuses)).toEqual(["200"]);

        // Generous on purpose: this catches an order-of-magnitude regression, not a 10% one.
        // A benchmark belongs in `bun run perf`, where the numbers are paired and reported.
        expect(gateway.p95).toBeLessThan(direct.p95 * 25 + 50);

        // The identity the plan promises, with both its qualifiers: after a flush, read as admin.
        // The warm-up requests went through the gateway too, so they count.
        const dp = world.dataPlanes[0]!;
        expect(dp.telemetry.requestsTotal).toBe(gateway.completed + options.warmup);
        await dp.client.pollOnce();
        world.app.telemetry.flushNow();

        const login = await fetch(`${world.cpUrl}/api/auth/dev-login`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:8080" },
          body: JSON.stringify({ userId: "alice" }),
        });
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        const summary = (await (
          await fetch(`${world.cpUrl}/api/telemetry/summary?environment=dev&sinceMin=60`, {
            headers: { cookie },
          })
        ).json()) as { totals: { requests: number; ok: number; gatewayRejections: number } };

        expect(summary.totals.requests).toBe(dp.telemetry.requestsTotal);
        expect(summary.totals.ok).toBe(dp.telemetry.requestsTotal);
        expect(summary.totals.gatewayRejections).toBe(0);
        expect(dp.telemetry.droppedSeries).toBe(0);
        expect(dp.telemetry.droppedWindows).toBe(0);
      } finally {
        world.stop();
      }
    },
    { timeout: 120_000 },
  );
});

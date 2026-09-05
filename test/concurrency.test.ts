import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUT_MS, lintDocument, validateUnit } from "../shared/policy.ts";
import { ConcurrencyGate } from "../data-plane/src/concurrency.ts";
import { assertOutboundCeiling, type DataPlane } from "../data-plane/src/server.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * Plan G7: a slow backend must not be able to take the gateway down.
 *
 * The property under test is *isolation*, not speed. One route's backend stops answering; the
 * question is whether every other route on the same instance keeps working. Without a ceiling it
 * cannot, because in-flight work grows at the arrival rate and leaves only at the timeout.
 */

let cp: TestCp;
let served: ReturnType<typeof serveCp>;
const planes: DataPlane[] = [];

/** A backend that answers when told to, so "in flight" is controlled rather than raced. */
function heldBackend() {
  const gates: Array<() => void> = [];
  let held = 0;
  const backend = startBackend(async (req) => {
    const url = new URL(req.url);
    // The base path is not stripped here, so what arrives is the whole published path — domain
    // included — and the fast route is the one whose *name* segment says so.
    if (url.pathname.includes("/fast")) return Response.json({ fast: true });
    held++;
    await new Promise<void>((resolve) => gates.push(resolve));
    return Response.json({ slow: true });
  });
  return {
    ...backend,
    get held() {
      return held;
    },
    releaseAll() {
      for (const gate of gates.splice(0)) gate();
    },
  };
}

beforeEach(() => {
  cp = makeCp();
  served = serveCp(cp);
});

afterEach(() => {
  for (const dp of planes.splice(0)) dp.stop();
  served.stop();
  cp.close();
});

function makePlane(overrides: Parameters<typeof makeDp>[3] = {}) {
  const dp = makeDp(served.url, cp.token, cp.dir, overrides);
  planes.push(dp);
  return dp;
}

describe("the concurrency gate", () => {
  test("counts per route, sheds at the route ceiling, and attributes it to the route", () => {
    const gate = new ConcurrencyGate(100);
    expect(gate.tryAcquire("a", 2)).toBe("ok");
    expect(gate.tryAcquire("a", 2)).toBe("ok");
    expect(gate.tryAcquire("a", 2)).toBe("route-saturated");
    // A different route has its own bucket, which is the entire point.
    expect(gate.tryAcquire("b", 2)).toBe("ok");
    expect(gate.inFlight).toBe(3);
    gate.release("a");
    expect(gate.tryAcquire("a", 2)).toBe("ok");
  });

  test("sheds at the instance ceiling even when no route has a unit attached", () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.tryAcquire("a", undefined)).toBe("ok");
    expect(gate.tryAcquire("b", undefined)).toBe("ok");
    expect(gate.tryAcquire("c", undefined)).toBe("instance-saturated");
    gate.release("a");
    expect(gate.tryAcquire("c", undefined)).toBe("ok");
  });

  test("the route ceiling is checked first, so one sick backend is not reported as a sick gateway", () => {
    const gate = new ConcurrencyGate(1);
    expect(gate.tryAcquire("sick", 1)).toBe("ok");
    // Both ceilings are now full. The answer names the route, because that is the actionable one.
    expect(gate.tryAcquire("sick", 1)).toBe("route-saturated");
    expect(gate.tryAcquire("healthy", 8)).toBe("instance-saturated");
  });

  test("releasing a route it never acquired does not corrupt the total", () => {
    const gate = new ConcurrencyGate(4);
    gate.release("never-seen");
    expect(gate.inFlight).toBe(0);
    expect(gate.tryAcquire("a", 1)).toBe("ok");
    gate.release("a");
    gate.release("a");
    expect(gate.inFlight).toBe(0);
  });

  test("idle routes leave no entry behind", () => {
    const gate = new ConcurrencyGate(4);
    gate.tryAcquire("a", 4);
    expect(gate.snapshot().routes).toHaveLength(1);
    gate.release("a");
    expect(gate.snapshot().routes).toHaveLength(0);
  });
});

describe("a slow backend cannot take the gateway with it", () => {
  test("a saturated route sheds 503 while another route keeps answering", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        policy: {
          rewrite: { stripBasePath: false },
          concurrency: { maxInFlight: 2, per: "instance", retryAfterSec: 3 },
          timeoutMs: 60_000,
        },
      });
      await publishApi(cp, {
        name: "fast-api",
        backendUrl: backend.url,
        basePath: "/fast",
        policy: { rewrite: { stripBasePath: false } },
      });

      const dp = makePlane({ name: "gated" });
      await dp.start();
      // Both routes must be live before anything is measured, or a 404 would look like a shed.
      expect(dp.client.table?.routes.map((r) => r.basePath).sort()).toEqual(["/it/solution/fast", "/it/solution/slow"]);

      // Two requests in, both parked on the backend, neither answered.
      const parked = [
        dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1"),
        dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1"),
      ];
      const deadline = Date.now() + 2000;
      while (backend.held < 2 && Date.now() < deadline) await Bun.sleep(5);
      if (backend.held < 2) {
        backend.releaseAll();
        const answered = await Promise.all(parked);
        throw new Error(
          `backend held ${backend.held}; gateway answered ` +
            `${answered.map((r) => r.status).join("/")}: ${await answered[0]?.text()}`,
        );
      }
      expect(dp.gate.inFlight).toBe(2);

      // The third is shed rather than queued, and says so.
      const shed = await dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      expect(shed.status).toBe(503);
      expect(shed.headers.get("retry-after")).toBe("3");
      const problem = (await shed.json()) as { detail: string; scope: string };
      expect(problem.scope).toBe("route");
      expect(problem.detail).toContain("shed rather than queued");
      // Shed means shed: the backend never saw it.
      expect(backend.held).toBe(2);

      // The whole point: a different route is completely unaffected.
      const fast = await dp.fetchHttp(new Request("http://gw/it/solution/fast/pet"), "127.0.0.1");
      expect(fast.status).toBe(200);
      expect(await fast.json()).toEqual({ fast: true });

      // And once the backend answers, the slots come back.
      backend.releaseAll();
      for (const response of await Promise.all(parked)) expect(response.status).toBe(200);
      expect(dp.gate.inFlight).toBe(0);

      // Issued, then released, in that order: awaiting a request the backend is still holding
      // would wait for a release that only happens on the next line.
      const again = dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      while (backend.held < 3) await Bun.sleep(5);
      backend.releaseAll();
      expect((await again).status).toBe(200);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });

  test("the instance ceiling protects routes that have no unit attached", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        policy: { rewrite: { stripBasePath: false }, timeoutMs: 60_000 },
      });
      const dp = makePlane({ name: "capped", maxConcurrentRequests: 1 });
      await dp.start();

      const parked = dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      while (backend.held < 1) await Bun.sleep(5);

      const shed = await dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      expect(shed.status).toBe(503);
      const problem = (await shed.json()) as { scope: string; maxInFlight: number };
      expect(problem.scope).toBe("instance");
      expect(problem.maxInFlight).toBe(1);
      expect(dp.gate.snapshot().shedInstance).toBe(1);

      backend.releaseAll();
      expect((await parked).status).toBe(200);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });

  test("a shed request is counted as its own outcome, not as an upstream error", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        policy: {
          rewrite: { stripBasePath: false },
          concurrency: { maxInFlight: 1, per: "instance" },
          timeoutMs: 60_000,
        },
      });
      const dp = makePlane({ name: "counted" });
      await dp.start();

      const parked = dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      while (backend.held < 1) await Bun.sleep(5);
      await dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");

      const report = dp.telemetry.snapshot();
      const outcomes = report.windows
        .flatMap((w) => w.series)
        .map((s) => `${s.outcome}:${s.status}`);
      expect(outcomes).toContain("route-saturated:503");
      // `Retry-After` defaults to a second when the unit does not say.
      backend.releaseAll();
      expect((await parked).status).toBe(200);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });

  test("rejected requests never take a slot, so a closed route cannot be saturated", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        subscribe: false,
        policy: {
          rewrite: { stripBasePath: false },
          "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
          concurrency: { maxInFlight: 1, per: "instance" },
        },
      });
      const dp = makePlane({ name: "unauthenticated" });
      await dp.start();

      // A hundred unauthenticated requests: all 401, none of them holding anything.
      for (let i = 0; i < 100; i++) {
        const response = await dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
        expect(response.status).toBe(401);
      }
      expect(dp.gate.inFlight).toBe(0);
      expect(dp.gate.snapshot().shedRoute).toBe(0);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });
});

describe("a caller that leaves takes its upstream call with it", () => {
  test("a disconnected client frees the slot instead of waiting out the timeout", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        policy: {
          rewrite: { stripBasePath: false },
          concurrency: { maxInFlight: 1, per: "instance" },
          // Long enough that waiting it out would fail this test rather than pass it slowly.
          timeoutMs: 60_000,
        },
      });
      const dp = makePlane({ name: "abandoned" });
      await dp.start();

      const controller = new AbortController();
      const abandoned = dp.fetchHttp(
        new Request("http://gw/it/solution/slow/pet", { signal: controller.signal }),
        "127.0.0.1",
      );
      while (backend.held < 1) await Bun.sleep(5);
      expect(dp.gate.inFlight).toBe(1);

      // The caller gives up. The gateway should stop waiting on the backend too.
      controller.abort();
      const response = await abandoned;
      expect(response.status).toBe(499);
      expect(dp.gate.inFlight).toBe(0);

      // And the freed slot is immediately usable, which is the point of freeing it.
      const next = dp.fetchHttp(new Request("http://gw/it/solution/slow/pet"), "127.0.0.1");
      while (backend.held < 2) await Bun.sleep(5);
      backend.releaseAll();
      expect((await next).status).toBe(200);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });

  test("it is counted as its own outcome, not as a backend timeout", async () => {
    const backend = heldBackend();
    try {
      await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/slow",
        policy: { rewrite: { stripBasePath: false }, timeoutMs: 60_000 },
      });
      const dp = makePlane({ name: "attributed" });
      await dp.start();

      const controller = new AbortController();
      const abandoned = dp.fetchHttp(
        new Request("http://gw/it/solution/slow/pet", { signal: controller.signal }),
        "127.0.0.1",
      );
      while (backend.held < 1) await Bun.sleep(5);
      controller.abort();
      await abandoned;

      const outcomes = dp.telemetry
        .snapshot()
        .windows.flatMap((w) => w.series)
        .map((s) => `${s.outcome}:${s.status}`);
      expect(outcomes).toContain("client-gone:499");
      // The distinction is the whole point: this must not inflate the backend's timeout count.
      expect(outcomes.some((o) => o.startsWith("backend-timeout"))).toBe(false);
    } finally {
      backend.releaseAll();
      backend.stop();
    }
  });
});

describe("the policy lint warns about the trap it cannot enforce", () => {
  test("a route with no concurrency ceiling is warned about, with the arithmetic", () => {
    const warnings = lintDocument({ rewrite: { stripBasePath: true }, timeoutMs: 30_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("No concurrency limit");
    expect(warnings[0]).toContain("6000 requests held at once");
  });

  test("the default timeout is named as a default when no unit sets one", () => {
    expect(lintDocument({})[0]).toContain(`the default ${DEFAULT_TIMEOUT_MS} ms`);
  });

  test("attaching the ceiling clears the warning", () => {
    expect(
      lintDocument({
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        concurrency: { maxInFlight: 64, per: "instance" },
      }),
    ).toEqual([]);
  });

  test("a ceiling on an open route is flagged, because the ceiling is then anyone's to consume", () => {
    const warnings = lintDocument({ concurrency: { maxInFlight: 64, per: "instance" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("any caller can consume the ceiling");
  });
});

describe("the runtime's outbound queue must not bind before the gateway's ceilings", () => {
  const config = { maxConcurrentRequests: 2048 } as Parameters<typeof assertOutboundCeiling>[0];

  test("a value at or above the instance ceiling is accepted", () => {
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "2048" })).not.toThrow();
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "8192" })).not.toThrow();
  });

  test("unset is a startup failure that names the variable", () => {
    expect(() => assertOutboundCeiling(config, {})).toThrow(/BUN_CONFIG_MAX_HTTP_REQUESTS is required/);
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "" })).toThrow(
      /BUN_CONFIG_MAX_HTTP_REQUESTS is required/,
    );
  });

  test("below the instance ceiling is a startup failure, because the queue would bind first", () => {
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "256" })).toThrow(
      /below MAX_CONCURRENT_REQUESTS/,
    );
  });

  test("a value that is not a positive integer is rejected", () => {
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "lots" })).toThrow(
      /positive integer/,
    );
    expect(() => assertOutboundCeiling(config, { BUN_CONFIG_MAX_HTTP_REQUESTS: "0" })).toThrow(
      /positive integer/,
    );
  });
});

describe("the concurrency unit is validated on write", () => {
  test("accepts a well-formed unit", () => {
    expect(validateUnit("concurrency", { maxInFlight: 64, per: "instance", retryAfterSec: 1 })).toEqual([]);
    expect(validateUnit("concurrency", { maxInFlight: 1, per: "instance" })).toEqual([]);
    expect(validateUnit("concurrency", { maxInFlight: 1, per: "instance", retryAfterSec: 0 })).toEqual([]);
  });

  test("rejects a limit that is not a usable integer", () => {
    expect(validateUnit("concurrency", { maxInFlight: 0, per: "instance" })[0]).toContain("maxInFlight");
    expect(validateUnit("concurrency", { maxInFlight: -1, per: "instance" })[0]).toContain("maxInFlight");
    expect(validateUnit("concurrency", { maxInFlight: 1.5, per: "instance" })[0]).toContain("maxInFlight");
    expect(validateUnit("concurrency", { maxInFlight: 1_000_000, per: "instance" })[0]).toContain(
      "maxInFlight",
    );
  });

  test("rejects a scope that is not implemented, and unknown fields", () => {
    expect(validateUnit("concurrency", { maxInFlight: 8, per: "fleet" })[0]).toContain("per");
    expect(validateUnit("concurrency", { maxInFlight: 8, per: "instance", queue: 10 })[0]).toContain(
      "unknown field",
    );
    expect(
      validateUnit("concurrency", { maxInFlight: 8, per: "instance", retryAfterSec: -1 })[0],
    ).toContain("retryAfterSec");
  });
});

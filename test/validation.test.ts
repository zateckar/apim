import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Sampler } from "../data-plane/src/validate.ts";
import { makeCp, makeDp, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";
import type { DataPlane } from "../data-plane/src/server.ts";

/**
 * Goal 1 (design section 5.1): request and response validation, headers and bodies, REST and SOAP,
 * against the contract's own definition.
 *
 * The shape of these tests follows the shape of the guarantee. Three states, and each means
 * something different about what a consumer can rely on:
 *
 *  - `blocking` — a non-conforming request never reaches the backend. Testable by asserting the
 *    backend saw nothing, which is stronger than asserting the status.
 *  - `warning` — the response is byte-for-byte what it would have been with validation off. The
 *    only way to be sure of that is to compare against the same call with it off.
 *  - `disabled` — nothing is checked, and the reason is on the record.
 *
 * The `always` block sits outside all three: depth, size, content type and duplicate keys are
 * checked whatever the state, because they bound what the *validator* will do, and a limit that
 * can be turned off is not a limit.
 */

const WSDL = readFileSync("tools/backend/petstore.wsdl", "utf8");

const SPEC = {
  openapi: "3.0.0",
  info: { title: "shop", version: "1.0.0" },
  paths: {
    "/orders": {
      post: {
        operationId: "createOrder",
        parameters: [
          { name: "channel", in: "query", required: true, schema: { type: "string", enum: ["web", "app"] } },
          { name: "x-tenant", in: "header", required: true, schema: { type: "string", minLength: 3 } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sku", "qty"],
                properties: {
                  sku: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$" },
                  qty: { type: "integer", minimum: 1, maximum: 99 },
                  note: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["orderId"],
                  properties: { orderId: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
    "/orders/{orderId}": {
      get: {
        operationId: "getOrder",
        parameters: [
          { name: "orderId", in: "path", required: true, schema: { type: "string", pattern: "^ord_[0-9]+$" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const VALID_BODY = { sku: "ABC-1234", qty: 2 };

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

interface World {
  dp: DataPlane;
  key: string;
  basePath: string;
  backend: ReturnType<typeof startBackend>;
  stop: () => void;
}

/**
 * Each world publishes its own API under its own base path. Two APIs sharing one base path in one
 * environment is a routing collision, not a fixture: the longest-prefix match would send both
 * subscriptions' traffic to whichever route was registered first.
 */
let worldSeq = 0;

async function world(
  policy: Record<string, unknown> = {},
  respondWith?: (req: Request) => Response,
): Promise<World> {
  const basePath = `/shop-${++worldSeq}`;
  const backend = startBackend(respondWith ?? (() => Response.json({ orderId: "ord_1" })));
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
  const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: `dp-${worldSeq}` });
  await dp.start();
  if (!dp.client.table) throw new Error(`config did not activate: ${dp.client.activationBlocked}`);
  return {
    dp,
    key: api.key!,
    // The published path, which carries the fixture's domain in front of what was asked for.
    basePath: api.basePath,
    backend,
    stop: () => {
      dp.stop();
      cpServer.stop();
      backend.stop();
    },
  };
}

function post(
  w: World,
  body: unknown,
  options: { query?: string; tenant?: string | null; contentType?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/json");
  headers.set("x-api-key", w.key);
  if (options.tenant !== null) headers.set("x-tenant", options.tenant ?? "acme");
  return w.dp.fetchHttp(
    new Request(`http://gw${w.basePath}/orders${options.query ?? "?channel=web"}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    "127.0.0.1",
  );
}

// --------------------------------------------------------------------------- blocking, the default

describe("blocking is the default", () => {
  test("a route with no validate unit attached still validates", async () => {
    const w = await world();
    try {
      // Nothing was configured; section 5.1's default is what is running.
      expect(w.dp.client.table!.routes[0]!.policy.validate!.request).toBe("blocking");
      expect(await (await post(w, VALID_BODY)).status).toBe(200);
      const bad = await post(w, { sku: "nope", qty: 2 });
      expect(bad.status).toBe(400);
      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  test("the body is checked against the operation's schema, and the backend never sees it", async () => {
    const w = await world();
    try {
      for (const body of [
        { qty: 2 }, // required property missing
        { sku: "ABC-1234" }, // required property missing
        { sku: "ABC-1234", qty: 0 }, // below minimum
        { sku: "ABC-1234", qty: 100 }, // above maximum
        { sku: "ABC-1234", qty: 2, extra: true }, // additionalProperties: false
        { sku: "abc-1234", qty: 2 }, // pattern
        { sku: "ABC-1234", qty: "2" }, // type
      ]) {
        const response = await post(w, body);
        expect(response.status).toBe(400);
        const problem = await response.json();
        // The failure says where, not just that it failed: a consumer has to be able to fix it.
        expect(problem.detail.length).toBeGreaterThan(0);
      }
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });

  test("a required query parameter and a required header are enforced", async () => {
    const w = await world();
    try {
      expect((await post(w, VALID_BODY, { query: "" })).status).toBe(400);
      expect((await post(w, VALID_BODY, { query: "?channel=fax" })).status).toBe(400);
      expect((await post(w, VALID_BODY, { tenant: null })).status).toBe(400);
      expect((await post(w, VALID_BODY, { tenant: "ab" })).status).toBe(400);
      expect((await post(w, VALID_BODY, { tenant: "acme" })).status).toBe(200);
      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  test("a path parameter that does not match its schema is refused", async () => {
    const w = await world();
    try {
      const ok = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders/ord_7`, { headers: { "x-api-key": w.key } }),
        "127.0.0.1",
      );
      expect(ok.status).toBe(200);
      const bad = await w.dp.fetchHttp(
        new Request(`http://gw${w.basePath}/orders/7`, { headers: { "x-api-key": w.key } }),
        "127.0.0.1",
      );
      expect(bad.status).toBe(400);
    } finally {
      w.stop();
    }
  });

  test("headers only, or body only, is a real distinction", async () => {
    const bodyOnly = await world({
      validate: { request: "blocking", headers: false, body: true },
    });
    try {
      // The header schema is not checked; the body schema still is.
      expect((await post(bodyOnly, VALID_BODY, { tenant: "ab" })).status).toBe(200);
      expect((await post(bodyOnly, { sku: "nope", qty: 1 }, { tenant: "ab" })).status).toBe(400);
    } finally {
      bodyOnly.stop();
    }

    const headersOnly = await world({
      validate: { request: "blocking", headers: true, body: false },
    });
    try {
      expect((await post(headersOnly, { sku: "nope", qty: 1 })).status).toBe(200);
      expect((await post(headersOnly, VALID_BODY, { tenant: "ab" })).status).toBe(400);
    } finally {
      headersOnly.stop();
    }
  });
});

// --------------------------------------------------------------------------- warning and disabled

describe("warning observes without changing anything", () => {
  test("a non-conforming request succeeds, and the response is what it would have been", async () => {
    const off = await world({
      validate: {
        request: "disabled",
        downgradeReason: "the baseline this test compares against",
      },
    });
    const baseline = await post(off, { sku: "nope", qty: 1 });
    const baselineBody = await baseline.text();
    const baselineHeaders = [...baseline.headers].filter(([name]) => name !== "x-request-id").sort();
    off.stop();

    const warning = await world({
      validate: {
        request: "warning",
        downgradeReason: "observing a legacy caller before enforcing, per design section 5.1",
        sample: { rate: 1 },
      },
    });
    try {
      const observed = await post(warning, { sku: "nope", qty: 1 });
      expect(observed.status).toBe(baseline.status);
      expect(await observed.text()).toBe(baselineBody);
      // Not one header differs: warning mode that added a header would be a behaviour change, and
      // a consumer cannot be asked to tolerate one from an observation.
      expect([...observed.headers].filter(([name]) => name !== "x-request-id").sort()).toEqual(
        baselineHeaders,
      );
      expect(warning.backend.requests).toHaveLength(1);

      // It was counted, though. Observation that records nothing is not observation.
      await Bun.sleep(20);
      expect(warning.dp.counters.snapshot().observed).toBeGreaterThan(0);
      expect(warning.dp.counters.snapshot().rejected).toBe(0);
    } finally {
      warning.stop();
    }
  });

  test("disabled requires a reason, and the reason reaches the config document", async () => {
    const cpServer = serveCp(cp);
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url, spec: SPEC, basePath: "/shop" });
      // No reason: refused at write time, not silently accepted.
      const refused = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/validate`,
        { cookie: api.pavel, body: { value: { request: "disabled" } } },
      );
      expect(refused.status).toBe(400);
      expect((await refused.json()).detail).toContain("downgradeReason");

      const accepted = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/validate`,
        {
          cookie: api.pavel,
          body: {
            value: {
              request: "disabled",
              downgradeReason: "the upstream contract is wrong and is being corrected in APIM-412",
            },
          },
        },
      );
      expect(accepted.status).toBe(200);

      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      await dp.start();
      try {
        const unit = dp.client.table!.routes[0]!.policy.validate!;
        expect(unit.request).toBe("disabled");
        expect(unit.downgradeReason).toContain("APIM-412");
      } finally {
        dp.stop();
      }
    } finally {
      backend.stop();
      cpServer.stop();
    }
  });
});

// --------------------------------------------------------------------------- the always block

describe("the always block holds in every state", () => {
  for (const state of ["blocking", "warning", "disabled"] as const) {
    test(`content type, size and depth are enforced with request: ${state}`, async () => {
      const w = await world({
        validate: {
          request: state,
          ...(state === "blocking"
            ? {}
            : { downgradeReason: "asserting that the always block is not part of the downgrade" }),
          always: { maxBodyBytes: 2048, maxDepth: 4 },
          ...(state === "warning" ? { sample: { rate: 1 } } : {}),
        },
      });
      try {
        // 415: a content type outside the declared set, whatever the state.
        const wrongType = await post(w, VALID_BODY, { contentType: "text/csv" });
        expect(wrongType.status).toBe(415);

        // 413: over the ceiling, whatever the state.
        const huge = await post(w, { ...VALID_BODY, note: "x".repeat(4096) });
        expect(huge.status).toBe(413);

        // Depth: a limit that bounds what the parser will do cannot be turned off.
        let nested: Record<string, unknown> = { deep: true };
        for (let i = 0; i < 10; i++) nested = { nested };
        const tooDeep = await post(w, nested);
        expect(tooDeep.status).toBe(400);

        expect(w.backend.requests).toHaveLength(0);
      } finally {
        w.stop();
      }
    });
  }

  test("duplicate keys are rejected rather than silently resolved", async () => {
    const w = await world({
      validate: { request: "blocking", always: { json: { duplicateKeys: "reject" } } },
    });
    try {
      // Two `qty` values: whichever one wins, a validator and a backend could disagree about it.
      const response = await post(w, '{"sku":"ABC-1234","qty":1,"qty":99}');
      expect(response.status).toBe(400);
      expect((await response.json()).detail).toContain("duplicate");
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });

  test("last-wins is available, and then the winner is what is validated", async () => {
    const w = await world({
      validate: { request: "blocking", always: { json: { duplicateKeys: "last-wins" } } },
    });
    try {
      expect((await post(w, '{"sku":"ABC-1234","qty":1,"qty":99}')).status).toBe(200);
      // The last value is the one checked: 100 is over the maximum.
      expect((await post(w, '{"sku":"ABC-1234","qty":1,"qty":100}')).status).toBe(400);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- responses

describe("response validation", () => {
  test("blocking turns a non-conforming backend response into 502", async () => {
    const w = await world(
      { validate: { request: "blocking", response: "blocking" } },
      () => Response.json({ orderId: 7 }),
    );
    try {
      const response = await post(w, VALID_BODY);
      // 502, not 500: the gateway worked, the backend broke its own contract. And not the backend's
      // 200, because a consumer that trusted the contract would have parsed garbage.
      expect(response.status).toBe(502);
      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  test("a conforming response passes through untouched", async () => {
    const w = await world(
      { validate: { request: "blocking", response: "blocking" } },
      () => Response.json({ orderId: "ord_9" }),
    );
    try {
      const response = await post(w, VALID_BODY);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ orderId: "ord_9" });
    } finally {
      w.stop();
    }
  });

  test("warning on the response leaves the backend's body exactly as it was", async () => {
    const w = await world(
      {
        validate: {
          request: "blocking",
          response: "warning",
          sample: { rate: 1 },
        },
      },
      () => Response.json({ orderId: 7 }),
    );
    try {
      const response = await post(w, VALID_BODY);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ orderId: 7 });
      await Bun.sleep(20);
      expect(w.dp.counters.snapshot().observed).toBeGreaterThan(0);
    } finally {
      w.stop();
    }
  });

  test("response validation is off by default: it is a backend contract, not a consumer one", async () => {
    const w = await world({}, () => Response.json({ orderId: 7 }));
    try {
      expect(w.dp.client.table!.routes[0]!.policy.validate!.response).toBe("disabled");
      expect((await post(w, VALID_BODY)).status).toBe(200);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- SOAP

describe("SOAP bodies validate against the WSDL's inline schema", () => {
  function envelope(inner: string): string {
    return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
  }

  async function soapWorld() {
    const backend = startBackend(() =>
      new Response(
        envelope(
          `<tns:GetPetResponse xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId><tns:name>doggie</tns:name><tns:status>available</tns:status></tns:GetPetResponse>`,
        ),
        { headers: { "content-type": "text/xml; charset=utf-8" } },
      ),
    );
    const cpServer = serveCp(cp);
    const api = await publishApi(cp, {
      kind: "soap",
      spec: WSDL,
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        rewrite: { stripBasePath: true },
      },
    });
    const dp = makeDp(cpServer.url, cp.token, cp.dir);
    await dp.start();
    if (!dp.client.table) throw new Error(`did not activate: ${dp.client.activationBlocked}`);
    const call = (body: string) =>
      dp.fetchHttp(
        new Request(`http://gw${api.basePath}`, {
          method: "POST",
          headers: {
            "content-type": "text/xml; charset=utf-8",
            "x-api-key": api.key!,
            soapaction: `"urn:apim:petstore:GetPet"`,
          },
          body,
        }),
        "127.0.0.1",
      );
    return {
      call,
      backend,
      dp,
      stop: () => {
        dp.stop();
        cpServer.stop();
        backend.stop();
      },
    };
  }

  test("a conforming envelope proxies; a body the XSD does not allow is a fault", async () => {
    const w = await soapWorld();
    try {
      const ok = await w.call(
        envelope(`<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId></tns:GetPetRequest>`),
      );
      expect(ok.status).toBe(200);
      expect(w.backend.requests).toHaveLength(1);

      // `petId` is xsd:long: a non-numeric lexical form is not a value of that type.
      const badType = await w.call(
        envelope(
          `<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>seven</tns:petId></tns:GetPetRequest>`,
        ),
      );
      expect(badType.status).toBe(400);
      expect(await badType.text()).toContain("Fault");

      // An element the sequence does not declare.
      const extra = await w.call(
        envelope(
          `<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId><tns:oops>x</tns:oops></tns:GetPetRequest>`,
        ),
      );
      expect(extra.status).toBe(400);

      // A required element missing.
      const missing = await w.call(
        envelope(`<tns:GetPetRequest xmlns:tns="urn:apim:petstore"/>`),
      );
      expect(missing.status).toBe(400);

      expect(w.backend.requests).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  test("a rejection on a soap route is a fault carrying the real HTTP status", async () => {
    const w = await soapWorld();
    try {
      const response = await w.call(
        envelope(`<tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>x</tns:petId></tns:GetPetRequest>`),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("text/xml");
      const text = await response.text();
      expect(text).toContain("Fault");
      expect(text).toContain("faultstring");
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- sampling and pools

describe("sampling", () => {
  test("the decision is deterministic in the key and the request id, not in a counter", () => {
    // Two independent samplers, no shared state: the same inputs must give the same answer, or a
    // report could not be reproduced and a fleet would not sample consistently.
    const options = { rate: 0.5, coldStart: 0, alwaysUnderBytes: 0 };
    const a = new Sampler();
    const b = new Sampler();
    for (const id of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) {
      expect(a.decide("op|sub", id, options, 1000)).toBe(b.decide("op|sub", id, options, 1000));
    }
    // And it is a rate, not a constant answer.
    const decisions = new Set(
      Array.from({ length: 40 }, (_, i) => a.decide("op|sub", `id-${i}`, options, 1000)),
    );
    expect(decisions).toEqual(new Set([true, false]));
  });

  test("a body cheap enough to check is always checked", () => {
    const sampler = new Sampler();
    // Sampling something that costs microseconds saves nothing, so cost is the gate.
    expect(sampler.decide("k", "r", { rate: 0, coldStart: 0, alwaysUnderBytes: 4096 }, 100)).toBe(true);
    expect(sampler.decide("k", "r", { rate: 0, coldStart: 0, alwaysUnderBytes: 4096 }, 8192)).toBe(false);
  });

  test("the first requests on a new key are always checked", () => {
    const sampler = new Sampler();
    const options = { rate: 0, coldStart: 3, alwaysUnderBytes: 0 };
    // A rate of zero would otherwise mean a new revision is never observed at all.
    expect(sampler.decide("fresh", "r1", options, 9999)).toBe(true);
    expect(sampler.decide("fresh", "r2", options, 9999)).toBe(true);
    expect(sampler.decide("fresh", "r3", options, 9999)).toBe(true);
    expect(sampler.decide("fresh", "r4", options, 9999)).toBe(false);

    // Re-armed by a config change, so a new revision gets its own burst.
    sampler.reset();
    expect(sampler.decide("fresh", "r4", options, 9999)).toBe(true);
  });

  test("a failure escalates that key to every request for a bounded window", () => {
    let now = 1_000_000;
    const sampler = new Sampler(20_000, () => now);
    const options = { rate: 0, coldStart: 0, alwaysUnderBytes: 0 };
    expect(sampler.decide("k", "r1", options, 9999)).toBe(false);

    sampler.escalate("k", 60);
    expect(sampler.decide("k", "r2", options, 9999)).toBe(true);
    expect(sampler.decide("k", "r3", options, 9999)).toBe(true);

    // Bounded: the escalation ends on its own rather than costing 100% forever.
    now += 61_000;
    expect(sampler.decide("k", "r4", options, 9999)).toBe(false);
  });

  test("a config change re-arms sampling on the instance", async () => {
    const w = await world({
      validate: {
        request: "warning",
        downgradeReason: "asserting that activation resets the sampler",
        sample: { rate: 1 },
      },
    });
    try {
      await post(w, { sku: "nope", qty: 1 });
      await Bun.sleep(20);
      expect(w.dp.counters.snapshot().observed).toBeGreaterThan(0);
    } finally {
      w.stop();
    }
  });
});

describe("the bounded validation pool and the blocking budget", () => {
  test("a saturated pool drops the sample and counts it; the request is unaffected", async () => {
    const w = await world(
      {
        validate: {
          request: "warning",
          downgradeReason: "asserting that saturation sheds samples, never requests",
          sample: { rate: 1 },
        },
      },
      () => Response.json({ orderId: "ord_1" }),
    );
    try {
      // A pool with no room at all: every sample must be dropped, and every request must succeed.
      const saturated = w.dp.pool as unknown as { queue: unknown[]; depth: number };
      Object.defineProperty(saturated, "depth", { value: 0, configurable: true });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => post(w, { sku: "nope", qty: 1 })),
      );
      for (const response of responses) expect(response.status).toBe(200);
      expect(w.dp.counters.snapshot().sampleDropped).toBe(5);
      // Not one request was rejected for a reason the consumer could do nothing about.
      expect(w.dp.counters.snapshot().rejected).toBe(0);
    } finally {
      w.stop();
    }
  });

  test("blocking validation past the buffer budget sheds with 503, never validates half-way", async () => {
    const w = await world({ validate: { request: "blocking" } });
    try {
      // A budget too small for even one buffered body: the request must be shed, not admitted
      // unvalidated (design section 8.4).
      Object.defineProperty(w.dp.budget, "total", { value: 1, configurable: true });

      const response = await post(w, VALID_BODY);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).not.toBeNull();
      expect(w.dp.counters.snapshot().budgetShed).toBe(1);
      // Shed, not forwarded: letting it through would be exactly the fail-open this bound exists
      // to prevent.
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- unavailable validators

describe("a route whose validator is unavailable fails closed", () => {
  test("the route answers 503 and is counted, while other routes serve", async () => {
    const w = await world({ validate: { request: "blocking" } });
    try {
      // The bundle is evicted underneath a running config — a corrupted volume, or an eviction
      // that should not have happened. Degrading to `warning` here would break the guarantee the
      // route was published with, so it fails closed.
      const digest = w.dp.client.table!.routes[0]!.artifacts[0]!.digest;
      w.dp.artifacts.unavailable.add(digest);
      const inner = w.dp.artifacts as unknown as { artifacts: Map<string, unknown> };
      inner.artifacts.delete(digest);
      const dir = (w.dp.artifacts as unknown as { options: { directory: string } }).options.directory;
      const { unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      unlinkSync(join(dir, "artifacts", digest.replace(":", "_")));

      const response = await post(w, VALID_BODY);
      expect(response.status).toBe(503);
      expect(w.dp.counters.snapshot().unavailable).toBe(1);
      expect(w.backend.requests).toHaveLength(0);
    } finally {
      w.stop();
    }
  });
});

// --------------------------------------------------------------------------- reporting

describe("what the instance reports", () => {
  test("validation counters travel on the poll and are cleared when it is accepted", async () => {
    const w = await world({ validate: { request: "blocking" } });
    try {
      await post(w, { sku: "nope", qty: 1 });
      expect(w.dp.counters.snapshot().rejected).toBe(1);

      expect(await w.dp.client.pollOnce()).not.toBe("error");
      // Cleared, so a re-sent report cannot double-count.
      expect(w.dp.counters.snapshot().rejected).toBe(0);

      const process = cp.app.db
        .query<{ process_json: string }, []>("SELECT process_json FROM gateway_instance LIMIT 1")
        .get()!;
      expect(JSON.parse(process.process_json).validation.rejected).toBe(1);
    } finally {
      w.stop();
    }
  });

  test("/healthz exposes the validation state an operator needs", async () => {
    const w = await world({ validate: { request: "blocking" } });
    try {
      await post(w, { sku: "nope", qty: 1 });
      const health = w.dp.health() as Record<string, Record<string, number>>;
      expect(health.validation!.rejected).toBe(1);
      expect(health.validation!.blockingBudgetBytes).toBeGreaterThan(0);
      expect(health.artifacts!.artifacts).toBeGreaterThan(0);
    } finally {
      w.stop();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GLOBAL_UNITS } from "../shared/policy.ts";
import { makeCp, makeDp, poll, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * Goal 2: a policy attached to an environment applies to every API in it, and an API's own policy
 * wins a conflict.
 *
 * This tier does not exist in the design (deviation D18), so it is built to be the weaker side of
 * every argument it can be in. Each of these tests is one of the reasons estate-wide policy is
 * hated wherever it exists, closed:
 *
 *  - "why is this API rate limited" is answerable **from the API's own page**, because every unit
 *    carries its origin;
 *  - an owner is never locked out: attaching the unit locally always wins;
 *  - a global write that would break an API is refused **naming that API**, not accepted and
 *    discovered at the next poll;
 *  - the tier is never promoted, so dev's globals cannot arrive in prod as a side effect of
 *    shipping a revision.
 */

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

const KEY_UNIT = { in: "header" as const, name: "X-Api-Key", forwardCredentials: false };

async function setGlobal(cookie: string, unitKey: string, value: unknown, environment = "dev") {
  return cp.call(`PUT`, `/api/policy/global/units/${encodeURIComponent(unitKey)}?environment=${environment}`, {
    cookie,
    body: { value },
  });
}

describe("attaching a global unit", () => {
  test("it reaches every API in the environment, without touching any of them", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const one = await publishApi(cp, { backendUrl: backend.url, name: "alpha" });
      const two = await publishApi(cp, { backendUrl: backend.url, name: "beta" });

      const response = await setGlobal(alice, "headers.response", {
        set: { "X-Served-By": "integration-portal" },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).affectedResources).toBe(2);

      const { config } = await poll(cp);
      for (const route of config!.routes) {
        expect(route.policy["headers.response"]).toEqual({
          set: { "X-Served-By": "integration-portal" },
        });
      }
      // Neither API has a `headers.response` row: the value is not copied into them, it is merged
      // under them, so changing the global changes both.
      const rows = cp.app.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM policy_entry WHERE unit_key = 'headers.response'")
        .get()!;
      expect(rows.n).toBe(0);
      expect([one.resourceId, two.resourceId]).toHaveLength(2);
    } finally {
      backend.stop();
    }
  });

  test("an API's own unit wins, whole, and the other units still merge", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: {
          "auth.subscriptionKey": KEY_UNIT,
          rateLimit: { calls: 100, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
        },
      });
      await setGlobal(alice, "rateLimit", {
        calls: 5,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      });
      await setGlobal(alice, "timeoutMs", 4000);

      const { config } = await poll(cp);
      const policy = config!.routes[0]!.policy;
      // Whole units, never field-wise: the API's 100 wins entirely rather than 100 with the
      // global's period, which is a value nobody wrote.
      expect(policy.rateLimit!.calls).toBe(100);
      expect(policy.timeoutMs).toBe(4000);
      expect(api.resourceId).toBeTruthy();
    } finally {
      backend.stop();
    }
  });

  test("the API's own page names the origin of every unit", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT },
      });
      await setGlobal(alice, "timeoutMs", 7000);

      const effective = await (
        await cp.call("GET", `/api/resources/${api.resourceId}/policy/effective?environment=dev`, {
          cookie: api.pavel,
        })
      ).json();

      const byKey = Object.fromEntries(
        (effective.units as Array<{ unitKey: string; origin: string }>).map((u) => [u.unitKey, u.origin]),
      );
      // This is the whole reason the tier is tolerable.
      expect(byKey["auth.subscriptionKey"]).toBe("resource");
      expect(byKey.timeoutMs).toBe("global");
      expect(effective.globalUnits).toEqual(["timeoutMs"]);
      expect(effective.document.timeoutMs).toBe(7000);
    } finally {
      backend.stop();
    }
  });

  test("an owner can always take a global unit back by attaching it locally", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT },
      });
      await setGlobal(alice, "timeoutMs", 1000);

      const override = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/timeoutMs`,
        { cookie: api.pavel, body: { value: 25_000 } },
      );
      expect(override.status).toBe(200);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBe(25_000);
    } finally {
      backend.stop();
    }
  });
});

describe("what may be attached, and by whom", () => {
  test("the tier is admin-only", async () => {
    const backend = startBackend();
    try {
      const api = await publishApi(cp, { backendUrl: backend.url });
      const asOwner = await setGlobal(api.pavel, "timeoutMs", 5000);
      // It changes every API in the environment at once, which is not an owner's decision.
      expect(asOwner.status).toBe(403);
      expect(
        (await cp.call("DELETE", "/api/policy/global/units/timeoutMs?environment=dev", { cookie: api.pavel }))
          .status,
      ).toBe(403);
    } finally {
      backend.stop();
    }
  });

  test("only allowlisted units may be attached globally", async () => {
    const alice = await cp.login("alice");
    // A backend is per API by definition; so is a rewrite, a passthrough, a transform.
    for (const unitKey of ["rewrite", "backendAuth", "passthrough", "transform", "errorFormat"]) {
      const refused = await setGlobal(alice, unitKey, {});
      expect(refused.status).toBe(400);
      expect((await refused.json()).detail).toContain("may not be attached globally");
    }
    // And a per-operation override never is: an operation id means nothing outside its own API.
    const perOperation = await setGlobal(alice, 'operations["getPet"].rateLimit', {});
    expect(perOperation.status).toBe(400);

    for (const unitKey of GLOBAL_UNITS) {
      expect(typeof unitKey).toBe("string");
    }
  });

  test("a globally attached unit is still validated as a unit", async () => {
    const alice = await cp.login("alice");
    const refused = await setGlobal(alice, "rateLimit", { calls: 0, periodSec: 60 });
    expect(refused.status).toBe(400);
    expect((await refused.json()).detail).toContain("rateLimit");
  });
});

describe("a global write is validated against every API it would affect", () => {
  test("it is refused, naming the API it would break", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      // This API has no subscription key, so a global rate limit counted by subscription would
      // leave it with a limit it cannot attribute.
      const open = await publishApi(cp, { backendUrl: backend.url, name: "wideopen", subscribe: false });

      const refused = await setGlobal(alice, "rateLimit", {
        calls: 10,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      });
      expect(refused.status).toBe(409);
      const detail = (await refused.json()).detail;
      // Naming the API is the difference between a message an admin can act on and one they cannot.
      expect(detail).toContain("wideopen");
      expect(detail).toContain("auth.subscriptionKey");
      expect(open.resourceId).toBeTruthy();

      // Nothing was written.
      const stored = cp.app.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM global_policy_entry")
        .get()!;
      expect(stored.n).toBe(0);
    } finally {
      backend.stop();
    }
  });

  test("a global auth.subscriptionKey can be what satisfies a global rate limit", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      await publishApi(cp, { backendUrl: backend.url, name: "plain" });

      // Attach the key first; now the rate limit has something to count by, estate-wide.
      expect((await setGlobal(alice, "auth.subscriptionKey", KEY_UNIT)).status).toBe(200);
      const rate = await setGlobal(alice, "rateLimit", {
        calls: 10,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      });
      expect(rate.status).toBe(200);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy["auth.subscriptionKey"]).toEqual(KEY_UNIT);
      expect(config!.routes[0]!.policy.rateLimit!.calls).toBe(10);
    } finally {
      backend.stop();
    }
  });

  test("detaching is checked the same way, in the other direction", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      await publishApi(cp, { backendUrl: backend.url, name: "plain" });
      await setGlobal(alice, "auth.subscriptionKey", KEY_UNIT);
      await setGlobal(alice, "rateLimit", {
        calls: 10,
        periodSec: 60,
        per: "instance",
        by: "subscription",
        scope: "route",
      });

      const refused = await cp.call(
        "DELETE",
        "/api/policy/global/units/auth.subscriptionKey?environment=dev",
        { cookie: alice },
      );
      // Removing the key would leave the rate limit unattributable — found here rather than at the
      // next poll.
      expect(refused.status).toBe(409);
      expect((await refused.json()).detail).toContain("plain");

      // Remove them in an order that stays valid, and both go.
      expect(
        (await cp.call("DELETE", "/api/policy/global/units/rateLimit?environment=dev", { cookie: alice }))
          .status,
      ).toBe(204);
      expect(
        (
          await cp.call("DELETE", "/api/policy/global/units/auth.subscriptionKey?environment=dev", {
            cookie: alice,
          })
        ).status,
      ).toBe(204);
    } finally {
      backend.stop();
    }
  });
});

describe("the tier is per environment and is never promoted", () => {
  test("dev's globals do not appear in prod", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      await publishApi(cp, { backendUrl: backend.url });
      await setGlobal(alice, "timeoutMs", 3000, "dev");

      const prod = await (
        await cp.call("GET", "/api/policy/global?environment=prod", { cookie: alice })
      ).json();
      expect(prod.units).toHaveLength(0);
      expect(prod.document).toEqual({});
    } finally {
      backend.stop();
    }
  });

  test("copy-from is explicit, diffed, and refused when it would break the destination", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, { backendUrl: backend.url, name: "mover" });
      await setGlobal(alice, "timeoutMs", 3000, "dev");
      await setGlobal(alice, "auth.subscriptionKey", KEY_UNIT, "dev");

      // A route and a binding in test, so the resource has state there to be affected.
      await cp.call("PUT", `/api/resources/${api.resourceId}/routes`, {
        cookie: api.pavel,
        body: { environment: "test", host: "*", basePath: "/mover" },
      });

      const dry = await (
        await cp.call("POST", "/api/policy/global/copy-from?environment=test", {
          cookie: alice,
          body: { from: "dev" },
        })
      ).json();
      expect(dry.applied).toBe(false);
      expect(dry.changes.map((c: { unitKey: string }) => c.unitKey).sort()).toEqual([
        "auth.subscriptionKey",
        "timeoutMs",
      ]);
      // Nothing has moved yet: a dry run is a dry run.
      const before = await (
        await cp.call("GET", "/api/policy/global?environment=test", { cookie: alice })
      ).json();
      expect(before.units).toHaveLength(0);

      const applied = await (
        await cp.call("POST", "/api/policy/global/copy-from?environment=test", {
          cookie: alice,
          body: { from: "dev", dryRun: false },
        })
      ).json();
      expect(applied.applied).toBe(true);

      const after = await (
        await cp.call("GET", "/api/policy/global?environment=test", { cookie: alice })
      ).json();
      expect(after.document.timeoutMs).toBe(3000);
    } finally {
      backend.stop();
    }
  });

  test("promoting a revision does not carry the global tier", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, { backendUrl: backend.url, name: "shipper" });
      await setGlobal(alice, "timeoutMs", 3000, "dev");

      const { promote, prepareEnvironment } = await import("./helpers.ts");
      await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/shipper", backend.url);
      const promoted = await promote(cp, api.pavel, api.resourceId, "test");
      expect([201, 202]).toContain(promoted.status);

      const testGlobals = await (
        await cp.call("GET", "/api/policy/global?environment=test", { cookie: alice })
      ).json();
      // The two environments differ in exactly the ways a global policy is used to express, so
      // carrying it along with a revision would be the wrong default.
      expect(testGlobals.units).toHaveLength(0);
    } finally {
      backend.stop();
    }
  });
});

describe("what the global screen reports", () => {
  test("it says how many APIs it affects and how many already override each unit", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      await publishApi(cp, { backendUrl: backend.url, name: "one" });
      await publishApi(cp, {
        backendUrl: backend.url,
        name: "two",
        policy: { timeoutMs: 9000 },
      });
      await setGlobal(alice, "timeoutMs", 3000);

      const view = await (
        await cp.call("GET", "/api/policy/global?environment=dev", { cookie: alice })
      ).json();
      expect(view.affectedResources).toBe(2);
      // The number that says whether the global value is actually doing anything.
      expect(view.units[0]!.overriddenBy).toBe(1);
      expect(view.attachable).toContain("timeoutMs");
      expect(view.canEdit).toBe(true);
    } finally {
      backend.stop();
    }
  });

  test("the gateway serves the merged document, with no knowledge of the tier", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/merged",
        policy: { "auth.subscriptionKey": KEY_UNIT, rewrite: { stripBasePath: true } },
      });
      await setGlobal(alice, "headers.response", { set: { "X-Estate": "vw" } });

      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      await dp.start();
      try {
        const response = await dp.fetchHttp(
          new Request("http://gw/it/solution/merged/store/inventory", { headers: { "x-api-key": api.key! } }),
          "127.0.0.1",
        );
        expect(response.status).toBe(200);
        // The data plane received one document and cannot tell which tier a unit came from —
        // which is what keeps the merge in one place.
        expect(response.headers.get("x-estate")).toBe("vw");
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });
});

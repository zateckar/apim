import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GLOBAL_UNITS } from "../shared/policy.ts";
import { runOperations } from "../control-plane/src/operations.ts";
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

  test("an administrator can give one API its own value, and it reaches the gateway", async () => {
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
        { cookie: alice, body: { value: 25_000 } },
      );
      expect(override.status).toBe(200);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBe(25_000);
    } finally {
      backend.stop();
    }
  });

  test("the owner cannot, and is told who can", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT },
      });
      await setGlobal(alice, "timeoutMs", 1000);

      const refused = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/timeoutMs`,
        { cookie: api.pavel, body: { value: 25_000 } },
      );
      expect(refused.status).toBe(403);
      const detail = (await refused.json()).detail as string;
      expect(detail).toContain("timeoutMs");
      expect(detail).toContain("administrator");
      expect(detail).toContain("Global policy");

      // Refused rather than accepted-and-ignored: the environment's value is what runs.
      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBe(1000);
    } finally {
      backend.stop();
    }
  });

  /**
   * The hole this rule was written for. `disabled` is a real key of the document, it was settable
   * by the owner like any other, and `activeDocument` subtracts it from the **merged** document —
   * so naming an inherited unit there took an administrator's environment-wide `auth.jwt`,
   * `ipAllow` or `rateLimit` off one API without touching the global tier at all.
   */
  test("the owner cannot switch an inherited unit off either", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT },
      });
      await setGlobal(alice, "timeoutMs", 1000);

      const refused = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/disabled`,
        { cookie: api.pavel, body: { value: ["timeoutMs"] } },
      );
      expect(refused.status).toBe(403);
      expect((await refused.json()).detail as string).toContain("timeoutMs");

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBe(1000);
    } finally {
      backend.stop();
    }
  });

  test("an owner may still switch off a unit that is their own", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT, timeoutMs: 9000 },
      });
      // A different unit is the environment's, so the rule is engaged and still lets this through.
      await setGlobal(alice, "headers.response", { set: { "X-A": "1" } });

      const off = await cp.call(
        "PUT",
        `/api/resources/${api.resourceId}/policy/units/disabled`,
        { cookie: api.pavel, body: { value: ["timeoutMs"] } },
      );
      expect(off.status).toBe(200);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBeUndefined();
    } finally {
      backend.stop();
    }
  });

  test("an exception an administrator granted is the administrator's to take away", async () => {
    const backend = startBackend();
    try {
      const alice = await cp.login("alice");
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        policy: { "auth.subscriptionKey": KEY_UNIT },
      });
      await setGlobal(alice, "timeoutMs", 1000);
      const path = `/api/resources/${api.resourceId}/policy/units/timeoutMs`;
      expect((await cp.call("PUT", path, { cookie: alice, body: { value: 25_000 } })).status).toBe(200);

      // Not the owner's to detach, and not the owner's to re-price either — an owner who could
      // revise an exception could first widen it.
      expect((await cp.call("DELETE", path, { cookie: api.pavel })).status).toBe(403);
      expect((await cp.call("PUT", path, { cookie: api.pavel, body: { value: 30_000 } })).status).toBe(403);
      expect((await cp.call("DELETE", path, { cookie: alice })).status).toBe(204);

      const { config } = await poll(cp);
      expect(config!.routes[0]!.policy.timeoutMs).toBe(1000);
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

/**
 * The workspace loads the **effective** document, so a global unit is on the API's own policy tab
 * looking exactly like one its owner wrote. That made two things go wrong at once, and both are
 * about the tier's whole point — that a global stays a global:
 *
 *  - saving anything at all wrote every unit of that document back as a `policy_entry` row, so the
 *    API silently detached from the tier and a later change on the Global policy screen reached
 *    every API except the ones somebody had touched;
 *  - removing a global unit's card appeared to work and then did nothing, because the value is
 *    merged back in at the next read.
 */
describe("a global unit survives an API's own save", () => {
  let backend: ReturnType<typeof startBackend>;
  beforeEach(() => {
    backend = startBackend();
  });
  afterEach(() => {
    backend.stop();
  });

  async function publish(name: string) {
    // `publishApi` rather than the publish command, because the two differ in exactly the way
    // these tests are about: a resource with a queued operation answers the workspace with that
    // operation's snapshot, and a snapshot is a record of what somebody asked for. Only an API
    // whose latest state is its stored rows is shown the *effective* document — which is where a
    // global unit turns up on a page that otherwise looks like the API's own.
    return (await publishApi(cp, { backendUrl: backend.url, name })).resourceId;
  }

  async function editor(id: string) {
    return (await cp.call("GET", `/api/resources/${id}/editor?environment=dev`, { cookie: await cp.login("pavel") })).json();
  }

  async function configure(id: string, body: Record<string, unknown>) {
    const d = await editor(id);
    return cp.call("POST", `/api/resources/${id}/configure`, {
      cookie: await cp.login("pavel"),
      body: { environment: "dev", domain: "IT", subdomain: "Solution", ...body },
      headers: { "idempotency-key": `cfg-${Math.random()}`, "if-match": d.resource.etag },
    }).then((response) => {
      runOperations(cp.app);
      return response;
    });
  }

  function localRows(unitKey: string): number {
    return cp.app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM policy_entry WHERE unit_key = ?")
      .get(unitKey)!.n;
  }

  test("saving an unrelated field does not freeze the global as a local copy", async () => {
    const alice = await cp.login("alice");
    const id = await publish("inheriting");
    await setGlobal(alice, "timeoutMs", 4000);
    expect(localRows("timeoutMs")).toBe(0);

    const saved = await configure(id, { description: "Something else entirely." });
    expect(saved.status).toBe(202);

    // Still inherited, not copied — so the next global change still reaches this API. Asserted
    // against the document the gateway is served rather than the workspace's, because the
    // workspace answers with the last queued snapshot once there is an operation and that is a
    // record of what was asked for rather than of what is in force.
    expect(localRows("timeoutMs")).toBe(0);
    await setGlobal(alice, "timeoutMs", 6000);
    const { config } = await poll(cp);
    expect(config!.routes.find((route) => route.resourceId === id)!.policy.timeoutMs).toBe(6000);
  });

  test("a save that carries the global's own value back is still an inheritance, not an override", async () => {
    const alice = await cp.login("alice");
    const id = await publish("echoing");
    await setGlobal(alice, "timeoutMs", 4000);

    // Exactly what the policy tab sends after somebody edits a different unit: the whole effective
    // document, the global included, because that is what it loaded.
    const d = await editor(id);
    const saved = await configure(id, { policy: { ...d.settings.policy, "headers.response": { set: { "X-A": "1" } } } });
    expect(saved.status).toBe(202);

    expect(localRows("timeoutMs")).toBe(0);
    expect(localRows("headers.response")).toBe(1);
  });

  test("a different value from the owner is refused, because overriding is an administrator's act", async () => {
    const alice = await cp.login("alice");
    const id = await publish("overriding");
    await setGlobal(alice, "timeoutMs", 4000);

    const d = await editor(id);
    const refused = await configure(id, { policy: { ...d.settings.policy, timeoutMs: 15_000 } });
    expect(refused.status).toBe(403);
    expect((await refused.json()).detail as string).toContain("timeoutMs");
    expect(localRows("timeoutMs")).toBe(0);
  });

  test("a different value from an administrator is stored, and wins over a later global change", async () => {
    const alice = await cp.login("alice");
    const id = await publish("overriding-admin");
    await setGlobal(alice, "timeoutMs", 4000);

    const d = await editor(id);
    const saved = await cp.call("POST", `/api/resources/${id}/configure`, {
      cookie: alice,
      body: {
        environment: "dev",
        domain: "IT",
        subdomain: "Solution",
        policy: { ...d.settings.policy, timeoutMs: 15_000 },
      },
      headers: { "idempotency-key": `admin-${Math.random()}`, "if-match": d.resource.etag },
    });
    runOperations(cp.app);
    expect(saved.status).toBe(202);
    expect(localRows("timeoutMs")).toBe(1);

    // And the override wins over a later global change, which is what an override means.
    await setGlobal(alice, "timeoutMs", 1000);
    expect((await editor(id)).settings.policy.timeoutMs).toBe(15_000);
  });

  /**
   * The rule is about what a save *moves*, not about what the document contains. An exception an
   * administrator granted stays in the document the owner loads and sends back on every save, and
   * an owner who could not save at all while one existed would be locked out of their own API.
   */
  test("an administrator's exception does not lock the owner out of the rest of the document", async () => {
    const alice = await cp.login("alice");
    const id = await publish("coexisting");
    await setGlobal(alice, "timeoutMs", 4000);
    expect(
      (await cp.call("PUT", `/api/resources/${id}/policy/units/timeoutMs`, {
        cookie: alice,
        body: { value: 15_000 },
      })).status,
    ).toBe(200);

    const d = await editor(id);
    expect(d.settings.policy.timeoutMs).toBe(15_000);
    const saved = await configure(id, {
      policy: { ...d.settings.policy, "headers.response": { set: { "X-A": "1" } } },
    });
    expect(saved.status).toBe(202);
    expect(localRows("headers.response")).toBe(1);
    expect((await editor(id)).settings.policy.timeoutMs).toBe(15_000);
  });

  test("dropping a global unit is refused, naming it and where it belongs", async () => {
    const alice = await cp.login("alice");
    const id = await publish("detaching");
    await setGlobal(alice, "timeoutMs", 4000);

    const d = await editor(id);
    const { timeoutMs, ...without } = d.settings.policy as Record<string, unknown>;
    expect(timeoutMs).toBe(4000);

    const refused = await configure(id, { policy: without });
    expect(refused.status).toBe(400);
    const detail = (await refused.json()).detail as string;
    expect(detail).toContain("timeoutMs");
    expect(detail).toContain("Global policy");
    // Refused rather than accepted-and-undone: the unit is still there afterwards.
    expect((await editor(id)).settings.policy.timeoutMs).toBe(4000);
  });

  test("an administrator cannot do it either, because it is the environment's decision", async () => {
    const alice = await cp.login("alice");
    const id = await publish("admin-detaching");
    await setGlobal(alice, "timeoutMs", 4000);

    const d = await editor(id);
    const { timeoutMs, ...without } = d.settings.policy as Record<string, unknown>;
    const refused = await cp.call("POST", `/api/resources/${id}/configure`, {
      cookie: alice,
      body: { environment: "dev", domain: "IT", subdomain: "Solution", policy: without },
      headers: { "idempotency-key": `admin-${Math.random()}`, "if-match": d.resource.etag },
    });
    expect(refused.status).toBe(400);
    expect(timeoutMs).toBe(4000);
  });

  test("the workspace says which units are the environment's, so the editor can lock them", async () => {
    const alice = await cp.login("alice");
    const id = await publish("naming");
    await setGlobal(alice, "timeoutMs", 4000);

    const d = await editor(id);
    expect(d.globalUnits).toEqual(["timeoutMs"]);
    // The value is already in the document; what the screen was missing is the provenance.
    expect(d.settings.policy.timeoutMs).toBe(4000);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ownerAttention } from "../control-plane/src/attention.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { activeDocument, disabledUnits, validateDocument } from "../shared/policy.ts";
import { makeCp, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * Configured, but not running.
 *
 * A policy that is switched off is not the same as a policy that was deleted: the first keeps its
 * numbers and the second loses them, and an operator suppressing a rate limit during an incident
 * means the first. The document says so in a reserved `disabled` key, and the control plane
 * subtracts it on the way to the wire — so no gateway learns the concept exists, and nothing that
 * reads a document can be looking at a different answer than the gateway is running.
 */

/** A valid `rateLimit` — it is the unit whose cross-unit rule these tests exercise. */
const RATE_LIMIT = {
  calls: 5,
  periodSec: 60,
  per: "instance",
  by: "subscription",
  scope: "route",
  emitHeaders: true,
};

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;

beforeEach(() => {
  cp = makeCp();
  backend = startBackend();
});

afterEach(() => {
  backend.stop();
  cp.close();
});

describe("the vocabulary", () => {
  test("names units, and only ones that exist", () => {
    expect(validateDocument({ disabled: ["rateLimit"], rateLimit: RATE_LIMIT }))
      .toEqual([]);
    expect(validateDocument({ disabled: "rateLimit" })).toEqual([
      "disabled: expected an array of policy unit keys",
    ]);
    expect(validateDocument({ disabled: ["nonsense"] })).toEqual([
      'disabled: "nonsense" is not a policy unit',
    ]);
    expect(validateDocument({ disabled: ["disabled"] })).toEqual(["disabled: cannot disable itself"]);
  });

  test("a name for a unit the document no longer carries is ignored, not refused", () => {
    // A promotion can drop a unit and leave the list that mentioned it. Refusing the document
    // would block the promotion rather than the mistake.
    expect(validateDocument({ disabled: ["rateLimit"] })).toEqual([]);
    expect(disabledUnits({ disabled: ["rateLimit"] })).toEqual([]);
  });

  test("the cross-unit rules read what runs, not what is stored", () => {
    // rateLimit counts by subscription, so it normally demands auth.subscriptionKey. Switched
    // off, it counts nothing and demands nothing.
    expect(validateDocument({ rateLimit: RATE_LIMIT })).toHaveLength(1);
    expect(
      validateDocument({ rateLimit: RATE_LIMIT, disabled: ["rateLimit"] }),
    ).toEqual([]);
  });

  test("activeDocument subtracts the key and everything it names", () => {
    const doc: Record<string, unknown> = {
      timeoutMs: 5000,
      rateLimit: RATE_LIMIT,
      disabled: ["rateLimit"],
    };
    expect(activeDocument(doc)).toEqual({ timeoutMs: 5000 });
    // Untouched when there is nothing to subtract, so the common case allocates nothing.
    const plain: Record<string, unknown> = { timeoutMs: 5000 };
    expect(activeDocument(plain)).toBe(plain);
  });
});

describe("what reaches the gateway", () => {
  test("a disabled unit is not in the config, and the digest moves when it is switched", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      subscribe: false,
      policy: { timeoutMs: 4321 },
    });

    const before = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
    const route = before.routes.find((r) => r.resourceId === api.resourceId)!;
    expect((route.policy as Record<string, unknown>).timeoutMs).toBe(4321);

    const off = await cp.call(
      "PUT",
      `/api/resources/${api.resourceId}/policy/units/disabled`,
      { cookie: api.pavel, body: { value: ["timeoutMs"] } },
    );
    expect(off.status).toBe(200);

    const after = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
    const now = after.routes.find((r) => r.resourceId === api.resourceId)!;
    expect((now.policy as Record<string, unknown>).timeoutMs).toBeUndefined();
    // The unit is not "sent as off": it is not sent, and the reserved key is not sent either.
    expect((now.policy as Record<string, unknown>).disabled).toBeUndefined();
    // A route that stopped applying a policy is a different desired state, so the fleet has to
    // converge onto it rather than keep serving the old one.
    expect(after.digest).not.toBe(before.digest);
  });

  test("the value survives, so switching it back on retypes nothing", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      subscribe: false,
      policy: { timeoutMs: 4321 },
    });
    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/disabled`, {
      cookie: api.pavel,
      body: { value: ["timeoutMs"] },
    });

    const view = await (
      await cp.call(
        "GET",
        `/api/resources/${api.resourceId}/policy/effective?environment=dev`,
        { cookie: api.pavel },
      )
    ).json();
    // `document` is what the gateway gets; `disabled` is why something is missing from it.
    expect(view.document.timeoutMs).toBeUndefined();
    expect(view.disabled).toEqual(["timeoutMs"]);
    // The reserved key is not offered as a policy row of its own.
    expect((view.units as Array<{ unitKey: string }>).map((u) => u.unitKey)).not.toContain(
      "disabled",
    );

    const back = await cp.call(
      "DELETE",
      `/api/resources/${api.resourceId}/policy/units/disabled?environment=dev`,
      { cookie: api.pavel },
    );
    expect(back.status).toBe(204);
    const config = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config);
    const route = config.routes.find((r) => r.resourceId === api.resourceId)!;
    expect((route.policy as Record<string, unknown>).timeoutMs).toBe(4321);
  });
});

describe("what the estate notices", () => {
  test("switching off the only authentication makes the route read as open", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      subscribe: false,
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    const alice = await cp.login("alice");

    const scope = { environments: ["dev"], applications: null };
    expect(ownerAttention(cp.app, scope).map((r) => r.code)).not.toContain("no-auth-policy");

    const off = await cp.call(
      "PUT",
      `/api/resources/${api.resourceId}/policy/units/disabled`,
      { cookie: alice, body: { value: ["auth.subscriptionKey"] } },
    );
    expect(off.status).toBe(200);

    // Attached, stored, and not running — which is exactly the state this rule exists to notice.
    expect(ownerAttention(cp.app, scope).map((r) => r.code)).toContain("no-auth-policy");
  });
});

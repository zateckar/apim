import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeCp, publishApi, startBackend, type TestCp } from "./helpers.ts";

/**
 * Handing an API to another application (`POST /api/resources/:id/owner`).
 *
 * The command is about *authority*, so the tests are mostly about who may run it and what survives
 * it. The three things that must hold: the whole family moves, the published address does not, and
 * neither side can be surprised — the giver needs rights on the receiver, and a name collision is
 * refused whole rather than half-applied.
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

/** The row as the catalog sees it, which is where the ETag and the owner come from. */
async function resource(cookie: string, id: string) {
  const response = await cp.call("GET", `/api/resources/${id}`, { cookie });
  return { status: response.status, body: await response.json(), etag: response.headers.get("etag") };
}

describe("changing who owns an API", () => {
  test("an administrator moves every version of the family at once", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const second = await cp.call("POST", `/api/resources/${published.resourceId}/versions`, {
      cookie: published.pavel,
      body: { apiVersion: "v2" },
    });
    expect(second.status).toBe(201);
    const v2 = await second.json();

    const before = await resource(alice, published.resourceId);
    const moved = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders", reason: "handover" },
    });
    expect(moved.status).toBe(200);
    const body = await moved.json();
    expect(body.applicationId).toBe("application_orders");
    // The family, not the one version the caller happened to address.
    expect(body.transferred.map((row: { apiVersion: string }) => row.apiVersion).sort()).toEqual([
      "v1",
      "v2",
    ]);
    expect((await resource(alice, v2.id)).body.applicationId).toBe("application_orders");
    // The family key is (application, name), so it moves with them and both versions stay one API.
    expect(body.family).toBe(`application_orders/${published.name}`);
  });

  test("the published address does not move with the owner", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(alice, published.resourceId);
    const routesBefore = before.body.routes;

    const moved = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(moved.status).toBe(200);

    // The path is built from the domain, never from the owner: a consumer's URL is unaffected.
    const after = await resource(alice, published.resourceId);
    expect(after.body.routes).toEqual(routesBefore);
    expect(after.body.routes[0].basePath).toBe(published.basePath);
  });

  test("a member of only the giving application cannot hand it to a team they are not in", async () => {
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(published.pavel, published.resourceId);
    // Pavel owns it and may delete it, but he is not in Orders — accepting an obligation on
    // somebody else's behalf is the one thing this command must not allow.
    const refused = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: published.pavel,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(refused.status).toBe(403);
    expect((await resource(published.pavel, published.resourceId)).body.applicationId).toBe(
      "application_platform",
    );
  });

  test("a member of only the receiving application cannot take it", async () => {
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const alice = await cp.login("alice");
    const clara = await cp.login("clara");
    const before = await resource(alice, published.resourceId);
    const refused = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: clara,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(refused.status).toBe(403);
  });

  test("a name already taken in the receiving application is refused whole", async () => {
    const alice = await cp.login("alice");
    const shared = `taken-${Math.random().toString(36).slice(2, 8)}`;
    const mine = await publishApi(cp, { backendUrl: backend.url, name: shared, subscribe: false });
    // The same name, already in Orders. Two APIs of one name in one application cannot be told
    // apart, so the transfer has nowhere to land.
    const theirs = await cp.call("POST", "/api/resources", {
      cookie: alice,
      body: { kind: "rest", name: shared, applicationId: "application_orders", apiVersion: "v9" },
    });
    expect(theirs.status).toBe(201);

    const before = await resource(alice, mine.resourceId);
    const refused = await cp.call("POST", `/api/resources/${mine.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("v9");
    expect((await resource(alice, mine.resourceId)).body.applicationId).toBe("application_platform");
  });

  test("a product that sells only this family travels with it, and its subscribers keep their keys", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url });
    expect(published.subscriptionId).not.toBeNull();

    const before = await resource(alice, published.resourceId);
    const moved = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(moved.status).toBe(200);
    const body = await moved.json();
    // The product exists to sell this API, so leaving it behind would break the rule that a
    // product holds only its own application's APIs.
    expect(body.productsMoved.map((product: { id: string }) => product.id)).toEqual([
      published.productId,
    ]);
    const products = await (await cp.call("GET", "/api/products", { cookie: alice })).json();
    const product = products.items.find((row: { id: string }) => row.id === published.productId);
    expect(product.applicationId).toBe("application_orders");

    // The consumer is keyed on the product, not on its owner: nothing they hold moved.
    const mine = await (await cp.call("GET", "/api/subscriptions", { cookie: published.clara })).json();
    const subscription = mine.items.find(
      (row: { id: string }) => row.id === published.subscriptionId,
    );
    expect(subscription).toBeDefined();
    expect(subscription.state).toBe("active");
    // Still reachable with the same key, which is the whole reason the product travelled.
    const reveal = await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/reveal`, {
      cookie: published.clara,
    });
    expect(reveal.status).toBe(200);
    expect((await reveal.json()).primaryKey).toBe(published.key!);
  });

  test("a product that also sells something else blocks the transfer instead of breaking", async () => {
    const alice = await cp.login("alice");
    const one = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const two = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    // One bundle, two APIs. Moving it would carry `two` along with it; splitting it would revoke
    // access; leaving it would put another application's API in a Platform product.
    const bundle = await cp.call("POST", "/api/products", {
      cookie: alice,
      body: {
        name: `bundle-${Math.random().toString(36).slice(2, 8)}`,
        applicationId: "application_platform",
        resourceIds: [one.resourceId, two.resourceId],
      },
    });
    expect(bundle.status).toBe(201);

    const before = await resource(alice, one.resourceId);
    const refused = await cp.call("POST", `/api/resources/${one.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("also sell other APIs");
    expect((await resource(alice, one.resourceId)).body.applicationId).toBe("application_platform");
  });

  test("it refuses without an If-Match, and refuses a stale one", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });

    const bare = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      body: { applicationId: "application_orders" },
    });
    expect(bare.status).toBe(428);

    const stale = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": '"not-the-current-one"' },
      body: { applicationId: "application_orders" },
    });
    expect(stale.status).toBe(412);
  });

  test("the target has to exist and has to be a different application", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(alice, published.resourceId);

    const same = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_platform" },
    });
    expect(same.status).toBe(400);

    const nowhere = await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_nope" },
    });
    expect(nowhere.status).toBe(400);
  });

  test("the transfer is in the audit log with both sides on it", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(alice, published.resourceId);
    await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders", reason: "team split" },
    });

    const audit = await (
      await cp.call("GET", "/api/audit?action=resource.transfer", { cookie: alice })
    ).json();
    const entry = audit.items.find(
      (row: { subject: string }) => row.subject === `resource:${published.resourceId}`,
    );
    expect(entry).toBeDefined();
    const detail = typeof entry.detail === "string" ? JSON.parse(entry.detail) : entry.detail;
    expect(detail.from).toBe("application_platform");
    expect(detail.to).toBe("application_orders");
    expect(detail.reason).toBe("team split");
  });

  test("the new owner can edit it and the old one cannot", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(alice, published.resourceId);
    await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });

    const after = await resource(published.pavel, published.resourceId);
    // Pavel is in Platform only. He can still *see* it — the catalog is open — but the capability
    // list is what every control in the portal reads, and it no longer offers him an edit.
    expect(after.body.capabilities).not.toContain("update");
    const refused = await cp.call("PATCH", `/api/resources/${published.resourceId}`, {
      cookie: published.pavel,
      headers: { "if-match": after.etag! },
      body: { summary: "not mine any more" },
    });
    expect(refused.status).toBe(403);

    const clara = await cp.login("clara");
    const claraSees = await resource(clara, published.resourceId);
    expect(claraSees.body.capabilities).toContain("update");
    const accepted = await cp.call("PATCH", `/api/resources/${published.resourceId}`, {
      cookie: clara,
      headers: { "if-match": claraSees.etag! },
      body: { summary: "ours now" },
    });
    expect(accepted.status).toBe(200);
  });

  test("the catalog search finds it under its new owner", async () => {
    const alice = await cp.login("alice");
    const published = await publishApi(cp, { backendUrl: backend.url, subscribe: false });
    const before = await resource(alice, published.resourceId);
    await cp.call("POST", `/api/resources/${published.resourceId}/owner`, {
      cookie: alice,
      headers: { "if-match": before.etag! },
      body: { applicationId: "application_orders" },
    });

    // The index carries the owner, so a stale entry would leave the old team's name on the card
    // and hide the API from the new owner's own filter.
    const listed = await (
      await cp.call("GET", "/api/catalog?application=application_orders&limit=100", { cookie: alice })
    ).json();
    expect(
      listed.items.some((item: { id: string }) => item.id === published.resourceId),
    ).toBeTrue();
  });
});

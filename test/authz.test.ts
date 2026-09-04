import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, publishApi, type TestCp } from "./helpers.ts";

/**
 * Reads are not uniformly public: an API and a product are discovery surfaces, but an
 * application and a subscription are a credential relationship, so `can()` applies to listing
 * them too (design section 9).
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

describe("list visibility", () => {
  test("a publisher does not see another team's applications or subscriptions", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });

    const asConsumer = await (
      await cp.call("GET", "/api/subscriptions", { cookie: published.clara })
    ).json();
    expect(asConsumer.items).toHaveLength(1);

    const asPublisher = await (
      await cp.call("GET", "/api/subscriptions", { cookie: published.pavel })
    ).json();
    expect(asPublisher.items).toHaveLength(0);

    const appsAsPublisher = await (
      await cp.call("GET", "/api/applications", { cookie: published.pavel })
    ).json();
    expect(appsAsPublisher.items).toHaveLength(0);
  });

  test("an admin sees everything", async () => {
    await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const alice = await cp.login("alice");
    const subscriptions = await (await cp.call("GET", "/api/subscriptions", { cookie: alice })).json();
    const applications = await (await cp.call("GET", "/api/applications", { cookie: alice })).json();
    expect(subscriptions.items.length).toBeGreaterThan(0);
    expect(applications.items.length).toBeGreaterThan(0);
  });

  test("APIs and products stay visible to everyone: they are the discovery surface", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const resources = await (await cp.call("GET", "/api/resources", { cookie: published.clara })).json();
    const products = await (await cp.call("GET", "/api/products", { cookie: published.clara })).json();
    expect(resources.items.length).toBeGreaterThan(0);
    expect(products.items.length).toBeGreaterThan(0);
  });

  test("another team's subscription cannot be revealed or revoked", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const reveal = await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/reveal`, {
      cookie: published.pavel,
    });
    expect(reveal.status).toBe(403);
    const revoke = await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, {
      cookie: published.pavel,
    });
    expect(revoke.status).toBe(403);
  });
});

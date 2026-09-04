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
  test("a publisher does not see another team's applications", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });

    // An application is one team's own object. Its existence, its name and how many it has are
    // nobody else's business, and unlike a subscription it names no relationship to a publisher.
    const appsAsPublisher = await (
      await cp.call("GET", "/api/applications", { cookie: published.pavel })
    ).json();
    expect(appsAsPublisher.items).toHaveLength(0);
  });

  test("a subscription is visible to both of its sides, and says which side you are", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });

    const asConsumer = await (
      await cp.call("GET", "/api/subscriptions", { cookie: published.clara })
    ).json();
    expect(asConsumer.items).toHaveLength(1);
    expect(asConsumer.items[0].viewerIs).toBe("consumer");

    // Pavel publishes the product this subscribes to, so he sees that somebody is calling it.
    // Without that he could hold the right to revoke and have no way to reach the row.
    const asPublisher = await (
      await cp.call("GET", "/api/subscriptions", { cookie: published.pavel })
    ).json();
    expect(asPublisher.items).toHaveLength(1);
    expect(asPublisher.items[0].viewerIs).toBe("publisher");
    // He may end it and nothing else — rotating somebody else's key is not a publisher's business.
    expect(asPublisher.items[0].capabilities.sort()).toEqual(["delete", "read"]);
    expect(asConsumer.items[0].capabilities).toContain("update");

    // And neither view carries key material, whichever side is asking.
    for (const item of [...asConsumer.items, ...asPublisher.items]) {
      expect(JSON.stringify(item)).not.toContain("primaryKey");
      expect(JSON.stringify(item)).not.toContain("_enc");
    }
  });

  test("the publisher's right follows the product's team, not the person who published it", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });

    // Hand the product to another team. Pavel authored every part of this API and still published
    // it — but he is now on neither side of this subscription, and the rule is about the teams the
    // two objects belong to today rather than about who did the work. This is the case that would
    // otherwise widen quietly into "any publisher sees any subscription".
    cp.app.db.run("UPDATE product SET team_id = 'team_orders' WHERE id = ?", [published.productId]);

    const asPavel = await (
      await cp.call("GET", "/api/subscriptions", { cookie: published.pavel })
    ).json();
    expect(asPavel.items).toHaveLength(0);

    const revoke = await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, {
      cookie: published.pavel,
    });
    expect(revoke.status).toBe(403);
    // Both sides named, because "you cannot do this" without saying which relationship is missing
    // sends somebody to ask the wrong team for access.
    const problem = await revoke.json();
    expect(problem.detail).toContain("neither the team that owns");
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

  test("a publisher may end a subscription to their product and may not touch its keys", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });

    // The asymmetry, in one test. Withdrawing access is the publisher's decision — an abusive or
    // compromised consumer is their problem, and needing an administrator to stop it makes the
    // platform the bottleneck at the moment it should not be. Reaching into the relationship is
    // not: a publisher who could rotate somebody else's key could break their caller silently, and
    // would learn a credential that is not theirs.
    const reveal = await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/reveal`, {
      cookie: published.pavel,
    });
    expect(reveal.status).toBe(403);
    const rotate = await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/rotate`, {
      cookie: published.pavel,
      body: { which: "primary" },
    });
    expect(rotate.status).toBe(403);

    const revoke = await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, {
      cookie: published.pavel,
    });
    expect(revoke.status).toBe(200);
    expect((await revoke.json()).state).toBe("revoked");
  });

  test("the audit says which side ended it", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, {
      cookie: published.pavel,
    });

    const alice = await cp.login("alice");
    const audit = await (await cp.call("GET", "/api/audit", { cookie: alice })).json();
    const row = audit.items.find(
      (r: { action: string; subject: string }) =>
        r.action === "subscription.revoke" &&
        r.subject === `subscription:${published.subscriptionId}`,
    );
    // "Our key stopped working and nobody here did it" is only answerable if the record said so at
    // the time it happened.
    expect(row.actor).toBe("pavel");
    expect(JSON.parse(row.detail).by).toBe("publisher");
  });
});

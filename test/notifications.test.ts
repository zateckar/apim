import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, MINI_SPEC, publishApi, type TestCp } from "./helpers.ts";
import { notificationsFor } from "../control-plane/src/notifications.ts";
import { emitIntegration, runIntegrationEvents } from "../control-plane/src/integrations.ts";

/**
 * The notification feed, which is the email outbox read as a mailbox.
 *
 * The property that matters most is that it invents nothing: every item corresponds to a message
 * the portal composed about a real decision. The second is that it says what the message is *about*
 * — a feed of opaque `sub_…` ids is a feed nobody reads twice.
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function call(method: string, path: string, user: string, body?: unknown, headers: Record<string, string> = {}) {
  return cp.call(method, path, { cookie: await cp.login(user), body, headers });
}

/**
 * Publish an API owned by the platform application and put it in a product of its own, live in
 * DEV — a product with nothing live in it cannot be subscribed to, so the fixture has to go all the
 * way through rather than stopping at a queued operation.
 */
async function publish(name: string) {
  const published = await publishApi(cp, {
    name,
    backendUrl: "http://127.0.0.1:9999",
    // The consumer side is what this file is about, so the fixture must not subscribe for us.
    subscribe: false,
  });
  return { productId: published.productId, resourceId: published.resourceId };
}

/** Clara's application asks the platform application for access, which puts mail on both sides. */
async function requestAccess(productId: string) {
  const response = await call("POST", "/api/subscriptions", "clara", {
    productId,
    applicationId: "application_orders",
    environment: "dev",
    purpose: "Reading the catalogue nightly.",
  });
  expect(response.status).toBe(201);
  return response.json();
}

function feed(applicationId: string) {
  return notificationsFor(cp.app, [applicationId], 50);
}

describe("the notification feed", () => {
  test("is empty for an application nothing has happened to", () => {
    expect(feed("application_platform")).toEqual([]);
  });

  test("an access request puts one item on each side, each saying what it is about", async () => {
    const { productId } = await publish("feed-api");
    await requestAccess(productId);

    const consumer = feed("application_orders");
    const publisher = feed("application_platform");

    expect(consumer.map((item) => item.kind)).toContain("subscription.requested");
    expect(publisher.map((item) => item.kind)).toContain("subscription.approval-needed");

    // Not the raw subscription id: the product and the environment, which is what a reader knows.
    const asked = consumer.find((item) => item.kind === "subscription.requested")!;
    expect(asked.title).toBe("You requested access to feed-api-product in DEV");
    expect(asked.environment).toBe("dev");

    // The publisher's row is the one with something to do, so it is toned as such and points at
    // the queue rather than at a read-only record of the request.
    const waiting = publisher.find((item) => item.kind === "subscription.approval-needed")!;
    expect(waiting.tone).toBe("warn");
    expect(waiting.href).toBe("/application_platform/approvals");
  });

  test("an unsent message says so, and a sent one carries its addressee and body", async () => {
    const { productId } = await publish("sent-api");
    await requestAccess(productId);

    let asked = feed("application_orders").find((i) => i.kind === "subscription.requested")!;
    expect(asked.state).toBe("queued");
    expect(asked.to).toEqual([]);

    runIntegrationEvents(cp.app);

    asked = feed("application_orders").find((i) => i.kind === "subscription.requested")!;
    expect(asked.state).toBe("delivered");
    expect(asked.to.length).toBeGreaterThan(0);
    expect(asked.body).toBe("Reading the catalogue nightly.");
    // The transport is simulated in this phase and every item says so, on every surface.
    expect(asked.simulated).toBe(true);
  });

  test("the answer to a request reaches the side that asked", async () => {
    const { productId } = await publish("decided-api");
    await requestAccess(productId);
    runIntegrationEvents(cp.app);

    const waiting = cp.app.db
      .query<{ id: string }, []>(
        "SELECT id FROM integration_event WHERE integration='skonet' AND state='awaiting-decision'",
      )
      .get()!;
    const decided = await call("POST", `/api/integration-events/${waiting.id}/decision`, "pavel", {
      decision: "approved",
      reason: "They are on the same programme.",
    });
    expect(decided.status).toBe(200);

    const consumer = feed("application_orders");
    const answer = consumer.find((item) => item.kind === "subscription.request.approved")!;
    expect(answer.title).toBe("Your access to decided-api-product in DEV was approved");
    expect(answer.tone).toBe("ok");
  });

  test("a finished deployment names the API and the environment it landed in", async () => {
    // The portal's publish *command*, which is what creates an operation — the REST fixture above
    // writes the same rows without one, and an operation is what this item is about.
    const queued = await call(
      "POST",
      "/api/publish",
      "pavel",
      {
        applicationId: "application_platform",
        name: "deployed-api",
        productName: "deployed-api-product",
        backendUrl: "http://127.0.0.1:9999",
        domain: "IT",
        subdomain: "Solution",
        spec: MINI_SPEC,
      },
      { "idempotency-key": "deployed-api" },
    );
    expect(queued.status).toBe(202);
    const operation = cp.app.db
      .query<{ id: string; application_id: string; resource_id: string }, []>(
        "SELECT id,application_id,resource_id FROM operation ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    // The completion mail is emitted by the operation runner once the gateways have acknowledged.
    // Emitting it directly keeps this test about the feed rather than about the fleet protocol,
    // which `native-workflows.test.ts` already drives end to end.
    emitIntegration(cp.app, operation.application_id, "email", "operation.complete", operation.id, {
      subject: "publish complete in DEV",
    });

    const item = feed("application_platform").find((i) => i.kind === "operation.complete")!;
    expect(item.title).toContain("deployed-api");
    expect(item.title).toContain("DEV");
    expect(item.href).toBe(`/application_platform/apis/${operation.resource_id}`);
  });

  test("newest first, and the limit is the number of items not the number of queries", async () => {
    const { productId } = await publish("many-api");
    await requestAccess(productId);
    runIntegrationEvents(cp.app);
    const items = notificationsFor(cp.app, null, 1);
    expect(items.length).toBe(1);
    const all = notificationsFor(cp.app, null, 50);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.at >= all[i]!.at).toBe(true);
    }
  });

  test("over HTTP a member sees their own applications and cannot ask for somebody else's", async () => {
    const { productId } = await publish("scoped-api");
    await requestAccess(productId);

    const mine = await call("GET", "/api/notifications?applicationId=application_orders", "clara");
    expect(mine.status).toBe(200);
    const body = await mine.json();
    expect(body.transport).toBe("simulated");
    expect(body.items.length).toBeGreaterThan(0);

    const theirs = await call("GET", "/api/notifications?applicationId=application_platform", "clara");
    expect(theirs.status).toBe(403);

    // Without an application, a member gets exactly the applications they are in — the publisher's
    // side of the same request is not among them.
    const everything = await (await call("GET", "/api/notifications", "clara")).json();
    expect(
      everything.items.every((item: { applicationId: string }) => item.applicationId === "application_orders"),
    ).toBe(true);
  });
});


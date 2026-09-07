import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, MINI_SPEC, type TestCp } from "./helpers.ts";

/**
 * Publishing without having decided on a product.
 *
 * Consumers still subscribe to products and never to an API, so a published API has to be in one.
 * What changed is who says which: requiring it stopped every first publish to invent a bundle for
 * a bundle of one, and the name people typed was the API's own.
 */
let cp: TestCp;
beforeEach(() => {
  cp = makeCp();
});
afterEach(() => cp.close());

async function publish(name: string, extra: Record<string, unknown> = {}) {
  const response = await cp.call("POST", "/api/publish", {
    cookie: await cp.login("pavel"),
    body: {
      applicationId: "application_platform",
      name,
      backendUrl: "http://127.0.0.1:9999",
      domain: "IT",
      subdomain: "Solution",
      spec: MINI_SPEC,
      ...extra,
    },
    headers: { "idempotency-key": `${name}-${JSON.stringify(extra)}` },
  });
  return { status: response.status, body: await response.json() };
}

/** The products one resource is sold in, by name. */
function productsOf(resourceId: string): string[] {
  return cp.app.db
    .query<{ name: string }, [string]>(
      `SELECT p.name FROM product p JOIN product_member pm ON pm.product_id = p.id
        WHERE pm.resource_id = ? ORDER BY p.name`,
    )
    .all(resourceId)
    .map((row) => row.name);
}

describe("an API sold on its own", () => {
  test("gets a product named after it, without being asked", async () => {
    const published = await publish("orders");
    expect(published.status).toBe(202);
    expect(productsOf(published.body.resourceId)).toEqual(["orders"]);
    // Owned by the publisher, and active — a product nobody can subscribe to would be no product.
    const product = cp.app.db
      .query<{ application_id: string; lifecycle: string }, [string]>(
        "SELECT application_id,lifecycle FROM product WHERE name='orders'",
      )
      .get("orders")!;
    expect(product.application_id).toBe("application_platform");
    expect(product.lifecycle).toBe("active");
  });

  test("a later version joins the same product rather than making another", async () => {
    const first = await publish("orders");
    const second = await publish("orders", { apiVersion: "v2" });
    expect(second.status).toBe(202);
    // Two contracts for one business capability are one thing to subscribe to. A consumer who had
    // to re-request access at every version increment would rightly ask why.
    expect(productsOf(second.body.resourceId)).toEqual(["orders"]);
    expect(productsOf(first.body.resourceId)).toEqual(["orders"]);
    expect(
      cp.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM product").get()!.n,
    ).toBe(1);
  });

  test("a name another application already took does not fail the publish", async () => {
    cp.app.db.run(
      "INSERT INTO product(id,name,application_id,lifecycle) VALUES ('prod_theirs','orders','application_orders','active')",
    );
    const published = await publish("orders");
    expect(published.status).toBe(202);
    // The slug of the publishing application breaks the tie. Failing here would be a failure on
    // somebody else's naming, which the publisher can neither see nor fix.
    expect(productsOf(published.body.resourceId)).toEqual(["orders-platform"]);
  });

  test("naming a product still works, and still refuses a name that is taken", async () => {
    const named = await publish("orders", { productName: "the-order-suite" });
    expect(named.status).toBe(202);
    expect(productsOf(named.body.resourceId)).toEqual(["the-order-suite"]);

    const clash = await publish("invoices", { productName: "the-order-suite" });
    expect(clash.status).toBe(409);
  });

  test("an invalid product name is still refused rather than quietly replaced", async () => {
    const bad = await publish("orders", { productName: "Not A Product Name" });
    expect(bad.status).toBe(400);
  });

  test("a chosen product must be active and this application's", async () => {
    const first = await publish("orders");
    const mine = cp.app.db
      .query<{ id: string }, []>("SELECT id FROM product WHERE name='orders'")
      .get()!;
    expect(first.status).toBe(202);

    const joined = await publish("invoices", { productId: mine.id });
    expect(joined.status).toBe(202);
    expect(productsOf(joined.body.resourceId)).toEqual(["orders"]);

    cp.app.db.run(
      "INSERT INTO product(id,name,application_id,lifecycle) VALUES ('prod_theirs','theirs','application_orders','active')",
    );
    const foreign = await publish("payments", { productId: "prod_theirs" });
    expect(foreign.status).toBe(400);
  });
});

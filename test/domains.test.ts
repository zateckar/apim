import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, publishApi, type TestCp } from "./helpers.ts";
import {
  DOMAINS,
  domainError,
  domainPrefix,
  publishedPath,
  slugifyPath,
} from "../shared/domains.ts";

/**
 * Every catalog item belongs to a domain, and for anything with an address the domain is the first
 * segment of that address. Two claims are under test here: the taxonomy is closed (a domain and a
 * sub-domain the estate does not have are refused rather than stored), and the classification and
 * the address cannot drift apart — you cannot publish outside your domain, and you cannot
 * reclassify an API out from under a route that is already serving.
 */

let cp: TestCp;
beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function draft(pavel: string, over: Record<string, unknown> = {}) {
  const response = await cp.call("POST", "/api/resources", {
    cookie: pavel,
    body: {
      kind: "rest",
      name: `d-${Math.random().toString(36).slice(2, 8)}`,
      applicationId: "application_platform",
      domain: "IT",
      subdomain: "Solution",
      ...over,
    },
  });
  return { status: response.status, body: await response.json() };
}

describe("the taxonomy itself", () => {
  test("a slash in a sub-domain is a path separator, not a character to escape", () => {
    expect(slugifyPath("Crm/customer data management")).toBe("crm/customer-data-management");
    expect(domainPrefix("Sales", "Crm/leads")).toBe("/sales/crm/leads");
    expect(domainPrefix("Sales", null)).toBe("/sales");
  });

  test("a version is a segment of the path, and only when there is one", () => {
    expect(publishedPath({ domain: "IT", subdomain: "Solution", name: "orders" })).toBe(
      "/it/solution/orders",
    );
    expect(
      publishedPath({ domain: "IT", subdomain: "Solution", name: "orders", apiVersion: "v2" }),
    ).toBe("/it/solution/orders/v2");
  });

  test("the vocabulary is closed at both levels", () => {
    expect(domainError("IT", "Solution")).toBeNull();
    expect(domainError("Nowhere", null)).toContain("Nowhere");
    // A real domain with a sub-domain that belongs to a different one is still wrong.
    expect(domainError("IT", "Merchandise")).toContain("Merchandise");
  });

  test("every sub-domain in the table belongs to exactly one domain path", () => {
    for (const domain of DOMAINS) {
      for (const subdomain of domain.subdomains) {
        expect(domainError(domain.name, subdomain)).toBeNull();
        expect(domainPrefix(domain.name, subdomain)).toStartWith(domainPrefix(domain.name));
      }
    }
  });
});

describe("classification at the API", () => {
  test("an unclassified draft exists, but cannot be given an address", async () => {
    const pavel = await cp.login("pavel");
    const created = await draft(pavel, { domain: undefined, subdomain: undefined });
    expect(created.status).toBe(201);

    const routed = await cp.call("PUT", `/api/resources/${created.body.id}/routes`, {
      cookie: pavel,
      body: { environment: "dev", host: "*", basePath: "/anywhere" },
    });
    expect(routed.status).toBe(400);
    expect((await routed.json()).detail).toContain("assign this API to a domain");
  });

  test("a domain outside the taxonomy is refused at create, with the name that failed", async () => {
    const pavel = await cp.login("pavel");
    const bad = await draft(pavel, { domain: "Procurement", subdomain: null });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("Procurement");

    const orphan = await draft(pavel, { domain: undefined, subdomain: "Solution" });
    expect(orphan.status).toBe(400);
    expect(orphan.body.detail).toContain("nothing to sit under");
  });

  test("an address outside the API's own domain is refused, and says where it should be", async () => {
    const pavel = await cp.login("pavel");
    const created = await draft(pavel);
    const routed = await cp.call("PUT", `/api/resources/${created.body.id}/routes`, {
      cookie: pavel,
      body: { environment: "dev", host: "*", basePath: "/sales/orders" },
    });
    expect(routed.status).toBe(400);
    const detail = (await routed.json()).detail as string;
    expect(detail).toContain("/sales/orders");
    expect(detail).toContain("/it/solution");
  });

  test("the domain is the front of the published path, and the version comes after the name", async () => {
    const api = await publishApi(cp, {
      name: "shipments",
      backendUrl: "http://127.0.0.1:9999",
      domain: "Sales",
      subdomain: "Orders",
    });
    expect(api.basePath).toBe("/sales/orders/shipments");

    const v2 = await (
      await cp.call("POST", `/api/resources/${api.resourceId}/versions`, {
        cookie: api.pavel,
        body: { apiVersion: "v2" },
      })
    ).json();
    // A version stays inside the family's domain: one that dropped it would be the only route in
    // the estate you could not find by browsing the domain it belongs to.
    expect(v2.proposedBasePath).toBe("/sales/orders/shipments/v2");
    expect(v2.domain).toBe("Sales");
    expect(v2.subdomain).toBe("Orders");
  });

  test("a draft can be reclassified; a published API cannot be, and is told where to do it", async () => {
    const pavel = await cp.login("pavel");
    const created = await draft(pavel);
    const etag = (await cp.call("GET", `/api/resources/${created.body.id}`, { cookie: pavel }))
      .headers.get("etag")!;
    const moved = await cp.call("PATCH", `/api/resources/${created.body.id}`, {
      cookie: pavel,
      headers: { "if-match": etag },
      body: { domain: "Sales", subdomain: "Orders" },
    });
    expect(moved.status).toBe(200);
    expect((await moved.json()).domain).toBe("Sales");

    const api = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const current = await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel });
    const refused = await cp.call("PATCH", `/api/resources/${api.resourceId}`, {
      cookie: api.pavel,
      headers: { "if-match": current.headers.get("etag")! },
      body: { domain: "Sales", subdomain: "Orders" },
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).detail).toContain("where the address is set");
  });
});

describe("classification at a Kafka topic", () => {
  const topic = (cookie: string, over: Record<string, unknown> = {}) =>
    cp.call("POST", "/api/kafka/topics", {
      cookie,
      body: {
        applicationId: "application_platform",
        environment: "test",
        name: `t.${Math.random().toString(36).slice(2, 8)}`,
        ...over,
      },
    });

  test("a topic needs a domain too, and it has to be one the estate has", async () => {
    const pavel = await cp.login("pavel");
    const missing = await topic(pavel);
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toContain("every catalog item belongs to a domain");

    const wrong = await topic(pavel, { domain: "Sales", subdomain: "Solution" });
    expect(wrong.status).toBe(400);

    const created = await topic(pavel, { domain: "Sales", subdomain: "Orders" });
    expect(created.status).toBe(202);
  });

  test("a topic's domain is fixed once it exists: its name carries it", async () => {
    const pavel = await cp.login("pavel");
    const created = await (await topic(pavel, { domain: "Sales", subdomain: "Orders" })).json();
    const moved = await cp.call("PATCH", `/api/kafka/topics/${created.id}`, {
      cookie: pavel,
      body: { domain: "IT", subdomain: "Solution" },
    });
    expect(moved.status).toBe(400);
    expect((await moved.json()).detail).toContain("its name carries it");
    const row = cp.app.db
      .query<{ domain: string; subdomain: string }, [string]>(
        "SELECT domain, subdomain FROM kafka_topic WHERE id = ?",
      )
      .get(created.id)!;
    expect(row).toEqual({ domain: "Sales", subdomain: "Orders" });
  });

  test("a topic named by the convention carries its domain, application, name and version", async () => {
    const pavel = await cp.login("pavel");
    const response = await cp.call("POST", "/api/kafka/topics", {
      cookie: pavel,
      body: {
        applicationId: "application_platform",
        displayName: "Order Created",
        version: "v2",
        domain: "Sales",
        subdomain: "Orders",
      },
    });
    expect(response.status).toBe(202);
    expect((await response.json()).name).toBe("sales_orders_platform-apis_order-created_v2");
  });

  test("an unrelated PATCH does not silently drop the classification", async () => {
    const pavel = await cp.login("pavel");
    const created = await (await topic(pavel, { domain: "Sales", subdomain: "Orders" })).json();
    await cp.call("PATCH", `/api/kafka/topics/${created.id}`, {
      cookie: pavel,
      body: { proxyEnabled: true },
    });
    const row = cp.app.db
      .query<{ domain: string }, [string]>("SELECT domain FROM kafka_topic WHERE id = ?")
      .get(created.id)!;
    expect(row.domain).toBe("Sales");
  });
});

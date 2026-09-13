import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeCp,
  makeDp,
  MINI_SPEC,
  publishApi,
  serveCp,
  startBackend,
  type TestCp,
} from "./helpers.ts";

/**
 * G2: a consumer-visible version is a resource, so two versions are two rows, two routes and two
 * release histories inside one product. Lifecycle is a property of the version and is global
 * across the chain (review V1-05).
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

describe("versions are resources", () => {
  test("two versions of one API are live at once, from different revisions", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const v1 = await publishApi(cp, {
        name: "petstore",
        apiVersion: "v1",
        backendUrl: backend.url,
        basePath: "/petstore/v1",
        policy: { rewrite: { stripBasePath: true } },
      });

      const created = await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
        cookie: v1.pavel,
        body: { apiVersion: "v2", copyPolicyFrom: "dev", createRoutes: true },
      });
      expect(created.status).toBe(201);
      const v2 = await created.json();
      expect(v2.name).toBe("petstore");
      expect(v2.apiVersion).toBe("v2");
      expect(v2.proposedBasePath).toBe("/it/solution/petstore/v2");

      // A new contract line: rev 1 of its own, copied from v1's newest revision.
      await cp.call("PUT", `/api/resources/${v2.id}/binding`, {
        cookie: v1.pavel,
        body: { environment: "dev", urls: [backend.url] },
      });
      await cp.call("PUT", `/api/products/${v1.productId}/members`, {
        cookie: v1.pavel,
        body: { resourceIds: [v1.resourceId, v2.id] },
      });
      const release = await cp.call("POST", `/api/resources/${v2.id}/releases`, {
        cookie: v1.pavel,
        body: { revision: 1, environment: "dev" },
      });
      expect(release.status).toBe(202);

      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      try {
        await dp.start();
        const one = await dp.fetchHttp(new Request("http://gw/it/solution/petstore/v1/store/inventory"), "127.0.0.1");
        const two = await dp.fetchHttp(new Request("http://gw/it/solution/petstore/v2/store/inventory"), "127.0.0.1");
        expect(one.status).toBe(200);
        expect(two.status).toBe(200);

        // Longest base path wins, and each version reached its own route.
        expect(backend.requests).toHaveLength(2);
        expect(backend.requests[0]!.path).toBe("/store/inventory");
        expect(dp.client.table!.routes.map((r) => r.basePath).sort()).toEqual([
          "/it/solution/petstore/v1",
          "/it/solution/petstore/v2",
        ]);
        expect(dp.client.table!.routes.map((r) => r.apiVersion).sort()).toEqual(["v1", "v2"]);
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("two versions carry independent policy", async () => {
    const v1 = await publishApi(cp, {
      name: "orders",
      apiVersion: "v1",
      backendUrl: "http://127.0.0.1:9999",
      basePath: "/orders/v1",
      policy: { timeoutMs: 1111 },
    });
    const v2 = await (
      await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
        cookie: v1.pavel,
        body: { apiVersion: "v2" },
      })
    ).json();
    await cp.call("PUT", `/api/resources/${v2.id}/routes`, {
      cookie: v1.pavel,
      body: { environment: "dev", host: "*", basePath: "/it/solution/orders/v2" },
    });
    await cp.call("PUT", `/api/resources/${v2.id}/binding`, {
      cookie: v1.pavel,
      body: { environment: "dev", urls: ["http://127.0.0.1:9999"] },
    });
    await cp.call("PUT", `/api/resources/${v2.id}/policy/units/timeoutMs`, {
      cookie: v1.pavel,
      body: { value: 2222 },
    });
    await cp.call("POST", `/api/resources/${v2.id}/releases`, {
      cookie: v1.pavel,
      body: { revision: 1, environment: "dev" },
    });

    const config = await (
      await cp.call("GET", "/api/environments/dev/config", { cookie: await cp.login("alice") })
    ).json();
    const byVersion = Object.fromEntries(
      config.routes.map((r: { apiVersion: string; policy: { timeoutMs: number } }) => [
        r.apiVersion,
        r.policy.timeoutMs,
      ]),
    );
    expect(byVersion).toEqual({ v1: 1111, v2: 2222 });
  });

  test("createRoutes never copies a base path that is taken, and says which it skipped", async () => {
    const v1 = await publishApi(cp, {
      name: "widgets",
      apiVersion: "v1",
      backendUrl: "http://127.0.0.1:9999",
      basePath: "/widgets/v1",
    });
    // Something else already owns the base path the new version would propose.
    const squatter = await (
      await cp.call("POST", "/api/resources", {
        cookie: v1.pavel,
        body: {
          kind: "rest",
          name: "squatter",
          applicationId: "application_platform",
          domain: "IT",
          subdomain: "Solution",
        },
      })
    ).json();
    await cp.call("PUT", `/api/resources/${squatter.id}/routes`, {
      cookie: v1.pavel,
      body: { environment: "dev", host: "*", basePath: "/it/solution/widgets/v2" },
    });

    const created = await (
      await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
        cookie: v1.pavel,
        body: { apiVersion: "v2", createRoutes: true },
      })
    ).json();
    expect(created.skippedRouteEnvironments).toEqual(["dev"]);
  });

  test("the same version twice is a conflict; the version format is checked", async () => {
    const v1 = await publishApi(cp, {
      name: "dupes",
      apiVersion: "v1",
      backendUrl: "http://127.0.0.1:9999",
    });
    const same = await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
      cookie: v1.pavel,
      body: { apiVersion: "v1" },
    });
    expect(same.status).toBe(409);

    const bad = await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
      cookie: v1.pavel,
      body: { apiVersion: "v 2/../x" },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toContain("apiVersion");
  });

  test("all version-writing endpoints reject non-numeric identifiers", async () => {
    const original = await publishApi(cp, { name: "version-rules", backendUrl: "http://127.0.0.1:9999" });
    const detail = await (await cp.call("GET", `/api/resources/${original.resourceId}`, { cookie: original.pavel })).json();
    for (const apiVersion of ["XXX", "v0", "v01", "V2", "v1.0", "2024-01", `v${"9".repeat(32)}`]) {
      for (const [method, path, body] of [
        ["POST", "/api/resources", { name: "new-version-rules", applicationId: "application_platform", apiVersion }],
        ["POST", "/api/publish", { name: "new-version-rules", applicationId: "application_platform", apiVersion }],
        ["POST", `/api/resources/${original.resourceId}/versions`, { apiVersion }],
        ["PATCH", `/api/resources/${original.resourceId}`, { apiVersion }],
      ] as const) {
        const response = await cp.call(method, path, {
          cookie: original.pavel, body,
          headers: { "if-match": detail.etag, "idempotency-key": crypto.randomUUID() },
        });
        expect(response.status, `${method} ${path} ${apiVersion}`).toBe(400);
        expect((await response.json()).detail).toContain("apiVersion");
      }
    }
    const family = await (await cp.call("GET", "/api/resources?application=application_platform&name=version-rules", { cookie: original.pavel })).json();
    expect(family.items).toHaveLength(1);
  });

  test("the family is listable and the detail view lists its versions", async () => {
    const v1 = await publishApi(cp, {
      name: "family",
      apiVersion: "v1",
      backendUrl: "http://127.0.0.1:9999",
    });
    await cp.call("POST", `/api/resources/${v1.resourceId}/versions`, {
      cookie: v1.pavel,
      body: { apiVersion: "v2" },
    });

    const list = await (
      await cp.call("GET", "/api/resources?application=application_platform&name=family", { cookie: v1.pavel })
    ).json();
    expect(list.items.map((i: { apiVersion: string }) => i.apiVersion)).toEqual(["v1", "v2"]);

    const detail = await (
      await cp.call("GET", `/api/resources/${v1.resourceId}`, { cookie: v1.pavel })
    ).json();
    expect(detail.versions.map((v: { apiVersion: string }) => v.apiVersion)).toEqual(["v1", "v2"]);
    expect(detail.versions.find((v: { current: boolean }) => v.current).apiVersion).toBe("v1");
  });
});

describe("lifecycle (design section 4.2)", () => {
  test("a deprecated version answers with Deprecation and Sunset, including on a rejection", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        name: "sunsetting",
        backendUrl: backend.url,
        basePath: "/sunsetting",
        policy: {
          "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
          rewrite: { stripBasePath: true },
        },
      });
      const current = await (
        await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel })
      ).json();
      const patched = await cp.call("PATCH", `/api/resources/${api.resourceId}`, {
        cookie: api.pavel,
        headers: { "if-match": current.etag },
        body: { lifecycle: "deprecated", sunsetAt: "2027-01-01T00:00:00.000Z" },
      });
      expect(patched.status).toBe(200);

      const dp = makeDp(cpServer.url, cp.token, cp.dir);
      try {
        await dp.start();
        const ok = await dp.fetchHttp(
          new Request("http://gw/it/solution/sunsetting/pet", { headers: { "x-api-key": api.key! } }),
          "127.0.0.1",
        );
        expect(ok.status).toBe(200);
        expect(ok.headers.get("deprecation")).toBe("true");
        expect(ok.headers.get("sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");

        // A consumer being rejected still needs to know the version is going away.
        const denied = await dp.fetchHttp(new Request("http://gw/it/solution/sunsetting/pet"), "127.0.0.1");
        expect(denied.status).toBe(401);
        expect(denied.headers.get("deprecation")).toBe("true");
        expect(denied.headers.get("sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      } finally {
        dp.stop();
      }
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });

  test("a retired product takes no new subscriptions and leaves existing ones working", async () => {
    const api = await publishApi(cp, {
      name: "retiring",
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    expect(api.key).toBeTruthy();

    // Retiring the only API in the product leaves nothing subscribable there.
    const current = await (
      await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel })
    ).json();
    await cp.call("PATCH", `/api/resources/${api.resourceId}`, {
      cookie: api.pavel,
      headers: { "if-match": current.etag },
      body: { lifecycle: "retired" },
    });

    const second = {id: "application_orders"};
    const refused = await cp.call("POST", "/api/subscriptions", {
      cookie: api.clara,
      body: { productId: api.productId, applicationId: second.id, environment: "dev", purpose: "Lifecycle test" },
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).detail).toContain("no active published API in dev");

    // The existing subscription is untouched: that is the half of section 4.2 that matters.
    const config = await (
      await cp.call("GET", "/api/environments/dev/config", { cookie: await cp.login("alice") })
    ).json();
    expect(config.subscriptions).toHaveLength(1);
  });

  test("a product with no published member in this environment refuses a subscription", async () => {
    const pavel = await cp.login("pavel");
    const clara = await cp.login("clara");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "unpublished", applicationId: "application_platform" },
      })
    ).json();
    await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
      cookie: pavel,
      body: { spec: MINI_SPEC },
    });
    const product = await (
      await cp.call("POST", "/api/products", {
        cookie: pavel,
        body: { name: "empty-product", applicationId: "application_platform", resourceIds: [resource.id] },
      })
    ).json();
    const application = {id: "application_orders"};

    const response = await cp.call("POST", "/api/subscriptions", {
      cookie: clara,
      body: { productId: product.id, applicationId: application.id, environment: "dev", purpose: "Lifecycle test" },
    });
    expect(response.status).toBe(409);
  });
});

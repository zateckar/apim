import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_VERSION, type GatewayConfig } from "../shared/config-doc.ts";
import { makeCp, MINI_SPEC, poll, publishApi, type TestCp } from "./helpers.ts";

let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

/** Deviation D11: config comes down on the poll, so a "read the config" helper is a poll. */
async function gatewayConfig(token = cp.token) {
  const { response, config } = await poll(cp, { token });
  return { response, body: config as GatewayConfig | null };
}

describe("publishing an API reaches the config document", () => {
  test("create, import, route, bind, policy, publish, subscribe", async () => {
    const backend = "http://127.0.0.1:9999";
    const published = await publishApi(cp, {
      backendUrl: backend,
      basePath: "/petstore",
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        rewrite: { stripBasePath: true },
        rateLimit: {
          calls: 3,
          periodSec: 60,
          per: "instance",
          by: "subscription",
          scope: "route",
          emitHeaders: true,
        },
      },
    });
    expect(published.release.state).toBe("converged");
    expect(published.release.warnings).toEqual([]);

    const { body } = await gatewayConfig();
    expect(body!.routes).toHaveLength(1);
    const route = body!.routes[0]!;
    // The published address carries the domain the API was classified under, in front of the name.
    expect(route.basePath).toBe("/it/solution/petstore");
    expect(route.rev).toBe(1);
    // v3: a pool. One backend is a pool of one, and `failover` is the rule that reads the same
    // whether the pool has one member or several — so it is what a v2-shaped binding becomes.
    expect(route.backend.pool).toEqual([{ url: backend }]);
    expect(route.backend.rule).toBe("failover");
    expect(route.policy["auth.subscriptionKey"]).toEqual({ in: "header", name: "X-Api-Key" });
    expect(route.policy.rateLimit!.calls).toBe(3);
    expect(route.productIds).toEqual([published.productId]);

    expect(body!.subscriptions).toHaveLength(1);
    expect(body!.subscriptions[0]!.keyHashes[0]).toMatch(/^sha256:/);
    // The plaintext key never appears in the document the data plane receives.
    expect(JSON.stringify(body)).not.toContain(published.key!);
  });

  test("publishing with no authentication unit returns a warning", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999", policy: {} });
    expect(published.release.warnings.join()).toContain("no authentication policy attached");
  });

  test("a release with no route or binding is refused", async () => {
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "bare", applicationId: "application_platform" },
      })
    ).json();
    await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
      cookie: pavel,
      body: { spec: MINI_SPEC },
    });
    const response = await cp.call("POST", `/api/resources/${resource.id}/releases`, {
      cookie: pavel,
      body: { revision: 1, environment: "dev" },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("no route");
  });
});

describe("what is and is not visible to the fleet", () => {
  test("an unreleased revision does not reach the config; releasing it does", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const before = (await gatewayConfig()).body!;
    expect(before.routes[0]!.rev).toBe(1);

    const secondSpec = {
      ...MINI_SPEC,
      paths: { ...MINI_SPEC.paths, "/pet/{petId}": { get: { operationId: "getPet", responses: {} } } },
    };
    const revision = await (
      await cp.call("POST", `/api/resources/${published.resourceId}/revisions`, {
        cookie: published.pavel,
        body: { spec: secondSpec },
      })
    ).json();
    expect(revision.rev).toBe(2);

    const stillRev1 = (await gatewayConfig()).body!;
    expect(stillRev1.routes[0]!.rev).toBe(1);
    expect(stillRev1.digest).toBe(before.digest);

    await cp.call("POST", `/api/resources/${published.resourceId}/releases`, {
      cookie: published.pavel,
      body: { revision: 2, environment: "dev" },
    });
    const after = (await gatewayConfig()).body!;
    expect(after.routes[0]!.rev).toBe(2);
    expect(after.digest).not.toBe(before.digest);
  });

  test("uploading the same document twice does not create a second revision", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const again = await cp.call("POST", `/api/resources/${published.resourceId}/revisions`, {
      cookie: published.pavel,
      body: { spec: MINI_SPEC },
    });
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.unchanged).toBe(true);
    expect(body.rev).toBe(1);
  });

  test("a policy edit changes the config with no release", async () => {
    const published = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    const before = (await gatewayConfig()).body!;

    await cp.call("PUT", `/api/resources/${published.resourceId}/policy/units/timeoutMs`, {
      cookie: published.pavel,
      body: { value: 1234 },
    });
    const after = (await gatewayConfig()).body!;
    expect(after.routes[0]!.policy.timeoutMs).toBe(1234);
    expect(after.digest).not.toBe(before.digest);
    // still revision 1, still the same release
    expect(after.routes[0]!.rev).toBe(1);
  });

  test("withdrawing removes the route; the resource itself survives", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    await cp.call("DELETE", `/api/resources/${published.resourceId}/releases?environment=dev`, {
      cookie: published.pavel,
    });
    expect((await gatewayConfig()).body!.routes).toHaveLength(0);
    const resource = await cp.call("GET", `/api/resources/${published.resourceId}`, {
      cookie: published.pavel,
    });
    expect(resource.status).toBe(200);
  });

  test("deleting the resource removes the route", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const response = await cp.call("DELETE", `/api/resources/${published.resourceId}`, {
      cookie: published.pavel,
    });
    expect(response.status).toBe(204);
    expect((await gatewayConfig()).body!.routes).toHaveLength(0);
  });

  test("a revoked subscription leaves the config document", async () => {
    const published = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    expect((await gatewayConfig()).body!.subscriptions).toHaveLength(1);
    await cp.call("DELETE", `/api/subscriptions/${published.subscriptionId}`, {
      cookie: published.clara,
    });
    expect((await gatewayConfig()).body!.subscriptions).toHaveLength(0);
  });

  test("two APIs cannot claim the same host and base path", async () => {
    const first = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999", basePath: "/shared" });
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: first.pavel,
        body: {
          kind: "rest",
          name: "second",
          applicationId: "application_platform",
          domain: "IT",
          subdomain: "Solution",
        },
      })
    ).json();
    const response = await cp.call("PUT", `/api/resources/${resource.id}/routes`, {
      cookie: first.pavel,
      body: { environment: "dev", host: "*", basePath: first.basePath },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).detail).toContain("already serves");
  });
});

describe("the config poll", () => {
  test("an instance already on the current digest is told so, with no config body", async () => {
    await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const first = await poll(cp);
    expect(first.payload!.unchanged).toBe(false);
    expect(first.config!.digest).toContain("sha256:");

    // Deviation D11: "nothing changed" is an explicit field, not a reused 304 on a POST.
    const second = await poll(cp, { activeDigest: first.config!.digest });
    expect(second.response.status).toBe(200);
    expect(second.payload!.unchanged).toBe(true);
    expect(second.payload!.config).toBeUndefined();
    expect(second.payload!.digest).toBe(first.config!.digest);

    const health = await (
      await cp.call("GET", "/api/targets/dev/health", { cookie: await cp.login("alice") })
    ).json();
    expect(health.instances[0].configDigest).toBe(first.config!.digest);
    expect(health.inSync).toBe(true);
  });

  test("the digest is over the document that was served", async () => {
    await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const { payload, config } = await poll(cp);
    expect(payload!.digest).toBe(config!.digest);
    expect(config!.configVersion).toBe(CONFIG_VERSION);
    // Design section 5.1's always-block ceilings travel with the config, not per gateway.
    expect(config!.limits.xml.maxPrefixBytes).toBe(8192);
  });

  test("a wire version this control plane does not speak is refused", async () => {
    const response = await cp.call("POST", "/api/gateway/poll", {
      headers: { authorization: `Bearer ${cp.token}` },
      body: { wireVersion: 99, instance: { runId: "run_x" }, telemetry: { windows: [] } },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("wireVersion 99");
  });

  test("a missing, unknown or revoked instance token is rejected", async () => {
    expect((await cp.call("POST", "/api/gateway/poll", { body: {} })).status).toBe(401);
    expect((await poll(cp, { token: "gwt_nonsense" })).response.status).toBe(401);

    cp.app.db.run("UPDATE gateway_instance SET revoked_at = ?", [new Date().toISOString()]);
    expect((await poll(cp)).response.status).toBe(401);
  });
});

describe("authorization, CSRF and concurrency", () => {
  test("a member of another application cannot edit or publish", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const clara = published.clara;

    const patch = await cp.call("PATCH", `/api/resources/${published.resourceId}`, {
      cookie: clara,
      headers: { "if-match": "*" },
      body: { name: "hijacked" },
    });
    expect(patch.status).toBe(403);

    const release = await cp.call("POST", `/api/resources/${published.resourceId}/releases`, {
      cookie: clara,
      body: { revision: 1, environment: "dev" },
    });
    expect(release.status).toBe(403);

    const policy = await cp.call(
      "PUT",
      `/api/resources/${published.resourceId}/policy/units/timeoutMs`,
      { cookie: clara, body: { value: 1000 } },
    );
    expect(policy.status).toBe(403);
  });

  test("an admin can act on any application's resource", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const alice = await cp.login("alice");
    const response = await cp.call(
      "PUT",
      `/api/resources/${published.resourceId}/policy/units/timeoutMs`,
      { cookie: alice, body: { value: 2000 } },
    );
    expect(response.status).toBe(200);
  });

  test("a cookie-authenticated write without an Origin header is refused", async () => {
    const pavel = await cp.login("pavel");
    const response = await cp.call("POST", "/api/resources", {
      cookie: pavel,
      origin: null,
      body: { kind: "rest", name: "no-origin", applicationId: "application_platform" },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).detail).toContain("Origin");
  });

  test("a foreign Origin is refused", async () => {
    const pavel = await cp.login("pavel");
    const response = await cp.call("POST", "/api/resources", {
      cookie: pavel,
      origin: "https://evil.example",
      body: { kind: "rest", name: "foreign", applicationId: "application_platform" },
    });
    expect(response.status).toBe(403);
  });

  test("PATCH requires If-Match and rejects a stale one", async () => {
    const pavel = await cp.login("pavel");
    const created = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "etagged", applicationId: "application_platform" },
      })
    ).json();

    const missing = await cp.call("PATCH", `/api/resources/${created.id}`, {
      cookie: pavel,
      body: { name: "renamed" },
    });
    expect(missing.status).toBe(428);

    const stale = await cp.call("PATCH", `/api/resources/${created.id}`, {
      cookie: pavel,
      headers: { "if-match": '"0000"' },
      body: { name: "renamed" },
    });
    expect(stale.status).toBe(412);

    const ok = await cp.call("PATCH", `/api/resources/${created.id}`, {
      cookie: pavel,
      headers: { "if-match": created.etag },
      body: { name: "renamed" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("renamed");
  });

  test("the audit log is append-only and records every mutation", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const alice = await cp.login("alice");
    const audit = await (await cp.call("GET", "/api/audit?limit=100", { cookie: alice })).json();
    const actions = audit.items.map((row: { action: string }) => row.action);
    expect(actions).toContain("resource.create");
    expect(actions).toContain("revision.create");
    expect(actions).toContain("release.request");
    expect(actions).toContain("reconcile.apply");
    expect(actions).toContain("subscription.create");

    expect(() => cp.app.db.run("UPDATE audit SET actor = 'nobody'")).toThrow(/append-only/);
    expect(() => cp.app.db.run("DELETE FROM audit")).toThrow(/append-only/);
    expect(published.resourceId).toBeTruthy();
  });

  test("the audit log is admin-only", async () => {
    const pavel = await cp.login("pavel");
    expect((await cp.call("GET", "/api/audit", { cookie: pavel })).status).toBe(403);
  });
});

describe("input handling", () => {
  test("a spec URL outside the egress allowlist is refused and never fetched", async () => {
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "ssrf", applicationId: "application_platform" },
      })
    ).json();
    const response = await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
      cookie: pavel,
      body: { specUrl: "http://169.254.169.254/latest/meta-data" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("egress allowlist");
  });

  test("a backend URL outside the egress allowlist is refused", async () => {
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "badbackend", applicationId: "application_platform" },
      })
    ).json();
    const response = await cp.call("PUT", `/api/resources/${resource.id}/binding`, {
      cookie: pavel,
      body: { environment: "dev", urls: ["https://evil.example/api"] },
    });
    expect(response.status).toBe(400);
  });

  test("a policy unit that fails validation is refused with the reason", async () => {
    const published = await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const response = await cp.call(
      "PUT",
      `/api/resources/${published.resourceId}/policy/units/preconditions`,
      {
        cookie: published.pavel,
        body: { value: [{ requireHeader: { name: "X-A", pattern: "(a+)+$" }, deny: { status: 403, reason: "no" } }] },
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("catastrophic backtracking");
  });

  test("detaching auth while a rate limit is attached is refused", async () => {
    const published = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        rateLimit: { calls: 2, periodSec: 60, per: "instance", by: "subscription", scope: "route" },
      },
    });
    const response = await cp.call(
      "DELETE",
      `/api/resources/${published.resourceId}/policy/units/${encodeURIComponent("auth.subscriptionKey")}`,
      { cookie: published.pavel },
    );
    expect(response.status).toBe(409);
    const detail = (await response.json()).detail;
    expect(detail).toContain("detaching auth.subscriptionKey would leave an invalid document");
    // v3 names the global tier too: the unit may be satisfied from the environment's policy.
    expect(detail).toContain("only auth.subscriptionKey resolves to one");
  });

  test("a subscription key round-trips through reveal and rotate", async () => {
    const published = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    const revealed = await (
      await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/reveal`, {
        cookie: published.clara,
      })
    ).json();
    expect(revealed.primaryKey).toBe(published.key);

    const rotated = await (
      await cp.call("POST", `/api/subscriptions/${published.subscriptionId}/rotate`, {
        cookie: published.clara,
        body: { which: "primary" },
      })
    ).json();
    expect(rotated.key).not.toBe(published.key);

    const config = (await gatewayConfig()).body!;
    const { hashSubscriptionKey } = await import("../shared/keys.ts");
    expect(config.subscriptions[0]!.keyHashes).toContain(hashSubscriptionKey(rotated.key));
    expect(config.subscriptions[0]!.keyHashes).not.toContain(hashSubscriptionKey(published.key!));
  });

  test("only known resource kinds are accepted", async () => {
    const pavel = await cp.login("pavel");
    const response = await cp.call("POST", "/api/resources", {
      cookie: pavel,
      body: { kind: "graphql", name: "later", applicationId: "application_platform" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("not implemented in the MVP");
  });

  test("the spec export renders OpenAPI 3.1 and the original verbatim", async () => {
    const pavel = await cp.login("pavel");
    const resource = await (
      await cp.call("POST", "/api/resources", {
        cookie: pavel,
        body: { kind: "rest", name: "exportable", applicationId: "application_platform" },
      })
    ).json();
    const original = JSON.stringify(MINI_SPEC, null, 2);
    const revision = await (
      await cp.call("POST", `/api/resources/${resource.id}/revisions`, {
        cookie: pavel,
        body: { spec: original },
      })
    ).json();

    const exported = await (
      await cp.call("GET", `/api/revisions/${revision.id}/spec?format=openapi-3.1`, { cookie: pavel })
    ).json();
    expect(exported.openapi).toBe("3.1.0");
    expect(Object.keys(exported.paths)).toContain("/store/inventory");

    const verbatim = await cp.call("GET", `/api/revisions/${revision.id}/spec?format=original`, {
      cookie: pavel,
    });
    expect(await verbatim.text()).toBe(original);
    expect(verbatim.headers.get("x-original-format")).toBe("swagger-2.0");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, makeDp, poll, publishApi, serveCp, startBackend, type TestCp } from "./helpers.ts";

/**
 * G3. Design section 8.5 keys the poll on `gateway_instance`, so "more gateways" is more rows in
 * that table plus one process each. An instance token is a credential: minted admin-only, shown
 * once, revocable, and capped per target.
 */
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

describe("instance tokens", () => {
  test("minting is admin-only and the token is shown exactly once", async () => {
    const pavel = await cp.login("pavel");
    const refused = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: pavel,
      body: { name: "dev-9" },
    });
    expect(refused.status).toBe(403);

    const alice = await cp.login("alice");
    const minted = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: alice,
      body: { name: "dev-9" },
    });
    expect(minted.status).toBe(201);
    const body = await minted.json();
    expect(body.token).toMatch(/^gwt_/);
    expect(minted.headers.get("cache-control")).toBe("no-store");

    // Only the hash is stored, so the token cannot be recovered from the list.
    const listed = await (
      await cp.call("GET", "/api/targets/dev/instances", { cookie: alice })
    ).json();
    const found = listed.items.find((i: { id: string }) => i.id === body.id);
    expect(found.name).toBe("dev-9");
    expect(JSON.stringify(found)).not.toContain(body.token);

    // And it works.
    expect((await poll(cp, { token: body.token })).response.status).toBe(200);
  });

  test("names are validated, duplicates rejected, and the per-target cap enforced", async () => {
    const alice = await cp.login("alice");
    const bad = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: alice,
      body: { name: "Dev 9!" },
    });
    expect(bad.status).toBe(400);

    await cp.call("POST", "/api/targets/dev/instances", { cookie: alice, body: { name: "dev-9" } });
    const duplicate = await cp.call("POST", "/api/targets/dev/instances", {
      cookie: alice,
      body: { name: "dev-9" },
    });
    expect(duplicate.status).toBe(409);

    const capped = makeCp({ maxInstancesPerTarget: 2 });
    try {
      const admin = await capped.login("alice");
      // The seed already created dev-1 and dev-2.
      const over = await capped.call("POST", "/api/targets/dev/instances", {
        cookie: admin,
        body: { name: "dev-3" },
      });
      expect(over.status).toBe(409);
      expect((await over.json()).detail).toContain("MAX_INSTANCES_PER_TARGET");
    } finally {
      capped.close();
    }
  });

  test("revoking one gateway stops only that one", async () => {
    const alice = await cp.login("alice");
    const second = await (
      await cp.call("POST", "/api/targets/dev/instances", { cookie: alice, body: { name: "dev-9" } })
    ).json();

    expect((await poll(cp, { token: cp.token })).response.status).toBe(200);
    expect((await poll(cp, { token: second.token })).response.status).toBe(200);

    const revoked = await cp.call("DELETE", `/api/instances/${second.id}`, { cookie: alice });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).effective).toContain("next poll");

    expect((await poll(cp, { token: second.token })).response.status).toBe(401);
    expect((await poll(cp, { token: cp.token })).response.status).toBe(200);
  });

  test("a revoked gateway fails closed while the rest of the fleet is untouched", async () => {
    const backend = startBackend();
    const cpServer = serveCp(cp);
    try {
      const api = await publishApi(cp, {
        backendUrl: backend.url,
        basePath: "/fleet",
        policy: { rewrite: { stripBasePath: true } },
      });
      const alice = await cp.login("alice");
      const second = await (
        await cp.call("POST", "/api/targets/dev/instances", {
          cookie: alice,
          body: { name: "dev-9" },
        })
      ).json();

      const one = makeDp(cpServer.url, cp.token, cp.dir, { name: "one" });
      const two = makeDp(cpServer.url, second.token, cp.dir, { name: "two" });
      try {
        await one.start();
        await two.start();
        expect((await one.fetchHttp(new Request("http://gw/it/solution/fleet/pet"), "127.0.0.1")).status).toBe(200);
        expect((await two.fetchHttp(new Request("http://gw/it/solution/fleet/pet"), "127.0.0.1")).status).toBe(200);

        await cp.call("DELETE", `/api/instances/${second.id}`, { cookie: alice });
        await two.client.pollOnce();
        await one.client.pollOnce();

        // Design section 8.5: revocation always fails closed; staleness never does.
        const stopped = await two.fetchHttp(new Request("http://gw/it/solution/fleet/pet"), "127.0.0.1");
        expect(stopped.status).toBe(503);
        expect((await stopped.json()).detail).toContain("revoked");
        expect(two.health().decommissioned).toBe(true);

        expect((await one.fetchHttp(new Request("http://gw/it/solution/fleet/pet"), "127.0.0.1")).status).toBe(200);
      } finally {
        one.stop();
        two.stop();
      }
      expect(api.resourceId).toBeTruthy();
    } finally {
      cpServer.stop();
      backend.stop();
    }
  });
});

describe("the fleet view", () => {
  test("environments report their targets and live instance counts", async () => {
    const alice = await cp.login("alice");
    const body = await (await cp.call("GET", "/api/environments", { cookie: alice })).json();
    expect(body.chain).toEqual(["dev", "test", "prod"]);
    const byEnv = Object.fromEntries(
      body.items.map((i: { environment: string; instances: number }) => [i.environment, i]),
    );
    // The seed mints two gateways in dev and one each in test and prod.
    expect(byEnv.dev.instances).toBe(2);
    expect(byEnv.test.instances).toBe(1);
    expect(byEnv.prod.instances).toBe(1);
    expect(byEnv.dev.liveInstances).toBe(0);
    expect(byEnv.dev.maxInstances).toBe(16);
  });

  test("in-sync becomes true only once every live instance reports the current digest", async () => {
    await publishApi(cp, { backendUrl: "http://127.0.0.1:9999" });
    const alice = await cp.login("alice");
    const first = await poll(cp);

    // The digest was delivered, but the instance has not yet said it activated it.
    let health = await (await cp.call("GET", "/api/targets/dev/health", { cookie: alice })).json();
    expect(health.inSync).toBe(false);

    // The lag is exactly one poll (design section 8.7, v1 finding I3).
    await poll(cp, { activeDigest: first.config!.digest });
    health = await (await cp.call("GET", "/api/targets/dev/health", { cookie: alice })).json();
    expect(health.inSync).toBe(true);
    expect(health.liveInstances).toBe(2);
    expect(health.routes).toBe(1);
  });

  test("the rendered config is admin-only, because it is the estate in one document", async () => {
    const api = await publishApi(cp, {
      backendUrl: "http://127.0.0.1:9999",
      policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" } },
    });
    const asPavel = await cp.call("GET", "/api/environments/dev/config", { cookie: api.pavel });
    expect(asPavel.status).toBe(403);

    const asAdmin = await cp.call("GET", "/api/environments/dev/config", {
      cookie: await cp.login("alice"),
    });
    expect(asAdmin.status).toBe(200);
    const config = await asAdmin.json();
    // Hashes, never keys: plaintext does not leave the control plane even for an admin read.
    expect(JSON.stringify(config)).not.toContain(api.key!);
    expect(config.subscriptions[0].keyHashes[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the poll records the instance's process report for the fleet view", async () => {
    await poll(cp, { requestsTotal: 42 });
    const alice = await cp.login("alice");
    const instances = await (
      await cp.call("GET", "/api/telemetry/instances?environment=dev", { cookie: alice })
    ).json();
    const reporting = instances.items.find((i: { process: unknown }) => i.process !== null);
    expect(reporting.process.requestsTotal).toBe(42);
    expect(reporting.process.droppedSeries).toBe(0);
    expect(reporting.process.runId).toBe("run_test");
  });
});

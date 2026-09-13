import { afterEach, describe, expect, test } from "bun:test";
import { makeCp, type TestCp, MINI_SPEC } from "./helpers.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { runOperations } from "../control-plane/src/operations.ts";
import { hashToken } from "../control-plane/src/crypto.ts";
import { CONFIG_VERSION } from "../shared/config-doc.ts";
let cp: TestCp;
afterEach(() => cp?.close());
function setup() {
  cp = makeCp();
  return cp;
}
async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return cp.call(method, path, { cookie: await cp.login(user), body, headers });
}
async function publish(name = "sample") {
  const response = await call(
    "POST",
    "/api/publish",
    "pavel",
    {
      applicationId: "application_platform",
      name,
      productName: `${name}-product`,
      backendUrl: "http://127.0.0.1:9999",
      // Every published thing is classified, and the domain is the first segment of its path, so
      // this API answers on `/it/<name>` rather than `/<name>`.
      domain: "IT",
      subdomain: "Solution",
      spec: MINI_SPEC,
    },
    { "idempotency-key": name },
  );
  expect(response.status).toBe(202);
  return response.json();
}
/** Acknowledge the current configuration on every gateway in `environment`, or only on `only`. */
async function ack(environment: string, only?: string[]) {
  const instances = cp.app.db
    .query<{ id: string; name: string }, [string]>(
      "SELECT gi.id,gi.name FROM gateway_instance gi JOIN target t ON t.id=gi.target_id WHERE t.environment=?",
    )
    .all(environment)
    .filter((instance) => !only || only.includes(instance.name));
  const digest = buildConfig(
    cp.app.db,
    cp.app.kek,
    environment,
    cp.app.config,
  ).digest;
  for (const instance of instances) {
    const token = `test-${instance.id}`;
    cp.app.db.run("UPDATE gateway_instance SET token_hash=? WHERE id=?", [
      hashToken(token),
      instance.id,
    ]);
    const response = await cp.call("POST", "/api/gateway/poll", {
      headers: { authorization: `Bearer ${token}` },
      body: {
        wireVersion: CONFIG_VERSION,
        instance: {
          name: instance.name,
          runId: "native-test",
          startedAt: new Date().toISOString(),
          activeDigest: digest,
          requestsTotal: 0,
          process: {},
        },
      },
    });
    expect(response.status).toBe(200);
  }
  runOperations(cp.app);
}
function stateOf(operationId: string): string {
  return cp.app.db
    .query<{ state: string }, [string]>("SELECT state FROM operation WHERE id=?")
    .get(operationId)!.state;
}
function releasesIn(resourceId: string, environment: string) {
  return cp.app.db
    .query<{ revision_id: string; state: string }, string[]>(
      "SELECT revision_id,state FROM release WHERE resource_id=? AND environment=?",
    )
    .all(resourceId, environment);
}
describe("native application workflows", () => {
  test("rejected subscriptions can be requested again without losing decision history", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const product = cp.app.db
      .query<{ product_id: string }, [string]>(
        "SELECT product_id FROM product_member WHERE resource_id=?",
      )
      .get(op.resourceId)!;
    const body = {
      applicationId: "application_orders",
      productId: product.product_id,
      environment: "dev",
      purpose: "Initial request",
    };
    const first = await (
      await call("POST", "/api/subscriptions", "clara", body)
    ).json();
    runDueJobs(cp.app);
    const event = cp.app.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM integration_event WHERE subject=? AND integration='skonet'",
      )
      .get(first.id)!;
    const pendingEvents = await (await call("GET", "/api/integration-events?applicationId=application_platform", "pavel")).json();
    expect(pendingEvents.items.find((item: any) => item.id === event.id).approval).toEqual({
      environment: "dev", name: "sample-product", state: "pending",
    });
    expect(
      (
        await call(
          "POST",
          `/api/integration-events/${event.id}/decision`,
          "pavel",
          { decision: "rejected", reason: "Clarify the purpose" },
        )
      ).status,
    ).toBe(200);
    const second = await call("POST", "/api/subscriptions", "clara", {
      ...body,
      purpose: "Revised order processing request",
    });
    expect(second.status).toBe(201);
    expect((await second.json()).id).not.toBe(first.id);
    const resolvedEvents = await (await call("GET", "/api/integration-events?applicationId=application_platform", "pavel")).json();
    expect(resolvedEvents.items.find((item: any) => item.id === event.id).approval.state).toBe("rejected");
    expect(
      cp.app.db
        .query<{ state: string }, [string]>(
          "SELECT state FROM subscription WHERE id=?",
        )
        .get(first.id)?.state,
    ).toBe("rejected");
    expect(
      (await call("POST", "/api/subscriptions", "clara", body)).status,
    ).toBe(409);
  });
  test("product creation rolls back when a member belongs to another application", async () => {
    setup();
    const op = await publish();
    const response = await call("POST", "/api/products", "alice", {
      applicationId: "application_orders",
      name: "invalid-product",
      resourceIds: [op.resourceId],
    });
    expect(response.status).toBe(409);
    expect(
      cp.app.db
        .query("SELECT id FROM product WHERE name='invalid-product'")
        .get(),
    ).toBeNull();
  });
  test("schema has one application ownership model and rejects unrelated callers", async () => {
    setup();
    expect(
      cp.app.db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='team'",
        )
        .get(),
    ).toBeNull();
    const response = await call(
      "POST",
      "/api/publish",
      "clara",
      { applicationId: "application_platform" },
      { "idempotency-key": "denied" },
    );
    expect(response.status).toBe(403);
    const apps = await (await call("GET", "/api/applications", "pavel")).json();
    expect(apps.items.filter((a: any) => a.mine).map((a: any) => a.id)).toEqual(
      ["application_platform"],
    );
  });
  test("publish is atomic, idempotent and completes only after both gateways acknowledge", async () => {
    setup();
    const op = await publish();
    expect((await publish()).id).toBe(op.id);
    runDueJobs(cp.app);
    let row = await (
      await call("GET", `/api/operations/${op.id}`, "pavel")
    ).json();
    expect(row.state).toBe("waiting-for-gateways");
    expect(
      cp.app.db
        .query("SELECT * FROM product_member WHERE resource_id=?")
        .all(op.resourceId),
    ).toHaveLength(1);
    await ack("dev");
    row = await (await call("GET", `/api/operations/${op.id}`, "pavel")).json();
    expect(row.state).toBe("complete");
    const bad = await call(
      "POST",
      "/api/publish",
      "pavel",
      {
        applicationId: "application_platform",
        name: "bad-api",
        productName: "bad-prod",
        spec: MINI_SPEC,
        backendUrl: "http://127.0.0.1:9999",
        policy: { madeUp: true },
      },
      { "idempotency-key": "invalid" },
    );
    expect(bad.status).toBe(400);
    expect(
      cp.app.db.query("SELECT id FROM resource WHERE name='bad-api'").get(),
    ).toBeNull();
  });
  test("promotion requires no technical plan and retains target backend on later promotion", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const response = await call(
      "POST",
      `/api/resources/${op.resourceId}/promote`,
      "pavel",
      { environment: "test", backendUrl: "http://127.0.0.1:9998" },
      { "idempotency-key": "to-test" },
    );
    expect(response.status).toBe(202);
    const promote = await response.json();
    runDueJobs(cp.app);
    await ack("test");
    expect(
      (
        await (
          await call("GET", `/api/operations/${promote.id}`, "pavel")
        ).json()
      ).state,
    ).toBe("complete");
    const again = await call(
      "POST",
      `/api/resources/${op.resourceId}/promote`,
      "pavel",
      { environment: "test" },
      { "idempotency-key": "to-test-again" },
    );
    expect(again.status).toBe(202);
    runDueJobs(cp.app);
    const editor = await (
      await call(
        "GET",
        `/api/resources/${op.resourceId}/editor?environment=test`,
        "pavel",
      )
    ).json();
    expect(editor.settings.backend.pool[0].url).toBe("http://127.0.0.1:9998");
  });
  test("cross-application approvals gate credentials; duplicates are idempotent; revocation converges", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const product = cp.app.db
      .query<{ product_id: string }, [string]>(
        "SELECT product_id FROM product_member WHERE resource_id=?",
      )
      .get(op.resourceId)!;
    const response = await call("POST", "/api/subscriptions", "clara", {
      applicationId: "application_orders",
      productId: product.product_id,
      environment: "dev",
      purpose: "Order processing",
    });
    expect(response.status).toBe(201);
    const sub = await response.json();
    expect(sub.state).toBe("pending");
    expect(sub.primaryKey).toBeUndefined();
    expect(
      buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config)
        .subscriptions,
    ).toHaveLength(0);
    expect(
      (await call("POST", `/api/subscriptions/${sub.id}/reveal`, "clara", {}))
        .status,
    ).toBe(409);
    runDueJobs(cp.app);
    const e = cp.app.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM integration_event WHERE integration='skonet' AND subject=?",
      )
      .get(sub.id)!;
    expect(
      (
        await call(
          "POST",
          `/api/integration-events/${e.id}/decision`,
          "clara",
          { decision: "approved" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          `/api/integration-events/${e.id}/decision`,
          "pavel",
          { decision: "approved" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/api/integration-events/${e.id}/decision`,
          "pavel",
          { decision: "approved" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/api/integration-events/${e.id}/decision`,
          "pavel",
          { decision: "rejected" },
        )
      ).status,
    ).toBe(409);
    await ack("dev");
    expect(
      (await call("POST", `/api/subscriptions/${sub.id}/reveal`, "clara", {}))
        .status,
    ).toBe(200);
    expect(
      (await call("POST", `/api/subscriptions/${sub.id}/reveal`, "pavel", {}))
        .status,
    ).toBe(403);
    const revoke = await (
      await call("DELETE", `/api/subscriptions/${sub.id}`, "pavel")
    ).json();
    expect(revoke.state).toBe("revoking");
    expect(
      buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config)
        .subscriptions,
    ).toHaveLength(0);
    await ack("dev");
    expect(
      cp.app.db
        .query<{ state: string }, [string]>(
          "SELECT state FROM subscription WHERE id=?",
        )
        .get(sub.id)!.state,
    ).toBe("revoked");
  });
  test("own-product subscription is automatically approved but waits for activation", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const product = cp.app.db
      .query<{ product_id: string }, [string]>(
        "SELECT product_id FROM product_member WHERE resource_id=?",
      )
      .get(op.resourceId)!;
    const sub = await (
      await call("POST", "/api/subscriptions", "pavel", {
        applicationId: "application_platform",
        productId: product.product_id,
        environment: "dev",
        purpose: "Own service testing",
      })
    ).json();
    expect(sub.state).toBe("activating");
    await ack("dev");
    expect(
      (await call("POST", `/api/subscriptions/${sub.id}/reveal`, "pavel", {}))
        .status,
    ).toBe(200);
  });
  test("Kafka subscription and playground exercise persisted mock ACLs and messages", async () => {
    setup();
    const response = await call("POST", "/api/kafka/topics", "pavel", {
      applicationId: "application_platform",
      environment: "dev",
      name: "orders.events",
      domain: "Sales",
      subdomain: "Orders",
    });
    expect(response.status).toBe(202);
    const topic = await response.json();
    runDueJobs(cp.app);
    const sub = await (
      await call("POST", `/api/kafka/topics/${topic.id}/subscribe`, "pavel", {
        applicationId: "application_platform",
        purpose: "Test events",
      })
    ).json();
    expect(sub.state).toBe("activating");
    runDueJobs(cp.app);
    const result = await (
      await call("POST", `/api/kafka/topics/${topic.id}/playground`, "pavel", {
        applicationId: "application_platform",
        action: "produce",
        value: "hello",
      })
    ).json();
    expect(result.simulated).toBe(true);
    expect(result.items[0].value).toBe("hello");
  });
  test("all mocked integrations are reachable and failures retry without disappearing", async () => {
    setup();
    for (const integration of ["leanix", "ldapws", "fixme"]) {
      const response = await call(
        "POST",
        `/api/applications/application_platform/integrations/${integration}`,
        "pavel",
        { environment: "dev", simulateFailures: 1 },
      );
      expect(response.status).toBe(202);
      const event = await response.json();
      runDueJobs(cp.app);
      expect(
        cp.app.db
          .query<{ state: string }, [string]>(
            "SELECT state FROM integration_event WHERE id=?",
          )
          .get(event.id)!.state,
      ).toBe("retrying");
      cp.app.db.run(
        "UPDATE integration_event SET next_attempt_at=NULL WHERE id=?",
        [event.id],
      );
      runDueJobs(cp.app);
      expect(
        cp.app.db
          .query<{ state: string }, [string]>(
            "SELECT state FROM integration_event WHERE id=?",
          )
          .get(event.id)!.state,
      ).toBe(integration === "fixme" ? "completed" : "delivered");
    }
  });
  test("temporary deployment failures continue past the old three-attempt limit", async () => {
    setup();
    const op = await publish();
    cp.app.db.run("UPDATE target SET paused=1 WHERE environment='dev'");
    for (let i = 0; i < 6; i++) {
      runDueJobs(cp.app);
      cp.app.db.run("UPDATE operation SET next_attempt_at=NULL WHERE id=?", [
        op.id,
      ]);
    }
    expect(
      cp.app.db
        .query<{ state: string }, [string]>(
          "SELECT state FROM operation WHERE id=?",
        )
        .get(op.id)!.state,
    ).toBe("blocked");
    cp.app.db.run("UPDATE target SET paused=0 WHERE environment='dev'");
    runDueJobs(cp.app);
    await ack("dev");
    expect(
      cp.app.db
        .query<{ state: string }, [string]>(
          "SELECT state FROM operation WHERE id=?",
        )
        .get(op.id)!.state,
    ).toBe("complete");
  });

  test("a gateway that was offline for the change catches up by itself, and is not counted twice", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    // dev-2 is down. Reporting complete here would be a claim about a gateway nobody has heard
    // from — the acceptance criterion is that it stays visibly pending instead.
    await ack("dev", ["dev-1"]);
    expect(stateOf(op.id)).toBe("waiting-for-gateways");
    // Nothing needs to be resubmitted, and no reconciliation is invoked by hand: the returning
    // instance polls, and the same pass that noticed it was missing notices it is back.
    await ack("dev", ["dev-2"]);
    expect(stateOf(op.id)).toBe("complete");
    expect(releasesIn(op.resourceId, "dev")).toHaveLength(1);
  });

  test("a replica that is gone rather than restarting stops holding the environment open", async () => {
    // The other side of the test above, and the one that was missing. A container replaced during a
    // redeploy leaves `revoked_at IS NULL` and a `last_seen_at` that never advances again. Every
    // transition that runs through `fleetApplied` — an operation to `complete`, a subscription to
    // `active`, a withdrawn one to `revoked` — then waited on it with no timeout and nothing on any
    // screen naming the replica being waited for.
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev", ["dev-1"]);
    // dev-2 has polled at some point, so it is a replica that went away rather than one that has
    // never appeared — and while it is merely offline it still counts, because a rolling restart
    // passes through here.
    cp.app.db.run(
      "UPDATE gateway_instance SET last_seen_at=? WHERE name='dev-2'",
      [new Date(Date.now() - 60_000).toISOString()],
    );
    runDueJobs(cp.app);
    expect(stateOf(op.id)).toBe("waiting-for-gateways");

    // Past the abandonment threshold it is gone, and the fleet converges on what is actually
    // running. `INSTANCE_ABANDONED_AFTER_SEC` defaults to 900.
    cp.app.db.run(
      "UPDATE gateway_instance SET last_seen_at=? WHERE name='dev-2'",
      [new Date(Date.now() - 3_600_000).toISOString()],
    );
    runDueJobs(cp.app);
    expect(stateOf(op.id)).toBe("complete");
    expect(releasesIn(op.resourceId, "dev")).toHaveLength(1);
  });

  test("an environment whose every replica is gone has not converged, it is down", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    cp.app.db.run("UPDATE gateway_instance SET last_seen_at=?", [
      new Date(Date.now() - 3_600_000).toISOString(),
    ]);
    runDueJobs(cp.app);
    // Nothing is serving this environment, so there is nothing for it to have converged on. The
    // operation stays pending rather than reporting success into an empty fleet.
    expect(stateOf(op.id)).toBe("waiting-for-gateways");
  });

  test("a change queued before a restart converges afterwards, and is not applied twice", async () => {
    setup();
    const op = await publish();
    // Accepted and durable, but nothing has run: exactly the window a deployment lands in.
    expect(stateOf(op.id)).toBe("queued");
    cp.restart();
    expect(stateOf(op.id)).toBe("queued");
    runDueJobs(cp.app);
    await ack("dev");
    expect(stateOf(op.id)).toBe("complete");
    expect(releasesIn(op.resourceId, "dev")).toHaveLength(1);
    // A browser that was open across the restart retries its submission: the idempotency key is on
    // disk too, so it is the same operation rather than a second API.
    const again = await publish();
    expect(again.id).toBe(op.id);
    expect(
      cp.app.db.query("SELECT id FROM resource WHERE name='sample'").all(),
    ).toHaveLength(1);
  });

  test("a backend pool set through configure reaches the gateway, with the binding's own rules", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const editor = await (
      await call(
        "GET",
        `/api/resources/${op.resourceId}/editor?environment=dev`,
        "pavel",
      )
    ).json();
    const pool = [
      { url: "http://127.0.0.1:9999", weight: 3 },
      { url: "http://127.0.0.1:9998", weight: 1 },
    ];
    expect(
      (
        await call(
          "POST",
          `/api/resources/${op.resourceId}/configure`,
          "pavel",
          { environment: "dev", pool, rule: "round-robin" },
          { "idempotency-key": "pool", "if-match": editor.resource.etag },
        )
      ).status,
    ).toBe(202);
    runDueJobs(cp.app);
    await ack("dev");
    const built = buildConfig(
      cp.app.db,
      cp.app.kek,
      "dev",
      cp.app.config,
    );
    const route = built.routes.find((r) => r.resourceId === op.resourceId)!;
    expect(route.backend.pool).toEqual(pool);
    expect(route.backend.rule).toBe("round-robin");

    // The command path and the binding endpoint read a pool through the same validator, so a shape
    // one refuses cannot be reached through the other.
    const fresh = await (
      await call(
        "GET",
        `/api/resources/${op.resourceId}/editor?environment=dev`,
        "pavel",
      )
    ).json();
    const weighted = await call(
      "POST",
      `/api/resources/${op.resourceId}/configure`,
      "pavel",
      {
        environment: "dev",
        pool: [{ url: "http://127.0.0.1:9999", weight: 2 }],
        rule: "failover",
      },
      { "idempotency-key": "weighted", "if-match": fresh.resource.etag },
    );
    expect(weighted.status).toBe(400);
    expect((await weighted.json()).detail).toContain("round-robin");
  });

  test("a new version serves beside its predecessor and carries its own subscriptions", async () => {
    setup();
    const first = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const editor = await (
      await call(
        "GET",
        `/api/resources/${first.resourceId}/editor?environment=dev`,
        "pavel",
      )
    ).json();
    expect(editor.versions.map((v: any) => v.apiVersion)).toEqual(["v1"]);

    const second = await call(
      "POST",
      "/api/publish",
      "pavel",
      {
        applicationId: "application_platform",
        name: "sample",
        apiVersion: "v2",
        productName: "sample-v2-product",
        domain: "IT",
        subdomain: "Solution",
        basePath: "/it/solution/sample/v2",
        pool: editor.settings.backend.pool,
        rule: editor.settings.backend.rule,
        policy: editor.settings.policy,
        spec: MINI_SPEC,
      },
      { "idempotency-key": "sample-v2" },
    );
    expect(second.status).toBe(202);
    const v2 = await second.json();
    runDueJobs(cp.app);
    await ack("dev");

    // Both live at once, on their own paths.
    const built = buildConfig(
      cp.app.db,
      cp.app.kek,
      "dev",
      cp.app.config,
    );
    expect(
      built.routes
        .filter((r) => [first.resourceId, v2.resourceId].includes(r.resourceId))
        .map((r) => r.basePath)
        .sort(),
    ).toEqual(["/it/solution/sample/v1", "/it/solution/sample/v2"]);
    // And each knows about the other, which is what the version switcher reads.
    const after = await (
      await call(
        "GET",
        `/api/resources/${v2.resourceId}/editor?environment=dev`,
        "pavel",
      )
    ).json();
    expect(after.versions.map((v: any) => v.apiVersion).sort()).toEqual(["v1", "v2"]);
    // A third publish of a version that already exists is refused rather than silently replacing it.
    expect(
      (
        await call(
          "POST",
          "/api/publish",
          "pavel",
          {
            applicationId: "application_platform",
            name: "sample",
            apiVersion: "v2",
            productName: "sample-v2-again",
            domain: "IT",
            subdomain: "Solution",
            basePath: "/it/solution/sample/v2-again",
            backendUrl: "http://127.0.0.1:9999",
            spec: MINI_SPEC,
          },
          { "idempotency-key": "sample-v2-again" },
        )
      ).status,
    ).toBe(409);
  });

  test("an edit made after a promotion was accepted belongs to a later operation", async () => {
    setup();
    const op = await publish();
    runDueJobs(cp.app);
    await ack("dev");
    const editor = await (
      await call(
        "GET",
        `/api/resources/${op.resourceId}/editor?environment=dev`,
        "pavel",
      )
    ).json();
    const captured = releasesIn(op.resourceId, "dev")[0]!.revision_id;

    // Submitted against DEV as it stands at this moment.
    expect(
      (
        await call(
          "POST",
          `/api/resources/${op.resourceId}/promote`,
          "pavel",
          { environment: "test", backendUrl: "http://127.0.0.1:9998" },
          { "idempotency-key": "capture" },
        )
      ).status,
    ).toBe(202);
    // …and DEV moves on before that promotion has reached its gateways.
    expect(
      (
        await call(
          "POST",
          `/api/resources/${op.resourceId}/configure`,
          "pavel",
          {
            environment: "dev",
            spec: { ...MINI_SPEC, info: { title: "mini", version: "2.0.0" } },
          },
          { "idempotency-key": "later-edit", "if-match": editor.resource.etag },
        )
      ).status,
    ).toBe(202);

    runDueJobs(cp.app);
    await ack("dev");
    await ack("test");
    // TEST carries what was captured at submission, not whatever DEV said by the time it ran.
    expect(releasesIn(op.resourceId, "test").map((r) => r.revision_id)).toEqual([
      captured,
    ]);
    expect(
      releasesIn(op.resourceId, "dev").filter((r) => r.state === "converged")[0]!
        .revision_id,
    ).not.toBe(captured);

    // The other half of a concurrent edit: the tab that was open before the save cannot land on
    // top of it, because its ETag is no longer the resource's.
    expect(
      (
        await call(
          "POST",
          `/api/resources/${op.resourceId}/configure`,
          "pavel",
          { environment: "dev", description: "from a stale tab" },
          { "idempotency-key": "stale", "if-match": editor.resource.etag },
        )
      ).status,
    ).toBe(412);
  });
});

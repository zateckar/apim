import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, MINI_SPEC, poll, publishApi, type TestCp } from "./helpers.ts";
import { enqueueJob, runDueJobs } from "../control-plane/src/jobs.ts";

/**
 * The reconcile job's own lifecycle (control-plane-surface, "Run background work as durable jobs
 * with a lease"). What happens to the *release* it applies is `promotion.test.ts` "release order".
 */
const BACKEND = "http://127.0.0.1:9999";
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

function jobFor(releaseId: string) {
  return cp.app.db
    .query<{ state: string; attempts: number; result: string | null }, [string]>(
      "SELECT state, attempts, result FROM job WHERE json_extract(payload, '$.releaseId') = ?",
    )
    .get(releaseId)!;
}
function dueNow() {
  cp.app.db.run("UPDATE job SET next_attempt_at = NULL WHERE state = 'queued'");
  runDueJobs(cp.app);
}
async function secondRevision(resourceId: string, cookie: string) {
  await cp.call("POST", `/api/resources/${resourceId}/revisions`, {
    cookie,
    body: { spec: { ...MINI_SPEC, info: { ...MINI_SPEC.info, version: "2" }, paths: { ...MINI_SPEC.paths, "/two": { get: { operationId: "two", responses: {} } } } } },
  });
}
async function release(resourceId: string, cookie: string, revision: number) {
  return (
    await cp.call("POST", `/api/resources/${resourceId}/releases`, {
      cookie,
      body: { revision, environment: "dev" },
    })
  ).json();
}

describe("the reconcile job", () => {
  test("a job whose release was deleted with its API finishes instead of retrying for ever", async () => {
    const api = await publishApi(cp, { backendUrl: BACKEND });
    await secondRevision(api.resourceId, api.pavel);
    cp.app.db.run("UPDATE target SET paused = 1 WHERE environment = 'dev'");
    const pending = await release(api.resourceId, api.pavel, 2);
    expect(pending.state).toBe("pending");
    cp.app.db.run("UPDATE target SET paused = 0 WHERE environment = 'dev'");

    const alice = await cp.login("alice");
    expect((await cp.call("DELETE", `/api/resources/${api.resourceId}`, { cookie: alice })).status).toBeLessThan(300);
    dueNow();

    const job = jobFor(pending.releaseId);
    expect(job.state).toBe("done");
    expect(job.result).toBe("nothing to apply: the release no longer exists");
  });

  test("a release onto two gateways is held while either one is paused", async () => {
    const api = await publishApi(cp, { backendUrl: BACKEND });
    const alice = await cp.login("alice");
    const added = await cp.call("POST", "/api/gateways", {
      cookie: alice,
      body: { environment: "dev", name: "onprem", publicUrl: "https://gw-onprem.example" },
    });
    expect(added.status).toBe(201);
    const onprem = cp.app.db
      .query<{ id: string }, []>("SELECT id FROM target WHERE environment = 'dev' AND name = 'onprem'")
      .get()!.id;
    cp.app.db.run("INSERT INTO route_gateway (resource_id, environment, target_id) VALUES (?, 'dev', ?)", [
      api.resourceId,
      onprem,
    ]);
    await secondRevision(api.resourceId, api.pavel);

    // `local` sorts first and is the job's handle; only `onprem` is paused.
    cp.app.db.run("UPDATE target SET paused = 1 WHERE id = ?", [onprem]);
    const held = await release(api.resourceId, api.pavel, 2);
    expect(held.state).toBe("pending");
    expect(jobFor(held.releaseId).result).toContain("dev/onprem is paused");
    const onOnprem = () =>
      cp.app.db
        .query<{ rev: number }, [string, string]>(
          "SELECT v.rev FROM applied a JOIN revision v ON v.id = a.revision_id WHERE a.target_id = ? AND a.resource_id = ?",
        )
        .get(onprem, api.resourceId);
    expect(onOnprem()).toBeNull();

    cp.app.db.run("UPDATE target SET paused = 0 WHERE id = ?", [onprem]);
    dueNow();
    expect(jobFor(held.releaseId).state).toBe("done");
    expect(onOnprem()!.rev).toBe(2);
    expect((await poll(cp)).config!.routes[0]!.rev).toBe(2);
  });

  test("a job that can never succeed fails at once rather than retrying", async () => {
    const id = enqueueJob(cp.app.db, "reconcile", {
      targetId: "tgt_gone",
      resourceId: "res_gone",
      intent: "remove",
    });
    runDueJobs(cp.app);
    const job = cp.app.db
      .query<{ state: string; attempts: number; result: string }, [string]>(
        "SELECT state, attempts, result FROM job WHERE id = ?",
      )
      .get(id)!;
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.result).toContain("does not say which environment");
  });

  test("a live lease held by another runner holds the job until it lapses", async () => {
    const api = await publishApi(cp, { backendUrl: BACKEND });
    await secondRevision(api.resourceId, api.pavel);
    // Named like the old shared holder: a string every runner used to share is not this runner's.
    cp.app.db.run(
      "UPDATE target SET lease_holder = 'cp-inline-runner', lease_expires_at = ? WHERE environment = 'dev'",
      [new Date(Date.now() + 30_000).toISOString()],
    );
    const held = await release(api.resourceId, api.pavel, 2);
    expect(held.state).toBe("pending");
    expect(jobFor(held.releaseId).result).toContain("leased by cp-inline-runner");

    cp.app.db.run("UPDATE target SET lease_expires_at = ? WHERE environment = 'dev'", [
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    dueNow();
    expect(jobFor(held.releaseId).state).toBe("done");
    // Released afterwards: nothing is left holding the target.
    const lease = cp.app.db
      .query<{ lease_holder: string | null }, []>("SELECT lease_holder FROM target WHERE environment = 'dev'")
      .get()!;
    expect(lease.lease_holder).toBeNull();
  });
});

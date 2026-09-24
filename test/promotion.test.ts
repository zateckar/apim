import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCp, poll, prepareEnvironment, promote, publishApi, type TestCp } from "./helpers.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";

/**
 * Design section 6: the contract is promoted along the chain, everything else is edited in place.
 * These tests are the gate (6.2), the per-unit merge (6.3) and divergence (6.4).
 */
const BACKEND = "http://127.0.0.1:9999";
let cp: TestCp;

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function published() {
  return publishApi(cp, {
    backendUrl: BACKEND,
    basePath: "/promo",
    policy: {
      "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
      timeoutMs: 5000,
    },
  });
}

describe("the promotion gate (design section 6.2)", () => {
  test("dev cannot skip test on the way to prod, and the rejection names the predecessor", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "prod", "/promo", BACKEND);

    const response = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "prod" },
    });
    expect(response.status).toBe(409);
    const detail = (await response.json()).detail as string;
    expect(detail).toContain("has not reached test");
    expect(detail).toContain("dev -> test -> prod");
    expect(detail).toContain("Furthest point so far: dev");
  });

  test("test, then prod, both succeed once the chain is walked in order", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await prepareEnvironment(cp, api.pavel, api.resourceId, "prod", "/promo", BACKEND);

    const toTest = await promote(cp, api.pavel, api.resourceId, "test");
    expect(toTest.status).toBe(202);
    expect(toTest.release.state).toBe("converged");

    const toProd = await promote(cp, api.pavel, api.resourceId, "prod");
    expect(toProd.status).toBe(202);
    expect(toProd.release.state).toBe("converged");

    for (const environment of ["dev", "test", "prod"]) {
      const config = await (
        await cp.call(`GET`, `/api/environments/${environment}/config`, {
          cookie: await cp.login("alice"),
        })
      ).json();
      expect(config.routes).toHaveLength(1);
      expect(config.routes[0].basePath).toBe("/it/solution/promo");
    }
  });

  test("a release with no route or binding in the target is refused, naming which", async () => {
    const api = await published();
    const response = await cp.call("POST", `/api/resources/${api.resourceId}/releases?dryRun=1`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "test" },
    });
    const plan = (await response.json()).plan;
    expect(plan.blockers.map((b: { code: string }) => b.code).sort()).toEqual([
      "no-binding",
      "no-route",
    ]);

    const confirm = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "test" },
    });
    expect(confirm.status).toBe(409);
    expect((await confirm.json()).detail).toContain("no route");
  });

  test("rollback works after the chain has moved on — the 'at some point' clause", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await prepareEnvironment(cp, api.pavel, api.resourceId, "prod", "/promo", BACKEND);
    await promote(cp, api.pavel, api.resourceId, "test", 1);
    await promote(cp, api.pavel, api.resourceId, "prod", 1);

    // A second revision travels dev -> test, so test is no longer on revision 1.
    await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
      cookie: api.pavel,
      body: {
        spec: {
          swagger: "2.0",
          info: { title: "mini", version: "2.0.0" },
          host: "example.test",
          basePath: "/v2",
          paths: { "/pet": { get: { operationId: "getPet", responses: { "200": { description: "ok" } } } } },
        },
      },
    });
    await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 2, environment: "dev" },
    });
    await promote(cp, api.pavel, api.resourceId, "test", 2);
    await promote(cp, api.pavel, api.resourceId, "prod", 2);

    // Rolling prod back to revision 1 is legal because revision 1 passed through test once.
    const rollback = await promote(cp, api.pavel, api.resourceId, "prod", 1);
    expect(rollback.status).toBe(202);
    expect(rollback.plan.plan.isRollback).toBe(true);
    expect(rollback.release.state).toBe("converged");
    expect(rollback.release.rev).toBe(1);
  });

  test("skipChain needs an admin and a reason, and records both", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "prod", "/promo", BACKEND);

    const notAdmin = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "prod", skipChain: true, reason: "incident 42" },
    });
    expect(notAdmin.status).toBe(403);

    const alice = await cp.login("alice");
    const noReason = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: alice,
      body: { revision: 1, environment: "prod", skipChain: true },
    });
    expect(noReason.status).toBe(400);

    const ok = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: alice,
      body: { revision: 1, environment: "prod", skipChain: true, reason: "incident 42" },
    });
    expect(ok.status).toBe(202);
    expect((await ok.json()).state).toBe("converged");

    const audit = await (await cp.call("GET", "/api/audit?limit=200", { cookie: alice })).json();
    const entry = audit.items.find((a: { action: string }) => a.action === "release.skipChain");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry.detail).reason).toBe("incident 42");
  });
});

describe("release order", () => {
  function revisionSpec(path: string) {
    return {
      swagger: "2.0",
      info: { title: "mini", version: path },
      host: "example.test",
      basePath: "/v1",
      paths: { [path]: { get: { operationId: path.slice(1), responses: { "200": { description: "ok" } } } } },
    };
  }
  function releasesIn(resourceId: string) {
    return cp.app.db
      .query<{ rev: number; state: string; reason: string | null }, [string]>(
        `SELECT v.rev, rel.state, rel.reason FROM release rel JOIN revision v ON v.id = rel.revision_id
          WHERE rel.resource_id = ? AND rel.environment = 'dev' ORDER BY rel.rowid`,
      )
      .all(resourceId);
  }

  // formal/Formal/Release.lean `older_release_resurrects`: the trace that used to roll DEV back.
  test("a retried release confirmed earlier never overtakes one that reached the fleet after it", async () => {
    const api = await published();
    for (const path of ["/two", "/three"]) {
      await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
        cookie: api.pavel,
        body: { spec: revisionSpec(path) },
      });
    }
    const release = async (revision: number) =>
      (
        await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
          cookie: api.pavel,
          body: { revision, environment: "dev" },
        })
      ).json();

    // Revision 2 is confirmed while DEV is paused, so its job fails and backs off.
    cp.app.db.run("UPDATE target SET paused = 1 WHERE environment = 'dev'");
    expect((await release(2)).state).toBe("pending");
    cp.app.db.run("UPDATE target SET paused = 0 WHERE environment = 'dev'");

    // Revision 3 is confirmed after it and goes live straight away.
    expect((await release(3)).state).toBe("converged");
    expect((await poll(cp)).config!.routes[0]!.rev).toBe(3);

    // Revision 2's backoff expires. It must not take DEV back to revision 2.
    cp.app.db.run("UPDATE job SET next_attempt_at = NULL WHERE state = 'queued'");
    runDueJobs(cp.app);

    expect((await poll(cp)).config!.routes[0]!.rev).toBe(3);
    const rows = releasesIn(api.resourceId);
    expect(rows.map((r) => [r.rev, r.state])).toEqual([
      [1, "superseded"],
      [2, "stale"],
      [3, "converged"],
    ]);
    expect(rows[1]!.reason).toContain("reached DEV first");
    // Terminal, not retried: the job is done.
    const jobs = cp.app.db
      .query<{ state: string; result: string }, []>(
        "SELECT state, result FROM job WHERE kind = 'reconcile' ORDER BY created_at",
      )
      .all();
    expect(jobs.every((j) => j.state === "done")).toBe(true);
    expect(jobs.some((j) => j.result === "stale")).toBe(true);

    // Rolling back is still one deliberate act away: a new release of the older revision.
    expect((await release(2)).state).toBe("converged");
    expect((await poll(cp)).config!.routes[0]!.rev).toBe(2);
  });

  // formal/Formal/Release.lean `Unguarded.withdrawn_then_applied`, and `withdrawal_wins`.
  test("a release still waiting to apply is not published after the API is withdrawn", async () => {
    const api = await published();
    await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
      cookie: api.pavel,
      body: { spec: revisionSpec("/two") },
    });
    cp.app.db.run("UPDATE target SET paused = 1 WHERE environment = 'dev'");
    const pending = await (
      await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
        cookie: api.pavel,
        body: { revision: 2, environment: "dev" },
      })
    ).json();
    expect(pending.state).toBe("pending");
    cp.app.db.run("UPDATE target SET paused = 0 WHERE environment = 'dev'");

    await cp.call("DELETE", `/api/resources/${api.resourceId}/releases?environment=dev`, { cookie: api.pavel });
    expect((await poll(cp)).config!.routes).toHaveLength(0);

    // Revision 2's backoff expires after the withdrawal. The API stays withdrawn.
    cp.app.db.run("UPDATE job SET next_attempt_at = NULL WHERE state = 'queued'");
    runDueJobs(cp.app);
    expect((await poll(cp)).config!.routes).toHaveLength(0);
    const rows = releasesIn(api.resourceId);
    expect(rows.map((r) => [r.rev, r.state])).toEqual([
      [1, "withdrawn"],
      [2, "stale"],
    ]);
    expect(rows[1]!.reason).toContain("withdrawn from DEV before it was applied");
  });

  // A process that dies after the apply transaction commits but before the job is marked `done`
  // leaves it `running`, and the runner re-queues it a minute later. The replay must be a no-op.
  test("a replayed reconcile of a release that already reached the fleet changes nothing", async () => {
    const api = await published();
    await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
      cookie: api.pavel,
      body: { spec: revisionSpec("/two") },
    });
    const second = await (
      await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
        cookie: api.pavel,
        body: { revision: 2, environment: "dev" },
      })
    ).json();
    expect(second.state).toBe("converged");
    const replay = (releaseId: string) => {
      cp.app.db.run(
        "UPDATE job SET state = 'queued', next_attempt_at = NULL WHERE json_extract(payload, '$.releaseId') = ?",
        [releaseId],
      );
      runDueJobs(cp.app);
    };

    // Replaying revision 1's apply must neither bring it back nor mark it `stale`: it did reach
    // DEV, and the promotion gate reads `stale` as "never got here".
    replay(api.release.releaseId);
    expect(releasesIn(api.resourceId).map((r) => [r.rev, r.state])).toEqual([
      [1, "superseded"],
      [2, "converged"],
    ]);
    expect((await poll(cp)).config!.routes[0]!.rev).toBe(2);

    // And replaying a withdrawn release's apply must not publish it again.
    await cp.call("DELETE", `/api/resources/${api.resourceId}/releases?environment=dev`, { cookie: api.pavel });
    expect((await poll(cp)).config!.routes).toHaveLength(0);
    replay(second.releaseId);
    expect(releasesIn(api.resourceId).map((r) => r.state)).toEqual(["superseded", "withdrawn"]);
    expect((await poll(cp)).config!.routes).toHaveLength(0);
  });
});

describe("the per-unit policy merge (design section 6.3)", () => {
  test("a unit absent in the target is created with the predecessor's values, and it functions", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);

    const result = await promote(cp, api.pavel, api.resourceId, "test");
    expect(result.plan.plan.policy.create.map((e: { unit: string }) => e.unit).sort()).toEqual([
      "auth.subscriptionKey",
      "timeoutMs",
    ]);
    expect(result.release.seededUnits.sort()).toEqual(["auth.subscriptionKey", "timeoutMs"]);

    const policy = await (
      await cp.call("GET", `/api/resources/${api.resourceId}/policy?environment=test`, {
        cookie: api.pavel,
      })
    ).json();
    const seeded = policy.units.find((u: { unitKey: string }) => u.unitKey === "auth.subscriptionKey");
    expect(seeded.origin).toBe("seeded");
    expect(seeded.seededFromEnv).toBe("dev");

    // Asserted by what the gateway is told, not by reading the row back.
    const config = await (
      await cp.call("GET", "/api/environments/test/config", { cookie: await cp.login("alice") })
    ).json();
    expect(config.routes[0].policy["auth.subscriptionKey"].name).toBe("X-Api-Key");
    expect(config.routes[0].policy.timeoutMs).toBe(5000);
  });

  test("a unit present in the target is untouched, and stays untouched across promotions", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/timeoutMs?environment=test`, {
      cookie: api.pavel,
      body: { value: 1234 },
    });

    const first = await promote(cp, api.pavel, api.resourceId, "test");
    expect(first.plan.plan.policy.keep.map((e: { unit: string }) => e.unit)).toEqual(["timeoutMs"]);

    const config = await (
      await cp.call("GET", "/api/environments/test/config", { cookie: await cp.login("alice") })
    ).json();
    expect(config.routes[0].policy.timeoutMs).toBe(1234);
  });

  test("removing a unit in the predecessor does not remove it downstream", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await promote(cp, api.pavel, api.resourceId, "test");

    await cp.call("DELETE", `/api/resources/${api.resourceId}/policy/units/timeoutMs`, {
      cookie: api.pavel,
    });
    const second = await promote(cp, api.pavel, api.resourceId, "test");
    expect(second.plan.plan.policy.localOnly.map((e: { unit: string }) => e.unit)).toContain("timeoutMs");

    const config = await (
      await cp.call("GET", "/api/environments/test/config", { cookie: await cp.login("alice") })
    ).json();
    expect(config.routes[0].policy.timeoutMs).toBe(5000);
  });

  test("editing a seeded unit flips it to local and it is never overwritten again", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await promote(cp, api.pavel, api.resourceId, "test");

    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/timeoutMs?environment=test`, {
      cookie: api.pavel,
      body: { value: 4321 },
    });
    await promote(cp, api.pavel, api.resourceId, "test");

    const policy = await (
      await cp.call("GET", `/api/resources/${api.resourceId}/policy?environment=test`, {
        cookie: api.pavel,
      })
    ).json();
    const unit = policy.units.find((u: { unitKey: string }) => u.unitKey === "timeoutMs");
    expect(unit.origin).toBe("local");
    expect(unit.value).toBe(4321);
  });

  test("a changed plan is automatically reevaluated before applying", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);

    const dry = await (
      await cp.call("POST", `/api/resources/${api.resourceId}/releases?dryRun=1`, {
        cookie: api.pavel,
        body: { revision: 1, environment: "test" },
      })
    ).json();

    // Someone edits DEV policy between the plan being shown and it being confirmed.
    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/timeoutMs`, {
      cookie: api.pavel,
      body: { value: 9999 },
    });

    const confirm = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "test", planId: dry.planId },
    });
    expect(confirm.status).toBe(202);
    const body = await confirm.json();
    expect(body.state).toBe("converged");

    // The current validated policy is applied automatically.
    const config = await (
      await cp.call("GET", "/api/environments/test/config", { cookie: await cp.login("alice") })
    ).json();
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].policy.timeoutMs).toBe(9999);
  });

  test("a plan cannot be confirmed twice", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    const first = await promote(cp, api.pavel, api.resourceId, "test");

    const replay = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "test", planId: first.plan.planId },
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).detail).toContain("already been confirmed");
  });

  test("promotion without a plan is refused; the first link of the chain does not need one", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);

    const noPlan = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "test" },
    });
    expect(noPlan.status).toBe(400);
    expect((await noPlan.json()).detail).toContain("needs a planId");

    // dev has no predecessor, so there is no merge to confirm.
    const dev = await cp.call("POST", `/api/resources/${api.resourceId}/releases`, {
      cookie: api.pavel,
      body: { revision: 1, environment: "dev" },
    });
    expect(dev.status).toBe(202);
  });
});

describe("copy-from and divergence (design section 6.3, 6.4)", () => {
  test("copy-from needs an explicit unit list and writes local units", async () => {
    const api = await published();

    const noUnits = await cp.call("POST", `/api/resources/${api.resourceId}/policy/copy-from`, {
      cookie: api.pavel,
      body: { fromEnvironment: "dev", environment: "test", units: [] },
    });
    expect(noUnits.status).toBe(400);

    const copied = await cp.call("POST", `/api/resources/${api.resourceId}/policy/copy-from`, {
      cookie: api.pavel,
      body: { fromEnvironment: "dev", environment: "test", units: ["timeoutMs"] },
    });
    expect(copied.status).toBe(200);
    expect((await copied.json()).after.timeoutMs).toBe(5000);

    const policy = await (
      await cp.call("GET", `/api/resources/${api.resourceId}/policy?environment=test`, {
        cookie: api.pavel,
      })
    ).json();
    expect(policy.units.find((u: { unitKey: string }) => u.unitKey === "timeoutMs").origin).toBe("local");
  });

  test("divergence classifies pending, local additions, drift and aligned", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await promote(cp, api.pavel, api.resourceId, "test");
    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/timeoutMs?environment=test`, {
      cookie: api.pavel,
      body: { value: 4321 },
    });
    await cp.call("PUT", `/api/resources/${api.resourceId}/policy/units/rewrite?environment=test`, {
      cookie: api.pavel,
      body: { value: { stripBasePath: true } },
    });

    const report = await (
      await cp.call("GET", `/api/resources/${api.resourceId}/divergence`, { cookie: api.pavel })
    ).json();
    const dev = report.environments.find((e: { environment: string }) => e.environment === "dev");
    const test_ = report.environments.find((e: { environment: string }) => e.environment === "test");
    const prod = report.environments.find((e: { environment: string }) => e.environment === "prod");

    expect(dev.predecessor).toBeNull();
    expect(dev.units.every((u: { category: string }) => u.category === "local-addition")).toBe(true);

    const byUnit = Object.fromEntries(
      test_.units.map((u: { unit: string; category: string }) => [u.unit, u.category]),
    );
    expect(byUnit.timeoutMs).toBe("value-drift");
    expect(byUnit.rewrite).toBe("local-addition");
    expect(byUnit["auth.subscriptionKey"]).toBe("aligned");

    // An auth unit present upstream and absent here is the case worth a warning.
    const pendingAuth = prod.units.find((u: { unit: string }) => u.unit === "auth.subscriptionKey");
    expect(pendingAuth.category).toBe("pending");
    expect(pendingAuth.warning).toContain("less protected");
  });

  test("the promotion view reports what is live where and how far a revision has travelled", async () => {
    const api = await published();
    await prepareEnvironment(cp, api.pavel, api.resourceId, "test", "/promo", BACKEND);
    await promote(cp, api.pavel, api.resourceId, "test");

    const view = await (
      await cp.call("GET", `/api/resources/${api.resourceId}/promotion`, { cookie: api.pavel })
    ).json();
    expect(view.chain).toEqual(["dev", "test", "prod"]);
    expect(view.furthest).toBe("test");
    const byEnv = Object.fromEntries(
      view.items.map((i: { environment: string; liveRev: number | null; eligible: boolean }) => [
        i.environment,
        i,
      ]),
    );
    expect(byEnv.dev.liveRev).toBe(1);
    expect(byEnv.test.liveRev).toBe(1);
    expect(byEnv.prod.liveRev).toBeNull();
    expect(byEnv.prod.eligible).toBe(true);
    expect(byEnv.prod.hasRoute).toBe(false);
  });
});

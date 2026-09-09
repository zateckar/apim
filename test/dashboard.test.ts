import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ATTENTION_CODES,
  ATTENTION_SEVERITY,
  START_HERE_CODES,
  type AttentionCode,
  type AttentionRow,
} from "../shared/attention.ts";
import { emptyBuckets, windowStartOf, type TelemetryReport } from "../shared/telemetry.ts";
import { makeCp, poll, publishApi, startBackend, type TestCp } from "./helpers.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";

/**
 * G2: one endpoint, blocks per hat, and one evaluator behind every "this needs attention" row.
 *
 * The properties worth protecting:
 *
 *  - **the numbers are the telemetry endpoints' own numbers.** Two screens that computed traffic
 *    separately would eventually disagree, and the one that disagreed would be the one somebody was
 *    looking at when they made a decision.
 *  - **`previous` is null rather than wrong.** A trend needs twice the window inside retention.
 *  - **every list is bounded**, with the truncation count beside it.
 *  - **one evaluator.** The API page's banner and the dashboard's list are the same rows, produced
 *    by the same SQL, so a user cannot be told two different things about one API.
 *  - **`start-here-*` never leaks into an `attention[]` block**: "publish your first API" on an application
 *    that has fifty is nonsense.
 */

let cp: TestCp;
let backend: ReturnType<typeof startBackend>;

/** Every row this suite ever sees, so the vocabulary can be checked against the code list once. */
const observed: AttentionRow[] = [];

beforeEach(() => {
  cp = makeCp();
  backend = startBackend();
});
afterEach(() => {
  backend.stop();
  cp.close();
});

interface Dash {
  generatedAt: string;
  environment: string;
  sinceMin: number;
  trendAvailable: boolean;
  hats: string[];
  owner: {
    apis: { total: number; byLifecycle: Record<string, number>; liveByEnvironment: Record<string, number> };
    traffic: {
      requests: number;
      ok: number;
      gatewayRejections: number;
      upstreamErrors: number;
      errorRate: number;
      p50Ms: number | null;
      p95Ms: number | null;
      series: Array<{ windowStart: string; requests: number; p95Ms: number | null }>;
      previous: { requests: number } | null;
      truncated: boolean;
    };
    topApis: Array<{ resourceId: string; name: string; requests: number }>;
    attention: AttentionRow[];
    attentionTruncated: number;
  };
  consumer: {
    applications: Array<{ id: string; name: string; subscriptions: number }>;
    subscriptions: Array<{
      id: string;
      name: string;
      environment: string;
      state: string;
      quota: { limit: number; used: number; fraction: number; resetsInSec: number } | null;
      keyAgeDays: number;
    }>;
    subscriptionsTruncated: number;
    attention: AttentionRow[];
    attentionTruncated: number;
  };
  platform: {
    environments: Array<{
      environment: string;
      hasTarget: boolean;
      instances: number;
      live: number;
      inSync: boolean;
      configDigest: string | null;
      activeTlsExceptions: number;
      trustAnchors: number;
      expiringAnchors: number;
      configErrors: number;
    }>;
    attention: AttentionRow[];
    attentionTruncated: number;
    admin: { failedJobs: number; staleReleases: number; downgrades: number } | null;
  };
  startHere: AttentionRow[] | null;
}

async function dashboard(cookie: string, query = ""): Promise<Dash> {
  const response = await cp.call("GET", `/api/dashboard${query}`, { cookie });
  if (!response.ok) throw new Error(`dashboard: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as Dash;
  observed.push(
    ...body.owner.attention,
    ...body.consumer.attention,
    ...body.platform.attention,
    ...(body.startHere ?? []),
  );
  return body;
}

/** Every attention row on the dashboard, whichever block it came from. */
function rows(dash: Dash): AttentionRow[] {
  return [...dash.owner.attention, ...dash.consumer.attention, ...dash.platform.attention];
}

function codes(dash: Dash): AttentionCode[] {
  return rows(dash).map((row) => row.code);
}

function find(dash: Dash, code: AttentionCode): AttentionRow | undefined {
  return rows(dash).find((row) => row.code === code);
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const DAY = 86_400_000;

/** A resource with nothing attached, straight into the table: most rules need only its row. */
function makeResource(name: string, applicationId = "application_platform", lifecycle = "active"): string {
  const id = `res_${name}`;
  cp.app.db.run(
    `INSERT INTO resource (id, kind, name, application_id, api_version, lifecycle, created_at, updated_at)
     VALUES (?, 'rest', ?, ?, 'v1', ?, ?, ?)`,
    [id, name, applicationId, lifecycle, iso(0), iso(0)],
  );
  return id;
}

function addRevision(resourceId: string, rev = 1): string {
  const id = `rev_${resourceId}_${rev}`;
  cp.app.db.run(
    `INSERT INTO revision (id, resource_id, rev, model, original, original_format, version_digest,
                           created_by, created_at)
     VALUES (?, ?, ?, '{}', '{}', 'openapi-3.0', ?, 'pavel', ?)`,
    [id, resourceId, rev, `sha256:${resourceId}-${rev}`, iso(0)],
  );
  return id;
}

// --------------------------------------------------------------------------- the window

describe("the window and the numbers", () => {
  const CLOSED = windowStartOf(Date.now() - 120_000);

  function report(resourceId: string, count: number): TelemetryReport {
    const buckets = emptyBuckets();
    buckets[6] = count;
    return {
      droppedSeries: 0,
      droppedWindows: 0,
      windows: [
        {
          windowStart: CLOSED,
          series: [
            {
              resourceId,
              subscriptionId: "",
              outcome: "ok",
              status: 200,
              count,
              durationMsSum: count * 60,
              durationMsMax: 90,
              bytesIn: 0,
              bytesOut: count * 100,
              buckets,
            },
          ],
        },
      ],
    };
  }

  test("traffic is the telemetry endpoint's own aggregation, for the same window", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    await poll(cp, { telemetry: report(api.resourceId, 7) });
    cp.app.telemetry.flushNow();

    const dash = await dashboard(api.pavel, "?environment=dev&sinceMin=60");
    // The Telemetry endpoints are the estate view and are admin-only; the dashboard is the
    // member-facing one. Both read through `rowsFor`, and the only traffic in this fixture is
    // Pavel's own API, so the two scopes contain the same rows and the identity below is about
    // the aggregation rather than about who may see what.
    const summary = (await (
      await cp.call("GET", "/api/telemetry/summary?environment=dev&sinceMin=60", {
        cookie: await cp.login("alice"),
      })
    ).json()) as {
      totals: {
        requests: number;
        ok: number;
        gatewayRejections: number;
        upstreamErrors: number;
        errorRate: number;
        p95Ms: number | null;
      };
      series: Array<{ windowStart: string }>;
    };

    // Read through the same function, so this is an identity rather than a coincidence (§6.2).
    expect(dash.owner.traffic.requests).toBe(summary.totals.requests);
    expect(dash.owner.traffic.ok).toBe(summary.totals.ok);
    expect(dash.owner.traffic.gatewayRejections).toBe(summary.totals.gatewayRejections);
    expect(dash.owner.traffic.upstreamErrors).toBe(summary.totals.upstreamErrors);
    expect(dash.owner.traffic.errorRate).toBe(summary.totals.errorRate);
    expect(dash.owner.traffic.p95Ms).toBe(summary.totals.p95Ms);
    expect(dash.owner.traffic.series.map((s) => s.windowStart)).toEqual(
      summary.series.map((s) => s.windowStart),
    );
    // Three numbers, never one.
    expect(dash.owner.traffic.requests).toBe(7);
    expect(dash.owner.traffic.ok).toBe(7);

    expect(dash.owner.topApis[0]).toMatchObject({ resourceId: api.resourceId, requests: 7 });
    expect(dash.owner.topApis[0]!.name).toContain(api.name);
  });

  test("environment=all covers the chain, and one environment covers only itself", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    await poll(cp, { telemetry: report(api.resourceId, 4) });
    cp.app.telemetry.flushNow();

    expect((await dashboard(api.pavel, "?environment=all")).owner.traffic.requests).toBe(4);
    expect((await dashboard(api.pavel, "?environment=dev")).owner.traffic.requests).toBe(4);
    expect((await dashboard(api.pavel, "?environment=prod")).owner.traffic.requests).toBe(0);
    // Nothing was live in PROD, so the count is a count and not an error.
    expect((await dashboard(api.pavel, "?environment=prod")).owner.apis.liveByEnvironment).toEqual({
      prod: 0,
    });
  });

  test("previous is null exactly when retention cannot cover the window before this one", async () => {
    const pavel = await cp.login("pavel");
    // TELEMETRY_RETENTION_HOURS is 48, so 2880 minutes is the ceiling and 1440 is the largest
    // window whose predecessor is still inside it.
    const covered = await dashboard(pavel, "?sinceMin=1440");
    expect(covered.trendAvailable).toBe(true);
    expect(covered.owner.traffic.previous).not.toBeNull();

    const uncovered = await dashboard(pavel, "?sinceMin=1441");
    expect(uncovered.trendAvailable).toBe(false);
    // One meaning, one field: null rather than a number computed over a window we do not hold.
    expect(uncovered.owner.traffic.previous).toBeNull();
  });

  test("a window past retention is refused by name, never clamped", async () => {
    const pavel = await cp.login("pavel");
    const refused = await cp.call("GET", "/api/dashboard?sinceMin=2881", { cookie: pavel });
    expect(refused.status).toBe(400);
    const problem = (await refused.json()) as { detail: string };
    expect(problem.detail).toContain("between 1 and 2880");
    expect(problem.detail).toContain("TELEMETRY_RETENTION_HOURS");

    const unknown = await cp.call("GET", "/api/dashboard?environment=staging", { cookie: pavel });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { detail: string }).detail).toContain('"all"');
  });

  test("the default window is DASHBOARD_DEFAULT_SINCE_MIN and the default environment is all", async () => {
    const pavel = await cp.login("pavel");
    const dash = await dashboard(pavel);
    expect(dash.sinceMin).toBe(cp.app.config.dashboardDefaultSinceMin);
    expect(dash.environment).toBe("all");
    expect(Date.parse(dash.generatedAt)).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- bounds

describe("every list is bounded", () => {
  test("attention is capped at 50 and says how many more there are", async () => {
    const pavel = await cp.login("pavel");
    for (let i = 0; i < 55; i++) makeResource(`bulk-${String(i).padStart(2, "0")}`);
    const dash = await dashboard(pavel);
    expect(dash.owner.attention).toHaveLength(50);
    expect(dash.owner.attentionTruncated).toBe(5);
    // Truncation drops the least urgent, so what survives is still ordered by severity.
    expect(dash.owner.attention.every((row) => row.code === "no-definition")).toBe(true);
  });

  test("top APIs are the ten busiest", async () => {
    const pavel = await cp.login("pavel");
    const buckets = emptyBuckets();
    buckets[6] = 1;
    const windowStart = windowStartOf(Date.now() - 120_000);
    const series = [];
    for (let i = 0; i < 12; i++) {
      const id = makeResource(`busy-${i}`);
      series.push({
        resourceId: id,
        subscriptionId: "",
        outcome: "ok" as const,
        status: 200,
        count: i + 1,
        durationMsSum: 10,
        durationMsMax: 10,
        bytesIn: 0,
        bytesOut: 0,
        buckets,
      });
    }
    await poll(cp, { telemetry: { droppedSeries: 0, droppedWindows: 0, windows: [{ windowStart, series }] } });
    cp.app.telemetry.flushNow();

    const dash = await dashboard(pavel, "?environment=dev");
    expect(dash.owner.topApis).toHaveLength(10);
    expect(dash.owner.topApis[0]!.requests).toBe(12);
    expect(dash.owner.topApis[9]!.requests).toBe(3);
  });
});

// --------------------------------------------------------------------------- hats

describe("two hats, and the data decides which", () => {
  test("an owner sees their APIs, a consumer sees their subscriptions, neither sees the other's", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });

    const owner = await dashboard(api.pavel);
    expect(owner.hats).toEqual(["owner"]);
    expect(owner.owner.apis.total).toBe(1);
    expect(owner.owner.apis.byLifecycle).toEqual({ active: 1 });
    expect(owner.owner.apis.liveByEnvironment.dev).toBe(1);
    // The application belongs to another application, so it is not this caller's data.
    expect(owner.consumer.applications.map(a => a.id)).toEqual(["application_platform"]);
    expect(owner.consumer.subscriptions).toEqual([]);

    const consumer = await dashboard(api.clara);
    expect(consumer.hats).toEqual(["consumer"]);
    expect(consumer.owner.apis.total).toBe(0);
    expect(consumer.consumer.applications).toHaveLength(1);
    expect(consumer.consumer.applications[0]!.subscriptions).toBe(1);
    expect(consumer.consumer.subscriptions[0]!.name).toContain("→");
    expect(consumer.consumer.subscriptions[0]!.environment).toBe("dev");
  });

  test("an admin sees the estate, and only an admin gets the admin block", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const alice = await cp.login("alice");

    const admin = await dashboard(alice);
    expect(admin.hats).toEqual(["owner", "consumer", "platform"]);
    expect(admin.platform.admin).not.toBeNull();
    expect(admin.platform.admin!.failedJobs).toBe(0);

    // Absent rather than empty: an empty block reads as "nothing is wrong".
    expect((await dashboard(api.pavel)).platform.admin).toBeNull();
  });

  test("the environments block is the fleet's own health, for everyone", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    await poll(cp);
    const dash = await dashboard(api.pavel, "?environment=dev");
    const health = (await (
      await cp.call("GET", "/api/targets/dev/health", { cookie: api.pavel })
    ).json()) as { configDigest: string; liveInstances: number; inSync: boolean };

    const dev = dash.platform.environments[0]!;
    expect(dev.environment).toBe("dev");
    expect(dev.hasTarget).toBe(true);
    expect(dev.configDigest).toBe(health.configDigest);
    expect(dev.live).toBe(health.liveInstances);
    expect(dev.inSync).toBe(health.inSync);
    expect(dev.trustAnchors).toBe(0);
  });
});

// --------------------------------------------------------------------------- start here

describe("the empty estate", () => {
  test("startHere appears exactly when there is nothing, in the same row shape", async () => {
    const pavel = await cp.login("pavel");
    const empty = await dashboard(pavel);
    expect(empty.startHere).not.toBeNull();
    expect(empty.startHere!.map((row) => row.code)).toEqual([
      "start-here-subscribe",
      "start-here-publish",
    ]);
    for (const row of empty.startHere!) {
      // The same shape as an attention row, so one component renders both `[P1-21]`.
      expect(row.severity).toBe("info");
      expect(row.subject.kind).toBe("portal");
      expect(row.href.startsWith("/")).toBe(true);
      expect(row.detail.length).toBeGreaterThan(20);
    }
    expect(empty.hats).toEqual([]);

    // Never inside an attention block, whatever the estate looks like `[P2-09]`.
    for (const code of codes(empty)) expect(START_HERE_CODES).not.toContain(code);

    const alice = await cp.login("alice");
    expect((await dashboard(alice)).startHere!.map((row) => row.code)).toContain("start-here-operate");
  });

  test("one API or one subscription is enough to make it go away", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    expect((await dashboard(api.pavel)).startHere).toBeNull();
    expect((await dashboard(api.clara)).startHere).toBeNull();
  });
});

// --------------------------------------------------------------------------- the rules

describe("an API that cannot serve traffic yet", () => {
  test("no definition", async () => {
    const pavel = await cp.login("pavel");
    const id = makeResource("empty");
    const dash = await dashboard(pavel);
    const row = find(dash, "no-definition")!;
    expect(row.severity).toBe("blocker");
    expect(row.subject).toEqual({ kind: "resource", id, name: "empty v1" });
    expect(row.href).toBe(`/apis/${id}/definition`);
    // Nothing else is said about an API with nothing in it.
    expect(codes(dash).filter((code) => code.startsWith("no-"))).toEqual(["no-definition"]);
  });

  test("a route or a backend is reported only where the API has begun to exist", async () => {
    const pavel = await cp.login("pavel");
    const id = makeResource("half");
    addRevision(id);
    cp.app.db.run("INSERT INTO binding (resource_id, environment, backend_json) VALUES (?, 'dev', '{}')", [id]);

    const dash = await dashboard(pavel);
    const noRoute = rows(dash).filter((row) => row.code === "no-route");
    expect(noRoute).toHaveLength(1);
    expect(noRoute[0]!.environment).toBe("dev");
    expect(noRoute[0]!.detail).toContain("DEV");
    // TEST and PROD are not gaps: nothing has been attempted there, and "no route in PROD" on
    // every new API is noise rather than attention.
    expect(noRoute[0]!.href).toBe(`/apis/${id}/publish?environment=dev`);
    expect(rows(dash).some((row) => row.code === "no-binding")).toBe(false);

    cp.app.db.run("DELETE FROM binding WHERE resource_id = ?", [id]);
    cp.app.db.run("INSERT INTO route (resource_id, environment, host, base_path) VALUES (?, 'test', '*', '/half')", [id]);
    const swapped = await dashboard(pavel);
    const noBinding = rows(swapped).filter((row) => row.code === "no-binding");
    expect(noBinding).toHaveLength(1);
    expect(noBinding[0]!.environment).toBe("test");
    expect(noBinding[0]!.severity).toBe("blocker");
  });

  test("never released, and the newest revision never published", async () => {
    const pavel = await cp.login("pavel");
    const id = makeResource("unpublished");
    addRevision(id);
    const never = find(await dashboard(pavel), "never-released")!;
    expect(never.severity).toBe("warning");
    expect(never.environment).toBeUndefined();
    expect(never.href).toBe(`/apis/${id}/publish`);

    // A published API with a newer revision says something different, and only then.
    const api = await publishApi(cp, { backendUrl: backend.url });
    expect(codes(await dashboard(api.pavel))).not.toContain("unreleased-revision");
    const second = await cp.call("POST", `/api/resources/${api.resourceId}/revisions`, {
      cookie: api.pavel,
      body: {
        spec: {
          swagger: "2.0",
          info: { title: "mini", version: "1.0.0" },
          paths: { "/extra": { get: { operationId: "extra", responses: { "200": { description: "ok" } } } } },
        },
      },
    });
    expect(second.ok).toBe(true);
    const stale = find(await dashboard(api.pavel), "unreleased-revision")!;
    expect(stale.detail).toContain("Revision 2");
    expect(stale.href).toBe(`/apis/${api.resourceId}/revisions`);
  });

  test("a release that failed, and a plan that went stale", async () => {
    const pavel = await cp.login("pavel");
    const id = makeResource("wobbly");
    const revisionId = addRevision(id);
    cp.app.db.run(
      `INSERT INTO release (id, resource_id, revision_id, environment, state, reason, version_digest,
                            released_by, released_at)
       VALUES ('rel_failed', ?, ?, 'dev', 'failed', 'the backend binding is empty', 'sha256:x', 'pavel', ?)`,
      [id, revisionId, iso(-1000)],
    );
    const failed = find(await dashboard(pavel), "release-failed")!;
    expect(failed.severity).toBe("blocker");
    expect(failed.detail).toContain("the backend binding is empty");
    expect(failed.environment).toBe("dev");

    // Only the newest release per environment: an old failure that was superseded is history.
    cp.app.db.run(
      `INSERT INTO release (id, resource_id, revision_id, environment, state, version_digest,
                            released_by, released_at)
       VALUES ('rel_stale', ?, ?, 'dev', 'stale', 'sha256:x', 'pavel', ?)`,
      [id, revisionId, iso(0)],
    );
    const after = await dashboard(pavel);
    expect(codes(after)).toContain("release-stale");
    expect(codes(after)).not.toContain("release-failed");
    expect(find(after, "release-stale")!.detail).toContain("changed before it was applied");
  });

  test("a published route the gateway is not serving", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    // The restored-backup case: an effective document that no write path would have accepted.
    cp.app.db.run(
      `INSERT INTO policy_entry (resource_id, environment, unit_key, value_json, origin, updated_by, updated_at)
       VALUES (?, 'dev', 'rateLimit', ?, 'local', 'test', ?)`,
      [api.resourceId, JSON.stringify({ calls: 5 }), iso(0)],
    );
    const dash = await dashboard(api.pavel, "?environment=dev");
    const row = find(dash, "config-error")!;
    expect(row.severity).toBe("blocker");
    expect(row.detail).toContain("rateLimit.periodSec");
    expect(row.detail).toContain("404");
    expect(row.href).toBe(`/apis/${api.resourceId}/policy?environment=dev`);
    // The same fact, counted, in the environment block — from the same config document.
    expect(dash.platform.environments[0]!.configErrors).toBe(1);
  });
});

describe("an API that serves traffic without a control somebody would expect", () => {
  test("no authentication, and no concurrency ceiling", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url, policy: {} });
    const dash = await dashboard(api.pavel, "?environment=dev");
    const open = find(dash, "no-auth-policy")!;
    expect(open.severity).toBe("warning");
    expect(open.detail).toContain("not attributable");
    expect(open.environment).toBe("dev");
    expect(find(dash, "no-concurrency-ceiling")!.severity).toBe("info");

    // A unit attached to the environment's global tier counts: the effective document is what the
    // gateway runs.
    const alice = await cp.login("alice");
    const attached = await cp.call("PUT", "/api/policy/global/units/concurrency?environment=dev", {
      cookie: alice,
      body: { value: { maxInFlight: 100, per: "instance" } },
    });
    expect(attached.ok).toBe(true);
    expect(codes(await dashboard(api.pavel, "?environment=dev"))).not.toContain("no-concurrency-ceiling");
  });

  test("request validation that observes instead of rejecting", async () => {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        validate: { request: "warning", downgradeReason: "the backend is stricter than its contract" },
      },
    });
    const row = find(await dashboard(api.pavel, "?environment=dev"), "validation-downgraded")!;
    expect(row.detail).toContain('"warning"');
    expect(row.detail).toContain("reaches the backend");
    expect(row.href).toBe(`/apis/${api.resourceId}/policy?environment=dev`);
  });

  test("a TLS exception, and the same exception about to expire", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const insert = (id: string, expiresAt: string) =>
      cp.app.db.run(
        `INSERT INTO tls_exception (id, resource_id, environment, mode, reason, created_by, created_at, expires_at)
         VALUES (?, ?, 'dev', 'pin', 'the vendor has not rotated yet', 'alice', ?, ?)`,
        [id, api.resourceId, iso(0), expiresAt],
      );

    insert("tex_far", iso(20 * DAY));
    const active = find(await dashboard(api.pavel, "?environment=dev"), "tls-exception-active")!;
    expect(active.detail).toContain("not fully verified");
    expect(active.detail).toContain("Trust");
    expect(active.href).toBe(`/apis/${api.resourceId}/routing?environment=dev`);

    cp.app.db.run("DELETE FROM tls_exception");
    insert("tex_soon", iso(2 * DAY));
    const expiring = find(await dashboard(api.pavel, "?environment=dev"), "tls-exception-expiring")!;
    // What actually happens when it lapses, rather than "expires soon".
    expect(expiring.detail).toContain("verifies the certificate again");
  });

  test("a certificate and a trust anchor with a date on them", async () => {
    const alice = await cp.login("alice");
    cp.app.db.run(
      `INSERT INTO certificate (id, application_id, environment, name, cert_pem, key_enc, thumbprint, subject,
                                issuer, not_before, not_after, usage, created_by, created_at)
       VALUES ('cert_1', 'application_platform', 'dev', 'orders-mtls', 'pem', 'enc', 'AA', 'CN=orders',
               'CN=issuer', ?, ?, 'backend-mtls', 'alice', ?)`,
      [iso(-DAY), iso(10 * DAY), iso(0)],
    );
    cp.app.db.run(
      `INSERT INTO trust_anchor (id, environment, name, cert_pem, subject, issuer, thumbprint,
                                 not_before, not_after, added_by, added_at)
       VALUES ('anc_1', 'dev', 'Corp Issuing CA', 'pem', 'CN=ca', 'CN=root', 'BB', ?, ?, 'alice', ?)`,
      [iso(-DAY), iso(5 * DAY), iso(0)],
    );

    const dash = await dashboard(alice, "?environment=dev");
    const certificate = find(dash, "certificate-expiring")!;
    expect(certificate.subject.kind).toBe("certificate");
    expect(certificate.subject.name).toBe("orders-mtls");
    expect(certificate.detail).toContain("nothing breaks at the moment of upload");
    expect(certificate.href).toBe("/trust?environment=dev");

    const anchor = find(dash, "trust-anchor-expiring")!;
    expect(anchor.subject.kind).toBe("anchor");
    expect(anchor.detail).toContain("both can be trusted at once");
    // The same fact as a number, on the environment block.
    expect(dash.platform.environments[0]!.trustAnchors).toBe(1);
    expect(dash.platform.environments[0]!.expiringAnchors).toBe(1);

    // An application that does not own the certificate is not told about it.
    const clara = await cp.login("clara");
    expect(codes(await dashboard(clara, "?environment=dev"))).not.toContain("certificate-expiring");
  });
});

describe("a subscription's own health", () => {
  async function subscribed(quotaCalls: number | null = 10) {
    const api = await publishApi(cp, {
      backendUrl: backend.url,
      policy: {
        "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
        ...(quotaCalls === null
          ? {}
          : {
              quota: {
                calls: quotaCalls,
                periodSec: 3600,
                per: "fleet",
                by: "subscription",
                scope: "route",
              },
            }),
      },
    });
    return api;
  }

  function spend(subscriptionId: string, resourceId: string, count: number) {
    cp.app.db.run(
      `INSERT INTO usage_counter (subscription_id, environment, scope_kind, scope_id, period_sec,
                                  window_start, count, updated_at)
       VALUES (?, 'dev', 'route', ?, 3600, ?, ?, ?)`,
      [subscriptionId, resourceId, iso(-60_000), count, iso(0)],
    );
  }

  test("80% of the quota, then all of it", async () => {
    const api = await subscribed(10);
    spend(api.subscriptionId!, api.resourceId, 8);
    const warned = await dashboard(api.clara, "?environment=dev");
    const eighty = find(warned, "quota-80")!;
    expect(eighty.severity).toBe("warning");
    expect(eighty.detail).toContain("80%");
    expect(eighty.detail).toContain("8 of 10");
    expect(eighty.href).toBe(`/subscriptions/${api.subscriptionId}`);
    expect(warned.consumer.subscriptions[0]!.quota).toMatchObject({ limit: 10, used: 8 });

    cp.app.db.run("UPDATE usage_counter SET count = 10");
    const exhausted = find(await dashboard(api.clara, "?environment=dev"), "quota-exhausted")!;
    expect(exhausted.severity).toBe("blocker");
    expect(exhausted.detail).toContain("Calls are being refused");
  });

  test('a subscription with no quota says "no quota" rather than 0 of 0', async () => {
    const api = await subscribed(null);
    spend(api.subscriptionId!, api.resourceId, 5);
    const dash = await dashboard(api.clara, "?environment=dev");
    // null is the whole point: `0 / 0` would read as "exhausted" (plan §6.2).
    expect(dash.consumer.subscriptions[0]!.quota).toBeNull();
    expect(codes(dash)).not.toContain("quota-80");
    expect(codes(dash)).not.toContain("quota-exhausted");
  });

  test("a key nobody has rotated past the warn threshold, and one past the deadline", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const age = (days: number) =>
      cp.app.db.run(
        "UPDATE subscription SET created_at = ?, primary_key_at = ? WHERE id = ?",
        [iso(-days * DAY), iso(-days * DAY), api.subscriptionId!],
      );

    // Past `SUBSCRIPTION_KEY_WARN_DAYS` (365) and short of the deadline: a warning, and it says
    // both numbers, because "old" without "and it stops at" is not a deadline.
    age(400);
    const warned = find(await dashboard(api.clara), "key-ageing")!;
    expect(warned.severity).toBe("warning");
    expect(warned.detail).toContain("400 days old");
    expect(warned.detail).toContain("600");
    // The reason it is safe to do: rotation gives a second key first.
    expect(warned.detail).toContain("second key");
    expect((await dashboard(api.clara)).consumer.subscriptions[0]!.keyAgeDays).toBe(400);

    // Past `SUBSCRIPTION_KEY_EXPIRE_DAYS` (600) the job retires the slot, and the row becomes a
    // blocker because the caller's requests are already being refused.
    age(700);
    runDueJobs(cp.app);
    const expired = find(await dashboard(api.clara), "key-expired")!;
    expect(expired.severity).toBe("blocker");
    expect(expired.detail).toContain("no longer accepts it");
    expect(codes(await dashboard(api.clara))).not.toContain("key-ageing");
  });

  test("an API you subscribe to that is deprecated, then retired", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url });
    const resource = (await (
      await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel })
    ).json()) as { updatedAt: string };
    const etag = (await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel })).headers.get(
      "etag",
    )!;
    expect(resource.updatedAt).toBeDefined();

    await cp.call("PATCH", `/api/resources/${api.resourceId}`, {
      cookie: api.pavel,
      headers: { "if-match": etag },
      body: { lifecycle: "deprecated", sunsetAt: iso(30 * DAY) },
    });
    const deprecated = find(await dashboard(api.clara), "subscribed-api-deprecated")!;
    expect(deprecated.subject.kind).toBe("subscription");
    expect(deprecated.detail).toContain("deprecated");
    expect(deprecated.detail).toContain("stop serving on");
    expect(deprecated.href).toBe(`/apis/${api.resourceId}`);

    cp.app.db.run("UPDATE resource SET lifecycle = 'retired' WHERE id = ?", [api.resourceId]);
    const retired = find(await dashboard(api.clara), "subscribed-api-retired")!;
    expect(retired.severity).toBe("blocker");
    expect(retired.detail).toContain("no longer served");
  });
});

describe("the estate", () => {
  test("a gateway that has never reported, and one that refused its configuration", async () => {
    const pavel = await cp.login("pavel");
    const before = await dashboard(pavel, "?environment=dev");
    // seedBaseline mints two DEV instances and neither has polled.
    const stale = before.platform.attention.filter((row) => row.code === "gateway-stale");
    expect(stale).toHaveLength(2);
    expect(stale[0]!.detail).toContain("never reported");
    expect(stale[0]!.subject.kind).toBe("instance");
    expect(stale[0]!.href).toBe("/fleet?environment=dev");

    await poll(cp, { activationBlocked: "artifact sha256:abc is not in the cache yet" });
    const after = await dashboard(pavel, "?environment=dev");
    const blocked = find(after, "gateway-activation-blocked")!;
    expect(blocked.severity).toBe("blocker");
    expect(blocked.detail).toContain("still serving the previous one");
    expect(blocked.detail).toContain("artifact sha256:abc");
    // It polled, so it is no longer stale — the two facts are independent.
    expect(after.platform.attention.filter((row) => row.code === "gateway-stale")).toHaveLength(1);
  });

  test("a failed background job is an operator's row, not everyone's", async () => {
    const alice = await cp.login("alice");
    const pavel = await cp.login("pavel");
    cp.app.db.run(
      `INSERT INTO job (id, kind, state, payload, attempts, result, created_at, updated_at)
       VALUES ('job_1', 'reconcile', 'failed', '{}', 3, 'the resource has no route', ?, ?)`,
      [iso(-1000), iso(0)],
    );

    const admin = await dashboard(alice);
    const row = find(admin, "job-failed")!;
    expect(row.subject).toEqual({ kind: "job", id: "job_1", name: "reconcile" });
    expect(row.detail).toContain("3 attempt");
    expect(row.href).toBe("/fleet");
    expect(admin.platform.admin!.failedJobs).toBe(1);

    // It carries an internal message and needs an operator, so it is not shown to an owner.
    expect(codes(await dashboard(pavel))).not.toContain("job-failed");
  });
});

// --------------------------------------------------------------------------- one evaluator

describe("one evaluator", () => {
  test("the API page's banner is the dashboard's rows for that API", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url, policy: {} });
    const dash = await dashboard(api.pavel, "?environment=all");
    const resource = (await (
      await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.pavel })
    ).json()) as { attention: AttentionRow[] };
    observed.push(...resource.attention);

    const mine = dash.owner.attention.filter((row) => row.subject.id === api.resourceId);
    expect(resource.attention).toEqual(mine);
    expect(resource.attention.length).toBeGreaterThan(0);
  });

  test("another application's API page carries no rows for a caller who cannot act on them", async () => {
    const api = await publishApi(cp, { backendUrl: backend.url, policy: {} });
    const resource = (await (
      await cp.call("GET", `/api/resources/${api.resourceId}`, { cookie: api.clara })
    ).json()) as { attention: AttentionRow[] };
    // A consumer can read the API; "attach an authentication policy" is not their row to act on.
    expect(resource.attention).toEqual([]);
  });
});

// --------------------------------------------------------------------------- the vocabulary

describe("the vocabulary", () => {
  test("every code carries a severity, and no rule invents one", () => {
    for (const code of ATTENTION_CODES) expect(ATTENTION_SEVERITY[code]).toBeDefined();
    for (const row of observed) {
      expect(ATTENTION_CODES).toContain(row.code);
      expect(row.severity).toBe(ATTENTION_SEVERITY[row.code]);
    }
  });

  test("every row names a subject, a screen and a sentence", () => {
    for (const row of observed) {
      expect(row.subject.id.length).toBeGreaterThan(0);
      expect(row.subject.name.length).toBeGreaterThan(0);
      // A href is a portal path, and one built from an undefined id is a broken link that looks
      // fine in a screenshot.
      expect(row.href).toMatch(/^\/[A-Za-z0-9/?=&_.-]*$/);
      expect(row.href).not.toContain("undefined");
      expect(row.href).not.toContain("null");
      expect(row.detail.trim().endsWith(".")).toBe(true);
      expect(row.detail.length).toBeGreaterThan(30);
    }
  });
});

/**
 * The coverage guard: a code nobody can produce is a promise the UI renders and the platform never
 * keeps, and a rule producing a code the list does not have would be caught above. Both directions,
 * once, at the end of the file.
 */
afterAll(() => {
  const produced = new Set(observed.map((row) => row.code));
  const missing = ATTENTION_CODES.filter((code) => !produced.has(code));
  if (missing.length > 0) {
    throw new Error(`no test produced these attention codes: ${missing.join(", ")}`);
  }
});

test("selected application scopes dashboard counts for a multi-application administrator", async () => {
  makeResource("publisher-one");
  makeResource("publisher-two");
  makeResource("consumer-owned", "application_orders");
  const cookie = await cp.login("alice");
  const publisher = await dashboard(cookie, "?environment=dev&applicationId=application_platform");
  const consumer = await dashboard(cookie, "?environment=dev&applicationId=application_orders");
  expect(publisher.owner.apis.total).toBe(2);
  expect(consumer.owner.apis.total).toBe(1);
  expect((await dashboard(cookie, "?environment=dev")).owner.apis.total).toBe(3);
});

test("dashboard application scope rejects unknown and unauthorized applications", async () => {
  const admin = await cp.login("alice");
  const publisher = await cp.login("pavel");
  expect((await cp.call("GET", "/api/dashboard?applicationId=missing", {cookie:admin})).status).toBe(404);
  expect((await cp.call("GET", "/api/dashboard?applicationId=application_orders", {cookie:publisher})).status).toBe(403);
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { readSettingOverrides, settingsFor } from "../control-plane/src/settings.ts";
import { GATEWAY_SETTING_DEFS } from "../shared/gateway-settings.ts";
import {
  makeCp,
  makeDp,
  publishApi,
  serveCp,
  setFleetSettings,
  startBackend,
  type TestCp,
} from "./helpers.ts";

/**
 * Gateway settings, end to end: the three layers in the database, the resolved block in the
 * configuration document, and a running gateway applying it without a restart.
 *
 * `test/gateway-settings.test.ts` holds the resolver on its own. What is here is everything that
 * needs a control plane, a gateway, or both.
 */

let cp: TestCp;
let admin: string;
let member: string;

/** The gateway `TARGETS_FILE` starts DEV with, which every seeded replica belongs to. */
function devGateway(): { id: string; name: string } {
  return cp.app.db
    .query<{ id: string; name: string }, []>(
      "SELECT id, name FROM target WHERE environment = 'dev' ORDER BY name",
    )
    .get()!;
}

async function addGateway(name: string): Promise<string> {
  const response = await cp.call("POST", "/api/gateways", {
    body: { environment: "dev", name },
    cookie: admin,
  });
  expect(response.status).toBe(201);
  return cp.app.db
    .query<{ id: string }, [string]>("SELECT id FROM target WHERE environment = 'dev' AND name = ?")
    .get(name)!.id;
}

function patch(body: unknown, cookie = admin) {
  return cp.call("PATCH", "/api/gateway-settings", { body, cookie });
}

beforeEach(async () => {
  cp = makeCp();
  admin = await cp.login("alice");
  member = await cp.login("pavel");
});

afterEach(() => {
  cp.close();
});

describe("the settings endpoints", () => {
  test("anybody may read the model, and it carries the table, the layers and the gateways", async () => {
    const response = await cp.call("GET", "/api/gateway-settings", { cookie: member });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defs: Record<string, { env: string; label: string }>;
      scopes: string[];
      environments: string[];
      gateways: Array<{ id: string; environment: string; name: string }>;
      overrides: unknown[];
      effective: {
        fleet: Record<string, { value: unknown; scope: string | null }>;
        environments: Record<string, unknown>;
        gateways: Record<string, unknown>;
      };
    };
    expect(body.scopes).toEqual(["fleet", "environment", "gateway"]);
    expect(body.defs.maxBodyBytes!.env).toBe("MAX_BODY_BYTES");
    expect(body.environments).toContain("dev");
    expect(body.gateways.some((gateway) => gateway.environment === "dev")).toBe(true);
    expect(body.overrides).toEqual([]);
    // Every layer resolves to something, so the screen never has a blank field to explain.
    expect(body.effective.fleet.maxBodyBytes).toEqual({
      value: GATEWAY_SETTING_DEFS.maxBodyBytes.default,
      scope: null,
    });
    expect(Object.keys(body.effective.gateways)).toContain(devGateway().id);
  });

  test("writing is admin-only", async () => {
    const refused = await patch(
      { scope: "fleet", scopeId: "", values: { maxBodyBytes: 65536 } },
      member,
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).detail).toContain("admin-only");
    expect(readSettingOverrides(cp.app.db)).toEqual([]);
  });

  test("a value outside its bounds is refused, naming the setting and the variable", async () => {
    const response = await patch({
      scope: "fleet",
      scopeId: "",
      values: { validatePoolSize: 9999 },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain(
      "validatePoolSize (VALIDATE_POOL_SIZE): expected 1–256",
    );
    // Refused as a whole: nothing lands, so a screen's worth of edits is never half-applied.
    expect(readSettingOverrides(cp.app.db)).toEqual([]);
  });

  test("a set is all-or-nothing", async () => {
    const response = await patch({
      scope: "fleet",
      scopeId: "",
      values: { maxBodyBytes: 65536, validateQueueDepth: 0 },
    });
    expect(response.status).toBe(400);
    expect(readSettingOverrides(cp.app.db)).toEqual([]);
  });

  test("a scope id that names nothing is refused rather than stored", async () => {
    const badEnvironment = await patch({
      scope: "environment",
      scopeId: "staging",
      values: { telemetry: false },
    });
    expect(badEnvironment.status).toBe(400);
    expect((await badEnvironment.json()).detail).toContain("not an environment in PROMOTION_CHAIN");

    const badGateway = await patch({
      scope: "gateway",
      scopeId: "tgt_nope",
      values: { telemetry: false },
    });
    expect(badGateway.status).toBe(400);
    expect((await badGateway.json()).detail).toContain("not a gateway");

    const fleetWithId = await patch({
      scope: "fleet",
      scopeId: "dev",
      values: { telemetry: false },
    });
    expect(fleetWithId.status).toBe(400);
    expect((await fleetWithId.json()).detail).toContain("takes no scope id");
  });

  test("an unknown setting is refused and the message lists the ones that exist", async () => {
    const response = await patch({ scope: "fleet", scopeId: "", values: { turboMode: 1 } });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("turboMode is not a gateway setting");
    expect((await patch({ scope: "sideways", scopeId: "", values: {} })).status).toBe(400);
  });

  test("null clears an override, and the layer below is inherited again", async () => {
    await patch({ scope: "fleet", scopeId: "", values: { jwksMinRefetchSec: 300 } });
    await patch({ scope: "environment", scopeId: "dev", values: { jwksMinRefetchSec: 30 } });
    const gateway = devGateway();
    expect(settingsFor(cp.app.db, { environment: "dev", targetId: gateway.id }).jwksMinRefetchSec).toBe(30);

    const cleared = await patch({
      scope: "environment",
      scopeId: "dev",
      values: { jwksMinRefetchSec: null },
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ changed: [], cleared: ["jwksMinRefetchSec"] });
    expect(settingsFor(cp.app.db, { environment: "dev", targetId: gateway.id }).jwksMinRefetchSec).toBe(300);
  });

  test("a write is audited, and the entry names a sensitive setting as sensitive", async () => {
    await patch({ scope: "fleet", scopeId: "", values: { accessLog: false, maxBodyBytes: 65536 } });
    const audit = cp.app.db
      .query<{ action: string; subject: string; detail: string }, []>(
        "SELECT action, subject, detail FROM audit WHERE action = 'gateway-settings.write'",
      )
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subject).toBe("fleet:*");
    const detail = JSON.parse(audit[0]!.detail) as {
      set: Record<string, unknown>;
      sensitive: string[];
    };
    expect(detail.set).toEqual({ accessLog: false, maxBodyBytes: 65536 });
    // The access log is a compliance record, so turning it off is the event worth finding later.
    expect(detail.sensitive).toEqual(["accessLog"]);
  });

  test("removing a gateway takes its overrides with it", async () => {
    const id = await addGateway("onprem");
    await patch({ scope: "gateway", scopeId: id, values: { maxConcurrentRequests: 256 } });
    expect(readSettingOverrides(cp.app.db)).toHaveLength(1);

    const removed = await cp.call("DELETE", "/api/gateways/dev/onprem", { cookie: admin });
    expect(removed.status).toBe(200);
    // Otherwise the next gateway to be handed this id would inherit a stranger's ceiling.
    expect(readSettingOverrides(cp.app.db)).toEqual([]);
  });
});

describe("the configuration document", () => {
  test("carries the settings resolved for the gateway that asked", async () => {
    const managed = devGateway();
    const onprem = await addGateway("onprem");
    await patch({ scope: "fleet", scopeId: "", values: { maxConcurrentRequests: 4096 } });
    await patch({ scope: "gateway", scopeId: onprem, values: { maxConcurrentRequests: 512 } });

    const forManaged = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, managed.id);
    const forOnprem = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, onprem);
    expect(forManaged.settings.maxConcurrentRequests).toBe(4096);
    expect(forOnprem.settings.maxConcurrentRequests).toBe(512);
    // Two gateways in one environment, two documents, and the difference is visible in the digest
    // — which is what makes convergence trackable without a second mechanism.
    expect(forManaged.digest).not.toBe(forOnprem.digest);
  });

  test("a settings change is a new digest, so the fleet view already tracks it", () => {
    const gateway = devGateway();
    const before = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, gateway.id);
    setFleetSettings(cp, { responseCacheMaxEntries: 50 });
    const after = buildConfig(cp.app.db, cp.app.kek, "dev", cp.app.config.integrations, gateway.id);
    expect(after.digest).not.toBe(before.digest);
    expect(after.settings.responseCacheMaxEntries).toBe(50);
  });
});

describe("a running gateway", () => {
  let served: ReturnType<typeof serveCp>;
  let backend: ReturnType<typeof startBackend>;

  beforeEach(() => {
    served = serveCp(cp);
    backend = startBackend();
  });

  afterEach(() => {
    backend.stop();
    served.stop();
  });

  test("applies a changed setting on its next poll, with no restart", async () => {
    const published = await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { rewrite: { stripBasePath: true } },
    });
    const dp = makeDp(served.url, cp.token, cp.dir, { pollIntervalMs: 3_600_000 });
    try {
      await dp.client.pollOnce();
      expect(dp.settings.maxBodyBytes).toBe(GATEWAY_SETTING_DEFS.maxBodyBytes.default);

      // Valid JSON, because the fixture's route validates the body — the cap under test is about
      // size, and a malformed body would be refused for the wrong reason.
      const post = (bytes: number) => {
        const body = JSON.stringify({ pad: "x".repeat(bytes) });
        return dp.fetchHttp(
          new Request(`http://gateway.test${published.basePath}/pet`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            },
            body,
          }),
          "203.0.113.7",
        );
      };
      expect((await post(2048)).status).toBe(200);

      setFleetSettings(cp, { maxBodyBytes: 1024 });
      await dp.client.pollOnce();
      expect(dp.settings.maxBodyBytes).toBe(1024);
      expect((await post(2048)).status).toBe(413);
      // The live components followed the same document, not just the record of it.
      expect(dp.gate.maxTotal).toBe(GATEWAY_SETTING_DEFS.maxConcurrentRequests.default);
      expect((dp.health().settings as { maxBodyBytes: number }).maxBodyBytes).toBe(1024);
    } finally {
      dp.stop();
    }
  });

  test("refuses a document whose ceiling this container cannot honour, and keeps serving", async () => {
    await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { rewrite: { stripBasePath: true } },
    });
    const dp = makeDp(served.url, cp.token, cp.dir, { pollIntervalMs: 3_600_000 });
    const original = process.env.BUN_CONFIG_MAX_HTTP_REQUESTS;
    try {
      await dp.client.pollOnce();
      const good = dp.client.table!.digest;

      // What an administrator can do from a browser that no boot check can catch: name a ceiling
      // above what this particular container's runtime will honour.
      process.env.BUN_CONFIG_MAX_HTTP_REQUESTS = "1024";
      setFleetSettings(cp, { maxConcurrentRequests: 8192 });
      expect(await dp.client.pollOnce()).toBe("blocked");
      expect(dp.client.activationBlocked).toContain("BUN_CONFIG_MAX_HTTP_REQUESTS (1024)");
      // Still serving the last configuration it accepted, on the settings that came with it.
      expect(dp.client.table!.digest).toBe(good);
      expect(dp.settings.maxConcurrentRequests).toBe(
        GATEWAY_SETTING_DEFS.maxConcurrentRequests.default,
      );
      expect(dp.gate.maxTotal).toBe(GATEWAY_SETTING_DEFS.maxConcurrentRequests.default);

      // Correcting it centrally is enough; the instance needs nothing done to it.
      setFleetSettings(cp, { maxConcurrentRequests: 1024 });
      expect(await dp.client.pollOnce()).toBe("updated");
      expect(dp.client.activationBlocked).toBeNull();
      expect(dp.gate.maxTotal).toBe(1024);
    } finally {
      if (original === undefined) delete process.env.BUN_CONFIG_MAX_HTTP_REQUESTS;
      else process.env.BUN_CONFIG_MAX_HTTP_REQUESTS = original;
      dp.stop();
    }
  });

  test("comes back on the fleet's settings after a restart during an outage", async () => {
    await publishApi(cp, {
      backendUrl: backend.url,
      basePath: "/petstore",
      policy: { rewrite: { stripBasePath: true } },
    });
    setFleetSettings(cp, { responseCacheMaxEntries: 7, telemetry: false });
    const first = makeDp(served.url, cp.token, cp.dir, { name: "restarts", pollIntervalMs: 3_600_000 });
    await first.client.pollOnce();
    expect(first.settings.responseCacheMaxEntries).toBe(7);
    first.stop();

    // The control plane is gone; everything this instance knows comes off its own disk.
    served.stop();
    const second = makeDp("http://127.0.0.1:1", cp.token, cp.dir, {
      name: "restarts",
      pollIntervalMs: 3_600_000,
    });
    try {
      expect(second.client.loadFromCache()).toBe(true);
      // Not the build's defaults: an estate that had turned counting off does not turn it back on
      // because a container was restarted while the portal was down.
      expect(second.settings.responseCacheMaxEntries).toBe(7);
      expect(second.settings.telemetry).toBe(false);
    } finally {
      second.stop();
      served = serveCp(cp);
    }
  });
});

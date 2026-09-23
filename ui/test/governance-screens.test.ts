import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetHealth, TelemetryInstanceRow } from "../src/api.ts";
import { replicasByGateway, uptime } from "../src/views/TelemetryView.tsx";
import { unitDraftError } from "../src/views/GlobalPolicyView.tsx";
import { matchAudit, PAGE, subjectHref } from "../src/views/AuditView.tsx";
import {
  auditOutcomeChip,
  tlsExceptionChip,
  tlsModeChip,
  validationChip,
} from "../src/lib/status.ts";

/**
 * The decisions on Telemetry, Global policy, Trust and Audit that are not markup: what a breakdown
 * is grouped by, when a draft may be saved, where an audit subject links, and which words a state
 * is given. The server halves are in `test/` against a control plane the test owns.
 */

const SRC = join(import.meta.dir, "..", "src");

function replica(instanceId: string, name: string): TelemetryInstanceRow {
  return { instanceId, name, share: 0, revoked: false, process: null } as unknown as TelemetryInstanceRow;
}

describe("Telemetry", () => {
  test("the per-instance breakdown is grouped by the gateway each replica belongs to", () => {
    const health = {
      instances: [
        { id: "i1", gateway: "onprem" },
        { id: "i2", gateway: "managed" },
        { id: "i3", gateway: "managed" },
      ],
      gateways: [
        { name: "managed", label: "Managed" },
        { name: "onprem", label: null },
      ],
    } as unknown as FleetHealth;
    const rows = replicasByGateway(
      [replica("i3", "m-2"), replica("i1", "o-1"), replica("i9", "ghost"), replica("i2", "m-1")],
      health,
    );
    expect(rows.map((row) => [row.gateway, row.name])).toEqual([
      ["Managed", "m-1"],
      ["Managed", "m-2"],
      ["onprem", "o-1"],
      // Not placed by the health read: last, and not guessed.
      [null, "ghost"],
    ]);
  });

  test("without the health read no replica is given a gateway", () => {
    expect(replicasByGateway([replica("i1", "a")], null)[0]!.gateway).toBeNull();
  });

  test("uptime reads in the unit a person would say", () => {
    expect(uptime(undefined)).toBe("—");
    expect(uptime(20)).toBe("1 min");
    expect(uptime(45 * 60)).toBe("45 min");
    expect(uptime(5 * 3600)).toBe("5 h");
    expect(uptime(3 * 86400)).toBe("3 days");
  });

  test("the chart axis is the reader's local clock, not the UTC string sliced", () => {
    const source = readFileSync(join(SRC, "views", "TelemetryView.tsx"), "utf8");
    expect(source).toContain("formatClock(point.windowStart)");
    expect(source).not.toMatch(/windowStart\.slice/);
  });

  test("the breakdown is labelled by what it counts", () => {
    const source = readFileSync(join(SRC, "views", "TelemetryView.tsx"), "utf8");
    expect(source).toContain('title="By replica"');
    expect(source).not.toContain('title="By gateway"');
  });
});

describe("Global policy", () => {
  test("a draft of the wrong shape is caught before the control plane is asked", () => {
    expect(unitDraftError([1], { perMinute: 60 })).toMatch(/takes an object/);
    expect(unitDraftError("30s", 30000)).toMatch(/takes a number/);
    expect(unitDraftError({}, [])).toMatch(/takes a list/);
  });

  test("a draft of the right shape is left to the control plane", () => {
    expect(unitDraftError({ perMinute: 5 }, { perMinute: 60 })).toBeNull();
    expect(unitDraftError(2500, 30000)).toBeNull();
    // A unit without a meaningful default has no shape to hold a draft to.
    expect(unitDraftError({ a: 1 }, null)).toBeNull();
  });

  test("a unit is edited with the per-API workspace's own form, not a JSON box", () => {
    const source = readFileSync(join(SRC, "views", "GlobalPolicyView.tsx"), "utf8");
    expect(source).toContain("<UnitForm");
    expect(source).not.toContain("<textarea");
  });

  test("the screen draws no environment picker of its own", () => {
    const source = readFileSync(join(SRC, "views", "GlobalPolicyView.tsx"), "utf8");
    expect(source).not.toContain("EnvironmentPicker");
    expect(source).not.toContain("onEnvironment");
  });

  test("detaching a global unit asks first", () => {
    const source = readFileSync(join(SRC, "views", "GlobalPolicyView.tsx"), "utf8");
    const del = source.indexOf("api.del(");
    const dialog = source.lastIndexOf("<Modal", del);
    expect(dialog).toBeGreaterThan(-1);
    expect(source.slice(dialog, del)).not.toContain("</Modal>");
  });
});

describe("Trust", () => {
  test("every exception can be re-checked from its row", () => {
    const source = readFileSync(join(SRC, "views", "TrustView.tsx"), "utf8");
    expect(source).toContain("/api/trust/exceptions/${row.id}/check");
  });

  test("a mode is named by what is still checked", () => {
    expect(tlsModeChip("pin").tone).toBe("live");
    expect(tlsModeChip("skip-hostname").tone).toBe("warn");
    expect(tlsModeChip("insecure")).toMatchObject({ label: "Not verified", tone: "stop" });
  });

  test("an exception's chip says whether it is still in force", () => {
    expect(tlsExceptionChip({ live: false, revokedAt: "2026-01-01T00:00:00Z", expiresInDays: 3 }).label).toBe("Revoked");
    expect(tlsExceptionChip({ live: false, revokedAt: null, expiresInDays: -1 }).label).toBe("Expired");
    expect(tlsExceptionChip({ live: true, revokedAt: null, expiresInDays: 5 }).tone).toBe("warn");
    expect(tlsExceptionChip({ live: true, revokedAt: null, expiresInDays: 1 }).label).toBe("1 day left");
    expect(tlsExceptionChip({ live: true, revokedAt: null, expiresInDays: 40 }).tone).toBe("neutral");
  });

  test("no trust screen writes an environment in lower case or by hand", () => {
    for (const file of ["TrustView.tsx", "TrustAnchors.tsx"]) {
      expect(readFileSync(join(SRC, "views", file), "utf8"), file).not.toContain(".toUpperCase()");
    }
  });
});

describe("Audit", () => {
  test("a subject links to the screen for its kind", () => {
    expect(subjectHref("resource:res_1")).toBe("/apis/res_1");
    expect(subjectHref("application:app_1")).toBe("/applications/app_1");
    expect(subjectHref("user:u 1")).toBe("/users/u%201");
    expect(subjectHref("environment:prod")).toBeNull();
    expect(subjectHref("retention")).toBeNull();
  });

  test("search covers the names shown as well as the ids stored", () => {
    const rows = [
      { id: "1", at: "", actor: "u1", actorName: "Alice Novak", action: "resource.create", subject: "resource:r1", subjectName: "orders v1", outcome: "ok", detail: null },
      { id: "2", at: "", actor: "u2", actorName: "Pavel", action: "user.disable", subject: "user:u3", subjectName: null, outcome: "denied", detail: null },
    ];
    expect(matchAudit(rows, "alice").map((row) => row.id)).toEqual(["1"]);
    expect(matchAudit(rows, "ORDERS").map((row) => row.id)).toEqual(["1"]);
    expect(matchAudit(rows, "user:u3").map((row) => row.id)).toEqual(["2"]);
    expect(matchAudit(rows, "  ")).toHaveLength(2);
  });

  test("the loaded events are drawn a page at a time", () => {
    expect(PAGE).toBeLessThan(200);
  });

  test("an outcome is said in words", () => {
    expect(auditOutcomeChip("ok")).toMatchObject({ label: "Succeeded", tone: "live" });
    expect(auditOutcomeChip("denied")).toMatchObject({ label: "Refused", tone: "stop" });
    expect(auditOutcomeChip("failed").tone).toBe("stop");
  });
});

describe("validation states", () => {
  test("only blocking is enforcement", () => {
    expect(validationChip("blocking").tone).toBe("live");
    expect(validationChip("warning").tone).toBe("warn");
    expect(validationChip("disabled").tone).toBe("stop");
  });
});

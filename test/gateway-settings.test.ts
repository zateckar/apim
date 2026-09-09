import { describe, expect, test } from "bun:test";
import {
  clampSetting,
  defaultGatewaySettings,
  GATEWAY_SETTING_DEFS,
  GATEWAY_SETTING_KEYS,
  isSettingKey,
  parseSetting,
  resolveGatewaySettings,
  resolveGatewaySettingSources,
  SETTING_SCOPES,
  type SettingOverride,
  type SettingSubject,
} from "../shared/gateway-settings.ts";

const subject: SettingSubject = { environment: "prod", targetId: "tgt_managed" };
const other: SettingSubject = { environment: "dev", targetId: "tgt_onprem" };

function override(
  scope: SettingOverride["scope"],
  scopeId: string,
  key: SettingOverride["key"],
  value: SettingOverride["value"],
): SettingOverride {
  return { scope, scopeId, key, value };
}

describe("the settings table", () => {
  test("every key has a label, a purpose and the variable it replaces", () => {
    for (const key of GATEWAY_SETTING_KEYS) {
      const def = GATEWAY_SETTING_DEFS[key];
      expect(def.label.length, key).toBeGreaterThan(0);
      expect(def.purpose.length, key).toBeGreaterThan(0);
      // The screen renders these; a key without them would be a knob nobody can explain.
      expect(def.env, key).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  test("every numeric default sits inside its own bounds", () => {
    for (const key of GATEWAY_SETTING_KEYS) {
      const def = GATEWAY_SETTING_DEFS[key];
      if (def.kind === "flag") continue;
      const value = def.default as number;
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(def.min ?? 0);
      expect(value, key).toBeLessThanOrEqual(def.max ?? Number.MAX_SAFE_INTEGER);
    }
  });

  test("no two settings replace the same variable", () => {
    const seen = new Set<string>();
    for (const key of GATEWAY_SETTING_KEYS) {
      const { env } = GATEWAY_SETTING_DEFS[key];
      expect(seen.has(env), env).toBe(false);
      seen.add(env);
    }
  });

  test("the poll interval is not a setting", () => {
    // It is the cadence of the channel the settings arrive on, so a mistake in it slows down its
    // own correction. It stays beside GATEWAY_CP_URL as part of how a container reaches the
    // control plane.
    expect(isSettingKey("pollIntervalSec")).toBe(false);
    expect(GATEWAY_SETTING_KEYS.map((key) => GATEWAY_SETTING_DEFS[key].env)).not.toContain(
      "POLL_INTERVAL_SEC",
    );
  });

  test("every setting is one a running instance can apply, so none of them mention a restart", () => {
    for (const key of GATEWAY_SETTING_KEYS) {
      expect(GATEWAY_SETTING_DEFS[key].purpose.toLowerCase(), key).not.toContain("restart");
    }
  });

  test("the access log is the one setting marked as a promise outside engineering", () => {
    const sensitive = GATEWAY_SETTING_KEYS.filter((key) => GATEWAY_SETTING_DEFS[key].sensitive);
    expect(sensitive).toEqual(["accessLog"]);
  });
});

describe("resolution", () => {
  test("an estate with no overrides gets this build's defaults, and every key", () => {
    const resolved = resolveGatewaySettings([], subject);
    expect(resolved).toEqual(defaultGatewaySettings());
    expect(Object.keys(resolved).sort()).toEqual([...GATEWAY_SETTING_KEYS].sort());
  });

  test("gateway beats environment beats fleet", () => {
    const overrides = [
      override("fleet", "", "maxConcurrentRequests", 100),
      override("environment", "prod", "maxConcurrentRequests", 200),
      override("gateway", "tgt_managed", "maxConcurrentRequests", 300),
    ];
    expect(resolveGatewaySettings(overrides, subject).maxConcurrentRequests).toBe(300);
    // The precedence is the scope array's order, so the two cannot drift apart.
    expect(SETTING_SCOPES).toEqual(["fleet", "environment", "gateway"]);
  });

  test("an environment override does not leak into another environment", () => {
    const overrides = [override("environment", "prod", "jwksMinRefetchSec", 30)];
    expect(resolveGatewaySettings(overrides, subject).jwksMinRefetchSec).toBe(30);
    expect(resolveGatewaySettings(overrides, other).jwksMinRefetchSec).toBe(
      GATEWAY_SETTING_DEFS.jwksMinRefetchSec.default,
    );
  });

  test("a gateway override does not leak into another gateway in the same environment", () => {
    const overrides = [
      override("environment", "prod", "maxConcurrentRequests", 4096),
      override("gateway", "tgt_managed", "maxConcurrentRequests", 512),
    ];
    expect(resolveGatewaySettings(overrides, subject).maxConcurrentRequests).toBe(512);
    expect(
      resolveGatewaySettings(overrides, { environment: "prod", targetId: "tgt_second" })
        .maxConcurrentRequests,
    ).toBe(4096);
  });

  test("layers combine per key rather than per layer", () => {
    // The gateway sets one thing; it does not thereby stop inheriting the rest.
    const resolved = resolveGatewaySettings(
      [
        override("fleet", "", "telemetry", false),
        override("environment", "prod", "jwksMinRefetchSec", 5),
        override("gateway", "tgt_managed", "maxConcurrentRequests", 512),
      ],
      subject,
    );
    expect(resolved.telemetry).toBe(false);
    expect(resolved.jwksMinRefetchSec).toBe(5);
    expect(resolved.maxConcurrentRequests).toBe(512);
    expect(resolved.accessLog).toBe(GATEWAY_SETTING_DEFS.accessLog.default);
  });

  test("the source of each value is reported, so a screen can explain an inherited number", () => {
    const sources = resolveGatewaySettingSources(
      [
        override("fleet", "", "jwksMinRefetchSec", 5),
        override("gateway", "tgt_managed", "maxConcurrentRequests", 512),
      ],
      subject,
    );
    expect(sources.jwksMinRefetchSec).toEqual({ value: 5, scope: "fleet" });
    expect(sources.maxConcurrentRequests).toEqual({ value: 512, scope: "gateway" });
    expect(sources.accessLog).toEqual({ value: true, scope: null });
  });

  test("a row for an unknown key is ignored rather than fatal", () => {
    // A row written by a newer build, read by an older one. Refusing here would take a fleet down
    // on a downgrade; ignoring it means one knob reverts to its default and everything else serves.
    const overrides = [
      { scope: "fleet", scopeId: "", key: "somethingNewer", value: 7 } as unknown as SettingOverride,
      override("fleet", "", "jwksMinRefetchSec", 4),
    ];
    expect(resolveGatewaySettings(overrides, subject).jwksMinRefetchSec).toBe(4);
    expect(isSettingKey("somethingNewer")).toBe(false);
  });

  test("a stored value outside its bounds is clamped rather than served", () => {
    const overrides = [override("fleet", "", "jwksMinRefetchSec", 100_000)];
    expect(resolveGatewaySettings(overrides, subject).jwksMinRefetchSec).toBe(86_400);
  });

  test("a stored value of the wrong shape falls back to the default", () => {
    const overrides = [
      override("fleet", "", "telemetry", 1 as unknown as boolean),
      override("fleet", "", "maxBodyBytes", true as unknown as number),
    ];
    const resolved = resolveGatewaySettings(overrides, subject);
    expect(resolved.telemetry).toBe(true);
    expect(resolved.maxBodyBytes).toBe(GATEWAY_SETTING_DEFS.maxBodyBytes.default);
  });

  test("clamping keeps a legal value untouched", () => {
    expect(clampSetting("responseCacheMaxEntries", 0)).toBe(0);
    expect(clampSetting("accessLogKeep", 5)).toBe(5);
    expect(clampSetting("telemetry", false)).toBe(false);
  });
});

describe("writing a value", () => {
  test("an out-of-range number is refused, naming the setting, the variable and the bound", () => {
    expect(() => parseSetting("validatePoolSize", 9999)).toThrow(
      /validatePoolSize \(VALIDATE_POOL_SIZE\): expected 1–256, got 9999/,
    );
  });

  test("a non-integer is refused", () => {
    expect(() => parseSetting("maxBodyBytes", 1.5)).toThrow(/expected an integer/);
    expect(() => parseSetting("maxBodyBytes", "8388608")).toThrow(/expected an integer/);
  });

  test("a flag takes a boolean and nothing else", () => {
    expect(parseSetting("telemetry", false)).toBe(false);
    expect(() => parseSetting("telemetry", "off")).toThrow(/expected true or false/);
    expect(() => parseSetting("telemetry", 0)).toThrow(/expected true or false/);
  });

  test("a legal value is returned unchanged, never clamped on the way in", () => {
    expect(parseSetting("maxConcurrentRequests", 4096)).toBe(4096);
    expect(parseSetting("responseCacheMaxEntries", 0)).toBe(0);
  });
});

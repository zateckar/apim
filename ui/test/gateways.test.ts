import { describe, expect, test } from "bun:test";
import type { SettingDef } from "../src/api.ts";
import { gatewaySyncChip, PAUSED_CHIP, replicaChip } from "../src/lib/status.ts";
import { formatValue, parseAmount, unitFor } from "../src/views/GatewaySettingsView.tsx";

/**
 * The decisions on the gateway screens that are not markup: how a size or a duration is shown and
 * typed, and which words a replica and a gateway wear.
 *
 * The settings screen used to ask for bytes and seconds — an 8 MB body cap was `8388608` in a box —
 * so the conversion is the thing most worth pinning: a unit that rounds quietly is a capacity nobody
 * chose (gateway-settings, "Validate explicit overrides before saving").
 */

const MIB = 1024 ** 2;
const body: SettingDef = { env: "MAX_BODY_BYTES", kind: "bytes", default: 8 * MIB, min: 1024, max: 1024 * MIB, label: "Request body cap", purpose: "" };
const cache: SettingDef = { env: "RESPONSE_CACHE_MAX_BYTES", kind: "bytes", default: 64 * MIB, min: 0, max: 8192 * MIB, label: "Response cache size", purpose: "" };
const jwks: SettingDef = { env: "JWKS_MIN_REFETCH_SEC", kind: "seconds", default: 60, min: 1, max: 86_400, label: "JWKS refetch floor", purpose: "" };
const count: SettingDef = { env: "MAX_CONCURRENT_REQUESTS", kind: "count", default: 2048, min: 1, max: 1_000_000, label: "Concurrent requests", purpose: "" };
const flag: SettingDef = { env: "DP_TELEMETRY", kind: "flag", default: true, label: "Telemetry", purpose: "" };

describe("gateway settings, in units a person would type", () => {
  test("a value is shown in the largest unit it is a whole number of", () => {
    expect(formatValue(body, 8 * MIB)).toBe("8 MB");
    expect(formatValue(body, 1024)).toBe("1 KB");
    expect(formatValue(body, 1024 * MIB)).toBe("1 GB");
    expect(formatValue(body, 1536)).toBe("1.50 KB");
    expect(formatValue(body, 1500)).toBe("1.46 KB");
    expect(formatValue(body, 500)).toBe("500 bytes");
    expect(formatValue(cache, 0)).toBe("0 KB");
    expect(formatValue(jwks, 60)).toBe("1 min");
    expect(formatValue(jwks, 90)).toBe("90 s");
    expect(formatValue(jwks, 86_400)).toBe("24 h");
    expect(formatValue(count, 1_000_000)).toBe("1,000,000");
    expect(formatValue(flag, false)).toBe("Off");
  });

  test("the unit beside the input opens on the one the value reads best in", () => {
    expect(unitFor(body, 8 * MIB)).toBe("MB");
    expect(unitFor(body, 1536)).toBe("KB");
    expect(unitFor(cache, 0)).toBe("KB");
    expect(unitFor(jwks, 120)).toBe("min");
    expect(unitFor(jwks, 45)).toBe("s");
    expect(unitFor(count, 10)).toBe("");
  });

  test("what is typed is converted into the stored whole number", () => {
    expect(parseAmount(body, "16", "MB")).toEqual({ value: 16 * MIB, error: null });
    expect(parseAmount(body, "1.5", "MB")).toEqual({ value: 1.5 * MIB, error: null });
    expect(parseAmount(jwks, "2", "min")).toEqual({ value: 120, error: null });
    expect(parseAmount(count, "40", "")).toEqual({ value: 40, error: null });
  });

  test("a fraction of the stored unit is refused rather than rounded", () => {
    expect(parseAmount(body, "0.3", "KB").error).toContain("whole number of bytes");
    expect(parseAmount(jwks, "0.01", "min").error).toContain("whole number of seconds");
    expect(parseAmount(count, "1.5", "").error).toContain("whole number");
  });

  test("the bounds are refused in the same units the screen shows", () => {
    expect(parseAmount(body, "2", "GB").error).toBe("Enter 1 KB to 1 GB.");
    expect(parseAmount(body, "-1", "MB").error).toBe("Enter 1 KB to 1 GB.");
    expect(parseAmount(jwks, "25", "h").error).toBe("Enter 1 s to 24 h.");
    expect(parseAmount(count, "-1", "").error).not.toBeNull();
    expect(parseAmount(body, "abc", "MB").error).toBe("Enter a number.");
  });
});

describe("the gateway status words", () => {
  test("a replica that refused its document is not merely catching up", () => {
    // Left to `instanceChip` it read "Catching up", which tells an administrator to wait for
    // something that will never arrive on its own.
    const chip = replicaChip({ revoked: false, stale: false, current: false, refused: "artifact missing" });
    expect(chip.label).toBe("Refused config");
    expect(chip.tone).toBe("stop");
    expect(chip.title).toContain("artifact missing");
  });

  test("otherwise a replica wears the instance vocabulary, worst first", () => {
    expect(replicaChip({ revoked: true, stale: false, current: true, refused: "x" }).label).toBe("Revoked");
    expect(replicaChip({ revoked: false, stale: true, current: true, refused: "x" }).label).toBe("Not reporting");
    expect(replicaChip({ revoked: false, stale: false, current: false }).label).toBe("Catching up");
    expect(replicaChip({ revoked: false, stale: false, current: true, refused: null }).label).toBe("Healthy");
  });

  test("a gateway with nothing behind it is an outage, not a quiet one", () => {
    expect(gatewaySyncChip({ inSync: true, expectedReplicas: 0, behindReplicas: 0 }).tone).toBe("stop");
    expect(gatewaySyncChip({ inSync: true, expectedReplicas: 2, behindReplicas: 0 }).label).toBe("In sync");
    expect(gatewaySyncChip({ inSync: false, expectedReplicas: 3, behindReplicas: 1 }).label).toBe("1 behind");
    expect(PAUSED_CHIP.tone).toBe("warn");
  });
});

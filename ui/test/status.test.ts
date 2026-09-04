import { describe, expect, test } from "bun:test";
import {
  instanceChip,
  lifecycleChip,
  releaseChip,
  releasedInChip,
  subscriptionChip,
  STATUS_DOMAINS,
  type Chip,
  type Tone,
} from "../src/lib/status.ts";

/**
 * One status vocabulary (plan §9.4).
 *
 * Totality is the point: a state the server can produce and the UI has no word for renders as a
 * blank chip, and the reader concludes nothing is happening. So every value of every domain is
 * asked for by name.
 */

const TONES: Tone[] = ["live", "wait", "stop", "past", "warn", "neutral"];

function assertChip(chip: Chip, where: string) {
  expect(chip.label.length, where).toBeGreaterThan(0);
  expect(TONES, where).toContain(chip.tone);
  // The underlying state stays reachable: somebody debugging must be able to get from "Live" back
  // to `converged` without reading this file.
  expect(chip.title.length, where).toBeGreaterThan(chip.label.length);
}

describe("the status vocabulary", () => {
  test("names every release state", () => {
    for (const state of STATUS_DOMAINS.release) assertChip(releaseChip(state), state);
  });

  test("names every lifecycle except active, which is the absence of news", () => {
    for (const lifecycle of STATUS_DOMAINS.lifecycle) {
      const chip = lifecycleChip(lifecycle);
      if (lifecycle === "active") expect(chip).toBeNull();
      else assertChip(chip!, lifecycle);
    }
  });

  test("names every place a revision can stand in an environment", () => {
    for (const state of STATUS_DOMAINS.releasedIn) assertChip(releasedInChip(state), state);
  });

  test("names both subscription states", () => {
    for (const state of STATUS_DOMAINS.subscription) assertChip(subscriptionChip(state), state);
  });

  test("names every instance condition, worst first", () => {
    assertChip(instanceChip({ revoked: true, stale: true }), "revoked");
    expect(instanceChip({ revoked: true, stale: true }).label).toBe("Revoked");
    expect(instanceChip({ revoked: false, stale: true }).label).toBe("Not reporting");
    expect(instanceChip({ revoked: false, stale: false, inSync: false }).label).toBe("Catching up");
    expect(instanceChip({ revoked: false, stale: false, inSync: true }).label).toBe("Healthy");
  });

  test("no two release states share a tone and a label by accident", () => {
    // "Publishing" is deliberately shared by pending and converging — the difference does not
    // change what the reader should do. Nothing else may be.
    const seen = new Map<string, string[]>();
    for (const state of STATUS_DOMAINS.release) {
      const chip = releaseChip(state);
      seen.set(chip.label, [...(seen.get(chip.label) ?? []), state]);
    }
    for (const [label, states] of seen) {
      if (states.length > 1) expect(label).toBe("Publishing");
    }
  });

  test("a broken state never renders as a good one", () => {
    expect(releaseChip("failed").tone).toBe("stop");
    expect(releaseChip("stale").tone).toBe("stop");
    expect(lifecycleChip("retired")!.tone).toBe("stop");
    expect(subscriptionChip("revoked").tone).toBe("stop");
  });
});

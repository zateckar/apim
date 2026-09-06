import { describe, expect, test } from "bun:test";
import {
  instanceChip,
  integrationEventChip,
  kafkaGrantChip,
  kafkaTopicChip,
  lifecycleChip,
  operationChip,
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

  test("names every subscription state", () => {
    for (const state of STATUS_DOMAINS.subscription) assertChip(subscriptionChip(state), state);
  });

  test("names every operation state", () => {
    for (const state of STATUS_DOMAINS.operation) assertChip(operationChip(state), state);
  });

  test("names every Kafka topic state", () => {
    for (const state of STATUS_DOMAINS.kafkaTopic) assertChip(kafkaTopicChip(state), state);
  });

  test("names every Kafka grant state", () => {
    for (const state of STATUS_DOMAINS.kafkaGrant) assertChip(kafkaGrantChip(state), state);
  });

  test("names every integration event state", () => {
    for (const state of STATUS_DOMAINS.integrationEvent)
      assertChip(integrationEventChip(state), state);
  });

  const WORKFLOW_DOMAINS = [
    [STATUS_DOMAINS.operation, operationChip],
    [STATUS_DOMAINS.subscription, subscriptionChip],
    [STATUS_DOMAINS.kafkaTopic, kafkaTopicChip],
    [STATUS_DOMAINS.kafkaGrant, kafkaGrantChip],
    [STATUS_DOMAINS.integrationEvent, integrationEventChip],
  ] as const;

  function eachWorkflowChip(visit: (chip: Chip, state: string) => void) {
    for (const [states, chipFor] of WORKFLOW_DOMAINS) {
      for (const state of states) visit((chipFor as (s: string) => Chip)(state), state);
    }
  }

  /**
   * The rule that made these five domains worth writing, asserted rather than described.
   *
   * They used to go through a component that printed the column value with the hyphens swapped for
   * spaces, so a reader watching their own change go out was told "waiting for gateways" — a phrase
   * from the reconciler, with no tooltip saying what it was waiting for.
   *
   * `awaiting-decision` is the one state where that swap lands on the right words anyway, so it is
   * named here rather than reworded into something worse. Nothing else may be.
   */
  test("no chip is the column value with the hyphens taken out", () => {
    eachWorkflowChip((chip, state) => {
      if (!state.includes("-")) return;
      if (chip.label.toLowerCase() === state.replaceAll("-", " "))
        expect(state).toBe("awaiting-decision");
    });
  });

  test("every workflow chip keeps its column value reachable from the tooltip", () => {
    // Whatever the label says, somebody debugging must be able to get from "Rolling out" back to
    // `waiting-for-gateways` by hovering, without reading this file.
    eachWorkflowChip((chip, state) => expect(chip.title, state).toContain(state));
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
    expect(operationChip("blocked").tone).toBe("stop");
    expect(kafkaGrantChip("rejected").tone).toBe("stop");
    expect(integrationEventChip("rejected").tone).toBe("stop");
  });

  test("a state nobody has decided yet is not a state somebody refused", () => {
    // The two-branch `subscriptionChip` this replaced treated everything that was not `active` as
    // revoked, so a request still waiting for its publisher rendered as **Revoked** in `stop` — the
    // consumer read "they said no" and the publisher's Approvals queue still held the request.
    expect(subscriptionChip("pending").tone).toBe("wait");
    expect(subscriptionChip("activating").tone).toBe("wait");
    expect(kafkaGrantChip("pending").tone).toBe("wait");
    expect(integrationEventChip("awaiting-decision").tone).toBe("wait");
  });

  test("only a finished operation is live", () => {
    for (const state of STATUS_DOMAINS.operation) {
      if (state !== "complete") expect(operationChip(state).tone, state).not.toBe("live");
    }
    expect(operationChip("complete").tone).toBe("live");
  });
});

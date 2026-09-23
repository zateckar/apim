import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kafkaProxyChip, mailChip, operationKindLabel } from "../src/lib/status.ts";
import { approvalFilterOptions, awaitingDecision, proxyCall } from "../src/portal/processes.tsx";

/**
 * The decisions behind Activity, Approvals, the Kafka REST Proxy and the mailbox — the parts that
 * are rules rather than markup.
 */

const source = (...path: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");

describe("what a change is called", () => {
  test("the three operation kinds read as what happened, not as the endpoint that queued them", () => {
    expect(operationKindLabel("publish")).toBe("Published");
    expect(operationKindLabel("configure")).toBe("Settings changed");
    expect(operationKindLabel("promote")).toBe("Promoted");
  });

  test("a kind the portal has no word for is still shown rather than dropped", () => {
    expect(operationKindLabel("roll-back")).toBe("Roll back");
    expect(operationKindLabel("")).toBe("Change");
  });
});

describe("the mailbox's sent state", () => {
  test("a message not sent yet is distinguishable from a sent one", () => {
    // notifications-and-mail, "A message has not been sent yet".
    expect(mailChip("delivered").label).toBe("Sent");
    expect(mailChip("delivered").tone).toBe("live");
    for (const state of ["queued", "retrying"]) {
      expect(mailChip(state).tone, state).toBe("wait");
      expect(mailChip(state).label, state).not.toBe("Sent");
      expect(mailChip(state).title, state).toContain(state);
    }
  });
});

describe("the approvals queue", () => {
  const row = (environment: string, state = "awaiting-decision", access = "pending") => ({
    state,
    approval: { environment, state: access },
  });

  test("only a request whose event and access both still wait is open for a decision", () => {
    expect(awaitingDecision(row("dev"))).toBe(true);
    // The outbox event can still say awaiting-decision after the consumer cancelled
    // (skonet-integration, "An approval is reviewed").
    expect(awaitingDecision(row("dev", "awaiting-decision", "cancelled"))).toBe(false);
    expect(awaitingDecision(row("dev", "approved", "activating"))).toBe(false);
  });

  test("the environment filter offers every stage, each with how many requests it holds", () => {
    const options = approvalFilterOptions([row("dev"), row("prod"), row("prod")], ["dev", "test", "prod"]);
    expect(options.map((option) => option.value)).toEqual(["all", "dev", "test", "prod"]);
    expect(options.map((option) => option.label)).toEqual(["All · 3", "DEV · 1", "TEST · 0", "PROD · 2"]);
  });

  test("the screen no longer narrows itself to the shell's environment", () => {
    // Approvals is not environment-scoped (routes.ts); a PROD request was invisible from DEV.
    const approvals = source("portal", "processes.tsx").split("export function Approvals")[1]!.split("export function Kafka")[0]!;
    expect(approvals).not.toContain("s.environment");
  });
});

describe("the Kafka REST Proxy", () => {
  test("off is the default, not a fault", () => {
    expect(kafkaProxyChip(false).tone).toBe("neutral");
    expect(kafkaProxyChip(true).tone).toBe("live");
  });

  test("the command given is one the portal would answer", () => {
    const produce = proxyCall("http://localhost:8080/some/path", "topic_1", "application_a", "produce");
    expect(produce.endpoint).toBe("http://localhost:8080/api/kafka/topics/topic_1/playground");
    // The control plane refuses a cross-origin write, so the Origin header is not decoration.
    expect(produce.curl).toContain("-H 'Origin: http://localhost:8080'");
    expect(produce.curl).toContain('"action":"produce"');
    expect(produce.curl).toContain('"applicationId":"application_a"');
    const consume = proxyCall("http://localhost:8080", "topic_1", "application_a", "consume");
    expect(consume.curl).toContain('"action":"consume"');
    expect(consume.curl).not.toContain('"value"');
  });

  test("the proxy screen offers no topic creation — that is Kafka Topics'", () => {
    const proxy = source("portal", "processes.tsx").split("export function KafkaProxy")[1]!;
    expect(proxy).not.toContain("Create topic");
    expect(proxy).not.toContain("/api/kafka/topics\", {");
  });
});

describe("loading is not empty", () => {
  test("the bell and the mailbox wait for the first read before saying there is no mail", () => {
    const text = source("portal", "notifications.tsx");
    // Both empty states are gated on data having arrived, and both have a skeleton for before.
    expect(text.match(/feed\.data && items\.length === 0/g)?.length).toBe(2);
    expect(text.match(/!feed\.data && !feed\.error && <Skeleton/g)?.length).toBe(2);
  });
});

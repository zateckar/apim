import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mailChip, operationKindLabel, topicApiChip } from "../src/lib/status.ts";
import {
  approvalFilterOptions,
  awaitingDecision,
  contractDraftOf,
  contractProblem,
  sharedProxyAction,
  topicApiAction,
} from "../src/portal/processes.tsx";

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
  test("no HTTP API is the normal case, not a fault, and says why when it cannot have one", () => {
    expect(topicApiChip(true).tone).toBe("live");
    expect(topicApiChip(false).tone).toBe("neutral");
    expect(topicApiChip(false, "The topic has no schema.").title).toBe("The topic has no schema.");
  });

  const chain = (published: boolean[]) => ({
    sharedResourceId: published.some(Boolean) ? "res_shared" : null,
    environments: ["dev", "test", "prod"].map((environment, i) => ({ environment, published: published[i]! })),
  });

  test("the shared proxy's button says what it will do in this environment", () => {
    expect(sharedProxyAction(chain([false, false, false]), "dev")).toEqual({ label: "Publish the shared proxy", blocked: null });
    expect(sharedProxyAction(chain([false, false, false]), "test").blocked).toContain("DEV");
    expect(sharedProxyAction(chain([true, false, false]), "dev").label).toBe("Save");
    expect(sharedProxyAction(chain([true, false, false]), "test")).toEqual({ label: "Promote to TEST", blocked: null });
    expect(sharedProxyAction(chain([true, false, false]), "prod").blocked).toContain("TEST");
  });

  test("a topic's row offers the one next step, or the first reason there is none", () => {
    const ready = { published: false, apiResourceId: null, blockers: [], canEdit: true };
    expect(topicApiAction({ ...ready, published: true, apiResourceId: "r" }, { published: true, first: true }).kind).toBe("open");
    expect(topicApiAction(ready, { published: true, first: true }).kind).toBe("create");
    expect(topicApiAction({ ...ready, apiResourceId: "r" }, { published: true, first: false }).kind).toBe("promote");
    expect(topicApiAction(ready, { published: true, first: false }).reason).toContain("starts where the chain does");
    expect(topicApiAction(ready, { published: false, first: true }).reason).toContain("not published here");
    expect(topicApiAction({ ...ready, blockers: ["no schema"] }, { published: true, first: true })).toEqual({ kind: "none", reason: "no schema" });
    expect(topicApiAction({ ...ready, canEdit: false }, { published: true, first: true }).reason).toContain("owner");
  });

  test("a topic's schema is checked as it is typed, the way the gateway will compile it", () => {
    const draft = contractDraftOf({ schemaType: "json", schema: { type: "object" }, certificateId: "c1" });
    expect(draft.schemaText).toContain('"type": "object"');
    expect(contractProblem("orders", draft)).toBeNull();
    expect(contractProblem("orders", { ...draft, schemaText: "{" })).toContain("not valid JSON");
    expect(contractProblem("orders", { ...draft, schemaText: '{"unevaluatedProperties":false}' })).toContain("unevaluatedProperties");
    // Not a JSON topic, or no schema yet: nothing to check, and the topic can still be saved.
    expect(contractProblem("orders", { ...draft, schemaType: "avro", schemaText: "{" })).toBeNull();
    expect(contractProblem("orders", { ...draft, schemaText: "" })).toBeNull();
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

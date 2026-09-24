import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HISTORY_LIMIT,
  appendHistory,
  certificatesFor,
  grantSections,
  matchesSearch,
  openingStage,
  readHistory,
  splitPublishedSubscribed,
  stageAction,
  topicListRows,
  type GrantRow,
  type HistoryEntry,
  type TopicRow,
} from "../src/lib/kafka.ts";
import { schemaCheck } from "../../shared/kafka.ts";

/**
 * The Kafka workspace's decisions (kafka-workspace, kafka-playground) — the parts that are rules
 * rather than markup: what a list row is, which side of the list a topic is on, what Stage does,
 * which certificate proves a principal, and what the playground's history keeps.
 */

const CHAIN = ["dev", "test", "prod"];
const source = (...path: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");

function topic(over: Partial<TopicRow>): TopicRow {
  return {
    id: "t",
    name: "sales_orders_platform-apis_order-created_v1",
    environment: "dev",
    state: "ready",
    applicationId: "application_platform",
    applicationName: "Platform APIs",
    canEdit: true,
    displayName: "Order created",
    version: "v1",
    family: "sales_orders_platform-apis_order-created",
    partitions: 8,
    replication: 2,
    retentionDays: 1,
    minInsyncReplicas: null,
    schemaType: "json",
    schemaDefinition: "{}",
    schemaVersion: 1,
    compatibility: null,
    subject: "x-value",
    description: "",
    wikiLink: null,
    domain: "Sales",
    subdomain: "Orders",
    certificateId: null,
    consumers: 0,
    apiResourceId: null,
    apiPublished: false,
    apiBlockers: [],
    ...over,
  };
}

function grant(over: Partial<GrantRow>): GrantRow {
  return {
    id: "g",
    topicId: "t",
    topicName: "n",
    topicDisplayName: null,
    environment: "dev",
    applicationId: "application_orders",
    applicationName: "Orders",
    publisher: "application_platform",
    principal: "CN=a",
    authType: "mtls",
    operation: "read",
    groupId: null,
    requestId: "g",
    state: "active",
    purpose: "p",
    createdAt: "",
    ...over,
  };
}

describe("the topic list", () => {
  const rows = [
    topic({ id: "d1", environment: "dev" }),
    topic({ id: "t1", environment: "test" }),
    topic({ id: "d2", environment: "dev", name: "sales_orders_platform-apis_order-created_v2", version: "v2", displayName: "Order created (v2)" }),
    topic({ id: "gone", environment: "prod", state: "deleted" }),
    topic({ id: "o1", applicationId: "application_orders", applicationName: "Orders", family: "other", name: "other_v1", displayName: "Other" }),
  ];

  test("is one row per topic family, its versions newest first, a deleted stage left out", () => {
    const list = topicListRows(rows);
    const orders = list.find((row) => row.applicationId === "application_platform")!;
    expect(orders.versions.map((v) => v.version)).toEqual(["v2", "v1"]);
    expect([...orders.versions[1]!.rows.keys()]).toEqual(["dev", "test"]);
    // The newest version names the row.
    expect(orders.displayName).toBe("Order created (v2)");
  });

  test("opens a version where the reader is looking, or the furthest stage it has reached", () => {
    const v1 = topicListRows(rows).find((row) => row.applicationId === "application_platform")!.versions[1]!;
    expect(openingStage(v1, CHAIN, "dev")).toBe("dev");
    expect(openingStage(v1, CHAIN, "prod")).toBe("test");
  });

  test("published is what the application owns; subscribed is what it holds a live grant on", () => {
    const list = topicListRows(rows);
    const orders = splitPublishedSubscribed(list, [grant({ topicId: "d1" })], "application_orders");
    expect(orders.published.map((row) => row.displayName)).toEqual(["Other"]);
    expect(orders.subscribed.map((row) => row.applicationId)).toEqual(["application_platform"]);
    const revoked = splitPublishedSubscribed(list, [grant({ topicId: "d1", state: "revoked" })], "application_orders");
    expect(revoked.subscribed).toEqual([]);
  });

  test("a subscribed row offers only the versions the application holds a grant on", () => {
    const { subscribed } = splitPublishedSubscribed(topicListRows(rows), [grant({ topicId: "t1" })], "application_orders");
    expect(subscribed[0]!.versions.map((v) => v.version)).toEqual(["v1"]);
  });

  test("the search covers titles, names, owners and domains", () => {
    const row = topicListRows(rows)[0]!;
    expect(matchesSearch(row, "platform")).toBe(true);
    expect(matchesSearch(row, "SALES")).toBe(true);
    expect(matchesSearch(row, "nothing-like-it")).toBe(false);
  });
});

describe("grants and stages", () => {
  test("a grant list splits into READ, WRITE and the rest, live grants only", () => {
    const sections = grantSections([
      grant({ id: "r" }),
      grant({ id: "w", operation: "write" }),
      grant({ id: "d", operation: "describe" }),
      grant({ id: "x", operation: "delete", state: "revoked" }),
    ]);
    expect(sections.read.map((g) => g.id)).toEqual(["r"]);
    expect(sections.write.map((g) => g.id)).toEqual(["w"]);
    expect(sections.other.map((g) => g.id)).toEqual(["d"]);
  });

  test("Stage names the next stage, and says why it cannot when it cannot", () => {
    const here = topic({});
    expect(stageAction(here, CHAIN, new Set(["dev"]))).toEqual({ next: "test", reason: null });
    expect(stageAction(here, CHAIN, new Set(["dev", "test"])).reason).toContain("Already there");
    expect(stageAction({ ...here, state: "provisioning" }, CHAIN, new Set(["dev"])).reason).toContain("still being created");
    expect(stageAction({ ...here, canEdit: false }, CHAIN, new Set(["dev"])).reason).toContain("owner");
    expect(stageAction({ ...here, environment: "prod" }, CHAIN, new Set(["dev", "test", "prod"]))).toEqual({ next: null, reason: null });
  });

  test("the certificate that proves an mTLS principal is the application's own, unexpired, with that subject", () => {
    const certs = [
      { id: "a", applicationId: "application_orders", expired: false, subject: "O=SKODA AUTO a.s., CN=ABC" },
      { id: "b", applicationId: "application_orders", expired: true, subject: "CN=ABC,O=SKODA AUTO a.s." },
      { id: "c", applicationId: "application_platform", expired: false, subject: "CN=ABC,O=SKODA AUTO a.s." },
      { id: "d", applicationId: "application_orders", expired: false, subject: "CN=XYZ,O=SKODA AUTO a.s." },
    ];
    expect(certificatesFor(certs, "application_orders", "CN=ABC,O=SKODA AUTO a.s.").map((c) => c.id)).toEqual(["a"]);
  });

  test("a schema is checked in its own language before Next or Save", () => {
    expect(schemaCheck("json", '{"type":"object"}')).toEqual({ level: "ok", message: "Valid JSON" });
    expect(schemaCheck("json", '{"unevaluatedProperties":false}').message).toContain("unevaluatedProperties");
    expect(schemaCheck("avro", "{").level).toBe("error");
    expect(schemaCheck("protobuf", "").level).toBe("error");
  });
});

describe("the playground's history", () => {
  const memory = () => {
    const store = new Map<string, string>();
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), store };
  };
  const entry = (id: string): HistoryEntry => ({
    id,
    at: "2026-01-01T00:00:00Z",
    topic: "t",
    environment: "dev",
    action: "consume",
    principal: "CN=a",
    operation: "read",
    request: { certificate: "orders-client" },
    ok: true,
    summary: "1 message",
    response: { items: [] },
  });

  test("is newest first, capped, and survives a store it cannot parse", () => {
    const storage = memory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) appendHistory(storage, "k", entry(String(i)));
    const kept = readHistory(storage, "k");
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[0]!.id).toBe(String(HISTORY_LIMIT + 4));
    storage.setItem("k", "{not json");
    expect(readHistory(storage, "k")).toEqual([]);
  });

  test("never holds a credential: the request names the certificate, not its material", () => {
    const text = source("portal", "kafka-playground.tsx");
    expect(text).toContain("certificate: chosenCertificate.name");
    expect(text).not.toMatch(/keyPem|certPem|clientSecret/);
  });
});

describe("the screens", () => {
  test("the list is not narrowed by the shell's environment; each row says where it is", () => {
    const list = source("portal", "kafka.tsx").split("export function KafkaTopics")[1]!.split("function TopicListEntry")[0]!;
    expect(list).not.toContain("s.environment");
  });

  test("the Kafka screens walk Kafka's stages, TEST and PROD, never the API chain with its DEV", () => {
    // kafka-workspace, "Kafka has its own stages": a DEV chevron, a DEV wizard or a PROD confirm
    // measured against the API chain's last stage would all be about a cluster that does not exist.
    for (const file of ["kafka.tsx", "kafka-playground.tsx"]) {
      expect(source("portal", file), file).not.toMatch(/meta\.chain\b/);
    }
    const shell = source("portal", "Portal.tsx");
    expect(shell).toContain("kafkaScreen ? s.meta.kafkaChain : s.meta.chain");
    expect(shell).toContain('route.id === "kafka-proxy"');
  });

  test("the proxy screen still offers no topic creation — that is Kafka Topics'", () => {
    expect(source("portal", "processes.tsx")).not.toContain("export function Kafka(");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../control-plane/src/config.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";
import {
  buildTopicName,
  dnMatches,
  principalError,
  schemaCheck,
  topicFamily,
  topicVersion,
} from "../shared/kafka.ts";
import { makeCp, type TestCp } from "./helpers.ts";
import { generateCertificate } from "./x509.ts";

/**
 * The Kafka workspace (kafka-workspace, kafka-playground): a topic named by the convention, sized
 * and given a schema of its type, created in TEST and staged to PROD; access granted to a principal one
 * operation at a time; and the playground exercising one of those grants against the simulated
 * broker with the credential the broker would check.
 */

let cp: TestCp;
beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

const AVRO = JSON.stringify({
  type: "record",
  name: "OrderCreated",
  fields: [
    { name: "orderId", type: "string" },
    { name: "amount", type: ["null", "double"] },
  ],
});

async function create(cookie: string, body: Record<string, unknown> = {}) {
  return cp.call("POST", "/api/kafka/topics", {
    cookie,
    body: {
      applicationId: "application_platform",
      displayName: "Order Created",
      domain: "Sales",
      subdomain: "Orders",
      schemaType: "avro",
      schemaDefinition: AVRO,
      ...body,
    },
  });
}

async function ready(cookie: string, body: Record<string, unknown> = {}) {
  const response = await create(cookie, body);
  expect(response.status).toBe(202);
  const created = await response.json();
  runDueJobs(cp.app);
  return created as { id: string; name: string; environment: string };
}

describe("Kafka's stages", () => {
  test("are TEST and PROD by default, and a setting names stages of the chain in its order", () => {
    const saved = process.env.KAFKA_ENVIRONMENTS;
    const load = (promotionChain = ["dev", "test", "prod"]) => loadConfig({ promotionChain, authProviders: ["dev"], targets: [] });
    try {
      delete process.env.KAFKA_ENVIRONMENTS;
      expect(load().kafka.environments).toEqual(["test", "prod"]);
      // A chain with neither still has somewhere to put a topic.
      expect(load(["dev"]).kafka.environments).toEqual(["dev"]);
      process.env.KAFKA_ENVIRONMENTS = "prod,test";
      expect(() => load()).toThrow("PROMOTION_CHAIN's order");
      process.env.KAFKA_ENVIRONMENTS = "qa";
      expect(() => load()).toThrow("not in PROMOTION_CHAIN");
      process.env.KAFKA_ENVIRONMENTS = "test";
      expect(load().kafka.environments).toEqual(["test"]);
    } finally {
      if (saved === undefined) delete process.env.KAFKA_ENVIRONMENTS;
      else process.env.KAFKA_ENVIRONMENTS = saved;
    }
  });
});

describe("the shared rules", () => {
  test("a name is built from the convention, and read back into its family and version", () => {
    const name = buildTopicName({
      domain: "Sales",
      subdomain: "Orders",
      application: "Platform APIs",
      displayName: "Order Created",
      version: "v1",
    });
    expect(name).toBe("sales_orders_platform-apis_order-created_v1");
    expect(topicVersion(name)).toBe("v1");
    expect(topicFamily(name)).toBe("sales_orders_platform-apis_order-created");
    expect(buildTopicName({ domain: "Sales", application: "x", displayName: "", version: "v1" })).toBe("");
    expect(topicVersion("orders.created")).toBeNull();
  });

  test("each schema type is checked in its own language", () => {
    expect(schemaCheck("json", '{"type":"object"}').level).toBe("ok");
    expect(schemaCheck("json", "{").level).toBe("error");
    expect(schemaCheck("avro", AVRO).level).toBe("ok");
    expect(schemaCheck("avro", '{"type":"record","fields":[]}').message).toContain("needs a name");
    expect(schemaCheck("protobuf", 'syntax = "proto3";\nmessage A { string id = 1; }').level).toBe("ok");
    expect(schemaCheck("protobuf", "message A { string id = 1; }").level).toBe("warn");
    expect(schemaCheck("protobuf", "message A {").level).toBe("error");
  });

  test("a DN matches however it is spelled, and a principal names what the broker binds", () => {
    expect(dnMatches("O=SKODA AUTO a.s., CN=ABC123X", "cn=ABC123X,O=SKODA AUTO a.s.")).toBe(true);
    expect(dnMatches("CN=ABC123X, O=Other", "CN=ABC123X,O=SKODA AUTO a.s.")).toBe(false);
    expect(principalError("mtls", "O=SKODA AUTO a.s.")).toContain("CN");
    expect(principalError("mtls", "CN=ABC123X,O=SKODA AUTO a.s.")).toBeNull();
    expect(principalError("oauth", "orders-service")).toBeNull();
    expect(principalError("oauth", "has space")).not.toBeNull();
  });
});

describe("a topic", () => {
  test("is created in Kafka's first stage, sized, with a schema of its type as version 1", async () => {
    const pavel = await cp.login("pavel");
    // There is no DEV cluster: Kafka's stages are TEST and PROD, whatever the API chain is.
    expect(cp.app.config.kafka.environments).toEqual(["test", "prod"]);
    const inDev = await create(pavel, { environment: "dev" });
    expect(inDev.status).toBe(400);
    expect((await inDev.json()).detail).toContain("TEST and PROD only");
    const refused = await create(pavel, { environment: "prod" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).detail).toContain("created in TEST");

    const created = await ready(pavel, { size: "M", compatibility: "BACKWARD", wikiLink: "https://wiki.example/orders" });
    const listed = await (await cp.call("GET", `/api/kafka/topics?name=${created.name}`, { cookie: pavel })).json();
    expect(listed.items).toHaveLength(1);
    const topic = listed.items[0];
    expect(topic).toMatchObject({
      state: "ready",
      environment: "test",
      displayName: "Order Created",
      version: "v1",
      partitions: 16,
      replication: 2,
      retentionDays: 3,
      schemaType: "avro",
      schemaVersion: 1,
      compatibility: "BACKWARD",
      subject: `${created.name}-value`,
      wikiLink: "https://wiki.example/orders",
      applicationName: "Platform APIs",
      consumers: 0,
    });
    expect(JSON.parse(topic.schemaDefinition).name).toBe("OrderCreated");
  });

  test("refuses a definition its type would not accept, and sizes a broker could not run", async () => {
    const pavel = await cp.login("pavel");
    expect((await create(pavel, { schemaDefinition: '{"type":"record"}' })).status).toBe(400);
    const insync = await create(pavel, { replication: 2, minInsyncReplicas: 3 });
    expect(insync.status).toBe(400);
    expect((await insync.json()).detail).toContain("min.insync.replicas");
  });

  test("grows partitions but never shrinks them, and a new definition is the next schema version", async () => {
    const pavel = await cp.login("pavel");
    const { id } = await ready(pavel);
    const patch = (body: Record<string, unknown>) => cp.call("PATCH", `/api/kafka/topics/${id}`, { cookie: pavel, body });
    expect((await patch({ partitions: 4 })).status).toBe(400);
    expect((await patch({ partitions: 12 })).status).toBe(200);
    expect((await patch({ replication: 3 })).status).toBe(400);
    const wider = JSON.stringify({ ...JSON.parse(AVRO), fields: [...JSON.parse(AVRO).fields, { name: "note", type: "string" }] });
    const saved = await (await patch({ schemaDefinition: wider })).json();
    expect(saved.schemaVersion).toBe(2);
    // The same definition again is not a new version.
    expect((await (await patch({ schemaDefinition: wider })).json()).schemaVersion).toBe(2);
    const row = cp.app.db
      .query<{ partitions: number; schema_text: string }, [string]>("SELECT partitions, schema_text FROM kafka_topic WHERE id=?")
      .get(id)!;
    expect(row.partitions).toBe(12);
    expect(row.schema_text).toContain("note");
  });

  test("is staged to PROD with its schema, and a stage it was deleted from keeps the name", async () => {
    const pavel = await cp.login("pavel");
    const { id, name } = await ready(pavel);
    const staged = await cp.call("POST", `/api/kafka/topics/${id}/stage`, { cookie: pavel });
    expect(staged.status).toBe(202);
    const inProd = await staged.json();
    expect(inProd.environment).toBe("prod");
    expect((await cp.call("POST", `/api/kafka/topics/${id}/stage`, { cookie: pavel })).status).toBe(409);
    runDueJobs(cp.app);
    const rows = (await (await cp.call("GET", `/api/kafka/topics?name=${name}`, { cookie: pavel })).json()).items;
    expect(rows.map((r: { environment: string; state: string }) => `${r.environment}:${r.state}`)).toEqual([
      "test:ready",
      "prod:ready",
    ]);
    expect(rows[1].schemaDefinition).toBe(rows[0].schemaDefinition);
    // PROD is the last stage.
    const past = await cp.call("POST", `/api/kafka/topics/${inProd.id}/stage`, { cookie: pavel });
    expect(past.status).toBe(409);
    expect((await past.json()).detail).toContain("last stage");

    expect((await cp.call("DELETE", `/api/kafka/topics/${inProd.id}`, { cookie: pavel })).status).toBe(200);
    const again = await cp.call("POST", `/api/kafka/topics/${id}/stage`, { cookie: pavel });
    expect(again.status).toBe(409);
    expect((await again.json()).detail).toContain("not reused");
  });

  test("is not staged onward while the broker is still creating it", async () => {
    const pavel = await cp.login("pavel");
    const created = await (await create(pavel)).json();
    const early = await cp.call("POST", `/api/kafka/topics/${created.id}/stage`, { cookie: pavel });
    expect(early.status).toBe(409);
    expect((await early.json()).detail).toContain("once it is ready");
  });

  test("a row left in a stage with no cluster is not listed and goes nowhere", async () => {
    const pavel = await cp.login("pavel");
    const { id, name } = await ready(pavel);
    // Written before Kafka had its own stages.
    cp.app.db.run("UPDATE kafka_topic SET environment='dev' WHERE id=?", [id]);
    expect((await (await cp.call("GET", `/api/kafka/topics?name=${name}`, { cookie: pavel })).json()).items).toEqual([]);
    const staged = await cp.call("POST", `/api/kafka/topics/${id}/stage`, { cookie: pavel });
    expect(staged.status).toBe(409);
    expect((await staged.json()).detail).toContain("Kafka has no DEV");
  });

  test("only its owner stages it", async () => {
    const pavel = await cp.login("pavel");
    const clara = await cp.login("clara");
    const { id } = await ready(pavel);
    expect((await cp.call("POST", `/api/kafka/topics/${id}/stage`, { cookie: clara })).status).toBe(403);
  });

  test("says where to connect, or that nobody has said", async () => {
    const pavel = await cp.login("pavel");
    const connection = await (await cp.call("GET", "/api/kafka/connection?environment=prod", { cookie: pavel })).json();
    expect(connection.bootstrap).toBeNull();
    expect(connection.variable).toBe("KAFKA_BOOTSTRAP_PROD");
    expect(connection.listeners.map((l: { authType: string; port: number }) => `${l.authType}:${l.port}`)).toEqual([
      "mtls:9400",
      "oauth:9800",
    ]);
    expect((await cp.call("GET", "/api/kafka/connection?environment=dev", { cookie: pavel })).status).toBe(400);
  });
});

describe("access", () => {
  test("another application's request is one approval for all its operations, each its own row", async () => {
    const pavel = await cp.login("pavel");
    const clara = await cp.login("clara");
    const { id, name } = await ready(pavel);
    const response = await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
      cookie: clara,
      body: {
        applicationId: "application_orders",
        purpose: "Order analytics",
        authType: "mtls",
        principal: "CN=orders-consumer,O=apim-test",
        operations: ["write", "read"],
      },
    });
    expect(response.status).toBe(201);
    const request = await response.json();
    expect(request.state).toBe("pending");
    expect(request.items.map((i: { operation: string }) => i.operation)).toEqual(["read", "write"]);
    expect(request.items[0].groupId).toStartWith(`${name}_ORDERS_`);
    expect(request.items[1].groupId).toBeNull();

    // Asking again for an operation already asked for is refused by name.
    const repeat = await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
      cookie: clara,
      body: {
        applicationId: "application_orders",
        purpose: "Again",
        authType: "mtls",
        principal: "CN=orders-consumer,O=apim-test",
        operations: ["read"],
      },
    });
    expect(repeat.status).toBe(409);

    runDueJobs(cp.app);
    const events = (await (await cp.call("GET", "/api/integration-events?applicationId=application_platform", { cookie: pavel })).json()).items;
    const approval = events.find((e: { kind: string }) => e.kind === "kafka.request");
    expect(approval.approval).toMatchObject({
      name,
      principal: "CN=orders-consumer,O=apim-test",
      authType: "mtls",
      operations: ["read", "write"],
      state: "pending",
    });
    const decided = await cp.call("POST", `/api/integration-events/${approval.id}/decision`, {
      cookie: pavel,
      body: { decision: "approved" },
    });
    expect(decided.status).toBe(200);
    runDueJobs(cp.app);
    const states = cp.app.db
      .query<{ operation: string; state: string }, [string]>("SELECT operation, state FROM kafka_access WHERE request_id=? ORDER BY operation")
      .all(request.requestId);
    expect(states).toEqual([
      { operation: "read", state: "active" },
      { operation: "write", state: "active" },
    ]);
    const listed = (await (await cp.call("GET", `/api/kafka/topics?name=${name}`, { cookie: clara })).json()).items[0];
    expect(listed.consumers).toBe(1);
  });

  test("a pending request is cancelled whole; a granted operation is revoked on its own", async () => {
    const pavel = await cp.login("pavel");
    const clara = await cp.login("clara");
    const { id } = await ready(pavel);
    const ask = async (principal: string) =>
      (
        await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
          cookie: clara,
          body: { applicationId: "application_orders", purpose: "Reads", authType: "oauth", principal, operations: ["read", "describe"] },
        })
      ).json();
    const pending = await ask("orders-a");
    expect((await cp.call("DELETE", `/api/kafka/access/${pending.items[1].id}`, { cookie: clara })).status).toBe(200);
    const cancelled = cp.app.db
      .query<{ state: string }, [string]>("SELECT state FROM kafka_access WHERE request_id=?")
      .all(pending.requestId)
      .map((r) => r.state);
    expect(cancelled).toEqual(["cancelled", "cancelled"]);

    // The owner's own request needs no approval, and each operation is revoked apart.
    const own = await (
      await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
        cookie: pavel,
        body: { applicationId: "application_platform", purpose: "Own", authType: "oauth", principal: "platform-svc", operations: ["read", "write"] },
      })
    ).json();
    expect(own.state).toBe("activating");
    runDueJobs(cp.app);
    await cp.call("DELETE", `/api/kafka/access/${own.items[1].id}`, { cookie: pavel });
    runDueJobs(cp.app);
    const after = cp.app.db
      .query<{ operation: string; state: string }, [string]>("SELECT operation, state FROM kafka_access WHERE request_id=? ORDER BY operation")
      .all(own.requestId);
    expect(after).toEqual([
      { operation: "read", state: "active" },
      { operation: "write", state: "revoked" },
    ]);
  });

  test("a principal is required, and has to be one the broker can bind", async () => {
    const pavel = await cp.login("pavel");
    const { id } = await ready(pavel);
    const response = await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
      cookie: pavel,
      body: { applicationId: "application_platform", purpose: "Own", authType: "mtls", principal: "O=apim-test", operations: ["read"] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("CN");
  });
});

describe("the playground", () => {
  async function world() {
    const pavel = await cp.login("pavel");
    const { id } = await ready(pavel, { partitions: 3 });
    const generated = generateCertificate({ cn: "orders-client" });
    const cert = await cp.call("POST", "/api/certificates", {
      cookie: pavel,
      body: { environment: "test", applicationId: "application_platform", name: "orders-client", certPem: generated.certPem, keyPem: generated.keyPem },
    });
    expect(cert.status).toBe(201);
    const certificateId = (await cert.json()).id as string;
    const subject = cp.app.db.query<{ subject: string }, [string]>("SELECT subject FROM certificate WHERE id=?").get(certificateId)!.subject;
    const grant = await (
      await cp.call("POST", `/api/kafka/topics/${id}/subscribe`, {
        cookie: pavel,
        body: { applicationId: "application_platform", purpose: "Tests", authType: "mtls", principal: subject, operations: ["read", "write"] },
      })
    ).json();
    runDueJobs(cp.app);
    const run = (body: Record<string, unknown>) =>
      cp.call("POST", `/api/kafka/topics/${id}/playground`, {
        cookie: pavel,
        body: { applicationId: "application_platform", certificateId, ...body },
      });
    return { pavel, id, certificateId, read: grant.items[0].id as string, write: grant.items[1].id as string, run };
  }

  test("writes under a WRITE grant and reads under a READ grant, never the other way round", async () => {
    const w = await world();
    const wrong = await w.run({ accessId: w.read, action: "produce", value: "x" });
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).detail).toContain("needs WRITE");

    const keyed = async (key: string, value: string) =>
      (await (await w.run({ accessId: w.write, action: "produce", key, value, headers: [{ key: "source", value: "test" }] })).json()).record;
    const a1 = await keyed("order-1", "a");
    const a2 = await keyed("order-1", "b");
    // One key's records stay on one partition, in order.
    expect(a2.partition).toBe(a1.partition);
    expect(a2.offset).toBe(a1.offset + 1);
    expect(a1.headers).toEqual([{ key: "source", value: "test" }]);

    const read = await (
      await w.run({ accessId: w.read, action: "consume", partition: a1.partition, position: { kind: "offset", offset: 1 } })
    ).json();
    expect(read.items.map((m: { value: string }) => m.value)).toEqual(["b"]);
    expect(read.groupId).toContain("_PLATFORM-APIS_");

    const latest = await (await w.run({ accessId: w.read, action: "consume", position: { kind: "latest", count: 1 } })).json();
    expect(latest.items.map((m: { value: string }) => m.value)).toEqual(["b"]);
  });

  test("an mTLS grant is used with a certificate whose subject is its principal", async () => {
    const w = await world();
    const missing = await w.run({ accessId: w.write, action: "produce", value: "x", certificateId: null });
    expect(missing.status).toBe(409);

    const other = generateCertificate({ cn: "someone-else" });
    const cert = await cp.call("POST", "/api/certificates", {
      cookie: w.pavel,
      body: { environment: "test", applicationId: "application_platform", name: "someone-else", certPem: other.certPem, keyPem: other.keyPem },
    });
    const mismatch = await w.run({ accessId: w.write, action: "produce", value: "x", certificateId: (await cert.json()).id });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).detail).toContain("is not the grant's principal");
  });

  test("a partition outside the topic is refused by number", async () => {
    const w = await world();
    const response = await w.run({ accessId: w.write, action: "produce", value: "x", partition: 3 });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("0–2");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mapGroupsToApplications } from "../control-plane/src/auth-oidc.ts";
import { runDueJobs } from "../control-plane/src/jobs.ts";
import { grantMembership } from "../control-plane/src/principals.ts";
import { runKeyExpiry } from "../control-plane/src/key-expiry.ts";
import { platformKafkaKey, rotatePlatformKeys } from "../control-plane/src/kafka-proxy.ts";
import { startDataPlane } from "../data-plane/src/server.ts";
import {
  PLATFORM_KAFKA_KEY_REF,
  topicApiBlockers,
  topicApiDefinition,
  topicApiName,
  topicSchemaError,
} from "../shared/kafka-proxy.ts";
import { KafkaRest, startKafkaRest } from "../tools/kafka-rest/server.ts";
import { activeSubscription, makeCp, makeDp, serveCp, type TestCp } from "./helpers.ts";
import { generateCertificate } from "./x509.ts";

/**
 * The Kafka REST proxy (kafka-rest-proxy), end to end: a topic's API generated from its schema, a
 * consumer's record through two gateway hops, and the Confluent v3 produce at the far end.
 *
 * Through a gateway that is really listening, because the second hop is a real HTTP call to the
 * gateway's own published address — the point of the design, and the thing an in-process
 * `fetchHttp` would not exercise.
 */

const TOPIC = "orders.created";
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["orderId"],
  properties: {
    orderId: { type: "string" },
    amount: { $ref: "#/$defs/money" },
  },
  $defs: { money: { type: "number", minimum: 0 } },
};

const RATE_LIMIT = { calls: 10, periodSec: 60, per: "instance", by: "subscription", scope: "route", emitHeaders: true };

let cp: TestCp;
let keySeq = 0;
const idem = () => ({ "idempotency-key": `k-${++keySeq}-${Math.random().toString(36).slice(2)}` });

beforeEach(() => {
  cp = makeCp();
});
afterEach(() => {
  cp.close();
});

async function certificate(cookie: string, environment = "dev") {
  const generated = generateCertificate({ cn: "orders-producer" });
  const response = await cp.call("POST", "/api/certificates", {
    cookie,
    body: {
      environment,
      applicationId: "application_platform",
      name: `orders-producer-${environment}`,
      certPem: generated.certPem,
      keyPem: generated.keyPem,
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}

async function topic(cookie: string, body: Record<string, unknown> = {}) {
  const response = await cp.call("POST", "/api/kafka/topics", {
    cookie,
    body: {
      applicationId: "application_platform",
      environment: "dev",
      name: TOPIC,
      domain: "Sales",
      subdomain: "Orders",
      schemaType: "json",
      schema: SCHEMA,
      ...body,
    },
  });
  expect(response.status).toBe(202);
  const created = await response.json();
  runDueJobs(cp.app);
  return created.id as string;
}

async function sharedProxy(alice: string, backendUrl: string, environment = "dev") {
  const response = await cp.call("POST", "/api/kafka/proxy/shared", {
    cookie: alice,
    headers: idem(),
    body: { environment, backendUrl, clusterId: "local-cluster" },
  });
  expect(response.status).toBe(202);
  runDueJobs(cp.app);
}

async function topicApi(pavel: string, topicId: string) {
  const response = await cp.call("POST", `/api/kafka/topics/${topicId}/proxy`, {
    cookie: pavel,
    headers: idem(),
  });
  if (response.status !== 202) throw new Error(`${response.status} ${await response.text()}`);
  runDueJobs(cp.app);
  return cp.app.db
    .query<{ id: string }, [string]>("SELECT id FROM resource WHERE kafka_topic = ?")
    .get(TOPIC)!.id;
}

describe("the generated contract", () => {
  test("a topic's schema is the request body, with its definitions moved where OpenAPI resolves them", () => {
    const doc = topicApiDefinition(TOPIC, SCHEMA) as {
      paths: Record<string, { post: { requestBody: { content: Record<string, { schema: any }> } } }>;
      components: { schemas: Record<string, unknown> };
    };
    const body = doc.paths[`/topics/${TOPIC}`]!.post.requestBody.content["application/json"]!.schema;
    expect(body.$schema).toBeUndefined();
    expect(body.$defs).toBeUndefined();
    expect(body.properties.amount.$ref).toBe("#/components/schemas/money");
    expect(doc.components.schemas.money).toEqual({ type: "number", minimum: 0 });
    expect(topicSchemaError(TOPIC, SCHEMA)).toBeNull();
  });

  test("a schema the gateway could not enforce is refused on the topic, not accepted silently", () => {
    expect(topicSchemaError(TOPIC, { type: "object", unevaluatedProperties: false })).toContain(
      "unevaluatedProperties",
    );
    expect(topicSchemaError(TOPIC, { $ref: "#/$defs/missing" })).toContain("does not resolve");
    expect(topicSchemaError(TOPIC, [1, 2])).toContain("expected a JSON Schema object");
  });

  test("an API name is derived from the topic, and a long one stays distinct", () => {
    expect(topicApiName("Orders.Created_v2")).toBe("kafka-orders-created-v2");
    const a = topicApiName(`${"x".repeat(80)}.a`);
    const b = topicApiName(`${"x".repeat(80)}.b`);
    expect(a.length).toBeLessThanOrEqual(61);
    expect(a).not.toBe(b);
  });

  test("the reasons a topic cannot have an API are the ones a person can act on, in order", () => {
    expect(
      topicApiBlockers({ state: "ready", schemaType: "avro", schema: null, certificateId: null, certificateValid: null }),
    ).toEqual([
      "Only a JSON topic can be produced to over HTTP; this one is AVRO.",
      "The topic has no client certificate. Choose the one its records are produced with.",
    ]);
    expect(
      topicApiBlockers({ state: "ready", schemaType: "json", schema: {}, certificateId: "c", certificateValid: true }),
    ).toEqual([]);
  });
});

describe("a record through two hops", () => {
  test("produced to the topic, checked against its schema first, written as a Confluent v3 record", async () => {
    const kafka = new KafkaRest({ port: 0, quiet: true });
    const kafkaServer = startKafkaRest(kafka);
    const cpServer = serveCp(cp);
    const dp = makeDp(cpServer.url, cp.token, cp.dir, { name: "kafka-1" });
    const gateway = startDataPlane(dp);
    try {
      const gatewayUrl = `http://127.0.0.1:${gateway.port}`;
      // The shared proxy's address is the gateway's own: the second hop calls it like a consumer.
      cp.app.db.run("UPDATE target SET public_url = ?, intranet_url = NULL WHERE environment = 'dev'", [gatewayUrl]);
      await dp.start();

      const alice = await cp.login("alice");
      const pavel = await cp.login("pavel");
      const clara = await cp.login("clara");

      // A member cannot set the shared proxy up: it is the platform's, and the platform has no members.
      const refused = await cp.call("POST", "/api/kafka/proxy/shared", {
        cookie: pavel,
        headers: idem(),
        body: { environment: "dev", backendUrl: `http://127.0.0.1:${kafkaServer.port}`, clusterId: "local-cluster" },
      });
      expect(refused.status).toBe(403);

      await sharedProxy(alice, `http://127.0.0.1:${kafkaServer.port}`);
      expect(platformKafkaKey(cp.app.db, cp.app.kek, "dev")).toMatch(/^sk_dev_/);

      const certificateId = await certificate(pavel);
      const topicId = await topic(pavel, { certificateId });
      const status = await (await cp.call("GET", "/api/kafka/proxy", { cookie: pavel })).json();
      expect(status.topics.find((t: { id: string }) => t.id === topicId).blockers).toEqual([]);
      // The far end is an administrator's to see, like any backend address.
      expect(status.environments[0].backendUrl).toBeUndefined();

      const resourceId = await topicApi(pavel, topicId);
      const row = cp.app.db
        .query<{ application_id: string; name: string; visibility: string }, [string]>(
          "SELECT application_id, name, visibility FROM resource WHERE id = ?",
        )
        .get(resourceId)!;
      // Owned by the topic's owner, listed in the catalog like any API.
      expect(row).toEqual({ application_id: "application_platform", name: "kafka-orders-created", visibility: "listed" });
      const shared = cp.app.db
        .query<{ application_id: string; visibility: string }, []>(
          "SELECT application_id, visibility FROM resource WHERE platform_role = 'kafka-proxy'",
        )
        .get()!;
      expect(shared).toEqual({ application_id: "platform", visibility: "unlisted" });

      const product = cp.app.db
        .query<{ product_id: string }, [string]>("SELECT product_id FROM product_member WHERE resource_id = ?")
        .get(resourceId)!.product_id;
      const subscription = await activeSubscription(cp, clara, product);
      const basePath = cp.app.db
        .query<{ base_path: string }, [string]>("SELECT base_path FROM route WHERE resource_id = ? AND environment = 'dev'")
        .get(resourceId)!.base_path;

      const produce = (body: unknown, key: string | null = subscription.primaryKey) =>
        fetch(`${gatewayUrl}${basePath}/topics/${TOPIC}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
          body: JSON.stringify(body),
        });

      // The gateway polls every 50 ms; wait for the document that carries the consumer's key.
      let answered: Response | null = null;
      for (let i = 0; i < 100; i++) {
        answered = await produce({ orderId: "o-1", amount: 12.5 });
        if (answered.status !== 401 && answered.status !== 404) break;
        await Bun.sleep(50);
      }
      expect(answered!.status).toBe(200);
      const written = await answered!.json();
      expect(written.topic_name).toBe(TOPIC);
      expect(written.offset).toBe(0);
      expect(kafka.topics.get(TOPIC)!.map((r) => r.data)).toEqual([{ orderId: "o-1", amount: 12.5 }]);

      // A record the topic would not accept never leaves the first hop.
      const invalid = await produce({ amount: -1 });
      expect(invalid.status).toBe(400);
      expect(kafka.topics.get(TOPIC)).toHaveLength(1);

      // Without a key, neither hop answers — and the shared proxy refuses a consumer's own key, which
      // the gateway knows but not as a subscription to it: nobody but the platform subscribes there.
      expect((await produce({ orderId: "o-2" }, null)).status).toBe(401);
      const sharedBase = cp.app.db
        .query<{ base_path: string }, []>(
          "SELECT base_path FROM route r JOIN resource x ON x.id = r.resource_id WHERE x.platform_role = 'kafka-proxy'",
        )
        .get()!.base_path;
      const direct = await fetch(`${gatewayUrl}${sharedBase}/topics/${TOPIC}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": subscription.primaryKey },
        body: JSON.stringify({ orderId: "o-3" }),
      });
      expect(direct.status).toBe(403);
      expect(kafka.topics.get(TOPIC)).toHaveLength(1);
    } finally {
      dp.stop();
      gateway.stop(true);
      cpServer.stop();
      kafkaServer.stop(true);
    }
  });
});

describe("the portal's own application", () => {
  test("has no members: no group maps to it and no grant is written", () => {
    const mapped = mapGroupsToApplications(cp.app.db, ["platform", "/company/apim/platform"]);
    expect(mapped.applicationIds).toEqual([]);
    expect(mapped.unmapped).toEqual(["platform", "/company/apim/platform"]);
    expect(() => grantMembership(cp.app.db, "pavel", "platform", "local", "alice")).toThrow(/has no members/);
    expect(
      cp.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM membership WHERE application_id = 'platform'").get()!.n,
    ).toBe(0);
  });

  test("is not offered in the application directory", async () => {
    const alice = await cp.login("alice");
    const listed = await (await cp.call("GET", "/api/applications", { cookie: alice })).json();
    expect(listed.items.map((a: { id: string }) => a.id)).not.toContain("platform");
  });
});

describe("what only the platform writes", () => {
  async function world() {
    const kafka = new KafkaRest({ port: 0, quiet: true });
    const kafkaServer = startKafkaRest(kafka);
    cp.app.db.run("UPDATE target SET public_url = 'http://127.0.0.1:18081', intranet_url = NULL WHERE environment = 'dev'");
    const alice = await cp.login("alice");
    const pavel = await cp.login("pavel");
    await sharedProxy(alice, `http://127.0.0.1:${kafkaServer.port}`);
    const certificateId = await certificate(pavel);
    const topicId = await topic(pavel, { certificateId });
    const resourceId = await topicApi(pavel, topicId);
    const etag = async () =>
      (await cp.call("GET", `/api/resources/${resourceId}/editor?environment=dev`, { cookie: pavel })).json();
    return { alice, pavel, topicId, resourceId, certificateId, etag, stop: () => kafkaServer.stop(true) };
  }

  test("nobody names the platform's key on an API of their own", async () => {
    const pavel = await cp.login("pavel");
    const alice = await cp.login("alice");
    for (const cookie of [pavel, alice]) {
      const response = await cp.call("POST", "/api/publish", {
        cookie,
        headers: idem(),
        body: {
          applicationId: "application_platform",
          name: `thief-${Math.random().toString(36).slice(2, 7)}`,
          spec: { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } } },
          backendUrl: "https://attacker.example",
          domain: "IT",
          subdomain: "Solution",
          policy: {
            "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
            backendAuth: { type: "api-key", credentialRef: PLATFORM_KAFKA_KEY_REF, in: "header", name: "X-Api-Key" },
          },
        },
      });
      expect(response.status).toBe(403);
      expect((await response.json()).detail).toContain("platform:");
    }
  });

  test("nor in the environment's global tier, where it would reach every API", async () => {
    const alice = await cp.login("alice");
    const response = await cp.call("PUT", "/api/policy/global/units/auth.basic?environment=dev", {
      cookie: alice,
      body: { value: { credentialRef: PLATFORM_KAFKA_KEY_REF, realm: "x" } },
    });
    expect(response.status).toBe(403);
    expect(
      cp.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM global_policy_entry").get()!.n,
    ).toBe(0);
  });

  test("a topic's API keeps its generated definition, backend, certificate and key", async () => {
    const w = await world();
    try {
      const editor = await w.etag();
      const headers = { ...idem(), "if-match": editor.resource.etag };
      const spec = await cp.call("POST", `/api/resources/${w.resourceId}/configure`, {
        cookie: w.pavel,
        headers,
        body: { environment: "dev", spec: { openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {} } },
      });
      expect(spec.status).toBe(409);
      expect((await spec.json()).detail).toContain("generated from the Kafka topic");
      const backend = await cp.call("POST", `/api/resources/${w.resourceId}/configure`, {
        cookie: w.pavel,
        headers: { ...idem(), "if-match": editor.resource.etag },
        body: { environment: "dev", backendUrl: "https://elsewhere.example" },
      });
      expect(backend.status).toBe(409);

      // A policy save that leaves the platform's unit out gets it back, not a route without a key.
      const saved = await cp.call("POST", `/api/resources/${w.resourceId}/configure`, {
        cookie: w.pavel,
        headers: { ...idem(), "if-match": editor.resource.etag },
        body: {
          environment: "dev",
          policy: { "auth.subscriptionKey": { in: "header", name: "X-Api-Key" }, rateLimit: RATE_LIMIT },
        },
      });
      expect(saved.status).toBe(202);
      runDueJobs(cp.app);
      const after = await w.etag();
      expect(after.settings.policy.backendAuth.credentialRef).toBe(PLATFORM_KAFKA_KEY_REF);
      expect(after.settings.policy.rateLimit).toEqual(RATE_LIMIT);
    } finally {
      w.stop();
    }
  });

  test("a schema edit on the topic regenerates its API; its certificate cannot be taken off", async () => {
    const w = await world();
    try {
      const wider = { ...SCHEMA, properties: { ...SCHEMA.properties, currency: { type: "string" } } };
      const patched = await cp.call("PATCH", `/api/kafka/topics/${w.topicId}`, {
        cookie: w.pavel,
        body: { schema: wider },
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).operation.kind).toBe("configure");
      runDueJobs(cp.app);
      const editor = await w.etag();
      expect(editor.definition).toContain('"currency"');

      const stripped = await cp.call("PATCH", `/api/kafka/topics/${w.topicId}`, {
        cookie: w.pavel,
        body: { certificateId: null },
      });
      expect(stripped.status).toBe(409);
      const deleted = await cp.call("DELETE", `/api/kafka/topics/${w.topicId}`, { cookie: w.pavel });
      expect(deleted.status).toBe(409);
    } finally {
      w.stop();
    }
  });

  test("a topic's API is promoted only to where its topic, its certificate and the shared proxy are", async () => {
    const w = await world();
    try {
      const refused = await cp.call("POST", `/api/resources/${w.resourceId}/promote`, {
        cookie: w.pavel,
        headers: idem(),
        body: { environment: "test", backendUrl: "https://whatever.example" },
      });
      expect(refused.status).toBe(409);
      expect((await refused.json()).detail).toContain("TEST has no Kafka topic named orders.created");
    } finally {
      w.stop();
    }
  });

  test("the platform's key is rotated at the warning age rather than retired", async () => {
    const w = await world();
    try {
      const before = platformKafkaKey(cp.app.db, cp.app.kek, "dev");
      const later = Date.now() + (cp.app.config.subscriptionKeyExpireDays + 1) * 86_400_000;
      runKeyExpiry(cp.app, later);
      const after = platformKafkaKey(cp.app.db, cp.app.kek, "dev");
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
      // And a second pass the same day leaves the fresh key alone.
      expect(rotatePlatformKeys(cp.app, cp.app.config.subscriptionKeyWarnDays, later)).toBe(0);
    } finally {
      w.stop();
    }
  });
});

/**
 * The Kafka REST proxy's shared rules (kafka-rest-proxy): what a topic's API is called, what its
 * contract is, and whether a topic can have one. Shared because the control plane generates the API
 * from them and the portal explains a refusal with the same sentences before anybody clicks.
 *
 * Two APIs make the proxy, both ordinary resources:
 *
 *  - **the shared Kafka proxy** — owned by the platform application, one per estate, published in
 *    every environment that has topics to proxy. Its backend is the Confluent REST Proxy and its
 *    `kafkaProduce` unit writes the v3 produce call. It requires a subscription key like any API.
 *  - **a topic's API** — owned by the topic's application, generated from the topic's JSON schema,
 *    validated against it at the gateway. Its backend is the shared proxy's address; it presents the
 *    topic's client certificate and the platform's subscription key to it. Consumers subscribe to it
 *    like to any API.
 */

import { SchemaCompiler, SchemaUnsupported } from "./jsonschema.ts";

/** The application that owns what every application shares. Created by migration 16, no members. */
export const PLATFORM_APPLICATION_ID = "platform";

/** `resource.platform_role` of the shared proxy. */
export const KAFKA_PROXY_ROLE = "kafka-proxy";

/** The shared proxy's resource name, under the platform application. */
export const KAFKA_PROXY_NAME = "kafka-rest-proxy";

/**
 * The reference a topic's API presents its backend key through: the platform application's own
 * subscription key to the shared proxy, in the same environment, resolved by the configuration
 * build. It is not a credential anybody can name — see `isPlatformRef`.
 */
export const PLATFORM_KAFKA_KEY_REF = "platform:kafka-proxy";

/** A reference only the platform may write into a policy. */
export function isPlatformRef(ref: unknown): boolean {
  return typeof ref === "string" && ref.startsWith("platform:");
}

export const TOPIC_SCHEMA_TYPES = ["json", "avro", "protobuf"] as const;
export type TopicSchemaType = (typeof TOPIC_SCHEMA_TYPES)[number];

/** The largest schema a topic may carry. It becomes a request body schema on every gateway. */
export const MAX_TOPIC_SCHEMA_BYTES = 256 * 1024;

/**
 * The resource name of a topic's API: `kafka-` and the topic, lower-cased, anything outside
 * `[a-z0-9]` folded to a hyphen. Resource names are at most 61 characters and topic names up to
 * 101, so a long one is cut and given a short hash of the whole name, keeping two long topics that
 * share a prefix apart.
 */
export function topicApiName(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `kafka-${slug || "topic"}`;
  if (name.length <= 61) return name;
  return `${name.slice(0, 54).replace(/-+$/, "")}-${shortHash(topic)}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

/** The path a topic's API — and the shared proxy — take a record on. */
export function topicPath(topic: string): string {
  return `/topics/${topic}`;
}

/** What the Confluent REST Proxy answers a produce with, as the contract states it to consumers. */
const PRODUCE_RESPONSE = {
  type: "object",
  properties: {
    topic_name: { type: "string" },
    partition_id: { type: "integer" },
    offset: { type: "integer" },
    timestamp: { type: "string" },
  },
};

/**
 * The OpenAPI document of a topic's API: one operation, `POST /topics/<topic>`, whose request body
 * is the topic's JSON schema — so the gateway refuses a record the topic would not accept, before it
 * reaches Kafka.
 *
 * A JSON Schema's own `$defs` (or draft-07 `definitions`) are moved to `components.schemas` and
 * every `$ref` into them rewritten, because inside an OpenAPI document a `#/…` pointer resolves
 * against the document, not against the schema it was written in. `$schema` and `$id` are dropped:
 * they describe the schema file, and OpenAPI has no place for them.
 */
export function topicApiDefinition(topic: string, schema: Record<string, unknown>, description?: string) {
  const { body, components } = hoistDefinitions(schema);
  return {
    openapi: "3.1.0",
    info: {
      title: `Kafka topic ${topic}`,
      version: "v1",
      description:
        description?.trim() ||
        `Produce JSON records to the Kafka topic ${topic}. Each request is one record, checked against the topic's schema.`,
    },
    paths: {
      [topicPath(topic)]: {
        post: {
          operationId: "produce",
          summary: `Produce one record to ${topic}`,
          requestBody: { required: true, content: { "application/json": { schema: body } } },
          responses: {
            "200": {
              description: "The record was written to the topic.",
              content: { "application/json": { schema: PRODUCE_RESPONSE } },
            },
          },
        },
      },
    },
    ...(Object.keys(components).length > 0 ? { components: { schemas: components } } : {}),
  };
}

/**
 * The shared proxy's own contract: any JSON body to any topic. It validates nothing itself — each
 * topic's API has already checked the record against that topic's schema — and `kafkaProduce` needs
 * the `{topic}` path parameter to know where to write.
 */
export function sharedProxyDefinition() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kafka REST proxy",
      version: "v1",
      description:
        "The platform's own proxy to the Kafka REST Proxy. Called by each topic's API, with the platform's key; not for consumers.",
    },
    paths: {
      "/topics/{topic}": {
        post: {
          operationId: "produce",
          summary: "Produce one record to a topic",
          parameters: [{ name: "topic", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: {} } } },
          responses: {
            "200": {
              description: "The record was written.",
              content: { "application/json": { schema: PRODUCE_RESPONSE } },
            },
          },
        },
      },
    },
  };
}

function hoistDefinitions(schema: Record<string, unknown>): {
  body: Record<string, unknown>;
  components: Record<string, unknown>;
} {
  const { $schema: _schema, $id: _id, $defs, definitions, ...body } = schema as Record<string, unknown> & {
    $defs?: Record<string, unknown>;
    definitions?: Record<string, unknown>;
  };
  const components: Record<string, unknown> = { ...(definitions ?? {}), ...($defs ?? {}) };
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        out[key] = value.replace(/^#\/(\$defs|definitions)\//, "#/components/schemas/");
      } else {
        out[key] = rewrite(value);
      }
    }
    return out;
  };
  const hoisted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(components)) hoisted[name] = rewrite(value);
  return { body: rewrite(body) as Record<string, unknown>, components: hoisted };
}

/**
 * Why a topic's JSON schema cannot be its API's request body, or `null` when it can.
 *
 * Compiled the way the gateway will compile it, so a schema the gateway could not enforce is
 * refused on the topic, where its author is, rather than accepted and then reported as
 * `unsupported-schema` on an API nobody validates — the one outcome a producer relying on the
 * schema must not get silently.
 */
export function topicSchemaError(topic: string, schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return "schema: expected a JSON Schema object";
  const definition = topicApiDefinition(topic, schema as Record<string, unknown>);
  const body = definition.paths[topicPath(topic)]!.post.requestBody.content["application/json"].schema;
  try {
    new SchemaCompiler({ dialect: "2020-12", components: definition }).hoist(body, "schema");
    return null;
  } catch (error) {
    return error instanceof SchemaUnsupported
      ? `schema: ${error.message}`
      : `schema: ${(error as Error).message || "is not a JSON Schema the gateway can enforce"}`;
  }
}

export interface TopicFacts {
  state: string;
  schemaType: string | null;
  schema: unknown;
  certificateId: string | null;
  /** Whether that certificate is still usable here. `null` when there is none. */
  certificateValid: boolean | null;
}

/**
 * Why a topic cannot have an API yet, in the order somebody would fix them — or nothing. The
 * control plane refuses with the first; the portal lists all of them beside the disabled button.
 */
export function topicApiBlockers(topic: TopicFacts): string[] {
  const out: string[] = [];
  if (topic.state !== "ready") out.push("The topic is still being created.");
  if (topic.schemaType !== "json") {
    out.push(
      topic.schemaType
        ? `Only a JSON topic can be produced to over HTTP; this one is ${topic.schemaType.toUpperCase()}.`
        : "The topic has no schema. Set its JSON schema first.",
    );
  } else if (!topic.schema || typeof topic.schema !== "object") {
    out.push("The topic is JSON but has no schema. Set its JSON schema first.");
  }
  if (!topic.certificateId) out.push("The topic has no client certificate. Choose the one its records are produced with.");
  else if (topic.certificateValid === false) out.push("The topic's client certificate has expired or is gone. Choose another.");
  return out;
}

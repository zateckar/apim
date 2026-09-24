/**
 * A Kafka topic's shared rules (kafka-workspace, kafka-playground): what a topic is called, what
 * its schema has to be, who a grant is bound to and how big a topic may be. Shared because the
 * control plane enforces them and the portal says the same sentence before anybody submits — the
 * create wizard's Next and the schema card's Save are disabled on exactly the refusals the server
 * would return.
 */

import { slugify } from "./domains.ts";
import { MAX_TOPIC_SCHEMA_BYTES, topicSchemaError, type TopicSchemaType } from "./kafka-proxy.ts";

/** Every topic name, however it was made. The broker's own limit is 249; ours leaves room. */
export const TOPIC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/;

/** The schema registry's compatibility levels a topic may name. `null` is the registry's default. */
export const TOPIC_COMPATIBILITIES = ["BACKWARD", "FORWARD", "FULL", "NONE"] as const;
export type TopicCompatibility = (typeof TOPIC_COMPATIBILITIES)[number];

/**
 * What a grant allows, one per row, because the broker grants them separately: a READ is bound to
 * a consumer group and a WRITE is not, and an approved READ next to a pending WRITE is two facts,
 * not one (the predecessor's "union" display claimed write access on every group row).
 */
export const TOPIC_OPERATIONS = ["read", "write", "describe", "delete"] as const;
export type TopicOperation = (typeof TOPIC_OPERATIONS)[number];

/** How a principal authenticates to the broker: a client certificate's DN, or an OAuth client id. */
export const TOPIC_AUTH_TYPES = ["mtls", "oauth"] as const;
export type TopicAuthType = (typeof TOPIC_AUTH_TYPES)[number];

/**
 * The sizing a topic may have. Partitions only ever grow (a broker cannot take one away), and
 * replication is fixed at creation because changing it is a reassignment, not a setting.
 */
export const TOPIC_LIMITS = {
  partitions: { min: 1, max: 100 },
  replication: { min: 1, max: 3 },
  retentionDays: { min: 1, max: 7 },
  minInsyncReplicas: { min: 1, max: 3 },
} as const;

/**
 * The three sizes the legacy portal offered, kept because people ask for "a medium topic" rather
 * than for sixteen partitions. Custom unlocks the numbers within `TOPIC_LIMITS`.
 */
export const TOPIC_SIZES = {
  S: { partitions: 8, replication: 2, retentionDays: 1 },
  M: { partitions: 16, replication: 2, retentionDays: 3 },
  L: { partitions: 32, replication: 2, retentionDays: 5 },
} as const;
export type TopicSize = keyof typeof TOPIC_SIZES;

/** At most this many messages come back from one playground read, whatever was asked for. */
export const PLAYGROUND_MAX_MESSAGES = 100;
/** A produced value's ceiling, refused by name past it (kafka-playground). */
export const PLAYGROUND_MAX_VALUE = 32768;
/** Headers on one produced record. */
export const PLAYGROUND_MAX_HEADERS = 20;

/**
 * A blank schema per type: valid, empty, and something to fill in. A topic always has a schema, so
 * the wizard starts from one of these rather than from nothing.
 */
export const BLANK_SCHEMAS: Record<TopicSchemaType, string> = {
  json: JSON.stringify({ type: "object", properties: {} }, null, 2),
  avro: JSON.stringify({ type: "record", name: "Value", namespace: "com.example", fields: [] }, null, 2),
  protobuf: 'syntax = "proto3";\n\nmessage Value {\n}\n',
};

/** `v1` → valid; anything else is the sentence the form shows. */
export function versionError(version: string): string | null {
  return /^v\d{1,3}$/.test(version.trim()) ? null : "version: v1, v2, … — a v and a number";
}

export function displayNameError(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return "display name: 2–80 characters";
  if (!slugify(trimmed)) return "display name: needs at least one letter or digit";
  return null;
}

/**
 * The topic name the estate's convention builds: `{domain}[_{sub-domain}]_{application}_{name}_{version}`.
 *
 * Built, never typed. The name is how every consumer, every ACL and every consumer group refers to
 * the topic for the rest of its life, and a free-typed one was where two applications' topics
 * collided and where nobody could tell whose `orders` a topic was. Each segment is a slug with no
 * underscore in it, so the underscores are the separators and the application can be read back out.
 * `""` while a part is still missing.
 */
export function buildTopicName(parts: {
  domain: string;
  subdomain?: string | null;
  application: string;
  displayName: string;
  version: string;
}): string {
  const domain = slugify(parts.domain);
  const name = slugify(parts.displayName);
  const application = slugify(parts.application);
  const version = parts.version.trim().toLowerCase();
  if (!domain || !name || !application || versionError(version)) return "";
  return [domain, parts.subdomain ? slugify(parts.subdomain) : "", application, name, version].filter(Boolean).join("_");
}

const VERSION_SEGMENT = /_(v\d+)(?=$|[^0-9])/gi;

/** The version a topic's name carries — `v1` — or `null` for a name written before the convention. */
export function topicVersion(name: string): string | null {
  const matches = [...name.matchAll(VERSION_SEGMENT)];
  return matches.length ? matches[matches.length - 1]![1]!.toLowerCase() : null;
}

/**
 * The name without its version: what `…_orders_v1` and `…_orders_v2` have in common, and so what
 * one row of the topic list stands for. A name with no version is its own family.
 */
export function topicFamily(name: string): string {
  const matches = [...name.matchAll(VERSION_SEGMENT)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return name;
  return name.slice(0, last.index) + name.slice(last.index + last[0].length);
}

export interface SchemaCheck {
  /** `error` blocks a save; `warn` is said first-hand and allowed. */
  level: "ok" | "warn" | "error";
  message: string;
}

const AVRO_PRIMITIVES = ["null", "boolean", "int", "long", "float", "double", "bytes", "string"];
const AVRO_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a schema definition is one a topic can carry, per type.
 *
 * JSON is held to the gateway's own compiler, because a JSON topic's schema is also the request
 * body of its HTTP API (kafka-rest-proxy) and a schema nothing could enforce is refused here rather
 * than accepted and reported as unvalidated later. Avro is parsed and checked for the shape the
 * registry would refuse. Protobuf has no parser here, so it is checked for the three things a
 * `.proto` file cannot do without — which is a heuristic, and says so by warning rather than
 * refusing where it is unsure.
 */
export function schemaCheck(type: string, text: string, topic = "topic"): SchemaCheck {
  const label = type.toUpperCase();
  if (!text.trim()) return { level: "error", message: `${label}: the definition is empty` };
  if (new TextEncoder().encode(text).length > MAX_TOPIC_SCHEMA_BYTES)
    return { level: "error", message: `${label}: at most ${MAX_TOPIC_SCHEMA_BYTES / 1024} KiB` };
  if (type === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { level: "error", message: `JSON: not valid JSON — ${(error as Error).message}` };
    }
    const problem = topicSchemaError(topic, parsed);
    return problem ? { level: "error", message: problem } : { level: "ok", message: "Valid JSON" };
  }
  if (type === "avro") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { level: "error", message: `AVRO: not valid JSON — ${(error as Error).message}` };
    }
    const problem = avroProblem(parsed, "schema");
    if (problem) return { level: "error", message: `AVRO: ${problem}` };
    if (Array.isArray(parsed)) return { level: "warn", message: "AVRO: a union at the top level — most consumers expect a record" };
    return { level: "ok", message: "Valid AVRO" };
  }
  if (type === "protobuf") {
    let depth = 0;
    for (const character of text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (character === "{") depth++;
      if (character === "}" && --depth < 0) return { level: "error", message: "PROTOBUF: a } with no { before it" };
    }
    if (depth !== 0) return { level: "error", message: "PROTOBUF: the braces do not balance" };
    if (!/\b(message|enum|service)\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(text))
      return { level: "error", message: "PROTOBUF: no message, enum or service" };
    if (!/^\s*syntax\s*=\s*"proto[23]"\s*;/m.test(text))
      return { level: "warn", message: 'PROTOBUF: no syntax line — the registry assumes "proto2"' };
    return { level: "ok", message: "Valid PROTOBUF" };
  }
  return { level: "error", message: `schema type: one of JSON, AVRO or PROTOBUF` };
}

function avroProblem(node: unknown, at: string): string | null {
  if (typeof node === "string") {
    // A named type defined elsewhere in the schema is also a string; only a bare primitive is checked.
    return AVRO_PRIMITIVES.includes(node) || AVRO_NAME.test(node.split(".").pop() ?? "") ? null : `${at}: "${node}" is not a type`;
  }
  if (Array.isArray(node)) {
    for (const [index, branch] of node.entries()) {
      const problem = avroProblem(branch, `${at}[${index}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (!node || typeof node !== "object") return `${at}: expected a type`;
  const schema = node as Record<string, unknown>;
  switch (schema.type) {
    case "record":
    case "error": {
      if (typeof schema.name !== "string" || !AVRO_NAME.test(schema.name)) return `${at}: a record needs a name`;
      if (!Array.isArray(schema.fields)) return `${at}: a record needs a fields array`;
      for (const [index, field] of schema.fields.entries()) {
        const f = field as Record<string, unknown> | null;
        if (!f || typeof f.name !== "string" || !AVRO_NAME.test(f.name)) return `${at}.fields[${index}]: a field needs a name`;
        if (f.type === undefined) return `${at}.fields[${index}] (${f.name}): a field needs a type`;
        const problem = avroProblem(f.type, `${at}.${f.name}`);
        if (problem) return problem;
      }
      return null;
    }
    case "enum":
      if (typeof schema.name !== "string") return `${at}: an enum needs a name`;
      return Array.isArray(schema.symbols) && schema.symbols.every((s) => typeof s === "string")
        ? null
        : `${at}: an enum needs a symbols array of strings`;
    case "fixed":
      return typeof schema.name === "string" && Number.isInteger(schema.size) ? null : `${at}: a fixed needs a name and a size`;
    case "array":
      return schema.items === undefined ? `${at}: an array needs items` : avroProblem(schema.items, `${at}.items`);
    case "map":
      return schema.values === undefined ? `${at}: a map needs values` : avroProblem(schema.values, `${at}.values`);
    default:
      return typeof schema.type === "string" && AVRO_PRIMITIVES.includes(schema.type)
        ? null
        : `${at}: "${String(schema.type)}" is not an Avro type`;
  }
}

/** A definition as an editor should show it: JSON and Avro indented, Protobuf as written. */
export function prettySchema(type: string, text: string): string {
  if (type === "protobuf") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * A distinguished name's parts, normalized so two spellings of one DN compare equal: `CN=a, O=B`
 * and `O=B,CN=a` are the same subject. The broker reads RFC 2253 (most specific first) and a
 * certificate prints the other way round, so order is not part of the identity here.
 */
export function dnParts(dn: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < dn.length; i++) {
    const character = dn[i]!;
    if (character === "\\" && i + 1 < dn.length) {
      current += dn[++i];
      continue;
    }
    if (character === "," || character === "\n" || character === "+") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? part : `${part.slice(0, at).trim().toUpperCase()}=${part.slice(at + 1).trim()}`;
    })
    .sort();
}

/** Whether a certificate's subject is the DN a grant is bound to. */
export function dnMatches(subject: string, principal: string): boolean {
  const a = dnParts(subject);
  const b = dnParts(principal);
  return a.length > 0 && a.length === b.length && a.every((part, index) => part.toLowerCase() === b[index]!.toLowerCase());
}

/**
 * Why a principal cannot be bound, or `null`. A DN has to name a CN, because that is the part the
 * broker's principal builder keeps; a client id is what the identity provider issued.
 */
export function principalError(authType: string, principal: string): string | null {
  const value = principal.trim();
  if (authType === "mtls") {
    if (!value || value.length > 500) return "principal: the certificate's DN, up to 500 characters";
    const parts = dnParts(value);
    if (parts.some((part) => !/^[A-Z][A-Z0-9.]*=.+$/i.test(part)))
      return "principal: a DN is KEY=value pairs separated by commas, e.g. CN=ABC123X,O=SKODA AUTO a.s.";
    if (!parts.some((part) => part.toUpperCase().startsWith("CN=")))
      return "principal: the DN has to include the certificate's CN";
    return null;
  }
  if (authType === "oauth")
    return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value)
      ? null
      : "principal: the OAuth client id — letters, digits and . _ : @ / -";
  return "authType: mtls or oauth";
}

/** A wiki link is optional; when present it is an http(s) address. */
export function wikiLinkError(link: string | null | undefined): string | null {
  const value = (link ?? "").trim();
  if (!value) return null;
  if (value.length > 500) return "wiki link: at most 500 characters";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? null : "wiki link: an http(s) address";
  } catch {
    return "wiki link: an http(s) address";
  }
}

/**
 * The consumer group a READ grant is bound to: the topic, the consuming application and six
 * random characters, so two grants to one application are two groups and neither can move the
 * other's offsets.
 */
export function groupIdFor(topic: string, application: string, random: string): string {
  return `${topic}_${slugify(application).toUpperCase()}_${random}`;
}

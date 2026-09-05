import * as I from "../icons";

/**
 * What kind of thing a row is, in one badge.
 *
 * The word and the colour carry the same fact twice on purpose: a reader scanning a long catalog
 * finds SOAP by its violet before they read anything, and a reader who cannot tell violet from
 * green reads the four letters. The palette lives in `brand.css` — this file writes class names
 * and never a colour, so a badge here is the same badge in the catalog, the workspace and the
 * detail dialog.
 */

export type Kind = "rest" | "soap" | "mcp" | "a2a" | "kafka" | "kproxy";

const LABEL: Record<Kind, string> = {
  rest: "REST",
  soap: "SOAP",
  mcp: "MCP",
  a2a: "A2A",
  kafka: "KAFKA",
  kproxy: "PROXY",
};

const TITLE: Record<Kind, string> = {
  rest: "A REST API, described by OpenAPI",
  soap: "A SOAP API, described by WSDL",
  mcp: "An MCP server — tools a model can call",
  a2a: "An A2A agent — skills another agent can call",
  kafka: "A Kafka topic",
  kproxy: "A Kafka topic reachable over HTTP through the REST proxy",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span className={`api-kind-badge ${kind}`} title={TITLE[kind]}>
      {LABEL[kind]}
    </span>
  );
}

const SCHEMA_SHORT: Record<string, string> = { JSON: "JSON", AVRO: "AVRO", PROTOBUF: "PROTO" };

/**
 * A Kafka topic's badge carries the *schema* as well as the kind, because a topic's schema is the
 * first thing a consumer needs and the second thing nobody can find. The Kafka icon says what it
 * is; the four letters and their colour say what shape the messages are.
 */
export function KafkaTopicBadge({ schemaType }: { schemaType?: string | null }) {
  const type = (schemaType ?? "").toUpperCase();
  const known = type === "JSON" || type === "AVRO" || type === "PROTOBUF";
  return (
    <span
      className={`api-kind-badge kafka ${known ? type.toLowerCase() : "none"}`}
      title={known ? `Kafka topic · ${type} schema` : "Kafka topic · no schema registered"}
      data-schema-type={known ? type : "none"}
    >
      <I.Kafka size={12} />
      <span className="kt">{known ? SCHEMA_SHORT[type] : "NO SCHEMA"}</span>
    </span>
  );
}

/** The row-chrome class that paints a catalog item's border and floating legend in its kind's hue. */
export function toneClassOf(kind: Kind, schemaType?: string | null): string {
  if (kind !== "kafka") return `t-${kind}`;
  const type = (schemaType ?? "").toLowerCase();
  return ["json", "avro", "protobuf"].includes(type) ? `t-kafka-${type}` : "t-kafka-none";
}

/** The legend printed on the border line, top-centre: `API · REST`, `Kafka · AVRO`. */
export function legendOf(kind: Kind, schemaType?: string | null): string {
  if (kind === "kafka") {
    const type = (schemaType ?? "").toUpperCase();
    return `Kafka · ${SCHEMA_SHORT[type] ?? "NO SCHEMA"}`;
  }
  if (kind === "kproxy") return "API · Kafka Proxy";
  return `API · ${LABEL[kind]}`;
}

/**
 * A real-enough Confluent REST Proxy (v3) to put behind the shared Kafka proxy API
 * (kafka-rest-proxy).
 *
 * Kafka is one of the six external systems, and like the others it is a mock here — but the proxy
 * path is a real HTTP call through two gateway routes, so it needs something at the far end that
 * speaks the wire contract the `kafkaProduce` unit writes. It speaks only the part the portal uses:
 * producing one JSON record to a topic, and listing the cluster. It is strict about the body shape,
 * so a gateway that wrapped the record wrongly fails here rather than being accepted by a mock that
 * accepts anything.
 *
 * It keeps the last records per topic in memory and answers a non-standard read of them (marked as
 * such), so a smoke test or a person can see what arrived. Nothing is ever written to a broker.
 */

export interface KafkaRestOptions {
  port: number;
  /** The one cluster it pretends to be. The shared proxy's `kafkaProduce.clusterId` must match. */
  clusterId?: string;
  /** How many records to keep per topic. */
  retain?: number;
  quiet?: boolean;
}

export interface ProducedRecord {
  offset: number;
  data: unknown;
  at: string;
  /** Headers worth seeing from the far end: which client certificate and key arrived, if any. */
  seen: Record<string, string>;
}

export const DEFAULT_CLUSTER_ID = "local-cluster";

export class KafkaRest {
  readonly clusterId: string;
  readonly topics = new Map<string, ProducedRecord[]>();
  private readonly retain: number;
  private nextOffset = new Map<string, number>();

  constructor(readonly options: KafkaRestOptions) {
    this.clusterId = options.clusterId ?? DEFAULT_CLUSTER_ID;
    this.retain = options.retain ?? 100;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "kafka-rest", clusterId: this.clusterId, simulated: true });
    }
    if (req.method === "GET" && url.pathname === "/v3/clusters") {
      return Response.json({ kind: "KafkaClusterList", data: [{ kind: "KafkaCluster", cluster_id: this.clusterId }] });
    }

    const match = /^\/v3\/clusters\/([^/]+)\/topics\/([^/]+)\/records$/.exec(url.pathname);
    if (!match) return problem(404, `no such resource: ${req.method} ${url.pathname}`);
    const cluster = decodeURIComponent(match[1]!);
    const topic = decodeURIComponent(match[2]!);
    if (cluster !== this.clusterId) return problem(404, `cluster ${cluster} not found`);

    if (req.method === "GET") {
      // Not part of Confluent's API: the inspection read this mock offers so a test can see what
      // arrived. Said in the body, so nobody mistakes it for a consume.
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20));
      return Response.json({ simulated: true, topic, records: (this.topics.get(topic) ?? []).slice(-limit) });
    }
    if (req.method !== "POST") return problem(405, "only POST produces a record");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return problem(400, "the request body is not JSON");
    }
    const value = (body as { value?: { type?: unknown; data?: unknown } } | null)?.value;
    if (!value || value.type !== "JSON" || !("data" in value)) {
      return problem(400, 'expected {"value":{"type":"JSON","data":…}}');
    }

    const offset = this.nextOffset.get(topic) ?? 0;
    this.nextOffset.set(topic, offset + 1);
    const seen: Record<string, string> = {};
    for (const name of ["x-api-key", "x-client-cert-subject-dn", "x-forwarded-for"]) {
      const header = req.headers.get(name);
      if (header) seen[name] = name === "x-api-key" ? `${header.slice(0, 4)}…` : header;
    }
    const records = this.topics.get(topic) ?? [];
    records.push({ offset, data: value.data, at: new Date().toISOString(), seen });
    if (records.length > this.retain) records.splice(0, records.length - this.retain);
    this.topics.set(topic, records);
    if (!this.options.quiet) console.log(`[kafka-rest] ${topic} ← offset ${offset}`);

    return Response.json({
      error_code: 200,
      cluster_id: this.clusterId,
      topic_name: topic,
      partition_id: 0,
      offset,
      timestamp: new Date().toISOString(),
      value: { type: "JSON", size: JSON.stringify(value.data).length },
    });
  }
}

/** Confluent's error body: `error_code` mirrors the status, `message` says why. */
function problem(status: number, message: string): Response {
  return Response.json({ error_code: status, message }, { status });
}

export function startKafkaRest(rest: KafkaRest) {
  return Bun.serve({ port: rest.options.port, fetch: (req) => rest.fetch(req) });
}

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const arg of Bun.argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return fallback;
}

if (import.meta.main) {
  const rest = new KafkaRest({
    port: Number(flag("port", process.env.KAFKA_REST_PORT ?? "9087")),
    clusterId: flag("cluster", process.env.KAFKA_REST_CLUSTER_ID ?? DEFAULT_CLUSTER_ID),
  });
  const server = startKafkaRest(rest);
  console.log(
    `[kafka-rest] Confluent REST Proxy v3 (simulated) on http://localhost:${server.port} — ` +
      `cluster ${rest.clusterId}, POST /v3/clusters/${rest.clusterId}/topics/<topic>/records`,
  );
}

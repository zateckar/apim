import type { ApiModel } from "../../shared/types.ts";
import { can, type User } from "./auth.ts";
import type { App } from "./router.ts";

/**
 * Per-request access logs, read from ELK.
 *
 * The control plane does not *store* request logs. Aggregate telemetry answers "how much" and is
 * kept here; "which call, when, and what happened to it" is a different question with a different
 * retention story, and the estate already runs Elasticsearch for it. So this module is a **native
 * query interface** over a log index — `search` and `histogram`, both scoped to resources the
 * caller may read — with two implementations behind it:
 *
 *  - `elk` — the real one. One `_search` per call, an explicit field map, no scripting, no
 *    wildcards a caller can write, and a hard result window. It never writes.
 *  - `mock` — deterministic simulated traffic, derived from the resources actually published in
 *    the environment and their real operations, so every screen that reads logs is exercised
 *    end to end before an Elasticsearch cluster exists. Every response it produces is marked
 *    `simulated: true`, and the UI says so on the screen.
 *
 * `LOGS_PROVIDER` picks one. There is no automatic fallback from `elk` to `mock`: a portal that
 * quietly showed invented traffic when the log cluster was unreachable would be worse than one
 * that showed an error, because the numbers would look like observations.
 */

/** One access-log line, in this system's vocabulary rather than the index's. */
export interface LogEntry {
  id: string;
  /** ISO-8601, UTC. */
  at: string;
  environment: string;
  /** The gateway's name within its environment, e.g. `managed`. */
  gateway: string;
  /** The replica that served it. Present when the index carries it. */
  instance: string | null;
  resourceId: string;
  resourceName: string;
  /** The matched operation, when the gateway could match one. `null` is a real answer: a 404 on an
   * unmatched path is exactly the line somebody is looking for. */
  operationId: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Time spent upstream. `status` minus this is roughly what the gateway itself cost. */
  backendMs: number | null;
  subscriptionId: string | null;
  consumerApplicationId: string | null;
  clientIp: string | null;
  /** The `x-request-id` the gateway assigned, which is what a consumer quotes in a ticket. */
  requestId: string;
  /** Set when the gateway refused or the backend failed; the reason, in the gateway's words. */
  error: string | null;
}

export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export interface LogQuery {
  environment: string;
  /** Already authorized. An empty list means "nothing you may read", and the search returns none. */
  resourceIds: string[];
  from: Date;
  to: Date;
  statusClass?: StatusClass;
  method?: string;
  /** Case-insensitive substring over the request path. Never interpreted as a pattern. */
  pathContains?: string;
  subscriptionId?: string;
  minDurationMs?: number;
  limit: number;
  offset: number;
}

export interface LogPage {
  items: LogEntry[];
  /** Capped at the provider's result window; `totalIsLowerBound` says when the cap was hit. */
  total: number;
  totalIsLowerBound: boolean;
  simulated: boolean;
}

export interface HistogramBucket {
  /** Bucket start, ISO-8601 UTC. */
  at: string;
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  /** Mean over the bucket, rounded. `null` when the bucket is empty. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Histogram {
  buckets: HistogramBucket[];
  /** The bucket width actually used, in seconds — chosen from the window, not from the caller. */
  intervalSec: number;
  simulated: boolean;
}

export interface LogSearchProvider {
  readonly kind: "elk" | "mock";
  search(query: LogQuery): Promise<LogPage>;
  histogram(query: LogQuery, buckets: number): Promise<Histogram>;
  /** For the Health screen's component matrix. Never throws; reports instead. */
  probe(): Promise<{ reachable: boolean; detail: string; latencyMs: number | null }>;
}

// ---------------------------------------------------------------------------- configuration

export interface LogsConfig {
  provider: "elk" | "mock";
  /** Absolute base URL of the Elasticsearch/OpenSearch HTTP API. */
  url: string | null;
  /** Index or alias pattern the access lines land in. */
  index: string;
  apiKey: string | null;
  username: string | null;
  password: string | null;
  timeoutMs: number;
  /** ES refuses `from + size` past `index.max_result_window`; we refuse first, with a reason. */
  maxResultWindow: number;
  /** How far back the screens may ask. A wider window is a cluster-wide cost, so it is bounded. */
  maxRangeHours: number;
}

/**
 * The field map, in one place.
 *
 * ECS-ish rather than ECS: these are the names the data plane's access line writes, and an estate
 * that ships them under other names changes this constant rather than every query. It is a
 * constant and not configuration on purpose — a field name that varies per deployment turns every
 * log bug into "which mapping is this cluster on".
 */
export const ELK_FIELDS = {
  timestamp: "@timestamp",
  environment: "apim.environment",
  gateway: "apim.gateway",
  instance: "apim.instance",
  resourceId: "apim.resource_id",
  resourceName: "apim.resource_name",
  operationId: "apim.operation_id",
  method: "http.request.method",
  path: "url.path",
  status: "http.response.status_code",
  durationMs: "event.duration_ms",
  backendMs: "apim.backend_duration_ms",
  subscriptionId: "apim.subscription_id",
  consumerApplicationId: "apim.consumer_application_id",
  clientIp: "client.ip",
  requestId: "http.request.id",
  error: "error.message",
} as const;

// ---------------------------------------------------------------------------- authorization

/**
 * Which resources this caller may read logs for, in one environment.
 *
 * The rule is the estate's one authorization rule, applied to observations rather than to changes:
 * an administrator reads everything; anybody else reads the APIs their applications **publish**.
 * A consumer's own calls are deliberately not included — the line carries the publisher's backend
 * latency and error text, which is the publisher's operational detail and not part of what a
 * subscription buys.
 */
export function readableResourceIds(
  app: App,
  user: User | null,
  environment: string,
  only?: string,
): string[] {
  const rows = app.db
    .query<{ id: string; application_id: string }, [string]>(
      `SELECT DISTINCT r.id, r.application_id
         FROM resource r
         JOIN release rel ON rel.resource_id = r.id
        WHERE rel.environment = ? AND rel.state IN ('converged', 'superseded', 'withdrawn')`,
    )
    .all(environment);
  return rows
    .filter((row) => (only ? row.id === only : true))
    .filter((row) => can(user, row.application_id))
    .map((row) => row.id);
}

// ---------------------------------------------------------------------------- the ELK provider

export class ElkLogSearch implements LogSearchProvider {
  readonly kind = "elk" as const;

  constructor(private readonly config: LogsConfig) {
    if (!config.url) throw new Error("ELK_URL is required when LOGS_PROVIDER=elk");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `ApiKey ${this.config.apiKey}`;
    else if (this.config.username !== null) {
      const basic = Buffer.from(`${this.config.username}:${this.config.password ?? ""}`).toString("base64");
      headers.authorization = `Basic ${basic}`;
    }
    return headers;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.url}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
        // A log cluster that answers a redirect is a misconfiguration, not something to follow.
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `the log index answered ${response.status}: ${text.slice(0, 400) || response.statusText}`,
        );
      }
      return JSON.parse(text);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`the log index did not answer within ${this.config.timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The filter clauses every query shares. Values are always passed as terms, never interpolated. */
  private filters(query: LogQuery): unknown[] {
    const F = ELK_FIELDS;
    const filter: unknown[] = [
      { range: { [F.timestamp]: { gte: query.from.toISOString(), lte: query.to.toISOString() } } },
      { term: { [F.environment]: query.environment } },
      { terms: { [F.resourceId]: query.resourceIds } },
    ];
    if (query.statusClass) {
      const base = Number(query.statusClass[0]) * 100;
      filter.push({ range: { [F.status]: { gte: base, lt: base + 100 } } });
    }
    if (query.method) filter.push({ term: { [F.method]: query.method.toUpperCase() } });
    if (query.subscriptionId) filter.push({ term: { [F.subscriptionId]: query.subscriptionId } });
    if (query.minDurationMs !== undefined) {
      filter.push({ range: { [F.durationMs]: { gte: query.minDurationMs } } });
    }
    if (query.pathContains) {
      // `wildcard` with the caller's substring escaped and wrapped — the caller cannot write a
      // pattern of their own, so `*` in their input is a literal asterisk.
      const escaped = query.pathContains.replace(/([*?\\])/g, "\\$1");
      filter.push({ wildcard: { [F.path]: { value: `*${escaped}*`, case_insensitive: true } } });
    }
    return filter;
  }

  async search(query: LogQuery): Promise<LogPage> {
    if (query.resourceIds.length === 0) {
      return { items: [], total: 0, totalIsLowerBound: false, simulated: false };
    }
    const window = this.config.maxResultWindow;
    if (query.offset + query.limit > window) {
      throw new Error(
        `this page starts past the log index's result window of ${window} entries — ` +
          "narrow the time range or add a filter rather than paging further",
      );
    }
    const body = await this.post(`/${encodeURIComponent(this.config.index)}/_search`, {
      from: query.offset,
      size: query.limit,
      track_total_hits: window,
      sort: [{ [ELK_FIELDS.timestamp]: "desc" }],
      query: { bool: { filter: this.filters(query) } },
    });
    const hits = body?.hits?.hits ?? [];
    const total = body?.hits?.total;
    return {
      items: hits.map((hit: any) => fromElkHit(hit)),
      total: typeof total?.value === "number" ? total.value : hits.length,
      totalIsLowerBound: total?.relation === "gte",
      simulated: false,
    };
  }

  async histogram(query: LogQuery, buckets: number): Promise<Histogram> {
    const intervalSec = intervalFor(query.from, query.to, buckets);
    if (query.resourceIds.length === 0) {
      return { buckets: emptyBuckets(query.from, query.to, intervalSec), intervalSec, simulated: false };
    }
    const F = ELK_FIELDS;
    const body = await this.post(`/${encodeURIComponent(this.config.index)}/_search`, {
      size: 0,
      query: { bool: { filter: this.filters(query) } },
      aggs: {
        over_time: {
          date_histogram: {
            field: F.timestamp,
            fixed_interval: `${intervalSec}s`,
            min_doc_count: 0,
            extended_bounds: { min: query.from.toISOString(), max: query.to.toISOString() },
          },
          aggs: {
            client_error: { filter: { range: { [F.status]: { gte: 400, lt: 500 } } } },
            server_error: { filter: { range: { [F.status]: { gte: 500 } } } },
            latency: { percentiles: { field: F.durationMs, percents: [50, 95] } },
          },
        },
      },
    });
    const raw = body?.aggregations?.over_time?.buckets ?? [];
    return {
      intervalSec,
      simulated: false,
      buckets: raw.map((bucket: any): HistogramBucket => {
        const total = bucket.doc_count ?? 0;
        const clientError = bucket.client_error?.doc_count ?? 0;
        const serverError = bucket.server_error?.doc_count ?? 0;
        const values = bucket.latency?.values ?? {};
        return {
          at: new Date(bucket.key).toISOString(),
          total,
          ok: Math.max(0, total - clientError - serverError),
          clientError,
          serverError,
          p50Ms: finiteOrNull(values["50.0"]),
          p95Ms: finiteOrNull(values["95.0"]),
        };
      }),
    };
  }

  async probe(): Promise<{ reachable: boolean; detail: string; latencyMs: number | null }> {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const response = await fetch(`${this.config.url}/${encodeURIComponent(this.config.index)}/_count`, {
        headers: this.headers(),
        signal: controller.signal,
        redirect: "manual",
      }).finally(() => clearTimeout(timer));
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return { reachable: false, detail: `index ${this.config.index}: HTTP ${response.status}`, latencyMs };
      }
      const body = (await response.json()) as { count?: number };
      return {
        reachable: true,
        detail: `index ${this.config.index}: ${body.count ?? 0} entries`,
        latencyMs,
      };
    } catch (err) {
      return { reachable: false, detail: (err as Error).message, latencyMs: Date.now() - started };
    }
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function fromElkHit(hit: any): LogEntry {
  const source = hit?._source ?? {};
  const read = (path: string): unknown =>
    path.split(".").reduce<any>((node, key) => (node == null ? undefined : node[key]), source);
  const str = (path: string): string | null => {
    const value = read(path);
    return value === undefined || value === null ? null : String(value);
  };
  const num = (path: string): number | null => {
    const value = Number(read(path));
    return Number.isFinite(value) ? value : null;
  };
  return {
    id: String(hit?._id ?? crypto.randomUUID()),
    at: str(ELK_FIELDS.timestamp) ?? new Date(0).toISOString(),
    environment: str(ELK_FIELDS.environment) ?? "",
    gateway: str(ELK_FIELDS.gateway) ?? "",
    instance: str(ELK_FIELDS.instance),
    resourceId: str(ELK_FIELDS.resourceId) ?? "",
    resourceName: str(ELK_FIELDS.resourceName) ?? "",
    operationId: str(ELK_FIELDS.operationId),
    method: (str(ELK_FIELDS.method) ?? "GET").toUpperCase(),
    path: str(ELK_FIELDS.path) ?? "/",
    status: num(ELK_FIELDS.status) ?? 0,
    durationMs: num(ELK_FIELDS.durationMs) ?? 0,
    backendMs: num(ELK_FIELDS.backendMs),
    subscriptionId: str(ELK_FIELDS.subscriptionId),
    consumerApplicationId: str(ELK_FIELDS.consumerApplicationId),
    clientIp: str(ELK_FIELDS.clientIp),
    requestId: str(ELK_FIELDS.requestId) ?? "",
    error: str(ELK_FIELDS.error),
  };
}

// ---------------------------------------------------------------------------- the mock provider

/**
 * Deterministic simulated traffic.
 *
 * Two properties matter and neither is decoration. It is **derived from the estate** — the
 * resources actually released in the environment, their real operations, and the applications
 * actually subscribed — so the screens are exercised against plausible shapes rather than against
 * `/foo`. And it is **a pure function of (resource, minute)**, so the histogram and the list agree,
 * paging is stable, and a reload does not reshuffle the evidence somebody is reading.
 */
export class MockLogSearch implements LogSearchProvider {
  readonly kind = "mock" as const;

  constructor(private readonly app: App) {}

  async search(query: LogQuery): Promise<LogPage> {
    const all = this.generate(query);
    return {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
      totalIsLowerBound: false,
      simulated: true,
    };
  }

  async histogram(query: LogQuery, buckets: number): Promise<Histogram> {
    const intervalSec = intervalFor(query.from, query.to, buckets);
    const shells = emptyBuckets(query.from, query.to, intervalSec);
    const latencies = new Map<string, number[]>();
    for (const entry of this.generate(query)) {
      const at = Date.parse(entry.at);
      const index = Math.floor((at - query.from.getTime()) / (intervalSec * 1000));
      const bucket = shells[index];
      if (!bucket) continue;
      bucket.total++;
      if (entry.status >= 500) bucket.serverError++;
      else if (entry.status >= 400) bucket.clientError++;
      else bucket.ok++;
      const list = latencies.get(bucket.at) ?? [];
      list.push(entry.durationMs);
      latencies.set(bucket.at, list);
    }
    for (const bucket of shells) {
      const list = (latencies.get(bucket.at) ?? []).sort((a, b) => a - b);
      bucket.p50Ms = percentile(list, 0.5);
      bucket.p95Ms = percentile(list, 0.95);
    }
    return { buckets: shells, intervalSec, simulated: true };
  }

  async probe(): Promise<{ reachable: boolean; detail: string; latencyMs: number | null }> {
    return { reachable: true, detail: "simulated log index — no cluster was contacted", latencyMs: 0 };
  }

  /** Newest first, filtered exactly as the ELK provider filters. */
  private generate(query: LogQuery): LogEntry[] {
    if (query.resourceIds.length === 0) return [];
    const out: LogEntry[] = [];
    // A ceiling on the simulation, not on the query: past it the mock stops inventing rather than
    // spending the request's whole budget producing evidence nobody will page to.
    const CEILING = 4000;
    for (const resourceId of query.resourceIds) {
      const context = this.contextFor(resourceId, query.environment);
      if (!context) continue;
      const fromMinute = Math.floor(query.from.getTime() / 60_000);
      const toMinute = Math.floor(query.to.getTime() / 60_000);
      // A long window is sampled rather than walked minute by minute: a 30-day range is 43 200
      // minutes, and the shape of the traffic is what the screen is showing, not every minute of it.
      const step = Math.max(1, Math.ceil((toMinute - fromMinute) / 1500));
      for (let minute = fromMinute; minute <= toMinute && out.length < CEILING; minute += step) {
        for (const entry of this.minuteOf(context, minute, step)) {
          if (out.length >= CEILING) break;
          const at = Date.parse(entry.at);
          if (at < query.from.getTime() || at > query.to.getTime()) continue;
          if (!matches(entry, query)) continue;
          out.push(entry);
        }
      }
    }
    out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return out;
  }

  private cache = new Map<string, MockContext | null>();

  private contextFor(resourceId: string, environment: string): MockContext | null {
    const key = `${resourceId}/${environment}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const context = this.buildContext(resourceId, environment);
    this.cache.set(key, context);
    return context;
  }

  private buildContext(resourceId: string, environment: string): MockContext | null {
    const row = this.app.db
      .query<{ name: string; kind: string; application_id: string; model: string }, [string, string]>(
        `SELECT r.name, r.kind, r.application_id, rev.model
           FROM release rel
           JOIN resource r   ON r.id   = rel.resource_id
           JOIN revision rev ON rev.id = rel.revision_id
          WHERE rel.resource_id = ? AND rel.environment = ? AND rel.state = 'converged'`,
      )
      .get(resourceId, environment);
    if (!row) return null;

    const route = this.app.db
      .query<{ base_path: string }, [string, string]>(
        "SELECT base_path FROM route WHERE resource_id = ? AND environment = ?",
      )
      .get(resourceId, environment);

    let operations: Array<{ operationId: string; method: string; path: string }> = [];
    try {
      const model = JSON.parse(row.model) as ApiModel;
      operations = (model.operations ?? []).map((op) => ({
        operationId: op.operationId,
        method: (op.method ?? "POST").toUpperCase(),
        path: op.path ?? "/",
      }));
    } catch {
      operations = [];
    }
    if (operations.length === 0) {
      operations = [{ operationId: "invoke", method: "POST", path: "/" }];
    }

    const gateways = this.app.db
      .query<{ name: string }, [string]>("SELECT name FROM target WHERE environment = ?")
      .all(environment)
      .map((t) => t.name);

    const consumers = this.app.db
      .query<{ id: string; application_id: string }, [string, string]>(
        `SELECT s.id, s.application_id
           FROM subscription s
           JOIN product_member pm ON pm.product_id = s.product_id
          WHERE pm.resource_id = ? AND s.environment = ? AND s.state = 'active'`,
      )
      .all(resourceId, environment);

    return {
      resourceId,
      resourceName: row.name,
      environment,
      basePath: route?.base_path ?? `/${row.name}`,
      operations,
      gateways: gateways.length ? gateways : ["managed"],
      consumers: consumers.length ? consumers : [{ id: "", application_id: row.application_id }],
    };
  }

  /**
   * The entries for one minute. `weight` scales the volume when the window is sampled, so a
   * sampled month and a walked hour describe the same traffic rate.
   */
  private minuteOf(context: MockContext, minute: number, weight: number): LogEntry[] {
    const rng = mulberry32(hash(`${context.resourceId}|${context.environment}|${minute}`));
    // A diurnal shape, because a flat line reads as fabricated at a glance and hides whether the
    // histogram's axis is working.
    const hour = new Date(minute * 60_000).getUTCHours();
    const busyness = 0.35 + 0.65 * Math.sin(((hour - 3) / 24) * Math.PI * 2) ** 2;
    const count = Math.round(rng() * 6 * busyness * weight);
    const out: LogEntry[] = [];
    for (let i = 0; i < count; i++) {
      const operation = context.operations[Math.floor(rng() * context.operations.length)]!;
      const consumer = context.consumers[Math.floor(rng() * context.consumers.length)]!;
      const roll = rng();
      const status = roll > 0.975 ? 500 : roll > 0.93 ? 429 : roll > 0.89 ? 404 : roll > 0.87 ? 401 : 200;
      const backendMs = status >= 500 ? Math.round(2000 + rng() * 8000) : Math.round(12 + rng() ** 3 * 900);
      const gatewayMs = Math.round(1 + rng() * 6);
      const at = new Date(minute * 60_000 + Math.floor(rng() * 60_000)).toISOString();
      out.push({
        id: `mock-${context.resourceId}-${minute}-${i}`,
        at,
        environment: context.environment,
        gateway: context.gateways[Math.floor(rng() * context.gateways.length)]!,
        instance: `${context.environment}-${1 + Math.floor(rng() * 2)}`,
        resourceId: context.resourceId,
        resourceName: context.resourceName,
        operationId: status === 404 ? null : operation.operationId,
        method: operation.method,
        path: joinPath(context.basePath, fillTemplate(operation.path, rng)),
        status,
        durationMs: status === 429 || status === 401 ? gatewayMs : gatewayMs + backendMs,
        backendMs: status === 429 || status === 401 ? null : backendMs,
        subscriptionId: consumer.id || null,
        consumerApplicationId: consumer.application_id,
        clientIp: `10.${Math.floor(rng() * 254)}.${Math.floor(rng() * 254)}.${1 + Math.floor(rng() * 250)}`,
        requestId: `req-${hash(`${context.resourceId}${minute}${i}`).toString(16).padStart(8, "0")}`,
        error:
          status === 429
            ? "rate limit exceeded"
            : status === 401
              ? "no valid subscription key"
              : status === 500
                ? "upstream returned 500"
                : null,
      });
    }
    return out;
  }
}

interface MockContext {
  resourceId: string;
  resourceName: string;
  environment: string;
  basePath: string;
  operations: Array<{ operationId: string; method: string; path: string }>;
  gateways: string[];
  consumers: Array<{ id: string; application_id: string }>;
}

function matches(entry: LogEntry, query: LogQuery): boolean {
  if (query.statusClass) {
    const base = Number(query.statusClass[0]) * 100;
    if (entry.status < base || entry.status >= base + 100) return false;
  }
  if (query.method && entry.method !== query.method.toUpperCase()) return false;
  if (query.subscriptionId && entry.subscriptionId !== query.subscriptionId) return false;
  if (query.minDurationMs !== undefined && entry.durationMs < query.minDurationMs) return false;
  if (query.pathContains && !entry.path.toLowerCase().includes(query.pathContains.toLowerCase())) {
    return false;
  }
  return true;
}

function fillTemplate(path: string, rng: () => number): string {
  return path.replace(/\{[^}]+\}/g, () => String(1000 + Math.floor(rng() * 9000)));
}

function joinPath(base: string, rest: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = rest.startsWith("/") ? rest : `/${rest}`;
  return `${left}${right === "/" ? "" : right}` || "/";
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[index]!);
}

// ---------------------------------------------------------------------------- shared helpers

/**
 * A bucket width from the window and a target bucket count, snapped to a round unit.
 *
 * Snapping matters: a 37-second bucket produces an axis nobody can read, and two screens showing
 * the same window would disagree about where a spike sits.
 */
export function intervalFor(from: Date, to: Date, buckets: number): number {
  const seconds = Math.max(1, Math.round((to.getTime() - from.getTime()) / 1000));
  const ideal = seconds / Math.max(1, buckets);
  const UNITS = [10, 30, 60, 300, 600, 1800, 3600, 10800, 21600, 43200, 86400, 604800];
  return UNITS.find((unit) => unit >= ideal) ?? UNITS[UNITS.length - 1]!;
}

export function emptyBuckets(from: Date, to: Date, intervalSec: number): HistogramBucket[] {
  const out: HistogramBucket[] = [];
  const step = intervalSec * 1000;
  // Aligned to the interval so two windows of the same width bucket the same instants together.
  const start = Math.floor(from.getTime() / step) * step;
  for (let at = start; at <= to.getTime(); at += step) {
    out.push({
      at: new Date(at).toISOString(),
      total: 0,
      ok: 0,
      clientError: 0,
      serverError: 0,
      p50Ms: null,
      p95Ms: null,
    });
  }
  return out;
}

export function createLogSearch(app: App): LogSearchProvider {
  return app.config.logs.provider === "elk" ? new ElkLogSearch(app.config.logs) : new MockLogSearch(app);
}

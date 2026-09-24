import { randomBytes } from "node:crypto";
import {
  Router,
  readJson,
  requireUser,
  json,
  badRequest,
  notFound,
  conflict,
  type Ctx,
} from "./router.ts";
import { assertCan } from "./api/common.ts";
import { can } from "./auth.ts";
import { newId, nowIso } from "./db.ts";
import { emitIntegration, requestApproval } from "./integrations.ts";
import { writeAudit } from "./audit.ts";
import { domainError } from "../../shared/domains.ts";
import { TOPIC_SCHEMA_TYPES, topicApiBlockers, topicApiDefinition } from "../../shared/kafka-proxy.ts";
import {
  PLAYGROUND_MAX_HEADERS,
  PLAYGROUND_MAX_MESSAGES,
  PLAYGROUND_MAX_VALUE,
  TOPIC_AUTH_TYPES,
  TOPIC_COMPATIBILITIES,
  TOPIC_LIMITS,
  TOPIC_NAME_PATTERN,
  TOPIC_OPERATIONS,
  TOPIC_SIZES,
  buildTopicName,
  displayNameError,
  dnMatches,
  groupIdFor,
  principalError,
  schemaCheck,
  topicFamily,
  topicVersion,
  versionError,
  wikiLinkError,
  type TopicOperation,
} from "../../shared/kafka.ts";
import { certificateUsable, parseSchema, topicApiOf, topicFacts, type TopicRow } from "./kafka-proxy.ts";
import { configureResource, currentSnapshot } from "./operations.ts";
import { getResource } from "./api/common.ts";

type Topic = TopicRow;

interface AccessRow {
  id: string;
  topic_id: string;
  application_id: string;
  purpose: string;
  state: string;
  requested_by: string;
  decision_by: string | null;
  created_at: string;
  principal: string | null;
  auth_type: string | null;
  operation: string;
  group_id: string | null;
  request_id: string | null;
}

const LIVE = "('pending','activating','active','revoking')";

/** What a topic is produced with: its schema, how the registry holds it to its past, and its certificate. */
interface ContractInput {
  schemaType?: string | null;
  /** The definition as text, of any of the three types. */
  schemaDefinition?: string | null;
  /** A JSON topic's schema as an object — kept for the API clients written before any type had text. */
  schema?: unknown;
  compatibility?: string | null;
  certificateId?: string | null;
}
type Contract = Pick<TopicRow, "schema_type" | "schema_json" | "schema_text" | "compatibility" | "certificate_id">;

/**
 * The schema, compatibility and certificate a write is asking for, on top of what the topic has
 * (kafka-workspace, "A topic carries a schema of its type"). Absent keeps a field; `null` clears it.
 *
 * Every type carries its definition now. A JSON topic's is stored as JSON because it is also the
 * request body of the topic's HTTP API (kafka-rest-proxy) and the compiler reads it as an object;
 * an Avro or Protobuf topic's is stored as the text that was written, because that is what a
 * registry is handed. The check is `schemaCheck`, the one the wizard runs before Next.
 */
function readContract(
  db: Ctx["app"]["db"],
  topic: Pick<TopicRow, "application_id" | "environment" | "name"> & Partial<Contract>,
  body: ContractInput,
): Contract {
  let schemaType = topic.schema_type ?? null;
  const typeChanged = body.schemaType !== undefined && (body.schemaType || null) !== schemaType;
  if (body.schemaType !== undefined) {
    schemaType = body.schemaType || null;
    if (schemaType && !(TOPIC_SCHEMA_TYPES as readonly string[]).includes(schemaType))
      throw badRequest(`schemaType: one of ${TOPIC_SCHEMA_TYPES.join(", ")}`);
  }

  let text: string | null | undefined;
  if (body.schemaDefinition !== undefined) text = body.schemaDefinition || null;
  else if (body.schema !== undefined)
    text =
      body.schema === null || body.schema === ""
        ? null
        : typeof body.schema === "string"
          ? body.schema
          : JSON.stringify(body.schema);

  let schemaJson = topic.schema_json ?? null;
  let schemaText = topic.schema_text ?? null;
  // A new type with no new definition leaves nothing behind: the old definition was another
  // language's, and keeping it would be a JSON Schema filed under PROTOBUF.
  if (typeChanged && text === undefined) {
    schemaJson = null;
    schemaText = null;
  }
  if (text !== undefined) {
    if (text === null) {
      schemaJson = null;
      schemaText = null;
    } else {
      if (!schemaType) throw badRequest("schemaType: a definition needs its type — json, avro or protobuf");
      const check = schemaCheck(schemaType, text, topic.name);
      if (check.level === "error") throw badRequest(check.message);
      schemaJson = schemaType === "json" ? JSON.stringify(JSON.parse(text)) : null;
      schemaText = schemaType === "json" ? null : text;
    }
  }

  let compatibility = topic.compatibility ?? null;
  if (body.compatibility !== undefined) {
    compatibility = body.compatibility || null;
    if (compatibility && !(TOPIC_COMPATIBILITIES as readonly string[]).includes(compatibility))
      throw badRequest(`compatibility: one of ${TOPIC_COMPATIBILITIES.join(", ")}, or empty for the registry's default`);
  }

  let certificateId = topic.certificate_id ?? null;
  if (body.certificateId !== undefined) {
    certificateId = body.certificateId || null;
    if (certificateId && !certificateUsable(db, certificateId, topic))
      throw badRequest(
        `certificateId: choose a certificate of this topic's application in ` +
          `${topic.environment.toUpperCase()} that has not expired`,
      );
  }
  return {
    schema_type: schemaType,
    schema_json: schemaJson,
    schema_text: schemaText,
    compatibility,
    certificate_id: certificateId,
  };
}

/** The definition as the editor shows it, whichever column holds it. */
function definitionOf(t: Pick<TopicRow, "schema_json" | "schema_text">): string | null {
  if (t.schema_json) {
    try {
      return JSON.stringify(JSON.parse(t.schema_json), null, 2);
    } catch {
      return t.schema_json;
    }
  }
  return t.schema_text;
}

function intIn(value: unknown, field: keyof typeof TOPIC_LIMITS, label: string): number {
  const { min, max } = TOPIC_LIMITS[field];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw badRequest(`${label}: ${min}–${max}`);
  return value as number;
}

function applicationNames(ctx: Ctx): Map<string, string> {
  return new Map(
    ctx.app.db
      .query<{ id: string; name: string }, []>("SELECT id, name FROM application")
      .all()
      .map((row) => [row.id, row.name]),
  );
}

/** Consumers per topic row: the applications holding a live READ, which is what "consumer" means on a broker. */
function consumerCounts(ctx: Ctx): Map<string, number> {
  return new Map(
    ctx.app.db
      .query<{ topic_id: string; n: number }, []>(
        `SELECT topic_id, COUNT(DISTINCT application_id) AS n FROM kafka_access
          WHERE operation = 'read' AND state IN ('activating','active') GROUP BY topic_id`,
      )
      .all()
      .map((row) => [row.topic_id, row.n]),
  );
}

/** A topic as the portal reads it: the row, in camel case where the screens read it, and its API. */
function topicView(ctx: Ctx, t: Topic, names: Map<string, string>, consumers: Map<string, number>) {
  const api = topicApiOf(ctx.app.db, t);
  return {
    ...t,
    applicationId: t.application_id,
    applicationName: names.get(t.application_id) ?? t.application_id,
    canEdit: can(ctx.user, t.application_id),
    displayName: t.display_name || t.name,
    version: topicVersion(t.name),
    family: topicFamily(t.name),
    replication: t.replication,
    retentionDays: t.retention_days,
    minInsyncReplicas: t.min_insync_replicas,
    schemaType: t.schema_type,
    schema: parseSchema(t.schema_json),
    schemaDefinition: definitionOf(t),
    schemaVersion: t.schema_version,
    compatibility: t.compatibility,
    // The registry's subject for a record's value — TopicNameStrategy, the one every client defaults to.
    subject: `${t.name}-value`,
    wikiLink: t.wiki_link,
    certificateId: t.certificate_id,
    consumers: consumers.get(t.id) ?? 0,
    createdAt: t.created_at,
    apiResourceId: api?.id ?? null,
    apiPublished: api ? currentSnapshot(ctx, api.id, t.environment) !== null : false,
    apiBlockers: topicApiBlockers(topicFacts(ctx.app.db, t)),
  };
}

function topic(ctx: Ctx): Topic {
  const t = ctx.app.db.query<Topic, [string]>("SELECT * FROM kafka_topic WHERE id=?").get(ctx.params.id!);
  if (!t) throw notFound("topic not found");
  return t;
}

function label(environment: string): string {
  return environment.toUpperCase();
}

/** Six characters that make one grant's consumer group its own. */
function groupSuffix(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * The partition a keyed record lands on: a stable hash of the key, so one key's records stay in
 * order the way a broker's default partitioner keeps them. Not murmur2 — the simulated broker only
 * has to be consistent with itself.
 */
function partitionFor(key: string, partitions: number): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) | 0;
  return Math.abs(hash) % partitions;
}

function readHeaders(raw: unknown): Array<{ key: string; value: string }> {
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw)
    ? raw.map((h) => [String((h as { key?: unknown })?.key ?? ""), String((h as { value?: unknown })?.value ?? "")] as const)
    : typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const)
      : null;
  if (!entries) throw badRequest("headers: a list of { key, value }");
  const headers = entries.filter(([key]) => key.trim()).map(([key, value]) => ({ key: key.trim(), value }));
  if (headers.length > PLAYGROUND_MAX_HEADERS) throw badRequest(`headers: at most ${PLAYGROUND_MAX_HEADERS}`);
  if (headers.some((h) => h.key.length > 200 || h.value.length > 2000))
    throw badRequest("headers: a key up to 200 characters, a value up to 2000");
  return headers;
}

export function registerKafkaRoutes(router: Router) {
  router.add("GET", "/api/kafka/topics", "session", (ctx) => {
    const name = ctx.url.searchParams.get("name");
    const all = name
      ? ctx.app.db.query<Topic, [string]>("SELECT * FROM kafka_topic WHERE name = ? ORDER BY created_at").all(name)
      : ctx.app.db.query<Topic, []>("SELECT * FROM kafka_topic ORDER BY name, created_at").all();
    const names = applicationNames(ctx);
    const consumers = consumerCounts(ctx);
    // A row in a stage with no cluster was written before Kafka had its own stages; it names a topic
    // nobody can connect to, so it is not listed rather than drawn with no chevron to open it by.
    const stages = new Set(ctx.app.config.kafka.environments);
    const rows = all.filter((t) => stages.has(t.environment));
    return json({
      simulated: true,
      // Kafka's stages, not the API chain's: the list and the topic page draw one chevron per stage
      // a cluster exists in (kafka-workspace, "Kafka has its own stages").
      chain: ctx.app.config.kafka.environments,
      items: rows.map((t) => topicView(ctx, t, names, consumers)),
    });
  });

  /**
   * Where a client connects (kafka-workspace, "The connection is shown"): the stage's public
   * bootstrap host and one listener per way of authenticating. Unset is said as unset, with the
   * variable that sets it — an invented address would be copied into somebody's client config.
   */
  router.add("GET", "/api/kafka/connection", "session", (ctx) => {
    const environment = ctx.url.searchParams.get("environment") ?? "";
    if (!ctx.app.config.kafka.environments.includes(environment))
      throw badRequest("environment: one of " + ctx.app.config.kafka.environments.join(", "));
    const host = ctx.app.config.kafka.bootstrap[environment] ?? null;
    const { mtlsPort, oauthPort } = ctx.app.config.kafka;
    return json({
      environment,
      simulated: true,
      bootstrap: host,
      variable: `KAFKA_BOOTSTRAP_${environment.toUpperCase()}`,
      listeners: [
        { authType: "mtls", port: mtlsPort, address: host ? `${host}:${mtlsPort}` : null },
        { authType: "oauth", port: oauthPort, address: host ? `${host}:${oauthPort}` : null },
      ],
    });
  });

  router.add("POST", "/api/kafka/topics", "session", async (ctx) => {
    const u = requireUser(ctx),
      body = await readJson<{
        applicationId?: string;
        environment?: string;
        name?: string;
        displayName?: string;
        version?: string;
        size?: string;
        partitions?: number;
        replication?: number;
        retentionDays?: number | null;
        minInsyncReplicas?: number | null;
        description?: string;
        wikiLink?: string | null;
        domain?: string;
        subdomain?: string;
      } & ContractInput>(ctx, 300_000);
    assertCan(u, body.applicationId, "create a topic");
    const chain = ctx.app.config.kafka.environments;
    const first = chain[0]!;
    // A topic starts in Kafka's first stage — TEST, there being no DEV cluster — and reaches the next
    // by being staged there, so PROD never holds a topic TEST has not had.
    const environment = body.environment ?? first;
    if (!chain.includes(environment))
      throw badRequest(`environment: Kafka has ${chain.map(label).join(" and ")} only`);
    if (environment !== first)
      throw badRequest(`a topic is created in ${label(first)} and staged onward from its page`);

    // A topic is a catalog item like any other, so it is classified like any other; and the name is
    // built from the classification, so the domain is required before there is a name at all.
    const domain = body.domain?.trim() || null;
    const subdomain = body.subdomain?.trim() || null;
    if (!domain) throw badRequest("domain: required — every catalog item belongs to a domain");
    const problem = domainError(domain, subdomain);
    if (problem) throw badRequest(problem);

    const application = ctx.app.db
      .query<{ name: string }, [string]>("SELECT name FROM application WHERE id = ?")
      .get(body.applicationId!);
    if (!application) throw badRequest("applicationId: no such application");

    let name: string;
    let displayName: string;
    if (body.name !== undefined) {
      // An explicit name is still accepted from an API client — a topic that already exists on a
      // broker keeps the name it has — and held to the broker's pattern.
      name = body.name;
      if (!TOPIC_NAME_PATTERN.test(name))
        throw badRequest("topic name: 2–101 letters, numbers, dots, underscores or hyphens");
      displayName = body.displayName?.trim() || name;
    } else {
      displayName = body.displayName?.trim() ?? "";
      const version = (body.version ?? "v1").trim().toLowerCase();
      const nameProblem = displayNameError(displayName) ?? versionError(version);
      if (nameProblem) throw badRequest(nameProblem);
      name = buildTopicName({ domain, subdomain, application: application.name, displayName, version });
      if (!TOPIC_NAME_PATTERN.test(name))
        throw badRequest(`topic name: ${name} is longer than the broker allows; shorten the display name`);
    }
    const nameProblem = displayNameError(displayName);
    if (nameProblem) throw badRequest(nameProblem);

    const size = body.size ? TOPIC_SIZES[body.size as keyof typeof TOPIC_SIZES] : TOPIC_SIZES.S;
    if (!size) throw badRequest("size: S, M or L — or give the numbers");
    const partitions = intIn(body.partitions ?? size.partitions, "partitions", "partitions");
    const replication = intIn(body.replication ?? size.replication, "replication", "replication");
    const retentionDays =
      body.retentionDays === null ? null : intIn(body.retentionDays ?? size.retentionDays, "retentionDays", "retention (days)");
    const minInsync =
      body.minInsyncReplicas === undefined || body.minInsyncReplicas === null
        ? null
        : intIn(body.minInsyncReplicas, "minInsyncReplicas", "min.insync.replicas");
    if (minInsync !== null && minInsync > replication)
      throw badRequest("min.insync.replicas: at most the replication factor, or no write could ever succeed");
    const wikiProblem = wikiLinkError(body.wikiLink);
    if (wikiProblem) throw badRequest(wikiProblem);
    const description = body.description ?? "";
    if (description.length > 20_000) throw badRequest("description: at most 20 000 characters");

    const existing = ctx.app.db
      .query<{ environment: string; application_id: string; state: string }, [string]>(
        "SELECT environment, application_id, state FROM kafka_topic WHERE name = ?",
      )
      .all(name);
    if (existing.some((row) => row.application_id !== body.applicationId))
      throw conflict(`${name} is another application's topic`);
    if (existing.some((row) => row.environment === environment))
      throw conflict(
        existing.find((row) => row.environment === environment)!.state === "deleted"
          ? `${name} was deleted in ${label(environment)}; a topic name is not reused there — choose another version`
          : "topic already exists",
      );

    const contract = readContract(ctx.app.db, { application_id: body.applicationId!, environment, name }, body);
    const hasSchema = Boolean(contract.schema_json || contract.schema_text);
    const id = newId("topic");
    ctx.app.db.transaction(() => {
      ctx.app.db.run(
        `INSERT INTO kafka_topic(id,application_id,environment,name,partitions,description,domain,subdomain,created_at,
           schema_type,schema_json,schema_text,compatibility,certificate_id,display_name,replication,retention_days,
           min_insync_replicas,schema_version,wiki_link)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          body.applicationId!,
          environment,
          name,
          partitions,
          description,
          domain,
          subdomain,
          nowIso(),
          contract.schema_type,
          contract.schema_json,
          contract.schema_text,
          contract.compatibility,
          contract.certificate_id,
          displayName,
          replication,
          retentionDays,
          minInsync,
          hasSchema ? 1 : 0,
          body.wikiLink?.trim() || null,
        ],
      );
      emitIntegration(ctx.app, body.applicationId!, "kafka", "topic.create", id, {});
      writeAudit(ctx.app.db, {
        actor: u.id,
        action: "kafka.publish",
        subject: id,
        outcome: "ok",
        detail: { applicationId: body.applicationId, name, environment, simulated: true },
      });
    })();
    return json({ id, name, environment, state: "provisioning", simulated: true }, { status: 202 });
  });

  router.add("PATCH", "/api/kafka/topics/:id", "session", async (ctx) => {
    const t = topic(ctx);
    assertCan(ctx.user, t.application_id, "configure topic");
    const body = await readJson<{
      displayName?: string;
      description?: string;
      wikiLink?: string | null;
      partitions?: number;
      retentionDays?: number | null;
      minInsyncReplicas?: number | null;
      replication?: number;
      domain?: string;
      subdomain?: string | null;
    } & ContractInput>(ctx, 300_000);
    if (t.state === "deleted") throw conflict("topic was deleted");
    if (body.partitions !== undefined) {
      intIn(body.partitions, "partitions", "partitions");
      // A broker adds partitions and never takes one away: a record's partition is its order.
      if (body.partitions < t.partitions) throw badRequest("partitions may only increase, up to 100");
    }
    if (body.replication !== undefined && body.replication !== t.replication)
      throw badRequest("replication: fixed when the topic is created — changing it is a reassignment, not a setting");
    // The name carries the domain, so moving the topic would leave a name that says the wrong thing
    // on every consumer's configuration. A differently classified topic is a new topic.
    if (
      (body.domain !== undefined && (body.domain.trim() || null) !== t.domain) ||
      (body.subdomain !== undefined && (body.subdomain?.trim() || null) !== t.subdomain)
    )
      throw badRequest("domain: fixed when the topic is created — its name carries it");
    const retentionDays =
      body.retentionDays === undefined
        ? t.retention_days
        : body.retentionDays === null
          ? null
          : intIn(body.retentionDays, "retentionDays", "retention (days)");
    const minInsync =
      body.minInsyncReplicas === undefined
        ? t.min_insync_replicas
        : body.minInsyncReplicas === null
          ? null
          : intIn(body.minInsyncReplicas, "minInsyncReplicas", "min.insync.replicas");
    if (minInsync !== null && minInsync > t.replication)
      throw badRequest("min.insync.replicas: at most the replication factor, or no write could ever succeed");
    const displayName = body.displayName === undefined ? t.display_name : body.displayName.trim();
    if (body.displayName !== undefined) {
      const problem = displayNameError(displayName ?? "");
      if (problem) throw badRequest(problem);
    }
    const wikiProblem = body.wikiLink === undefined ? null : wikiLinkError(body.wikiLink);
    if (wikiProblem) throw badRequest(wikiProblem);
    if (body.description !== undefined && body.description.length > 20_000)
      throw badRequest("description: at most 20 000 characters");
    const next = readContract(ctx.app.db, t, body);
    const definitionChanged =
      next.schema_type !== t.schema_type || next.schema_json !== t.schema_json || next.schema_text !== t.schema_text;
    const hasSchema = Boolean(next.schema_json || next.schema_text);

    /**
     * A topic with an API in its stage carries that API with it (kafka-rest-proxy, "A schema edit
     * regenerates the topic's API"): a new schema is a new definition and a new certificate a new
     * binding, queued as an ordinary configure before the topic row changes — so a schema the
     * compiler refuses leaves both as they were, rather than the topic saying one thing and its API
     * another. What the API cannot run without cannot be taken off while it exists.
     */
    const api = topicApiOf(ctx.app.db, t);
    let operation: unknown = null;
    if (api && currentSnapshot(ctx, api.id, t.environment)) {
      if (next.schema_type !== "json" || !next.schema_json || !next.certificate_id)
        throw conflict(
          `${t.name} has an API in ${label(t.environment)}, which needs a JSON schema and a ` +
            "client certificate. Keep both, or retire the API first.",
        );
      const schemaChanged = next.schema_json !== t.schema_json;
      const certificateChanged = next.certificate_id !== t.certificate_id;
      if (schemaChanged || certificateChanged) {
        const response = await configureResource(
          ctx,
          getResource(ctx, api.id),
          {
            environment: t.environment,
            ...(schemaChanged
              ? {
                  spec: topicApiDefinition(
                    t.name,
                    parseSchema(next.schema_json)!,
                    body.description ?? t.description,
                  ),
                }
              : {}),
            ...(certificateChanged ? { clientCertRef: next.certificate_id } : {}),
          },
          { generated: true, idempotencyKey: newId("kafka") },
        );
        operation = await response.json();
      }
    }

    // A changed definition is the subject's next version, the way a registry numbers it; clearing
    // the definition leaves the number where it was, because the registry keeps what it had.
    const schemaVersion = definitionChanged && hasSchema ? t.schema_version + 1 : t.schema_version;
    ctx.app.db.run(
      `UPDATE kafka_topic SET description=?,partitions=?,retention_days=?,min_insync_replicas=?,display_name=?,wiki_link=?,
         schema_type=?,schema_json=?,schema_text=?,compatibility=?,certificate_id=?,schema_version=? WHERE id=?`,
      [
        body.description ?? t.description,
        body.partitions ?? t.partitions,
        retentionDays,
        minInsync,
        displayName,
        body.wikiLink === undefined ? t.wiki_link : body.wikiLink?.trim() || null,
        next.schema_type,
        next.schema_json,
        next.schema_text,
        next.compatibility,
        next.certificate_id,
        schemaVersion,
        t.id,
      ],
    );
    // The schema itself is not audited — it can be a quarter of a megabyte — only that it changed.
    const { schema: _schema, schemaDefinition: _definition, description: _description, ...audited } = body;
    writeAudit(ctx.app.db, {
      actor: requireUser(ctx).id,
      action: "kafka.configure",
      subject: t.id,
      outcome: "ok",
      detail: {
        applicationId: t.application_id,
        ...audited,
        ...(body.description !== undefined ? { descriptionChanged: body.description !== t.description } : {}),
        ...(definitionChanged ? { schemaVersion } : {}),
        simulated: true,
      },
    });
    return json({ id: t.id, schemaVersion, simulated: true, operation });
  });

  /**
   * Stage a topic to the next stage of the chain (kafka-workspace, "A topic is staged along the
   * chain"): the same name, size, schema and description in a new row of the next stage, created
   * there by the broker integration like any topic. The certificate is not carried — a certificate
   * belongs to one stage — so an HTTP proxy there is its own decision.
   */
  router.add("POST", "/api/kafka/topics/:id/stage", "session", (ctx) => {
    const t = topic(ctx);
    const u = requireUser(ctx);
    assertCan(u, t.application_id, "stage topic");
    if (t.state !== "ready") throw conflict(`${t.name} is ${t.state} in ${label(t.environment)}; stage it once it is ready`);
    const chain = ctx.app.config.kafka.environments;
    // A row in a stage with no cluster — written before Kafka had its own stages — goes nowhere.
    if (!chain.includes(t.environment)) throw conflict(`Kafka has no ${label(t.environment)}; ${t.name} cannot be staged from it`);
    const next = chain[chain.indexOf(t.environment) + 1];
    if (!next) throw conflict(`${label(t.environment)} is the last stage`);
    const there = ctx.app.db
      .query<{ state: string }, [string, string]>("SELECT state FROM kafka_topic WHERE environment = ? AND name = ?")
      .get(next, t.name);
    if (there)
      throw conflict(
        there.state === "deleted"
          ? `${t.name} was deleted in ${label(next)}; a topic name is not reused there — create a new version instead`
          : `${t.name} is already in ${label(next)}`,
      );
    const id = newId("topic");
    ctx.app.db.transaction(() => {
      ctx.app.db.run(
        `INSERT INTO kafka_topic(id,application_id,environment,name,partitions,description,domain,subdomain,created_at,
           schema_type,schema_json,schema_text,compatibility,certificate_id,display_name,replication,retention_days,
           min_insync_replicas,schema_version,wiki_link)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)`,
        [
          id,
          t.application_id,
          next,
          t.name,
          t.partitions,
          t.description,
          t.domain,
          t.subdomain,
          nowIso(),
          t.schema_type,
          t.schema_json,
          t.schema_text,
          t.compatibility,
          t.display_name,
          t.replication,
          t.retention_days,
          t.min_insync_replicas,
          t.schema_json || t.schema_text ? 1 : 0,
          t.wiki_link,
        ],
      );
      emitIntegration(ctx.app, t.application_id, "kafka", "topic.create", id, { stagedFrom: t.id });
      writeAudit(ctx.app.db, {
        actor: u.id,
        action: "kafka.stage",
        subject: id,
        outcome: "ok",
        detail: { applicationId: t.application_id, name: t.name, from: t.environment, to: next, simulated: true },
      });
    })();
    return json({ id, name: t.name, environment: next, state: "provisioning", simulated: true }, { status: 202 });
  });

  router.add("DELETE", "/api/kafka/topics/:id", "session", (ctx) => {
    const t = topic(ctx);
    assertCan(ctx.user, t.application_id, "delete topic");
    if (ctx.app.db.query(`SELECT id FROM kafka_access WHERE topic_id=? AND state IN ${LIVE}`).get(t.id))
      throw conflict("revoke or cancel topic subscriptions first");
    // Its API would go on answering, bound to a topic that no longer exists and a certificate the
    // topic no longer names. Retiring the API is the owner's decision, made on its workspace.
    const api = topicApiOf(ctx.app.db, t);
    if (api && currentSnapshot(ctx, api.id, t.environment))
      throw conflict(`${t.name} has an API in ${label(t.environment)}; retire the API first`);
    ctx.app.db.run("UPDATE kafka_topic SET state='deleted' WHERE id=?", [t.id]);
    writeAudit(ctx.app.db, {
      actor: requireUser(ctx).id,
      action: "kafka.delete",
      subject: t.id,
      outcome: "ok",
      detail: { applicationId: t.application_id, simulated: true },
    });
    return json({ id: t.id, state: "deleted", simulated: true });
  });

  router.add("GET", "/api/kafka/access", "session", (ctx) => {
    const user = requireUser(ctx);
    const topicId = ctx.url.searchParams.get("topicId");
    const rows = ctx.app.db
      .query<AccessRow & { topicName: string; publisher: string; environment: string }, []>(
        `SELECT ka.*, kt.name AS topicName, kt.display_name AS topicDisplayName, kt.application_id AS publisher,
                kt.environment, a.name AS applicationName
           FROM kafka_access ka
           JOIN kafka_topic kt ON kt.id = ka.topic_id
           LEFT JOIN application a ON a.id = ka.application_id
          ORDER BY ka.created_at DESC`,
      )
      .all();
    return json({
      simulated: true,
      items: rows
        .filter((r) => (!topicId || r.topic_id === topicId) && (can(user, r.application_id) || can(user, r.publisher)))
        .map((r) => ({
          ...r,
          topicId: r.topic_id,
          applicationId: r.application_id,
          authType: r.auth_type,
          groupId: r.group_id,
          requestId: r.request_id ?? r.id,
          createdAt: r.created_at,
        })),
    });
  });

  /**
   * Ask for access to a topic for one principal (kafka-workspace, "Access is granted to a
   * principal, one operation at a time"): one row per operation, asked for together and decided
   * together. A READ gets a consumer group of its own. The owner's own request needs nobody's
   * approval; anyone else's goes to the owner through SkoNET, once for the whole request.
   */
  router.add("POST", "/api/kafka/topics/:id/subscribe", "session", async (ctx) => {
    const t = topic(ctx),
      u = requireUser(ctx);
    const body = await readJson<{
      applicationId?: string;
      purpose?: string;
      authType?: string;
      principal?: string;
      operations?: string[];
    }>(ctx);
    assertCan(u, body.applicationId, "request topic access");
    if (t.state !== "ready") throw conflict("topic is not ready");
    const purpose = body.purpose?.trim() ?? "";
    if (purpose.length < 3 || purpose.length > 500) throw badRequest("purpose: 3–500 characters");
    const authType = body.authType ?? "";
    if (!(TOPIC_AUTH_TYPES as readonly string[]).includes(authType)) throw badRequest("authType: mtls or oauth");
    const principal = (body.principal ?? "").trim();
    const principalProblem = principalError(authType, principal);
    if (principalProblem) throw badRequest(principalProblem);
    const operations = [...new Set(body.operations ?? [])];
    if (operations.length === 0 || operations.some((op) => !(TOPIC_OPERATIONS as readonly string[]).includes(op)))
      throw badRequest(`operations: one or more of ${TOPIC_OPERATIONS.join(", ")}`);
    const held = ctx.app.db
      .query<{ operation: string }, [string, string, string]>(
        `SELECT operation FROM kafka_access WHERE topic_id=? AND application_id=? AND principal=? AND state IN ${LIVE}`,
      )
      .all(t.id, body.applicationId!, principal)
      .map((row) => row.operation);
    const repeated = operations.filter((op) => held.includes(op));
    if (repeated.length > 0)
      throw conflict(
        `${repeated.map((op) => op.toUpperCase()).join(", ")} for this principal is already requested or granted`,
      );
    const application = ctx.app.db
      .query<{ name: string }, [string]>("SELECT name FROM application WHERE id = ?")
      .get(body.applicationId!);
    const own = body.applicationId === t.application_id;
    const state = own ? "activating" : "pending";
    const ordered = TOPIC_OPERATIONS.filter((op) => operations.includes(op));
    const items = ordered.map((operation: TopicOperation) => ({
      id: newId("acl"),
      operation,
      state,
      groupId: operation === "read" ? groupIdFor(t.name, application?.name ?? body.applicationId!, groupSuffix()) : null,
    }));
    const requestId = items[0]!.id;
    ctx.app.db.transaction(() => {
      const at = nowIso();
      for (const item of items) {
        ctx.app.db.run(
          `INSERT INTO kafka_access(id,topic_id,application_id,purpose,state,requested_by,created_at,principal,auth_type,operation,group_id,request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [item.id, t.id, body.applicationId!, purpose, state, u.id, at, principal, authType, item.operation, item.groupId, requestId],
        );
        if (own) emitIntegration(ctx.app, body.applicationId!, "kafka", "access.grant", item.id, {});
      }
      if (!own) requestApproval(ctx.app, body.applicationId!, t.application_id, requestId, "kafka", purpose);
      writeAudit(ctx.app.db, {
        actor: u.id,
        action: "kafka.subscribe",
        subject: requestId,
        outcome: "ok",
        detail: { applicationId: body.applicationId, topicId: t.id, principal, authType, operations: ordered, simulated: true },
      });
    })();
    return json({ id: requestId, requestId, state, items, simulated: true }, { status: 201 });
  });

  /**
   * Take a grant away. A pending request is cancelled whole — it was asked for, and will be decided,
   * as one — and a granted operation is revoked on its own, so a consumer can drop WRITE and keep READ.
   */
  router.add("DELETE", "/api/kafka/access/:id", "session", (ctx) => {
    const row = ctx.app.db
      .query<AccessRow & { publisher: string }, [string]>(
        "SELECT ka.*,kt.application_id AS publisher FROM kafka_access ka JOIN kafka_topic kt ON kt.id=ka.topic_id WHERE ka.id=?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound("access request not found");
    if (!can(ctx.user, row.publisher)) assertCan(ctx.user, row.application_id, "revoke topic access");
    const state =
      row.state === "pending"
        ? "cancelled"
        : row.state === "active" || row.state === "activating"
          ? "revoking"
          : row.state;
    const affected =
      state === "cancelled"
        ? ctx.app.db
            .query<{ id: string }, [string]>("SELECT id FROM kafka_access WHERE request_id=? AND state='pending'")
            .all(row.request_id ?? row.id)
            .map((r) => r.id)
        : [row.id];
    ctx.app.db.transaction(() => {
      for (const id of affected) {
        ctx.app.db.run("UPDATE kafka_access SET state=? WHERE id=?", [state, id]);
        if (state === "revoking") emitIntegration(ctx.app, row.application_id, "kafka", "access.revoke", id, {});
      }
    })();
    writeAudit(ctx.app.db, {
      actor: requireUser(ctx).id,
      action: "kafka.revoke",
      subject: row.id,
      outcome: "ok",
      detail: { applicationId: row.application_id, affected, simulated: true },
    });
    return json({ id: row.id, state, affected, simulated: true });
  });

  /**
   * The playground (kafka-playground): one read or one write against the simulated broker, as one
   * of the application's own grants. The grant is the identity — a WRITE produces, a READ consumes —
   * and an mTLS grant is exercised with a certificate whose subject is that grant's DN, which is what
   * the broker would check. Reads are group-less: a test must not move the offsets of the consumer
   * group a real client of this grant is reading through.
   */
  router.add("POST", "/api/kafka/topics/:id/playground", "session", async (ctx) => {
    const t = topic(ctx),
      u = requireUser(ctx),
      body = await readJson<{
        applicationId?: string;
        accessId?: string;
        action?: string;
        certificateId?: string | null;
        partition?: number | null;
        position?: { kind?: string; count?: number; offset?: number; at?: string } | null;
        maxMessages?: number;
        key?: string | null;
        headers?: unknown;
        value?: string;
      }>(ctx, 65536);
    assertCan(u, body.applicationId, "use this application playground");
    if (t.state !== "ready") throw conflict("topic is unavailable");
    if (body.action !== "produce" && body.action !== "consume") throw badRequest("action: produce or consume");
    const grant = body.accessId
      ? ctx.app.db
          .query<AccessRow, [string, string, string]>(
            "SELECT * FROM kafka_access WHERE id=? AND topic_id=? AND application_id=?",
          )
          .get(body.accessId, t.id, body.applicationId!)
      : null;
    if (!grant) throw conflict("choose one of this application's grants on the topic");
    if (grant.state !== "active") throw conflict(`the grant is ${grant.state}; only an active grant can be used`);
    const needed = body.action === "produce" ? "write" : "read";
    if (grant.operation !== needed)
      throw conflict(
        `this grant allows ${grant.operation.toUpperCase()}; ${body.action === "produce" ? "a write" : "a read"} needs ${needed.toUpperCase()}`,
      );
    if (grant.auth_type === "mtls") {
      const cert = body.certificateId
        ? ctx.app.db
            .query<{ application_id: string; environment: string; not_after: string; subject: string }, [string]>(
              "SELECT application_id, environment, not_after, subject FROM certificate WHERE id=?",
            )
            .get(body.certificateId)
        : null;
      if (!cert) throw conflict("an mTLS grant is tested with a client certificate; choose one");
      if (cert.application_id !== body.applicationId || cert.environment !== t.environment)
        throw conflict(`the certificate has to be this application's, in ${label(t.environment)}`);
      if (Date.parse(cert.not_after) <= Date.now()) throw conflict("the certificate has expired");
      if (!dnMatches(cert.subject, grant.principal ?? ""))
        throw conflict(`the certificate's subject ${cert.subject} is not the grant's principal ${grant.principal}`);
    }

    const partition = body.partition ?? null;
    if (partition !== null && (!Number.isInteger(partition) || partition < 0 || partition >= t.partitions))
      throw badRequest(`partition: 0–${t.partitions - 1}, or empty`);
    const detail = { applicationId: body.applicationId, accessId: grant.id, partition, simulated: true };

    if (body.action === "produce") {
      if (typeof body.value !== "string" || body.value.length > PLAYGROUND_MAX_VALUE)
        throw badRequest(`message: up to ${PLAYGROUND_MAX_VALUE} characters`);
      const key = body.key ? String(body.key) : null;
      if (key && key.length > 1024) throw badRequest("key: at most 1024 characters");
      const headers = readHeaders(body.headers);
      let record: Record<string, unknown> = {};
      ctx.app.db.transaction(() => {
        const produced = ctx.app.db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM kafka_message WHERE topic_id=?")
          .get(t.id)!.n;
        // Keyed records hash to a partition; unkeyed ones round-robin, like the default partitioner.
        const target = partition ?? (key ? partitionFor(key, t.partitions) : produced % t.partitions);
        const offset =
          (ctx.app.db
            .query<{ o: number | null }, [string, number]>(
              "SELECT MAX(msg_offset) AS o FROM kafka_message WHERE topic_id=? AND partition_no=?",
            )
            .get(t.id, target)?.o ?? -1) + 1;
        const at = nowIso();
        ctx.app.db.run(
          "INSERT INTO kafka_message(topic_id,application_id,value,created_at,partition_no,msg_offset,msg_key,headers_json) VALUES (?,?,?,?,?,?,?,?)",
          [t.id, body.applicationId!, body.value!, at, target, offset, key, headers.length ? JSON.stringify(headers) : null],
        );
        // The simulated broker keeps a topic's newest hundred records, whatever its retention says.
        ctx.app.db.run(
          "DELETE FROM kafka_message WHERE topic_id=? AND id NOT IN (SELECT id FROM kafka_message WHERE topic_id=? ORDER BY id DESC LIMIT 100)",
          [t.id, t.id],
        );
        record = { partition: target, offset, key, headers, value: body.value, timestamp: at };
      })();
      writeAudit(ctx.app.db, { actor: u.id, action: "kafka.produce", subject: t.id, outcome: "ok", detail });
      return json({ simulated: true, action: "produce", environment: t.environment, record });
    }

    const max = Math.min(
      PLAYGROUND_MAX_MESSAGES,
      Number.isInteger(body.maxMessages) && body.maxMessages! > 0 ? body.maxMessages! : PLAYGROUND_MAX_MESSAGES,
    );
    const position = body.position ?? { kind: "latest", count: 20 };
    const where = ["topic_id = ?"];
    const params: Array<string | number> = [t.id];
    if (partition !== null) {
      where.push("partition_no = ?");
      params.push(partition);
    }
    let order = "id DESC";
    let limit = max;
    if (position.kind === "latest") {
      const count = position.count ?? 20;
      if (!Number.isInteger(count) || count < 1 || count > PLAYGROUND_MAX_MESSAGES)
        throw badRequest(`position: the latest 1–${PLAYGROUND_MAX_MESSAGES}`);
      limit = Math.min(max, count);
    } else if (position.kind === "earliest") {
      order = "id ASC";
    } else if (position.kind === "offset") {
      if (partition === null) throw badRequest("position: an offset is one partition's; choose the partition");
      if (!Number.isInteger(position.offset) || position.offset! < 0) throw badRequest("position: an offset of 0 or more");
      where.push("msg_offset >= ?");
      params.push(position.offset!);
      order = "id ASC";
    } else if (position.kind === "timestamp") {
      const at = Date.parse(position.at ?? "");
      if (Number.isNaN(at)) throw badRequest("position: a timestamp to read from");
      where.push("created_at >= ?");
      params.push(new Date(at).toISOString());
      order = "id ASC";
    } else throw badRequest("position: latest, earliest, offset or timestamp");
    const items = ctx.app.db
      .query<
        { partition: number; offset: number; key: string | null; headers_json: string | null; value: string; timestamp: string },
        Array<string | number>
      >(
        `SELECT partition_no AS partition, msg_offset AS offset, msg_key AS key, headers_json, value, created_at AS timestamp
           FROM kafka_message WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
      )
      .all(...params)
      .map(({ headers_json, ...record }) => ({ ...record, headers: headers_json ? JSON.parse(headers_json) : [] }));
    writeAudit(ctx.app.db, { actor: u.id, action: "kafka.consume", subject: t.id, outcome: "ok", detail });
    return json({
      simulated: true,
      action: "consume",
      environment: t.environment,
      groupId: grant.group_id,
      // The latest N come newest first; a read from a position comes in the order it was written.
      items,
    });
  });
}

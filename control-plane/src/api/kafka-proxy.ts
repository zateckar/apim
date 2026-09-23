import {
  Router,
  readJson,
  requireAdmin,
  requireUser,
  json,
  badRequest,
  conflict,
  notFound,
  type Ctx,
} from "../router.ts";
import { assertCan, getResource } from "./common.ts";
import { can } from "../auth.ts";
import {
  configureResource,
  currentSnapshot,
  DEFAULT_POLICY,
  promoteResource,
  publishResource,
} from "../operations.ts";
import {
  managedUnitsFor,
  parseSchema,
  platformKafkaKey,
  sharedProxy,
  sharedProxyUrls,
  topicApiBinding,
  topicApiOf,
  topicFacts,
  type TopicRow,
} from "../kafka-proxy.ts";
import {
  KAFKA_PROXY_NAME,
  KAFKA_PROXY_ROLE,
  PLATFORM_APPLICATION_ID,
  sharedProxyDefinition,
  topicApiBlockers,
  topicApiDefinition,
  topicApiName,
} from "../../../shared/kafka-proxy.ts";

/**
 * The Kafka REST proxy's endpoints (kafka-rest-proxy). Nothing here writes a release: each one
 * turns a request about a topic or the shared proxy into a publish, configure or promote of an
 * ordinary resource, through the functions `POST /api/publish` and its siblings use.
 */

/** The shared proxy's classification: the portal's own infrastructure. */
const SHARED_DOMAIN = { domain: "IT", subdomain: "Operation" } as const;

/** The same rule `kafkaProduce.clusterId` is validated with, so the form cannot pass one the unit refuses. */
const CLUSTER_ID = /^[A-Za-z0-9._-]{1,255}$/;

interface SharedInput {
  environment?: string;
  backendUrl?: string;
  clusterId?: string;
}

function chainIndex(ctx: Ctx, environment: string | undefined): number {
  const index = environment ? ctx.app.config.promotionChain.indexOf(environment) : -1;
  if (index < 0) throw badRequest("environment: one of " + ctx.app.config.promotionChain.join(", "));
  return index;
}

export function registerKafkaProxyRoutes(router: Router) {
  /**
   * Everything the Kafka REST proxy screen draws: the shared proxy per stage, and every topic with
   * whether it has an API and, when it cannot have one, why. Readable by everybody — the one
   * authorization rule — with the shared proxy's far end redacted for anybody but an administrator,
   * as a backend address is on any API's workspace.
   */
  router.add("GET", "/api/kafka/proxy", "session", (ctx) => {
    const user = requireUser(ctx);
    const db = ctx.app.db;
    const shared = sharedProxy(db);
    const environments = ctx.app.config.promotionChain.map((environment) => {
      const snapshot = shared ? currentSnapshot(ctx, shared.id, environment) : null;
      const operation = shared
        ? db
            .query<{ id: string; state: string; error: string | null }, [string, string]>(
              "SELECT id, state, error FROM operation WHERE resource_id = ? AND environment = ? AND state <> 'superseded' ORDER BY rowid DESC LIMIT 1",
            )
            .get(shared.id, environment)
        : null;
      const pool = (snapshot?.backend as { pool?: Array<{ url: string }> } | undefined)?.pool ?? [];
      const produce = snapshot?.policy?.kafkaProduce as { clusterId?: string } | undefined;
      return {
        environment,
        published: Boolean(snapshot),
        urls: sharedProxyUrls(db, environment),
        operation: operation ?? null,
        keyReady: platformKafkaKey(db, ctx.app.kek, environment) !== null,
        ...(user.isAdmin
          ? { backendUrl: pool[0]?.url ?? null, clusterId: produce?.clusterId ?? null }
          : {}),
      };
    });
    const topics = db
      .query<TopicRow & { application_name: string | null; certificate_name: string | null }, []>(
        `SELECT t.*, a.name AS application_name, c.name AS certificate_name
           FROM kafka_topic t
           LEFT JOIN application a ON a.id = t.application_id
           LEFT JOIN certificate c ON c.id = t.certificate_id
          WHERE t.state <> 'deleted'
          ORDER BY t.name, t.environment`,
      )
      .all()
      .map((topic) => {
        const api = topicApiOf(db, topic);
        const inStage = api ? currentSnapshot(ctx, api.id, topic.environment) !== null : false;
        return {
          id: topic.id,
          name: topic.name,
          environment: topic.environment,
          applicationId: topic.application_id,
          applicationName: topic.application_name ?? topic.application_id,
          schemaType: topic.schema_type,
          certificateName: topic.certificate_name,
          canEdit: can(user, topic.application_id),
          apiResourceId: api?.id ?? null,
          published: inStage,
          blockers: topicApiBlockers(topicFacts(db, topic)),
        };
      });
    return json({ sharedResourceId: shared?.id ?? null, environments, topics });
  });

  /**
   * An administrator puts the shared proxy in a stage, or points it somewhere else there. The first
   * call in the chain's first stage publishes it; in a later stage it promotes it; in a stage it is
   * already in it reconfigures it. One address for one decision — "the shared proxy in TEST talks to
   * this cluster" — rather than three the administrator has to choose between.
   */
  router.add("POST", "/api/kafka/proxy/shared", "session", async (ctx) => {
    requireAdmin(ctx, "set up the shared Kafka proxy");
    const body = await readJson<SharedInput>(ctx);
    const index = chainIndex(ctx, body.environment);
    const environment = body.environment!;
    if (typeof body.backendUrl !== "string" || !body.backendUrl.trim())
      throw badRequest("backendUrl: the Kafka REST Proxy's address, for example https://kafka-rest.example:8082");
    if (typeof body.clusterId !== "string" || !CLUSTER_ID.test(body.clusterId))
      throw badRequest("clusterId: the Kafka cluster id, 1–255 letters, digits, dots, underscores or hyphens");
    const backendUrl = body.backendUrl.trim();
    const produce = { kafkaProduce: { clusterId: body.clusterId } };

    const shared = sharedProxy(ctx.app.db);
    if (!shared) {
      if (index !== 0)
        throw conflict(
          `The shared Kafka proxy starts in ${ctx.app.config.promotionChain[0]!.toUpperCase()}; set it up there first.`,
        );
      return publishResource(
        ctx,
        {
          applicationId: PLATFORM_APPLICATION_ID,
          name: KAFKA_PROXY_NAME,
          kind: "rest",
          apiVersion: "v1",
          description:
            "The portal's proxy to the Kafka REST Proxy. Every Kafka topic's API calls it; nobody else subscribes to it.",
          spec: sharedProxyDefinition(),
          backendUrl,
          policy: { ...DEFAULT_POLICY, ...produce },
          ...SHARED_DOMAIN,
        },
        { columns: { platform_role: KAFKA_PROXY_ROLE, visibility: "unlisted" } },
      );
    }
    const row = getResource(ctx, shared.id);
    const here = currentSnapshot(ctx, row.id, environment);
    if (here) {
      // Its other units — a rate limit an administrator added on the workspace — are kept.
      return configureResource(
        ctx,
        row,
        { environment, backendUrl, policy: { ...here.policy, ...produce } },
        { generated: true },
      );
    }
    const previous = currentSnapshot(ctx, row.id, ctx.app.config.promotionChain[index - 1]!);
    return promoteResource(ctx, row, {
      environment,
      backendUrl,
      policy: { ...(previous?.policy ?? DEFAULT_POLICY), ...produce },
    });
  });

  /**
   * A topic's owner gives it an API — or carries the one it has into the topic's stage.
   *
   * In the chain's first stage this publishes a new API generated from the topic; in a later one it
   * promotes that API, bound to this stage's shared proxy and this topic's certificate. Refused, with
   * the first reason, while the topic cannot have one (`topicApiBlockers`).
   */
  router.add("POST", "/api/kafka/topics/:id/proxy", "session", async (ctx) => {
    const topic = ctx.app.db
      .query<TopicRow, [string]>("SELECT * FROM kafka_topic WHERE id = ? AND state <> 'deleted'")
      .get(ctx.params.id!);
    if (!topic) throw notFound("topic not found");
    assertCan(ctx.user, topic.application_id, "create this topic's API");
    const blockers = topicApiBlockers(topicFacts(ctx.app.db, topic));
    if (blockers.length > 0) throw conflict(blockers[0]!);

    const existing = topicApiOf(ctx.app.db, topic);
    const index = chainIndex(ctx, topic.environment);
    if (existing) {
      if (currentSnapshot(ctx, existing.id, topic.environment))
        throw conflict(`${topic.name} already has an API in ${topic.environment.toUpperCase()}.`);
      if (index === 0) throw conflict(`${topic.name} already has an API.`);
      return promoteResource(ctx, getResource(ctx, existing.id), { environment: topic.environment });
    }
    if (index !== 0)
      throw conflict(
        `A topic's API starts in ${ctx.app.config.promotionChain[0]!.toUpperCase()}, where the chain ` +
          `does. Create ${topic.name} there and give it an API, then promote it.`,
      );
    const row = { application_id: topic.application_id, kafka_topic: topic.name };
    const binding = topicApiBinding(ctx.app.db, row, topic.environment);
    return publishResource(
      ctx,
      {
        applicationId: topic.application_id,
        name: topicApiName(topic.name),
        kind: "rest",
        apiVersion: "v1",
        description: topic.description || `Produce records to the Kafka topic ${topic.name}.`,
        spec: topicApiDefinition(topic.name, parseSchema(topic.schema_json)!, topic.description),
        ...binding,
        domain: topic.domain ?? undefined,
        subdomain: topic.subdomain,
      },
      { managed: managedUnitsFor(row), columns: { kafka_topic: topic.name } },
    );
  });
}

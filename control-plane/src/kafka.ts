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
interface Topic {
  id: string;
  application_id: string;
  environment: string;
  name: string;
  partitions: number;
  description: string;
  state: string;
  proxy_enabled: number;
  domain: string | null;
  subdomain: string | null;
}
function topic(ctx: Ctx): Topic {
  const t = ctx.app.db
    .query<Topic, [string]>("SELECT * FROM kafka_topic WHERE id=?")
    .get(ctx.params.id!);
  if (!t) throw notFound("topic not found");
  return t;
}
export function registerKafkaRoutes(router: Router) {
  router.add("GET", "/api/kafka/topics", "session", (ctx) =>
    json({
      simulated: true,
      items: ctx.app.db
        .query<Topic, []>("SELECT * FROM kafka_topic ORDER BY name")
        .all()
        .map((t) => ({
          ...t,
          applicationId: t.application_id,
          canEdit: can(ctx.user, t.application_id),
        })),
    }),
  );
  router.add("POST", "/api/kafka/topics", "session", async (ctx) => {
    const u = requireUser(ctx),
      body = await readJson<{
        applicationId?: string;
        environment?: string;
        name?: string;
        partitions?: number;
        description?: string;
        domain?: string;
        subdomain?: string;
      }>(ctx);
    assertCan(u, body.applicationId, "create a topic");
    if (
      !body.environment ||
      !ctx.app.config.promotionChain.includes(body.environment)
    )
      throw badRequest("valid environment required");
    if (!body.name || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(body.name))
      throw badRequest(
        "topic name: 2–101 letters, numbers, dots, underscores or hyphens",
      );
    const partitions = body.partitions ?? 3;
    if (!Number.isInteger(partitions) || partitions < 1 || partitions > 100)
      throw badRequest("partitions: 1–100");
    // A topic is a catalog item like any other, so it is classified like any other. There is no
    // path to prefix here — a topic is addressed by name on a broker — but the domain is how it is
    // found, and an unclassified topic is one nobody browsing by domain will ever see.
    const domain = body.domain?.trim() || null;
    const subdomain = body.subdomain?.trim() || null;
    if (!domain) throw badRequest("domain: required — every catalog item belongs to a domain");
    const problem = domainError(domain, subdomain);
    if (problem) throw badRequest(problem);
    if (
      ctx.app.db
        .query("SELECT id FROM kafka_topic WHERE environment=? AND name=?")
        .get(body.environment, body.name)
    )
      throw conflict("topic already exists");
    const id = newId("topic");
    ctx.app.db.transaction(() => {
      ctx.app.db.run(
        "INSERT INTO kafka_topic(id,application_id,environment,name,partitions,description,domain,subdomain,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          body.applicationId!,
          body.environment!,
          body.name!,
          partitions,
          body.description ?? "",
          domain,
          subdomain,
          nowIso(),
        ],
      );
      emitIntegration(
        ctx.app,
        body.applicationId!,
        "kafka",
        "topic.create",
        id,
        {},
      );
      writeAudit(ctx.app.db, {
        actor: u.id,
        action: "kafka.publish",
        subject: id,
        outcome: "ok",
        detail: { applicationId: body.applicationId, simulated: true },
      });
    })();
    return json(
      { id, state: "provisioning", simulated: true },
      { status: 202 },
    );
  });
  router.add("PATCH", "/api/kafka/topics/:id", "session", async (ctx) => {
    const t = topic(ctx);
    assertCan(ctx.user, t.application_id, "configure topic");
    const body = await readJson<{
      description?: string;
      partitions?: number;
      proxyEnabled?: boolean;
      domain?: string;
      subdomain?: string | null;
    }>(ctx);
    if (t.state === "deleted") throw conflict("topic was deleted");
    if (
      body.partitions !== undefined &&
      (!Number.isInteger(body.partitions) ||
        body.partitions < t.partitions ||
        body.partitions > 100)
    )
      throw badRequest("partitions may only increase, up to 100");
    // Reclassifying is free here: a topic is addressed by its name on the broker, so moving it
    // between domains moves where it is *found*, not where it answers.
    const domain = body.domain === undefined ? t.domain : body.domain.trim() || null;
    const subdomain =
      body.subdomain === undefined ? t.subdomain : body.subdomain?.trim() || null;
    if (!domain) throw badRequest("domain: required — every catalog item belongs to a domain");
    const problem = domainError(domain, subdomain);
    if (problem) throw badRequest(problem);
    ctx.app.db.run(
      "UPDATE kafka_topic SET description=?,partitions=?,proxy_enabled=?,domain=?,subdomain=? WHERE id=?",
      [
        body.description ?? t.description,
        body.partitions ?? t.partitions,
        body.proxyEnabled === undefined
          ? t.proxy_enabled
          : body.proxyEnabled
            ? 1
            : 0,
        domain,
        subdomain,
        t.id,
      ],
    );
    writeAudit(ctx.app.db, {
      actor: requireUser(ctx).id,
      action: "kafka.configure",
      subject: t.id,
      outcome: "ok",
      detail: { applicationId: t.application_id, ...body, simulated: true },
    });
    return json({ id: t.id, simulated: true });
  });
  router.add("DELETE", "/api/kafka/topics/:id", "session", (ctx) => {
    const t = topic(ctx);
    assertCan(ctx.user, t.application_id, "delete topic");
    if (
      ctx.app.db
        .query(
          "SELECT id FROM kafka_access WHERE topic_id=? AND state IN ('pending','activating','active','revoking')",
        )
        .get(t.id)
    )
      throw conflict("revoke or cancel topic subscriptions first");
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
    const rows = ctx.app.db
      .query<{ id: string; application_id: string; publisher: string }, []>(
        `SELECT ka.*,kt.name AS topicName,kt.application_id AS publisher,kt.environment FROM kafka_access ka JOIN kafka_topic kt ON kt.id=ka.topic_id ORDER BY ka.created_at DESC`,
      )
      .all();
    return json({
      simulated: true,
      items: rows.filter(
        (r) => can(user, r.application_id) || can(user, r.publisher),
      ),
    });
  });
  router.add(
    "POST",
    "/api/kafka/topics/:id/subscribe",
    "session",
    async (ctx) => {
      const t = topic(ctx),
        u = requireUser(ctx);
      const body = await readJson<{ applicationId?: string; purpose?: string }>(
        ctx,
      );
      assertCan(u, body.applicationId, "request topic access");
      if (t.state !== "ready") throw conflict("topic is not ready");
      const purpose = body.purpose?.trim() ?? "";
      if (purpose.length < 3 || purpose.length > 500)
        throw badRequest("purpose: 3–500 characters");
      if (
        ctx.app.db
          .query(
            "SELECT id FROM kafka_access WHERE topic_id=? AND application_id=? AND state IN ('pending','activating','active','revoking')",
          )
          .get(t.id, body.applicationId!)
      )
        throw conflict("access request already exists");
      const id = newId("acl"),
        own = body.applicationId === t.application_id;
      ctx.app.db.transaction(() => {
        ctx.app.db.run(
          "INSERT INTO kafka_access(id,topic_id,application_id,purpose,state,requested_by,created_at) VALUES (?,?,?,?,?,?,?)",
          [
            id,
            t.id,
            body.applicationId!,
            purpose,
            own ? "activating" : "pending",
            u.id,
            nowIso(),
          ],
        );
        if (own)
          emitIntegration(
            ctx.app,
            body.applicationId!,
            "kafka",
            "access.grant",
            id,
            {},
          );
        else
          requestApproval(
            ctx.app,
            body.applicationId!,
            t.application_id,
            id,
            "kafka",
            purpose,
          );
        writeAudit(ctx.app.db, {
          actor: u.id,
          action: "kafka.subscribe",
          subject: id,
          outcome: "ok",
          detail: {
            applicationId: body.applicationId,
            topicId: t.id,
            simulated: true,
          },
        });
      })();
      return json(
        { id, state: own ? "activating" : "pending", simulated: true },
        { status: 201 },
      );
    },
  );
  router.add("DELETE", "/api/kafka/access/:id", "session", (ctx) => {
    const row = ctx.app.db
      .query<
        {
          id: string;
          state: string;
          application_id: string;
          publisher: string;
        },
        [string]
      >(
        "SELECT ka.*,kt.application_id AS publisher FROM kafka_access ka JOIN kafka_topic kt ON kt.id=ka.topic_id WHERE ka.id=?",
      )
      .get(ctx.params.id!);
    if (!row) throw notFound("access request not found");
    if (!can(ctx.user, row.publisher))
      assertCan(ctx.user, row.application_id, "revoke topic access");
    const state =
      row.state === "pending"
        ? "cancelled"
        : row.state === "active" || row.state === "activating"
          ? "revoking"
          : row.state;
    ctx.app.db.transaction(() => {
      ctx.app.db.run("UPDATE kafka_access SET state=? WHERE id=?", [
        state,
        row.id,
      ]);
      if (state === "revoking")
        emitIntegration(
          ctx.app,
          row.application_id,
          "kafka",
          "access.revoke",
          row.id,
          {},
        );
    })();
    writeAudit(ctx.app.db, {
      actor: requireUser(ctx).id,
      action: "kafka.revoke",
      subject: row.id,
      outcome: "ok",
      detail: { applicationId: row.application_id, simulated: true },
    });
    return json({ id: row.id, state, simulated: true });
  });
  router.add(
    "POST",
    "/api/kafka/topics/:id/playground",
    "session",
    async (ctx) => {
      const t = topic(ctx),
        u = requireUser(ctx),
        body = await readJson<{
          applicationId?: string;
          action?: string;
          value?: string;
        }>(ctx, 65536);
      assertCan(u, body.applicationId, "use this application playground");
      if (t.state !== "ready") throw conflict("topic is unavailable");
      if (
        !ctx.app.db
          .query(
            "SELECT id FROM kafka_access WHERE topic_id=? AND application_id=? AND state='active'",
          )
          .get(t.id, body.applicationId!)
      )
        throw conflict("an active topic subscription is required");
      if (body.action !== "produce" && body.action !== "consume")
        throw badRequest("action: produce or consume");
      if (body.action === "produce") {
        if (typeof body.value !== "string" || body.value.length > 32768)
          throw badRequest("message: up to 32768 characters");
        ctx.app.db.run(
          "INSERT INTO kafka_message(topic_id,application_id,value,created_at) VALUES (?,?,?,?)",
          [t.id, body.applicationId!, body.value, nowIso()],
        );
        ctx.app.db.run(
          "DELETE FROM kafka_message WHERE topic_id=? AND id NOT IN (SELECT id FROM kafka_message WHERE topic_id=? ORDER BY id DESC LIMIT 100)",
          [t.id, t.id],
        );
      }
      writeAudit(ctx.app.db, {
        actor: u.id,
        action: `kafka.${body.action}`,
        subject: t.id,
        outcome: "ok",
        detail: { applicationId: body.applicationId, simulated: true },
      });
      return json({
        simulated: true,
        items: ctx.app.db
          .query(
            "SELECT id AS offset,value,created_at AS createdAt FROM kafka_message WHERE topic_id=? ORDER BY id DESC LIMIT 20",
          )
          .all(t.id),
      });
    },
  );
}

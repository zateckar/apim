import type { App, Ctx } from "./router.ts";
import {
  Router,
  requireUser,
  readJson,
  json,
  badRequest,
  notFound,
  conflict,
} from "./router.ts";
import { can } from "./auth.ts";
import { assertCan } from "./api/common.ts";
import { newId, nowIso } from "./db.ts";
import { writeAudit } from "./audit.ts";

export const MOCK_INTEGRATIONS = [
  "kafka",
  "skonet",
  "email",
  "ldapws",
  "fixme",
  "leanix",
] as const;
export type IntegrationName = (typeof MOCK_INTEGRATIONS)[number];
export interface IntegrationEvent {
  id: string;
  application_id: string;
  integration: IntegrationName;
  kind: string;
  subject: string;
  state: string;
  payload_json: string;
  result_json: string | null;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Durable native outbox. A transport failure cannot roll back a business decision. */
export function emitIntegration(
  app: App,
  applicationId: string,
  integration: IntegrationName,
  kind: string,
  subject: string,
  payload: unknown,
): string {
  const previous = app.db
    .query<{ id: string }, string[]>(
      "SELECT id FROM integration_event WHERE integration=? AND kind=? AND subject=?",
    )
    .get(integration, kind, subject);
  if (previous) return previous.id;
  const id = newId("evt"),
    at = nowIso();
  app.db.run(
    `INSERT INTO integration_event
    (id,application_id,integration,kind,subject,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [
      id,
      applicationId,
      integration,
      kind,
      subject,
      JSON.stringify(payload),
      at,
      at,
    ],
  );
  return id;
}

/** Explicitly simulated transport. State/results survive process and browser restarts. */
export function runIntegrationEvents(app: App): void {
  const events = app.db
    .query<IntegrationEvent, [string]>(
      "SELECT * FROM integration_event WHERE state IN ('queued','retrying') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id LIMIT 50",
    )
    .all(nowIso());
  for (const event of events) {
    app.db.transaction(() => {
      const payload = JSON.parse(event.payload_json);
      const attempts = event.attempts + 1;
      if (payload.simulateFailures && attempts <= payload.simulateFailures) {
        app.db.run(
          "UPDATE integration_event SET state='retrying',attempts=?,next_attempt_at=?,updated_at=? WHERE id=?",
          [
            attempts,
            new Date(
              Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)),
            ).toISOString(),
            nowIso(),
            event.id,
          ],
        );
        return;
      }
      const result: Record<string, unknown> = {
        simulated: true,
        reference: `mock-${event.id}`,
      };
      let state = "delivered";
      if (event.integration === "skonet") {
        state = "awaiting-decision";
        result.trackingReference = `SKONET-${event.id}`;
      }
      if (event.integration === "email") {
        result.to = payload.to ?? [`${event.application_id}@mock.invalid`];
        result.subject = payload.subject ?? event.kind;
        result.body =
          payload.body ??
          `Application ${event.application_id}: ${event.kind} for ${event.subject}`;
      }
      if (event.integration === "leanix") {
        const appRow = app.db
          .query<{ name: string }, [string]>(
            "SELECT name FROM application WHERE id=?",
          )
          .get(event.application_id);
        result.applicationName = appRow?.name;
        result.leanixId = `LX-${event.application_id}`;
        result.description = `Simulated business metadata for ${appRow?.name}`;
        result.ownerContact = `${event.application_id}@mock.invalid`;
      }
      if (event.integration === "ldapws") {
        result.contacts = app.db
          .query(
            `SELECT p.id,p.display_name AS name,p.email FROM principal p
          JOIN membership m ON m.user_id=p.id WHERE m.application_id=?`,
          )
          .all(event.application_id);
      }
      if (event.integration === "fixme") {
        state = "completed";
        result.steps = [
          { name: "Inspect environment", state: "complete" },
          { name: "Simulate repair", state: "complete" },
          { name: "Verify simulated recovery", state: "complete" },
        ];
        result.summary =
          "Simulated diagnostics completed. No infrastructure was changed.";
      }
      if (event.integration === "kafka") {
        if (event.kind === "topic.create")
          app.db.run(
            "UPDATE kafka_topic SET state='ready' WHERE id=? AND state='provisioning'",
            [event.subject],
          );
        if (event.kind === "access.grant")
          app.db.run(
            "UPDATE kafka_access SET state='active' WHERE id=? AND state='activating'",
            [event.subject],
          );
        if (event.kind === "access.revoke")
          app.db.run(
            "UPDATE kafka_access SET state='revoked' WHERE id=? AND state='revoking'",
            [event.subject],
          );
      }
      app.db.run(
        "UPDATE integration_event SET state=?,result_json=?,attempts=?,next_attempt_at=NULL,updated_at=? WHERE id=?",
        [state, JSON.stringify(result), attempts, nowIso(), event.id],
      );
    })();
  }
}

export function requestApproval(
  app: App,
  consumer: string,
  publisher: string,
  subject: string,
  kind: "subscription" | "kafka",
  purpose: string,
): void {
  emitIntegration(app, publisher, "skonet", `${kind}.request`, subject, {
    consumer,
    publisher,
    purpose,
  });
  emitIntegration(app, consumer, "email", `${kind}.requested`, subject, {
    subject: "Access requested",
    body: purpose,
  });
  emitIntegration(app, publisher, "email", `${kind}.approval-needed`, subject, {
    subject: "Approval requested",
    body: purpose,
  });
  emitIntegration(app, consumer, "ldapws", "contacts", consumer, {});
  emitIntegration(app, publisher, "leanix", "metadata", publisher, {});
}

export function registerIntegrationRoutes(router: Router): void {
  router.add("GET", "/api/integrations", "session", (ctx) =>
    json({
      mode: "mock",
      items: MOCK_INTEGRATIONS.map((name) => ({
        name,
        mode: "mock",
        simulated: true,
      })),
    }),
  );
  router.add("GET", "/api/integration-events", "session", (ctx) => {
    const user = requireUser(ctx);
    const applicationId = ctx.url.searchParams.get("applicationId");
    if (applicationId)
      assertCan(
        user,
        applicationId,
        "read this application integration history",
      );
    const scope = applicationId
      ? [applicationId]
      : user.isAdmin
        ? null
        : user.applications;
    const where =
      scope === null
        ? ""
        : ` WHERE application_id IN (${scope.map(() => "?").join(",") || "NULL"})`;
    const events = ctx.app.db
      .query<IntegrationEvent, string[]>(
        `SELECT * FROM integration_event${where} ORDER BY created_at DESC LIMIT 500`,
      )
      .all(...(scope ?? []));
    return json({
      mode: "mock",
      items: events.map((e) => ({
        ...e,
        payload: JSON.parse(e.payload_json),
        result: e.result_json ? JSON.parse(e.result_json) : null,
      })),
    });
  });
  router.add(
    "POST",
    "/api/applications/:id/integrations/:integration",
    "session",
    async (ctx) => {
      const user = requireUser(ctx);
      const applicationId = ctx.params.id!;
      assertCan(user, applicationId, "use this application integration");
      const integration = ctx.params.integration as IntegrationName;
      if (!["leanix", "ldapws", "fixme"].includes(integration))
        throw badRequest("expected leanix, ldapws or fixme");
      const body = await readJson<{
        environment?: string;
        simulateFailures?: number;
      }>(ctx);
      if (
        body.environment &&
        !ctx.app.config.promotionChain.includes(body.environment)
      )
        throw badRequest("unknown environment");
      const failures = body.simulateFailures ?? 0;
      if (!Number.isInteger(failures) || failures < 0 || failures > 5)
        throw badRequest("simulateFailures: 0–5");
      const id = emitIntegration(
        ctx.app,
        applicationId,
        integration,
        integration === "fixme" ? "diagnose" : "lookup",
        newId("request"),
        { ...body, simulateFailures: failures },
      );
      writeAudit(ctx.app.db, {
        actor: user.id,
        action: `${integration}.request`,
        subject: id,
        outcome: "ok",
        detail: { applicationId, simulated: true },
      });
      return json({ id, state: "queued", simulated: true }, { status: 202 });
    },
  );
  router.add(
    "POST",
    "/api/integration-events/:id/decision",
    "session",
    async (ctx) => {
      const user = requireUser(ctx),
        db = ctx.app.db;
      const event = db
        .query<IntegrationEvent, [string]>(
          "SELECT * FROM integration_event WHERE id=?",
        )
        .get(ctx.params.id!);
      if (!event || event.integration !== "skonet")
        throw notFound("no SkoNET approval request");
      assertCan(
        user,
        event.application_id,
        "decide access to this application product",
      );
      const body = await readJson<{ decision?: string; reason?: string }>(ctx);
      if (body.decision !== "approved" && body.decision !== "rejected")
        throw badRequest("decision: approved or rejected");
      const decision = body.decision;
      if (event.state === decision)
        return json({ id: event.id, state: decision, simulated: true });
      if (event.state !== "awaiting-decision")
        throw conflict("request is not awaiting a decision");
      db.transaction(() => {
        if (event.kind === "subscription.request") {
          const row = db
            .query<
              { state: string; application_id: string; product_id: string },
              [string]
            >(
              "SELECT state,application_id,product_id FROM subscription WHERE id=?",
            )
            .get(event.subject);
          if (!row || row.state !== "pending")
            throw conflict("subscription is no longer pending");
          const owner = db
            .query<{ application_id: string }, [string]>(
              "SELECT application_id FROM product WHERE id=?",
            )
            .get(row.product_id);
          if (owner?.application_id !== event.application_id)
            throw conflict("product ownership changed");
          db.run(
            "UPDATE subscription SET state=?,decision_by=?,decision_at=?,decision_reason=? WHERE id=?",
            [
              decision === "approved" ? "activating" : "rejected",
              user.id,
              nowIso(),
              body.reason ?? "",
              event.subject,
            ],
          );
        } else if (event.kind === "kafka.request") {
          const row = db
            .query<{ state: string; application_id: string }, [string]>(
              "SELECT state,application_id FROM kafka_access WHERE id=?",
            )
            .get(event.subject);
          if (!row || row.state !== "pending")
            throw conflict("Kafka request is no longer pending");
          db.run("UPDATE kafka_access SET state=?,decision_by=? WHERE id=?", [
            decision === "approved" ? "activating" : "rejected",
            user.id,
            event.subject,
          ]);
          if (decision === "approved")
            emitIntegration(
              ctx.app,
              row.application_id,
              "kafka",
              "access.grant",
              event.subject,
              {},
            );
        } else throw badRequest("unsupported approval process");
        const payload = JSON.parse(event.payload_json);
        db.run(
          "UPDATE integration_event SET state=?,updated_at=?,result_json=? WHERE id=?",
          [
            decision,
            nowIso(),
            JSON.stringify({
              simulated: true,
              decision,
              actor: user.id,
              reason: body.reason ?? "",
            }),
            event.id,
          ],
        );
        emitIntegration(
          ctx.app,
          payload.consumer,
          "email",
          `${event.kind}.${decision}`,
          event.subject,
          { subject: `Access ${decision}`, body: body.reason ?? "" },
        );
        writeAudit(db, {
          actor: user.id,
          action: `approval.${decision}`,
          subject: event.subject,
          outcome: "ok",
          detail: {
            applicationId: event.application_id,
            consumer: payload.consumer,
            simulated: true,
          },
        });
      })();
      return json({ id: event.id, state: decision, simulated: true });
    },
  );
}

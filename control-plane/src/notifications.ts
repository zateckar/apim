import type { App, Ctx } from "./router.ts";
import { json, requireUser, Router } from "./router.ts";
import { assertCan } from "./api/common.ts";

/**
 * The notification feed — what happened that you may not have seen.
 *
 * Read from the **email outbox**, not from a second table of its own. Every business event this
 * portal considers worth telling somebody about already emits an email into `integration_event`:
 * an access request, the answer to one, a withdrawal, a deployment that finished. A parallel
 * `notification` table would be a second list of the same facts, free to disagree with the one that
 * was actually sent, and the first bug would be a bell that says something the mailbox does not.
 *
 * So the bell and the mailbox are one query with two renderings. The mailbox shows the message; the
 * bell shows its first line and a link to the screen that acts on it. What is "read" is a property
 * of one person's eyes rather than of the estate, so it lives in that person's browser — the
 * control plane has no opinion about it and stores nothing.
 *
 * The transport is simulated in this phase, like the other five external systems, and every item
 * says so. The *events* are real: they are emitted by real decisions and they survive a restart.
 */

/** The closed vocabulary. A kind the portal has not heard of still renders, as its own subject. */
export type NotificationTone = "ok" | "warn" | "err" | "info";

export interface NotificationItem {
  /** Stable across polls and processes, so "read" survives both. */
  id: string;
  applicationId: string;
  applicationName: string;
  /** The outbox `kind`, verbatim — the UI groups on it, it does not parse it. */
  kind: string;
  /** One line. What happened, to what, where. */
  title: string;
  /** The message, when the simulated transport has rendered one. */
  body: string | null;
  /** Who it went to, once sent. */
  to: string[];
  /** `queued` and `retrying` are "not sent yet"; `delivered` is sent. */
  state: string;
  at: string;
  environment: string | null;
  tone: NotificationTone;
  /** The screen that acts on it, or `null` when there is nothing to do but know. */
  href: string | null;
  /** Always true in this phase: the message was composed and never handed to a mail server. */
  simulated: boolean;
}

interface Row {
  id: string;
  application_id: string;
  kind: string;
  subject: string;
  state: string;
  payload_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

/** What a subject id turns out to name, once looked up. */
interface Subject {
  what: string;
  environment: string | null;
  href: string | null;
}

/**
 * Titles, by outbox kind. `%s` is the resolved subject.
 *
 * Written out rather than assembled from the kind: `subscription.request.rejected` is not a
 * sentence, and a reader should not have to know that the portal's outbox names events after the
 * skonet request that carried them.
 */
const TITLES: Record<string, { title: string; tone: NotificationTone; act: boolean }> = {
  "subscription.requested": { title: "You requested access to %s", tone: "info", act: false },
  "subscription.approval-needed": { title: "Someone is asking for access to %s", tone: "warn", act: true },
  "subscription.request.approved": { title: "Your access to %s was approved", tone: "ok", act: false },
  "subscription.request.rejected": { title: "Your request for %s was turned down", tone: "err", act: false },
  "subscription.approved": { title: "Access to %s is active", tone: "ok", act: false },
  "subscription.revoked": { title: "Access to %s was withdrawn", tone: "warn", act: false },
  "kafka.requested": { title: "You requested access to %s", tone: "info", act: false },
  "kafka.approval-needed": { title: "Someone is asking for access to %s", tone: "warn", act: true },
  "kafka.request.approved": { title: "Your access to %s was approved", tone: "ok", act: false },
  "kafka.request.rejected": { title: "Your request for %s was turned down", tone: "err", act: false },
  "operation.complete": { title: "%s", tone: "ok", act: false },
};

/**
 * Resolve the subjects of a page of events in three statements rather than one per row: a mailbox
 * of fifty messages should not be fifty round trips through the query planner.
 */
function subjectsOf(app: App, rows: Row[]): Map<string, Subject> {
  const out = new Map<string, Subject>();
  const ids = [...new Set(rows.map((row) => row.subject))];
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");

  for (const row of app.db
    .query<
      { id: string; product: string; consumer: string; consumer_id: string; environment: string },
      string[]
    >(
      `SELECT s.id, p.name AS product, a.name AS consumer, a.id AS consumer_id, s.environment
         FROM subscription s
         JOIN product p ON p.id = s.product_id
         JOIN application a ON a.id = s.application_id
        WHERE s.id IN (${marks})`,
    )
    .all(...ids)) {
    out.set(row.id, {
      what: `${row.product} in ${row.environment.toUpperCase()}`,
      environment: row.environment,
      // The consumer's own subscription list. The publisher-side rows are re-pointed at the
      // approvals queue below, because reading the request is not what the publisher has to do.
      href: `/${row.consumer_id}/subscriptions`,
    });
  }

  for (const row of app.db
    .query<
      { id: string; kind: string; environment: string; application_id: string; name: string | null; api_version: string | null; resource_id: string | null },
      string[]
    >(
      `SELECT o.id, o.kind, o.environment, o.application_id, o.resource_id, r.name, r.api_version
         FROM operation o
         LEFT JOIN resource r ON r.id = o.resource_id
        WHERE o.id IN (${marks})`,
    )
    .all(...ids)) {
    const what = row.name
      ? `${row.kind} of ${row.name} ${row.api_version} finished in ${row.environment.toUpperCase()}`
      : `${row.kind} finished in ${row.environment.toUpperCase()}`;
    out.set(row.id, {
      what,
      environment: row.environment,
      href: row.resource_id ? `/${row.application_id}/apis/${row.resource_id}` : `/${row.application_id}/activity`,
    });
  }

  for (const row of app.db
    .query<{ id: string; topic: string; environment: string; application_id: string }, string[]>(
      `SELECT ka.id, kt.name AS topic, kt.environment, ka.application_id
         FROM kafka_access ka
         JOIN kafka_topic kt ON kt.id = ka.topic_id
        WHERE ka.id IN (${marks})`,
    )
    .all(...ids)) {
    out.set(row.id, {
      what: `the ${row.topic} topic in ${row.environment.toUpperCase()}`,
      environment: row.environment,
      href: `/${row.application_id}/kafka`,
    });
  }

  return out;
}

/**
 * One page of the feed, newest first, for the applications `scope` names — or for everything when
 * `scope` is `null`, which is what an administrator asking for the whole estate means.
 */
export function notificationsFor(
  app: App,
  scope: string[] | null,
  limit: number,
): NotificationItem[] {
  const where =
    scope === null
      ? "integration = 'email'"
      : `integration = 'email' AND application_id IN (${scope.map(() => "?").join(",") || "NULL"})`;
  const rows = app.db
    .query<Row, string[]>(
      `SELECT id, application_id, kind, subject, state, payload_json, result_json, created_at, updated_at
         FROM integration_event
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${Math.trunc(limit)}`,
    )
    .all(...(scope ?? []));

  const names = new Map(
    app.db.query<{ id: string; name: string }, []>("SELECT id, name FROM application").all().map((a) => [a.id, a.name]),
  );
  const subjects = subjectsOf(app, rows);

  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { subject?: string; body?: string };
    const result = row.result_json ? (JSON.parse(row.result_json) as { to?: string[]; body?: string; subject?: string }) : null;
    const known = TITLES[row.kind];
    const subject = subjects.get(row.subject);
    const what = subject?.what ?? row.subject;
    return {
      id: row.id,
      applicationId: row.application_id,
      applicationName: names.get(row.application_id) ?? row.application_id,
      kind: row.kind,
      // An unknown kind still says something true — the outbox subject line and what it is about —
      // rather than being dropped on the floor for not being in the table above.
      title: known ? known.title.replace("%s", what) : `${payload.subject ?? row.kind}: ${what}`,
      body: result?.body ?? payload.body ?? null,
      to: result?.to ?? [],
      state: row.state,
      at: row.created_at,
      environment: subject?.environment ?? null,
      tone: known?.tone ?? "info",
      href: known?.act ? `/${row.application_id}/approvals` : (subject?.href ?? null),
      simulated: true,
    };
  });
}

export function registerNotificationRoutes(router: Router): void {
  /**
   * The bell and the mailbox read the same list; only `limit` differs. `applicationId` narrows it
   * to one application, which is what the shell asks for — the bell counts what is unread *here*,
   * not across every application somebody happens to be a member of.
   */
  router.add("GET", "/api/notifications", "session", (ctx: Ctx) => {
    const user = requireUser(ctx);
    const applicationId = ctx.url.searchParams.get("applicationId");
    if (applicationId) assertCan(user, applicationId, "read this application's notifications");
    const asked = Number(ctx.url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(asked) ? Math.min(200, Math.max(1, Math.trunc(asked))) : 50;
    const scope = applicationId ? [applicationId] : user.isAdmin ? null : user.applications;
    return json({
      items: notificationsFor(ctx.app, scope, limit),
      // The transport, not the events. Said on the wire so the screen does not have to guess from
      // the absence of a real mail server.
      transport: "simulated",
    });
  });
}

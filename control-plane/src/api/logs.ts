import { MAX_LOGGED_BODY_BYTES } from "../../../shared/config-doc.ts";
import { writeAudit } from "../audit.ts";
import { newId, nowIso } from "../db.ts";
import {
  badRequest,
  conflict,
  json,
  notFound,
  readJson,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import {
  createLogSearch,
  readableResourceIds,
  STATUS_CLASSES,
  type LogQuery,
  type LogSearchProvider,
  type StatusClass,
} from "../logs.ts";
import { assertCan, environmentOf, getResource, pageOf, touch } from "./common.ts";

/**
 * The two reads the Logs tab makes, and the one write that changes what a log line contains.
 *
 * The reads have no per-resource route: the resource is a *filter*, and the same two endpoints
 * answer "this API's traffic" and "everything I can see". Authorization is applied by turning the
 * caller into a list of resource ids before the query is built, so a caller cannot name a resource
 * they may not read — the worst a wrong id does is return nothing.
 *
 * The write is body capture (schema-010): an hour in which one API's request and response bodies
 * are written to the access log, for the bug nobody can reproduce from status codes and timings.
 */

/**
 * An hour, and the endpoint below will not be argued past it.
 *
 * The number is small on purpose. A capture window is a deliberate, temporary widening of what
 * ends up in a central log index that far more people can read than can read the API's backend,
 * and the failure mode of every diagnostic switch ever built is that somebody turns it on during
 * an incident and nobody turns it off. An hour is long enough to reproduce a call and short enough
 * that forgetting costs an hour of bodies rather than a quarter of them. Renewing is one click and
 * one more audit row, which is the right price for a second hour.
 */
export const MAX_BODY_CAPTURE_MINUTES = 60;

/** One provider per process. The mock caches per-resource context and the ELK client is stateless. */
let cached: { provider: LogSearchProvider; key: string } | null = null;

function providerFor(ctx: Ctx): LogSearchProvider {
  const key = `${ctx.app.config.logs.provider}|${ctx.app.config.logs.url ?? ""}|${ctx.app.config.logs.index}`;
  if (!cached || cached.key !== key) cached = { provider: createLogSearch(ctx.app), key };
  return cached.provider;
}

/** Exposed so a test can drop a stub in, and so a config change in-process is not sticky. */
export function resetLogSearchCache(): void {
  cached = null;
}

function queryOf(ctx: Ctx): LogQuery {
  const user = requireUser(ctx);
  const environment = environmentOf(ctx);
  const page = pageOf(ctx);
  const params = ctx.url.searchParams;

  const to = params.get("to") ? new Date(params.get("to")!) : new Date();
  if (Number.isNaN(to.getTime())) throw badRequest("to: expected an ISO-8601 timestamp");
  const sinceMin = Number(params.get("sinceMin") ?? 60);
  if (!Number.isInteger(sinceMin) || sinceMin < 1) {
    throw badRequest("sinceMin: expected a positive integer number of minutes");
  }
  const from = params.get("from") ? new Date(params.get("from")!) : new Date(to.getTime() - sinceMin * 60_000);
  if (Number.isNaN(from.getTime())) throw badRequest("from: expected an ISO-8601 timestamp");
  if (from >= to) throw badRequest("from must be before to");

  const maxHours = ctx.app.config.logs.maxRangeHours;
  if (to.getTime() - from.getTime() > maxHours * 3600_000) {
    throw badRequest(
      `that window is wider than the ${maxHours} hours this portal will ask the log index for ` +
        "(LOGS_MAX_RANGE_HOURS). Narrow the range.",
    );
  }

  const statusClass = params.get("status");
  if (statusClass && !STATUS_CLASSES.includes(statusClass as StatusClass)) {
    throw badRequest(`status: expected one of ${STATUS_CLASSES.join(", ")}`);
  }
  const method = params.get("method");
  if (method && !/^[A-Za-z]{3,10}$/.test(method)) throw badRequest("method: expected an HTTP method name");
  const minDurationRaw = params.get("minDurationMs");
  const minDurationMs = minDurationRaw === null ? undefined : Number(minDurationRaw);
  if (minDurationMs !== undefined && (!Number.isFinite(minDurationMs) || minDurationMs < 0)) {
    throw badRequest("minDurationMs: expected a non-negative number");
  }

  return {
    environment,
    resourceIds: readableResourceIds(ctx.app, user, environment, params.get("resourceId") ?? undefined),
    from,
    to,
    statusClass: (statusClass as StatusClass) ?? undefined,
    method: method ?? undefined,
    pathContains: params.get("path")?.slice(0, 200) || undefined,
    subscriptionId: params.get("subscriptionId") ?? undefined,
    minDurationMs,
    limit: page.limit,
    offset: page.offset,
  };
}

export function registerLogRoutes(router: Router): void {
  router.add("GET", "/api/logs", "session", async (ctx) => {
    const query = queryOf(ctx);
    const provider = providerFor(ctx);
    const page = await provider.search(query);
    return json({
      ...page,
      // Echoed so the screen can say what it is showing without re-deriving it, and so a
      // bookmarked window is unambiguous when the default changes.
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      provider: provider.kind,
      // `null` when the page is the last one; the shape `pageOf`/`nextCursor` uses everywhere else.
      nextCursor:
        query.offset + page.items.length < page.total
          ? Buffer.from(String(query.offset + page.items.length)).toString("base64url")
          : null,
    });
  });

  router.add("GET", "/api/logs/histogram", "session", async (ctx) => {
    const query = queryOf(ctx);
    const bucketsRaw = ctx.url.searchParams.get("buckets");
    const buckets = bucketsRaw ? Number(bucketsRaw) : 48;
    if (!Number.isInteger(buckets) || buckets < 4 || buckets > 240) {
      throw badRequest("buckets: expected an integer between 4 and 240");
    }
    const provider = providerFor(ctx);
    const histogram = await provider.histogram(query, buckets);
    return json({
      ...histogram,
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      provider: provider.kind,
    });
  });

  // ------------------------------------------------------------------- body capture (schema-010)

  /**
   * Every window, live or spent, newest first — `?environment=` and `?resourceId=` narrow it.
   *
   * Readable by anyone with a session, like everything else in this portal: "whose bodies have
   * been captured lately, and who asked" is precisely the question this row exists to let somebody
   * else ask. Filtering it to the owner would make the record private to the person it is a record
   * of.
   */
  router.add("GET", "/api/logs/body-capture", "session", (ctx) => {
    requireUser(ctx);
    const environment = ctx.url.searchParams.get("environment");
    const resourceId = ctx.url.searchParams.get("resourceId");
    const includeSpent = ctx.url.searchParams.get("includeSpent") === "1";

    const rows = ctx.app.db
      .query<CaptureRow, []>(
        `SELECT c.id, c.resource_id, r.name AS resource_name, r.api_version, r.application_id,
                c.environment, c.reason, c.opened_by, c.opened_at, c.expires_at, c.revoked_at
           FROM body_capture c JOIN resource r ON r.id = c.resource_id
          ORDER BY c.opened_at DESC`,
      )
      .all();

    const now = Date.now();
    const items = rows
      .filter((row) => environment === null || row.environment === environment)
      .filter((row) => resourceId === null || row.resource_id === resourceId)
      .map((row) => captureView(row, now))
      .filter((item) => includeSpent || item.live);

    return json({
      items,
      maxMinutes: MAX_BODY_CAPTURE_MINUTES,
      maxBytes: MAX_LOGGED_BODY_BYTES,
    });
  });

  /**
   * Open a window. Owner or admin, with a reason, for at most an hour.
   *
   * Owner rather than admin-only — the one authorization rule, applied honestly: this captures
   * traffic to an API whose bodies the owner's own backend already receives in full, so it is a
   * change to something their application owns rather than a relaxation of a guarantee the estate
   * makes. What stops it being casual is everything around it: the reason, the audit row, the hour,
   * and the fact that the window is listed to every reader of the portal. A TLS exception is
   * admin-only for the opposite reason — it changes what this estate is willing to trust, which is
   * nobody's own decision.
   */
  router.add("POST", "/api/logs/body-capture", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{
      resourceId?: string;
      environment?: string;
      minutes?: number;
      reason?: string;
    }>(ctx);

    const resource = getResource(ctx, body.resourceId ?? "");
    assertCan(user, resource.application_id, "capture bodies for this API");
    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }

    // The same bar `tls_exception` sets, for the same reader. "debug" six weeks later is a row
    // nobody can act on; the ticket and the symptom are what makes it a record.
    const reason = (body.reason ?? "").trim();
    if (reason.length < 20) {
      throw badRequest(
        "reason: required, and at least 20 characters. It is shown beside this API for as long " +
          "as the row exists; name the ticket and the call you are trying to reproduce",
      );
    }

    const minutes = body.minutes === undefined ? MAX_BODY_CAPTURE_MINUTES : Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BODY_CAPTURE_MINUTES) {
      throw badRequest(
        `minutes: expected an integer between 1 and ${MAX_BODY_CAPTURE_MINUTES}. A longer window ` +
          "is a second request, deliberately",
      );
    }

    // A second live window would mean two rows to close and one still capturing, and the config
    // build can only carry one instant anyway.
    const open = liveCapture(ctx, resource.id, environment);
    if (open) {
      throw conflict(
        `bodies are already being captured for this API in ${environment} until ${open.expires_at} ` +
          `(opened by ${open.opened_by}). Close that window first, or wait for it to expire`,
      );
    }

    const id = newId("bcap");
    const at = nowIso();
    const expiresAt = new Date(Date.parse(at) + minutes * 60_000).toISOString();
    ctx.app.db.run(
      `INSERT INTO body_capture
         (id, resource_id, environment, reason, opened_by, opened_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, resource.id, environment, reason, user.id, at, expiresAt],
    );
    touch(ctx, resource.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "body-capture.open",
      subject: `resource:${resource.id}`,
      outcome: "ok",
      detail: { environment, reason, minutes, expiresAt },
    });

    return json(
      {
        id,
        resourceId: resource.id,
        environment,
        reason,
        openedBy: user.id,
        openedAt: at,
        expiresAt,
        maxBytes: MAX_LOGGED_BODY_BYTES,
        // Nothing is captured until the fleet polls, and the gateway then closes the window on its
        // own clock rather than on ours — so this instant is the end of it either way.
        effectiveAt: "the next poll of every gateway in this environment",
      },
      { status: 201 },
    );
  });

  /** Close a window early. Dated, not deleted — see the migration. */
  router.add("DELETE", "/api/logs/body-capture/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.app.db
      .query<
        { id: string; resource_id: string; environment: string; application_id: string; revoked_at: string | null },
        [string]
      >(
        `SELECT c.id, c.resource_id, c.environment, r.application_id, c.revoked_at
           FROM body_capture c JOIN resource r ON r.id = c.resource_id
          WHERE c.id = ?`,
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no body capture window ${ctx.params.id}`);
    assertCan(user, row.application_id, "close this capture window");

    if (!row.revoked_at) {
      ctx.app.db.run("UPDATE body_capture SET revoked_at = ? WHERE id = ?", [nowIso(), row.id]);
      touch(ctx, row.resource_id);
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "body-capture.close",
      subject: `resource:${row.resource_id}`,
      outcome: "ok",
      detail: { captureId: row.id, environment: row.environment },
    });
    return new Response(null, { status: 204 });
  });
}

interface CaptureRow {
  id: string;
  resource_id: string;
  resource_name: string;
  api_version: string;
  application_id: string;
  environment: string;
  reason: string;
  opened_by: string;
  opened_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function captureView(row: CaptureRow, now: number) {
  const expires = Date.parse(row.expires_at);
  const live = row.revoked_at === null && expires > now;
  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceName: `${row.resource_name} ${row.api_version}`,
    applicationId: row.application_id,
    environment: row.environment,
    reason: row.reason,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    live,
    /** What the screen counts down. Zero once the window is spent, never negative. */
    remainingSec: live ? Math.max(0, Math.round((expires - now) / 1000)) : 0,
  };
}

function liveCapture(ctx: Ctx, resourceId: string, environment: string) {
  return ctx.app.db
    .query<{ id: string; expires_at: string; opened_by: string }, [string, string, string]>(
      `SELECT id, expires_at, opened_by
         FROM body_capture
        WHERE resource_id = ? AND environment = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY expires_at DESC
        LIMIT 1`,
    )
    .get(resourceId, environment, nowIso());
}

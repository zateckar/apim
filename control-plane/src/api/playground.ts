import type { ConfigOperation } from "../../../shared/config-doc.ts";
import { writeAudit } from "../audit.ts";
import { newId, nowIso } from "../db.ts";
import {
  composeCall,
  forwardCall,
  takeRateSlot,
  type ComposedCall,
  type PlaygroundRequest,
  type PlaygroundResult,
} from "../playground.ts";
import { buildPlaygroundForm } from "../playground-form.ts";
import { badRequest, json, notFound, readJson, requireUser, Router, HttpError, type Ctx } from "../router.ts";
import { getResource } from "./common.ts";

/**
 * `POST /api/playground` and the caller's own history (G1, plan §5).
 *
 * The browser posts a `subscriptionId` and an `operationId`; it never posts a URL, and it never
 * receives a key. Everything about *why* that is the shape lives in `playground.ts`; this file is
 * the endpoint, the audit row and the bounded history around it.
 */

interface HistoryRow {
  id: string;
  user_id: string;
  resource_id: string;
  environment: string;
  subscription_id: string | null;
  key_kind: string;
  operation_id: string | null;
  method: string;
  path: string;
  query_json: string;
  headers_json: string;
  body: string | null;
  gateway_label: string;
  status: number | null;
  status_text: string | null;
  duration_ms: number | null;
  response_headers_json: string | null;
  response_preview: string | null;
  response_encoding: string | null;
  response_truncated: number;
  error: string | null;
  created_at: string;
}

export function registerPlaygroundRoutes(router: Router): void {
  router.add("POST", "/api/playground", "session", async (ctx) => {
    const user = requireUser(ctx);
    const request = await readJson<PlaygroundRequest>(
      ctx,
      ctx.app.config.playgroundMaxBodyBytes + 8192,
    );

    const retryAfter = takeRateSlot(ctx.app, user.id);
    if (retryAfter !== null) {
      // Protects the control plane, not the consumer's quota — the response says which.
      throw new HttpError(
        429,
        "Too Many Requests",
        `the console allows ${ctx.app.config.playgroundRatePerMin} calls a minute per user ` +
          "(PLAYGROUND_RATE_PER_MIN). This is the portal's own limit, not your subscription's",
        { retryAfterSec: retryAfter },
      );
    }

    const composed = composeCall(ctx.app, user, request);
    const result = await forwardCall(ctx.app, composed);
    recordHistory(ctx, user.id, request, composed, result);

    // Never a body, a header value or a query string: `audit` is append-only and never pruned
    // (design section 4, review `[P1-11]`).
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "playground.call",
      subject: `resource:${composed.route.resourceId}`,
      outcome: result.error ? "failed" : "ok",
      detail: {
        environment: request.environment,
        gateway: composed.gateway.label,
        operationId: composed.operation?.id ?? (request.agentCard ? "agent-card" : null),
        method: composed.method,
        subscriptionId: composed.subscriptionId,
        keyKind: composed.keyKind,
        status: result.status,
        durationMs: result.durationMs,
        bytesIn: composed.body ? Buffer.byteLength(composed.body, "utf8") : 0,
        bytesOut: result.bytesOut,
        ...(result.error ? { error: result.error } : {}),
      },
    });

    return json({
      // What was called, so a reader of the console can reproduce it with curl.
      request: {
        method: composed.method,
        path: composed.path,
        query: composed.search,
        // The header set as it was *sent* contains the key, so this is the safe set (§5.2).
        headers: composed.safeHeaders,
        gateway: composed.gateway,
        keyKind: composed.keyKind,
        subscriptionId: composed.subscriptionId,
        droppedHeaders: composed.droppedHeaders,
        warnings: composed.warnings,
      },
      response: {
        status: result.status,
        statusText: result.statusText,
        durationMs: result.durationMs,
        headers: result.responseHeaders,
        body: result.bodyText,
        encoding: result.encoding,
        truncated: result.truncated,
        bytes: result.bytesOut,
        error: result.error,
      },
      // A playground call is a real call: it spends this subscription's rate limit and quota and
      // appears in telemetry. Said here as well as in the UI, because a consumer who exhausts
      // their own quota from a test console and cannot see why has been misled by us (§5.3).
      note:
        "This request went through the gateway like any other: it consumed the subscription's " +
        "rate limit and quota and appears in telemetry.",
    });
  });

  /**
   * What the console needs to draw the form (§5.4). Separate from the send so the two cannot
   * disagree: both resolve the route through `buildRoutes`, so an operation this endpoint offers
   * is an operation the send will accept, and a refusal here is the refusal the send would give.
   */
  router.add("GET", "/api/playground/form", "session", (ctx) => {
    const user = requireUser(ctx);
    const resourceId = ctx.url.searchParams.get("resourceId");
    if (!resourceId) throw badRequest("resourceId is required");
    const environment = ctx.url.searchParams.get("environment") ?? "";
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(
        `unknown environment "${environment}" (PROMOTION_CHAIN is ${ctx.app.config.promotionChain.join(",")})`,
      );
    }
    return json(buildPlaygroundForm(ctx.app, user, resourceId, environment));
  });

  /**
   * The caller's own history, newest first, **per (user, resource) across environments** — the same
   * request against DEV and TEST is the comparison a user wants, so they are mixed and each row
   * carries its environment `[P1-28]`.
   */
  router.add("GET", "/api/playground/history", "session", (ctx) => {
    const user = requireUser(ctx);
    const resourceId = ctx.url.searchParams.get("resourceId");
    if (!resourceId) throw badRequest("resourceId is required");
    getResource(ctx, resourceId);
    const limit = Number(ctx.url.searchParams.get("limit") ?? ctx.app.config.playgroundHistoryPerResource);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest("limit: expected an integer between 1 and 100");
    }

    const rows = ctx.app.db
      .query<HistoryRow, [string, string, number]>(
        // `rowid DESC` is the tiebreak, not decoration: `created_at` is a millisecond timestamp and
        // two sends can share one, at which point "newest" would otherwise be whichever row SQLite
        // happened to visit first — and the de-duplication and eviction below read the same order.
        `SELECT * FROM playground_call
          WHERE user_id = ? AND resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(user.id, resourceId, limit);

    // What can still be replayed, and why not. An entry whose operation has gone or whose
    // subscription was revoked stays listed with the load action disabled `[P1-22]`.
    const operations = new Map<string, Set<string>>();
    const subscriptions = new Map<string, string>();
    for (const row of rows) {
      if (!operations.has(row.environment)) {
        operations.set(row.environment, new Set(servedOperations(ctx, resourceId, row.environment)));
      }
      if (row.subscription_id && !subscriptions.has(row.subscription_id)) {
        const state = ctx.app.db
          .query<{ state: string }, [string]>("SELECT state FROM subscription WHERE id = ?")
          .get(row.subscription_id);
        subscriptions.set(row.subscription_id, state?.state ?? "deleted");
      }
    }

    return json({
      resourceId,
      items: rows.map((row) => historyView(row, operations, subscriptions)),
      retentionDays: ctx.app.config.playgroundHistoryRetentionDays,
      cap: ctx.app.config.playgroundHistoryPerResource,
    });
  });

  router.add("DELETE", "/api/playground/history/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    // Scoped to the caller in the statement itself: history is per user, and an id is not a
    // capability (§4).
    const removed = ctx.app.db.run("DELETE FROM playground_call WHERE id = ? AND user_id = ?", [
      ctx.params.id!,
      user.id,
    ]);
    if (removed.changes === 0) throw notFound(`no history entry ${ctx.params.id}`);
    return new Response(null, { status: 204 });
  });

  router.add("DELETE", "/api/playground/history", "session", (ctx) => {
    const user = requireUser(ctx);
    const resourceId = ctx.url.searchParams.get("resourceId");
    if (!resourceId) throw badRequest("resourceId is required");
    const removed = ctx.app.db.run(
      "DELETE FROM playground_call WHERE user_id = ? AND resource_id = ?",
      [user.id, resourceId],
    );
    return json({ removed: removed.changes });
  });
}

/** The operation ids the environment's config currently serves for this resource. */
function servedOperations(ctx: Ctx, resourceId: string, environment: string): string[] {
  const row = ctx.app.db
    .query<{ index_json: string | null }, [string, string]>(
      `SELECT rev.index_json
         FROM release rel JOIN revision rev ON rev.id = rel.revision_id
        WHERE rel.resource_id = ? AND rel.environment = ? AND rel.state = 'converged'`,
    )
    .get(resourceId, environment);
  if (!row?.index_json) return [];
  try {
    return (JSON.parse(row.index_json) as ConfigOperation[]).map((operation) => operation.id);
  } catch {
    return [];
  }
}

function historyView(
  row: HistoryRow,
  operations: Map<string, Set<string>>,
  subscriptions: Map<string, string>,
) {
  const reasons: string[] = [];
  if (row.operation_id && !operations.get(row.environment)?.has(row.operation_id)) {
    reasons.push(
      `the operation "${row.operation_id}" is not in the revision now serving ` +
        `${row.environment.toUpperCase()}`,
    );
  }
  if (row.subscription_id) {
    const state = subscriptions.get(row.subscription_id);
    if (state === "deleted") reasons.push("the subscription it used no longer exists");
    else if (state && state !== "active") reasons.push(`the subscription it used is ${state}`);
  }

  return {
    id: row.id,
    environment: row.environment,
    subscriptionId: row.subscription_id,
    keyKind: row.key_kind,
    operationId: row.operation_id,
    method: row.method,
    path: row.path,
    query: JSON.parse(row.query_json) as unknown,
    headers: JSON.parse(row.headers_json) as unknown,
    body: row.body,
    gateway: row.gateway_label,
    status: row.status,
    statusText: row.status_text,
    durationMs: row.duration_ms,
    responseHeaders: row.response_headers_json ? (JSON.parse(row.response_headers_json) as unknown) : null,
    responsePreview: row.response_preview,
    responseEncoding: row.response_encoding,
    responseTruncated: row.response_truncated === 1,
    error: row.error,
    createdAt: row.created_at,
    /** Whether the console may load this entry back into the form, and why not (§5.5). */
    replayable: reasons.length === 0,
    reason: reasons.join("; ") || null,
  };
}

/**
 * One bounded row per send (D27). Two things are capped rather than stored whole: the request body
 * and the response preview, both at `PLAYGROUND_HISTORY_BODY_BYTES` — what we send and what we
 * keep are different questions `[P3-03]`.
 */
function recordHistory(
  ctx: Ctx,
  userId: string,
  request: PlaygroundRequest,
  composed: ComposedCall,
  result: PlaygroundResult,
): void {
  const { db, config } = ctx.app;
  const cap = config.playgroundHistoryBodyBytes;
  const bodyStored = clip(composed.body, cap);
  const previewStored = clip(result.bodyText, cap);
  const querySignature = JSON.stringify(request.query ?? []);
  const headerSignature = JSON.stringify(composed.safeHeaders);

  const write = db.transaction(() => {
    // De-duplication: a send identical to the newest entry replaces it, so hammering send does
    // not evict the history (§5.5).
    const newest = db
      .query<
        {
          id: string;
          environment: string;
          subscription_id: string | null;
          key_kind: string;
          operation_id: string | null;
          method: string;
          path: string;
          query_json: string;
          headers_json: string;
          body: string | null;
        },
        [string, string]
      >(
        `SELECT id, environment, subscription_id, key_kind, operation_id, method, path, query_json,
                headers_json, body
           FROM playground_call
          WHERE user_id = ? AND resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId, composed.route.resourceId);
    const operationId = composed.operation?.id ?? (request.agentCard ? "agent-card" : null);
    if (
      newest &&
      newest.environment === request.environment &&
      newest.subscription_id === composed.subscriptionId &&
      newest.key_kind === composed.keyKind &&
      newest.operation_id === operationId &&
      newest.method === composed.method &&
      newest.path === composed.path &&
      newest.query_json === querySignature &&
      newest.headers_json === headerSignature &&
      (newest.body ?? null) === bodyStored
    ) {
      db.run("DELETE FROM playground_call WHERE id = ?", [newest.id]);
    }

    db.run(
      `INSERT INTO playground_call
         (id, user_id, resource_id, environment, subscription_id, key_kind, operation_id, method,
          path, query_json, headers_json, body, gateway_label, status, status_text, duration_ms,
          response_headers_json, response_preview, response_encoding, response_truncated, error,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("pgc"),
        userId,
        composed.route.resourceId,
        request.environment ?? "",
        composed.subscriptionId,
        composed.keyKind,
        operationId,
        composed.method,
        composed.path,
        querySignature,
        headerSignature,
        bodyStored,
        composed.gateway.label,
        result.status,
        result.statusText,
        result.durationMs,
        JSON.stringify(result.responseHeaders),
        previewStored,
        result.encoding,
        result.truncated || (result.bodyText?.length ?? 0) > cap ? 1 : 0,
        result.error,
        nowIso(),
      ],
    );

    // Oldest dropped on write, so the table cannot grow with use.
    db.run(
      `DELETE FROM playground_call
        WHERE id IN (
          SELECT id FROM playground_call
           WHERE user_id = ? AND resource_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
        )`,
      [userId, composed.route.resourceId, config.playgroundHistoryPerResource],
    );
  });
  write();
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  return Buffer.byteLength(value, "utf8") <= max ? value : Buffer.from(value, "utf8").subarray(0, max).toString("utf8");
}

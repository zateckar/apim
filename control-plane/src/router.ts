import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import type { CpConfig } from "./config.ts";
import { parseCookies, policyOf, sessionUser, SESSION_COOKIE, type User } from "./auth.ts";
import { refreshClaimsIfDue } from "./auth-oidc.ts";
import { constantTimeEquals, hashToken } from "./crypto.ts";
// Imported as values as well as re-exported below: a bare `export … from` creates no local
// binding, and `readJson` raises a `badRequest` in this file.
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import { assertNotAwaitingPasswordChange } from "./principals.ts";
import type { QuotaService } from "./quota.ts";
import type { TelemetryAggregator } from "./telemetry.ts";

/**
 * A router over Bun's HTTP server, in place of a framework (design section 2). Middleware
 * ordering is not a hazard here because there is no middleware chain: authentication, the CSRF
 * origin check and error shaping happen once, in `dispatch`, in a fixed order.
 */
export interface App {
  db: DB;
  config: CpConfig;
  kek: Buffer;
  /** Reports arrive on the gateway poll and are flushed in batches (plan section 10). */
  telemetry: TelemetryAggregator;
  /** Quota deltas arrive on the same poll and are summed the same way (design section 5.7). */
  quota: QuotaService;
}

export interface InstanceIdentity {
  id: string;
  targetId: string;
  environment: string;
  name: string;
}

export interface Ctx {
  app: App;
  req: Request;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  user: User | null;
  sessionId: string | null;
  instance: InstanceIdentity | null;
}

export type AuthMode = "public" | "session" | "instance";
export type Handler = (ctx: Ctx) => Response | Promise<Response>;

// The refusals live in `errors.ts` since v5 and are re-exported here, because everything that
// raises one imports it from the router and there is no reason for that to change.
export {
  badGateway,
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from "./errors.ts";

interface Route {
  method: string;
  segments: string[];
  auth: AuthMode;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, auth: AuthMode, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), auth, handler });
    return this;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    if (pathMatched) throw new HttpError(405, "Method Not Allowed", `${method} is not allowed here`);
    return null;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function problemResponse(
  status: number,
  title: string,
  detail: string,
  requestId: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, detail, requestId, ...extra }),
    { status, headers: { "content-type": "application/problem+json; charset=utf-8" } },
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function checkOrigin(req: Request, config: CpConfig): void {
  const allowed = [config.publicUrl, config.uiDevOrigin].filter(Boolean) as string[];
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const candidate = origin ?? (referer ? new URL(referer).origin : null);
  if (!candidate) {
    throw forbidden(
      "cookie-authenticated writes require an Origin header (CSRF, design section 9). " +
        `Send -H "Origin: ${config.publicUrl}".`,
    );
  }
  if (!allowed.some((a) => new URL(a).origin === candidate)) {
    throw forbidden(`Origin ${candidate} is not allowed (expected one of ${allowed.join(", ")})`);
  }
}

function instanceFrom(app: App, req: Request): InstanceIdentity {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Unauthorized", "a gateway instance bearer token is required");

  const rows = app.db
    .query<
      { id: string; target_id: string; name: string; token_hash: string; environment: string },
      []
    >(
      `SELECT gi.id, gi.target_id, gi.name, gi.token_hash, t.environment
         FROM gateway_instance gi JOIN target t ON t.id = gi.target_id
        WHERE gi.revoked_at IS NULL`,
    )
    .all();

  const presented = hashToken(token);
  for (const row of rows) {
    if (constantTimeEquals(row.token_hash, presented)) {
      return { id: row.id, targetId: row.target_id, environment: row.environment, name: row.name };
    }
  }
  throw new HttpError(401, "Unauthorized", "unknown or revoked gateway instance token");
}

export async function dispatch(app: App, router: Router, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = randomUUID();
  try {
    const matched = router.match(req.method, url.pathname);
    if (!matched) throw notFound(`no route for ${req.method} ${url.pathname}`);

    const cookies = parseCookies(req.headers.get("cookie"));
    const sessionId = cookies[SESSION_COOKIE] ?? null;
    const policy = policyOf(app.config);
    let user: User | null = null;
    let instance: InstanceIdentity | null = null;

    if (matched.route.auth === "instance") {
      instance = instanceFrom(app, req);
    } else {
      // An OIDC session's roles and teams are re-read from the identity provider on a bounded
      // interval, and that has to happen before the directory is consulted (v5 `[P1-13]`). It is
      // skipped for the authentication routes themselves, which would otherwise recurse.
      if (!url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/auth/")) {
        await refreshClaimsIfDue(app, sessionId);
      }
      user = sessionUser(app.db, sessionId, policy);
      if (matched.route.auth === "session") {
        if (!user) throw new HttpError(401, "Unauthorized", "sign in first", { code: "no_session" });
        if (MUTATING.has(req.method)) checkOrigin(req, app.config);
        // A forced password change is a gate, not a suggestion: everything but reading who you
        // are, changing the password and signing out is refused until it is done (plan §5.3).
        assertNotAwaitingPasswordChange(app, user, url.pathname);
      }
    }

    const ctx: Ctx = {
      app,
      req,
      url,
      params: matched.params,
      requestId,
      user,
      sessionId,
      instance,
    };
    const response = await matched.route.handler(ctx);
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (err) {
    if (err instanceof HttpError) {
      return problemResponse(err.status, err.title, err.detail, requestId, err.extra);
    }
    console.error(`[cp] unhandled error on ${req.method} ${url.pathname}`, err);
    return problemResponse(500, "Internal Server Error", String((err as Error)?.message ?? err), requestId);
  }
}

export async function readJson<T>(ctx: Ctx, maxBytes = 1024 * 1024): Promise<T> {
  const text = await ctx.req.text();
  if (text.length > maxBytes) throw badRequest(`request body larger than ${maxBytes} bytes`);
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw badRequest(`body is not valid JSON: ${(err as Error).message}`);
  }
}

export function requireUser(ctx: Ctx): User {
  if (!ctx.user) throw new HttpError(401, "Unauthorized", "sign in first", { code: "no_session" });
  return ctx.user;
}

/**
 * The admin carve-outs, in one function (v5 plan §6). There were seven of these written out by
 * hand — five inline and two duplicate local helpers — and the point of collapsing them is that
 * the set of admin-only actions is now something you can enumerate when somebody asks what an
 * administrator can do.
 */
export function requireAdmin(ctx: Ctx, what: string): User {
  const user = requireUser(ctx);
  if (!user.isAdmin) throw forbidden(what);
  return user;
}

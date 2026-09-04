import { writeAudit } from "../audit.ts";
import {
  clearedCookie,
  createSession,
  devUser,
  policyOf,
  revokeSession,
  revokeSessionsOf,
  sessionCookie,
  sessionsOf,
  type User,
} from "../auth.ts";
import {
  assertPasswordAcceptable,
  resetLoginRate,
  setPassword,
  verifyCurrentPassword,
  verifyLocalLogin,
} from "../auth-local.ts";
import {
  authorizeUrl,
  claimsToIdentity,
  discover,
  endSessionUrl,
  exchangeCode,
  applyClaims,
  pkcePair,
  principalForSubject,
  randomToken,
  requireOidc,
  revokeAtProvider,
  safeReturnTo,
  groupClaimWasEmpty,
  unmappedGroupsFor,
  verifyIdToken,
} from "../auth-oidc.ts";
import { encrypt } from "../crypto.ts";
import { nowIso } from "../db.ts";
import { badRequest, forbidden, unauthorized } from "../errors.ts";
import {
  adminFrom,
  DEV_USERS,
  membershipsOf,
  principalById,
  userOf,
  type PrincipalRow,
} from "../principals.ts";
import { json, readJson, requireUser, type Ctx, type Router } from "../router.ts";

/**
 * The sign-in surface (v5 plan §5). One shape whichever provider answered, so nothing downstream
 * of this file needs an auth-mode branch — that is the failure the reference implementation in
 * `existing-ui-for-inspiration/` records: gates keyed on `mode !== 'oidc'` that silently stopped
 * enforcing when the mode changed.
 *
 * `/auth/login` and `/auth/callback` are deliberately **not** under `/api`. They are top-level
 * browser navigations answering `302`, and a `fetch` wrapper that followed a redirect into an
 * identity provider would be a bug waiting to happen. `server.ts` lists `/auth` as a non-static
 * prefix and the Vite dev server proxies it, or the sign-in button appears to do nothing.
 */

const FLOW_COOKIE = "apim_authflow";
const FLOW_TTL_SEC = 120;

/**
 * `Path=/auth/callback` `[P1-09]`: it is needed on exactly one request, so scoping it to `/` would
 * send it with every request for its whole life. `SameSite=Lax` is what lets it ride the identity
 * provider's top-level GET redirect back to us.
 */
function flowCookie(state: string, publicUrl: string): string {
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${FLOW_COOKIE}=${state}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${FLOW_TTL_SEC}${secure}`;
}

function clearedFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * A cross-site sign-in POST is the only CSRF shape a public login endpoint has, and the answer is
 * the same one `dev-login` has always used: reject a foreign `Origin` when one is sent, and allow
 * its absence so that `curl` and scripts work. A browser always sends it on a cross-origin POST.
 */
function checkLoginOrigin(ctx: Ctx): void {
  const origin = ctx.req.headers.get("origin");
  if (!origin) return;
  const allowed = [ctx.app.config.publicUrl, ctx.app.config.uiDevOrigin].filter(Boolean) as string[];
  if (!allowed.some((a) => new URL(a).origin === origin)) {
    throw forbidden(`Origin ${origin} is not allowed`);
  }
}

function assertProvider(ctx: Ctx, provider: "local" | "oidc" | "dev"): void {
  if (!ctx.app.config.authProviders.includes(provider)) {
    throw badRequest(
      `the "${provider}" sign-in method is not enabled here (AUTH_PROVIDERS is ` +
        `${ctx.app.config.authProviders.join(",")})`,
    );
  }
}

function userAgentOf(ctx: Ctx): string | null {
  return ctx.req.headers.get("user-agent");
}

/** What `GET /api/me` says about the caller. `null` for an anonymous one, without a 401. */
function meFor(ctx: Ctx, user: User | null): Record<string, unknown> {
  if (!user) return { user: null };
  const row = principalById(ctx.app.db, user.id);
  return {
    user: {
      ...user,
      provider: row?.provider ?? "dev",
      username: row?.username ?? user.id,
      email: row?.email ?? null,
      /** So a screen can say "admin, from the identity provider" rather than offering a demotion
       *  that would change nothing `[P1-17]`. */
      adminFrom: row ? adminFrom(row) : null,
    },
    teams: membershipsOf(ctx.app.db, user.id),
    mustChangePassword: row?.must_change === 1,
    /**
     * A deployment whose scope omits `offline_access` gets no refresh token, so the roles and
     * teams on screen are the ones from sign-in and will not change until the next one. Saying so
     * is better than silently running on eight-hour-old claims.
     */
    claimsStale:
      row?.provider === "oidc" && ctx.app.config.oidc !== null
        ? claimsAreStale(ctx)
        : false,
    /** Groups the token carried that map to no team — the Teams screen offers to create them. */
    unmappedGroups: unmappedGroupsFor(user.id),
    /**
     * The token carried no groups at all at the configured claim. Distinct from the line above and
     * reported separately: "your groups match no team here" is a portal problem an administrator
     * fixes on the Teams screen, and "your token had no groups" is a claim-path problem nobody can
     * fix from any screen. Told apart, or the second is diagnosed as the first for an afternoon.
     */
    noGroupsInToken: row?.provider === "oidc" ? groupClaimWasEmpty(user.id) : false,
  };
}

function claimsAreStale(ctx: Ctx): boolean {
  if (!ctx.sessionId) return false;
  const row = ctx.app.db
    .query<{ refresh_token_enc: string | null }, [string]>(
      "SELECT refresh_token_enc FROM session WHERE id = ?",
    )
    .get(ctx.sessionId);
  return !row?.refresh_token_enc;
}

export function registerAuthRoutes(router: Router): void {
  // ---------------------------------------------------------------- what the browser may know

  /**
   * The whole pre-session surface, and deliberately tiny `[P1-01]`. Until v5 the sign-in screen
   * read the development user list off `GET /api/meta`, which is why that endpoint was public —
   * and it carries every gateway URL the playground may use, to any anonymous caller. That is a
   * leak with no compensating feature, so the two are now separate and `/api/meta` needs a session.
   */
  router.add("GET", "/api/auth/providers", "public", (ctx) => {
    const { config } = ctx.app;
    return json({
      providers: config.authProviders,
      oidc: config.oidc ? { label: config.oidc.displayName } : null,
      // Empty unless the bypass is actually on: three usernames are harmless, but an endpoint that
      // advertises accounts a deployment does not have is a support call.
      devUsers: config.authProviders.includes("dev")
        ? DEV_USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, teams: u.teams }))
        : [],
      passwordMinLength: config.localPasswordMinLen,
    });
  });

  router.add("GET", "/api/me", "public", (ctx) => json(meFor(ctx, ctx.user)));

  // ---------------------------------------------------------------- local

  router.add("POST", "/api/auth/login", "public", async (ctx) => {
    assertProvider(ctx, "local");
    checkLoginOrigin(ctx);
    const body = await readJson<{ username?: string; password?: string }>(ctx);
    const { principal } = await verifyLocalLogin(ctx.app, body.username ?? "", body.password ?? "");
    return signedIn(ctx, principal, "local", null);
  });

  router.add("POST", "/api/auth/password", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = principalById(ctx.app.db, user.id);
    if (!row) throw unauthorized("sign in first", { code: "no_session" });
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(ctx);

    // A principal whose password an admin has just reset does not know a current one, so the
    // forced-change flow does not ask for it. Everybody else does — otherwise a stolen session
    // cookie becomes a permanent account takeover.
    if (row.must_change === 0) {
      const ok = await verifyCurrentPassword(row, body.currentPassword ?? "");
      if (!ok) throw unauthorized("currentPassword: that is not your current password");
    }
    const next = body.newPassword ?? "";
    assertPasswordAcceptable(ctx.app.config, next, { username: row.username, email: row.email });
    await setPassword(ctx.app, row, next, { mustChange: false });

    // Every *other* session goes. The one making the change survives, so a user is not signed out
    // by their own success — which is the difference between a security control and an annoyance.
    const revoked = ctx.sessionId ? revokeSessionsOf(ctx.app.db, row.id, ctx.sessionId) : 0;
    writeAudit(ctx.app.db, {
      actor: row.id,
      action: "user.password-change",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { otherSessionsRevoked: revoked },
    });
    return json({ ok: true, otherSessionsRevoked: revoked });
  });

  // ---------------------------------------------------------------- the development bypass

  router.add("POST", "/api/auth/dev-login", "public", async (ctx) => {
    assertProvider(ctx, "dev");
    checkLoginOrigin(ctx);
    const body = await readJson<{ userId?: string }>(ctx);
    const known = devUser(body.userId ?? "");
    if (!known) {
      throw badRequest(`unknown dev user (known: ${DEV_USERS.map((u) => u.id).join(", ")})`);
    }
    const row = principalById(ctx.app.db, known.id);
    if (!row) throw badRequest(`the development directory has no principal ${known.id}`);
    return signedIn(ctx, row, "dev", null);
  });

  // ---------------------------------------------------------------- OIDC

  router.add("GET", "/auth/login", "public", async (ctx) => {
    assertProvider(ctx, "oidc");
    const oidc = requireOidc(ctx.app);
    const discovery = await discover(ctx.app, oidc);

    const pkce = pkcePair();
    const state = randomToken();
    const nonce = randomToken();
    const returnTo = safeReturnTo(ctx.url.searchParams.get("return"));

    // Housekeeping on the way past, so an abandoned sign-in cannot accumulate even if the prune
    // job is not running.
    ctx.app.db.run("DELETE FROM auth_flow WHERE expires_at < ?", [nowIso()]);
    ctx.app.db.run(
      `INSERT INTO auth_flow (state, code_verifier, nonce, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        state,
        pkce.verifier,
        nonce,
        returnTo,
        nowIso(),
        new Date(Date.now() + FLOW_TTL_SEC * 1000).toISOString(),
      ],
    );

    return redirect(authorizeUrl(discovery, oidc, { state, nonce, codeChallenge: pkce.challenge }), [
      flowCookie(state, ctx.app.config.publicUrl),
    ]);
  });

  router.add("GET", "/auth/callback", "public", async (ctx) => {
    assertProvider(ctx, "oidc");
    const oidc = requireOidc(ctx.app);

    // The identity provider's own words, because most "the callback is broken" reports are a
    // mis-registered redirect URI and it has already said so.
    const idpError = ctx.url.searchParams.get("error");
    if (idpError) {
      const description = ctx.url.searchParams.get("error_description");
      throw badRequest(
        `the identity provider refused the sign-in: ${idpError}${description ? ` (${description})` : ""}`,
        { code: "idp_error" },
      );
    }

    const code = ctx.url.searchParams.get("code");
    const state = ctx.url.searchParams.get("state");
    if (!code || !state) throw badRequest("the callback carried no code or no state", { code: "callback_invalid" });

    // The cookie binding is what stops login CSRF: an attacker who starts their own flow and
    // feeds a victim the resulting `code` has no way to put their `state` in the victim's browser.
    const cookieState = parseCookieHeader(ctx.req.headers.get("cookie"))[FLOW_COOKIE] ?? null;
    if (!cookieState || cookieState !== state) {
      throw badRequest(
        "this sign-in did not start in this browser. Start again from the portal's sign-in page.",
        { code: "state_mismatch" },
      );
    }

    const flow = ctx.app.db
      .query<{ code_verifier: string; nonce: string; return_to: string; expires_at: string }, [string]>(
        "SELECT code_verifier, nonce, return_to, expires_at FROM auth_flow WHERE state = ?",
      )
      .get(state);
    if (!flow || Date.parse(flow.expires_at) < Date.now()) {
      throw badRequest("this sign-in took too long, or has already been completed. Start again.", {
        code: "state_mismatch",
      });
    }
    // Deleted before the exchange, so a replayed callback cannot exchange the same code twice.
    ctx.app.db.run("DELETE FROM auth_flow WHERE state = ?", [state]);

    const discovery = await discover(ctx.app, oidc);
    const tokens = await exchangeCode(ctx.app, oidc, discovery, {
      code,
      codeVerifier: flow.code_verifier,
    });
    if (!tokens.id_token) {
      throw badRequest("the identity provider returned no id_token, so there is no identity to use", {
        code: "no_id_token",
      });
    }

    const verified = await verifyIdToken(tokens.id_token, oidc, discovery, flow.nonce);
    const identity = claimsToIdentity(verified.claims, oidc);
    const row = principalForSubject(ctx.app, oidc, verified.sub, identity);
    if (row.disabled_at) {
      // The local kill switch: a deployment's own offboarding is sometimes faster than the
      // directory's, and this is what makes disabling here mean something.
      writeAudit(ctx.app.db, {
        actor: row.id,
        action: "auth.login-failed",
        subject: `user:${row.id}`,
        outcome: "denied",
        detail: { provider: "oidc", why: "account disabled here" },
      });
      throw forbidden("that account is disabled in this portal. An administrator can re-enable it.");
    }
    applyClaims(ctx.app, row, identity);

    const fresh = principalById(ctx.app.db, row.id)!;
    return signedIn(ctx, fresh, "oidc", tokens.refresh_token ?? null, flow.return_to);
  });

  // ---------------------------------------------------------------- signing out

  router.add("POST", "/api/auth/logout", "session", async (ctx) => {
    const user = requireUser(ctx);
    let endSession: string | null = null;
    const row = ctx.sessionId
      ? ctx.app.db
          .query<{ provider: string; refresh_token_enc: string | null }, [string]>(
            "SELECT provider, refresh_token_enc FROM session WHERE id = ?",
          )
          .get(ctx.sessionId)
      : null;

    if (ctx.sessionId) revokeSession(ctx.app.db, ctx.sessionId);

    // Local revocation is the authoritative step and has already happened; the provider round trip
    // is best-effort, so an identity provider that is down cannot leave somebody signed in here.
    if (row?.provider === "oidc" && ctx.app.config.oidc) {
      try {
        const oidc = ctx.app.config.oidc;
        const discovery = await discover(ctx.app, oidc);
        if (row.refresh_token_enc) {
          const { decrypt } = await import("../crypto.ts");
          await revokeAtProvider(ctx.app, oidc, discovery, decrypt(row.refresh_token_enc, ctx.app.kek));
        }
        endSession = endSessionUrl(discovery, oidc, ctx.app.config.publicUrl);
      } catch (err) {
        console.warn(`[cp] signing out at the identity provider failed: ${String(err)}`);
      }
    }

    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "auth.logout",
      subject: `user:${user.id}`,
      outcome: "ok",
    });
    return json(
      { ok: true, endSessionUrl: endSession },
      { headers: { "set-cookie": clearedCookie() } },
    );
  });

  // ---------------------------------------------------------------- the caller's own sessions

  router.add("GET", "/api/my/sessions", "session", (ctx) => {
    const user = requireUser(ctx);
    return json({ items: sessionsOf(ctx.app.db, user.id, ctx.sessionId) });
  });

  router.add("DELETE", "/api/my/sessions/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const id = ctx.params.id!;
    const mine = ctx.app.db
      .query<{ id: string }, [string, string]>("SELECT id FROM session WHERE id = ? AND user_id = ?")
      .get(id, user.id);
    // A 404 rather than a 403 for somebody else's session: whether a given session id exists is
    // not a fact this endpoint should confirm.
    if (!mine) throw badRequest("no session of yours has that id");
    revokeSession(ctx.app.db, id);
    return json({ id, revoked: true, current: id === ctx.sessionId });
  });

  router.add("POST", "/api/my/sessions/revoke-all", "session", (ctx) => {
    const user = requireUser(ctx);
    const revoked = revokeSessionsOf(ctx.app.db, user.id, ctx.sessionId);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "session.revoke",
      subject: `user:${user.id}`,
      outcome: "ok",
      detail: { revoked, sparedCurrent: true },
    });
    return json({ revoked });
  });
}

/** One place a session is created, whichever provider got us here. */
function signedIn(
  ctx: Ctx,
  row: PrincipalRow,
  provider: "local" | "oidc" | "dev",
  refreshToken: string | null,
  returnTo: string | null = null,
): Response {
  const user = userOf(ctx.app.db, row);
  const sessionId = createSession(ctx.app.db, user, policyOf(ctx.app.config), {
    provider,
    refreshTokenEnc: refreshToken ? encrypt(refreshToken, ctx.app.kek) : null,
    userAgent: userAgentOf(ctx),
    claimsRefreshedAt: provider === "oidc" ? nowIso() : null,
  });
  ctx.app.db.run("UPDATE principal SET last_login_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(ctx.app.db, {
    actor: row.id,
    action: "auth.login",
    subject: `user:${row.id}`,
    outcome: "ok",
    detail: { provider, mustChangePassword: row.must_change === 1 },
  });

  const cookie = sessionCookie(sessionId, ctx.app.config.publicUrl);
  if (returnTo !== null) return redirect(returnTo, [cookie, clearedFlowCookie()]);
  return json(
    { user, mustChangePassword: row.must_change === 1 },
    { headers: { "set-cookie": cookie, "cache-control": "no-store" } },
  );
}

/** The router has already parsed cookies for the session; the flow cookie needs its own read. */
function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Tests reset the shared login-rate window between cases; nothing in the product calls this. */
export { resetLoginRate };

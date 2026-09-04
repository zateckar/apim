import type { CpConfig } from "./config.ts";
import type { DB } from "./db.ts";
import { newId, nowIso } from "./db.ts";
import { DEV_USERS, userFor, type Provider } from "./principals.ts";

/**
 * Sessions and the one authorization function (design §9).
 *
 * Who a person *is* lives in `principals.ts`; this module is about the cookie in front of them.
 * The split matters because of D35: a session no longer carries the roles and teams it was issued
 * with, it carries a pointer to the directory, and the directory is read on every request. So an
 * admin's edit to somebody's role or teams takes effect on that person's next request instead of
 * on their next sign-in, and there is no re-issue-on-privilege-change machinery to get wrong.
 *
 * `roles_json` and `teams_json` are still written, and are still what they always were — but they
 * are now the *login-time snapshot*, kept because "what was this person allowed to do when they
 * signed in" is an audit question, not an authorization one.
 */
export interface User {
  id: string;
  name: string;
  roles: string[];
  teams: string[];
  isAdmin: boolean;
}

export const SESSION_COOKIE = "apim_session";

/** The two bounds design §9 asks to be distinct, and the prune horizon behind them. */
export interface SessionPolicy {
  idleMin: number;
  lifetimeHours: number;
}

export function policyOf(config: CpConfig): SessionPolicy {
  return { idleMin: config.sessionIdleMin, lifetimeHours: config.sessionLifetimeHours };
}

export interface NewSession {
  provider: Provider;
  /** OIDC only, and encrypted by the caller before it gets here. */
  refreshTokenEnc?: string | null;
  /** Truncated by the caller; shown in the user's own session list and nowhere else. */
  userAgent?: string | null;
  claimsRefreshedAt?: string | null;
}

export function createSession(
  db: DB,
  user: User,
  policy: SessionPolicy,
  options: NewSession,
): string {
  const id = newId("ses");
  const now = new Date();
  db.run(
    `INSERT INTO session
       (id, user_id, roles_json, teams_json, created_at, idle_until, expires_at,
        provider, refresh_token_enc, claims_refreshed_at, user_agent, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      user.id,
      JSON.stringify(user.roles),
      JSON.stringify(user.teams),
      now.toISOString(),
      new Date(now.getTime() + policy.idleMin * 60_000).toISOString(),
      new Date(now.getTime() + policy.lifetimeHours * 3_600_000).toISOString(),
      options.provider,
      options.refreshTokenEnc ?? null,
      options.claimsRefreshedAt ?? null,
      options.userAgent ? options.userAgent.slice(0, 200) : null,
      now.toISOString(),
    ],
  );
  return id;
}

export interface SessionRow {
  id: string;
  user_id: string;
  provider: Provider;
  created_at: string;
  idle_until: string;
  expires_at: string;
  revoked_at: string | null;
  refresh_token_enc: string | null;
  claims_refreshed_at: string | null;
  user_agent: string | null;
  last_seen_at: string | null;
}

/** The row, without asking whether it is still valid. The OIDC claim re-read needs this. */
export function sessionRow(db: DB, sessionId: string | null): SessionRow | null {
  if (!sessionId) return null;
  return (
    db
      .query<SessionRow, [string]>(
        `SELECT id, user_id, provider, created_at, idle_until, expires_at, revoked_at,
                refresh_token_enc, claims_refreshed_at, user_agent, last_seen_at
           FROM session WHERE id = ?`,
      )
      .get(sessionId) ?? null
  );
}

export function sessionValid(row: SessionRow | null, nowMs = Date.now()): boolean {
  if (!row || row.revoked_at) return false;
  return Date.parse(row.expires_at) >= nowMs && Date.parse(row.idle_until) >= nowMs;
}

/**
 * The signed-in user, or `null`. Resolves the directory live (D35), so a disabled principal's
 * session stops working on its next request rather than at its next sign-in — which is the local
 * kill switch a deployment needs when the identity provider's own offboarding is slower than the
 * incident.
 */
export function sessionUser(db: DB, sessionId: string | null, policy: SessionPolicy): User | null {
  const row = sessionRow(db, sessionId);
  if (!sessionValid(row)) return null;
  const user = userFor(db, row!.user_id);
  if (!user) return null;
  touchSession(db, row!.id, policy);
  return user;
}

/** Slides the idle window and records the visit, in the one write the request was making anyway. */
export function touchSession(db: DB, sessionId: string, policy: SessionPolicy): void {
  const now = Date.now();
  db.run("UPDATE session SET idle_until = ?, last_seen_at = ? WHERE id = ?", [
    new Date(now + policy.idleMin * 60_000).toISOString(),
    new Date(now).toISOString(),
    sessionId,
  ]);
}

export function revokeSession(db: DB, sessionId: string): void {
  db.run("UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowIso(), sessionId]);
}

/**
 * Every session of a principal except, optionally, one. Used by a password change (which spares
 * the session making the change, so the user is not signed out by their own success) and by an
 * admin's force-sign-out and disable (which spare nothing).
 */
export function revokeSessionsOf(db: DB, userId: string, except: string | null = null): number {
  const rows = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM session WHERE user_id = ? AND revoked_at IS NULL",
    )
    .all(userId)
    .filter((row) => row.id !== except);
  for (const row of rows) revokeSession(db, row.id);
  return rows.length;
}

export interface SessionView {
  id: string;
  provider: Provider;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export function sessionsOf(db: DB, userId: string, currentId: string | null): SessionView[] {
  const now = Date.now();
  return db
    .query<SessionRow, [string]>(
      `SELECT id, user_id, provider, created_at, idle_until, expires_at, revoked_at,
              refresh_token_enc, claims_refreshed_at, user_agent, last_seen_at
         FROM session WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    )
    .all(userId)
    .filter((row) => sessionValid(row, now))
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      current: row.id === currentId,
    }));
}

/** Who the `dev` provider lets you become. The list itself lives with the directory. */
export function devUser(id: string): { id: string; name: string } | null {
  const found = DEV_USERS.find((u) => u.id === id);
  return found ? { id: found.id, name: found.name } : null;
}

/** `can(user, action, subject) = user.isAdmin || subject.team_id ∈ user.teams` (design §9). */
export function can(user: User | null, teamId: string | null | undefined): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!teamId) return false;
  return user.teams.includes(teamId);
}

export function capabilitiesFor(user: User | null, teamId: string | null | undefined): string[] {
  const caps = ["read"];
  if (can(user, teamId)) caps.push("update", "delete", "publish", "policy");
  return caps;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(id: string, publicUrl: string): string {
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

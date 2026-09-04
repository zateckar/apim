import type { DB } from "./db.ts";
import { newId, nowIso } from "./db.ts";
import { conflict, HttpError, notFound } from "./errors.ts";
import type { App } from "./router.ts";
import type { User } from "./auth.ts";

/**
 * The directory (v5 plan §4, §6, §7). One table for every human the portal knows, whichever
 * provider authenticated them, and one place that decides what they are allowed to be.
 *
 * Two rules live here rather than in the endpoints, because an endpoint is a place to forget them:
 *
 *  - **The last enabled admin cannot be disabled or demoted.** Otherwise a deployment locks itself
 *    out of its own trust store, global policy and audit log with one click.
 *  - **A principal cannot disable or demote itself.** The last-admin rule does not cover it — an
 *    estate with two admins would let either one remove their own access by accident.
 *
 * Both answer `409`, not `403`: they are conflicts with the state of the world, not refusals of
 * permission. The caller *is* an admin; there is simply no valid end state on the other side.
 */

export type Provider = "local" | "oidc" | "dev";
export type Role = "member" | "admin";

export interface PrincipalRow {
  id: string;
  provider: Provider;
  subject: string;
  username: string;
  email: string | null;
  display_name: string;
  role: Role;
  idp_admin: number;
  password_hash: string | null;
  must_change: number;
  disabled_at: string | null;
  failed_count: number;
  locked_until: string | null;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
}

export interface TeamMembership {
  teamId: string;
  teamName: string;
  /** `idp` came from a token's group claim; `local` was granted here (D33). */
  source: "idp" | "local";
  grantedBy: string | null;
  grantedAt: string | null;
  /** The IdP group that produced an `idp` row, so a member list can say where it came from. */
  sourceGroup: string | null;
}

const SELECT_PRINCIPAL = "SELECT * FROM principal WHERE id = ?";

export function principalById(db: DB, id: string): PrincipalRow | null {
  return db.query<PrincipalRow, [string]>(SELECT_PRINCIPAL).get(id) ?? null;
}

export function principalOr404(db: DB, id: string): PrincipalRow {
  const row = principalById(db, id);
  if (!row) throw notFound(`no user ${id}`);
  return row;
}

export function principalBySubject(db: DB, provider: Provider, subject: string): PrincipalRow | null {
  return (
    db
      .query<PrincipalRow, [string, string]>(
        "SELECT * FROM principal WHERE provider = ? AND subject = ?",
      )
      .get(provider, subject) ?? null
  );
}

/** Local usernames are what a person types, so they are matched case-insensitively. */
export function localByUsername(db: DB, username: string): PrincipalRow | null {
  return (
    db
      .query<PrincipalRow, [string]>(
        "SELECT * FROM principal WHERE provider = 'local' AND lower(username) = lower(?)",
      )
      .get(username.trim()) ?? null
  );
}

export function isAdminRow(row: PrincipalRow): boolean {
  return row.role === "admin" || row.idp_admin === 1;
}

/** Where the admin flag came from, so a screen can say why a local demotion changed nothing. */
export function adminFrom(row: PrincipalRow): "local" | "idp" | "both" | null {
  const local = row.role === "admin";
  const idp = row.idp_admin === 1;
  if (local && idp) return "both";
  if (local) return "local";
  if (idp) return "idp";
  return null;
}

export function teamIdsOf(db: DB, userId: string): string[] {
  return db
    .query<{ team_id: string }, [string]>("SELECT team_id FROM membership WHERE user_id = ?")
    .all(userId)
    .map((row) => row.team_id);
}

export function membershipsOf(db: DB, userId: string): TeamMembership[] {
  return db
    .query<
      {
        team_id: string;
        name: string;
        source: "idp" | "local";
        granted_by: string | null;
        granted_at: string | null;
        source_group: string | null;
      },
      [string]
    >(
      `SELECT m.team_id, t.name, m.source, m.granted_by, m.granted_at, t.source_group
         FROM membership m JOIN team t ON t.id = m.team_id
        WHERE m.user_id = ? ORDER BY t.name`,
    )
    .all(userId)
    .map((row) => ({
      teamId: row.team_id,
      teamName: row.name,
      source: row.source,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
      sourceGroup: row.source_group,
    }));
}

/**
 * The directory's answer to "who is this", resolved **live** rather than from the session's
 * snapshot (D35). It is why an admin's edit to somebody's role or teams takes effect on that
 * person's next request instead of on their next sign-in, with no invalidation machinery to get
 * wrong. Two indexed reads on tables with tens of rows.
 */
export function userFor(db: DB, id: string): User | null {
  const row = principalById(db, id);
  if (!row || row.disabled_at) return null;
  return userOf(db, row);
}

export function userOf(db: DB, row: PrincipalRow): User {
  const admin = isAdminRow(row);
  return {
    id: row.id,
    name: row.display_name,
    roles: admin ? ["admin"] : ["member"],
    teams: teamIdsOf(db, row.id),
    isAdmin: admin,
  };
}

/**
 * A local principal whose password an admin has just reset — or the bootstrap admin, who has never
 * had one of their own choosing — may do exactly three things: read who they are, change the
 * password, and sign out. Everything else is refused with the screen that fixes it.
 *
 * The gate is here rather than in the endpoints because it has to apply to routes nobody thought
 * about, including ones added later. The allowlist is three paths and it is tested path by path.
 */
const PASSWORD_CHANGE_ALLOWED = ["/api/me", "/api/auth/password", "/api/auth/logout"];

export function assertNotAwaitingPasswordChange(app: App, user: User, pathname: string): void {
  if (PASSWORD_CHANGE_ALLOWED.includes(pathname)) return;
  const row = principalById(app.db, user.id);
  if (!row || row.must_change === 0) return;
  throw new HttpError(
    403,
    "Forbidden",
    "your password has to be changed before you can do anything else here",
    { code: "password_change_required", fix: { screen: "account" } },
  );
}

// --------------------------------------------------------------------------- display names

/**
 * Ids stop being readable the moment a principal is not called `alice` `[P2-03]`. One query for a
 * whole page's worth of them; anything unresolved is returned as itself, because an id that no
 * longer has a principal is still the truthful answer to "who did this".
 */
export function displayNames(db: DB, ids: Iterable<string>): Map<string, string> {
  const wanted = [...new Set([...ids].filter(Boolean))];
  const out = new Map<string, string>(wanted.map((id) => [id, id]));
  if (wanted.length === 0) return out;
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .query<{ id: string; display_name: string }, string[]>(
      `SELECT id, display_name FROM principal WHERE id IN (${placeholders})`,
    )
    .all(...wanted);
  for (const row of rows) out.set(row.id, row.display_name);
  return out;
}

// --------------------------------------------------------------------------- writes

export interface CreatePrincipal {
  provider: Provider;
  subject: string;
  username: string;
  displayName: string;
  email?: string | null;
  role?: Role;
  passwordHash?: string | null;
  mustChange?: boolean;
  createdBy: string;
}

export function createPrincipal(db: DB, input: CreatePrincipal): PrincipalRow {
  const id = newId("usr");
  db.run(
    `INSERT INTO principal
       (id, provider, subject, username, email, display_name, role, password_hash, must_change,
        created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider,
      input.subject,
      input.username,
      input.email ?? null,
      input.displayName,
      input.role ?? "member",
      input.passwordHash ?? null,
      input.mustChange ? 1 : 0,
      nowIso(),
      input.createdBy,
    ],
  );
  return principalById(db, id)!;
}

function enabledAdminCount(db: DB): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM principal WHERE disabled_at IS NULL AND (role = 'admin' OR idp_admin = 1)",
    )
    .get()!.n;
}

/**
 * The two self-protection rules, in one place so every write goes through them. `actorId` is who
 * is asking; `row` is who it is about.
 */
export function assertStillReachable(
  db: DB,
  row: PrincipalRow,
  actorId: string,
  change: "disable" | "demote",
): void {
  // The last-admin rule is checked first, and the order is the point. Only an enabled admin can
  // reach here, so "the subject is the last admin" and "the subject is the caller" are the same
  // case — and telling a sole administrator to "ask another administrator" is advice to go and
  // talk to somebody who does not exist. The rule below says the thing that unblocks them.
  if (isAdminRow(row) && enabledAdminCount(db) <= 1) {
    throw conflict(
      `${row.display_name} is the only enabled administrator left, so ${
        change === "disable" ? "disabling" : "demoting"
      } them would leave nobody able to manage users, trust anchors, global policy or the audit ` +
        "log. Make somebody else an administrator first.",
      { fix: { screen: "users" } },
    );
  }
  if (row.id === actorId) {
    throw conflict(
      change === "disable"
        ? "you cannot disable your own account — ask another administrator"
        : "you cannot remove your own administrator role — ask another administrator",
      { fix: { screen: "users" } },
    );
  }
}

// --------------------------------------------------------------------------- membership

export function grantMembership(
  db: DB,
  userId: string,
  teamId: string,
  source: "idp" | "local",
  grantedBy: string,
): void {
  db.run(
    `INSERT INTO membership (team_id, user_id, source, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (team_id, user_id) DO UPDATE SET
       -- A local grant outranks an IdP one: it is a decision somebody made here, and letting the
       -- next claim sync silently downgrade its provenance would lose that (D33).
       source     = CASE WHEN membership.source = 'local' OR excluded.source = 'local'
                         THEN 'local' ELSE 'idp' END,
       granted_by = COALESCE(membership.granted_by, excluded.granted_by),
       granted_at = COALESCE(membership.granted_at, excluded.granted_at)`,
    [teamId, userId, source, grantedBy, nowIso()],
  );
}

export function revokeMembership(db: DB, userId: string, teamId: string): boolean {
  const before = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM membership WHERE user_id = ? AND team_id = ?",
    )
    .get(userId, teamId)!.n;
  db.run("DELETE FROM membership WHERE user_id = ? AND team_id = ?", [userId, teamId]);
  return before > 0;
}

/**
 * Replace this principal's IdP-derived memberships with what the token just said, leaving locally
 * granted ones alone (D33). Called on every OIDC sign-in and every claim re-read, which is how
 * design §9's "a group removal in the IdP takes effect at the next refresh" happens.
 */
export function syncIdpMemberships(db: DB, userId: string, teamIds: string[]): void {
  const wanted = new Set(teamIds);
  const current = db
    .query<{ team_id: string; source: string }, [string]>(
      "SELECT team_id, source FROM membership WHERE user_id = ?",
    )
    .all(userId);
  for (const row of current) {
    if (row.source === "idp" && !wanted.has(row.team_id)) {
      db.run("DELETE FROM membership WHERE user_id = ? AND team_id = ?", [userId, row.team_id]);
    }
  }
  for (const teamId of wanted) grantMembership(db, userId, teamId, "idp", "idp-sync");
}

// --------------------------------------------------------------------------- the dev directory

export const TEAM_PLATFORM = "team_platform";
export const TEAM_ORDERS = "team_orders";

export const DEV_TEAMS = [
  { id: TEAM_PLATFORM, name: "Platform APIs", source_group: "SG-APIM-PLATFORM" },
  { id: TEAM_ORDERS, name: "Orders", source_group: "SG-APIM-ORDERS" },
];

/**
 * Who the `dev` provider lets you become. Their ids are bare words rather than `usr_…` because
 * they predate the directory: every v1–v4 database records `alice`, `pavel` and `clara` as the
 * authors of its revisions and releases, and renaming them would rewrite history `[P1-04]`.
 */
export const DEV_USERS: Array<{ id: string; name: string; role: Role; teams: string[] }> = [
  { id: "alice", name: "Alice Admin", role: "admin", teams: [TEAM_PLATFORM, TEAM_ORDERS] },
  { id: "pavel", name: "Pavel Publisher", role: "member", teams: [TEAM_PLATFORM] },
  { id: "clara", name: "Clara Consumer", role: "member", teams: [TEAM_ORDERS] },
];

/**
 * The three development principals, their two teams and their memberships — idempotent, and a
 * no-op unless the `dev` provider is enabled. Called from `createApp`, so `AUTH_PROVIDERS=dev` on
 * an empty database is self-sufficient and does not need the seed script to have run first.
 */
export function ensureDevDirectory(app: App): void {
  if (!app.config.authProviders.includes("dev")) return;
  const { db } = app;
  for (const team of DEV_TEAMS) {
    db.run(
      `INSERT INTO team (id, name, source_group) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, source_group = excluded.source_group`,
      [team.id, team.name, team.source_group],
    );
  }
  for (const user of DEV_USERS) {
    db.run(
      `INSERT INTO principal (id, provider, subject, username, display_name, role, created_at, created_by)
       VALUES (?, 'dev', ?, ?, ?, ?, ?, 'dev-provider')
       ON CONFLICT (id) DO UPDATE SET
         provider     = 'dev',
         display_name = excluded.display_name,
         role         = excluded.role,
         disabled_at  = NULL`,
      [user.id, user.id, user.id, user.name, user.role, nowIso()],
    );
    for (const teamId of user.teams) grantMembership(db, user.id, teamId, "local", "dev-provider");
  }
}

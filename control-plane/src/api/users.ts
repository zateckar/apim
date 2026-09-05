import { writeAudit } from "../audit.ts";
import { can, revokeSessionsOf, sessionsOf } from "../auth.ts";
import {
  assertPasswordAcceptable,
  assertUsernameAcceptable,
  hashPassword,
  setPassword,
} from "../auth-local.ts";
import { newId, nowIso } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { applicationMetadata, ensureApplicationMetadata } from "../integrations.ts";
import {
  adminFrom,
  assertStillReachable,
  createPrincipal,
  displayNames,
  grantMembership,
  isAdminRow,
  localByUsername,
  membershipsOf,
  principalOr404,
  revokeMembership,
  type PrincipalRow,
  type Role,
} from "../principals.ts";
import { json, readJson, requireAdmin, requireUser, Router, type Ctx } from "../router.ts";
import { nextCursor, pageOf } from "./common.ts";

/**
 * User and application management (v5 plan §7).
 *
 * Two things this file deliberately does not do:
 *
 *  - **It does not delete people.** `audit.actor`, `revision.created_by` and `release.released_by`
 *    reference a principal by id, and the audit table is append-only by trigger, so a delete would
 *    either orphan history or break the constraint that keeps it honest. `disabled_at` is the end
 *    state and the list can filter on it.
 *  - **It does not edit an OIDC principal's directory-owned fields.** A `PATCH` that changed a
 *    display name the next claim re-read would overwrite looks like the portal losing writes, so
 *    it refuses and names the directory as the owner instead.
 */

interface UserView {
  id: string;
  provider: string;
  username: string;
  email: string | null;
  displayName: string;
  /** What an admin set here. `effectiveRole` is what actually applies. */
  role: Role;
  effectiveRole: Role;
  /** `local`, `idp`, `both` or null — so a screen can explain a demotion that changes nothing. */
  adminFrom: "local" | "idp" | "both" | null;
  disabled: boolean;
  mustChangePassword: boolean;
  /** Only meaningful for a local principal; null for everybody else rather than false. */
  hasPassword: boolean | null;
  lockedUntil: string | null;
  createdAt: string;
  createdBy: string;
  lastLoginAt: string | null;
  applications: number;
}

function viewOf(row: PrincipalRow, applicationCount: number): UserView {
  return {
    id: row.id,
    provider: row.provider,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    effectiveRole: isAdminRow(row) ? "admin" : "member",
    adminFrom: adminFrom(row),
    disabled: Boolean(row.disabled_at),
    mustChangePassword: row.must_change === 1,
    hasPassword: row.provider === "local" ? Boolean(row.password_hash) : null,
    lockedUntil:
      row.locked_until && Date.parse(row.locked_until) > Date.now() ? row.locked_until : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastLoginAt: row.last_login_at,
    applications: applicationCount,
  };
}

function assertLocal(row: PrincipalRow, what: string): void {
  if (row.provider === "local") return;
  throw conflict(
    `${what} is not something this portal decides for ${row.display_name}: that account signs in ` +
      `through ${
        row.provider === "oidc" ? "the identity provider" : "the development bypass"
      }, which owns it. Change it there.`,
    { fix: { screen: "users" } },
  );
}

export function registerUserRoutes(router: Router): void {
  // ---------------------------------------------------------------- the directory

  router.add("GET", "/api/users", "session", (ctx) => {
    requireAdmin(ctx, "the user directory is admin-only");
    const page = pageOf(ctx);
    const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
    const provider = ctx.url.searchParams.get("provider");
    if (provider && !["local", "oidc", "dev"].includes(provider)) {
      throw badRequest('provider: expected "local", "oidc" or "dev"');
    }

    // `q` is matched in SQL rather than after paging: filtering a page would make the page sizes
    // lie and would hide matches that fell past the limit.
    const where: string[] = [];
    const args: string[] = [];
    if (provider) {
      where.push("provider = ?");
      args.push(provider);
    }
    if (q) {
      where.push("(lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(email) LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = ctx.app.db
      .query<PrincipalRow, (string | number)[]>(
        `SELECT * FROM principal
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY lower(display_name) LIMIT ? OFFSET ?`,
      )
      .all(...args, page.limit, page.offset);

    const counts = applicationCounts(ctx);
    return json({
      items: rows.map((row) => viewOf(row, counts.get(row.id) ?? 0)),
      nextCursor: nextCursor(page, rows.length),
      /** So the screen can say which sign-in methods a created account could use. */
      providers: ctx.app.config.authProviders,
    });
  });

  router.add("POST", "/api/users", "session", async (ctx) => {
    const actor = requireAdmin(ctx, "creating an account is admin-only");
    if (!ctx.app.config.authProviders.includes("local")) {
      throw conflict(
        'this deployment does not have the "local" sign-in method enabled, so an account created ' +
          "here could never be used. Accounts arrive from the identity provider on first sign-in.",
      );
    }
    const body = await readJson<{
      username?: string;
      displayName?: string;
      email?: string;
      role?: string;
      password?: string;
    }>(ctx);

    const username = assertUsernameAcceptable(body.username ?? "");
    if (localByUsername(ctx.app.db, username)) {
      throw conflict(`a local account called "${username}" already exists`);
    }
    const role = roleFrom(body.role);
    const email = (body.email ?? "").trim() || null;
    const password = body.password ?? "";
    assertPasswordAcceptable(ctx.app.config, password, { username, email });

    const row = createPrincipal(ctx.app.db, {
      provider: "local",
      subject: username,
      username,
      displayName: (body.displayName ?? "").trim() || username,
      email,
      role,
      passwordHash: await hashPassword(password),
      // Always: the password was chosen by somebody who is not the person who will use it, and it
      // travelled through a form and a request body to get here.
      mustChange: true,
      createdBy: actor.id,
    });
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "user.create",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { provider: "local", username, role },
    });
    return json(viewOf(row, 0), { status: 201 });
  });

  router.add("GET", "/api/users/:id", "session", (ctx) => {
    requireAdmin(ctx, "reading an account is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    const memberships = membershipsOf(ctx.app.db, row.id);
    const granters = displayNames(
      ctx.app.db,
      memberships.map((m) => m.grantedBy ?? ""),
    );
    return json({
      ...viewOf(row, memberships.length),
      memberships: memberships.map((m) => ({
        ...m,
        grantedByName: m.grantedBy ? (granters.get(m.grantedBy) ?? m.grantedBy) : null,
      })),
      sessions: sessionsOf(ctx.app.db, row.id, null),
    });
  });

  router.add("PATCH", "/api/users/:id", "session", async (ctx) => {
    const actor = requireAdmin(ctx, "changing an account is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    const body = await readJson<{
      displayName?: string;
      email?: string;
      role?: string;
      disabled?: boolean;
    }>(ctx);

    const changed: Record<string, unknown> = {};

    if (body.displayName !== undefined || body.email !== undefined) {
      assertLocal(row, "the name and email address");
    }
    if (body.displayName !== undefined) {
      const value = body.displayName.trim();
      if (value.length < 1 || value.length > 120) throw badRequest("displayName: 1–120 characters");
      ctx.app.db.run("UPDATE principal SET display_name = ? WHERE id = ?", [value, row.id]);
      changed.displayName = value;
    }
    if (body.email !== undefined) {
      const value = body.email.trim() || null;
      if (value && !/^[^\s@]+@[^\s@]+$/.test(value)) throw badRequest("email: expected an address");
      ctx.app.db.run("UPDATE principal SET email = ? WHERE id = ?", [value, row.id]);
      changed.email = value;
    }
    if (body.role !== undefined) {
      const role = roleFrom(body.role);
      if (role === "member" && row.role === "admin") {
        assertStillReachable(ctx.app.db, row, actor.id, "demote");
      }
      ctx.app.db.run("UPDATE principal SET role = ? WHERE id = ?", [role, row.id]);
      changed.role = role;
    }
    if (body.disabled !== undefined) {
      if (body.disabled) {
        assertStillReachable(ctx.app.db, row, actor.id, "disable");
        ctx.app.db.run("UPDATE principal SET disabled_at = ? WHERE id = ?", [nowIso(), row.id]);
        // A disabled account's sessions go now, not at their next idle timeout. This is the local
        // kill switch, and a kill switch with an hour of lag is not one.
        changed.sessionsRevoked = revokeSessionsOf(ctx.app.db, row.id);
      } else {
        ctx.app.db.run(
          "UPDATE principal SET disabled_at = NULL, failed_count = 0, locked_until = NULL WHERE id = ?",
          [row.id],
        );
      }
      changed.disabled = body.disabled;
    }

    if (Object.keys(changed).length === 0) throw badRequest("nothing to change");
    const fresh = principalOr404(ctx.app.db, row.id);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: body.disabled === true ? "user.disable" : body.disabled === false ? "user.enable" : "user.update",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: changed,
    });
    return json({
      ...viewOf(fresh, membershipsOf(ctx.app.db, fresh.id).length),
      /**
       * Returned so a screen can say "still an administrator, from the identity provider" rather
       * than showing a demotion that reported success and changed nothing `[P1-17]`.
       */
      note:
        body.role === "member" && fresh.idp_admin === 1
          ? `${fresh.display_name} is still an administrator because the identity provider says so. ` +
            "Remove the role there, or disable the account here."
          : null,
    });
  });

  router.add("POST", "/api/users/:id/password", "session", async (ctx) => {
    const actor = requireAdmin(ctx, "resetting a password is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    assertLocal(row, "the password");
    const body = await readJson<{ password?: string }>(ctx);
    // `mustChange` always: the admin who typed this password must not be able to keep using it,
    // and the user must not be left with one somebody else knows.
    await setPassword(ctx.app, row, body.password ?? "", { mustChange: true });
    const revoked = revokeSessionsOf(ctx.app.db, row.id);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "user.password-reset",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { sessionsRevoked: revoked },
    });
    return json({ id: row.id, mustChangePassword: true, sessionsRevoked: revoked });
  });

  router.add("DELETE", "/api/users/:id/sessions", "session", (ctx) => {
    const actor = requireAdmin(ctx, "signing somebody else out is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    const revoked = revokeSessionsOf(ctx.app.db, row.id);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "session.revoke",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { revoked, by: "admin" },
    });
    return json({ revoked });
  });

  // ---------------------------------------------------------------- membership

  router.add("PUT", "/api/users/:id/applications/:applicationId", "session", (ctx) => {
    const actor = requireAdmin(ctx, "granting application membership is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    const application = applicationOr404(ctx, ctx.params.applicationId!);
    grantMembership(ctx.app.db, row.id, application.id, "local", actor.id);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "user.application-grant",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { applicationId: application.id, applicationName: application.name },
    });
    return json({ memberships: membershipsOf(ctx.app.db, row.id) });
  });

  router.add("DELETE", "/api/users/:id/applications/:applicationId", "session", (ctx) => {
    const actor = requireAdmin(ctx, "revoking application membership is admin-only");
    const row = principalOr404(ctx.app.db, ctx.params.id!);
    const application = applicationOr404(ctx, ctx.params.applicationId!);
    const removed = revokeMembership(ctx.app.db, row.id, application.id);
    if (!removed) throw notFound(`${row.display_name} is not a member of ${application.name}`);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "user.application-revoke",
      subject: `user:${row.id}`,
      outcome: "ok",
      detail: { applicationId: application.id, applicationName: application.name },
    });
    return json({
      memberships: membershipsOf(ctx.app.db, row.id),
      /**
       * An `idp` membership removed here comes straight back at the next claim re-read, because
       * the directory is what says it exists. Saying so is the difference between a control that
       * works and one that appears to.
       */
      note:
        row.provider === "oidc" && application.source_group
          ? `${application.name} is mapped from the identity provider group "${application.source_group}". If ` +
            `${row.display_name} is still in that group, the membership returns at their next ` +
            "claim refresh. Remove them from the group instead."
          : null,
    });
  });

  // ---------------------------------------------------------------- applications

  router.add("GET", "/api/applications", "session", (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.app.db
      .query<{ id: string; name: string; source_group: string | null }, []>(
        "SELECT id, name, source_group FROM application ORDER BY name",
      )
      .all();
    const counts = memberCounts(ctx);
    const metadata = applicationMetadata(ctx.app);
    return json({
      items: rows.map((application) => ({
        id: application.id,
        name: application.name,
        mine: can(user, application.id),
        capabilities: can(user, application.id) ? ["read", "create", "update", "delete"] : ["read"],
        members: counts.get(application.id) ?? 0,
        /**
         * Quoted from LeanIX, and absent rather than blank when the lookup has not answered.
         * Every consumer of this treats it as decoration: nothing chooses, authorises or routes
         * on a business id this portal does not own.
         */
        leanixId: metadata.get(application.id)?.leanixId ?? null,
        /**
         * Admin-only `[P1-18]`. Application names are already a discovery surface, but which identity
         * provider group grants an application tells any signed-in user exactly which group to get
         * themselves added to in order to own another application's APIs. Absent, not blanked.
         */
        ...(user.isAdmin ? { sourceGroup: application.source_group } : {}),
      })),
    });
  });

  router.add("GET", "/api/applications/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const application = applicationOr404(ctx, ctx.params.id!);
    // Your own application's member list is yours to see; anybody else's is an admin question.
    if (!can(user, application.id)) requireAdmin(ctx, `${application.name} is not one of your applications`);
    const members = ctx.app.db
      .query<
        { user_id: string; source: string; granted_by: string | null; granted_at: string | null },
        [string]
      >(
        `SELECT m.user_id, m.source, m.granted_by, m.granted_at
           FROM membership m WHERE m.application_id = ?`,
      )
      .all(application.id);
    const names = displayNames(
      ctx.app.db,
      members.flatMap((m) => [m.user_id, m.granted_by ?? ""]),
    );
    return json({
      id: application.id,
      name: application.name,
      ...(user.isAdmin ? { sourceGroup: application.source_group } : {}),
      /** Quoted from LeanIX; `null` throughout when the lookup has not answered for it yet. */
      metadata: applicationMetadata(ctx.app).get(application.id) ?? {
        leanixId: null,
        description: null,
        ownerContact: null,
        simulated: false,
      },
      owns: ownedBy(ctx, application.id),
      members: members.map((m) => ({
        userId: m.user_id,
        displayName: names.get(m.user_id) ?? m.user_id,
        source: m.source,
        grantedBy: m.granted_by,
        grantedByName: m.granted_by ? (names.get(m.granted_by) ?? m.granted_by) : null,
        grantedAt: m.granted_at,
      })),
    });
  });

  router.add("POST", "/api/applications", "session", async (ctx) => {
    const actor = requireAdmin(ctx, "creating an application is admin-only");
    const body = await readJson<{ name?: string; sourceGroup?: string; id?: string }>(ctx);
    const name = (body.name ?? "").trim();
    if (name.length < 2 || name.length > 80) throw badRequest("name: 2–80 characters");
    const existing = ctx.app.db
      .query<{ id: string }, [string]>("SELECT id FROM application WHERE lower(name) = lower(?)")
      .get(name);
    if (existing) throw conflict(`an application called "${name}" already exists`);
    const sourceGroup = (body.sourceGroup ?? "").trim() || null;
    if (sourceGroup) assertSourceGroupFree(ctx, sourceGroup, null);

    const id = (body.id ?? "").trim() || newId("application");
    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(id)) {
      throw badRequest("id: lower-case letters, digits, hyphens and underscores, 2–48 characters");
    }
    if (ctx.app.db.query("SELECT id FROM application WHERE id = ?").get(id)) {
      throw conflict(`an application with id "${id}" already exists`);
    }
    ctx.app.db.run("INSERT INTO application (id, name, source_group) VALUES (?, ?, ?)", [
      id,
      name,
      sourceGroup,
    ]);
    // Ask LeanIX about it now rather than at the next boot, so the business id appears on the
    // picker within a poll of the application existing.
    ensureApplicationMetadata(ctx.app);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "application.create",
      subject: `application:${id}`,
      outcome: "ok",
      detail: { name, sourceGroup },
    });
    return json({ id, name, sourceGroup, members: 0, mine: true }, { status: 201 });
  });

  router.add("PATCH", "/api/applications/:id", "session", async (ctx) => {
    const actor = requireAdmin(ctx, "changing an application is admin-only");
    const application = applicationOr404(ctx, ctx.params.id!);
    const body = await readJson<{ name?: string; sourceGroup?: string | null }>(ctx);
    const changed: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name.length < 2 || name.length > 80) throw badRequest("name: 2–80 characters");
      const clash = ctx.app.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM application WHERE lower(name) = lower(?) AND id <> ?",
        )
        .get(name, application.id);
      if (clash) throw conflict(`another application is called "${name}"`);
      ctx.app.db.run("UPDATE application SET name = ? WHERE id = ?", [name, application.id]);
      changed.name = name;
    }
    if (body.sourceGroup !== undefined) {
      const value = (body.sourceGroup ?? "").trim() || null;
      if (value) assertSourceGroupFree(ctx, value, application.id);
      ctx.app.db.run("UPDATE application SET source_group = ? WHERE id = ?", [value, application.id]);
      changed.sourceGroup = value;
    }
    if (Object.keys(changed).length === 0) throw badRequest("nothing to change");
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "application.update",
      subject: `application:${application.id}`,
      outcome: "ok",
      detail: changed,
    });
    return json({ id: application.id, ...changed });
  });

  router.add("DELETE", "/api/applications/:id", "session", (ctx) => {
    const actor = requireAdmin(ctx, "deleting an application is admin-only");
    const application = applicationOr404(ctx, ctx.params.id!);
    const owns = ownedBy(ctx, application.id);
    const total = Object.values(owns).reduce((sum, n) => sum + n, 0);
    if (total > 0) {
      // Cascading an application delete through the resource graph would delete published APIs from a
      // screen about people. The refusal lists what is in the way, with counts.
      throw conflict(
        `${application.name} still owns ${owns.resources} API(s), ${owns.products} product(s) and ` +
          `${owns.subscriptions} subscription(s), ${owns.certificates} certificate(s) and ${owns.processes} process record(s). Move or withdraw those first — deleting an application ` +
          "must not be a way to delete published APIs.",
        { fix: { screen: "applications" }, owns },
      );
    }
    const members = memberCounts(ctx).get(application.id) ?? 0;
    ctx.app.db.run("DELETE FROM membership WHERE application_id = ?", [application.id]);
    // The lookup goes with what it describes. It carries a foreign key to the row about to
    // disappear, so leaving it behind would fail the integrity check on the next restart.
    ctx.app.db.run(
      `DELETE FROM integration_event WHERE application_id = ? AND ${OWN_METADATA_LOOKUP}`,
      [application.id, application.id],
    );
    ctx.app.db.run("DELETE FROM application WHERE id = ?", [application.id]);
    writeAudit(ctx.app.db, {
      actor: actor.id,
      action: "application.delete",
      subject: `application:${application.id}`,
      outcome: "ok",
      detail: { name: application.name, membersRemoved: members },
    });
    return json({ id: application.id, deleted: true, membersRemoved: members });
  });
}

// --------------------------------------------------------------------------- helpers

function roleFrom(raw: string | undefined): Role {
  if (raw === undefined) return "member";
  if (raw === "member" || raw === "admin") return raw;
  throw badRequest('role: expected "member" or "admin" — design §9 has exactly two');
}

interface ApplicationRow {
  id: string;
  name: string;
  source_group: string | null;
}

function applicationOr404(ctx: Ctx, id: string): ApplicationRow {
  const row = ctx.app.db
    .query<ApplicationRow, [string]>("SELECT id, name, source_group FROM application WHERE id = ?")
    .get(id);
  if (!row) throw notFound(`no application ${id}`);
  return row;
}

/**
 * One group cannot map to two applications: the mapping is a function, and two applications claiming one group
 * would make a user's application set depend on which row a query happened to return first.
 */
function assertSourceGroupFree(ctx: Ctx, sourceGroup: string, exceptApplicationId: string | null): void {
  const clash = ctx.app.db
    .query<{ id: string; name: string }, [string]>(
      "SELECT id, name FROM application WHERE lower(source_group) = lower(?)",
    )
    .get(sourceGroup);
  if (clash && clash.id !== exceptApplicationId) {
    throw conflict(
      `the group "${sourceGroup}" already maps to the application "${clash.name}". One group maps to one ` +
        "application, or a user's applications would depend on which row was read first.",
    );
  }
}

function applicationCounts(ctx: Ctx): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of ctx.app.db
    .query<{ user_id: string; n: number }, []>(
      "SELECT user_id, COUNT(*) AS n FROM membership GROUP BY user_id",
    )
    .all()) {
    out.set(row.user_id, row.n);
  }
  return out;
}

function memberCounts(ctx: Ctx): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of ctx.app.db
    .query<{ application_id: string; n: number }, []>(
      "SELECT application_id, COUNT(*) AS n FROM membership GROUP BY application_id",
    )
    .all()) {
    out.set(row.application_id, row.n);
  }
  return out;
}

/** What stands in the way of deleting an application, and what a member's access actually covers. */
function ownedBy(ctx: Ctx, applicationId: string): { resources: number; products: number; subscriptions: number; certificates: number; processes: number } {
  const count = (table: string): number =>
    ctx.app.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE application_id = ?`)
      .get(applicationId)!.n;
  return {
    resources: count("resource"),
    products: count("product"),
    subscriptions: count("subscription"),
    certificates: count("certificate"),
    processes:
      count("operation") +
      ctx.app.db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM integration_event
            WHERE application_id = ? AND NOT ${OWN_METADATA_LOOKUP}`,
        )
        .get(applicationId, applicationId)!.n +
      count("kafka_topic") +
      count("kafka_access") +
      count("kafka_message"),
  };
}

/**
 * The portal's own LeanIX lookup *about* the application being deleted.
 *
 * Every other integration event is work somebody started and somebody is waiting on, so it stands
 * in the way of a delete. This one the portal emitted on its own initiative the moment the
 * application existed, which would make every application permanently undeletable — a record about
 * a thing is not a reason to keep the thing.
 */
const OWN_METADATA_LOOKUP = "(integration = 'leanix' AND kind = 'metadata' AND subject = ?)";

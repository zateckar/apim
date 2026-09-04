import { writeAudit } from "../audit.ts";
import { capabilitiesFor, can } from "../auth.ts";
import { decrypt, encrypt, mintSubscriptionKey } from "../crypto.ts";
import { newId, nowIso } from "../db.ts";
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  readJson,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import type { User } from "../auth.ts";
import { assertCan, environmentOf, nextCursor, pageOf } from "./common.ts";

interface SubscriptionRow {
  id: string;
  product_id: string;
  application_id: string;
  environment: string;
  state: string;
  primary_key_enc: string;
  secondary_key_enc: string | null;
  key_rotated_at: string | null;
  created_at: string;
}

/**
 * A subscription as the two sides of it see it. Never carries key material — the keys come from
 * `/reveal` alone, which is consumer-only — so the same shape is safe to hand to a publisher.
 *
 * `viewerIs` is what makes the row readable rather than merely visible: the same subscription means
 * "our application calls their product" to one team and "their application calls our product" to
 * the other, and a list that did not say which is which would be a list of eight opaque rows.
 */
function subscriptionView(
  ctx: Ctx,
  row: SubscriptionRow,
  teams: { appTeam: string; productTeam: string },
  extra: object = {},
) {
  const asConsumer = can(ctx.user, teams.appTeam);
  return {
    id: row.id,
    productId: row.product_id,
    applicationId: row.application_id,
    environment: row.environment,
    state: row.state,
    keyRotatedAt: row.key_rotated_at,
    createdAt: row.created_at,
    viewerIs: asConsumer ? "consumer" : can(ctx.user, teams.productTeam) ? "publisher" : "other",
    // The consumer's own capabilities are the ordinary ones. A publisher gets `delete` and nothing
    // else: they may end the relationship, and may not reach into it and rotate somebody else's
    // key. `capabilitiesFor` cannot express that, because it answers about one team at a time.
    capabilities: asConsumer
      ? capabilitiesFor(ctx.user, teams.appTeam)
      : can(ctx.user, teams.productTeam)
        ? ["read", "delete"]
        : ["read"],
    ...extra,
  };
}

/**
 * A subscription plus the two teams that have a say in it: the one owning the **application** doing
 * the calling, and the one owning the **product** being called. They are usually different teams,
 * and the difference is the whole of `assertMayRevoke` below.
 */
type SubscriptionWithTeams = SubscriptionRow & {
  app_team: string;
  app_name: string;
  product_team: string;
  product_name: string;
};

function subscriptionOr404(ctx: Ctx, id: string): SubscriptionWithTeams {
  const row = ctx.app.db
    .query<SubscriptionWithTeams, [string]>(
      `SELECT s.*, a.team_id AS app_team, a.name AS app_name,
              p.team_id AS product_team, p.name AS product_name
         FROM subscription s
         JOIN application a ON a.id = s.application_id
         JOIN product p ON p.id = s.product_id
        WHERE s.id = ?`,
    )
    .get(id);
  if (!row) throw notFound(`no subscription ${id}`);
  return row;
}

/**
 * Who may end a subscription: the team whose application holds the keys, **or** the team whose
 * product is being called.
 *
 * The second half is the asymmetry, and it is deliberate. Withdrawing access is the publisher's
 * decision — an abusive or compromised consumer is the publisher's problem, and needing to find an
 * administrator to stop it makes the platform the bottleneck in exactly the moment it should not
 * be. Granting was already the publisher's decision, by putting the API in the product.
 *
 * It does **not** extend to the keys. Reveal and rotate stay consumer-only, because a publisher who
 * could rotate another team's key could break their caller silently at a moment of their choosing,
 * and would learn a credential that is not theirs. So the publisher may end the relationship and
 * may not reach inside it — which is the same shape as ending a subscription to anything else.
 */
function assertMayRevoke(user: User, row: SubscriptionWithTeams): void {
  if (can(user, row.app_team) || can(user, row.product_team)) return;
  throw forbidden(
    `you are in neither the team that owns ${row.app_name} nor the team that publishes ${row.product_name}`,
    { fix: { screen: "teams" } },
  );
}

export function registerCatalogRoutes(router: Router): void {
  // ---------------------------------------------------------------- products

  router.add("GET", "/api/products", "session", (ctx) => {
    const page = pageOf(ctx);
    const rows = ctx.app.db
      .query("SELECT * FROM product ORDER BY name LIMIT ? OFFSET ?")
      .all(page.limit, page.offset) as Array<{ id: string; name: string; team_id: string; lifecycle: string }>;
    return json({
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        teamId: p.team_id,
        lifecycle: p.lifecycle,
        members: ctx.app.db
          .query(
            `SELECT r.id, r.name FROM product_member pm JOIN resource r ON r.id = pm.resource_id
              WHERE pm.product_id = ? ORDER BY r.name`,
          )
          .all(p.id),
        capabilities: capabilitiesFor(ctx.user, p.team_id),
      })),
      nextCursor: nextCursor(page, rows.length),
    });
  });

  router.add("POST", "/api/products", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{ name?: string; teamId?: string; resourceIds?: string[] }>(ctx);
    if (!body.name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }
    const teamId = body.teamId ?? user.teams[0];
    assertCan(user, teamId, "create a product for this team");

    const id = newId("prod");
    try {
      ctx.app.db.run("INSERT INTO product (id, name, team_id, lifecycle) VALUES (?, ?, ?, 'active')", [
        id,
        body.name,
        teamId!,
      ]);
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw conflict(`a product named ${body.name} already exists`);
      throw err;
    }
    for (const resourceId of body.resourceIds ?? []) {
      const resource = ctx.app.db
        .query<{ team_id: string }, [string]>("SELECT team_id FROM resource WHERE id = ?")
        .get(resourceId);
      if (!resource) throw notFound(`no resource ${resourceId}`);
      assertCan(user, resource.team_id, `add ${resourceId} to a product`);
      ctx.app.db.run("INSERT INTO product_member (product_id, resource_id) VALUES (?, ?)", [id, resourceId]);
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "product.create",
      subject: `product:${id}`,
      outcome: "ok",
      detail: { name: body.name, members: body.resourceIds ?? [] },
    });
    return json({ id, name: body.name, teamId, members: body.resourceIds ?? [] }, { status: 201 });
  });

  router.add("PUT", "/api/products/:id/members", "session", async (ctx) => {
    const user = requireUser(ctx);
    const product = ctx.app.db
      .query<{ id: string; team_id: string }, [string]>("SELECT id, team_id FROM product WHERE id = ?")
      .get(ctx.params.id!);
    if (!product) throw notFound(`no product ${ctx.params.id}`);
    assertCan(user, product.team_id, "change this product's members");

    const body = await readJson<{ resourceIds?: string[] }>(ctx);
    const resourceIds = body.resourceIds ?? [];
    for (const resourceId of resourceIds) {
      const resource = ctx.app.db
        .query<{ team_id: string }, [string]>("SELECT team_id FROM resource WHERE id = ?")
        .get(resourceId);
      if (!resource) throw notFound(`no resource ${resourceId}`);
      assertCan(user, resource.team_id, `add ${resourceId} to a product`);
    }
    ctx.app.db.transaction(() => {
      ctx.app.db.run("DELETE FROM product_member WHERE product_id = ?", [product.id]);
      for (const resourceId of resourceIds) {
        ctx.app.db.run("INSERT INTO product_member (product_id, resource_id) VALUES (?, ?)", [
          product.id,
          resourceId,
        ]);
      }
    })();
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "product.members",
      subject: `product:${product.id}`,
      outcome: "ok",
      detail: { resourceIds },
    });
    return json({ id: product.id, resourceIds });
  });

  /**
   * A product with live subscriptions is a credential relationship, not just a row: deleting it
   * would turn every consumer's next call into a bare 404 with no explanation. So the delete
   * refuses and names the count, and revoking is an explicit act by whoever owns the application.
   */
  router.add("DELETE", "/api/products/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const product = ctx.app.db
      .query<{ id: string; name: string; team_id: string }, [string]>(
        "SELECT id, name, team_id FROM product WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!product) throw notFound(`no product ${ctx.params.id}`);
    assertCan(user, product.team_id, "delete this product");

    const active = ctx.app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM subscription WHERE product_id = ? AND state = 'active'",
      )
      .get(product.id)!.n;
    if (active > 0) {
      throw conflict(
        `${product.name} has ${active} active subscription(s); revoke them first, or their next ` +
          "call would become an unexplained 404",
      );
    }
    ctx.app.db.run("DELETE FROM product WHERE id = ?", [product.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "product.delete",
      subject: `product:${product.id}`,
      outcome: "ok",
      detail: { name: product.name },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------- applications

  router.add("GET", "/api/applications", "session", (ctx) => {
    const user = requireUser(ctx);
    const rows = (
      ctx.app.db.query("SELECT * FROM application ORDER BY name").all() as Array<{
        id: string;
        name: string;
        team_id: string;
        created_at: string;
      }>
    ).filter((a) => can(user, a.team_id));
    return json({
      items: rows.map((a) => ({
        id: a.id,
        name: a.name,
        teamId: a.team_id,
        createdAt: a.created_at,
        capabilities: capabilitiesFor(ctx.user, a.team_id),
      })),
    });
  });

  router.add("POST", "/api/applications", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{ name?: string; teamId?: string }>(ctx);
    if (!body.name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }
    const teamId = body.teamId ?? user.teams[0];
    assertCan(user, teamId, "create an application for this team");
    const id = newId("app");
    try {
      ctx.app.db.run("INSERT INTO application (id, name, team_id, created_at) VALUES (?, ?, ?, ?)", [
        id,
        body.name,
        teamId!,
        nowIso(),
      ]);
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw conflict(`an application named ${body.name} already exists`);
      throw err;
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "application.create",
      subject: `application:${id}`,
      outcome: "ok",
      detail: { name: body.name, teamId },
    });
    return json({ id, name: body.name, teamId }, { status: 201 });
  });

  // ---------------------------------------------------------------- subscriptions

  /** Same rule as a product: an application holding live credentials does not silently vanish. */
  router.add("DELETE", "/api/applications/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const application = ctx.app.db
      .query<{ id: string; name: string; team_id: string }, [string]>(
        "SELECT id, name, team_id FROM application WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!application) throw notFound(`no application ${ctx.params.id}`);
    assertCan(user, application.team_id, "delete this application");

    const active = ctx.app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM subscription WHERE application_id = ? AND state = 'active'",
      )
      .get(application.id)!.n;
    if (active > 0) {
      throw conflict(`${application.name} has ${active} active subscription(s); revoke them first`);
    }
    ctx.app.db.run("DELETE FROM application WHERE id = ?", [application.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "application.delete",
      subject: `application:${application.id}`,
      outcome: "ok",
      detail: { name: application.name },
    });
    return new Response(null, { status: 204 });
  });

  router.add("GET", "/api/subscriptions", "session", (ctx) => {
    const user = requireUser(ctx);
    const applicationId = ctx.url.searchParams.get("application");
    const productId = ctx.url.searchParams.get("product");
    let sql =
      `SELECT s.*, a.team_id AS app_team, a.name AS app_name,
              p.team_id AS product_team, p.name AS product_name
         FROM subscription s JOIN application a ON a.id = s.application_id
         JOIN product p ON p.id = s.product_id WHERE 1 = 1`;
    const args: unknown[] = [];
    if (applicationId) {
      sql += " AND s.application_id = ?";
      args.push(applicationId);
    }
    if (productId) {
      sql += " AND s.product_id = ?";
      args.push(productId);
    }
    sql += " ORDER BY s.created_at DESC";
    // A subscription is a credential relationship, not a discovery surface — but it has two sides,
    // and both of them are entitled to know it exists. You see the ones your team's applications
    // hold, and the ones somebody holds against your team's products. Never anybody else's, and in
    // neither case any key material: `/reveal` is what carries a key and it stays consumer-only.
    const rows = (
      ctx.app.db.query(sql).all(...(args as never[])) as Array<
        SubscriptionRow & {
          app_team: string;
          app_name: string;
          product_team: string;
          product_name: string;
        }
      >
    ).filter((row) => can(user, row.app_team) || can(user, row.product_team));
    return json({
      items: rows.map((row) =>
        subscriptionView(ctx, row, { appTeam: row.app_team, productTeam: row.product_team }, {
          applicationName: row.app_name,
          productName: row.product_name,
        }),
      ),
    });
  });

  router.add("POST", "/api/subscriptions", "session", async (ctx) => {
    const body = await readJson<{ productId?: string; applicationId?: string; environment?: string }>(ctx);
    return createSubscription(ctx, body);
  });

  registerSubscriptionRoutes(router);
}

/**
 * Creating a subscription, apart from the route that takes it, because the Catalog's Subscribe
 * dialog posts the same thing with the product in the path (plan section 11.2). One function, so
 * the two entry points cannot drift on which lifecycle states are subscribable.
 */
export function createSubscription(
  ctx: Ctx,
  body: { productId?: string; applicationId?: string; environment?: string },
): Response {
  const user = requireUser(ctx);
  const environment = body.environment ?? environmentOf(ctx);
  {
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }
    const product = ctx.app.db
      .query<{ id: string; name: string; lifecycle: string }, [string]>(
        "SELECT id, name, lifecycle FROM product WHERE id = ?",
      )
      .get(body.productId ?? "");
    if (!product) throw notFound(`no product ${body.productId}`);
    const application = ctx.app.db
      .query<{ id: string; name: string; team_id: string }, [string]>(
        "SELECT id, name, team_id FROM application WHERE id = ?",
      )
      .get(body.applicationId ?? "");
    if (!application) throw notFound(`no application ${body.applicationId}`);

    // Deviation D9: the design requires a second person to approve a subscription to another
    // team's product; approvals are out of the MVP, so owning the application is the whole check.
    assertCan(user, application.team_id, "subscribe this application");

    /*
     * Design section 4.2: `retired` blocks NEW subscriptions and leaves existing ones working.
     * The subscription unit is a product, not an API, so the rule is defined at the product
     * (review V1-06): refuse when the product itself is retired, or when nothing in it is both
     * published here and not retired. A partly retired product succeeds with a warning.
     */
    if (product.lifecycle === "retired") {
      throw conflict(`product ${product.name} is retired and does not take new subscriptions`);
    }
    const members = ctx.app.db
      .query<{ name: string; api_version: string; lifecycle: string; live: number }, [string, string]>(
        `SELECT r.name, r.api_version, r.lifecycle,
                (SELECT COUNT(*) FROM release rel
                  WHERE rel.resource_id = r.id AND rel.environment = ? AND rel.state = 'converged') AS live
           FROM product_member pm JOIN resource r ON r.id = pm.resource_id
          WHERE pm.product_id = ?`,
      )
      .all(environment, product.id);
    const usable = members.filter((m) => m.lifecycle !== "retired" && m.live > 0);
    if (usable.length === 0) {
      throw conflict(
        `product ${product.name} has no active published API in ${environment}` +
          (members.length === 0 ? " (it has no members)" : " (every member is retired or unpublished)"),
      );
    }
    const retired = members.filter((m) => m.lifecycle === "retired");
    const warnings = retired.map(
      (m) => `${m.name} ${m.api_version} is retired and will not accept new traffic patterns`,
    );

    const key = mintSubscriptionKey(environment);
    const id = newId("sub");
    try {
      ctx.app.db.run(
        `INSERT INTO subscription (id, product_id, application_id, environment, state, primary_key_enc, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [id, product.id, application.id, environment, encrypt(key, ctx.app.kek), nowIso()],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`${application.name} is already subscribed to ${product.name} in ${environment}`);
      }
      throw err;
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "subscription.create",
      subject: `subscription:${id}`,
      outcome: "ok",
      detail: { productId: product.id, applicationId: application.id, environment },
    });
    return json(
      {
        id,
        productId: product.id,
        applicationId: application.id,
        environment,
        state: "active",
        // Shown exactly once. It is recoverable through /reveal, which is audited.
        primaryKey: key,
        warnings,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }
}

/** The rest of a subscription's life: reveal, rotate, revoke — and the team list the UI needs. */
function registerSubscriptionRoutes(router: Router): void {
  router.add("POST", "/api/subscriptions/:id/reveal", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = subscriptionOr404(ctx, ctx.params.id!);
    assertCan(user, row.app_team, "reveal this subscription's keys");
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "subscription.reveal",
      subject: `subscription:${row.id}`,
      outcome: "ok",
    });
    return json(
      {
        id: row.id,
        primaryKey: decrypt(row.primary_key_enc, ctx.app.kek),
        secondaryKey: row.secondary_key_enc ? decrypt(row.secondary_key_enc, ctx.app.kek) : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });

  router.add("POST", "/api/subscriptions/:id/rotate", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = subscriptionOr404(ctx, ctx.params.id!);
    assertCan(user, row.app_team, "rotate this subscription's keys");
    const body = await readJson<{ which?: string }>(ctx);
    const which = body.which ?? "primary";
    if (which !== "primary" && which !== "secondary") {
      throw badRequest('which: expected "primary" or "secondary"');
    }
    const key = mintSubscriptionKey(row.environment);
    const column = which === "primary" ? "primary_key_enc" : "secondary_key_enc";
    ctx.app.db.run(`UPDATE subscription SET ${column} = ?, key_rotated_at = ? WHERE id = ?`, [
      encrypt(key, ctx.app.kek),
      nowIso(),
      row.id,
    ]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "subscription.rotate",
      subject: `subscription:${row.id}`,
      outcome: "ok",
      detail: { which },
    });
    return json({ id: row.id, which, key }, { headers: { "cache-control": "no-store" } });
  });

  router.add("DELETE", "/api/subscriptions/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = subscriptionOr404(ctx, ctx.params.id!);
    assertMayRevoke(user, row);
    ctx.app.db.run("UPDATE subscription SET state = 'revoked' WHERE id = ?", [row.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "subscription.revoke",
      subject: `subscription:${row.id}`,
      outcome: "ok",
      // Which side ended it, on the row. "Our key stopped working and nobody here did it" is the
      // question this answers, and it is only answerable if the audit says so at the time.
      detail: {
        by: can(user, row.app_team) ? "consumer" : "publisher",
        application: row.app_name,
        product: row.product_name,
      },
    });
    // Revocation fails closed at the next config poll (design section 8.5).
    return json({ id: row.id, state: "revoked" });
  });

  // `GET /api/teams` used to live here, next to the owner pickers that read it. Since v5 the teams
  // surface is a managed one — member counts, provenance, an admin-only `sourceGroup` — so it lives
  // with the rest of team management in `api/users.ts` rather than being answered twice.
}

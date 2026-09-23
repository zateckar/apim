import { UNIT_CATALOGUE } from "../../../shared/policy.ts";
import { RESOURCE_KINDS } from "../../../shared/types.ts";
import { gatewayUrlsFor } from "../config.ts";
import { displayNames } from "../principals.ts";
import { badRequest, json, requireAdmin, notFound, Router } from "../router.ts";
import { gatewayAddresses, gatewaysIn, instancesFor, publicGatewayUrl } from "./fleet.ts";

export function registerAdminRoutes(router: Router): void {
  /**
   * Everything the portal needs to render, and **session-scoped since v5** `[P1-01]`. It was
   * public because the sign-in screen read the development user list off it — and it carries every
   * gateway URL the playground may use, which is not something to hand an anonymous caller. The
   * sign-in screen now reads `GET /api/auth/providers` instead.
   */
  router.add("GET", "/api/meta", "session", (ctx) => {
    const all = instancesFor(ctx);
    const environments = ctx.app.config.promotionChain.map((environment) => {
      const instances = all.filter((i) => i.environment === environment);
      // Where a consumer calls this environment: the reverse proxy in front of the replicas. It
      // is one address however many replicas there are, and it is the one every URL in the portal
      // is built from.
      const publicUrl = publicGatewayUrl(ctx.app.db, environment);
      const replicas = gatewayUrlsFor(ctx.app.config, environment);
      return {
        environment,
        instances: instances.length,
        // What the UI multiplies a rate limit by: "calls x instances" (design section 5.7).
        liveInstances: instances.filter((i) => !i.stale && !i.revoked).length,
        publicUrl,
        /**
         * Where the playground may send a request here, and what a copyable `curl` addresses
         * (plan §11, review `[P2-07]`). An empty list means the console says the playground is
         * unavailable in this environment and names `TARGETS_FILE`.
         *
         * Individual replica addresses are administration, not documentation: a consumer given one
         * is holding a URL that stops working the next time the fleet is resized, and the proxy
         * exists precisely so nobody has to. So a member is offered the published address only.
         */
        gateways: ctx.user?.isAdmin
          ? replicas
          : publicUrl
            ? [{ label: environment, url: publicUrl }]
            : replicas,
        /**
         * The gateways an API can be published on here — the localities, not the replicas. Named
         * separately from `gateways` above, which is the playground's list of places to send a
         * request and has meant that since v4; renaming either would have broken the other.
         */
        localities: gatewaysIn(ctx.app.db, environment).map((t) => ({
          name: t.name,
          label: t.label,
          addresses: gatewayAddresses(t),
          paused: Boolean(t.paused),
        })),
      };
    });
    return json({
      environments,
      chain: ctx.app.config.promotionChain,
      kinds: RESOURCE_KINDS,
      policyUnits: UNIT_CATALOGUE,
      publicUrl: ctx.app.config.publicUrl,
      telemetryRetentionHours: ctx.app.config.telemetryRetentionHours,
      authProviders: ctx.app.config.authProviders,
    });
  });

  // ---------------------------------------------------------------- targets and fleet

  router.add("GET", "/api/targets", "session", (ctx) =>
    json({
      items: ctx.app.db
        .query(
          `SELECT id, environment, name, adapter, enforce, paused
             FROM target ORDER BY environment, name`,
        )
        .all(),
    }),
  );

  router.add("GET", "/api/jobs/:id", "session", (ctx) => {
    const row = ctx.app.db.query("SELECT * FROM job WHERE id = ?").get(ctx.params.id!);
    if (!row) throw notFound(`no job ${ctx.params.id}`);
    return json(row);
  });

  router.add("GET", "/api/audit", "session", (ctx) => {
    requireAdmin(ctx, "the audit log is admin-only");
    const limitRaw = ctx.url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw badRequest("limit: expected an integer between 1 and 500");
    }
    const items = ctx.app.db
      .query<{ actor: string }, [number]>("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?")
      .all(limit);
    // An id stopped being readable the moment a principal was not called `alice` `[P2-03]`. One
    // query for the page, and anything unresolved comes back as itself — an id whose principal is
    // gone is still the truthful answer to "who did this".
    const names = displayNames(
      ctx.app.db,
      items.map((row) => row.actor),
    );
    const subjects = subjectNames(
      ctx.app.db,
      items.map((row) => (row as { subject?: string }).subject ?? ""),
    );
    return json({
      items: items.map((row) => {
        const subject = (row as { subject?: string }).subject ?? "";
        return {
          ...row,
          actorName: names.get(row.actor) ?? row.actor,
          subjectName: subjects.get(subject) ?? null,
        };
      }),
    });
  });
}

/**
 * The subject's name, for the kinds a reader can go and look at — `platform-administration`,
 * *Make audit events easy to scan*. The same reasoning as `actorName` `[P2-03]`: `resource:res_8f2…`
 * answers "what was changed" for nobody. One query per kind for the page, and a subject whose row is
 * gone (or whose kind has no name, like `environment:prod`) resolves to nothing, so the screen shows
 * the stored id rather than a name that is no longer true.
 */
function subjectNames(db: Parameters<typeof displayNames>[0], subjects: string[]): Map<string, string> {
  const byKind = new Map<string, Set<string>>();
  for (const subject of subjects) {
    const at = subject.indexOf(":");
    if (at <= 0) continue;
    const kind = subject.slice(0, at);
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind)!.add(subject.slice(at + 1));
  }
  const out = new Map<string, string>();
  const lookup = (kind: string, sql: (placeholders: string) => string) => {
    const ids = [...(byKind.get(kind) ?? [])];
    if (ids.length === 0) return;
    const rows = db
      .query<{ id: string; name: string }, string[]>(sql(ids.map(() => "?").join(",")))
      .all(...ids);
    for (const row of rows) out.set(`${kind}:${row.id}`, row.name);
  };
  lookup("resource", (p) => `SELECT id, name || ' ' || api_version AS name FROM resource WHERE id IN (${p})`);
  lookup("application", (p) => `SELECT id, name FROM application WHERE id IN (${p})`);
  lookup("product", (p) => `SELECT id, name FROM product WHERE id IN (${p})`);
  const users = [...(byKind.get("user") ?? [])];
  if (users.length > 0) {
    // `displayNames` answers an unknown id with the id itself; only a real name is a name here.
    for (const [id, name] of displayNames(db, users)) if (name !== id) out.set(`user:${id}`, name);
  }
  return out;
}

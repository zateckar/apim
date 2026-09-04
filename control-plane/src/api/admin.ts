import { UNIT_CATALOGUE } from "../../../shared/policy.ts";
import { RESOURCE_KINDS } from "../../../shared/types.ts";
import { gatewayUrlsFor } from "../config.ts";
import { displayNames } from "../principals.ts";
import { badRequest, json, requireAdmin, notFound, Router } from "../router.ts";
import { instancesFor } from "./fleet.ts";

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
      return {
        environment,
        instances: instances.length,
        // What the UI multiplies a rate limit by: "calls x instances" (design section 5.7).
        liveInstances: instances.filter((i) => !i.stale && !i.revoked).length,
        /**
         * Where the playground may send a request here, and what a copyable `curl` addresses
         * (plan §11, review `[P2-07]`). Admin configuration, not a secret. An empty list means the
         * console says the playground is unavailable in this environment and names `TARGETS_FILE`.
         */
        gateways: gatewayUrlsFor(ctx.app.config, environment),
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
        .query("SELECT id, environment, adapter, enforce, paused FROM target ORDER BY environment, adapter")
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
    return json({
      items: items.map((row) => ({ ...row, actorName: names.get(row.actor) ?? row.actor })),
    });
  });
}

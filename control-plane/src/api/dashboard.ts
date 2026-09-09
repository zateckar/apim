import { buildDashboard } from "../dashboard.ts";
import { badRequest, forbidden, notFound, json, requireUser, Router } from "../router.ts";

/**
 * `GET /api/dashboard?environment=all|dev|test|prod&sinceMin=…` (G2, plan §6.1).
 *
 * `sinceMin` rather than a second vocabulary of window names, because that is what
 * `/api/telemetry/*` already takes `[P1-14]`. Past the ceiling it is a `400` naming the ceiling —
 * never a silent clamp, which would answer a question nobody asked (design §11, `[P2-11]`).
 */
export function registerDashboardRoutes(router: Router): void {
  router.add("GET", "/api/dashboard", "session", (ctx) => {
    const user = requireUser(ctx);
    const applicationId = ctx.url.searchParams.get("applicationId") ?? undefined;
    if (applicationId) {
      if (!user.isAdmin && !user.applications.includes(applicationId)) throw forbidden("Select an application you belong to");
      if (!ctx.app.db.query("SELECT id FROM application WHERE id = ?").get(applicationId)) throw notFound("No such application");
    }
    const chain = ctx.app.config.promotionChain;

    const environment = ctx.url.searchParams.get("environment") ?? "all";
    if (environment !== "all" && !chain.includes(environment)) {
      throw badRequest(
        `unknown environment "${environment}" (expected "all" or one of ${chain.join(", ")})`,
      );
    }

    const ceiling = ctx.app.config.telemetryRetentionHours * 60;
    const raw = ctx.url.searchParams.get("sinceMin");
    const sinceMin = raw ? Number(raw) : Math.min(ctx.app.config.dashboardDefaultSinceMin, ceiling);
    if (!Number.isInteger(sinceMin) || sinceMin < 1 || sinceMin > ceiling) {
      throw badRequest(
        `sinceMin: expected an integer between 1 and ${ceiling} — TELEMETRY_RETENTION_HOURS is ` +
          `${ctx.app.config.telemetryRetentionHours}, so there is nothing older than that to read`,
      );
    }

    return json(buildDashboard(ctx, { environment, sinceMin, applicationId }));
  });
}

/**
 * Gateway settings — read by anybody, written by an administrator (the one authorization rule).
 *
 * Two endpoints only. The `GET` carries the whole model: the setting table, every stored override,
 * and what each layer resolves to — so the settings screen renders inheritance without a second
 * call per gateway, and so "what is PROD actually running" is one request rather than a walk over
 * compose files.
 */
import {
  GATEWAY_SETTING_DEFS,
  resolveGatewaySettingSources,
  SETTING_SCOPES,
  type SettingScope,
  type SettingValue,
} from "../../../shared/gateway-settings.ts";
import { badRequest, json, readJson, requireAdmin, Router } from "../router.ts";
import {
  listSettingOverrides,
  readSettingOverrides,
  writeSettingOverrides,
} from "../settings.ts";
import { gatewaysIn } from "./fleet.ts";

export function registerSettingsRoutes(router: Router): void {
  router.add("GET", "/api/gateway-settings", "session", (ctx) => {
    const overrides = readSettingOverrides(ctx.app.db);
    const environments = ctx.app.config.promotionChain;
    const gateways = environments.flatMap((environment) =>
      gatewaysIn(ctx.app.db, environment).map((target) => ({
        id: target.id,
        environment,
        name: target.name,
        label: target.label,
        category: target.category,
      })),
    );
    return json({
      defs: GATEWAY_SETTING_DEFS,
      scopes: SETTING_SCOPES,
      environments,
      gateways,
      overrides: listSettingOverrides(ctx.app.db),
      /**
       * What each layer resolves to, with the scope each value came from. The fleet entry is
       * resolved against no environment and no gateway, which is exactly what "the fleet's own
       * value" means; an environment's is what a gateway there with no overrides of its own gets.
       */
      effective: {
        fleet: resolveGatewaySettingSources(overrides, { environment: "", targetId: "" }),
        environments: Object.fromEntries(
          environments.map((environment) => [
            environment,
            resolveGatewaySettingSources(overrides, { environment, targetId: "" }),
          ]),
        ),
        gateways: Object.fromEntries(
          gateways.map((gateway) => [
            gateway.id,
            resolveGatewaySettingSources(overrides, {
              environment: gateway.environment,
              targetId: gateway.id,
            }),
          ]),
        ),
      },
    });
  });

  router.add("PATCH", "/api/gateway-settings", "session", async (ctx) => {
    const user = requireAdmin(ctx, "changing gateway settings is admin-only");
    const body = await readJson<{
      scope?: string;
      scopeId?: string | null;
      values?: Record<string, SettingValue | null>;
    }>(ctx);
    const scope = String(body.scope ?? "");
    if (!(SETTING_SCOPES as readonly string[]).includes(scope)) {
      throw badRequest(`scope: expected one of ${SETTING_SCOPES.join(", ")}`);
    }
    if (body.values === undefined || body.values === null || typeof body.values !== "object") {
      throw badRequest("values: expected an object of setting names to values, or null to inherit");
    }
    try {
      const result = writeSettingOverrides(
        ctx.app.db,
        {
          scope: scope as SettingScope,
          scopeId: String(body.scopeId ?? ""),
          values: body.values,
        },
        user.id,
        ctx.app.config.promotionChain,
      );
      // No job and no operation: the next poll from every affected replica carries a document with
      // a new digest, and convergence is already tracked by digest. What this returns is what
      // changed, and the fleet view answers whether it arrived.
      return json(result);
    } catch (err) {
      // The store refuses with the message the administrator needs to read — the setting, the
      // variable it replaces and the bound — so it is passed through rather than summarised.
      throw badRequest((err as Error).message);
    }
  });
}

import { writeAudit } from "../audit.ts";
import { buildConfig } from "../config-build.ts";
import { hashToken, mintInstanceToken } from "../crypto.ts";
import { newId, nowIso, type DB } from "../db.ts";
import {
  badRequest,
  conflict,
  json,
  notFound,
  readJson,
  requireAdmin,
  Router,
  type Ctx,
} from "../router.ts";

/**
 * The fleet (plan G3). Design section 8.5 keys the poll on `gateway_instance`, so "more
 * gateways" is more rows in that table plus one process each — no new concept.
 *
 * An instance token is a long-lived credential: minted admin-only, shown once, revocable, and
 * capped per target so the telemetry row bound stays arithmetic rather than a hope.
 */
export interface InstanceView {
  id: string;
  name: string;
  environment: string;
  configDigest: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  stale: boolean;
  process: Record<string, unknown> | null;
}

export function instancesFor(ctx: Ctx, environment?: string): InstanceView[] {
  const staleAfterMs = ctx.app.config.instanceStaleAfterSec * 1000;
  const rows = ctx.app.db
    .query<
      {
        id: string;
        name: string;
        environment: string;
        config_digest: string | null;
        last_seen_at: string | null;
        revoked_at: string | null;
        process_json: string | null;
      },
      never[]
    >(
      `SELECT gi.id, gi.name, t.environment, gi.config_digest, gi.last_seen_at, gi.revoked_at,
              gi.process_json
         FROM gateway_instance gi JOIN target t ON t.id = gi.target_id
        ${environment ? "WHERE t.environment = ?" : ""}
        ORDER BY t.environment, gi.name`,
    )
    .all(...((environment ? [environment] : []) as never[]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    environment: row.environment,
    configDigest: row.config_digest,
    lastSeenAt: row.last_seen_at,
    revoked: Boolean(row.revoked_at),
    stale: !row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > staleAfterMs,
    process: row.process_json ? (JSON.parse(row.process_json) as Record<string, unknown>) : null,
  }));
}

interface TargetRow {
  id: string;
  adapter: string;
  enforce: number;
  paused: number;
  public_url: string | null;
  label: string | null;
}

const TARGET_COLUMNS = "id, adapter, enforce, paused, public_url, label";

function findTarget(ctx: Ctx, environment: string): TargetRow | null {
  return (
    ctx.app.db
      .query<TargetRow, [string]>(
        `SELECT ${TARGET_COLUMNS} FROM target WHERE environment = ? AND adapter = 'standalone'`,
      )
      .get(environment) ?? null
  );
}

function targetFor(ctx: Ctx, environment: string): TargetRow {
  const target = findTarget(ctx, environment);
  if (!target) throw notFound(`no standalone target for ${environment}`);
  return target;
}

/**
 * The hostname a consumer is given, which is the reverse proxy's and never a replica's.
 *
 * A gateway in one environment and one locality runs as several replicas behind a TLS-terminating
 * L7 proxy. The replicas are an operational fact — admins mint their tokens and watch them
 * converge — and a consumer who learned one of their addresses would be holding a URL that stops
 * working the next time the fleet is resized. So exactly one address is published, and it is this
 * one.
 */
export function publicGatewayUrl(db: DB, environment: string): string | null {
  const url =
    db
      .query<{ public_url: string | null }, [string]>(
        "SELECT public_url FROM target WHERE environment = ? AND adapter = 'standalone'",
      )
      .get(environment)?.public_url ?? null;
  return url ? url.replace(/\/+$/, "") : null;
}

/** Reject anything that is not an origin with an optional path prefix. */
function readPublicUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw badRequest("publicUrl: expected an absolute http or https URL, e.g. https://api.example");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("publicUrl: expected http or https");
  }
  if (url.search || url.hash) {
    throw badRequest("publicUrl: an origin with an optional path prefix, no query string");
  }
  return url.href.replace(/\/+$/, "");
}

function gatewayView(ctx: Ctx, environment: string, target: TargetRow | null) {
  const instances = target ? instancesFor(ctx, environment) : [];
  const live = instances.filter((i) => !i.stale && !i.revoked);
  return {
    environment,
    exists: Boolean(target),
    id: target?.id ?? null,
    adapter: target?.adapter ?? null,
    label: target?.label ?? null,
    publicUrl: target?.public_url ?? null,
    enforce: target ? Boolean(target.enforce) : false,
    paused: target ? Boolean(target.paused) : false,
    replicas: instances.length,
    liveReplicas: live.length,
    maxReplicas: ctx.app.config.maxInstancesPerTarget,
  };
}

export function registerFleetRoutes(router: Router): void {
  /** The chain, its targets and its gateways in one call — what the environment switcher reads. */
  router.add("GET", "/api/environments", "session", (ctx) => {
    const instances = instancesFor(ctx);
    return json({
      chain: ctx.app.config.promotionChain,
      items: ctx.app.config.promotionChain.map((environment) => {
        const target = findTarget(ctx, environment);
        const mine = instances.filter((i) => i.environment === environment);
        const live = mine.filter((i) => !i.stale && !i.revoked);
        return {
          environment,
          hasTarget: Boolean(target),
          enforce: target ? Boolean(target.enforce) : false,
          paused: target ? Boolean(target.paused) : false,
          instances: mine.length,
          liveInstances: live.length,
          maxInstances: ctx.app.config.maxInstancesPerTarget,
          // The proxy in front of the replicas — the only gateway address a consumer is given.
          publicUrl: target?.public_url ?? null,
          label: target?.label ?? null,
        };
      }),
    });
  });

  router.add("GET", "/api/targets/:environment/instances", "session", (ctx) =>
    json({ items: instancesFor(ctx, ctx.params.environment!) }),
  );

  router.add("POST", "/api/targets/:environment/instances", "session", async (ctx) => {
    const user = requireAdmin(ctx, "minting a gateway instance token is admin-only");
    const environment = ctx.params.environment!;
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw notFound(`unknown environment "${environment}"`);
    }
    const target = targetFor(ctx, environment);

    const body = await readJson<{ name?: string }>(ctx);
    const name = (body.name ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      throw badRequest('name: expected lower-case letters, digits and hyphens, e.g. "dev-2"');
    }

    const live = ctx.app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM gateway_instance WHERE target_id = ? AND revoked_at IS NULL",
      )
      .get(target.id)!.n;
    if (live >= ctx.app.config.maxInstancesPerTarget) {
      throw conflict(
        `${environment} already has ${live} live instances (MAX_INSTANCES_PER_TARGET is ` +
          `${ctx.app.config.maxInstancesPerTarget}); revoke one first`,
      );
    }
    const clash = ctx.app.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM gateway_instance WHERE target_id = ? AND name = ? AND revoked_at IS NULL",
      )
      .get(target.id, name);
    if (clash) throw conflict(`an instance named "${name}" already exists in ${environment}`);

    const token = mintInstanceToken();
    const id = newId("gwi");
    ctx.app.db.run(
      `INSERT INTO gateway_instance (id, target_id, name, token_hash, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, target.id, name, hashToken(token), nowIso(), user.id],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "instance.mint",
      subject: `instance:${id}`,
      outcome: "ok",
      detail: { environment, name },
    });
    // Shown exactly once: only the hash is stored, so it cannot be recovered.
    return json({ id, name, environment, token }, { status: 201, headers: { "cache-control": "no-store" } });
  });

  router.add("DELETE", "/api/instances/:id", "session", (ctx) => {
    const user = requireAdmin(ctx, "revoking a gateway instance is admin-only");
    const id = ctx.params.id!;
    const row = ctx.app.db
      .query<{ id: string; name: string }, [string]>(
        "SELECT id, name FROM gateway_instance WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound(`no gateway instance ${id}`);

    ctx.app.db.run("UPDATE gateway_instance SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "instance.revoke",
      subject: `instance:${id}`,
      outcome: "ok",
      detail: { name: row.name },
    });
    // Design section 8.5: revocation fails closed, at that instance's next poll and no sooner.
    return json({ id, revoked: true, effective: "at that instance's next poll" });
  });

  // ------------------------------------------------------------------ gateway management
  //
  // Adding and removing a gateway is not the same question as "is it healthy", and merging the two
  // made the second screen answer neither: `/health` grew a token minter and the estate had no
  // page that said which gateways exist, where they are published, and what the proxy in front of
  // them is called. These four endpoints are that page's API; `/health` keeps only health.

  router.add("GET", "/api/gateways", "session", (ctx) => {
    requireAdmin(ctx, "gateway management is admin-only");
    return json({
      items: ctx.app.config.promotionChain.map((environment) =>
        gatewayView(ctx, environment, findTarget(ctx, environment)),
      ),
    });
  });

  /** One gateway per environment, so this creates the missing one rather than taking a name. */
  router.add("POST", "/api/gateways", "session", async (ctx) => {
    const user = requireAdmin(ctx, "creating a gateway is admin-only");
    const body = await readJson<{ environment?: string; label?: string; publicUrl?: string }>(ctx);
    const environment = String(body.environment ?? "");
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(
        `environment: expected one of ${ctx.app.config.promotionChain.join(", ")}`,
      );
    }
    if (findTarget(ctx, environment)) {
      throw conflict(
        `${environment} already has a gateway; edit it instead. One gateway per environment is ` +
          "what the promotion chain means — its replicas are behind it, not beside it",
      );
    }
    const publicUrl = readPublicUrl(body.publicUrl);
    const id = newId("tgt");
    ctx.app.db.run(
      `INSERT INTO target (id, environment, adapter, config_json, enforce, paused, public_url, label)
       VALUES (?, ?, 'standalone', '{}', 1, 0, ?, ?)`,
      [id, environment, publicUrl, (body.label ?? "").trim() || null],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.create",
      subject: `target:${id}`,
      outcome: "ok",
      detail: { environment, publicUrl, label: body.label ?? null },
    });
    return json(gatewayView(ctx, environment, findTarget(ctx, environment)), { status: 201 });
  });

  router.add("PATCH", "/api/gateways/:environment", "session", async (ctx) => {
    const user = requireAdmin(ctx, "changing a gateway is admin-only");
    const environment = ctx.params.environment!;
    const target = targetFor(ctx, environment);
    const body = await readJson<{
      label?: string | null;
      publicUrl?: string | null;
      paused?: boolean;
    }>(ctx);
    const publicUrl =
      body.publicUrl === undefined ? target.public_url : readPublicUrl(body.publicUrl);
    const label =
      body.label === undefined ? target.label : (String(body.label ?? "").trim() || null);
    const paused = body.paused === undefined ? Boolean(target.paused) : Boolean(body.paused);
    ctx.app.db.run("UPDATE target SET public_url = ?, label = ?, paused = ? WHERE id = ?", [
      publicUrl,
      label,
      paused ? 1 : 0,
      target.id,
    ]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.update",
      subject: `target:${target.id}`,
      outcome: "ok",
      detail: { environment, publicUrl, label, paused },
    });
    return json(gatewayView(ctx, environment, findTarget(ctx, environment)));
  });

  /**
   * Removing a gateway removes the environment's ability to serve anything, so it is refused
   * while a replica is still live: an admin who meant "retire this locality" would otherwise take
   * every route in the environment offline and find out from a consumer.
   */
  router.add("DELETE", "/api/gateways/:environment", "session", (ctx) => {
    const user = requireAdmin(ctx, "removing a gateway is admin-only");
    const environment = ctx.params.environment!;
    const target = targetFor(ctx, environment);
    const live = instancesFor(ctx, environment).filter((i) => !i.revoked);
    if (live.length > 0) {
      throw conflict(
        `${environment} still has ${live.length} un-revoked replica${live.length === 1 ? "" : "s"} ` +
          `(${live.map((i) => i.name).join(", ")}); revoke them first`,
      );
    }
    const routes = ctx.app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM route WHERE environment = ?")
      .get(environment)!.n;
    if (routes > 0) {
      throw conflict(
        `${environment} still serves ${routes} route${routes === 1 ? "" : "s"}; withdraw them ` +
          "before removing the gateway they answer on",
      );
    }
    ctx.app.db.run("DELETE FROM target WHERE id = ?", [target.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.delete",
      subject: `target:${target.id}`,
      outcome: "ok",
      detail: { environment },
    });
    return json({ environment, removed: true });
  });

  /** What the demo and the UI wait on: every live instance reports the current digest. */
  router.add("GET", "/api/targets/:environment/health", "session", (ctx) => {
    const environment = ctx.params.environment!;
    targetFor(ctx, environment);
    return json(healthFor(ctx, environment)!);
  });
}

/**
 * One environment's health. Shared with the dashboard rather than recomputed there (plan §6.2), so
 * "in sync" cannot mean two things on two screens. `null` when the environment has no target at
 * all — the endpoint turns that into a 404, and the dashboard reports the environment as unset.
 */
export function healthFor(ctx: Ctx, environment: string) {
  const target = findTarget(ctx, environment);
  if (!target) return null;

  const config = buildConfig(ctx.app.db, ctx.app.kek, environment, ctx.app.config.integrations);
  const instances = instancesFor(ctx, environment);
  const live = instances.filter((i) => !i.stale && !i.revoked);
  // Every replica that has not been revoked is still part of this gateway, whether or not it is
  // answering. Counting only the live ones let a killed replica *improve* the headline — the
  // instance that fell behind dropped out of the denominator and the environment started reading
  // "in sync" while a row underneath it read `behind` (finding 10).
  const expected = instances.filter((i) => !i.revoked);
  const behind = expected.filter((i) => i.stale || i.configDigest !== config.digest);
  return {
    environment,
    adapter: target.adapter,
    label: target.label,
    publicUrl: target.public_url,
    enforce: Boolean(target.enforce),
    paused: Boolean(target.paused),
    configDigest: config.digest,
    routes: config.routes.length,
    subscriptions: config.subscriptions.length,
    trustAnchors: config.trustAnchors.length,
    configErrors: config.errors.length,
    /** Which routes, and why — the fleet screen's "what is this environment not serving". */
    errors: config.errors,
    instances,
    liveInstances: live.length,
    /** Replicas that are expected to be serving: everything not revoked. */
    expectedInstances: expected.length,
    /** Of those, the ones on an older digest or not reporting at all. */
    behindInstances: behind.length,
    // An instance reports the digest it has *activated*, so this becomes true one poll after the
    // config changed. That lag is design section 8.7's intent, not a defect.
    inSync: expected.length > 0 && behind.length === 0,
    staleAfterSec: ctx.app.config.instanceStaleAfterSec,
  };
}

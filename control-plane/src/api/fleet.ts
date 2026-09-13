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
  type App,
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
  /** Which of the environment's gateways this replica belongs to. */
  gateway: string;
  targetId: string;
  configDigest: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  stale: boolean;
  process: Record<string, unknown> | null;
}

export function instancesFor(ctx: Ctx, environment?: string): InstanceView[] {
  return instancesOf(ctx.app, environment);
}

/**
 * The same list, asked of the application rather than of a request.
 *
 * The uptime monitor runs on a timer and has no `Ctx` to hand: it is not serving anybody. Rather
 * than fabricating one, the query lives here and `instancesFor` is the request-shaped wrapper —
 * so "which replicas are live and what are they serving" has exactly one implementation.
 */
export function instancesOf(app: App, environment?: string): InstanceView[] {
  const staleAfterMs = app.config.instanceStaleAfterSec * 1000;
  const rows = app.db
    .query<
      {
        id: string;
        name: string;
        environment: string;
        gateway: string;
        target_id: string;
        config_digest: string | null;
        last_seen_at: string | null;
        revoked_at: string | null;
        process_json: string | null;
      },
      never[]
    >(
      `SELECT gi.id, gi.name, t.environment, t.name AS gateway, gi.target_id,
              gi.config_digest, gi.last_seen_at, gi.revoked_at, gi.process_json
         FROM gateway_instance gi JOIN target t ON t.id = gi.target_id
        ${environment ? "WHERE t.environment = ?" : ""}
        ORDER BY t.environment, t.name, gi.name`,
    )
    .all(...((environment ? [environment] : []) as never[]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    environment: row.environment,
    gateway: row.gateway,
    targetId: row.target_id,
    configDigest: row.config_digest,
    lastSeenAt: row.last_seen_at,
    revoked: Boolean(row.revoked_at),
    stale: !row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > staleAfterMs,
    process: row.process_json ? (JSON.parse(row.process_json) as Record<string, unknown>) : null,
  }));
}

export interface TargetRow {
  id: string;
  environment: string;
  name: string;
  adapter: string;
  enforce: number;
  paused: number;
  public_url: string | null;
  intranet_url: string | null;
  label: string | null;
}

const TARGET_COLUMNS =
  "id, environment, name, adapter, enforce, paused, public_url, intranet_url, label";

/**
 * Every gateway in an environment, alphabetically by name.
 *
 * The order used to be a taxonomy first — managed, then on-premise, then everything else — which
 * was the only thing a gateway's `category` ever reached. The column is gone (schema-012) and the
 * name is enough: it is stable, it is the identity a publish travels under, and a list ordered by
 * it reads the same on every screen.
 */
export function gatewaysIn(db: DB, environment: string): TargetRow[] {
  return db
    .query<TargetRow, [string]>(
      `SELECT ${TARGET_COLUMNS} FROM target WHERE environment = ? ORDER BY name`,
    )
    .all(environment);
}

function findTarget(ctx: Ctx, environment: string): TargetRow | null {
  return gatewaysIn(ctx.app.db, environment)[0] ?? null;
}

function gatewayIn(ctx: Ctx, environment: string, name: string): TargetRow {
  const row = ctx.app.db
    .query<TargetRow, [string, string]>(
      `SELECT ${TARGET_COLUMNS} FROM target WHERE environment = ? AND name = ?`,
    )
    .get(environment, name);
  if (!row) throw notFound(`no gateway "${name}" in ${environment}`);
  return row;
}

function targetFor(ctx: Ctx, environment: string): TargetRow {
  const target = findTarget(ctx, environment);
  if (!target) throw notFound(`no gateway for ${environment}`);
  return target;
}

/** Strip the trailing slash so a URL and a base path never join into a double one. */
function trimUrl(url: string | null): string | null {
  return url ? url.replace(/\/+$/, "") : null;
}

/**
 * Both addresses a gateway answers on, in the shape the portal shows them.
 *
 * One on-premise deployment commonly has two DNS names — one resolvable from the internet, one
 * only from inside — and they are two addresses for one gateway rather than two gateways. So both
 * appear against the same row, badged, and publishing binds to the gateway.
 */
export function gatewayAddresses(target: {
  public_url: string | null;
  intranet_url: string | null;
}): Array<{ network: "internet" | "intranet"; url: string }> {
  const out: Array<{ network: "internet" | "intranet"; url: string }> = [];
  const internet = trimUrl(target.public_url);
  const intranet = trimUrl(target.intranet_url);
  if (internet) out.push({ network: "internet", url: internet });
  if (intranet) out.push({ network: "intranet", url: intranet });
  return out;
}

/**
 * The hostname a consumer is given, which is the reverse proxy's and never a replica's.
 *
 * A gateway in one environment and one locality runs as several replicas behind a TLS-terminating
 * L7 proxy. The replicas are an operational fact — admins mint their tokens and watch them
 * converge — and a consumer who learned one of their addresses would be holding a URL that stops
 * working the next time the fleet is resized. So a replica's address is never published.
 *
 * Where an environment has several gateways this returns the first one's, which is what a caller
 * with nothing else to go on should try; anything that knows *which* API it is asking about should
 * use `publishedUrlsFor` instead and get every address the API is actually reachable at.
 */
export function publicGatewayUrl(db: DB, environment: string): string | null {
  for (const target of gatewaysIn(db, environment)) {
    const first = gatewayAddresses(target)[0];
    if (first) return first.url;
  }
  return null;
}

/**
 * Where one API answers in one environment: every address of every gateway it is published on,
 * with the base path already appended. This is the list the Properties screen shows, and the
 * reason a URL there is worth trusting — it is derived from the binding rows the fleet is served
 * from, not from a hostname somebody typed beside the API.
 */
export function publishedUrlsFor(
  db: DB,
  resourceId: string,
  environment: string,
): Array<{ gateway: string; label: string | null; network: "internet" | "intranet"; url: string }> {
  const route = db
    .query<{ base_path: string }, [string, string]>(
      "SELECT base_path FROM route WHERE resource_id = ? AND environment = ?",
    )
    .get(resourceId, environment);
  if (!route) return [];
  const targets = db
    .query<TargetRow, [string, string]>(
      `SELECT ${TARGET_COLUMNS.split(", ")
        .map((c) => `t.${c}`)
        .join(", ")}
         FROM route_gateway rg JOIN target t ON t.id = rg.target_id
        WHERE rg.resource_id = ? AND rg.environment = ?
        ORDER BY t.name`,
    )
    .all(resourceId, environment);
  return targets.flatMap((target) =>
    gatewayAddresses(target).map((address) => ({
      gateway: target.name,
      label: target.label,
      network: address.network,
      url: `${address.url}${route.base_path}`,
    })),
  );
}

/**
 * Turn the gateway *names* a publish carried into this environment's target ids.
 *
 * Names rather than ids because a publish travels: "published on `managed` and `onprem`" has to
 * still mean something in TEST, and a DEV target id means nothing there. A name that does not
 * exist in the destination is refused rather than dropped — silently publishing on fewer gateways
 * than were asked for is how an API goes missing in one locality and nobody finds out.
 */
export function resolveGateways(
  db: DB,
  environment: string,
  names: string[],
): { ids: string[]; missing: string[] } {
  const known = new Map(gatewaysIn(db, environment).map((t) => [t.name, t.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const id = known.get(name);
    if (id) ids.push(id);
    else missing.push(name);
  }
  return { ids, missing };
}

/** Which gateways an API is currently published on in an environment, by name. */
export function boundGatewayNames(db: DB, resourceId: string, environment: string): string[] {
  return db
    .query<{ name: string }, [string, string]>(
      `SELECT t.name FROM route_gateway rg JOIN target t ON t.id = rg.target_id
        WHERE rg.resource_id = ? AND rg.environment = ? ORDER BY t.name`,
    )
    .all(resourceId, environment)
    .map((r) => r.name);
}

/** Reject anything that is not an origin with an optional path prefix. */
function readPublicUrl(value: unknown, field = "publicUrl"): string | null {
  if (value === null || value === undefined || value === "") return null;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw badRequest(`${field}: expected an absolute http or https URL, e.g. https://api.example`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`${field}: expected http or https`);
  }
  if (url.search || url.hash) {
    throw badRequest(`${field}: an origin with an optional path prefix, no query string`);
  }
  return url.href.replace(/\/+$/, "");
}

function gatewayView(ctx: Ctx, target: TargetRow) {
  const instances = instancesFor(ctx, target.environment).filter((i) => i.targetId === target.id);
  const live = instances.filter((i) => !i.stale && !i.revoked);
  const published = ctx.app.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM route_gateway WHERE target_id = ?",
    )
    .get(target.id)!.n;
  return {
    environment: target.environment,
    name: target.name,
    id: target.id,
    adapter: target.adapter,
    label: target.label,
    publicUrl: target.public_url,
    intranetUrl: target.intranet_url,
    addresses: gatewayAddresses(target),
    enforce: Boolean(target.enforce),
    paused: Boolean(target.paused),
    replicas: instances.length,
    liveReplicas: live.length,
    maxReplicas: ctx.app.config.maxInstancesPerTarget,
    /** How many APIs are published on it — what makes removing one a decision rather than a click. */
    published,
  };
}

export function registerFleetRoutes(router: Router): void {
  /** The chain, its targets and its gateways in one call — what the environment switcher reads. */
  router.add("GET", "/api/environments", "session", (ctx) => {
    const instances = instancesFor(ctx);
    return json({
      chain: ctx.app.config.promotionChain,
      items: ctx.app.config.promotionChain.map((environment) => {
        const gateways = gatewaysIn(ctx.app.db, environment);
        const target = gateways[0] ?? null;
        const mine = instances.filter((i) => i.environment === environment);
        const live = mine.filter((i) => !i.stale && !i.revoked);
        return {
          environment,
          hasTarget: Boolean(target),
          // `enforce` and `paused` are still asked of the environment because everything that reads
          // them is asking "can I deploy here"; a paused gateway anywhere in the environment stops
          // that, so the answer is the pessimistic one rather than the first row's.
          enforce: gateways.length > 0 && gateways.every((t) => Boolean(t.enforce)),
          paused: gateways.some((t) => Boolean(t.paused)),
          instances: mine.length,
          liveInstances: live.length,
          maxInstances: ctx.app.config.maxInstancesPerTarget,
          // The proxy in front of the replicas — the only gateway address a consumer is given.
          publicUrl: target?.public_url ?? null,
          label: target?.label ?? null,
          /** Every gateway an API in this environment can be published on. */
          gateways: gateways.map((t) => ({
            name: t.name,
            label: t.label,
            addresses: gatewayAddresses(t),
            paused: Boolean(t.paused),
          })),
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
    const body = await readJson<{ name?: string; gateway?: string }>(ctx);
    // A replica belongs to one gateway, not to an environment. With one gateway the caller need
    // not say which — with two, guessing would mint a token for the wrong locality and the
    // mistake would only show up as an on-premise replica serving cloud routes.
    const gateways = gatewaysIn(ctx.app.db, environment);
    if (gateways.length === 0) throw notFound(`no gateway for ${environment}`);
    let target: TargetRow;
    if (body.gateway) {
      target = gatewayIn(ctx, environment, String(body.gateway));
    } else if (gateways.length === 1) {
      target = gateways[0]!;
    } else {
      throw badRequest(
        `gateway: ${environment} has ${gateways.length} gateways (` +
          `${gateways.map((t) => t.name).join(", ")}); say which one this replica belongs to`,
      );
    }

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
        `${environment}/${target.name} already has ${live} live instances ` +
          `(MAX_INSTANCES_PER_TARGET is ${ctx.app.config.maxInstancesPerTarget}); revoke one first`,
      );
    }
    const clash = ctx.app.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM gateway_instance WHERE target_id = ? AND name = ? AND revoked_at IS NULL",
      )
      .get(target.id, name);
    if (clash) {
      throw conflict(`an instance named "${name}" already exists on ${environment}/${target.name}`);
    }

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
      detail: { environment, gateway: target.name, name },
    });
    // Shown exactly once: only the hash is stored, so it cannot be recovered.
    return json(
      { id, name, environment, gateway: target.name, token },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
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
      items: ctx.app.config.promotionChain.flatMap((environment) =>
        gatewaysIn(ctx.app.db, environment).map((target) => gatewayView(ctx, target)),
      ),
      /** So the screen can offer "add a gateway to PROD" for an environment holding none. */
      environments: ctx.app.config.promotionChain,
    });
  });

  router.add("POST", "/api/gateways", "session", async (ctx) => {
    const user = requireAdmin(ctx, "creating a gateway is admin-only");
    const body = await readJson<{
      environment?: string;
      name?: string;
      label?: string;
      publicUrl?: string;
      intranetUrl?: string;
    }>(ctx);
    const environment = String(body.environment ?? "");
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(
        `environment: expected one of ${ctx.app.config.promotionChain.join(", ")}`,
      );
    }
    const name = String(body.name ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      throw badRequest('name: expected lower-case letters, digits and hyphens, e.g. "onprem"');
    }
    if (gatewaysIn(ctx.app.db, environment).some((t) => t.name === name)) {
      throw conflict(`${environment} already has a gateway named "${name}"; edit it instead`);
    }
    const publicUrl = readPublicUrl(body.publicUrl);
    const intranetUrl = readPublicUrl(body.intranetUrl, "intranetUrl");
    const id = newId("tgt");
    ctx.app.db.run(
      `INSERT INTO target (id, environment, name, adapter, config_json, enforce, paused,
                           public_url, intranet_url, label)
       VALUES (?, ?, ?, 'standalone', '{}', 1, 0, ?, ?, ?)`,
      [id, environment, name, publicUrl, intranetUrl, (body.label ?? "").trim() || null],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.create",
      subject: `target:${id}`,
      outcome: "ok",
      detail: { environment, name, publicUrl, intranetUrl, label: body.label ?? null },
    });
    // Deliberately empty: nothing already published in this environment moves onto a gateway that
    // did not exist when it was published. An API arrives here when somebody decides it belongs.
    return json(gatewayView(ctx, gatewayIn(ctx, environment, name)), { status: 201 });
  });

  router.add("PATCH", "/api/gateways/:environment/:name", "session", async (ctx) => {
    const user = requireAdmin(ctx, "changing a gateway is admin-only");
    const environment = ctx.params.environment!;
    const target = gatewayIn(ctx, environment, ctx.params.name!);
    const body = await readJson<{
      label?: string | null;
      publicUrl?: string | null;
      intranetUrl?: string | null;
      paused?: boolean;
    }>(ctx);
    const publicUrl =
      body.publicUrl === undefined ? target.public_url : readPublicUrl(body.publicUrl);
    const intranetUrl =
      body.intranetUrl === undefined
        ? target.intranet_url
        : readPublicUrl(body.intranetUrl, "intranetUrl");
    const label =
      body.label === undefined ? target.label : (String(body.label ?? "").trim() || null);
    const paused = body.paused === undefined ? Boolean(target.paused) : Boolean(body.paused);
    ctx.app.db.run(
      `UPDATE target SET public_url = ?, intranet_url = ?, label = ?, paused = ? WHERE id = ?`,
      [publicUrl, intranetUrl, label, paused ? 1 : 0, target.id],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.update",
      subject: `target:${target.id}`,
      outcome: "ok",
      detail: { environment, name: target.name, publicUrl, intranetUrl, label, paused },
    });
    return json(gatewayView(ctx, gatewayIn(ctx, environment, target.name)));
  });

  /**
   * Removing a gateway takes everything published on it offline, so it is refused while a replica
   * is still live or an API is still bound to it: an admin who meant "retire this locality" would
   * otherwise stop serving routes and find out from a consumer.
   */
  router.add("DELETE", "/api/gateways/:environment/:name", "session", (ctx) => {
    const user = requireAdmin(ctx, "removing a gateway is admin-only");
    const environment = ctx.params.environment!;
    const target = gatewayIn(ctx, environment, ctx.params.name!);
    const live = instancesFor(ctx, environment).filter(
      (i) => !i.revoked && i.targetId === target.id,
    );
    if (live.length > 0) {
      throw conflict(
        `${environment}/${target.name} still has ${live.length} un-revoked replica` +
          `${live.length === 1 ? "" : "s"} (${live.map((i) => i.name).join(", ")}); revoke them first`,
      );
    }
    const routes = ctx.app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM route_gateway WHERE target_id = ?")
      .get(target.id)!.n;
    if (routes > 0) {
      throw conflict(
        `${environment}/${target.name} still serves ${routes} API${routes === 1 ? "" : "s"}; ` +
          "move them to another gateway or withdraw them first",
      );
    }
    ctx.app.db.run("DELETE FROM target WHERE id = ?", [target.id]);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "gateway.delete",
      subject: `target:${target.id}`,
      outcome: "ok",
      detail: { environment, name: target.name },
    });
    return json({ environment, name: target.name, removed: true });
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
 * "in sync" cannot mean two things on two screens. `null` when the environment has no gateway at
 * all — the endpoint turns that into a 404, and the dashboard reports the environment as unset.
 *
 * Since v8 an environment may hold several gateways serving different subsets of its routes, so
 * "behind" is asked of each replica against *its own* gateway's digest. The headline figures stay
 * environment-wide, because that is the question the dashboard is asking; `gateways` underneath
 * says which locality the disagreement is in.
 */
export function healthFor(ctx: Ctx, environment: string) {
  const targets = gatewaysIn(ctx.app.db, environment);
  const target = targets[0];
  if (!target) return null;

  // The environment-wide document: every route it serves anywhere. It is what the admin config
  // projection shows and what `routes` counts, and with one gateway it is byte-identical to that
  // gateway's own config.
  const config = buildConfig(ctx.app.db, ctx.app.kek, environment, ctx.app.config);
  const instances = instancesFor(ctx, environment);
  const live = instances.filter((i) => !i.stale && !i.revoked);
  // Every replica that has not been revoked is still part of this gateway, whether or not it is
  // answering. Counting only the live ones let a killed replica *improve* the headline — the
  // instance that fell behind dropped out of the denominator and the environment started reading
  // "in sync" while a row underneath it read `behind` (finding 10).
  const expected = instances.filter((i) => !i.revoked);

  const gateways = targets.map((row) => {
    const own =
      targets.length === 1
        ? config
        : buildConfig(ctx.app.db, ctx.app.kek, environment, ctx.app.config, row.id);
    const mine = instances.filter((i) => i.targetId === row.id);
    const mineExpected = mine.filter((i) => !i.revoked);
    const mineBehind = mineExpected.filter(
      (i) => i.stale || i.configDigest !== own.digest,
    );
    return {
      name: row.name,
      label: row.label,
      addresses: gatewayAddresses(row),
      paused: Boolean(row.paused),
      configDigest: own.digest,
      routes: own.routes.length,
      replicas: mine.length,
      liveReplicas: mine.filter((i) => !i.stale && !i.revoked).length,
      expectedReplicas: mineExpected.length,
      behindReplicas: mineBehind.length,
      inSync: mineExpected.length > 0 && mineBehind.length === 0,
      behind: mineBehind.map((i) => i.name),
    };
  });
  const behindInstances = gateways.reduce((n, g) => n + g.behindReplicas, 0);

  return {
    environment,
    adapter: target.adapter,
    label: target.label,
    publicUrl: target.public_url,
    enforce: targets.every((t) => Boolean(t.enforce)),
    paused: targets.some((t) => Boolean(t.paused)),
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
    /** Of those, the ones on an older digest than their own gateway's, or not reporting at all. */
    behindInstances,
    // An instance reports the digest it has *activated*, so this becomes true one poll after the
    // config changed. That lag is design section 8.7's intent, not a defect. A gateway with no
    // replicas at all cannot be in sync, so neither is the environment holding it.
    inSync: expected.length > 0 && behindInstances === 0 && gateways.every((g) => g.inSync),
    /** Per locality, because that is where a disagreement actually lives. */
    gateways,
    staleAfterSec: ctx.app.config.instanceStaleAfterSec,
  };
}

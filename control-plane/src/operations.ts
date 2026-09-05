import type { App, Ctx } from "./router.ts";
import {
  Router,
  requireUser,
  readJson,
  json,
  badRequest,
  conflict,
  notFound,
} from "./router.ts";
import { can } from "./auth.ts";
import { assertCan, getResource, etagOf, assertIfMatch } from "./api/common.ts";
import { revisionSource, writeRevision } from "./api/resources.ts";
import { newId, nowIso } from "./db.ts";
import { validateDocument, type PolicyDocument } from "../../shared/policy.ts";
import { domainError, domainPrefix, publishedPath } from "../../shared/domains.ts";
import { normalizeBasePath, normalizeHost } from "../../shared/routing.ts";
import { checkEgress } from "./egress.ts";
import { readPool, type PoolInput } from "./backend-pool.ts";
import {
  buildConfig,
  buildRoutes,
  appliedDigest,
  COMPILER_VERSION,
  limitsFor,
  policyFor,
} from "./config-build.ts";
import {
  boundGatewayNames,
  gatewaysIn,
  publishedUrlsFor,
  resolveGateways,
} from "./api/fleet.ts";
import { writeAudit } from "./audit.ts";
import { reindexResource } from "./search.ts";
import { emitIntegration } from "./integrations.ts";
import { digestOf } from "../../shared/canonical.ts";

interface Snapshot {
  revisionId: string;
  host: string;
  basePath: string;
  backend: Record<string, unknown>;
  policy: Record<string, unknown>;
  /**
   * Gateway *names*, not target ids. A snapshot travels along the promotion chain, and "published
   * on `managed` and `onprem`" has to still mean something in the next environment — a DEV target
   * id means nothing there. Optional so a snapshot written before v8 still parses; the reconciler
   * reads it as "every gateway this environment has".
   */
  gateways?: string[];
  sourceOperationId?: string;
  sourceEnvironment?: string;
  requestDigest?: string;
}
interface OperationRow {
  id: string;
  application_id: string;
  actor: string;
  kind: string;
  resource_id: string;
  resource_name?: string;
  environment: string;
  state: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}
export interface PublishInput extends PoolInput {
  applicationId?: string;
  name?: string;
  kind?: string;
  apiVersion?: string;
  productId?: string;
  productName?: string;
  description?: string;
  spec?: unknown;
  specUrl?: string;
  discoverUrl?: string;
  backendUrl?: string;
  basePath?: string;
  host?: string;
  clientCertRef?: string | null;
  policy?: Record<string, unknown>;
  environment?: string;
  /** The taxonomy. Required on publish; on configure, absent means "leave it as it is". */
  domain?: string;
  subdomain?: string | null;
  /**
   * Which of the environment's gateways this API answers on, by name. Absent means every gateway
   * the environment has today — the answer a one-gateway estate would give anyway, and the one a
   * caller who has never heard of localities means.
   */
  gateways?: string[];
}

/** Where a resource sits in the catalogue's taxonomy, as stored on the resource row. */
interface Taxonomy {
  domain: string | null;
  subdomain: string | null;
}

/**
 * What an API starts with when nobody has said otherwise: a subscription key is required.
 *
 * Named rather than written inline, because it is now two facts in one place — the default *and*
 * the value a non-admin's save is held to.
 */
export const DEFAULT_POLICY: Record<string, unknown> = {
  "auth.subscriptionKey": { in: "header", name: "X-Api-Key" },
};

/**
 * The taxonomy a write is asking for, refusing anything the closed list does not offer.
 *
 * `current` is what the resource already has, so a form that does not send the fields (the policy
 * tab, the definition tab) does not silently un-classify an API. A resource published before
 * domains existed has `domain: null`; that is tolerated on read and refused here, so the next save
 * is where it gets classified rather than the next deploy being where it breaks.
 */
function readTaxonomy(body: PublishInput, current: Taxonomy, required: boolean): Taxonomy {
  const domain = body.domain !== undefined ? body.domain : current.domain;
  const subdomain = body.subdomain !== undefined ? body.subdomain : current.subdomain;
  if (!domain && !required) return { domain: null, subdomain: null };
  const error = domainError(domain, subdomain);
  if (error) throw badRequest(error);
  return { domain: domain!, subdomain: subdomain || null };
}
function env(ctx: Ctx, value?: string): string {
  const e = value ?? ctx.app.config.promotionChain[0]!;
  if (!ctx.app.config.promotionChain.includes(e))
    throw badRequest("unknown environment");
  return e;
}
function key(ctx: Ctx): string {
  const value = ctx.req.headers.get("idempotency-key");
  if (!value || value.length > 160)
    throw badRequest("Idempotency-Key is required (up to 160 characters)");
  return `${requireUser(ctx).id}:${value}`;
}
function repeated(ctx: Ctx, requestDigest: string): Response | null {
  const row = ctx.app.db
    .query<OperationRow, [string]>(
      "SELECT * FROM operation WHERE idempotency_key=?",
    )
    .get(key(ctx));
  if (!row) return null;
  if (JSON.parse(row.input_json).requestDigest !== requestDigest)
    throw conflict("Idempotency-Key was already used for a different command");
  return json(operationView(row), { status: 202 });
}
function operationView(row: OperationRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    actor: row.actor,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    environment: row.environment,
    state: row.state,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}
function queue(
  ctx: Ctx,
  applicationId: string,
  resourceId: string,
  environment: string,
  kind: string,
  snapshot: Snapshot,
): Response {
  const id = newId("op"),
    at = nowIso(),
    actor = requireUser(ctx).id;
  ctx.app.db.run(
    `INSERT INTO operation (id,application_id,actor,kind,resource_id,environment,input_json,created_at,updated_at,idempotency_key)
  VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      applicationId,
      actor,
      kind,
      resourceId,
      environment,
      JSON.stringify(snapshot),
      at,
      at,
      key(ctx),
    ],
  );
  writeAudit(ctx.app.db, {
    actor,
    action: `api.${kind}`,
    subject: `resource:${resourceId}`,
    outcome: "ok",
    detail: { applicationId, environment, operationId: id },
  });
  return json(
    { id, applicationId, resourceId, environment, kind, state: "queued" },
    { status: 202 },
  );
}
async function settings(
  ctx: Ctx,
  body: PublishInput,
  kind: string,
  environment: string,
  taxonomy: Taxonomy,
  apiVersion: string,
  defaults?: Snapshot,
): Promise<Omit<Snapshot, "revisionId">> {
  const h = normalizeHost(body.host ?? defaults?.host ?? "*");
  // The domain is the first segment of the address, not a label filed beside it, so the default
  // path is derived from the taxonomy and an explicit one has to live underneath it. Anything
  // else and two APIs in different domains could answer on the same URL, and the catalog's
  // grouping would stop being a fact about the estate.
  const prefix = taxonomy.domain ? domainPrefix(taxonomy.domain, taxonomy.subdomain) : null;
  const fallback = taxonomy.domain
    ? publishedPath({
        domain: taxonomy.domain,
        subdomain: taxonomy.subdomain,
        name: body.name ?? "",
        apiVersion,
      })
    : `/${body.name}`;
  const p = normalizeBasePath(body.basePath ?? defaults?.basePath ?? fallback);
  if (h.errors.length || p.errors.length)
    throw badRequest([...h.errors, ...p.errors].join("; "));
  if (prefix && p.basePath !== prefix && !p.basePath.startsWith(`${prefix}/`)) {
    throw badRequest(
      `basePath: "${p.basePath}" is not under "${prefix}", which is where ${taxonomy.domain}` +
        `${taxonomy.subdomain ? ` / ${taxonomy.subdomain}` : ""} publishes`,
    );
  }
  let backend = defaults?.backend;
  // A pool and a single URL are the same field said two ways: `backendUrl` is the one-member
  // shorthand the publish and promotion forms send, `pool`/`rule` is what the properties form
  // sends once there is more than one. Both land on the reader the binding endpoint uses, so a
  // pool cannot mean one thing here and another there.
  const read = await readPool(body, ctx.app.config.integrations);
  if (read) {
    backend = {
      ...read,
      ...(defaults?.backend.clientCertRef
        ? { clientCertRef: defaults.backend.clientCertRef }
        : {}),
    };
  } else if (body.backendUrl !== undefined) {
    const errors = await checkEgress(
      body.backendUrl,
      ctx.app.config.integrations,
      "backendUrl",
    );
    if (errors.length) throw badRequest(errors.join("; "));
    backend = {
      pool: [{ url: body.backendUrl }],
      rule: "failover",
      ...(defaults?.backend.clientCertRef
        ? { clientCertRef: defaults.backend.clientCertRef }
        : {}),
    };
  }
  if (!backend)
    throw badRequest(`backendUrl is required for ${environment.toUpperCase()}`);
  backend = { ...backend };
  if (body.clientCertRef !== undefined) {
    if (body.clientCertRef) backend.clientCertRef = body.clientCertRef;
    else delete backend.clientCertRef;
  }
  if (backend.clientCertRef) {
    const cert = ctx.app.db
      .query<
        { application_id: string; environment: string; not_after: string },
        [string]
      >(
        "SELECT application_id,environment,not_after FROM certificate WHERE id=?",
      )
      .get(String(backend.clientCertRef));
    if (
      !cert ||
      cert.environment !== environment ||
      Date.parse(cert.not_after) <= Date.now()
    )
      throw badRequest(
        `a valid client certificate in ${environment} is required`,
      );
    assertCan(ctx.user, cert.application_id, "use this certificate");
    if (cert.application_id !== body.applicationId)
      throw badRequest(
        "the client certificate must belong to the API application",
      );
  }
  const policy = { ...(body.policy ?? defaults?.policy ?? DEFAULT_POLICY) };
  // "Requires a subscription key" is the default, and whether an API may stop requiring one is an
  // administrator's decision rather than its owner's: an open route is the one policy change whose
  // blast radius is the whole internet, and the owner is exactly the person with a reason to want
  // it. So a non-admin's document keeps whatever the unit was — including the default — and the
  // control says so rather than the save failing later.
  if (!ctx.user?.isAdmin) {
    const before = defaults?.policy?.["auth.subscriptionKey"] ?? DEFAULT_POLICY["auth.subscriptionKey"];
    // Only a document that actually carries the unit can be trying to change it. The unit is
    // stored explicitly once somebody has set it and not before, so reading its *absence* as an
    // attempt to remove it refused every save that had nothing to do with policy at all — a
    // description, a backend, a gateway selection — for any API nobody had touched it on.
    const sent = body.policy?.["auth.subscriptionKey"];
    if (sent !== undefined && JSON.stringify(sent) !== JSON.stringify(before)) {
      throw badRequest(
        "auth.subscriptionKey: only an administrator can change whether this API requires a " +
          "subscription key",
      );
    }
    policy["auth.subscriptionKey"] = before;
  }
  const errors = validateDocument(policy, { kind });
  if (errors.length) throw badRequest(errors.join("; "));
  return {
    host: h.host,
    basePath: p.basePath,
    backend,
    policy,
    gateways: readGateways(ctx, environment, body.gateways ?? defaults?.gateways),
  };
}

/**
 * Which gateways this API answers on in this environment.
 *
 * Absent means all of them, because that is what publishing meant before an environment could
 * hold more than one and it is what somebody who has not thought about localities intends. An
 * explicit empty list is refused rather than quietly widened: "published on no gateway" is an API
 * with an address nobody can reach, and the person who ticked every box off should be told so
 * here rather than discover it from a 404.
 */
function readGateways(
  ctx: Ctx,
  environment: string,
  requested: string[] | undefined,
): string[] {
  const available = gatewaysIn(ctx.app.db, environment);
  if (available.length === 0) {
    throw badRequest(
      `${environment.toUpperCase()} has no gateway to publish on; an administrator adds one on ` +
        "the Gateways screen",
    );
  }
  if (requested === undefined) return available.map((t) => t.name);
  if (!Array.isArray(requested)) throw badRequest("gateways: expected an array of gateway names");
  const names = [...new Set(requested.map((n) => String(n).trim()).filter(Boolean))];
  if (names.length === 0) {
    throw badRequest(
      `gateways: an API must be published on at least one gateway (${environment.toUpperCase()} ` +
        `has ${available.map((t) => t.name).join(", ")})`,
    );
  }
  const unknown = names.filter((n) => !available.some((t) => t.name === n));
  if (unknown.length > 0) {
    throw badRequest(
      `gateways: ${environment.toUpperCase()} has no gateway named ` +
        `${unknown.map((n) => `"${n}"`).join(", ")} (it has ` +
        `${available.map((t) => t.name).join(", ")})`,
    );
  }
  // Sorted so the same selection always produces the same snapshot, and an idempotency digest
  // over it cannot depend on the order the checkboxes were ticked in.
  return names.sort();
}
function currentSnapshot(
  ctx: Ctx,
  id: string,
  environment: string,
): Snapshot | null {
  const pending = ctx.app.db
    .query<OperationRow, string[]>(
      "SELECT * FROM operation WHERE resource_id=? AND environment=? AND state<>'superseded' ORDER BY rowid DESC LIMIT 1",
    )
    .get(id, environment);
  if (pending) return JSON.parse(pending.input_json);
  const release = ctx.app.db
    .query<{ revision_id: string }, string[]>(
      "SELECT revision_id FROM release WHERE resource_id=? AND environment=? AND state='converged'",
    )
    .get(id, environment);
  const route = ctx.app.db
    .query<{ host: string; base_path: string }, string[]>(
      "SELECT * FROM route WHERE resource_id=? AND environment=?",
    )
    .get(id, environment);
  const binding = ctx.app.db
    .query<{ backend_json: string }, string[]>(
      "SELECT backend_json FROM binding WHERE resource_id=? AND environment=?",
    )
    .get(id, environment);
  if (!release || !route || !binding) return null;
  return {
    revisionId: release.revision_id,
    host: route.host,
    basePath: route.base_path,
    backend: JSON.parse(binding.backend_json),
    policy: policyFor(ctx.app.db, id, environment),
    // Read back from the binding rows rather than remembered, so a configure that says nothing
    // about gateways leaves the API exactly where it is answering.
    gateways: boundGatewayNames(ctx.app.db, id, environment),
  };
}
function assertRouteFree(
  ctx: Ctx,
  id: string,
  environment: string,
  host: string,
  basePath: string,
) {
  const other = ctx.app.db
    .query<{ resource_id: string }, string[]>(
      "SELECT resource_id FROM route WHERE environment=? AND host=? AND base_path=? AND resource_id<>?",
    )
    .get(environment, host, basePath, id);
  if (other)
    throw conflict(
      "another API already uses this path in the target environment",
    );
  const pending = ctx.app.db
    .query<OperationRow, [string]>(
      "SELECT * FROM operation WHERE environment=? AND state IN ('queued','retrying','blocked')",
    )
    .all(environment);
  if (
    pending.some(
      (o) =>
        o.resource_id !== id &&
        JSON.parse(o.input_json).host === host &&
        JSON.parse(o.input_json).basePath === basePath,
    )
  )
    throw conflict("another pending API already reserves this path");
}
export function registerOperationRoutes(router: Router) {
  router.add("GET", "/api/operations", "session", (ctx) => {
    const user = requireUser(ctx),
      applicationId = ctx.url.searchParams.get("applicationId");
    if (applicationId)
      assertCan(user, applicationId, "read this application activity");
    const scope = applicationId
      ? [applicationId]
      : user.isAdmin
        ? null
        : user.applications;
    const where =
      scope === null
        ? ""
        : ` WHERE o.application_id IN (${scope.map(() => "?").join(",") || "NULL"})`;
    const rows = ctx.app.db
      .query<OperationRow, string[]>(
        `SELECT o.*,r.name AS resource_name FROM operation o LEFT JOIN resource r ON r.id=o.resource_id${where} ORDER BY o.rowid DESC LIMIT 500`,
      )
      .all(...(scope ?? []));
    return json({ items: rows.map(operationView) });
  });
  router.add("GET", "/api/operations/:id", "session", (ctx) => {
    const row = ctx.app.db
      .query<OperationRow, [string]>("SELECT * FROM operation WHERE id=?")
      .get(ctx.params.id!);
    if (!row) throw notFound("operation not found");
    assertCan(ctx.user, row.application_id, "read this operation");
    return json(operationView(row));
  });
  router.add("POST", "/api/publish", "session", async (ctx) => {
    const user = requireUser(ctx),
      body = await readJson<PublishInput>(
        ctx,
        ctx.app.config.maxSpecBytes + 32768,
      );
    const requestDigest = digestOf({ path: ctx.url.pathname, body });
    const again = repeated(ctx, requestDigest);
    if (again) return again;
    const applicationId = body.applicationId ?? "";
    assertCan(user, applicationId, "publish for this application");
    if (
      !ctx.app.db
        .query("SELECT id FROM application WHERE id=?")
        .get(applicationId)
    )
      throw notFound("application not found");
    const kind = body.kind ?? "rest",
      version = body.apiVersion ?? "v1",
      environment = ctx.app.config.promotionChain[0]!;
    if (!["rest", "soap", "mcp", "a2a"].includes(kind))
      throw badRequest("kind: rest, soap, mcp or a2a");
    if (!body.name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.name))
      throw badRequest("name: 2–61 lowercase letters, digits or hyphens");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version))
      throw badRequest("invalid API version");
    if (
      !body.productId &&
      (!body.productName || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.productName))
    )
      throw badRequest("choose a product or enter a valid product name");
    // Required on a new API, with no "unclassified" escape: a catalog you cannot browse by domain
    // is a list, and one API without a domain is enough to make the grouping incomplete.
    const taxonomy = readTaxonomy(body, { domain: null, subdomain: null }, true);
    const source = await revisionSource(ctx, { kind }, body);
    const config = await settings(ctx, body, kind, environment, taxonomy, version);
    return ctx.app.db.transaction(() => {
      const duplicate = repeated(ctx, requestDigest);
      if (duplicate) return duplicate;
      const id = newId("res"),
        at = nowIso();
      assertRouteFree(ctx, id, environment, config.host, config.basePath);
      if (
        ctx.app.db
          .query(
            "SELECT id FROM resource WHERE application_id=? AND name=? AND api_version=?",
          )
          .get(applicationId, body.name!, version)
      )
        throw conflict("API name and version already exist");
      let productId = body.productId;
      if (productId) {
        const p = ctx.app.db
          .query<{ application_id: string; lifecycle: string }, [string]>(
            "SELECT application_id,lifecycle FROM product WHERE id=?",
          )
          .get(productId);
        if (
          !p ||
          p.application_id !== applicationId ||
          p.lifecycle !== "active"
        )
          throw badRequest(
            "choose an active product owned by this application",
          );
      } else {
        productId = newId("prod");
        if (
          ctx.app.db
            .query("SELECT id FROM product WHERE name=?")
            .get(body.productName!)
        )
          throw conflict("product name already exists");
        ctx.app.db.run(
          "INSERT INTO product(id,name,application_id,lifecycle) VALUES (?,?,?,'active')",
          [productId, body.productName!, applicationId],
        );
      }
      ctx.app.db.run(
        `INSERT INTO resource(id,kind,name,application_id,api_version,lifecycle,description,domain,subdomain,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,?,?,?)`,
        [
          id,
          kind,
          body.name!,
          applicationId,
          version,
          body.description ?? "",
          taxonomy.domain,
          taxonomy.subdomain,
          at,
          at,
        ],
      );
      writeRevision(ctx, getResource(ctx, id), source, "revision.create");
      const revision = ctx.app.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM revision WHERE resource_id=? ORDER BY rev DESC LIMIT 1",
        )
        .get(id)!;
      ctx.app.db.run(
        "INSERT INTO product_member(product_id,resource_id) VALUES (?,?)",
        [productId, id],
      );
      return queue(ctx, applicationId, id, environment, "publish", {
        ...config,
        revisionId: revision.id,
        requestDigest,
      });
    })();
  });
  router.add("GET", "/api/resources/:id/editor", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!),
      environment = env(
        ctx,
        ctx.url.searchParams.get("environment") ?? undefined,
      );
    const snapshot = currentSnapshot(ctx, row.id, environment);
    const canEdit = can(ctx.user, row.application_id);
    const definition = snapshot
      ? ctx.app.db
          .query<{ original: string }, [string]>(
            "SELECT original FROM revision WHERE id=?",
          )
          .get(snapshot.revisionId)?.original
      : null;
    const owner = ctx.app.db
      .query<{ name: string }, [string]>("SELECT name FROM application WHERE id=?")
      .get(row.application_id);
    return json({
      resource: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        applicationId: row.application_id,
        applicationName: owner?.name ?? row.application_id,
        apiVersion: row.api_version,
        description: row.description,
        domain: row.domain ?? null,
        subdomain: row.subdomain ?? null,
        etag: etagOf(row),
        canEdit,
        // One sentence saying why, rather than controls that vanish (finding 8). Present for
        // everybody so the screen never has to decide whether to render a reason it does not have.
        editReason: canEdit
          ? null
          : `This API belongs to ${owner?.name ?? row.application_id}. You can read it here; ` +
            "only somebody in that application can change it.",
      },
      environment,
      // A non-owner sees what the API *is*, never how it is wired: backend addresses are internal
      // topology and the policy document names credentials, certificates and header rules
      // (finding 3). `published` keeps the one bit the workspace actually needs from `settings` —
      // whether this environment has it at all — without the rest.
      settings: snapshot
        ? canEdit
          ? {
              host: snapshot.host,
              basePath: snapshot.basePath,
              backend: snapshot.backend,
              policy: snapshot.policy,
              gateways: snapshot.gateways ?? [],
            }
          : {
              host: snapshot.host,
              basePath: snapshot.basePath,
              // Which gateways it answers on is not topology: it is half of the address, and
              // every URL on this screen is built from it.
              gateways: snapshot.gateways ?? [],
              redacted: true,
            }
        : null,
      /** Where it actually answers here: one entry per address of every gateway it is on. */
      urls: publishedUrlsFor(ctx.app.db, row.id, environment),
      published: Boolean(snapshot),
      definition,
      products: ctx.app.db
        .query(
          "SELECT p.id,p.name FROM product p JOIN product_member pm ON pm.product_id=p.id WHERE pm.resource_id=?",
        )
        .all(row.id),
      // Every version of this API, so the workspace can offer the switcher and the next identifier
      // without a second round trip. Siblings are the rows sharing an application and a name.
      versions: ctx.app.db
        .query(
          "SELECT id,api_version AS apiVersion,lifecycle FROM resource WHERE application_id=? AND name=? ORDER BY api_version",
        )
        .all(row.application_id, row.name),
    });
  });
  router.add("POST", "/api/resources/:id/configure", "session", async (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    assertCan(ctx.user, row.application_id, "configure this API");
    const body = await readJson<PublishInput>(
        ctx,
        ctx.app.config.maxSpecBytes + 32768,
      ),
      environment = env(ctx, body.environment);
    const requestDigest = digestOf({ path: ctx.url.pathname, body });
    const again = repeated(ctx, requestDigest);
    if (again) return again;
    assertIfMatch(ctx, row);
    const previous = currentSnapshot(ctx, row.id, environment);
    if (!previous)
      throw conflict("publish or promote to this environment first");
    // Required from here on, including for a row published before domains existed: the save that
    // classifies it is also the save that moves its path, so both happen at once or neither does.
    const taxonomy = readTaxonomy(
      body,
      { domain: row.domain, subdomain: row.subdomain },
      true,
    );
    const config = await settings(
      ctx,
      { ...body, applicationId: row.application_id, name: row.name },
      row.kind,
      environment,
      taxonomy,
      row.api_version,
      previous,
    );
    const source =
      body.spec !== undefined || body.specUrl || body.discoverUrl
        ? await revisionSource(ctx, row, body)
        : null;
    return ctx.app.db.transaction(() => {
      assertIfMatch(ctx, getResource(ctx, row.id));
      assertRouteFree(ctx, row.id, environment, config.host, config.basePath);
      let revisionId = previous.revisionId;
      if (source) {
        writeRevision(ctx, getResource(ctx, row.id), source, "revision.create");
        revisionId = ctx.app.db
          .query<{ id: string }, [string]>(
            "SELECT id FROM revision WHERE resource_id=? ORDER BY rev DESC LIMIT 1",
          )
          .get(row.id)!.id;
      }
      ctx.app.db.run(
        "UPDATE resource SET updated_at=?,description=COALESCE(?,description),domain=?,subdomain=? WHERE id=?",
        [nowIso(), body.description ?? null, taxonomy.domain, taxonomy.subdomain, row.id],
      );
      if (body.policy && environment !== ctx.app.config.promotionChain[0])
        ctx.app.db.run(
          "INSERT INTO environment_override(resource_id,environment,policy_json) VALUES (?,?,?) ON CONFLICT(resource_id,environment) DO UPDATE SET policy_json=excluded.policy_json",
          [row.id, environment, JSON.stringify(body.policy)],
        );
      reindexResource(ctx.app.db, row.id);
      return queue(ctx, row.application_id, row.id, environment, "configure", {
        ...config,
        revisionId,
        requestDigest,
      });
    })();
  });
  router.add("POST", "/api/resources/:id/promote", "session", async (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    assertCan(ctx.user, row.application_id, "promote this API");
    const body = await readJson<PublishInput>(ctx),
      environment = env(ctx, body.environment);
    const requestDigest = digestOf({ path: ctx.url.pathname, body });
    const again = repeated(ctx, requestDigest);
    if (again) return again;
    const index = ctx.app.config.promotionChain.indexOf(environment);
    if (index < 1) throw badRequest("promote to TEST or PROD");
    const sourceEnvironment = ctx.app.config.promotionChain[index - 1]!;
    const source = currentSnapshot(ctx, row.id, sourceEnvironment);
    if (!source)
      throw conflict(`publish to ${sourceEnvironment.toUpperCase()} first`);
    const sourceOp = ctx.app.db
      .query<{ id: string }, string[]>(
        "SELECT id FROM operation WHERE resource_id=? AND environment=? AND state<>'superseded' ORDER BY rowid DESC LIMIT 1",
      )
      .get(row.id, sourceEnvironment);
    const target = currentSnapshot(ctx, row.id, environment);
    const override = ctx.app.db
      .query<{ policy_json: string }, string[]>(
        "SELECT policy_json FROM environment_override WHERE resource_id=? AND environment=?",
      )
      .get(row.id, environment);
    const defaults = {
      ...source,
      backend: target?.backend ?? {},
      host: target?.host ?? source.host,
      basePath: target?.basePath ?? source.basePath,
      policy: override ? JSON.parse(override.policy_json) : source.policy,
      // Where it is already answering here, if anywhere. Not carried over from the source: the
      // gateway names may not line up across environments, and a promotion into a locality this
      // environment does not have is a decision, not a default.
      gateways: target?.gateways,
    };
    if (!target && !body.backendUrl)
      throw badRequest(
        `backendUrl is required for the first promotion to ${environment.toUpperCase()}`,
      );
    // A promotion carries the taxonomy the resource already has: the domain belongs to the API,
    // not to one environment's route, so it is never re-asked here and never differs across the
    // chain. A row published before domains existed promotes unchanged rather than being blocked
    // — it gets classified on its next edit, which is where the path can move safely.
    const config = await settings(
      ctx,
      { ...body, applicationId: row.application_id, name: row.name },
      row.kind,
      environment,
      { domain: row.domain, subdomain: row.subdomain },
      row.api_version,
      defaults,
    );
    return ctx.app.db.transaction(() => {
      assertRouteFree(ctx, row.id, environment, config.host, config.basePath);
      return queue(ctx, row.application_id, row.id, environment, "promote", {
        ...config,
        revisionId: source.revisionId,
        sourceEnvironment,
        sourceOperationId: sourceOp?.id,
        requestDigest,
      });
    })();
  });
}

/**
 * A current complete configuration must be acknowledged by every non-revoked instance — each
 * against its own gateway's document, because two gateways in one environment serve different
 * subsets of it and comparing both to the union would say "behind" forever.
 */
export function fleetApplied(app: App, environment: string): boolean {
  if (buildConfig(app.db, app.kek, environment, app.config.integrations).errors.length) {
    return false;
  }
  const targets = gatewaysIn(app.db, environment);
  const instances = app.db
    .query<
      { target_id: string; config_digest: string | null; last_seen_at: string | null },
      [string]
    >(
      `SELECT gi.target_id,gi.config_digest,gi.last_seen_at FROM gateway_instance gi JOIN target t ON t.id=gi.target_id WHERE t.environment=? AND gi.revoked_at IS NULL`,
    )
    .all(environment);
  const digests = new Map(
    targets.map((t) => [
      t.id,
      targets.length === 1
        ? buildConfig(app.db, app.kek, environment, app.config.integrations).digest
        : buildConfig(app.db, app.kek, environment, app.config.integrations, t.id).digest,
    ]),
  );
  return (
    instances.length > 0 &&
    instances.every(
      (i) =>
        i.config_digest === digests.get(i.target_id) &&
        i.last_seen_at &&
        Date.now() - Date.parse(i.last_seen_at) < 120000,
    )
  );
}
export function runOperations(app: App): void {
  const db = app.db;
  const pending = db
    .query<OperationRow, [string]>(
      "SELECT * FROM operation WHERE state IN ('queued','retrying','blocked') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY rowid LIMIT 30",
    )
    .all(nowIso());
  for (const operation of pending) {
    try {
      db.transaction(() => {
        const snapshot = JSON.parse(operation.input_json) as Snapshot;
        // Preserve captured promotions: a source operation cannot be skipped while a child waits for it.
        const earlier = db
          .query<{ id: string }, string[]>(
            "SELECT id FROM operation WHERE resource_id=? AND environment=? AND rowid<(SELECT rowid FROM operation WHERE id=?) AND state NOT IN ('complete','superseded') LIMIT 1",
          )
          .get(operation.resource_id, operation.environment, operation.id);
        if (earlier) return;
        if (snapshot.sourceOperationId) {
          const parent = db
            .query<{ state: string }, [string]>(
              "SELECT state FROM operation WHERE id=?",
            )
            .get(snapshot.sourceOperationId);
          if (parent?.state !== "complete") return;
        } else if (
          snapshot.sourceEnvironment &&
          !fleetApplied(app, snapshot.sourceEnvironment)
        )
          return;
        // Which gateways this operation puts the API on. Names, resolved here rather than at
        // request time, because the row it writes has to be the one that exists now — a gateway
        // could have been removed while the operation sat in the queue.
        const chosen = snapshot.gateways
          ? resolveGateways(db, operation.environment, snapshot.gateways)
          : {
              ids: gatewaysIn(db, operation.environment).map((t) => t.id),
              missing: [] as string[],
            };
        if (chosen.missing.length > 0)
          throw new Error(
            `${operation.environment.toUpperCase()} has no gateway named ` +
              `${chosen.missing.map((n) => `"${n}"`).join(", ")}.`,
          );
        if (chosen.ids.length === 0)
          throw new Error(
            "Environment has no gateway to publish on; deployment will resume automatically.",
          );
        const targets = db
          .query<{ id: string; paused: number }, string[]>(
            `SELECT id,paused FROM target WHERE environment=? AND id IN (${chosen.ids
              .map(() => "?")
              .join(",")})`,
          )
          .all(operation.environment, ...chosen.ids);
        // Every chosen gateway has to be able to take it. Deploying to the half that is running
        // would leave the API answering in one locality and not the other, which is the one state
        // "published on both" must never quietly mean.
        if (targets.length === 0 || targets.some((t) => t.paused))
          throw new Error(
            "Environment is unavailable; deployment will resume automatically.",
          );
        const target = targets[0]!;
        db.run(
          "INSERT INTO route(resource_id,environment,host,base_path) VALUES (?,?,?,?) ON CONFLICT(resource_id,environment) DO UPDATE SET host=excluded.host,base_path=excluded.base_path",
          [
            operation.resource_id,
            operation.environment,
            snapshot.host,
            snapshot.basePath,
          ],
        );
        // Replaced wholesale rather than merged: the snapshot is the whole answer to "where does
        // this answer", so a gateway dropped from the selection has to stop being told about it.
        db.run("DELETE FROM route_gateway WHERE resource_id=? AND environment=?", [
          operation.resource_id,
          operation.environment,
        ]);
        for (const id of chosen.ids)
          db.run(
            "INSERT INTO route_gateway(resource_id,environment,target_id) VALUES (?,?,?)",
            [operation.resource_id, operation.environment, id],
          );
        db.run(
          "INSERT INTO binding(resource_id,environment,backend_json) VALUES (?,?,?) ON CONFLICT(resource_id,environment) DO UPDATE SET backend_json=excluded.backend_json",
          [
            operation.resource_id,
            operation.environment,
            JSON.stringify(snapshot.backend),
          ],
        );
        db.run(
          "DELETE FROM policy_entry WHERE resource_id=? AND environment=?",
          [operation.resource_id, operation.environment],
        );
        for (const [unit, value] of Object.entries(snapshot.policy))
          db.run(
            "INSERT INTO policy_entry(resource_id,environment,unit_key,value_json,origin,updated_by,updated_at) VALUES (?,?,?,?,'local',?,?)",
            [
              operation.resource_id,
              operation.environment,
              unit,
              JSON.stringify(value),
              operation.actor,
              nowIso(),
            ],
          );
        const revision = db
          .query<{ version_digest: string }, [string]>(
            "SELECT version_digest FROM revision WHERE id=?",
          )
          .get(snapshot.revisionId);
        if (!revision) throw new Error("Definition is unavailable.");
        db.run(
          "UPDATE release SET state='superseded' WHERE resource_id=? AND environment=? AND state='converged'",
          [operation.resource_id, operation.environment],
        );
        const releaseId = newId("rel");
        db.run(
          "INSERT INTO release(id,resource_id,revision_id,environment,state,version_digest,released_by,released_at) VALUES (?,?,?,?,'converged',?,?,?)",
          [
            releaseId,
            operation.resource_id,
            snapshot.revisionId,
            operation.environment,
            revision.version_digest,
            operation.actor,
            nowIso(),
          ],
        );
        db.run(
          "UPDATE revision SET frozen_at=COALESCE(frozen_at,?) WHERE id=?",
          [nowIso(), snapshot.revisionId],
        );
        const built = buildRoutes(
          db,
          operation.environment,
          limitsFor(app.config.integrations),
        );
        const route = built.routes.find(
          (r) => r.resourceId === operation.resource_id,
        );
        if (!route || built.errors.length)
          throw new Error(
            "Configuration could not be activated: " +
              JSON.stringify(built.errors),
          );
        const config = buildConfig(
          db,
          app.kek,
          operation.environment,
          app.config.integrations,
        );
        // One row per gateway it was put on: `applied` answers "what does this gateway have", and
        // with several in an environment that is a different answer per gateway.
        for (const id of chosen.ids)
          db.run(
            `INSERT INTO applied(target_id,resource_id,revision_id,applied_digest,compiler_version,applied_at) VALUES (?,?,?,?,?,?) ON CONFLICT(target_id,resource_id) DO UPDATE SET revision_id=excluded.revision_id,applied_digest=excluded.applied_digest,compiler_version=excluded.compiler_version,applied_at=excluded.applied_at`,
            [
              id,
              operation.resource_id,
              snapshot.revisionId,
              appliedDigest(route),
              COMPILER_VERSION,
              nowIso(),
            ],
          );
        // And none for a gateway it has just been taken off.
        db.run(
          `DELETE FROM applied WHERE resource_id=? AND target_id IN (
             SELECT id FROM target WHERE environment=? AND id NOT IN (${chosen.ids
               .map(() => "?")
               .join(",")}))`,
          [operation.resource_id, operation.environment, ...chosen.ids],
        );
        db.run(
          "UPDATE operation SET state='waiting-for-gateways',error=NULL,result_json=?,updated_at=? WHERE id=?",
          [
            JSON.stringify({ releaseId, configDigest: config.digest }),
            nowIso(),
            operation.id,
          ],
        );
      })();
    } catch (error) {
      const attempts = operation.attempts + 1;
      db.run(
        "UPDATE operation SET state=?,attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?",
        [
          attempts >= 5 ? "blocked" : "retrying",
          attempts,
          (error as Error).message,
          new Date(
            Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)),
          ).toISOString(),
          nowIso(),
          operation.id,
        ],
      );
    }
  }
  for (const environment of app.config.promotionChain) {
    if (!fleetApplied(app, environment)) continue;
    db.transaction(() => {
      const done = db
        .query<OperationRow, [string]>(
          "SELECT * FROM operation WHERE environment=? AND state='waiting-for-gateways'",
        )
        .all(environment);
      for (const o of done) {
        db.run(
          "UPDATE operation SET state='complete',updated_at=? WHERE id=?",
          [nowIso(), o.id],
        );
        emitIntegration(
          app,
          o.application_id,
          "email",
          "operation.complete",
          o.id,
          { subject: `${o.kind} complete in ${environment.toUpperCase()}` },
        );
      }
      db.run(
        "UPDATE subscription SET state='active' WHERE environment=? AND state='activating'",
        [environment],
      );
      db.run(
        "UPDATE subscription SET state='revoked' WHERE environment=? AND state='revoking'",
        [environment],
      );
    })();
  }
}

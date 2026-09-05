import { digestOf } from "../../../shared/canonical.ts";
import {
  lintDocument,
  OPERATION_OVERRIDABLE,
  parseOperationUnitKey,
  POLICY_UNITS,
  validateDocument,
  validateUnit,
} from "../../../shared/policy.ts";
import { normalizeBasePath, normalizeHost } from "../../../shared/routing.ts";
import { domainError, domainPrefix, publishedPath } from "../../../shared/domains.ts";
import { diffModels } from "../../../shared/diff.ts";
import { API_VERSION_PATTERN, REACHED_FLEET_STATES, RESOURCE_KINDS } from "../../../shared/types.ts";
import type { ApiModel, OriginalFormat } from "../../../shared/types.ts";
import { type BackendPool } from "../../../shared/backend.ts";
import type { ConfigOperation } from "../../../shared/config-doc.ts";
import { readPool } from "../backend-pool.ts";
import { looksLikeWsdl, normalizeWsdl, toSoapSummary } from "../normalize-wsdl.ts";
import { discoverA2a, looksLikeAgentCard, normalizeA2a } from "../normalize-a2a.ts";
import { discoverMcp, looksLikeMcpManifest, normalizeMcp } from "../normalize-mcp.ts";
import { compileAndStore } from "../artifacts.ts";
import { resourceAttention } from "../attention.ts";
import { writeAudit } from "../audit.ts";
import { capabilitiesFor } from "../auth.ts";
import { policyFor } from "../config-build.ts";
import { newId, nowIso } from "../db.ts";
import { checkEgress } from "../egress.ts";
import { enqueueJob, runDueJobs } from "../jobs.ts";
import { normalizeSpec, toOpenApi31 } from "../normalize.ts";
import { reindexResource } from "../search.ts";
import { trustedFetch } from "../trust-store.ts";
import {
  badGateway,
  badRequest,
  conflict,
  HttpError,
  json,
  notFound,
  readJson,
  requireUser,
  Router,
  type Ctx,
} from "../router.ts";
import {
  assertCan,
  assertIfMatch,
  environmentOf,
  etagOf,
  getResource,
  nextCursor,
  pageOf,
  touch,
  type ResourceRow,
} from "./common.ts";

function resourceView(ctx: Ctx, row: ResourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    applicationId: row.application_id,
    apiVersion: row.api_version,
    // A family is (application, name); its members are the api_version values (plan section 8).
    family: `${row.application_id}/${row.name}`,
    lifecycle: row.lifecycle,
    sunsetAt: row.sunset_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The catalog's metadata, on the resource it describes (goal G6). `visibility` also decides
    // whether an A2A agent's card is public, so it is not only presentation.
    summary: row.summary,
    description: row.description,
    tags: JSON.parse(row.tags_json ?? "[]") as string[],
    docsUrl: row.docs_url,
    icon: row.icon,
    visibility: row.visibility,
    discoveryUrl: row.discovery_url,
    // The taxonomy, which is also the first segment of the published path (schema-007).
    domain: row.domain,
    subdomain: row.subdomain,
    etag: etagOf(row),
    capabilities: capabilitiesFor(ctx.user, row.application_id),
  };
}

/** Every version of one API, oldest first — what the version switcher renders. */
function versionsOf(ctx: Ctx, row: ResourceRow) {
  return (
    ctx.app.db
      .query<ResourceRow, [string, string]>(
        "SELECT * FROM resource WHERE application_id = ? AND name = ? ORDER BY api_version",
      )
      .all(row.application_id, row.name)
      .map((sibling) => ({
        id: sibling.id,
        apiVersion: sibling.api_version,
        lifecycle: sibling.lifecycle,
        sunsetAt: sibling.sunset_at,
        current: sibling.id === row.id,
      }))
  );
}

/** It prefills a base path, so it stays path-safe, and two versions may not differ by case. */
function assertApiVersion(value: string): void {
  if (!API_VERSION_PATTERN.test(value)) {
    throw badRequest(
      "apiVersion: expected 1-32 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]*$, e.g. \"v1\" or \"2024-11-01\"",
    );
  }
}

/**
 * The operation ids this API's latest revision declares, or `null` when it has no revision yet or
 * one compiled before the index existed — in which case a per-operation override cannot be checked
 * and is allowed through rather than refused on a guess.
 */
function operationIdsOf(ctx: Ctx, resourceId: string): Set<string> | null {
  const row = ctx.app.db
    .query<{ index_json: string | null }, [string]>(
      "SELECT index_json FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT 1",
    )
    .get(resourceId);
  if (!row?.index_json) return null;
  try {
    return new Set((JSON.parse(row.index_json) as Array<{ id: string }>).map((op) => op.id));
  } catch {
    return null;
  }
}

/** Design section 5.3: the same allowlist that gates a backend gates a server-side spec fetch. */
async function fetchSpec(ctx: Ctx, specUrl: string): Promise<string> {
  const errors = await checkEgress(specUrl, ctx.app.config.integrations, "specUrl");
  if (errors.length > 0) throw badRequest(errors.join("; "));

  // G4 §8.5: through the estate's trust anchors, so a spec served by an internal host with an
  // internally-issued certificate is importable without an exception — and without turning
  // verification off, which the control plane never does.
  let response: Response;
  try {
    response = await trustedFetch(ctx.app.db)(specUrl, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw badGateway(unreachableSpecUrl(specUrl, err as Error));
  }
  if (response.status >= 300 && response.status < 400) {
    throw badRequest(
      `the spec URL redirected to ${response.headers.get("location") ?? "elsewhere"}; ` +
        "redirects are never followed (design section 5.3)",
    );
  }
  if (!response.ok) throw badRequest(`fetching the spec returned HTTP ${response.status}`);

  const max = ctx.app.config.maxSpecBytes;
  const reader = response.body?.getReader();
  if (!reader) throw badRequest("the spec URL returned an empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw badRequest(`the spec is larger than MAX_SPEC_BYTES (${max})`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

interface RevisionSource {
  raw: string;
  model: ApiModel;
  format: OriginalFormat;
  /** The live endpoint this came from, or `null` for an uploaded document. */
  discoveredFrom: string | null;
  /**
   * How this revision came to exist (G3, plan §4). `resource.discovery_url` is per resource, so it
   * cannot answer this for a revision — and the revision list promises the answer per row.
   */
  provenance: RevisionProvenance;
  /** The URL, or the revision copied from. `null` for an upload, which has no detail to give. */
  provenanceDetail: string | null;
}

export type RevisionProvenance = "upload" | "url" | "discovery" | "copied" | "corrected";

/**
 * One spine, four dialects (design section 4.1). The variant decides which normaliser runs, and a
 * document that does not match the variant is an error rather than a guess — publishing a WSDL as
 * a `rest` API would produce an API with no operations and no explanation.
 *
 * `mcp` and `a2a` add a third way in: a URL that is *asked* rather than downloaded. The result is
 * frozen as `original` all the same, so the two paths converge here and everything downstream —
 * digest, dedupe, compile, promote — is one code path.
 */
export async function revisionSource(
  ctx: Ctx,
  row: Pick<ResourceRow, "kind">,
  body: { specUrl?: string; spec?: unknown; discoverUrl?: string },
): Promise<RevisionSource> {
  const maxBytes = ctx.app.config.maxSpecBytes;
  const discoverable = row.kind === "mcp" || row.kind === "a2a";
  // Recorded once, here, because this is the only place that knows which way in was taken.
  const provenance: Pick<RevisionSource, "provenance" | "provenanceDetail"> = body.discoverUrl
    ? { provenance: "discovery", provenanceDetail: body.discoverUrl }
    : body.specUrl
      ? { provenance: "url", provenanceDetail: body.specUrl }
      : { provenance: "upload", provenanceDetail: null };

  if (body.discoverUrl && !discoverable) {
    throw badRequest(
      `discoverUrl is for mcp and a2a APIs, which are published by asking the endpoint what it ` +
        `offers. This is a ${row.kind} API; use specUrl or spec.`,
    );
  }

  if (body.discoverUrl && row.kind === "mcp") {
    const manifest = await discoverMcp(body.discoverUrl, {
      integrations: ctx.app.config.integrations,
      maxBytes,
      fetchImpl: trustedFetch(ctx.app.db),
    });
    const raw = JSON.stringify(manifest, null, 2);
    assertSize(raw, maxBytes);
    return { raw, ...normalizeMcp(raw), discoveredFrom: body.discoverUrl, ...provenance };
  }
  if (body.discoverUrl && row.kind === "a2a") {
    const { raw } = await discoverA2a(body.discoverUrl, {
      integrations: ctx.app.config.integrations,
      maxBytes,
      fetchImpl: trustedFetch(ctx.app.db),
    });
    assertSize(raw, maxBytes);
    return { raw, ...normalizeA2a(raw), discoveredFrom: body.discoverUrl, ...provenance };
  }

  let raw: string;
  if (body.specUrl) raw = await fetchSpec(ctx, body.specUrl);
  else if (typeof body.spec === "string") raw = body.spec;
  else if (body.spec && typeof body.spec === "object") raw = JSON.stringify(body.spec);
  else if (discoverable) throw badRequest("expected either discoverUrl or spec");
  else throw badRequest("expected either specUrl or spec");
  assertSize(raw, maxBytes);

  if (row.kind === "soap") {
    if (!looksLikeWsdl(raw)) {
      throw badRequest("this is a soap API, so the definition must be a WSDL 1.1 document");
    }
    return {
      raw,
      model: normalizeWsdl(raw, ctx.app.config.integrations.xml).model,
      format: "wsdl-1.1",
      discoveredFrom: null,
      ...provenance,
    };
  }
  if (row.kind === "mcp") {
    if (!looksLikeMcpManifest(raw)) {
      throw badRequest(
        "this is an mcp API, so the definition must be a discovered manifest — an object with " +
          "serverInfo and capabilities. Pass discoverUrl to ask a running server for one.",
      );
    }
    return { raw, ...normalizeMcp(raw), discoveredFrom: null, ...provenance };
  }
  if (row.kind === "a2a") {
    if (!looksLikeAgentCard(raw)) {
      throw badRequest(
        "this is an a2a API, so the definition must be an Agent Card — an object with a name and " +
          "skills or capabilities. Pass discoverUrl to fetch one from a running agent.",
      );
    }
    return { raw, ...normalizeA2a(raw), discoveredFrom: null, ...provenance };
  }
  if (looksLikeWsdl(raw)) {
    throw badRequest("this looks like a WSDL, but the API's kind is rest; create a soap API for a WSDL");
  }
  return { raw, ...normalizeSpec(raw), discoveredFrom: null, ...provenance };
}

/**
 * A fetch that never got an answer, said in terms of what to do about it. The TLS case is worth
 * naming: after G4 the remedy is "register the CA that signed it" (§8.5), and a bare
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` in a 500 sends people to turn verification off instead.
 */
function unreachableSpecUrl(specUrl: string, err: Error): string {
  const message = err.message;
  if (/certificate|SSL|self.signed|TLS/i.test(message) || /CERT|SIGNATURE/.test(err.name)) {
    return (
      `specUrl: the TLS certificate of ${new URL(specUrl).host} could not be verified (${message}). ` +
      "If this is an internal host, register the certificate authority that signed it under " +
      "Trust — the control plane never skips verification"
    );
  }
  return `specUrl: ${new URL(specUrl).host} could not be reached (${message})`;
}

function assertSize(raw: string, maxBytes: number): void {
  if (raw.length > maxBytes) {
    throw badRequest(`the definition is larger than MAX_SPEC_BYTES (${maxBytes})`);
  }
}

/** Which `original_format`s belong to which kind of contract (plan §7.3, review `[P1-16]`). */
const FORMAT_FAMILY: Record<string, OriginalFormat[]> = {
  rest: ["swagger-2.0", "openapi-3.0", "openapi-3.1"],
  soap: ["wsdl-1.1"],
  mcp: ["mcp-manifest"],
  a2a: ["a2a-agent-card"],
};

interface RevisionListRow {
  id: string;
  rev: number;
  version_digest: string;
  original_format: string;
  artifact_digest: string | null;
  index_json: string | null;
  frozen_at: string | null;
  pruned_at: string | null;
  source: string;
  source_detail: string | null;
  created_by: string;
  created_at: string;
  original_bytes: number | null;
}

/**
 * One row of the revision list. "Where is this released" is answered per environment in three
 * states rather than two: `live` now, `previously` live (so it is a rollback target somebody may
 * still want), or `never`.
 */
function revisionListView(
  revision: RevisionListRow,
  releases: Array<{ revision_id: string; environment: string; state: string }>,
) {
  const releasedIn: Record<string, "live" | "previously" | "never"> = {};
  for (const release of releases) {
    if (release.revision_id !== revision.id) continue;
    const current = releasedIn[release.environment];
    if (release.state === "converged") releasedIn[release.environment] = "live";
    else if (REACHED_FLEET_STATES.includes(release.state as never) && current !== "live") {
      releasedIn[release.environment] = "previously";
    } else if (!current) releasedIn[release.environment] = "never";
  }

  // What of this contract can be validated, from the operation index rather than re-derived: an
  // owner reading "3 unsupported" here is reading the same number the gateway acts on.
  const schemaStates = { ok: 0, "no-schema": 0, "unsupported-schema": 0 };
  if (revision.index_json) {
    try {
      for (const operation of JSON.parse(revision.index_json) as ConfigOperation[]) {
        const state = operation.schemaState ?? "no-schema";
        if (state in schemaStates) schemaStates[state] += 1;
      }
    } catch {
      // An index written by an older build; the counts stay zero rather than failing the list.
    }
  }

  return {
    id: revision.id,
    rev: revision.rev,
    versionDigest: revision.version_digest,
    originalFormat: revision.original_format,
    originalBytes: revision.original_bytes ?? 0,
    artifactDigest: revision.artifact_digest || null,
    operations: Object.values(schemaStates).reduce((sum, count) => sum + count, 0),
    schemaStates,
    frozenAt: revision.frozen_at,
    prunedAt: revision.pruned_at,
    /** `upload` | `url` | `discovery` | `copied` | `corrected` (plan §4). */
    source: revision.source,
    sourceDetail: revision.source_detail,
    createdBy: revision.created_by,
    createdAt: revision.created_at,
    releasedIn,
    /** What may be done with it, so the UI does not have to re-derive the same three rules. */
    editable: revision.frozen_at === null && revision.pruned_at === null,
    diffable: revision.pruned_at === null,
  };
}

interface DiffRevisionRow {
  id: string;
  resource_id: string;
  rev: number;
  version_digest: string;
  model: string;
  pruned_at: string | null;
}

const DIFF_COLUMNS = "id, resource_id, rev, version_digest, model, pruned_at";

function revisionForDiff(ctx: Ctx, id: string): DiffRevisionRow {
  const row = ctx.app.db
    .query<DiffRevisionRow, [string]>(`SELECT ${DIFF_COLUMNS} FROM revision WHERE id = ?`)
    .get(id);
  if (!row) throw notFound(`no revision ${id}`);
  // Readable by anyone with a session, like the rest of the catalog: a contract is not a secret.
  getResource(ctx, row.resource_id);
  return row;
}

function previousRevision(ctx: Ctx, to: DiffRevisionRow): DiffRevisionRow | null {
  return (
    ctx.app.db
      .query<DiffRevisionRow, [string, number]>(
        `SELECT ${DIFF_COLUMNS} FROM revision
          WHERE resource_id = ? AND rev < ? ORDER BY rev DESC LIMIT 1`,
      )
      .get(to.resource_id, to.rev) ?? null
  );
}

/**
 * `from` is a rev number of the same API, or the id of any revision in the same **version
 * family** — the same application and name at another `api_version`, which is what makes "what changed
 * between v1 and v2" answerable. Anything else is refused rather than diffed, because two
 * unrelated contracts produce a diff in which everything is removed and everything is added.
 */
function resolveDiffFrom(ctx: Ctx, to: DiffRevisionRow, from: string): DiffRevisionRow {
  if (/^\d+$/.test(from)) {
    const row = ctx.app.db
      .query<DiffRevisionRow, [string, number]>(
        `SELECT ${DIFF_COLUMNS} FROM revision WHERE resource_id = ? AND rev = ?`,
      )
      .get(to.resource_id, Number(from));
    if (!row) throw notFound(`this API has no revision ${from}`);
    return row;
  }
  const row = revisionForDiff(ctx, from);
  if (row.resource_id !== to.resource_id) {
    const left = getResource(ctx, row.resource_id);
    const right = getResource(ctx, to.resource_id);
    if (left.application_id !== right.application_id || left.name !== right.name) {
      throw badRequest(
        `${left.name} ${left.api_version} and ${right.name} ${right.api_version} are different ` +
          "APIs, not two versions of one, so a diff between them would say that everything changed",
      );
    }
  }
  return row;
}

/**
 * `If-Match` against the revision's `version_digest` rather than the resource's ETag: what must
 * not have moved under the caller is the document they are replacing (design §14).
 */
function assertRevisionMatch(ctx: Ctx, versionDigest: string): void {
  const header = ctx.req.headers.get("if-match");
  if (!header) {
    throw new HttpError(
      428,
      "Precondition Required",
      "If-Match is required: send back the revision's versionDigest, so a correction cannot " +
        "overwrite a definition somebody else replaced in the meantime",
    );
  }
  const presented = header.split(",").map((value) => value.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!presented.includes("*") && !presented.includes(versionDigest)) {
    throw new HttpError(
      412,
      "Precondition Failed",
      `If-Match does not match this revision's current digest ${versionDigest}; somebody else ` +
        "changed it",
    );
  }
}

/** The half of a revision that is the same whichever dialect it arrived in. */
export function writeRevision(
  ctx: Ctx,
  row: ResourceRow,
  source: RevisionSource,
  action: "revision.create" | "revision.regenerate",
): Response {
  const user = requireUser(ctx);
  const versionDigest = digestOf(source.model);

  const latest = ctx.app.db
    .query<{ id: string; rev: number; version_digest: string }, [string]>(
      "SELECT id, rev, version_digest FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT 1",
    )
    .get(row.id);

  // Remembered even when nothing changed: a resource re-discovered from a new URL should
  // regenerate from that one next time.
  if (source.discoveredFrom && source.discoveredFrom !== row.discovery_url) {
    ctx.app.db.run("UPDATE resource SET discovery_url = ? WHERE id = ?", [
      source.discoveredFrom,
      row.id,
    ]);
  }

  // The same document twice is not a new revision (the digest is over the normalized model, so
  // a reformatted upload is the same document). For `regenerate` this is the common case, and
  // saying so is the point: "nothing changed" is the answer an operator wants.
  if (latest && latest.version_digest === versionDigest) {
    return json(
      { id: latest.id, rev: latest.rev, versionDigest, unchanged: true, model: source.model },
      { status: 200 },
    );
  }

  // Compiled here rather than at release (plan `[R3-01]`): attaching `validate` to an API that
  // was released months ago has to work, and one contract compiles once however many
  // environments it reaches. An operation whose schema this cannot compile is reported and left
  // unvalidated — refusing the import would make one unsupported keyword block the whole API.
  let compiled: { digest: string | null; index: ConfigOperation[]; notes: string[] };
  try {
    compiled = compileAndStore(ctx.app.db, source.model, ctx.app.config.artifactMaxBytes);
  } catch (err) {
    throw badRequest(`this definition could not be prepared for validation: ${(err as Error).message}`);
  }

  const id = newId("rev");
  const rev = (latest?.rev ?? 0) + 1;
  ctx.app.db.run(
    `INSERT INTO revision (id, resource_id, rev, model, original, original_format, version_digest,
                           artifact_digest, index_json, source, source_detail, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.id,
      rev,
      JSON.stringify(source.model),
      source.raw,
      source.format,
      versionDigest,
      // `''` rather than NULL for "compiled, nothing to compile": NULL is what the backfill job
      // looks for, and a revision that has been compiled must not be picked up again.
      compiled.digest ?? "",
      JSON.stringify(compiled.index),
      source.provenance,
      source.provenanceDetail,
      user.id,
      nowIso(),
    ],
  );
  touch(ctx, row.id);
  // The contract is half of what the catalog indexes — operation ids, MCP tool names, A2A skills.
  reindexResource(ctx.app.db, row.id);
  writeAudit(ctx.app.db, {
    actor: user.id,
    action,
    subject: `revision:${id}`,
    outcome: "ok",
    detail: {
      resourceId: row.id,
      rev,
      format: source.format,
      versionDigest,
      artifact: compiled.digest ?? null,
      ...(source.discoveredFrom ? { discoveredFrom: source.discoveredFrom } : {}),
    },
  });
  return json(
    {
      id,
      rev,
      versionDigest,
      format: source.format,
      unchanged: false,
      model: source.model,
      artifactDigest: compiled.digest,
      operations: compiled.index.length,
      // What will not be validated, and why. Surfaced on the import screen next to the model.
      validationNotes: compiled.notes,
      ...(source.discoveredFrom ? { discoveredFrom: source.discoveredFrom } : {}),
    },
    { status: 201 },
  );
}

export function registerResourceRoutes(router: Router): void {
  // ---------------------------------------------------------------- resources

  router.add("GET", "/api/resources", "session", (ctx) => {
    const user = requireUser(ctx);
    const page = pageOf(ctx);
    const q = ctx.url.searchParams.get("q");
    const kind = ctx.url.searchParams.get("kind");
    const mine = ctx.url.searchParams.get("application") === "mine";

    let sql = "SELECT * FROM resource WHERE 1 = 1";
    const args: unknown[] = [];
    if (q) {
      sql += " AND name LIKE ?";
      args.push(`%${q}%`);
    }
    if (kind) {
      sql += " AND kind = ?";
      args.push(kind);
    }
    // Two parameters rather than one packed "application/name" (review V4-02): they compose with the
    // filters above instead of fighting them.
    const family = ctx.url.searchParams.get("name");
    if (family) {
      sql += " AND name = ?";
      args.push(family);
    }
    const application = ctx.url.searchParams.get("application");
    if (application && application !== "mine") {
      sql += " AND application_id = ?";
      args.push(application);
    }
    if (mine && !user.isAdmin) {
      const placeholders = user.applications.map(() => "?").join(",") || "''";
      sql += ` AND application_id IN (${placeholders})`;
      args.push(...user.applications);
    }
    sql += " ORDER BY name, api_version LIMIT ? OFFSET ?";
    args.push(page.limit, page.offset);

    const rows = ctx.app.db.query(sql).all(...(args as never[])) as ResourceRow[];
    // Where each one is live, for the whole page in one statement. "My APIs" cannot show a
    // per-environment state without it, and the alternative is one request per row from the
    // browser — which is the same query, N times, over the network.
    const liveIn = new Map<string, string[]>();
    if (rows.length > 0) {
      for (const release of ctx.app.db
        .query<{ resource_id: string; environment: string }, string[]>(
          `SELECT resource_id, environment FROM release
            WHERE state = 'converged' AND resource_id IN (${rows.map(() => "?").join(", ")})
            ORDER BY environment`,
        )
        .all(...rows.map((row) => row.id))) {
        liveIn.set(release.resource_id, [
          ...(liveIn.get(release.resource_id) ?? []),
          release.environment,
        ]);
      }
    }

    return json({
      items: rows.map((row) => ({ ...resourceView(ctx, row), liveIn: liveIn.get(row.id) ?? [] })),
      nextCursor: nextCursor(page, rows.length),
    });
  });

  router.add("POST", "/api/resources", "session", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson<{
      kind?: string;
      name?: string;
      applicationId?: string;
      apiVersion?: string;
      domain?: string;
      subdomain?: string;
    }>(ctx);
    const kind = body.kind ?? "rest";
    if (!RESOURCE_KINDS.includes(kind as never)) {
      throw badRequest(
        `kind "${kind}" is not implemented in the MVP (the variant set is closed: ${RESOURCE_KINDS.join(", ")})`,
      );
    }
    if (!body.name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }
    const applicationId = body.applicationId ?? user.applications[0];
    if (!applicationId) throw badRequest("applicationId: required, you are not a member of any application");
    assertCan(user, applicationId, "create a resource for this application");
    const apiVersion = body.apiVersion ?? "v1";
    assertApiVersion(apiVersion);
    // Optional here and required at `PUT routes`: a draft nobody can call yet does not need a place
    // in the taxonomy, but nothing gets an address without one.
    const domain = body.domain?.trim() || null;
    const subdomain = body.subdomain?.trim() || null;
    if (domain) {
      const problem = domainError(domain, subdomain);
      if (problem) throw badRequest(problem);
    } else if (subdomain) {
      throw badRequest("subdomain: a subdomain without a domain has nothing to sit under");
    }

    const id = newId("res");
    const at = nowIso();
    try {
      ctx.app.db.run(
        `INSERT INTO resource (id, kind, name, application_id, api_version, lifecycle, domain, subdomain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [id, kind, body.name, applicationId, apiVersion, domain, subdomain, at, at],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`this application already has an API named ${body.name} at version ${apiVersion}`);
      }
      throw err;
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "resource.create",
      subject: `resource:${id}`,
      outcome: "ok",
      detail: { name: body.name, kind, applicationId, domain, subdomain },
    });
    // Searchable from the moment it exists — a publisher who cannot find their own draft in the
    // catalog assumes the create failed.
    reindexResource(ctx.app.db, id);
    return json(resourceView(ctx, getResource(ctx, id)), { status: 201 });
  });

  router.add("GET", "/api/resources/:id", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const db = ctx.app.db;
    // Revision metadata only: `model` is tens of kilobytes and has its own endpoint.
    const revisions = db
      .query(
        `SELECT id, rev, version_digest, original_format, frozen_at, created_by, created_at
           FROM revision WHERE resource_id = ? ORDER BY rev DESC`,
      )
      .all(row.id) as Array<Record<string, unknown>>;
    // Aliased, because the column name is not the API's vocabulary: every other endpoint that
    // returns a route — the catalog listing, the playground form — says `basePath`, and so does
    // every endpoint that accepts one.
    const routes = db
      .query("SELECT environment, host, base_path AS basePath FROM route WHERE resource_id = ?")
      .all(row.id);
    const bindings = db.query("SELECT environment, backend_json FROM binding WHERE resource_id = ?").all(
      row.id,
    ) as Array<{ environment: string; backend_json: string }>;
    const releases = db
      .query(
        `SELECT rel.id, rel.environment, rel.state, rel.reason, rel.released_by, rel.released_at, rev.rev
           FROM release rel JOIN revision rev ON rev.id = rel.revision_id
          WHERE rel.resource_id = ? ORDER BY rel.released_at DESC LIMIT 20`,
      )
      .all(row.id);
    const products = db
      .query(
        `SELECT p.id, p.name FROM product_member pm JOIN product p ON p.id = pm.product_id
          WHERE pm.resource_id = ?`,
      )
      .all(row.id);

    return json(
      {
        ...resourceView(ctx, row),
        versions: versionsOf(ctx, row),
        revisions,
        routes,
        bindings: bindings.map((b) => ({ environment: b.environment, backend: JSON.parse(b.backend_json) })),
        releases,
        products,
        // The same rows the dashboard shows, from the one evaluator (plan §6.3, `[P1-04]`): the
        // banner on this page and the list on the home page cannot say different things.
        attention: resourceAttention(ctx.app, requireUser(ctx), row.id),
      },
      { headers: { etag: etagOf(row) } },
    );
  });

  router.add("PATCH", "/api/resources/:id", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "update this resource");
    assertIfMatch(ctx, row);

    const body = await readJson<{
      name?: string;
      apiVersion?: string;
      lifecycle?: string;
      sunsetAt?: string | null;
      summary?: string | null;
      description?: string | null;
      tags?: string[];
      docsUrl?: string | null;
      icon?: string | null;
      visibility?: string;
      domain?: string | null;
      subdomain?: string | null;
    }>(ctx);
    const name = body.name ?? row.name;
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
      throw badRequest("name: expected 2-61 lowercase letters, digits or hyphens");
    }
    const apiVersion = body.apiVersion ?? row.api_version;
    assertApiVersion(apiVersion);
    const lifecycle = body.lifecycle ?? row.lifecycle;
    if (!["active", "deprecated", "retired"].includes(lifecycle)) {
      throw badRequest("lifecycle: expected active, deprecated or retired");
    }
    // Lifecycle is a property of the *version* and is global across the chain: design section
    // 6.1's per-environment tier is policy, route, binding and subscription (review V1-05).
    let sunsetAt = body.sunsetAt === undefined ? row.sunset_at : body.sunsetAt;
    if (sunsetAt !== null && sunsetAt !== undefined) {
      const parsed = new Date(sunsetAt);
      if (Number.isNaN(parsed.getTime())) throw badRequest("sunsetAt: expected an ISO-8601 date or null");
      sunsetAt = parsed.toISOString();
    }

    /*
     * The catalog's marketing metadata (goal G6). It lives on the resource rather than on a
     * separate listing entity, because a listing that can disagree with the thing it lists is a
     * second source of truth — and `visibility` is not marketing at all: it decides whether an
     * A2A agent's card is public (plan `[R1-17]`), so it reaches the gateway's config.
     */
    const summary = body.summary === undefined ? row.summary : body.summary;
    const description = body.description === undefined ? row.description : body.description;
    const docsUrl = body.docsUrl === undefined ? row.docs_url : body.docsUrl;
    const icon = body.icon === undefined ? row.icon : body.icon;
    if (summary !== null && summary !== undefined && summary.length > 200) {
      throw badRequest("summary: at most 200 characters — it is a card subtitle, not the description");
    }
    if (description !== null && description !== undefined && description.length > 20_000) {
      throw badRequest("description: at most 20000 characters");
    }
    let tagsJson = row.tags_json;
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) {
        throw badRequest("tags: expected an array of strings");
      }
      const cleaned = [...new Set(body.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
      if (cleaned.length > 20) throw badRequest("tags: at most 20");
      if (cleaned.some((tag) => tag.length > 40)) throw badRequest("tags: at most 40 characters each");
      tagsJson = JSON.stringify(cleaned);
    }
    const visibility = body.visibility ?? row.visibility;
    if (visibility !== "listed" && visibility !== "unlisted") {
      throw badRequest('visibility: expected "listed" or "unlisted"');
    }

    /*
     * Reclassifying moves the address, and the two have to move together — so a domain change is
     * only accepted while the API has no route yet. Once it is published the portal's configure
     * flow is the way: it rewrites the base path in the same save, in front of the publisher.
     */
    const domain = body.domain === undefined ? row.domain : body.domain?.trim() || null;
    const subdomain = body.subdomain === undefined ? row.subdomain : body.subdomain?.trim() || null;
    if (domain !== row.domain || subdomain !== row.subdomain) {
      if (domain) {
        const problem = domainError(domain, subdomain);
        if (problem) throw badRequest(problem);
      } else if (subdomain) {
        throw badRequest("subdomain: a subdomain without a domain has nothing to sit under");
      }
      const routed = ctx.app.db
        .query<{ environment: string }, [string]>("SELECT environment FROM route WHERE resource_id = ?")
        .all(row.id);
      if (routed.length > 0) {
        throw conflict(
          `the domain is the first segment of this API's address, and it already answers in ` +
            `${routed.map((r) => r.environment).join(", ")} — change it where the address is set, ` +
            "so the route moves with it",
        );
      }
    }

    try {
      ctx.app.db.run(
        `UPDATE resource SET name = ?, api_version = ?, lifecycle = ?, sunset_at = ?,
                summary = ?, description = ?, tags_json = ?, docs_url = ?, icon = ?, visibility = ?,
                domain = ?, subdomain = ?, updated_at = ?
          WHERE id = ?`,
        [
          name,
          apiVersion,
          lifecycle,
          sunsetAt ?? null,
          summary ?? null,
          description ?? null,
          tagsJson,
          docsUrl ?? null,
          icon ?? null,
          visibility,
          domain,
          subdomain,
          nowIso(),
          row.id,
        ],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`this application already has an API named ${name} at version ${apiVersion}`);
      }
      throw err;
    }
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "resource.update",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { name, apiVersion, lifecycle, sunsetAt, visibility, domain, subdomain },
    });
    reindexResource(ctx.app.db, row.id);
    const updated = getResource(ctx, row.id);
    return json(resourceView(ctx, updated), { headers: { etag: etagOf(updated) } });
  });

  router.add("DELETE", "/api/resources/:id", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "delete this resource");

    // Withdraw from every target first, through the same job the withdraw endpoint uses, so the
    // projection has one writer; then the row goes and the rest cascades.
    for (const target of ctx.app.db.query("SELECT id FROM target").all() as Array<{ id: string }>) {
      enqueueJob(
        ctx.app.db,
        "reconcile",
        { targetId: target.id, resourceId: row.id, intent: "remove" },
        `reconcile:remove:${target.id}:${row.id}:${Date.now()}`,
      );
    }
    runDueJobs(ctx.app);
    ctx.app.db.run("DELETE FROM resource WHERE id = ?", [row.id]);
    // FTS5 rows are not foreign keys, so nothing cascades them: a deleted resource that stayed in
    // the catalog would be a listing nobody can open.
    reindexResource(ctx.app.db, row.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "resource.delete",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { name: row.name },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------- versions (G2)

  /**
   * A consumer-visible version is a resource (plan section 8). The sibling starts from the
   * source's newest revision as its own rev 1 — unfrozen, because it is a new contract line.
   */
  /**
   * Where the new version answers. Never a copy of the source's base path — that would violate
   * UNIQUE(environment, host, base_path) on arrival (review V4-03) — and never `/name/version`
   * either once the API has a domain, because the domain is the first segment of the address and a
   * version that dropped it would be the one route in the estate you could not find by domain.
   *
   * Every published address ends in its version, so this is the same shape v1 already has: the
   * sibling differs in one segment, which is what makes two versions answering at once legible.
   */
  const versionBasePath = (row: ResourceRow, apiVersion: string) =>
    row.domain
      ? publishedPath({
          domain: row.domain,
          subdomain: row.subdomain,
          name: row.name,
          apiVersion,
        })
      : `/${row.name}/${apiVersion}`;

  router.add("POST", "/api/resources/:id/versions", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "create a version of this resource");

    const body = await readJson<{
      apiVersion?: string;
      copyPolicyFrom?: string;
      createRoutes?: boolean;
    }>(ctx);
    const apiVersion = (body.apiVersion ?? "").trim();
    assertApiVersion(apiVersion);
    if (apiVersion.toLowerCase() === row.api_version.toLowerCase()) {
      throw conflict(`this API is already at version ${row.api_version}`);
    }

    const db = ctx.app.db;
    const source = db
      .query<
        {
          id: string;
          model: string;
          original: string;
          original_format: string;
          version_digest: string;
          artifact_digest: string | null;
          index_json: string | null;
        },
        [string]
      >(
        `SELECT id, model, original, original_format, version_digest, artifact_digest, index_json
           FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT 1`,
      )
      .get(row.id);
    if (!source) throw conflict("this API has no revision yet, so there is nothing to version");

    const newResourceId = newId("res");
    const at = nowIso();
    const skipped: string[] = [];

    const create = db.transaction(() => {
      db.run(
        `INSERT INTO resource (id, kind, name, application_id, api_version, lifecycle, domain, subdomain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [
          newResourceId,
          row.kind,
          row.name,
          row.application_id,
          apiVersion,
          // A version is the same API in the same domain. Asking again here would let two versions
          // of one thing sit in different parts of the catalog.
          row.domain,
          row.subdomain,
          at,
          at,
        ],
      );
      db.run(
        `INSERT INTO revision (id, resource_id, rev, model, original, original_format, version_digest,
                               artifact_digest, index_json, source, source_detail, created_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'copied', ?, ?, ?)`,
        [
          newId("rev"),
          newResourceId,
          source.model,
          source.original,
          source.original_format,
          source.version_digest,
          // The same model compiles to the same content address, so the new version shares the
          // stored bundle rather than compiling an identical one (design section 4.1).
          source.artifact_digest,
          source.index_json,
          // Which revision this version started from — the question somebody asks six months
          // later when the two versions have drifted (plan §7.1).
          `revision:${source.id}`,
          user.id,
          at,
        ],
      );

      if (body.copyPolicyFrom) {
        if (!ctx.app.config.promotionChain.includes(body.copyPolicyFrom)) {
          throw badRequest(`unknown environment "${body.copyPolicyFrom}"`);
        }
        db.run(
          `INSERT INTO policy_entry (resource_id, environment, unit_key, value_json, origin,
                                     updated_by, updated_at)
           SELECT ?, environment, unit_key, value_json, 'local', ?, ?
             FROM policy_entry WHERE resource_id = ? AND environment = ?`,
          [newResourceId, user.id, at, row.id, body.copyPolicyFrom],
        );
      }

      if (body.createRoutes) {
        // Never a copy of the source's base path — that would violate
        // UNIQUE(environment, host, base_path) on arrival (review V4-03).
        const proposed = versionBasePath(row, apiVersion);
        const sourceRoutes = db
          .query<{ environment: string; host: string }, [string]>(
            "SELECT environment, host FROM route WHERE resource_id = ?",
          )
          .all(row.id);
        for (const route of sourceRoutes) {
          const taken = db
            .query("SELECT 1 FROM route WHERE environment = ? AND host = ? AND base_path = ?")
            .get(route.environment, route.host, proposed);
          if (taken) {
            skipped.push(route.environment);
            continue;
          }
          db.run(
            "INSERT INTO route (resource_id, environment, host, base_path) VALUES (?, ?, ?, ?)",
            [newResourceId, route.environment, route.host, proposed],
          );
        }
      }
    });

    try {
      create();
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(`${row.name} already has a version ${apiVersion}`);
      }
      throw err;
    }

    writeAudit(db, {
      actor: user.id,
      action: "resource.version",
      subject: `resource:${newResourceId}`,
      outcome: "ok",
      detail: { from: row.id, name: row.name, apiVersion, skippedRoutes: skipped },
    });

    return json(
      {
        ...resourceView(ctx, getResource(ctx, newResourceId)),
        proposedBasePath: versionBasePath(row, apiVersion),
        skippedRouteEnvironments: skipped,
      },
      { status: 201 },
    );
  });

  // ---------------------------------------------------------------- revisions

  router.add("POST", "/api/resources/:id/revisions", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "add a revision to this resource");

    const body = await readJson<{ specUrl?: string; spec?: unknown; discoverUrl?: string }>(
      ctx,
      ctx.app.config.maxSpecBytes + 4096,
    );
    const source = await revisionSource(ctx, row, body);
    return writeRevision(ctx, row, source, "revision.create");
  });

  /**
   * Re-runs discovery for a resource that was published from a live endpoint (goal G4/G5).
   *
   * A new **unreleased** revision when the contract changed, exactly as a Kafka schema change
   * produces one (design section 8.10). Never an in-place edit: an MCP server that renamed a tool
   * has changed its contract, and a platform that quietly followed it would break the consumers
   * that subscribed to the old one without anybody deciding to.
   */
  router.add("POST", "/api/resources/:id/regenerate", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "regenerate this resource's contract");
    if (!row.discovery_url) {
      throw badRequest(
        `${row.name} was not published from a live endpoint, so there is nothing to re-discover. ` +
          "Upload a new definition instead.",
      );
    }
    const source = await revisionSource(ctx, row, { discoverUrl: row.discovery_url });
    return writeRevision(ctx, row, source, "revision.regenerate");
  });

  /**
   * The revision list (G3, plan §7.1). `GET /api/resources/:id` carries the same rows in its
   * summary; this one answers the questions that page has no room for — where each revision is
   * released, how it came to exist, what of it can be validated, and whether its content is still
   * here at all.
   */
  router.add("GET", "/api/resources/:id/revisions", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const page = pageOf(ctx);
    const rows = ctx.app.db
      .query<RevisionListRow, [string, number, number]>(
        `SELECT id, rev, version_digest, original_format, artifact_digest, index_json,
                frozen_at, pruned_at, source, source_detail, created_by, created_at,
                LENGTH(original) AS original_bytes
           FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT ? OFFSET ?`,
      )
      .all(row.id, page.limit, page.offset);

    const releases = ctx.app.db
      .query<{ revision_id: string; environment: string; state: string }, [string]>(
        "SELECT revision_id, environment, state FROM release WHERE resource_id = ?",
      )
      .all(row.id);

    return json({
      resourceId: row.id,
      items: rows.map((revision) => revisionListView(revision, releases)),
      nextCursor: nextCursor(page, rows.length),
    });
  });

  /**
   * The structural diff (plan §7.2). `from` is a revision id or a rev number; the answer is
   * computed from two normalized models, so it needs no storage and a reformatted upload diffs as
   * no change.
   */
  router.add("GET", "/api/revisions/:id/diff", "session", (ctx) => {
    const to = revisionForDiff(ctx, ctx.params.id!);
    const fromParam = ctx.url.searchParams.get("from");
    const from = fromParam
      ? resolveDiffFrom(ctx, to, fromParam)
      : previousRevision(ctx, to) ??
        (() => {
          throw badRequest(
            `revision ${to.rev} is the first of this API, so there is nothing to compare it with. ` +
              "Pass ?from= a revision of another version to compare across versions",
          );
        })();

    for (const side of [
      { label: "from", revision: from },
      { label: "to", revision: to },
    ]) {
      if (side.revision.pruned_at) {
        // Design section 4.1's tombstone: the row survives so releases and audit still resolve,
        // but its content is gone, and pretending the diff is empty would be the worse answer.
        throw conflict(
          `the ${side.label} side (revision ${side.revision.rev}) was pruned on ` +
            `${side.revision.pruned_at}, so its definition is no longer stored and cannot be diffed`,
        );
      }
    }

    const diff = diffModels(
      JSON.parse(from.model) as ApiModel,
      JSON.parse(to.model) as ApiModel,
    );
    return json({
      from: { id: from.id, rev: from.rev, resourceId: from.resource_id, versionDigest: from.version_digest },
      to: { id: to.id, rev: to.rev, resourceId: to.resource_id, versionDigest: to.version_digest },
      ...diff,
    });
  });

  /**
   * Correcting a draft in place (design §14, plan §7.3). Only while the revision is unfrozen: once
   * it has been released, the contract somebody else is running is not something to edit under
   * them, and the alternative — a new revision — is offered in the refusal.
   */
  router.add("PUT", "/api/revisions/:id/spec", "session", async (ctx) => {
    const user = requireUser(ctx);
    const revision = ctx.app.db
      .query<
        {
          id: string;
          resource_id: string;
          rev: number;
          version_digest: string;
          artifact_digest: string | null;
          frozen_at: string | null;
          pruned_at: string | null;
        },
        [string]
      >(
        `SELECT id, resource_id, rev, version_digest, artifact_digest, frozen_at, pruned_at
           FROM revision WHERE id = ?`,
      )
      .get(ctx.params.id!);
    if (!revision) throw notFound(`no revision ${ctx.params.id}`);
    const row = getResource(ctx, revision.resource_id);
    // The owning application or an admin, like every other write on a resource (review `[P2-08]`).
    assertCan(user, row.application_id, "correct this revision");

    if (revision.pruned_at) {
      throw conflict(
        `revision ${revision.rev} was pruned on ${revision.pruned_at}: its definition is no longer ` +
          "stored, so there is nothing to correct. Upload a new revision instead",
      );
    }
    if (revision.frozen_at) {
      const released = ctx.app.db
        .query<{ environment: string; released_at: string }, [string]>(
          `SELECT environment, released_at FROM release
            WHERE revision_id = ? ORDER BY released_at LIMIT 1`,
        )
        .get(revision.id);
      throw conflict(
        `revision ${revision.rev} was released${released ? ` to ${released.environment.toUpperCase()} on ${released.released_at}` : ""} ` +
          `and cannot change; create revision ${revision.rev + 1} instead`,
        {
          revision: revision.rev,
          nextAction: { method: "POST", href: `/api/resources/${row.id}/revisions` },
        },
      );
    }
    assertRevisionMatch(ctx, revision.version_digest);

    const body = await readJson<{ specUrl?: string; spec?: unknown; discoverUrl?: string }>(
      ctx,
      ctx.app.config.maxSpecBytes + 4096,
    );
    const source = await revisionSource(ctx, row, body);
    // A WSDL replacing an OpenAPI would leave routing, validation and the catalog describing a
    // different shape of contract under an unchanged rev number (review `[P1-16]`).
    const family = FORMAT_FAMILY[row.kind] ?? [];
    if (!family.includes(source.format)) {
      throw badRequest(
        `this is a ${row.kind} API, so a revision's definition must be ${family.join(" or ")} — ` +
          `this one is ${source.format}. Correcting a revision cannot change what kind of ` +
          "contract it is",
      );
    }

    const versionDigest = digestOf(source.model);
    if (versionDigest === revision.version_digest) {
      // The same document twice, matching v1's `[R2-01]`: an idempotent no-op, not a 409.
      return json({ id: revision.id, rev: revision.rev, versionDigest, unchanged: true });
    }

    let compiled: { digest: string | null; index: ConfigOperation[]; notes: string[] };
    try {
      compiled = compileAndStore(ctx.app.db, source.model, ctx.app.config.artifactMaxBytes);
    } catch (err) {
      throw badRequest(`this definition could not be prepared for validation: ${(err as Error).message}`);
    }

    const previousDigest = revision.version_digest;
    ctx.app.db.run(
      `UPDATE revision
          SET model = ?, original = ?, original_format = ?, version_digest = ?, artifact_digest = ?,
              index_json = ?, source = 'corrected', source_detail = ?
        WHERE id = ?`,
      [
        JSON.stringify(source.model),
        source.raw,
        source.format,
        versionDigest,
        compiled.digest ?? "",
        JSON.stringify(compiled.index),
        `replaced ${previousDigest}`,
        revision.id,
      ],
    );
    touch(ctx, row.id);
    reindexResource(ctx.app.db, row.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "revision.correct",
      subject: `revision:${revision.id}`,
      outcome: "ok",
      detail: {
        resourceId: row.id,
        rev: revision.rev,
        format: source.format,
        replacedDigest: previousDigest,
        versionDigest,
      },
    });
    return json({
      id: revision.id,
      rev: revision.rev,
      versionDigest,
      replacedDigest: previousDigest,
      format: source.format,
      unchanged: false,
      artifactDigest: compiled.digest,
      operations: compiled.index.length,
      validationNotes: compiled.notes,
    });
  });

  router.add("GET", "/api/revisions/:id/spec", "session", (ctx) => {
    const rev = ctx.app.db
      .query<{ id: string; model: string; original: string; original_format: string }, [string]>(
        "SELECT id, model, original, original_format FROM revision WHERE id = ?",
      )
      .get(ctx.params.id!);
    if (!rev) throw notFound(`no revision ${ctx.params.id}`);

    const isWsdl = rev.original_format === "wsdl-1.1";
    const format = ctx.url.searchParams.get("format") ?? (isWsdl ? "model" : "openapi-3.1");
    if (format === "original") {
      return new Response(rev.original, {
        headers: {
          "content-type": isWsdl ? "text/xml; charset=utf-8" : "application/json; charset=utf-8",
          "x-original-format": rev.original_format,
        },
      });
    }
    const model = JSON.parse(rev.model) as ApiModel;
    // Deviation D13: `soap` exports the original WSDL plus a generated summary of the model.
    // Regenerating WSDL and XSD from the model is a compiler, not a feature of this MVP.
    if (isWsdl) {
      if (format !== "model") throw badRequest('format: expected "model" or "original" for a WSDL');
      return json(toSoapSummary(model));
    }
    if (format !== "openapi-3.1") {
      throw badRequest('format: expected "openapi-3.1" or "original"');
    }
    return json(toOpenApi31(model));
  });

  // ---------------------------------------------------------------- routes and bindings

  router.add("GET", "/api/resources/:id/routes", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    return json({
      items: ctx.app.db
        .query("SELECT environment, host, base_path AS basePath FROM route WHERE resource_id = ?")
        .all(row.id),
    });
  });

  router.add("PUT", "/api/resources/:id/routes", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "set the route for this resource");
    const body = await readJson<{ environment?: string; host?: string; basePath?: string }>(ctx);
    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }

    const host = normalizeHost(body.host);
    const basePath = normalizeBasePath(body.basePath);
    const errors = [...host.errors, ...basePath.errors];
    if (errors.length > 0) throw badRequest(errors.join("; "));

    /*
     * An address is where the taxonomy stops being paperwork: the domain is the first segment of
     * every published path, so a route is the last moment at which an unclassified API can still be
     * caught, and a classified one cannot be given an address that contradicts its classification.
     */
    if (!row.domain) {
      throw badRequest(
        "domain: assign this API to a domain before giving it an address — the domain is the first " +
          "segment of the path, so every consumer of the catalog finds it by domain first",
      );
    }
    const prefix = domainPrefix(row.domain, row.subdomain);
    if (basePath.basePath !== prefix && !basePath.basePath.startsWith(`${prefix}/`)) {
      throw badRequest(
        `basePath: "${basePath.basePath}" is outside ${row.domain}` +
          `${row.subdomain ? ` / ${row.subdomain}` : ""} — it has to start with "${prefix}"`,
      );
    }

    try {
      ctx.app.db.run(
        `INSERT INTO route (resource_id, environment, host, base_path) VALUES (?, ?, ?, ?)
         ON CONFLICT (resource_id, environment) DO UPDATE SET host = excluded.host, base_path = excluded.base_path`,
        [row.id, environment, host.host, basePath.basePath],
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        throw conflict(
          `another API already serves ${host.host}${basePath.basePath} in ${environment} ` +
            "(route uniqueness is UNIQUE(environment, host, base_path), design section 4)",
        );
      }
      throw err;
    }
    touch(ctx, row.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "route.set",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { environment, host: host.host, basePath: basePath.basePath },
    });
    return json({ environment, host: host.host, basePath: basePath.basePath });
  });

  router.add("GET", "/api/resources/:id/binding", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const environment = environmentOf(ctx);
    const binding = ctx.app.db
      .query<{ backend_json: string }, [string, string]>(
        "SELECT backend_json FROM binding WHERE resource_id = ? AND environment = ?",
      )
      .get(row.id, environment);
    return json({ environment, backend: binding ? JSON.parse(binding.backend_json) : null });
  });

  /**
   * Goal G7: a pool rather than a URL, with a load-balancing rule and an optional client identity.
   *
   * `urls: [...]` is still accepted and means an ordered `failover` pool — the reading that changes
   * nothing for a single-backend binding, which is what every existing caller has. `pool` is the
   * shape that can also carry weights.
   *
   * Every URL passes the egress allowlist at write time (design section 5.3), because a pool is
   * exactly as safe as its least-checked member.
   */
  router.add("PUT", "/api/resources/:id/binding", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "set the backend for this resource");
    const body = await readJson<{
      environment?: string;
      urls?: unknown;
      pool?: unknown;
      rule?: unknown;
      clientCertRef?: unknown;
    }>(ctx);
    const environment = body.environment ?? environmentOf(ctx);
    if (!ctx.app.config.promotionChain.includes(environment)) {
      throw badRequest(`unknown environment "${environment}"`);
    }

    const read = await readPool(body, ctx.app.config.integrations);
    if (!read) throw badRequest("expected a non-empty `pool` or `urls` array");
    const { pool, rule } = read;

    let clientCertRef: string | undefined;
    if (body.clientCertRef !== undefined && body.clientCertRef !== null) {
      clientCertRef = String(body.clientCertRef);
      const certificate = ctx.app.db
        .query<{ id: string; application_id: string }, [string, string]>(
          "SELECT id, application_id FROM certificate WHERE id = ? AND environment = ?",
        )
        .get(clientCertRef, environment);
      if (!certificate) {
        throw badRequest(`clientCertRef: no certificate "${clientCertRef}" in ${environment}`);
      }
      // A client identity is key material: an owner may present their own application's, not another's.
      assertCan(user, certificate.application_id, "use that certificate as this backend's client identity");
    }

    const backend: BackendPool = {
      pool,
      rule,
      ...(clientCertRef === undefined ? {} : { clientCertRef }),
    };
    ctx.app.db.run(
      `INSERT INTO binding (resource_id, environment, backend_json) VALUES (?, ?, ?)
       ON CONFLICT (resource_id, environment) DO UPDATE SET backend_json = excluded.backend_json`,
      [row.id, environment, JSON.stringify(backend)],
    );
    touch(ctx, row.id);
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "binding.set",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { environment, ...backend },
    });
    return json({ environment, backend });
  });

  // ---------------------------------------------------------------- policy

  router.add("GET", "/api/resources/:id/policy", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    const environment = environmentOf(ctx);
    const units = ctx.app.db
      .query(
        `SELECT unit_key, value_json, origin, seeded_from_env, updated_by, updated_at
           FROM policy_entry WHERE resource_id = ? AND environment = ? ORDER BY unit_key`,
      )
      .all(row.id, environment) as Array<{
      unit_key: string;
      value_json: string;
      origin: string;
      seeded_from_env: string | null;
      updated_by: string;
      updated_at: string;
    }>;

    return json({
      environment,
      document: policyFor(ctx.app.db, row.id, environment),
      // Advisory, not blocking, and returned on the read rather than only after a write: a
      // warning that appears once when somebody happens to save is a warning nobody sees.
      warnings: lintDocument(policyFor(ctx.app.db, row.id, environment) as Record<string, unknown>, {
        environment,
      }),
      units: units.map((u) => ({
        unitKey: u.unit_key,
        value: JSON.parse(u.value_json),
        origin: u.origin,
        seededFromEnv: u.seeded_from_env,
        updatedBy: u.updated_by,
        updatedAt: u.updated_at,
      })),
      capabilities: capabilitiesFor(ctx.user, row.application_id),
    });
  });

  router.add("PUT", "/api/resources/:id/policy/units/:unitKey", "session", async (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "edit policy for this resource");
    const environment = environmentOf(ctx);
    const unitKey = ctx.params.unitKey!;
    const scoped = parseOperationUnitKey(unitKey);
    if (!scoped && !POLICY_UNITS.includes(unitKey as never)) {
      throw badRequest(
        `unknown policy unit "${unitKey}" (known: ${POLICY_UNITS.join(", ")}, and ` +
          `operations["<id>"].{${OPERATION_OVERRIDABLE.join("|")}})`,
      );
    }
    const body = await readJson<{ value?: unknown }>(ctx);
    const value = body.value;

    const unitErrors = validateUnit(unitKey, value);
    if (unitErrors.length > 0) throw badRequest(unitErrors.join("; "));

    // An override for an operation this contract does not declare is silently dead: it would sit
    // in the document forever, matching nothing, and read as configured. The operation index on
    // the latest revision is the list of names that exist.
    if (scoped) {
      const known = operationIdsOf(ctx, row.id);
      if (known !== null && !known.has(scoped.operationId)) {
        throw badRequest(
          `no operation "${scoped.operationId}" in this API's latest revision` +
            (known.size > 0 ? ` (declared: ${[...known].slice(0, 8).join(", ")})` : ""),
        );
      }
    }

    // The assembled document is validated however it was produced (design section 5): per-unit
    // validity is not enough, cross-unit constraints hold too.
    const assembled = { ...policyFor(ctx.app.db, row.id, environment), [unitKey]: value } as Record<
      string,
      unknown
    >;
    // `errorFormat` is the first unit whose legality depends on the variant, so the kind travels.
    const docErrors = validateDocument(assembled, { kind: row.kind });
    if (docErrors.length > 0) throw badRequest(docErrors.join("; "));

    const at = nowIso();
    ctx.app.db.run(
      `INSERT INTO policy_entry (resource_id, environment, unit_key, value_json, origin, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'local', ?, ?)
       ON CONFLICT (resource_id, environment, unit_key) DO UPDATE SET
         value_json = excluded.value_json, origin = 'local', updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [row.id, environment, unitKey, JSON.stringify(value), user.id, at],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "policy.set",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { environment, unitKey, value },
    });
    return json({
      environment,
      unitKey,
      value,
      origin: "local",
      updatedAt: at,
      warnings: lintDocument(assembled, { environment }),
    });
  });

  router.add("DELETE", "/api/resources/:id/policy/units/:unitKey", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "edit policy for this resource");
    const environment = environmentOf(ctx);
    const unitKey = ctx.params.unitKey!;

    const remaining = policyFor(ctx.app.db, row.id, environment) as Record<string, unknown>;
    delete remaining[unitKey];
    const errors = validateDocument(remaining, { kind: row.kind });
    if (errors.length > 0) {
      throw conflict(`detaching ${unitKey} would leave an invalid document: ${errors.join("; ")}`);
    }

    ctx.app.db.run(
      "DELETE FROM policy_entry WHERE resource_id = ? AND environment = ? AND unit_key = ?",
      [row.id, environment, unitKey],
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "policy.delete",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { environment, unitKey },
    });
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------- releases

  router.add("GET", "/api/resources/:id/releases", "session", (ctx) => {
    const row = getResource(ctx, ctx.params.id!);
    return json({
      items: ctx.app.db
        .query(
          `SELECT rel.id, rel.environment, rel.state, rel.reason, rel.version_digest,
                  rel.released_by, rel.released_at, rev.rev
             FROM release rel JOIN revision rev ON rev.id = rel.revision_id
            WHERE rel.resource_id = ? ORDER BY rel.released_at DESC`,
        )
        .all(row.id),
    });
  });

  // POST /api/resources/:id/releases lives in api/promotion.ts: the gate, the plan and the
  // per-unit merge are one decision, and splitting them across files is how they drift.

  router.add("DELETE", "/api/resources/:id/releases", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = getResource(ctx, ctx.params.id!);
    assertCan(user, row.application_id, "withdraw this resource");
    const environment = environmentOf(ctx);
    const target = ctx.app.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM target WHERE environment = ? AND adapter = 'standalone'",
      )
      .get(environment);
    if (!target) throw conflict(`no standalone target is configured for ${environment}`);

    const jobId = enqueueJob(
      ctx.app.db,
      "reconcile",
      { targetId: target.id, resourceId: row.id, intent: "remove" },
      `reconcile:remove:${target.id}:${row.id}:${Date.now()}`,
    );
    writeAudit(ctx.app.db, {
      actor: user.id,
      action: "release.withdraw",
      subject: `resource:${row.id}`,
      outcome: "ok",
      detail: { environment },
    });
    runDueJobs(ctx.app);
    return json({ jobId, environment, state: "withdrawn" }, { status: 202 });
  });
}

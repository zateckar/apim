import { digestOf, sha256Hex } from "../../shared/canonical.ts";
import type { ArtifactRef } from "../../shared/artifact.ts";
import { readBackendPool } from "../../shared/backend.ts";
import {
  CONFIG_VERSION,
  type ConfigBackendTls,
  type ConfigCertificate,
  type ConfigLimits,
  type ConfigOperation,
  type ConfigReferences,
  type ConfigRoute,
  type ConfigSoapOperation,
  type ConfigSubscription,
  type GatewayConfig,
} from "../../shared/config-doc.ts";
import {
  activeDocument,
  parseOperationUnitKey,
  validateDocument,
  VALIDATE_DEFAULTS,
  type BackendAuthUnit,
  type ErrorFormatUnit,
  type PolicyDocument,
  type PreconditionsUnit,
  type ValidateSample,
  type ValidateUnit,
} from "../../shared/policy.ts";
import type { ApiModel, Lifecycle, ResourceKind } from "../../shared/types.ts";
import { RPC_KINDS } from "../../shared/types.ts";
import { decrypt, hashKey } from "./crypto.ts";
import type { DB } from "./db.ts";
import {
  DEFAULT_VALIDATION_CEILINGS,
  DEFAULT_XML_LIMITS,
  resolveSecret,
  type Integrations,
} from "./egress.ts";
import { effectiveDocument } from "./globals.ts";
import { liveAnchorsFor } from "./trust-store.ts";

export const COMPILER_VERSION = "v3-1";

interface RouteRow {
  resource_id: string;
  resource_name: string;
  api_version: string;
  kind: string;
  lifecycle: string;
  sunset_at: string | null;
  visibility: string;
  revision_id: string;
  rev: number;
  model: string | null;
  index_json: string | null;
  artifact_digest: string | null;
  host: string;
  base_path: string;
  backend_json: string;
}

interface SubscriptionRow {
  id: string;
  product_id: string;
  application_id: string;
  application_name: string;
  product_name: string;
  primary_key_enc: string;
  secondary_key_enc: string | null;
  primary_key_expired_at: string | null;
  secondary_key_expired_at: string | null;
}

export function policyFor(db: DB, resourceId: string, environment: string): PolicyDocument {
  return effectiveDocument(db, resourceId, environment);
}

export function productIdsFor(db: DB, resourceId: string): string[] {
  return db
    .query<{ product_id: string }, [string]>(
      "SELECT product_id FROM product_member WHERE resource_id = ? ORDER BY product_id",
    )
    .all(resourceId)
    .map((r) => r.product_id);
}

/**
 * The default is resolved here, once, and written explicitly into every route — so the data plane
 * never computes a default and the wire contract carries no implicit values (review V3-03).
 * An attached `errorFormat` unit overrides it.
 */
function errorFormatFor(kind: string, model: ApiModel | null, policy: PolicyDocument): ErrorFormatUnit {
  if (policy.errorFormat) return policy.errorFormat;
  if (kind === "soap") return { shape: "soap-fault", soapVersion: model?.soap?.version ?? "1.1" };
  if (RPC_KINDS.includes(kind as ResourceKind)) return { shape: "jsonrpc" };
  return { shape: "problem+json" };
}

/**
 * Design section 5.1's defaults, resolved here rather than in the gateway, and clamped by the
 * admin ceilings of section 11 — so one API's policy cannot commandeer the instance, and a route
 * with **no `validate` unit attached still validates**, which is what "blocking by default" means.
 */
function validateFor(
  kind: string,
  policy: PolicyDocument,
  ceilings: ConfigLimits["validation"],
  instanceXml: ConfigLimits["xml"],
): ValidateUnit {
  const attached = policy.validate ?? {};
  const websocket = policy.passthrough?.websocket === true;
  const rpc = RPC_KINDS.includes(kind as ResourceKind);

  const request = websocket ? "disabled" : (attached.request ?? VALIDATE_DEFAULTS.request);
  const response = attached.response ?? VALIDATE_DEFAULTS.response;

  const bodyCeiling = rpc ? VALIDATE_DEFAULTS.rpcMaxBodyBytes : VALIDATE_DEFAULTS.maxBodyBytes;
  const always = attached.always ?? {};
  const maxBodyBytes = Math.min(always.maxBodyBytes ?? bodyCeiling, ceilings.maxBodyBytes);

  const defaultContentTypes =
    kind === "soap" ? instanceXml.contentTypes : ["application/json", "application/*+json"];

  const resolved: ValidateUnit = {
    request,
    response,
    headers: attached.headers ?? VALIDATE_DEFAULTS.headers,
    body: attached.body ?? VALIDATE_DEFAULTS.body,
    always: {
      contentType: always.contentType ?? defaultContentTypes,
      maxBodyBytes,
      maxDepth: Math.min(always.maxDepth ?? VALIDATE_DEFAULTS.maxDepth, instanceXml.maxDepth),
      json: {
        maxArrayLength: always.json?.maxArrayLength ?? VALIDATE_DEFAULTS.maxArrayLength,
        duplicateKeys: always.json?.duplicateKeys ?? VALIDATE_DEFAULTS.duplicateKeys,
      },
      xml: {
        maxElements: Math.min(
          always.xml?.maxElements ?? VALIDATE_DEFAULTS.maxElements,
          instanceXml.maxElements,
        ),
      },
    },
    maxConcurrent: Math.min(attached.maxConcurrent ?? VALIDATE_DEFAULTS.maxConcurrent, ceilings.maxConcurrent),
    onSaturated: "skip",
    logEvents: {
      includeBodyExcerptBytes: Math.min(
        attached.logEvents?.includeBodyExcerptBytes ?? 0,
        ceilings.maxIncludeBodyExcerptBytes,
      ),
    },
    ...(attached.downgradeReason ? { downgradeReason: attached.downgradeReason } : {}),
  };

  // Sampling exists only in warning mode, and its rate is clamped from below so a route cannot
  // sample so rarely that the observation means nothing.
  if (request === "warning" || response === "warning") {
    const sample: Partial<ValidateSample> = attached.sample ?? {};
    resolved.sample = {
      alwaysUnderBytes: sample.alwaysUnderBytes ?? VALIDATE_DEFAULTS.alwaysUnderBytes,
      rate: Math.max(sample.rate ?? VALIDATE_DEFAULTS.sampleRate, ceilings.minSampleRate),
      coldStart: sample.coldStart ?? VALIDATE_DEFAULTS.coldStart,
      onFailureEscalateSec: sample.onFailureEscalateSec ?? VALIDATE_DEFAULTS.onFailureEscalateSec,
      key: sample.key ?? ["operation", "subscription"],
    };
  }
  return resolved;
}

function soapIndexFor(model: ApiModel | null): ConfigRoute["soap"] {
  if (!model?.soap) return undefined;
  const operations: ConfigSoapOperation[] = model.operations
    .filter((op) => op.inputElement !== undefined)
    .map((op) => ({
      soapAction: op.soapAction ?? "",
      element: op.inputElement!,
      operationId: op.operationId,
    }))
    .sort((a, b) => a.element.localeCompare(b.element));
  return { version: model.soap.version, operations };
}

/**
 * Design section 5.4: verified by default, and the only way to relax it is an admin-created,
 * dated `tls_exception`. `expiresAt` travels so the instance self-expires on its own clock even
 * with the control plane unreachable and the config served from the fail-static cache.
 *
 * A `backend_url` of NULL covers every backend in the binding's pool; a value covers exactly one.
 * Where several apply, the **narrowest** wins, then the one expiring soonest — an exception should
 * never be broader or longer-lived than somebody asked for.
 */
function tlsFor(db: DB, resourceId: string, environment: string, now: string): ConfigBackendTls {
  const rows = db
    .query<
      {
        id: string;
        backend_url: string | null;
        mode: string;
        pin_thumbprint: string | null;
        reason: string;
        expires_at: string;
      },
      [string, string, string]
    >(
      `SELECT id, backend_url, mode, pin_thumbprint, reason, expires_at
         FROM tls_exception
        WHERE resource_id = ? AND environment = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY (backend_url IS NULL), expires_at
        LIMIT 1`,
    )
    .all(resourceId, environment, now);
  const row = rows[0];
  if (!row) return { mode: "verify" };
  return {
    mode: row.mode as ConfigBackendTls["mode"],
    ...(row.pin_thumbprint ? { pinThumbprint: row.pin_thumbprint } : {}),
    expiresAt: row.expires_at,
    exceptionId: row.id,
    reason: row.reason,
  };
}

/**
 * The bundle a route needs before it may serve. `''` is the sentinel for "compiled, and this
 * contract declares no schemas", which is why an empty digest yields no reference.
 *
 * A digest the `artifact` table no longer holds still travels. Dropping it would be a fail-open:
 * the revision says it has a validator, the instance would receive a config referencing none, and
 * `validate: blocking` would then validate nothing while reporting success. Sending it means the
 * instance's fetch 404s and it refuses to activate — loudly, which is the correct direction for a
 * control plane whose own storage has lost a row.
 */
function artifactsFor(db: DB, digest: string | null, resourceKind: string): ArtifactRef[] {
  if (!digest) return [];
  const row = db
    .query<{ digest: string; kind: string; size_bytes: number }, [string]>(
      "SELECT digest, kind, size_bytes FROM artifact WHERE digest = ?",
    )
    .get(digest);
  if (row) {
    return [{ digest: row.digest, kind: row.kind as ArtifactRef["kind"], sizeBytes: row.size_bytes }];
  }
  return [
    {
      digest,
      // Informational only — the instance fetches by digest. Inferred from the variant so the
      // reference is still well formed.
      kind: resourceKind === "soap" ? "xsd-set" : "json-schema",
      sizeBytes: 0,
    },
  ];
}

/**
 * Desired state for one environment, rendered as the wire contract of design section 8.5.
 *
 * Only the single `converged` release per (resource, environment) reaches the fleet, which is
 * what makes "publish" mean something: an edited but unreleased revision is invisible here.
 * Policy, routes and bindings are read live, because they are per-environment state edited in
 * place (design section 6.1) and reach the fleet on the next poll with no release.
 *
 * `targetId` narrows the answer to one gateway. Since v8 an environment may hold several — a
 * managed one in the cloud, an on-premise one — and an API says which of them it is published on;
 * a gateway that was handed the environment's whole route table would serve routes nobody chose to
 * put there, and the selection would be a label rather than a fact. Omitting it asks the other
 * question, "what does this environment serve anywhere", which is what the admin config projection
 * and the readiness checks want.
 */
export function buildRoutes(
  db: DB,
  environment: string,
  limits: ConfigLimits,
  targetId?: string,
): { routes: ConfigRoute[]; errors: GatewayConfig["errors"] } {
  const rows = db
    .query<RouteRow, string[]>(
      `SELECT r.id          AS resource_id,
              r.name        AS resource_name,
              r.api_version,
              r.kind,
              r.lifecycle,
              r.sunset_at,
              r.visibility,
              rel.revision_id,
              rev.rev,
              CASE WHEN r.kind IN ('soap', 'a2a', 'mcp') THEN rev.model ELSE NULL END AS model,
              rev.index_json,
              rev.artifact_digest,
              rt.host,
              rt.base_path,
              b.backend_json
         FROM release rel
         JOIN resource r   ON r.id   = rel.resource_id
         JOIN revision rev ON rev.id  = rel.revision_id
         JOIN route rt     ON rt.resource_id = r.id AND rt.environment = rel.environment
         JOIN binding b    ON b.resource_id  = r.id AND b.environment  = rel.environment
        WHERE rel.environment = ? AND rel.state = 'converged'
          ${
            targetId
              ? `AND EXISTS (SELECT 1 FROM route_gateway rg
                              WHERE rg.resource_id = r.id
                                AND rg.environment = rel.environment
                                AND rg.target_id   = ?)`
              : ""
          }
        ORDER BY rt.base_path, rt.host`,
    )
    .all(...(targetId ? [environment, targetId] : [environment]));

  const now = new Date().toISOString();
  const routes: ConfigRoute[] = [];
  const errors: GatewayConfig["errors"] = [];

  for (const row of rows) {
    // Only a variant whose request path reads the model loads it: a REST model is tens of
    // kilobytes and the operation index it needs is already denormalized onto the revision.
    const model = row.model ? (JSON.parse(row.model) as ApiModel) : null;
    // `activeDocument` subtracts the units the document switches off. It happens here, once, on
    // the way to the wire: a disabled unit never reaches a gateway, so no gateway has to know
    // what "disabled" means.
    const policy = activeDocument(effectiveDocument(db, row.resource_id, environment));

    // A route whose effective document is invalid is OMITTED rather than served. It cannot happen
    // through the API — both writes validate the effective document — but a restored backup or a
    // hand-edited database can produce it, and an API that does not answer is visible while an API
    // answering under a document nobody validated is not (plan `[R4-02]`).
    const problems = validateDocument(policy as Record<string, unknown>, { kind: row.kind });
    if (problems.length > 0) {
      errors.push({
        resourceId: row.resource_id,
        resourceName: `${row.resource_name} ${row.api_version}`,
        detail: `effective policy is invalid, so this route is not being served: ${problems.join("; ")}`,
      });
      continue;
    }

    const operations: ConfigOperation[] = row.index_json
      ? (JSON.parse(row.index_json) as ConfigOperation[])
      : [];
    const backend = readBackendPool(JSON.parse(row.backend_json));

    routes.push({
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      apiVersion: row.api_version,
      kind: row.kind as ResourceKind,
      revisionId: row.revision_id,
      rev: row.rev,
      host: row.host,
      basePath: row.base_path,
      lifecycle: row.lifecycle as Lifecycle,
      sunsetAt: row.sunset_at,
      productIds: productIdsFor(db, row.resource_id),
      backend: {
        pool: backend.pool,
        rule: backend.rule,
        ...(backend.clientCertRef ? { clientCertRef: backend.clientCertRef } : {}),
        tls: tlsFor(db, row.resource_id, environment, now),
      },
      policy: {
        ...policy,
        errorFormat: errorFormatFor(row.kind, model, policy),
        validate: validateFor(row.kind, policy, limits.validation, limits.xml),
      },
      operations,
      artifacts: artifactsFor(db, row.artifact_digest, row.kind),
      soap: soapIndexFor(model),
      ...(row.kind === "mcp" && model?.mcp
        ? { mcp: { protocolVersion: model.mcp.protocolVersion } }
        : {}),
      ...(row.kind === "a2a" && model?.a2a
        ? {
            a2a: {
              cardPath: `${row.base_path === "/" ? "" : row.base_path}/.well-known/agent-card.json`,
              // Discovery precedes credentials: a listed agent's card is public, an unlisted one's
              // needs the key (plan `[R1-17]`).
              cardPublic: row.visibility === "listed",
              card: model.a2a,
            },
          }
        : {}),
    });
  }
  return { routes, errors };
}

export function buildSubscriptions(db: DB, kek: Buffer, environment: string): ConfigSubscription[] {
  const rows = db
    .query<SubscriptionRow, [string]>(
      `SELECT s.id, s.product_id, s.application_id,
              a.name AS application_name, p.name AS product_name,
              s.primary_key_enc, s.secondary_key_enc,
              s.primary_key_expired_at, s.secondary_key_expired_at
         FROM subscription s
         JOIN application a ON a.id = s.application_id
         JOIN product p     ON p.id = s.product_id
        WHERE s.environment = ? AND s.state IN ('active','activating')
        ORDER BY s.id`,
    )
    .all(environment);

  return rows.map((row) => ({
    id: row.id,
    // Hashes, not keys: the data plane only needs the mapping, so plaintext never leaves here.
    //
    // An expired slot is left out, and that is the whole of the enforcement — the gateway has never
    // heard of an expiry and needs no code for it, because a key it was not given is a key it does
    // not know. `key-expiry.ts` decides when; this only reads the mark, so the document stays a
    // function of the database rather than of the database and the clock.
    //
    // Both slots expired leaves the subscription in the document with no keys at all. That is
    // deliberate: the entry is what telemetry, quota and the logs name the caller by, and dropping
    // it would turn a refused call from "this subscription's keys are dead" into an anonymous 401.
    keyHashes: [
      row.primary_key_expired_at === null ? row.primary_key_enc : null,
      row.secondary_key_expired_at === null ? row.secondary_key_enc : null,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((enc) => hashKey(decrypt(enc, kek))),
    productId: row.product_id,
    productName: row.product_name,
    applicationId: row.application_id,
    applicationName: row.application_name,
    subscriptionName: `${row.application_name} -> ${row.product_name}`,
  }));
}

/**
 * The client identities routes in this environment reference. The certificate *material* is not
 * here — it travels on the same channel as artifacts, keyed `<id>-<thumbprint>` so a rotation is
 * a new cache entry and activation waits for it (plan `[R2-15]`).
 */
export function buildCertificates(db: DB, environment: string): ConfigCertificate[] {
  return db
    .query<{ id: string; name: string; thumbprint: string; not_after: string }, [string]>(
      `SELECT DISTINCT c.id, c.name, c.thumbprint, c.not_after
         FROM certificate c
         JOIN binding b ON b.environment = c.environment
        WHERE c.environment = ?
          AND json_extract(b.backend_json, '$.clientCertRef') = c.id
        ORDER BY c.id`,
    )
    .all(environment)
    .map((row) => ({
      id: row.id,
      name: row.name,
      thumbprint: row.thumbprint,
      notAfter: row.not_after,
    }));
}

/**
 * Only the references this environment's routes actually name. An owner writes `issuerRef`; the
 * document carries what it resolves to, and nothing else — so the blast radius is the estate that
 * is configured rather than the whole integrations file (plan `[R1-09]`).
 */
export function buildReferences(routes: ConfigRoute[], integrations: Integrations): ConfigReferences {
  const issuerRefs = new Set<string>();
  const providerRefs = new Set<string>();
  const hmacRefs = new Set<string>();
  const hashRefs = new Set<string>();
  const secretRefs = new Set<string>();

  for (const route of routes) {
    for (const [unitKey, raw] of Object.entries(route.policy)) {
      const unit = parseOperationUnitKey(unitKey)?.unit ?? unitKey;
      const value = raw as Record<string, unknown> | undefined;
      if (!value) continue;
      switch (unit) {
        case "auth.jwt":
        case "auth.introspection":
          if (typeof value.issuerRef === "string") issuerRefs.add(value.issuerRef);
          break;
        case "auth.basic":
          if (typeof value.credentialRef === "string") hashRefs.add(value.credentialRef);
          break;
        case "preconditions":
          for (const rule of (raw as PreconditionsUnit) ?? []) {
            const ref = rule.requireHeader?.credentialRef;
            if (ref) hashRefs.add(ref);
          }
          break;
        case "backendAuth": {
          const auth = raw as BackendAuthUnit;
          if (auth.type === "basic" || auth.type === "api-key") secretRefs.add(auth.credentialRef);
          if (auth.type === "oauth2-client-credentials") providerRefs.add(auth.tokenProviderRef);
          if (auth.type === "hmac-sa-key-lite") hmacRefs.add(auth.schemeRef);
          break;
        }
        default:
          break;
      }
    }
  }

  const issuers: ConfigReferences["issuers"] = {};
  for (const ref of issuerRefs) {
    const def = integrations.issuers?.[ref];
    if (!def) continue;
    const credential = def.credentialRef ? resolveSecret(integrations, def.credentialRef) : null;
    issuers[ref] = {
      issuer: def.issuer,
      algorithms: def.algorithms,
      ...(def.jwksUrl ? { jwksUrl: def.jwksUrl } : {}),
      ...(def.audienceDefault ? { audienceDefault: def.audienceDefault } : {}),
      ...(def.introspectionUrl ? { introspectionUrl: def.introspectionUrl } : {}),
      ...(credential ? { introspectionCredential: credential } : {}),
    };
  }

  const tokenProviders: ConfigReferences["tokenProviders"] = {};
  for (const ref of providerRefs) {
    const def = integrations.tokenProviders?.[ref];
    if (!def) continue;
    const credential = resolveSecret(integrations, def.credentialRef);
    if (credential === null) continue;
    tokenProviders[ref] = {
      tokenUrl: def.tokenUrl,
      grant: def.grant,
      credential,
      ...(def.scope ? { scope: def.scope } : {}),
      ...(def.skewSec === undefined ? {} : { skewSec: def.skewSec }),
    };
  }

  const hmacSchemes: ConfigReferences["hmacSchemes"] = {};
  for (const ref of hmacRefs) {
    const def = integrations.hmacSchemes?.[ref];
    if (!def) continue;
    const appId = resolveSecret(integrations, def.appIdRef);
    const appKey = resolveSecret(integrations, def.appKeyRef);
    if (appId === null || appKey === null) continue;
    hmacSchemes[ref] = { appId, appKey };
  }

  const secretHashes: Record<string, string> = {};
  for (const ref of hashRefs) {
    const value = resolveSecret(integrations, ref);
    if (value !== null) secretHashes[ref] = sha256Hex(value);
  }
  const secrets: Record<string, string> = {};
  for (const ref of secretRefs) {
    const value = resolveSecret(integrations, ref);
    if (value !== null) secrets[ref] = value;
  }

  return { issuers, tokenProviders, hmacSchemes, secretHashes, secrets };
}

export function limitsFor(integrations: Integrations): ConfigLimits {
  return {
    xml: integrations.xml ?? DEFAULT_XML_LIMITS,
    validation: integrations.validationCeilings ?? DEFAULT_VALIDATION_CEILINGS,
  };
}

export function buildConfig(
  db: DB,
  kek: Buffer,
  environment: string,
  integrations: Integrations,
  targetId?: string,
): GatewayConfig {
  const limits = limitsFor(integrations);
  const { routes, errors } = buildRoutes(db, environment, limits, targetId);
  const subscriptions = buildSubscriptions(db, kek, environment);
  const certificates = buildCertificates(db, environment);
  const body = {
    configVersion: CONFIG_VERSION,
    environment,
    limits,
    routes,
    subscriptions,
    certificates,
    // Unlike `certificates`, not narrowed to what a route names: an anchor is not referenced by a
    // binding, it is what makes any backend in this environment verify (plan §8.2).
    trustAnchors: liveAnchorsFor(db, environment),
    references: buildReferences(routes, integrations),
    errors,
  };
  return {
    ...body,
    digest: digestOf(body),
    generatedAt: new Date().toISOString(),
  };
}

/** Every artifact digest this environment's config references — the scope check on the channel. */
export function artifactDigestsFor(db: DB, environment: string, integrations: Integrations): Set<string> {
  const { routes } = buildRoutes(db, environment, limitsFor(integrations));
  const digests = new Set<string>();
  for (const route of routes) for (const artifact of route.artifacts) digests.add(artifact.digest);
  return digests;
}

/**
 * `applied_digest = hash(rendered output, compiler_version)` — a second digest, because changing
 * the renderer changes every rendered output while every `version_digest` stays identical
 * (design section 4).
 */
export function appliedDigest(route: ConfigRoute): string {
  return digestOf({ route, compilerVersion: COMPILER_VERSION });
}

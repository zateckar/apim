/**
 * The gateway config document — the only contract between the two planes (design section 8.5).
 * The control plane owns desired state; this document is the projection the data plane serves
 * from. It is versioned: an instance refuses a `configVersion` it does not understand and keeps
 * serving what it already has.
 */
import type { ArtifactRef } from "./artifact.ts";
import type { PolicyDocument } from "./policy.ts";
import type { A2aBinding, Lifecycle, ResourceKind } from "./types.ts";

/**
 * v3 added: the effective policy document (the environment's global tier merged under the
 * resource's own units), an operation index, artifact references, a backend pool with a
 * load-balancing rule and a resolved TLS mode, and the MCP/A2A projections.
 *
 * v4 adds `trustAnchors` — the environment's trust store, which is what makes G4 an environment
 * decision rather than a per-process one. An instance speaking 3 is refused, keeps serving from its
 * cache, and reports the refusal as `activationBlocked` (plan §10).
 */
export const CONFIG_VERSION = 4;

export interface ConfigSoapOperation {
  /** May legitimately be `""` — see ApiOperation.soapAction. */
  soapAction: string;
  /** `{namespace}LocalName` of the body's first child. */
  element: string;
  operationId: string;
}

/**
 * Routing and selection only, never schemas. Design section 8.7 keeps compiled validators on a
 * separate channel; this index is small, and it is what SOAPAction agreement, per-operation policy
 * and validation all resolve against.
 */
export interface ConfigOperation {
  id: string;
  method: string;
  /** Path template as declared, relative to the route's base path. */
  template: string;
  /** SOAP: `{ns}Local` of the body's first child. */
  element?: string;
  soapAction?: string;
  /** MCP tool or A2A method — the selector for a single-endpoint variant. */
  selector?: string;
  summary?: string;
  /** Why this operation is or is not validated (plan `[R1-14]`, `[R1-15]`). */
  schemaState: "ok" | "no-schema" | "unsupported-schema";
}

export interface BackendEntry {
  url: string;
  /** 1–10, expanded into the round-robin rotation. */
  weight?: number;
}

/**
 * Design section 5.4: verified by default, and the only way to relax it is an admin-created,
 * dated `tls_exception`. `expiresAt` travels so the instance stops honouring it on its own clock
 * even with the control plane unreachable — without that, fail-static config would hold an
 * exception open through an outage.
 */
export interface ConfigBackendTls {
  mode: "verify" | "pin" | "skip-hostname" | "insecure";
  pinThumbprint?: string;
  expiresAt?: string;
  exceptionId?: string;
  reason?: string;
}

export interface ConfigBackend {
  pool: BackendEntry[];
  rule: "round-robin" | "failover";
  /** A `certificate` id, fetched over the instance channel (design section 8.7). */
  clientCertRef?: string;
  tls: ConfigBackendTls;
}

export interface ConfigRoute {
  resourceId: string;
  resourceName: string;
  /** Consumer-visible version. Two versions are two resources, two routes (plan section 8). */
  apiVersion: string;
  kind: ResourceKind;
  revisionId: string;
  rev: number;
  /** `*` matches any host. */
  host: string;
  basePath: string;
  /** Global across the chain: design section 6.1's per-environment tier does not include it. */
  lifecycle: Lifecycle;
  sunsetAt: string | null;
  productIds: string[];
  backend: ConfigBackend;
  /** The EFFECTIVE document: the environment's global units merged under the resource's own. */
  policy: PolicyDocument;
  operations: ConfigOperation[];
  /** Compiled validators to fetch before this config may be activated (design section 8.7). */
  artifacts: ArtifactRef[];
  soap?: { version: "1.1" | "1.2"; operations: ConfigSoapOperation[] };
  mcp?: { protocolVersion: string };
  a2a?: { cardPath: string; cardPublic: boolean; card: A2aBinding };
}

export interface ConfigSubscription {
  id: string;
  /** sha256 of each active key. Plaintext keys never leave the control plane. */
  keyHashes: string[];
  productId: string;
  productName: string;
  applicationId: string;
  applicationName: string;
  /** `<application> -> <product>`, what ${subscription.name} renders to. */
  subscriptionName: string;
}

/**
 * Design section 5.1's `always` block, as admin ceilings. They travel in the config document
 * rather than being configured on the gateway, so there is one place that defines them and no
 * way for the two planes to drift apart on what "too deep" means.
 */
export interface ConfigLimits {
  xml: {
    maxPrefixBytes: number;
    maxDepth: number;
    maxElements: number;
    maxBytes: number;
    contentTypes: string[];
  };
  /** Per-route `validate` values are clamped to these (design section 11). */
  validation: {
    maxBodyBytes: number;
    minSampleRate: number;
    maxConcurrent: number;
    maxIncludeBodyExcerptBytes: number;
  };
}

/** A client identity the gateway may present to a backend; the key is fetched separately. */
export interface ConfigCertificate {
  id: string;
  name: string;
  thumbprint: string;
  notAfter: string;
}

/**
 * A certificate authority this environment trusts (design section 5.4 rung 1, plan §8.2). The PEM
 * travels inline: a CA certificate is 1–2 KiB, so the artifact channel — which exists because
 * schemas reach megabytes — would buy activation-gating complexity for nothing.
 *
 * `notAfter` travels for the same reason `ConfigBackendTls.expiresAt` does: the instance drops an
 * expired anchor on its own clock, so fail-static config cannot keep a dead CA alive through a
 * control-plane outage.
 */
export interface ConfigTrustAnchor {
  id: string;
  name: string;
  thumbprint: string;
  notAfter: string;
  pem: string;
}

/**
 * The admin-registered references a policy may name (design section 5.3, 5.5). An owner writes
 * `issuerRef: "vwidp-dev"`; what that resolves to is here, and only for the references this
 * environment's routes actually use — so the blast radius of the document is the estate that is
 * actually configured, not the whole integrations file.
 */
export interface ConfigIssuer {
  issuer: string;
  jwksUrl?: string;
  algorithms: string[];
  audienceDefault?: string[];
  introspectionUrl?: string;
  /** `user:pass` for the introspection call. Present only when introspection is in use. */
  introspectionCredential?: string;
}

export interface ConfigTokenProvider {
  tokenUrl: string;
  grant: "client_credentials";
  scope?: string;
  skewSec?: number;
  /** `client_id:client_secret`. The gateway must present it, so a hash would not do. */
  credential: string;
}

export interface ConfigReferences {
  issuers: Record<string, ConfigIssuer>;
  tokenProviders: Record<string, ConfigTokenProvider>;
  /** `appId` and `appKey` for a `hmac-sa-key-lite` scheme, per environment (design section 5.5). */
  hmacSchemes: Record<string, { appId: string; appKey: string }>;
  /**
   * sha256 of a shared secret, for the comparisons the gateway only has to *check*: `auth.basic`
   * and `requireHeader.credentialRef`. A hash is enough there, so a hash is what travels
   * (plan `[R1-09]`).
   */
  secretHashes: Record<string, string>;
  /** Plaintext, and only for the references the gateway must *present* to a backend. */
  secrets: Record<string, string>;
}

export interface GatewayConfig {
  configVersion: number;
  environment: string;
  digest: string;
  generatedAt: string;
  limits: ConfigLimits;
  routes: ConfigRoute[];
  subscriptions: ConfigSubscription[];
  certificates: ConfigCertificate[];
  /** v4/G4: the environment's trust store, live anchors only. Empty for an estate with none. */
  trustAnchors: ConfigTrustAnchor[];
  references: ConfigReferences;
  /**
   * Routes that could not be rendered, and why. A route whose effective policy document is
   * invalid is **omitted** rather than served: an API that does not answer is visible, an API
   * answering under a document nobody validated is not (plan `[R4-02]`).
   */
  errors: Array<{ resourceId: string; resourceName: string; detail: string }>;
}

import type { AttentionRow } from "../../shared/attention.ts";
import type { ModelDiff } from "../../shared/diff.ts";
import type { SubscriptionState } from "../../shared/types.ts";

export type { AttentionRow, ModelDiff };

/**
 * One place that talks to the control plane. The session cookie is httpOnly, so there is no
 * token handling here; the browser adds `Origin` on writes, which is what the CSRF check reads.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    /**
     * The whole `problem+json` body. The control plane spreads an `extra` into it — `fix`,
     * `conflictsWith`, `missing` — and those are the difference between a sentence naming the
     * remedy and a control that goes there.
     */
    readonly problem: Record<string, unknown> = {},
  ) {
    super(detail || title);
  }
}

/** Where the control plane says this refusal is fixed, when it says so (`extra.fix`). */
export interface Fix {
  screen: string;
  resourceId?: string;
  environment?: string;
}

export function fixOf(err: unknown): Fix | null {
  if (!(err instanceof ApiError)) return null;
  const fix = err.problem.fix;
  if (!fix || typeof fix !== "object") return null;
  const screen = (fix as Record<string, unknown>).screen;
  return typeof screen === "string" ? ({ ...fix } as Fix) : null;
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: string; raw?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.ifMatch) headers["if-match"] = options.ifMatch;

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (options.raw && response.ok) return text as unknown as T;

  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.title ?? response.statusText,
      data?.detail ?? text ?? "request failed",
      data && typeof data === "object" ? data : {},
    );
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  getText: (path: string) => request<string>("GET", path, { raw: true }),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  patch: <T,>(path: string, body: unknown, ifMatch?: string) =>
    request<T>("PATCH", path, { body, ifMatch }),
  del: <T,>(path: string) => request<T>("DELETE", path),
};

// ------------------------------------------------------------------ shapes we read

export interface User {
  id: string;
  name: string;
  roles: string[];
  applications: string[];
  isAdmin: boolean;
  /** v5: which directory authenticated this person, and what they are called in it. */
  provider?: string;
  username?: string;
  email?: string | null;
  /** Where the admin flag came from, so a screen can explain a demotion that changes nothing. */
  adminFrom?: "local" | "idp" | "both" | null;
}

export interface Meta {
  environments: Array<{
    environment: string;
    instances: number;
    liveInstances: number;
    /**
     * The gateway's published hostname — the reverse proxy in front of the replicas, and the only
     * gateway address a consumer is ever given. `null` until an administrator sets one.
     */
    publicUrl?: string | null;
    gateways?: Array<{ label: string; url: string }>;
    /**
     * The gateways an API can be published on here — the localities, not the replicas. Named
     * apart from `gateways` above, which is the playground's list of places to send a request and
     * has meant that since v4.
     */
    localities?: Locality[];
  }>;
  chain: string[];
  kinds: string[];
  policyUnits: Array<{
    key: string;
    title: string;
    group: string;
    description: string;
    defaultValue: unknown;
    appliesToKinds?: string[];
    /** Whether this unit may be attached to a whole environment (goal G2). */
    global: boolean;
  }>;
  authProviders: string[];
  publicUrl: string;
  telemetryRetentionHours: number;
}

// ------------------------------------------------------------------ v5: who you are

/**
 * `GET /api/auth/providers` — the whole pre-session surface, and deliberately tiny. Until v5 the
 * sign-in screen read the development user list off `/api/meta`, which is why that endpoint was
 * public — and it carries every gateway URL the playground may use.
 */
export interface AuthProviders {
  providers: string[];
  oidc: { label: string } | null;
  devUsers: Array<{ id: string; name: string; role: string; applications: string[] }>;
  passwordMinLength: number;
}

export interface ApplicationMembership {
  applicationId: string;
  applicationName: string;
  /** `idp` came from a token's group claim; `local` was granted in this portal. */
  source: "idp" | "local";
  grantedBy: string | null;
  grantedByName?: string | null;
  grantedAt: string | null;
  sourceGroup: string | null;
}

/** `GET /api/me`. Answers for an anonymous caller too, with `user: null` and no 401. */
export interface Me {
  user: User | null;
  applications?: ApplicationMembership[];
  mustChangePassword?: boolean;
  /** No refresh token, so the roles on screen are the ones from sign-in until the next one. */
  claimsStale?: boolean;
  /** Groups the token carried that map to no application — the Applications screen offers to create them. */
  unmappedGroups?: string[];
  /** The token carried no groups at all: a claim-path problem, not a missing-application one. */
  noGroupsInToken?: boolean;
}

export interface SessionView {
  id: string;
  provider: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface DirectoryUser {
  id: string;
  provider: string;
  username: string;
  email: string | null;
  displayName: string;
  role: "member" | "admin";
  /** What applies, which is the OR of the role set here and the one the token last carried. */
  effectiveRole: "member" | "admin";
  adminFrom: "local" | "idp" | "both" | null;
  disabled: boolean;
  mustChangePassword: boolean;
  /** Null for anybody who is not a local account: there is no password here to have or to lack. */
  hasPassword: boolean | null;
  lockedUntil: string | null;
  createdAt: string;
  createdBy: string;
  lastLoginAt: string | null;
  applications: number;
}

export interface DirectoryUserDetail extends DirectoryUser {
  memberships: ApplicationMembership[];
  sessions: SessionView[];
  note?: string | null;
}

export interface ApplicationRow {
  id: string;
  name: string;
  mine: boolean;
  members: number;
  /** Admin-only: which identity provider group grants this application. */
  sourceGroup?: string | null;
}

export interface ApplicationDetail {
  id: string;
  name: string;
  sourceGroup?: string | null;
  owns: { resources: number; products: number; subscriptions: number; certificates: number; processes: number };
  members: Array<{
    userId: string;
    displayName: string;
    source: "idp" | "local";
    grantedBy: string | null;
    grantedByName: string | null;
    grantedAt: string | null;
  }>;
}

export interface Resource {
  id: string;
  kind: string;
  name: string;
  applicationId: string;
  apiVersion: string;
  /** `<application>/<name>` — the version family this resource is a member of. */
  family: string;
  lifecycle: string;
  sunsetAt: string | null;
  updatedAt: string;
  etag: string;
  capabilities: string[];
  // The Catalog's metadata, on the resource it describes (goal G6). `visibility` also decides
  // whether an A2A agent's card is served publicly, so it is not only presentation.
  summary: string | null;
  description: string | null;
  tags: string[];
  docsUrl: string | null;
  icon: string | null;
  visibility: string;
  /** Where an MCP server or A2A agent was discovered from — the URL `regenerate` re-reads. */
  discoveryUrl: string | null;
  /** Environments currently serving this version. Present on the list, absent on the detail. */
  liveIn?: string[];
}

export interface Revision {
  id: string;
  rev: number;
  version_digest: string;
  original_format: string;
  frozen_at: string | null;
  created_by: string;
  created_at: string;
}

export interface Release {
  id: string;
  environment: string;
  state: string;
  reason: string | null;
  rev: number;
  released_by: string;
  released_at: string;
}

export interface ResourceDetail extends Resource {
  versions: Array<{
    id: string;
    apiVersion: string;
    lifecycle: string;
    sunsetAt: string | null;
    current: boolean;
  }>;
  revisions: Revision[];
  routes: Array<{ environment: string; host: string; basePath: string }>;
  bindings: Array<{ environment: string; backend: { urls: string[] } }>;
  releases: Release[];
  products: Array<{ id: string; name: string }>;
  /**
   * The same rows the dashboard shows, from the one evaluator — so the banner on this page and the
   * list on Home cannot say different things about the same API (plan §6.3, `[P1-04]`).
   */
  attention: AttentionRow[];
}

// ------------------------------------------------------------------ promotion (design section 6)

export interface PromotionView {
  chain: string[];
  latestRev: number | null;
  furthest: string | null;
  items: Array<{
    environment: string;
    predecessor: string | null;
    liveRev: number | null;
    releasedAt: string | null;
    hasRoute: boolean;
    hasBinding: boolean;
    eligible: boolean;
  }>;
}

export interface PlanEntry {
  unit: string;
  value?: unknown;
  from?: string;
  reason?: string;
}

export interface ReleasePlan {
  resourceName: string;
  apiVersion: string;
  rev: number;
  from: string | null;
  to: string;
  isRollback: boolean;
  blockers: Array<{ code: string; detail: string }>;
  policy: { create: PlanEntry[]; keep: PlanEntry[]; localOnly: PlanEntry[] };
  warnings: string[];
}

export interface DivergenceReport {
  environments: Array<{
    environment: string;
    predecessor: string | null;
    units: Array<{
      unit: string;
      category: "pending" | "local-addition" | "value-drift" | "aligned";
      here?: unknown;
      there?: unknown;
      origin?: string;
      updatedBy?: string;
      updatedAt?: string;
      warning?: string;
    }>;
  }>;
}

// ------------------------------------------------------------------ telemetry (plan G4)

export interface TelemetryTotals {
  requests: number;
  ok: number;
  gatewayRejections: number;
  upstreamErrors: number;
  errorRate: number;
  bytesIn: number;
  bytesOut: number;
  avgMs: number | null;
  maxMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  approximate: boolean;
}

export interface TelemetrySummary {
  environment: string;
  sinceMin: number;
  totals: TelemetryTotals;
  series: Array<{
    windowStart: string;
    requests: number;
    ok: number;
    gatewayRejections: number;
    upstreamErrors: number;
    p95Ms: number | null;
  }>;
  outcomes: Array<{ outcome: string; count: number }>;
  statuses: Array<{ status: number; count: number }>;
  truncated: boolean;
}

export interface TelemetryResourceRow extends TelemetryTotals {
  resourceId: string;
  name: string;
  apiVersion: string | null;
  kind: string | null;
}

export interface TelemetryConsumerRow extends TelemetryTotals {
  subscriptionId: string;
  application: string;
  product: string;
}

export interface TelemetryInstanceRow extends TelemetryTotals {
  instanceId: string;
  name: string;
  configDigest: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  share: number;
  process: {
    rssBytes?: number;
    cpuUserMs?: number;
    uptimeSec?: number;
    requestsTotal?: number;
    droppedSeries?: number;
    droppedWindows?: number;
  } | null;
}

export interface EnvironmentsView {
  chain: string[];
  items: Array<{
    environment: string;
    hasTarget: boolean;
    enforce: boolean;
    paused: boolean;
    instances: number;
    liveInstances: number;
    maxInstances: number;
    publicUrl: string | null;
    label: string | null;
    /** Every gateway an API in this environment can be published on. */
    gateways: Locality[];
  }>;
}

/** `GET /api/gateways` — the admin screen that adds, publishes and removes a gateway. */
/** One address a gateway answers on, and who can reach it. */
export interface GatewayAddress {
  network: "internet" | "intranet";
  url: string;
}

/** A gateway an API can be published on: one environment, one locality, one or two addresses. */
export interface Locality {
  name: string;
  label: string | null;
  addresses: GatewayAddress[];
  paused: boolean;
}

export interface GatewayRow {
  environment: string;
  name: string;
  id: string;
  adapter: string;
  label: string | null;
  publicUrl: string | null;
  intranetUrl: string | null;
  addresses: GatewayAddress[];
  enforce: boolean;
  paused: boolean;
  replicas: number;
  liveReplicas: number;
  maxReplicas: number;
  /** How many APIs are published on it — what makes removing one a decision rather than a click. */
  published: number;
}

// ------------------------------------------------------------------ gateway settings

/** Most specific last, which is also the order they are resolved in. */
export type SettingScope = "fleet" | "environment" | "gateway";

export type SettingValue = number | boolean;

/**
 * One setting, as the control plane declares it. The label and the one-line purpose come from
 * `shared/gateway-settings.ts` rather than from this screen, for the reason a route's title comes
 * from `lib/routes.ts`: a screen that named its own settings would be a second list of them.
 */
export interface SettingDef {
  env: string;
  kind: "count" | "bytes" | "seconds" | "flag";
  default: SettingValue;
  min?: number;
  max?: number;
  label: string;
  purpose: string;
  /** Changing it is audited and asks for a typed confirmation. */
  sensitive?: boolean;
}

/** A resolved value and the layer it came from — `null` for "nobody has set this". */
export interface SettingSource {
  value: SettingValue;
  scope: SettingScope | null;
}

export interface GatewaySettingsModel {
  defs: Record<string, SettingDef>;
  scopes: SettingScope[];
  environments: string[];
  gateways: Array<{
    id: string;
    environment: string;
    name: string;
    label: string | null;
  }>;
  overrides: Array<{
    scope: SettingScope;
    scopeId: string;
    key: string;
    value: SettingValue;
    setAt: string;
    setBy: string;
  }>;
  /** What each layer resolves to, so inheritance is rendered without a call per gateway. */
  effective: {
    fleet: Record<string, SettingSource>;
    environments: Record<string, Record<string, SettingSource>>;
    gateways: Record<string, Record<string, SettingSource>>;
  };
}

export interface PolicyUnitRow {
  unitKey: string;
  value: unknown;
  origin: string;
  updatedBy: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  applicationId: string;
  members: Array<{ id: string; name: string }>;
  capabilities: string[];
}

export interface Application {
  id: string;
  name: string;
  applicationId: string;
  capabilities: string[];
}

export interface SubscriptionKey {
  which: "primary" | "secondary";
  /** Null when the slot is empty. A key that does not exist has no age and no deadline. */
  mintedAt: string | null;
  ageDays: number | null;
  /** Projected, not promised: the estate's policy may be changed and the date moves with it. */
  expiresAt: string | null;
  /** Recorded, unlike `expiresAt` — this one is a thing that happened. */
  expiredAt: string | null;
  status: "absent" | "ok" | "ageing" | "expired";
}

export interface Subscription {
  id: string;
  productId: string;
  applicationId: string;
  environment: string;
  /** One of the seven `SUBSCRIPTION_STATES`, so `subscriptionChip` is total over it. */
  state: SubscriptionState;
  applicationName?: string;
  productName?: string;
  /** When either key was last rotated — "when was this last touched", not "how old is the key". */
  keyRotatedAt: string | null;
  /**
   * The two slots, each with its own age and deadline.
   *
   * Two entries, always, so the secondary's absence is a state rather than a missing row: a
   * subscription has a secondary only once somebody has rotated into it, and `status: "absent"` is
   * how the screen knows to offer minting one rather than showing an age of zero.
   */
  keys?: SubscriptionKey[];
  /**
   * Which side of it you are. A subscription has two, and the same row means "our application
   * calls their product" to one application and the reverse to the other — so a list that did not say
   * which would be a list of rows nobody can read.
   */
  viewerIs?: "consumer" | "publisher" | "other";
  /** `read`+`delete` for a publisher: they may end it, and may not reach into it for the keys. */
  capabilities?: string[];
}

// ------------------------------------------------------------------ the Catalog (goal G6)

export interface MarketCard {
  id: string;
  kind: string;
  name: string;
  title: string;
  apiVersion: string;
  icon: string | null;
  summary: string | null;
  tags: string[];
  /** Null for a row published before the taxonomy existed; the catalog files those under Other. */
  domain: string | null;
  subdomain: string | null;
  applicationId: string;
  lifecycle: string;
  visibility: string;
  environments: string[];
  /** Visible to the caller only because they own it. The card says so rather than implying it. */
  unpublished: boolean;
  operationCount: number;
  subscriberCount: number;
  subscribed: boolean;
  products: Array<{ id: string; name: string; lifecycle: string; summary: string | null }>;
  updatedAt: string;
}

export interface MarketListingDetail extends MarketCard {
  description: string | null;
  docsUrl: string | null;
  operations: Array<{
    id: string;
    name: string;
    title?: string;
    method?: string;
    path?: string;
    summary: string | null;
    soapAction?: string;
    inputSchema?: Record<string, unknown> | null;
    tags?: string[];
    examples?: string[];
  }>;
  endpoints: Array<{
    environment: string;
    host: string;
    basePath: string;
    live: boolean;
    /** Every address it answers at here — one per address of every gateway it is published on. */
    urls: Array<{
      gateway: string;
      label: string | null;
      network: "internet" | "intranet";
      url: string;
    }>;
  }>;
  example: { environment: string; language: string; text: string } | null;
  versions: Array<{ id: string; api_version: string; lifecycle: string }>;
  traffic: Array<{ windowStart: string; requests: number }>;
  mcp?: { protocolVersion: string; serverInfo: { name: string; version?: string } };
  a2a?: {
    protocolVersion: string;
    skills: Array<{ id: string; name: string; description?: string; tags: string[] }>;
    capabilities: Record<string, boolean>;
    cardPath: string;
  };
}

export interface MarketFacets {
  kinds: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
  applications: Array<{ value: string; count: number }>;
  environments: Array<{ value: string; count: number }>;
  /**
   * Every domain in the taxonomy, in taxonomy order, whether or not anything is filed under it —
   * plus `other` last for what predates the taxonomy. Topics are counted separately because they
   * are the same estate but a different kind of thing to subscribe to.
   */
  domains: Array<{ value: string; count: number; topics: number }>;
  total: number;
  /** The facet counts are over a bounded scan, so they can be a floor rather than a total. */
  truncated: boolean;
}

export interface SubscriptionUsage {
  id: string;
  state: string;
  environment: string;
  windows: Array<{
    scopeKind: string;
    scopeId: string;
    periodSec: number;
    windowStart: string;
    used: number;
    resetsInSec: number;
  }>;
  rejections: Record<string, number>;
  note: string;
}

// ------------------------------------------------------------------ the global tier (goal G2)

export interface GlobalPolicyView {
  environment: string;
  document: Record<string, unknown>;
  units: Array<{
    unitKey: string;
    value: unknown;
    updatedBy: string;
    updatedAt: string;
    overriddenBy: number;
  }>;
  affectedResources: number;
  attachable: string[];
  warnings: string[];
  canEdit: boolean;
}

export interface EffectivePolicyView {
  environment: string;
  document: Record<string, unknown>;
  /** `resource` — this API set it; `global` — the environment did, and this API did not. */
  units: Array<{ unitKey: string; value: unknown; origin: "resource" | "global" }>;
  warnings: string[];
  globalUnits: string[];
}

// ------------------------------------------------------------------ trust (design section 5.4)

export interface CertificateRow {
  id: string;
  applicationId: string;
  name: string;
  thumbprint: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  usage: string;
  createdBy: string;
  createdAt: string;
  expiresInDays: number;
  expired: boolean;
  usedBy: Array<{ resourceId: string; resourceName: string; environment: string }>;
}

export interface TlsExceptionRow {
  id: string;
  resourceId: string;
  resourceName: string;
  environment: string;
  backendUrl: string | null;
  mode: string;
  pinThumbprint: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  live: boolean;
  expiresInDays: number;
}

/** One released route a deny rule is currently taking out of service. */
export interface BlockedRoute {
  resourceId: string;
  resourceName: string;
  applicationId: string;
  environment: string;
  backendUrl: string;
}

export interface DenyRuleRow {
  id: string;
  /** `null` applies to every environment. */
  environment: string | null;
  /** `null` matches both schemes. */
  scheme: "http" | "https" | null;
  hostPattern: string;
  ports?: number[];
  portRange?: [number, number];
  reason: string;
  createdBy: string;
  createdAt: string;
  blocking: BlockedRoute[];
}

/** The rule the platform states about its own address. Listed, never removable. */
export type PlatformDenyRule = Omit<DenyRuleRow, "createdBy" | "createdAt">;

export interface DenyRuleList {
  items: DenyRuleRow[];
  platformRules: PlatformDenyRule[];
  maxRules: number;
}

export interface GovernanceReport {
  denyRules: Array<{
    id: string;
    environment: string | null;
    scheme: "http" | "https" | null;
    hostPattern: string;
    reason: string;
    platform: boolean;
    blocking: BlockedRoute[];
  }>;
  blockedRoutes: Array<BlockedRoute & { hostPattern: string; reason: string }>;
  tlsExceptions: Array<{
    id: string;
    resourceId: string;
    resourceName: string;
    environment: string;
    backendUrl: string;
    mode: string;
    reason: string;
    createdBy: string;
    expiresAt: string;
    expiresInDays: number;
  }>;
  cnOnlyRoutes: Array<{ resourceId: string; resourceName: string; environment: string }>;
  clientCaBundle: { description?: string; issuers?: string[] } | null;
}

export interface FleetHealth {
  environment: string;
  adapter: string;
  enforce: boolean;
  paused: boolean;
  configDigest: string;
  routes: number;
  subscriptions: number;
  liveInstances: number;
  /** Replicas that are not revoked, and how many of those are behind or not reporting. */
  expectedInstances: number;
  behindInstances: number;
  publicUrl: string | null;
  label: string | null;
  inSync: boolean;
  staleAfterSec: number;
  instances: Array<{
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
    /** Whatever the instance last reported: process gauges, `activationBlocked`, `validation`. */
    process: Record<string, unknown> | null;
  }>;
  /** Per locality, because that is where a disagreement between replicas actually lives. */
  gateways: Array<{
    name: string;
    label: string | null;
    addresses: GatewayAddress[];
    paused: boolean;
    configDigest: string;
    routes: number;
    replicas: number;
    liveReplicas: number;
    expectedReplicas: number;
    behindReplicas: number;
    inSync: boolean;
    behind: string[];
  }>;
}

/** Per-instance validation counters, reported on the poll and held on the instance row. */
export interface ValidationCounters {
  rejected: number;
  observed: number;
  sampleDropped: number;
  unavailable: number;
  budgetShed: number;
}

export interface DowngradeReport {
  items: Array<{
    resourceId: string;
    resourceName: string;
    kind: string;
    environment: string;
    request: string;
    response: string;
    downgradeReason: string | null;
    updatedBy: string;
    updatedAt: string;
  }>;
  /** Operations no state can validate — an unsupported keyword or an unimplemented WSDL construct. */
  unvalidatable: Array<{
    resourceId: string;
    resourceName: string;
    operationId: string;
    schemaState: string;
  }>;
}

// ------------------------------------------------------------------ the dashboard (goal G2)

/**
 * `GET /api/dashboard`. One block per hat, from one request, so two numbers on one page cannot
 * disagree about what "now" means (plan §6.1). `AttentionRow` is imported from `shared/` rather
 * than re-declared: the control plane's closed vocabulary is the contract, and a second copy of it
 * here is a second place for a code to go missing.
 */
export interface DashboardTraffic {
  requests: number;
  ok: number;
  gatewayRejections: number;
  upstreamErrors: number;
  errorRate: number;
  bytesIn: number;
  bytesOut: number;
  avgMs: number | null;
  maxMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  approximate: boolean;
  truncated: boolean;
  series: Array<{
    windowStart: string;
    requests: number;
    ok: number;
    gatewayRejections: number;
    upstreamErrors: number;
    p95Ms: number | null;
  }>;
  /** Null when retention cannot cover two windows — never a number computed over a short one. */
  previous: TelemetryTotals | null;
}

export interface DashboardQuota {
  limit: number | null;
  used: number;
  fraction: number | null;
  resetsInSec: number | null;
  periodSec: number | null;
}

export interface Dashboard {
  generatedAt: string;
  environment: string;
  sinceMin: number;
  /** False exactly when `owner.traffic.previous` is null, so one meaning has one field. */
  trendAvailable: boolean;
  /** Which blocks have data — not which screens exist (`[P1-26]`). */
  hats: string[];
  owner: {
    apis: {
      total: number;
      byLifecycle: Record<string, number>;
      liveByEnvironment: Record<string, number>;
    };
    traffic: DashboardTraffic;
    topApis: Array<{
      resourceId: string;
      name: string;
      requests: number;
      ok: number;
      gatewayRejections: number;
      upstreamErrors: number;
      errorRate: number;
      p95Ms: number | null;
    }>;
    attention: AttentionRow[];
    attentionTruncated: number;
  };
  consumer: {
    applications: Array<{ id: string; name: string; applicationId: string; subscriptions: number }>;
    subscriptions: Array<{
      id: string;
      name: string;
      environment: string;
      state: string;
      productId: string;
      /** Null when this subscription has no quota — a different statement from "0 of 0". */
      quota: DashboardQuota | null;
      keyAgeDays: number;
      keyRotatedAt: string | null;
    }>;
    subscriptionsTruncated: number;
    attention: AttentionRow[];
    attentionTruncated: number;
  };
  platform: {
    environments: Array<{
      environment: string;
      hasTarget: boolean;
      instances: number;
      live: number;
      inSync: boolean;
      configDigest: string | null;
      activeTlsExceptions: number;
      trustAnchors: number;
      expiringAnchors: number;
      configErrors: number;
    }>;
    attention: AttentionRow[];
    attentionTruncated: number;
    /** Null for a non-admin: absent rather than empty, which would read as "nothing is wrong". */
    admin: { failedJobs: number; staleReleases: number; downgrades: number } | null;
  };
  /** Present only on an estate this application has not started using yet. */
  startHere: AttentionRow[] | null;
}

// ------------------------------------------------------------------ the playground (goal G1)

export interface PlaygroundEntry {
  name: string;
  value: string;
  enabled?: boolean;
}

export interface PlaygroundSend {
  resourceId: string;
  environment: string;
  subscriptionId?: string | null;
  keyKind?: "primary" | "secondary";
  gatewayLabel?: string;
  operationId?: string;
  agentCard?: boolean;
  pathParams?: Record<string, string>;
  query?: PlaygroundEntry[];
  headers?: PlaygroundEntry[];
  body?: string | null;
}

export interface PlaygroundResponse {
  request: {
    method: string;
    path: string;
    query: string;
    /** The key is never in here, by construction on the server (plan §5.2). */
    headers: Record<string, string>;
    gateway: { label: string; url: string };
    keyKind: "primary" | "secondary" | "none";
    subscriptionId: string | null;
    droppedHeaders: string[];
    warnings: string[];
  };
  response: {
    status: number | null;
    statusText: string | null;
    durationMs: number;
    headers: Record<string, string>;
    body: string | null;
    encoding: "utf-8" | "base64";
    truncated: boolean;
    bytes: number;
    /** A transport outcome — no response at all — rather than a status. Shown, not thrown. */
    error: string | null;
  };
  note: string;
}

export interface PlaygroundHistoryEntry {
  id: string;
  environment: string;
  subscriptionId: string | null;
  keyKind: string;
  operationId: string | null;
  method: string;
  path: string;
  query: PlaygroundEntry[];
  headers: Record<string, string>;
  body: string | null;
  gateway: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  responseHeaders: Record<string, string> | null;
  responsePreview: string | null;
  responseEncoding: string | null;
  responseTruncated: boolean;
  error: string | null;
  createdAt: string;
  /** Whether it can be loaded back into the form, and why not. */
  replayable: boolean;
  reason: string | null;
}

export interface PlaygroundHistory {
  resourceId: string;
  items: PlaygroundHistoryEntry[];
  retentionDays: number;
  cap: number;
}

export interface FormParameter {
  name: string;
  required: boolean;
  value: string;
  description?: string;
}

export interface FormOperation {
  id: string;
  name: string;
  method: string;
  template: string;
  summary: string | null;
  pathParams: FormParameter[];
  query: FormParameter[];
  headers: FormParameter[];
  body: string | null;
  bodyKind: "json" | "xml" | null;
  schemaState: "ok" | "no-schema" | "unsupported-schema";
  selector?: string;
}

/**
 * `GET /api/playground/form`. Everything the console needs to draw the form, resolved from the
 * revision this environment is actually serving — so an operation it offers is one the send will
 * accept, and a refusal here is the refusal the send would have given.
 */
export interface PlaygroundForm {
  resourceId: string;
  resourceName: string;
  apiVersion: string;
  kind: string;
  environment: string;
  rev: number;
  host: string;
  basePath: string;
  gateways: Array<{ label: string; url: string }>;
  /** Null when this route accepts anonymous traffic — a fact worth seeing, not an omission. */
  key: { in: string; name: string } | null;
  subscriptions: Array<{
    id: string;
    name: string;
    application: string;
    product: string;
    hasSecondary: boolean;
  }>;
  /** A key is required and the caller's applications hold none: the one control is "subscribe". */
  needsSubscription: boolean;
  operations: FormOperation[];
  agentCard: { path: string } | null;
  streaming: { kind: string; command: string } | null;
  warnings: string[];
  limits: {
    maxBodyBytes: number;
    maxResponseBytes: number;
    timeoutMs: number;
    ratePerMin: number;
    historyPerResource: number;
    historyRetentionDays: number;
  };
  note: string;
}

// ------------------------------------------------------------------ revisions (goal G3)

export interface RevisionRow {
  id: string;
  rev: number;
  versionDigest: string;
  originalFormat: string;
  originalBytes: number;
  artifactDigest: string | null;
  operations: number;
  schemaStates: { ok: number; "no-schema": number; "unsupported-schema": number };
  frozenAt: string | null;
  prunedAt: string | null;
  /** `upload` | `url` | `discovery` | `copied` | `corrected`. */
  source: string;
  sourceDetail: string | null;
  createdBy: string;
  createdAt: string;
  releasedIn: Record<string, "live" | "previously" | "never">;
  /** What may be done with it, so the screen does not re-derive the same three rules. */
  editable: boolean;
  diffable: boolean;
}

export interface RevisionList {
  resourceId: string;
  items: RevisionRow[];
  nextCursor: string | null;
}

export interface RevisionDiff extends ModelDiff {
  from: { id: string; rev: number; resourceId: string; versionDigest: string };
  to: { id: string; rev: number; resourceId: string; versionDigest: string };
}

// ------------------------------------------------------------------ trust anchors (goal G4)

export interface TrustAnchorRow {
  id: string;
  environment: string;
  name: string;
  subject: string;
  issuer: string;
  thumbprint: string;
  notBefore: string;
  notAfter: string;
  expiresInDays: number;
  expired: boolean;
  live: boolean;
  /** Null when a stored anchor no longer parses — the list still renders, saying what it can. */
  selfSigned: boolean | null;
  keyAlgorithm: string | null;
  addedBy: string;
  addedAt: string;
  removedAt: string | null;
  /** Where the same certificate is live already, so "copy to TEST" is an informed decision. */
  alsoLiveIn: string[];
}

export interface TrustAnchorCopy {
  fromEnvironment: string;
  environment: string;
  copy: Array<{ id: string; name: string; subject: string; thumbprint: string; notAfter: string }>;
  skipped: Array<{ id: string; reason: string }>;
  applied: boolean;
  created?: string[];
}

export interface TrustAnchorList {
  environment: string;
  maxAnchors: number;
  items: TrustAnchorRow[];
  note: string;
}

export interface TrustAnchorPreview {
  subject: string;
  issuer: string;
  thumbprint: string;
  notBefore: string;
  notAfter: string;
  expiresInDays: number;
  ca: boolean;
  selfSigned: boolean;
  keyAlgorithm: string;
}

// --------------------------------------------------------------------------- request logs (ELK)

/**
 * One access-log line. The control plane does not store these — it reads them from the log index,
 * and `provider`/`simulated` on the envelope say which index answered. Every screen that shows
 * them has to show that too: simulated traffic that looks like observation is worse than none.
 */
export interface LogEntry {
  id: string;
  at: string;
  environment: string;
  gateway: string;
  instance: string | null;
  resourceId: string;
  resourceName: string;
  operationId: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  backendMs: number | null;
  subscriptionId: string | null;
  consumerApplicationId: string | null;
  clientIp: string | null;
  requestId: string;
  error: string | null;
}

export interface LogWindow {
  from: string;
  to: string;
}

/**
 * An hour in which one API's request and response bodies are written into its log lines as well.
 *
 * Off by default and never longer than `maxMinutes`, because a body is the one part of a call that
 * carries whatever the caller put in it. The row survives the window — `revokedAt` is set rather
 * than the row being deleted — so the screen can show that bodies *were* captured, when, and on
 * whose word.
 */
export interface BodyCaptureWindow {
  id: string;
  resourceId: string;
  resourceName: string;
  applicationId: string;
  environment: string;
  reason: string;
  openedBy: string;
  openedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  live: boolean;
  /** Zero once the window is spent, never negative — so a countdown cannot run backwards. */
  remainingSec: number;
}

export interface BodyCapturePage {
  items: BodyCaptureWindow[];
  /** The longest window the control plane will open, and the cap on each captured body. */
  maxMinutes: number;
  maxBytes: number;
}

export interface LogPage {
  items: LogEntry[];
  total: number;
  /** The index caps how deep it will count; past the cap `total` is a floor rather than a count. */
  totalIsLowerBound: boolean;
  simulated: boolean;
  provider: "elk" | "mock";
  window: LogWindow;
  nextCursor: string | null;
}

export interface LogBucket {
  at: string;
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface LogHistogram {
  buckets: LogBucket[];
  intervalSec: number;
  simulated: boolean;
  provider: "elk" | "mock";
  window: LogWindow;
}

// ------------------------------------------------------------------ the health screen

export type ComponentStatus = "up" | "down" | "disabled";

export interface HealthItem {
  id: string;
  label: string;
  kind: "control-plane" | "database" | "fleet" | "gateway" | "log-index" | "integration";
  environment: string | null;
  status: ComponentStatus;
  latencyMs: number | null;
  checkedAt: string;
  message: string | null;
  tag: string | null;
  /** True when nothing was really contacted. The screen says so rather than counting it as evidence. */
  simulated: boolean;
}

export type EnvironmentVerdict = "healthy" | "degraded" | "down" | "unknown";

export interface EnvironmentRollup {
  environment: string;
  status: EnvironmentVerdict;
  up: number;
  down: number;
  disabled: number;
  total: number;
  impact: string[];
}

export interface HealthSnapshot {
  generatedAt: string;
  /** The cadence the server wants to be polled at. The browser does not choose it. */
  intervalMs: number;
  summary: { up: number; down: number; disabled: number; total: number };
  environments: EnvironmentRollup[];
  items: HealthItem[];
  warming: boolean;
}

export interface SyntheticsBucket {
  at: string;
  status: "up" | "down" | "empty";
  total: number;
  down: number;
  avgDurationMs: number | null;
}

export interface SyntheticsMonitor {
  id: string;
  name: string;
  host: string | null;
  buckets: SyntheticsBucket[];
  /** Share of the buckets that ran which were up, 0-1. `null` when nothing ran. */
  availability: number | null;
  lastError: string | null;
}

export interface SyntheticsSnapshot {
  range: string;
  intervalMs: number;
  generatedAt: string;
  environments: Array<{ environment: string; monitors: SyntheticsMonitor[] }>;
  simulated: boolean;
}

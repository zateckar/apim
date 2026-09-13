import { readFileSync } from "node:fs";
import { MAX_QUOTA_ENTRIES } from "../../shared/quota.ts";
import { TELEMETRY_DEFAULTS } from "../../shared/telemetry.ts";
import { SUBSCRIPTION_KEY_DEFAULTS } from "../../shared/types.ts";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "./artifacts.ts";
import { DEFAULT_MAX_DENY_RULES } from "./deny-rules.ts";
import {
  checkEgress,
  DEFAULT_TLS_EXCEPTION_MAX_DAYS,
  DEFAULT_VALIDATION_CEILINGS,
  DEFAULT_XML_LIMITS,
  validateIntegrations,
  type Integrations,
} from "./egress.ts";

/**
 * Design section 11: explicit values, no fallback chains. A wrong or missing value is a startup
 * failure that names the variable, never a silent downgrade.
 */
export interface TargetDef {
  environment: string;
  adapter: string;
  /**
   * This gateway's name within its environment, and the same name in every environment it exists
   * in — `managed`, `onprem`. It is the identity a publish carries along the promotion chain, so
   * "published on `managed`" still means something two environments later. Defaults to the
   * adapter, which is what every target was called before an environment could hold several.
   */
  name?: string;
  enforce: boolean;
  paused: boolean;
  config: Record<string, unknown>;
  /**
   * The reverse proxy in front of this gateway's replicas — the hostname every API URL the portal
   * shows a consumer is built from. A *seed* only: it is written when the target row is created
   * and never again, because an administrator can change it on the Gateways screen and a file that
   * reasserted itself at every boot would silently undo them.
   */
  publicUrl?: string;
  /**
   * The same gateway's inside-only address, when it has one. One on-premise deployment commonly
   * answers on two DNS names — one resolvable from the internet, one only from the corporate
   * network — and those are two addresses for one gateway rather than two gateways, so both are
   * shown and publishing binds to the gateway.
   */
  intranetUrl?: string;
  /** What to call this deployment: `Azure Cloud`, `Mladá Boleslav`. Seeded the same way. */
  label?: string;
}

/**
 * Where the playground may send a request in an environment (plan §11). Admin configuration, not
 * a secret and not something a caller may name: G1's whole safety argument is that the target is
 * composed from this list plus the published route, so there is no field in which a caller can
 * write a host.
 *
 * In a real deployment this is the F5 vhost rather than an instance. Two entries exist locally
 * because design section 5.7's `calls × instances` is worth being able to demonstrate by hand.
 */
export interface GatewayUrl {
  label: string;
  url: string;
}

/**
 * How people sign in (v5 plan §5.1). A closed, ordered list with no default: `AUTH_PROVIDERS` is
 * required, and a deployment that forgets it does not quietly get the bypass (D36).
 */
export type AuthProvider = "local" | "oidc" | "dev";
export const AUTH_PROVIDERS: readonly AuthProvider[] = ["local", "oidc", "dev"];

/**
 * Where per-request logs come from (`LOGS_PROVIDER`).
 *
 * `mock` is the default and produces deterministic simulated traffic derived from the estate; the
 * responses are marked `simulated` and every screen that shows them says so. `elk` reads a real
 * Elasticsearch index. There is deliberately **no fallback** from `elk` to `mock`: a portal that
 * quietly invented traffic when the log cluster was down would present fiction as observation.
 */
export interface LogsConfig {
  provider: "elk" | "mock";
  url: string | null;
  index: string;
  /**
   * Where the availability checks land. A different index from the access lines because they are
   * different documents with different retention — Heartbeat writes one document per check, and
   * mixing them into the access index would make every request-count aggregation wrong.
   */
  uptimeIndex: string;
  apiKey: string | null;
  username: string | null;
  password: string | null;
  timeoutMs: number;
  maxResultWindow: number;
  maxRangeHours: number;
}

function readLogs(): LogsConfig {
  const raw = (process.env.LOGS_PROVIDER ?? "mock").trim().toLowerCase();
  if (raw !== "elk" && raw !== "mock") {
    throw new Error(`LOGS_PROVIDER: expected "elk" or "mock", got "${raw}"`);
  }
  const url = (process.env.ELK_URL ?? "").trim().replace(/\/+$/, "") || null;
  if (raw === "elk" && !url) {
    throw new Error(
      'ELK_URL is required when LOGS_PROVIDER=elk — the base URL of the Elasticsearch HTTP API, ' +
        "e.g. https://elk.example.com:9200. It must also be in the egress allowlist.",
    );
  }
  const apiKey = (process.env.ELK_API_KEY ?? "").trim() || null;
  const username = (process.env.ELK_USERNAME ?? "").trim() || null;
  if (raw === "elk" && !apiKey && !username) {
    throw new Error(
      "LOGS_PROVIDER=elk needs a credential: either ELK_API_KEY, or ELK_USERNAME with " +
        "ELK_PASSWORD. An unauthenticated log cluster is not assumed.",
    );
  }
  return {
    provider: raw,
    url,
    index: (process.env.ELK_INDEX ?? "apim-access-*").trim(),
    uptimeIndex: (process.env.ELK_UPTIME_INDEX ?? "heartbeat-*").trim(),
    apiKey,
    username,
    password: process.env.ELK_PASSWORD ?? null,
    timeoutMs: intFromEnv("ELK_TIMEOUT_MS", 10_000),
    maxResultWindow: intFromEnv("ELK_MAX_RESULT_WINDOW", 10_000),
    maxRangeHours: intFromEnv("LOGS_MAX_RANGE_HOURS", 24 * 30),
  };
}

/** Everything the OIDC provider needs. Present only when `oidc` is one of the providers. */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
  /** Dotted paths, because Keycloak's realm roles live at `realm_access.roles` (plan §5.5). */
  roleClaim: string;
  adminRole: string;
  groupClaim: string;
  claimsRefreshSec: number;
  autoCreate: boolean;
  endSession: boolean;
  /** The sign-in button's label, so a deployment can say "Škoda ID" rather than "Single sign-on". */
  displayName: string;
}

export interface CpConfig {
  port: number;
  dbPath: string;
  publicUrl: string;
  kekPath: string;
  promotionChain: string[];
  /** Ordered: the order the sign-in screen shows them, first one focused. */
  authProviders: AuthProvider[];
  oidc: OidcConfig | null;
  /** Session bounds — idle is distinct from absolute (design §9), and both are now configurable. */
  sessionIdleMin: number;
  sessionLifetimeHours: number;
  /** How long a revoked or expired session stays readable in the session list. */
  sessionPruneAfterDays: number;
  localPasswordMinLen: number;
  localLockoutThreshold: number;
  localLockoutMinutes: number;
  /**
   * Across all callers, in front of the argon2 hash. Two things need it: a spray attack — one
   * password, a thousand usernames — never trips the per-principal lockout, and at ~18 ms a verify
   * an unauthenticated caller could otherwise saturate this process's CPU with no credential at
   * all (review `[P1-05]`).
   */
  localLoginRatePerMin: number;
  bootstrapAdminUsername: string | null;
  bootstrapAdminPassword: string | null;
  /**
   * A second allowed `Origin` for the CSRF check. No longer gated on the auth mode `[P2-01]`:
   * whether a Vite dev server is running is not a fact about how people sign in.
   */
  uiDevOrigin: string | null;
  uiDist: string;
  instanceStaleAfterSec: number;
  /** When a silent replica stops holding the environment's convergence open. See `fleetApplied`. */
  instanceAbandonedAfterSec: number;
  /** When a subscription key is complained about, and when the gateway stops accepting it. */
  subscriptionKeyWarnDays: number;
  subscriptionKeyExpireDays: number;
  maxSpecBytes: number;
  integrations: Integrations;
  targets: TargetDef[];
  // v2 — telemetry and fleet bounds. Every one of them is a bound with a defined behaviour past
  // it, so the telemetry row count is arithmetic rather than a hope (plan section 10).
  telemetryFlushIntervalSec: number;
  telemetryRetentionHours: number;
  jobRetentionHours: number;
  maxReportBytes: number;
  maxInstancesPerTarget: number;
  maxRunsPerInstanceWindow: number;
  // v3 — the compiled-validator channel and the Catalog. Same rule: every ceiling has a defined
  // behaviour past it (plan section 14).
  /**
   * One compiled bundle's ceiling. Past it the import is refused rather than the bundle shipped:
   * every gateway in the environment downloads it, so a bundle nobody bounded is a fleet-wide cost.
   */
  artifactMaxBytes: number;
  /** Usage flush interval; also the quota RPO, because a lost flush is what quota can be behind by. */
  usageFlushIntervalSec: number;
  /** Quota rows exchanged per poll, in each direction. */
  maxQuotaEntries: number;
  catalogPageSize: number;
  // v4 — the playground, revision retention, the trust store and the dashboard. Same rule again:
  // every one of these is a bound with a defined behaviour past it (plan §5.3, §7.4, §8.1, §6.1).
  /** What may be sent. Past it the request is refused; the editor says so before sending. */
  playgroundMaxBodyBytes: number;
  /** What may be read back. Past it the body is truncated and the response says it was. */
  playgroundMaxResponseBytes: number;
  playgroundTimeoutMs: number;
  /**
   * Per user, per minute. It protects the control plane, not the consumer's quota: a playground
   * call is a real call and spends the subscription's rate limit and quota like any other.
   */
  playgroundRatePerMin: number;
  playgroundHistoryPerResource: number;
  playgroundHistoryRetentionDays: number;
  /** Bounds the *stored* request body and response preview — not what is sent (plan `[P3-03]`). */
  playgroundHistoryBodyBytes: number;
  /** Retention keeps the tighter of the two, plus design section 4.1's three exceptions. */
  revisionKeepCount: number;
  revisionKeepDays: number;
  /** Live anchors per environment. The document carries every one of them, so it is bounded. */
  maxTrustAnchors: number;
  /** Live egress deny rules. Every one is evaluated on every write and every configuration build. */
  maxEgressDenyRules: number;
  dashboardDefaultSinceMin: number;
  /** Where per-request access logs are read from. The control plane never stores them. */
  logs: LogsConfig;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}: expected a non-negative integer`);
  return value;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "0") return raw === "1";
  throw new Error(`${name}: expected 1 or 0, got "${raw}"`);
}

/**
 * `AUTH_PROVIDERS` — required, ordered, closed (D36). This is the one place a fallback chain would
 * be catastrophic: a deployment that forgets the variable must not silently get the development
 * bypass, so there is no default and the error names the three legal values.
 */
export function parseAuthProviders(raw: string | undefined): AuthProvider[] {
  const listed = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length === 0) {
    throw new Error(
      "AUTH_PROVIDERS is required: an ordered, comma-separated subset of " +
        `${AUTH_PROVIDERS.join(",")} saying how people sign in. There is no default — a control ` +
        "plane that guessed would either be unreachable or wide open. " +
        '`AUTH_PROVIDERS=dev` is the local development bypass; `local` is a username and ' +
        "password directory in this database; `oidc` is an OpenID Connect provider such as Keycloak.",
    );
  }
  const out: AuthProvider[] = [];
  for (const entry of listed) {
    if (!AUTH_PROVIDERS.includes(entry as AuthProvider)) {
      throw new Error(
        `AUTH_PROVIDERS: "${entry}" is not a provider (expected ${AUTH_PROVIDERS.join(", ")})`,
      );
    }
    if (!out.includes(entry as AuthProvider)) out.push(entry as AuthProvider);
  }
  return out;
}

function readOidc(providers: AuthProvider[]): OidcConfig | null {
  if (!providers.includes("oidc")) return null;
  const required = (name: string): string => {
    const value = (process.env[name] ?? "").trim();
    if (!value) {
      throw new Error(`${name} is required when AUTH_PROVIDERS includes "oidc"`);
    }
    return value;
  };
  const issuer = required("OIDC_ISSUER").replace(/\/+$/, "");
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    throw new Error(`OIDC_ISSUER: expected an absolute http(s) URL, got "${issuer}"`);
  }
  return {
    issuer,
    clientId: required("OIDC_CLIENT_ID"),
    // Absent means a public PKCE client, which is the Keycloak default for this shape. Explicitly
    // optional rather than defaulted to "": an empty secret sent to a confidential client fails
    // in a way that reads like a wrong secret.
    clientSecret: (process.env.OIDC_CLIENT_SECRET ?? "").trim() || null,
    redirectUri: required("OIDC_REDIRECT_URI"),
    scope: process.env.OIDC_SCOPE ?? "openid profile email offline_access",
    roleClaim: process.env.OIDC_ROLE_CLAIM ?? "realm_access.roles",
    adminRole: process.env.OIDC_ADMIN_ROLE ?? "apim-admin",
    groupClaim: process.env.OIDC_GROUP_CLAIM ?? "groups",
    claimsRefreshSec: intFromEnv("OIDC_CLAIMS_REFRESH_SEC", 300),
    autoCreate: boolFromEnv("OIDC_AUTO_CREATE", true),
    endSession: boolFromEnv("OIDC_END_SESSION", false),
    displayName: process.env.OIDC_DISPLAY_NAME ?? "Single sign-on",
  };
}

export function readIntegrations(path: string): Integrations {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Integrations & {
    egressAllowlist?: unknown;
  };
  // Retired in v1.4.0, and a **failure** rather than an ignored key: the platform no longer
  // allowlists egress, so a file still carrying one would leave an operator believing they are
  // protected by a list nothing reads — the one failure mode worse than having no list at all.
  if (parsed.egressAllowlist !== undefined) {
    throw new Error(
      `${path}: egressAllowlist is retired. Egress is allowed by default and forbidden two ways: ` +
        "denyCidrs here, which nothing in the portal can widen, and per-host deny rules an " +
        "administrator states on the Trust screen under \"Blocked backends\". Remove this key, and " +
        "re-state anything it was protecting as a deny rule. See openspec/specs/egress-governance.",
    );
  }
  if (!Array.isArray(parsed.denyCidrs)) throw new Error(`${path}: denyCidrs must be an array`);
  // The ceilings are admin config with safe defaults rather than required keys, so an existing v1
  // or v2 integrations file keeps working.
  parsed.xml = { ...DEFAULT_XML_LIMITS, ...(parsed.xml ?? {}) };
  parsed.validationCeilings = { ...DEFAULT_VALIDATION_CEILINGS, ...(parsed.validationCeilings ?? {}) };
  parsed.tlsExceptionMaxDays = parsed.tlsExceptionMaxDays ?? DEFAULT_TLS_EXCEPTION_MAX_DAYS;
  // A dangling reference is a boot failure naming both the ref and where it is used: a policy
  // pointing at a missing secret would otherwise fail at the first request instead (plan [R3-08]).
  validateIntegrations(parsed, path);
  return parsed;
}

export function readTargets(path: string): TargetDef[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { targets: TargetDef[] };
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error(`${path}: expected at least one target`);
  }
  // Parsed at boot rather than at the first click: a malformed entry is a startup failure that
  // names the target, not a 500 the first time somebody presses Send.
  const seen = new Set<string>();
  for (const target of parsed.targets) {
    parseGatewayUrls(target, `${path}: target "${target.environment}"`);
    target.name = (target.name ?? target.adapter).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(target.name)) {
      throw new Error(
        `${path}: gateway name "${target.name}" in ${target.environment}: expected lower-case ` +
          'letters, digits and hyphens, e.g. "managed"',
      );
    }
    // Two gateways with one name in an environment is the schema's unique constraint, and finding
    // out at boot names the file rather than the SQLite error.
    const key = `${target.environment}/${target.name}`;
    if (seen.has(key)) {
      throw new Error(`${path}: ${target.environment} has two gateways named "${target.name}"`);
    }
    seen.add(key);
  }
  return parsed.targets;
}

/**
 * `config.gatewayUrls` on a target, validated. Absent is a legitimate answer — it disables the
 * playground in that environment, and the endpoint says exactly that and names `TARGETS_FILE`.
 */
export function parseGatewayUrls(target: TargetDef, where: string): GatewayUrl[] {
  const raw = target.config?.gatewayUrls;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: config.gatewayUrls must be an array`);
  const out: GatewayUrl[] = [];
  const labels = new Set<string>();
  for (const entry of raw) {
    const candidate = entry as Partial<GatewayUrl>;
    if (typeof candidate?.label !== "string" || candidate.label.length === 0) {
      throw new Error(`${where}: every gatewayUrls entry needs a label`);
    }
    if (labels.has(candidate.label)) {
      throw new Error(
        `${where}: two gateways are labelled "${candidate.label}"; the label is how a caller ` +
          "picks one, so it has to be unique within the environment",
      );
    }
    labels.add(candidate.label);
    let url: URL;
    try {
      url = new URL(String(candidate.url));
    } catch {
      throw new Error(`${where}: gateway "${candidate.label}" has no valid absolute URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${where}: gateway "${candidate.label}" must be http or https`);
    }
    if (url.search || url.hash) {
      throw new Error(
        `${where}: gateway "${candidate.label}" must be an origin with an optional path prefix — ` +
          "the query string belongs to the request the playground composes",
      );
    }
    // The route's base path is appended, so a trailing slash here would produce `//`.
    out.push({ label: candidate.label, url: url.href.replace(/\/+$/, "") });
  }
  return out;
}

/** Every gateway URL the playground may use in an environment, across that environment's targets. */
export function gatewayUrlsFor(config: CpConfig, environment: string): GatewayUrl[] {
  const out: GatewayUrl[] = [];
  for (const target of config.targets) {
    if (target.environment !== environment) continue;
    for (const entry of parseGatewayUrls(target, `target "${target.environment}"`)) {
      if (!out.some((existing) => existing.label === entry.label)) out.push(entry);
    }
  }
  return out;
}

/**
 * Design section 5.3 applies to the playground's target as much as to a spec import, even though
 * no part of the composed URL came from a caller. Checked at boot because a playground that can
 * reach nothing should say so at startup, naming the target — not at the first click.
 *
 * The denied **ranges** only: see `assertIssuerAllowed` for why no deny rule is consulted here.
 */
export async function assertGatewayUrlsAllowed(config: CpConfig): Promise<void> {
  const problems: string[] = [];
  for (const target of config.targets) {
    for (const gateway of parseGatewayUrls(target, `target "${target.environment}"`)) {
      const errors = await checkEgress(
        gateway.url,
        `${target.environment} gateway "${gateway.label}"`,
        { integrations: config.integrations },
      );
      problems.push(...errors);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `TARGETS_FILE names gateway URLs the denied ranges refuse:\n  ${problems.join("\n  ")}`,
    );
  }
}

export function loadConfig(overrides: Partial<CpConfig> = {}): CpConfig {
  const targetsFile = process.env.TARGETS_FILE ?? "config/targets.json";
  const integrationsFile = process.env.INTEGRATIONS_FILE ?? "config/integrations.json";
  // Parsed only when the caller has not supplied one, so a test can pass `authProviders` without
  // needing the environment variable set. The same applies to `oidc`: `readOidc` throws on a
  // missing OIDC_ISSUER, and `...overrides` further down would be too late to prevent that.
  const authProviders = overrides.authProviders ?? parseAuthProviders(process.env.AUTH_PROVIDERS);
  const oidc = overrides.oidc !== undefined ? overrides.oidc : readOidc(authProviders);

  const config: CpConfig = {
    port: intFromEnv("PORT", 8080),
    dbPath: process.env.DB_PATH ?? ".data/apim.sqlite",
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8080",
    kekPath: process.env.KEK_PATH ?? ".data/kek.key",
    promotionChain: (process.env.PROMOTION_CHAIN ?? "dev,test,prod")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authProviders,
    oidc,
    sessionIdleMin: intFromEnv("SESSION_IDLE_MIN", 60),
    sessionLifetimeHours: intFromEnv("SESSION_LIFETIME_HOURS", 8),
    sessionPruneAfterDays: intFromEnv("SESSION_PRUNE_AFTER_DAYS", 30),
    localPasswordMinLen: intFromEnv("LOCAL_PASSWORD_MIN_LEN", 12),
    localLockoutThreshold: intFromEnv("LOCAL_LOCKOUT_THRESHOLD", 10),
    localLockoutMinutes: intFromEnv("LOCAL_LOCKOUT_MINUTES", 15),
    localLoginRatePerMin: intFromEnv("LOCAL_LOGIN_RATE_PER_MIN", 60),
    bootstrapAdminUsername: (process.env.BOOTSTRAP_ADMIN_USERNAME ?? "").trim() || null,
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || null,
    uiDevOrigin: (process.env.UI_DEV_ORIGIN ?? "").trim() || null,
    uiDist: process.env.UI_DIST ?? "ui/dist",
    instanceStaleAfterSec: intFromEnv("INSTANCE_STALE_AFTER_SEC", 30),
    // When a replica stops counting towards convergence at all. Deliberately an order of magnitude
    // above the staleness threshold: that one answers "is this healthy right now" for a screen,
    // and a fleet must not be abandoned mid-rolling-restart. See `fleetApplied`.
    instanceAbandonedAfterSec: intFromEnv("INSTANCE_ABANDONED_AFTER_SEC", 900),
    // When a subscription key is complained about, and when it stops working. See
    // `SUBSCRIPTION_KEY_DEFAULTS`. A warn threshold at or past the expiry would be a deadline with
    // no notice, so it is clamped below it rather than trusted.
    subscriptionKeyExpireDays: intFromEnv(
      "SUBSCRIPTION_KEY_EXPIRE_DAYS",
      SUBSCRIPTION_KEY_DEFAULTS.expireDays,
    ),
    subscriptionKeyWarnDays: Math.min(
      intFromEnv("SUBSCRIPTION_KEY_WARN_DAYS", SUBSCRIPTION_KEY_DEFAULTS.warnDays),
      intFromEnv("SUBSCRIPTION_KEY_EXPIRE_DAYS", SUBSCRIPTION_KEY_DEFAULTS.expireDays),
    ),
    maxSpecBytes: intFromEnv("MAX_SPEC_BYTES", 5 * 1024 * 1024),
    integrations: readIntegrations(integrationsFile),
    targets: readTargets(targetsFile),
    telemetryFlushIntervalSec: intFromEnv(
      "TELEMETRY_FLUSH_INTERVAL_SEC",
      TELEMETRY_DEFAULTS.flushIntervalSec,
    ),
    telemetryRetentionHours: intFromEnv("TELEMETRY_RETENTION_HOURS", TELEMETRY_DEFAULTS.retentionHours),
    jobRetentionHours: intFromEnv("JOB_RETENTION_HOURS", TELEMETRY_DEFAULTS.jobRetentionHours),
    maxReportBytes: intFromEnv("MAX_REPORT_BYTES", TELEMETRY_DEFAULTS.maxReportBytes),
    maxInstancesPerTarget: intFromEnv(
      "MAX_INSTANCES_PER_TARGET",
      TELEMETRY_DEFAULTS.maxInstancesPerTarget,
    ),
    maxRunsPerInstanceWindow: intFromEnv(
      "MAX_RUNS_PER_INSTANCE_WINDOW",
      TELEMETRY_DEFAULTS.maxRunsPerInstanceWindow,
    ),
    artifactMaxBytes: intFromEnv("ARTIFACT_MAX_BYTES", DEFAULT_ARTIFACT_MAX_BYTES),
    usageFlushIntervalSec: intFromEnv("USAGE_FLUSH_INTERVAL_SEC", 10),
    maxQuotaEntries: intFromEnv("MAX_QUOTA_ENTRIES", MAX_QUOTA_ENTRIES),
    catalogPageSize: intFromEnv("CATALOG_PAGE_SIZE", 24),
    playgroundMaxBodyBytes: intFromEnv("PLAYGROUND_MAX_BODY_BYTES", 256 * 1024),
    playgroundMaxResponseBytes: intFromEnv("PLAYGROUND_MAX_RESPONSE_BYTES", 512 * 1024),
    playgroundTimeoutMs: intFromEnv("PLAYGROUND_TIMEOUT_MS", 30_000),
    playgroundRatePerMin: intFromEnv("PLAYGROUND_RATE_PER_MIN", 60),
    playgroundHistoryPerResource: intFromEnv("PLAYGROUND_HISTORY_PER_RESOURCE", 25),
    playgroundHistoryRetentionDays: intFromEnv("PLAYGROUND_HISTORY_RETENTION_DAYS", 7),
    playgroundHistoryBodyBytes: intFromEnv("PLAYGROUND_HISTORY_BODY_BYTES", 4096),
    revisionKeepCount: intFromEnv("REVISION_KEEP_COUNT", 5),
    revisionKeepDays: intFromEnv("REVISION_KEEP_DAYS", 365),
    maxTrustAnchors: intFromEnv("MAX_TRUST_ANCHORS", 16),
    maxEgressDenyRules: intFromEnv("MAX_EGRESS_DENY_RULES", DEFAULT_MAX_DENY_RULES),
    dashboardDefaultSinceMin: intFromEnv("DASHBOARD_DEFAULT_SINCE_MIN", 1440),
    logs: readLogs(),
    ...overrides,
  };

  // Zero is a legal integer and a destructive value for these three, so it is refused by name
  // rather than accepted quietly: no revision kept, no anchor registrable, no window to report on.
  if (config.revisionKeepCount < 1) {
    throw new Error("REVISION_KEEP_COUNT: expected at least 1 — retention keeps the newest N revisions");
  }
  if (config.maxTrustAnchors < 1) throw new Error("MAX_TRUST_ANCHORS: expected at least 1");
  // Zero would not mean "no limit", it would mean no rule can be created — the administrator
  // locked out of the control, with nothing saying why.
  if (config.maxEgressDenyRules < 1) throw new Error("MAX_EGRESS_DENY_RULES: expected at least 1");
  if (config.dashboardDefaultSinceMin < 1) throw new Error("DASHBOARD_DEFAULT_SINCE_MIN: expected at least 1");
  if (config.promotionChain.length === 0) throw new Error("PROMOTION_CHAIN: expected at least one environment");
  const chainSet = new Set(config.promotionChain);
  if (chainSet.size !== config.promotionChain.length) {
    throw new Error("PROMOTION_CHAIN: an environment appears twice; the chain must be an order");
  }
  for (const target of config.targets) {
    if (!chainSet.has(target.environment)) {
      throw new Error(
        `${targetsFile}: target for environment "${target.environment}" is not in PROMOTION_CHAIN ` +
          `(${config.promotionChain.join(",")}); a target nothing can be released to is a misconfiguration`,
      );
    }
  }
  return config;
}

/**
 * Everything about how people sign in that can be checked without touching the network or the
 * database (v5 plan §5.1). Called once, at boot, before anything serves: a half-configured
 * authentication surface must be a startup failure naming the variable, never a 500 at the first
 * sign-in and never a quiet downgrade.
 */
export function assertAuthConfig(config: CpConfig): void {
  if (process.env.DEV_AUTH !== undefined && process.env.AUTH_PROVIDERS === undefined) {
    throw new Error(
      "DEV_AUTH is retired and AUTH_PROVIDERS is not set. Set AUTH_PROVIDERS explicitly — " +
        "`AUTH_PROVIDERS=dev` is what DEV_AUTH=1 used to mean. Reading the old variable silently " +
        "is how a development bypass survives an upgrade into production.",
    );
  }

  // A bypass beside a real directory is the worst of both: it looks configured and it is not. The
  // reference implementation's own history records this exact failure — a portal running against
  // production with every gate short-circuited because one mode check read `!== 'oidc'`.
  if (config.authProviders.includes("dev") && config.authProviders.includes("oidc")) {
    throw new Error(
      'AUTH_PROVIDERS: "dev" cannot be combined with "oidc". The development bypass lets anybody ' +
        "become any development user without a password; beside a real identity provider it is a " +
        "way in that looks like it is not there. Pick one.",
    );
  }

  if (config.authProviders.includes("local")) {
    const named = Boolean(config.bootstrapAdminUsername) || Boolean(config.bootstrapAdminPassword);
    if (named && !(config.bootstrapAdminUsername && config.bootstrapAdminPassword)) {
      throw new Error(
        "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD go together: one without the " +
          "other cannot create an account. Set both, or neither if the directory already has a user.",
      );
    }
    if (config.bootstrapAdminPassword && config.bootstrapAdminPassword.length < config.localPasswordMinLen) {
      throw new Error(
        `BOOTSTRAP_ADMIN_PASSWORD is shorter than LOCAL_PASSWORD_MIN_LEN (${config.localPasswordMinLen}). ` +
          "The bootstrap admin is the account with every permission; it is not the one to exempt.",
      );
    }
  }

  const oidc = config.oidc;
  if (oidc) {
    let redirect: URL;
    try {
      redirect = new URL(oidc.redirectUri);
    } catch {
      throw new Error(`OIDC_REDIRECT_URI: expected an absolute URL, got "${oidc.redirectUri}"`);
    }
    // A callback that sets the session cookie on a different origin than the SPA is served from
    // completes a whole sign-in and lands the user signed out, with no error anywhere `[P1-07]`.
    const publicOrigin = new URL(config.publicUrl).origin;
    if (redirect.origin !== publicOrigin) {
      throw new Error(
        `OIDC_REDIRECT_URI origin (${redirect.origin}) must equal PUBLIC_URL's (${publicOrigin}). ` +
          "The callback is what sets the session cookie, and a cookie set on another origin is " +
          "never sent back — the user would complete sign-in and arrive signed out.",
      );
    }
    if (!oidc.scope.split(/\s+/).includes("openid")) {
      throw new Error(`OIDC_SCOPE must include "openid"; got "${oidc.scope}"`);
    }
  }
}

/**
 * Design §5.3 applies to the identity provider as much as to a spec import. Checked at boot on the
 * *string*, with no discovery call `[P1-15]`: a host inside a denied range has to be a startup
 * failure naming it, but fetching discovery here would make the control plane refuse to start while
 * Keycloak restarts — an availability coupling nobody asked for. The endpoints the discovery
 * document names are checked when it is first fetched.
 *
 * The denied **ranges** only, deliberately. `OIDC_ISSUER`, `ELK_URL` and the playground targets are
 * set by the operator in the environment rather than written by an owner; running them through the
 * administrator-editable deny rules would let a rule created in the portal prevent the next restart
 * (`runtime-configuration`, *An administrator's deny rule cannot prevent a restart*).
 */
export async function assertIssuerAllowed(config: CpConfig): Promise<void> {
  if (!config.oidc) return;
  const errors = await checkEgress(config.oidc.issuer, "OIDC_ISSUER", {
    integrations: config.integrations,
  });
  if (errors.length > 0) {
    throw new Error(
      `OIDC_ISSUER is not reachable:\n  ${errors.join("\n  ")}\n` +
        `Adjust denyCidrs in ${process.env.INTEGRATIONS_FILE ?? "config/integrations.json"}, or ` +
        "give the identity provider an address outside the denied ranges.",
    );
  }
}

/**
 * The log cluster is admin configuration and the control plane fetches it, so design section 5.3
 * applies to it exactly as it applies to a spec import — checked once at boot, naming the variable,
 * rather than on the first click of the Logs tab.
 */
export async function assertLogsUrlAllowed(config: CpConfig): Promise<void> {
  if (config.logs.provider !== "elk" || !config.logs.url) return;
  const errors = await checkEgress(config.logs.url, "ELK_URL", { integrations: config.integrations });
  if (errors.length > 0) {
    throw new Error(
      `ELK_URL is not reachable:\n  ${errors.join("\n  ")}\n` +
        `Adjust denyCidrs in ${process.env.INTEGRATIONS_FILE ?? "config/integrations.json"}, or ` +
        "give the log cluster an address outside the denied ranges.",
    );
  }
}

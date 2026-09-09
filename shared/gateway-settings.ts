/**
 * Gateway settings — the fleet's operational knobs, owned by the control plane (design section 8.5).
 *
 * Every key below used to be an environment variable on each gateway container, which meant a
 * fleet's configuration was the union of N compose files: drift between them was invisible until it
 * produced a symptom, and "what is prod actually running" had no answer short of reading every
 * file. They travel in the configuration document instead, for the same reason `ConfigLimits` does
 * — one place defines them, and the two planes cannot disagree about what a ceiling is.
 *
 * The table's invariant, and the whole entry criterion: **a key is here only if a running instance
 * can apply it without restarting.** Anything a process must know before it can poll — its name,
 * its port, its token, where the control plane is, where its caches are — stays an environment
 * variable, because a setting that arrives over the poll cannot configure the poll that fetched it.
 * So does anything the runtime reads rather than the gateway (`BUN_CONFIG_*`), and so does the
 * trusted-proxy boundary: whether a header counts as an identity is a fact about the network in
 * front of one container, not a fleet policy, and getting it wrong is an authorization bypass.
 *
 * `POLL_INTERVAL_SEC` is the case worth naming, because it looks like it belongs here and does not.
 * It is the cadence of the channel these settings arrive on, so a mistake in it slows down its own
 * correction: set it to five minutes by accident and every subsequent fix — including the fix to
 * this — takes five minutes to reach the fleet. It stays beside `GATEWAY_CP_URL`, as part of how a
 * container reaches its control plane rather than part of what the control plane tells it.
 *
 * Three scopes, resolved most-specific-first: `gateway` over `environment` over `fleet`, with the
 * defaults here under all three. Every key accepts every scope deliberately — a uniform model has
 * one rule to learn, where "which layer may set this" would be a second table to keep true.
 */

export type SettingScope = "fleet" | "environment" | "gateway";

/** Most specific last. The resolver walks this in order, so the array *is* the precedence. */
export const SETTING_SCOPES: readonly SettingScope[] = ["fleet", "environment", "gateway"] as const;

export type SettingValue = number | boolean;

/**
 * `count` and `flag` render as themselves; `bytes` and `seconds` carry a unit the settings screen
 * renders and the write path validates against, so a field asking for seconds cannot be filled in
 * with milliseconds and look plausible.
 */
export type SettingKind = "count" | "bytes" | "seconds" | "flag";

export interface SettingDef {
  /** The variable this replaces. Kept so an error, a release note and the screen can all name it. */
  env: string;
  kind: SettingKind;
  default: SettingValue;
  /** Inclusive, and enforced on write as a refusal and on read as a clamp. See `clampSetting`. */
  min?: number;
  max?: number;
  label: string;
  /**
   * One line, rendered by the settings screen. Declared here for the reason `ui/src/lib/routes.ts`
   * declares a route's purpose: a screen that named its own settings would be a second list of them.
   */
  purpose: string;
  /**
   * Changing it is an audit entry and a typed confirmation rather than a spinner. Only for the
   * settings whose value is a promise to somebody outside engineering.
   */
  sensitive?: boolean;
}

/** The resolved block, as it travels in the configuration document. */
export interface GatewaySettings {
  maxConcurrentRequests: number;
  maxConcurrentUpgrades: number;
  maxBodyBytes: number;
  blockingBufferBudgetBytes: number;
  validatePoolSize: number;
  validateQueueDepth: number;
  responseCacheMaxEntries: number;
  responseCacheMaxBytes: number;
  artifactCacheMaxBytes: number;
  jwksMinRefetchSec: number;
  telemetry: boolean;
  telemetryMaxSeries: number;
  telemetryMaxWindowsPerReport: number;
  accessLog: boolean;
  accessLogMaxBytes: number;
  accessLogKeep: number;
}

export type SettingKey = keyof GatewaySettings;

const MIB = 1024 * 1024;

/**
 * Keyed by the setting rather than a list, so TypeScript refuses a table that has drifted from
 * `GatewaySettings` in either direction — a key with no definition, or a definition for a key the
 * document does not carry.
 */
export const GATEWAY_SETTING_DEFS: {
  [K in SettingKey]: SettingDef & { default: GatewaySettings[K] };
} = {
  maxConcurrentRequests: {
    env: "MAX_CONCURRENT_REQUESTS",
    kind: "count",
    default: 2048,
    min: 1,
    max: 1_000_000,
    label: "Concurrent requests",
    purpose:
      "The most requests one replica will have in flight to backends at once, across every route. " +
      "Past it requests are shed with 503, never queued.",
  },
  maxConcurrentUpgrades: {
    env: "MAX_CONCURRENT_UPGRADES",
    kind: "count",
    default: 1024,
    min: 1,
    max: 1_000_000,
    label: "Concurrent streams",
    purpose: "WebSocket and SSE connections one replica will hold open at once.",
  },
  maxBodyBytes: {
    env: "MAX_BODY_BYTES",
    kind: "bytes",
    default: 8 * MIB,
    min: 1024,
    max: 1024 * MIB,
    label: "Request body cap",
    purpose:
      "The largest request body a gateway will read. A route's own `always` limit may be smaller, " +
      "never larger.",
  },
  blockingBufferBudgetBytes: {
    env: "BLOCKING_BUFFER_BUDGET_BYTES",
    kind: "bytes",
    default: 256 * MIB,
    min: MIB,
    max: 8192 * MIB,
    label: "Blocking validation budget",
    purpose:
      "Bytes held for enforcing validation across every in-flight request. Past it a request is " +
      "shed rather than validated half-way or let through unvalidated.",
  },
  validatePoolSize: {
    env: "VALIDATE_POOL_SIZE",
    kind: "count",
    default: 4,
    min: 1,
    max: 256,
    label: "Validation pool",
    purpose: "Warning-mode validation samples processed at once, off the request path.",
  },
  validateQueueDepth: {
    env: "VALIDATE_QUEUE_DEPTH",
    kind: "count",
    default: 256,
    min: 1,
    max: 100_000,
    label: "Validation queue",
    purpose: "Samples waiting for the pool. Past it a sample is counted as dropped, not held.",
  },
  responseCacheMaxEntries: {
    env: "RESPONSE_CACHE_MAX_ENTRIES",
    kind: "count",
    default: 10_000,
    // Zero is a legal and useful value here, unlike the ceilings `runtime-configuration` refuses it
    // for: it turns the response cache off on this gateway without touching any route's policy.
    min: 0,
    max: 10_000_000,
    label: "Response cache entries",
    purpose: "Cached responses one replica holds. Zero turns the response cache off here.",
  },
  responseCacheMaxBytes: {
    env: "RESPONSE_CACHE_MAX_BYTES",
    kind: "bytes",
    default: 64 * MIB,
    min: 0,
    max: 8192 * MIB,
    label: "Response cache size",
    purpose: "Bytes the response cache may hold, whichever ceiling is reached first.",
  },
  artifactCacheMaxBytes: {
    env: "ARTIFACT_CACHE_MAX_BYTES",
    kind: "bytes",
    default: 512 * MIB,
    min: MIB,
    max: 8192 * MIB,
    label: "Artifact cache size",
    purpose:
      "Disk for compiled validators and backend client certificates. Too small for the estate's " +
      "schemas and activation stalls, so the fleet view names it when it does.",
  },
  jwksMinRefetchSec: {
    env: "JWKS_MIN_REFETCH_SEC",
    kind: "seconds",
    default: 60,
    min: 1,
    max: 86_400,
    label: "JWKS refetch floor",
    purpose:
      "The soonest a key set is refetched for an unknown `kid`. Too high and a key rotation costs " +
      "that long in 401s; too low and any caller can make this gateway hammer the provider.",
  },
  telemetry: {
    env: "DP_TELEMETRY",
    kind: "flag",
    default: true,
    label: "Telemetry",
    purpose:
      "Counting per request and per response byte. Off, the Telemetry view goes blank for this " +
      "gateway and the response body is handed through rather than pulled through a counter.",
  },
  telemetryMaxSeries: {
    env: "TELEMETRY_MAX_SERIES",
    kind: "count",
    default: 2000,
    min: 1,
    max: 1_000_000,
    label: "Telemetry series",
    purpose: "Distinct series one replica keeps per window. Past it series are dropped and counted.",
  },
  telemetryMaxWindowsPerReport: {
    env: "TELEMETRY_MAX_WINDOWS_PER_REPORT",
    kind: "count",
    default: 15,
    min: 1,
    max: 1440,
    label: "Windows per report",
    purpose: "Minute windows one poll may carry, which bounds catch-up after a control-plane outage.",
  },
  accessLog: {
    env: "DP_ACCESS_LOG",
    kind: "flag",
    default: true,
    // The lines are a compliance record, so this is the one setting in the table that is a promise
    // to somebody outside engineering. There is deliberately no setting that *thins* the log: "all
    // of them" and "none" are the only two honest states.
    sensitive: true,
    label: "Access log",
    purpose:
      "One line per request. Off, this gateway answers requests without recording that it did — a " +
      "real operational choice, and an audited one.",
  },
  accessLogMaxBytes: {
    env: "DP_ACCESS_LOG_MAX_BYTES",
    kind: "bytes",
    default: 128 * MIB,
    min: MIB,
    max: 8192 * MIB,
    label: "Access log rotation size",
    purpose: "How large the live file grows before it is rotated. Only applies when a path is set.",
  },
  accessLogKeep: {
    env: "DP_ACCESS_LOG_KEEP",
    kind: "count",
    default: 5,
    min: 0,
    max: 1000,
    label: "Access log generations",
    purpose: "Rotated files kept, so the log's disk is (generations + 1) × the rotation size.",
  },
};

export const GATEWAY_SETTING_KEYS = Object.keys(GATEWAY_SETTING_DEFS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(GATEWAY_SETTING_DEFS, key);
}

export function defaultGatewaySettings(): GatewaySettings {
  const out = {} as Record<SettingKey, SettingValue>;
  for (const key of GATEWAY_SETTING_KEYS) out[key] = GATEWAY_SETTING_DEFS[key].default;
  return out as GatewaySettings;
}

/** One stored override. Sparse: a row exists only where somebody set something. */
export interface SettingOverride {
  scope: SettingScope;
  /**
   * `""` for `fleet`, the environment's name for `environment`, the target id for `gateway` — an id
   * rather than a name because a gateway's overrides should follow it through a rename and leave
   * with it when it is deleted.
   */
  scopeId: string;
  key: SettingKey;
  value: SettingValue;
}

/** Which gateway is asking. The instance's own target, never anything it reported about itself. */
export interface SettingSubject {
  environment: string;
  targetId: string;
}

function scopeIdFor(scope: SettingScope, subject: SettingSubject): string {
  if (scope === "fleet") return "";
  return scope === "environment" ? subject.environment : subject.targetId;
}

/** Where a resolved value came from, for a screen that has to explain an inherited number. */
export interface SettingSource<K extends SettingKey = SettingKey> {
  value: GatewaySettings[K];
  /** `null` means nobody has overridden it and the value is this build's default. */
  scope: SettingScope | null;
}

/**
 * The one resolution. Returns every key, so the document never carries a partial block and the
 * gateway never has a default of its own to fall back to.
 *
 * Values are clamped rather than refused here: the write path refuses an out-of-range value with a
 * message, and by the time a row is being read the useful behaviour is a working fleet. A row
 * written by an older build whose bounds were wider must not be able to strand one.
 */
export function resolveGatewaySettingSources(
  overrides: readonly SettingOverride[],
  subject: SettingSubject,
): { [K in SettingKey]: SettingSource<K> } {
  const out = {} as Record<SettingKey, SettingSource>;
  for (const key of GATEWAY_SETTING_KEYS) {
    out[key] = { value: GATEWAY_SETTING_DEFS[key].default, scope: null };
  }
  for (const scope of SETTING_SCOPES) {
    const wanted = scopeIdFor(scope, subject);
    for (const override of overrides) {
      if (override.scope !== scope || override.scopeId !== wanted) continue;
      if (!isSettingKey(override.key)) continue;
      out[override.key] = { value: clampSetting(override.key, override.value), scope };
    }
  }
  return out as { [K in SettingKey]: SettingSource<K> };
}

export function resolveGatewaySettings(
  overrides: readonly SettingOverride[],
  subject: SettingSubject,
): GatewaySettings {
  const sources = resolveGatewaySettingSources(overrides, subject);
  const out = {} as Record<SettingKey, SettingValue>;
  for (const key of GATEWAY_SETTING_KEYS) out[key] = sources[key].value;
  return out as GatewaySettings;
}

/** A value of the wrong shape falls back to the default; one out of range is pulled into it. */
export function clampSetting(key: SettingKey, value: SettingValue): SettingValue {
  const def = GATEWAY_SETTING_DEFS[key];
  if (def.kind === "flag") return typeof value === "boolean" ? value : def.default;
  if (typeof value !== "number" || !Number.isInteger(value)) return def.default;
  return Math.min(Math.max(value, def.min ?? 0), def.max ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Validate one value on its way in, refusing rather than clamping — an administrator who typed a
 * number outside the range has made a decision about capacity, and quietly serving them a different
 * one is how a gateway ends up not doing what its own screen says it does.
 *
 * The message names the setting, the variable it replaces and the bound, in the shape
 * `runtime-configuration` requires of every configuration refusal.
 */
export function parseSetting(key: SettingKey, raw: unknown): SettingValue {
  const def = GATEWAY_SETTING_DEFS[key];
  if (def.kind === "flag") {
    if (typeof raw !== "boolean") throw new Error(`${key} (${def.env}): expected true or false`);
    return raw;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`${key} (${def.env}): expected an integer, got ${JSON.stringify(raw)}`);
  }
  const min = def.min ?? 0;
  const max = def.max ?? Number.MAX_SAFE_INTEGER;
  if (raw < min || raw > max) {
    throw new Error(`${key} (${def.env}): expected ${min}–${max}, got ${raw}`);
  }
  return raw;
}

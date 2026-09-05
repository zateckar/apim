/**
 * The policy vocabulary (design section 5): a closed, declarative JSON vocabulary, not a
 * programming language. No expressions, no XML, no `send-request`, and no URL an owner writes is
 * fetched — backends live in `binding` and every reference (`issuerRef`, `credentialRef`,
 * `tokenProviderRef`) resolves through the admin-registered `INTEGRATIONS_FILE`.
 *
 * A **unit** is the smallest thing that can independently exist or be absent; everything beneath a
 * unit is its values and moves as one piece. That is what makes the per-unit promotion merge
 * (§6.3) and the global tier (D18) expressible: half a `rateLimit` is never merged.
 *
 * One definition, used by both planes: the control plane validates on write, the data plane
 * interprets. Unknown unit keys and unknown fields are rejected, so nothing passes through unread.
 */
import { templateErrorsDeep } from "./template.ts";

export const POLICY_UNITS = [
  "auth.subscriptionKey",
  "auth.basic",
  "auth.jwt",
  "auth.introspection",
  "auth.mtls",
  "ipAllow",
  "cors",
  "preconditions",
  "validate",
  "rewrite",
  "headers.request",
  "headers.response",
  "transform",
  "cache",
  "rateLimit",
  "quota",
  "timeoutMs",
  "retries",
  "circuitBreaker",
  "concurrency",
  "backendAuth",
  "passthrough",
  "errorFormat",
] as const;

export type PolicyUnitKey = (typeof POLICY_UNITS)[number];

/**
 * Which units may be attached to an environment's **global** tier (goal G2, deviation D18).
 *
 * An allowlist rather than an exclusion list, so a unit added later is not globally attachable
 * until somebody decides it should be `[R2-08]`. The six that are missing are per-API by nature:
 * `errorFormat` is derived from the variant; `rewrite`, `transform`, `backendAuth` and `cache`
 * describe one backend and one contract; `passthrough` changes what a route *is*.
 */
export const GLOBAL_UNITS: readonly string[] = [
  "auth.subscriptionKey",
  "auth.basic",
  "auth.jwt",
  "auth.introspection",
  "auth.mtls",
  "ipAllow",
  "cors",
  "preconditions",
  "validate",
  "headers.request",
  "headers.response",
  "rateLimit",
  "quota",
  "timeoutMs",
  "retries",
  "circuitBreaker",
  "concurrency",
];

/** The units a per-operation override may carry (plan `[R2-04]`). */
export const OPERATION_OVERRIDABLE: readonly string[] = [
  "validate",
  "rateLimit",
  "quota",
  "timeoutMs",
  "cache",
];

const OPERATION_KEY = /^operations\["([A-Za-z0-9._:/{}-]{1,120})"\]\.(.+)$/;

/** `operations["getPet"].rateLimit` → `{ operationId: "getPet", unit: "rateLimit" }`, or null. */
export function parseOperationUnitKey(
  unitKey: string,
): { operationId: string; unit: string } | null {
  const match = OPERATION_KEY.exec(unitKey);
  if (!match) return null;
  return { operationId: match[1]!, unit: match[2]! };
}

export function operationUnitKey(operationId: string, unit: string): string {
  return `operations["${operationId}"].${unit}`;
}

export function isGloballyAttachable(unitKey: string): boolean {
  // An operation id means nothing outside the API that declares it, so no per-operation unit is
  // globally attachable, whatever its base unit.
  if (parseOperationUnitKey(unitKey)) return false;
  return GLOBAL_UNITS.includes(unitKey) || unitKey === DISABLED_KEY;
}

/**
 * Configured, but not running.
 *
 * `disabled` is a reserved key holding the unit keys the document carries but the gateway must
 * not apply. It exists because turning a policy off and losing its configuration are different
 * things: an operator suppressing a rate limit during an incident wants the numbers back
 * afterwards, and deleting the unit is how they get lost. The alternative — a flag inside every
 * unit's own value — would put the same field in twenty-one validators and let each of them
 * disagree about it.
 *
 * It is subtracted in the control plane, in `activeDocument`, so a disabled unit never reaches
 * the wire at all and no gateway has to know the concept exists.
 */
export const DISABLED_KEY = "disabled";

/** The unit keys a document switches off, ignoring anything it does not actually carry. */
export function disabledUnits(doc: Record<string, unknown>): string[] {
  const raw = doc[DISABLED_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((key): key is string => typeof key === "string" && doc[key] !== undefined);
}

/**
 * The document as the gateway will see it: the reserved key gone, and every unit it names gone
 * with it. Everything that renders, counts or cross-checks a document reads this rather than the
 * stored one, so "off" cannot mean one thing on a screen and another at the gateway.
 */
export function activeDocument<T extends Record<string, unknown>>(doc: T): T {
  const off = disabledUnits(doc);
  if (off.length === 0 && doc[DISABLED_KEY] === undefined) return doc;
  const out = { ...doc } as Record<string, unknown>;
  delete out[DISABLED_KEY];
  for (const key of off) delete out[key];
  return out as T;
}

// ---------------------------------------------------------------------------- unit value types

export interface SubscriptionKeyUnit {
  in: "header" | "query";
  name: string;
  /** Design section 5: defaults to false — the key never reaches the backend unless opted in. */
  forwardCredentials?: boolean;
}

export interface BasicAuthUnit {
  /** Resolves through INTEGRATIONS_FILE.sharedSecrets; an owner never writes a secret. */
  credentialRef: string;
  realm?: string;
  forwardCredentials?: boolean;
}

export interface JwtAuthUnit {
  /** Resolves to a vetted issuer: JWKS URL, allowed algorithms, default audience. */
  issuerRef: string;
  headerName?: string;
  scheme?: string;
  audience?: string[];
  requiredScopes?: string[];
  /**
   * Per-operation scope requirements, keyed by operation id or by the design's `"GET /orders"`
   * form. Checked at pipeline step 11, where the operation is known `[R3-14]`.
   */
  scopeMap?: Record<string, string[]>;
  clockSkewSec?: number;
  forwardCredentials?: boolean;
}

export interface IntrospectionAuthUnit {
  issuerRef: string;
  cacheTtlSec?: number;
  requiredScopes?: string[];
  forwardCredentials?: boolean;
}

export interface MtlsAuthUnit {
  allowedIssuers?: string[];
  allowedSubjectCns?: string[];
  allowedSans?: string[];
  /**
   * Design section 5.6: CN alone is a weaker identity check than CN pinned to an issuer, and the
   * boundary sits at the reverse proxy's client-CA bundle. Required by schema, so CN-only cannot
   * happen by omission, and such routes appear in the governance report.
   */
  acknowledgeCnOnly?: boolean;
}

export type IpAllowUnit = string[];

export interface CorsUnit {
  origins: string[];
  methods?: string[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAgeSec?: number;
}

export interface RequireHeaderCheck {
  name: string;
  present?: true;
  equals?: string;
  pattern?: string;
  /** Constant-time comparison against a shared secret resolved by name (design section 5.6). */
  credentialRef?: string;
}

export interface RequireQueryCheck {
  name: string;
  present?: true;
  equals?: string;
  pattern?: string;
}

export interface RequireClientCertCheck {
  issuers?: string[];
  subjectCns?: string[];
  sans?: string[];
}

export interface RequireOperationCheck {
  methods: string[];
}

export interface PreconditionRule {
  requireHeader?: RequireHeaderCheck;
  requireQuery?: RequireQueryCheck;
  requireClientCert?: RequireClientCertCheck;
  requireOperation?: RequireOperationCheck;
  deny: {
    status: number;
    reason: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

export type PreconditionsUnit = PreconditionRule[];

export type ValidationState = "blocking" | "warning" | "disabled";

export interface ValidateAlways {
  contentType?: string[];
  maxBodyBytes?: number;
  maxDepth?: number;
  json?: { maxArrayLength?: number; duplicateKeys?: "reject" | "last-wins" };
  xml?: { maxElements?: number };
}

export interface ValidateSample {
  alwaysUnderBytes?: number;
  rate: number;
  coldStart?: number;
  onFailureEscalateSec?: number;
  key?: Array<"operation" | "subscription">;
}

export interface ValidateUnit {
  request?: ValidationState;
  response?: ValidationState;
  /** Required by schema whenever `request` is not `blocking` (design section 5.1). */
  downgradeReason?: string;
  headers?: boolean;
  body?: boolean;
  always?: ValidateAlways;
  /** Warning mode only: sampling plus rejecting would make the same payload succeed by luck. */
  sample?: ValidateSample;
  maxConcurrent?: number;
  onSaturated?: "skip";
  logEvents?: { includeBodyExcerptBytes?: number };
}

export interface RewriteUnit {
  stripBasePath?: boolean;
  /** A template over the matched operation's path parameters, e.g. `/{vin}/description`. */
  path?: string;
  copyUnmatchedParams?: boolean;
  query?: { set?: Record<string, string>; remove?: string[] };
}

export interface HeaderRulesUnit {
  remove?: string[];
  set?: Record<string, string>;
  append?: Record<string, string>;
  skip?: Record<string, string>;
}

export interface TransformUnit {
  /** Deviation D21: only `none`. Generating XML from an XSD is a writer, not a reader. */
  request?: "none";
  response?: "none" | "soap-to-json";
}

export interface CacheUnit {
  ttlSec: number;
  vary?: string[];
  varyBySubscription?: boolean;
  mustRevalidate?: boolean;
  downstream?: "public" | "private" | "none";
  maxBodyBytes?: number;
}

export interface RateLimitUnit {
  calls: number;
  periodSec: number;
  per: "instance";
  by: "subscription";
  scope: "route" | "product";
  emitHeaders?: boolean;
}

export interface QuotaUnit {
  calls: number;
  periodSec: number;
  /** Design section 5.7: a per-instance monthly quota is not a quota. */
  per: "fleet";
  by: "subscription";
  scope: "route" | "product";
  emitHeaders?: boolean;
}

export interface RetriesUnit {
  attempts: number;
  on: Array<"502" | "503" | "504" | "timeout" | "connect">;
  idempotentOnly?: boolean;
}

export interface CircuitBreakerUnit {
  failures: number;
  windowSec: number;
  openSec: number;
  halfOpenProbes?: number;
}

/**
 * How every gateway rejection is rendered. The *default* is resolved once, at config-build time,
 * from the resource kind and (for SOAP) the WSDL's version, and written explicitly into every
 * route's document — so the data plane never computes a default (review V3-03).
 */
export interface ErrorFormatUnit {
  shape: "problem+json" | "soap-fault" | "jsonrpc";
  soapVersion?: "1.1" | "1.2";
}

/**
 * A bulkhead: the most upstream calls this route may have in flight on one instance.
 *
 * `timeoutMs` bounds how long one request may wait; it does not bound how many may be waiting.
 * Those are different failures. In-flight work settles at roughly `arrival rate × timeout`, so at
 * 500 rps against a hung backend with a 30 s timeout that is 15,000 parked requests, each holding
 * two sockets, on a process measured comfortable at about a thousand. Nothing about the *other*
 * routes is wrong, and all of them go down with it.
 *
 * So: a ceiling per route, and shed at the ceiling rather than queue. Per instance, like
 * `rateLimit`, so the fleet ceiling is `maxInFlight × instances`.
 */
export interface ConcurrencyUnit {
  maxInFlight: number;
  per: "instance";
  /** `Retry-After` on the 503. Zero is valid and means "immediately". */
  retryAfterSec?: number;
}

export type BackendAuthUnit =
  | { type: "none" }
  | { type: "basic"; credentialRef: string }
  | { type: "api-key"; credentialRef: string; in: "header" | "query"; name: string }
  | {
      type: "oauth2-client-credentials";
      tokenProviderRef: string;
      scope?: string;
      invalidateOnStatus?: number[];
    }
  | {
      type: "hmac-sa-key-lite";
      schemeRef: string;
      dateHeader?: string;
      serviceShortcut: string;
    }
  | { type: "mtls" };

export interface PassthroughUnit {
  websocket?: boolean;
  sse?: boolean;
  streamIdleTimeoutSec?: number;
  maxConnectionSec?: number;
  maxConcurrentConnections?: number;
  /** 0 means unbounded, which is the design's own default. */
  maxBytesPerConnection?: number;
}

export interface PolicyDocument {
  "auth.subscriptionKey"?: SubscriptionKeyUnit;
  "auth.basic"?: BasicAuthUnit;
  "auth.jwt"?: JwtAuthUnit;
  "auth.introspection"?: IntrospectionAuthUnit;
  "auth.mtls"?: MtlsAuthUnit;
  ipAllow?: IpAllowUnit;
  cors?: CorsUnit;
  preconditions?: PreconditionsUnit;
  validate?: ValidateUnit;
  rewrite?: RewriteUnit;
  "headers.request"?: HeaderRulesUnit;
  "headers.response"?: HeaderRulesUnit;
  transform?: TransformUnit;
  cache?: CacheUnit;
  rateLimit?: RateLimitUnit;
  quota?: QuotaUnit;
  timeoutMs?: number;
  retries?: RetriesUnit;
  circuitBreaker?: CircuitBreakerUnit;
  concurrency?: ConcurrencyUnit;
  backendAuth?: BackendAuthUnit;
  passthrough?: PassthroughUnit;
  errorFormat?: ErrorFormatUnit;
  /** `operations["<id>"].<unit>` — a per-operation override is its own unit (design section 5). */
  [operationUnit: string]: unknown;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Deviation D8: JS RegExp backtracks where design section 5.6 assumed RE2. */
export const MAX_PATTERN_LENGTH = 200;
export const PATTERN_VALUE_MAX_BYTES = 1024;
/** The ceiling a single route may claim of one instance. Above it, use more instances. */
export const MAX_ROUTE_IN_FLIGHT = 100_000;

/** Design section 5.1's defaults, resolved once at config-build time and written explicitly. */
export const VALIDATE_DEFAULTS = {
  request: "blocking" as ValidationState,
  response: "disabled" as ValidationState,
  headers: true,
  body: true,
  maxBodyBytes: 1024 * 1024,
  rpcMaxBodyBytes: 256 * 1024,
  maxDepth: 32,
  maxArrayLength: 10_000,
  duplicateKeys: "reject" as const,
  maxElements: 100_000,
  maxConcurrent: 8,
  sampleRate: 0.1,
  coldStart: 20,
  onFailureEscalateSec: 300,
  alwaysUnderBytes: 65_536,
};

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"];
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

export function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------- helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string): string[] {
  return Object.keys(value)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}: unknown field "${k}" (allowed: ${allowed.join(", ")})`);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function intField(
  value: unknown,
  where: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (value === undefined) return;
  if (!isInt(value) || value < min || value > max) {
    errors.push(`${where}: expected an integer between ${min} and ${max}`);
  }
}

function boolField(value: unknown, where: string, errors: string[]): void {
  if (value !== undefined && typeof value !== "boolean") errors.push(`${where}: expected a boolean`);
}

function refField(value: unknown, where: string, errors: string[]): void {
  if (typeof value !== "string" || !REF_NAME.test(value)) {
    errors.push(
      `${where}: expected the name of an entry in INTEGRATIONS_FILE (1-64 characters, letters, digits, . _ -)`,
    );
  }
}

function stringArrayField(
  value: unknown,
  where: string,
  errors: string[],
  each?: (item: string, index: number) => string | null,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${where}: expected an array of strings`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${where}[${index}]: expected a string`);
      return;
    }
    const message = each?.(item, index);
    if (message) errors.push(`${where}[${index}]: ${message}`);
  });
}

function stringMap(value: unknown, where: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${where}: expected an object of header name to value`);
    return;
  }
  for (const [name, v] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) errors.push(`${where}: "${name}" is not a valid header name`);
    if (typeof v !== "string") errors.push(`${where}.${name}: expected a string`);
  }
  errors.push(...templateErrorsDeep(value, where));
}

// ------------------------------------------------------------------- the pattern linter (D8)

function hasQuantifierOrAlternation(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "{" || ch === "|") return true;
  }
  return false;
}

function hasNestedQuantifier(pattern: string): boolean {
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      stack.push(i);
      continue;
    }
    if (ch === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      const next = pattern[i + 1];
      if (next === "*" || next === "+" || next === "{") {
        if (hasQuantifierOrAlternation(pattern.slice(start + 1, i))) return true;
      }
    }
  }
  return false;
}

/**
 * Design section 5.6 relies on RE2, which cannot backtrack. Bun has no RE2, and the value being
 * matched is caller-controlled, so a pattern like `(a+)+$` would be a CPU denial of service
 * against the whole event loop. Constructs that make catastrophic backtracking possible are
 * rejected at write time instead.
 */
export function lintPattern(pattern: string, where = "pattern"): string[] {
  const errors: string[] = [];
  if (pattern.length > MAX_PATTERN_LENGTH) {
    errors.push(`${where}: longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) {
    errors.push(`${where}: backreferences are not allowed (they force backtracking)`);
  }
  if (/\(\?<?[=!]/.test(pattern)) {
    errors.push(`${where}: lookahead and lookbehind are not allowed (they force backtracking)`);
  }
  if (hasNestedQuantifier(pattern)) {
    errors.push(
      `${where}: a quantifier applied to a group that itself repeats or alternates is not allowed ` +
        `(catastrophic backtracking, e.g. "(a+)+")`,
    );
  }
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const lo = Number(m[1]);
    const hi = m[2] === undefined || m[2] === "" ? lo : Number(m[2]);
    if (lo > 1000 || hi > 1000) errors.push(`${where}: repetition bounds above 1000 are not allowed`);
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    errors.push(`${where}: not a valid regular expression (${(err as Error).message})`);
  }
  return errors;
}

/** `10.0.0.0/8` and friends, checked at write time so the gateway never parses a bad CIDR. */
function cidrError(value: string): string | null {
  const [ip, bitsRaw] = value.split("/");
  if (!ip || bitsRaw === undefined) return 'expected "<ipv4>/<bits>"';
  const octets = ip.split(".");
  if (octets.length !== 4) return "expected an IPv4 address";
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(octet)) {
      return `"${octet}" is not an octet`;
    }
  }
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return "expected a prefix length 0-32";
  return null;
}

// ---------------------------------------------------------------------------- unit validation

function validateSubscriptionKey(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["auth.subscriptionKey: expected an object"];
  errors.push(...unknownKeys(value, ["in", "name", "forwardCredentials"], "auth.subscriptionKey"));
  if (value.in !== "header" && value.in !== "query") {
    errors.push('auth.subscriptionKey.in: expected "header" or "query"');
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    errors.push("auth.subscriptionKey.name: expected a non-empty string");
  } else if (value.in === "header" && !HEADER_NAME.test(value.name)) {
    errors.push(`auth.subscriptionKey.name: "${value.name}" is not a valid header name`);
  }
  boolField(value.forwardCredentials, "auth.subscriptionKey.forwardCredentials", errors);
  return errors;
}

function validateBasic(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["auth.basic: expected an object"];
  errors.push(...unknownKeys(value, ["credentialRef", "realm", "forwardCredentials"], "auth.basic"));
  refField(value.credentialRef, "auth.basic.credentialRef", errors);
  if (value.realm !== undefined && typeof value.realm !== "string") {
    errors.push("auth.basic.realm: expected a string");
  }
  boolField(value.forwardCredentials, "auth.basic.forwardCredentials", errors);
  return errors;
}

function validateJwt(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["auth.jwt: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      [
        "issuerRef",
        "headerName",
        "scheme",
        "audience",
        "requiredScopes",
        "scopeMap",
        "clockSkewSec",
        "forwardCredentials",
      ],
      "auth.jwt",
    ),
  );
  refField(value.issuerRef, "auth.jwt.issuerRef", errors);
  if (value.headerName !== undefined && (typeof value.headerName !== "string" || !HEADER_NAME.test(value.headerName))) {
    errors.push("auth.jwt.headerName: expected a valid header name");
  }
  if (value.scheme !== undefined && typeof value.scheme !== "string") {
    errors.push("auth.jwt.scheme: expected a string");
  }
  stringArrayField(value.audience, "auth.jwt.audience", errors);
  stringArrayField(value.requiredScopes, "auth.jwt.requiredScopes", errors);
  if (value.scopeMap !== undefined) {
    if (!isPlainObject(value.scopeMap)) {
      errors.push("auth.jwt.scopeMap: expected an object of operation to required scopes");
    } else {
      for (const [key, scopes] of Object.entries(value.scopeMap)) {
        stringArrayField(scopes, `auth.jwt.scopeMap.${key}`, errors);
      }
    }
  }
  intField(value.clockSkewSec, "auth.jwt.clockSkewSec", 0, 300, errors);
  boolField(value.forwardCredentials, "auth.jwt.forwardCredentials", errors);
  return errors;
}

function validateIntrospection(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["auth.introspection: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      ["issuerRef", "cacheTtlSec", "requiredScopes", "forwardCredentials"],
      "auth.introspection",
    ),
  );
  refField(value.issuerRef, "auth.introspection.issuerRef", errors);
  intField(value.cacheTtlSec, "auth.introspection.cacheTtlSec", 0, 3600, errors);
  stringArrayField(value.requiredScopes, "auth.introspection.requiredScopes", errors);
  boolField(value.forwardCredentials, "auth.introspection.forwardCredentials", errors);
  return errors;
}

function validateMtls(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["auth.mtls: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      ["allowedIssuers", "allowedSubjectCns", "allowedSans", "acknowledgeCnOnly"],
      "auth.mtls",
    ),
  );
  stringArrayField(value.allowedIssuers, "auth.mtls.allowedIssuers", errors);
  stringArrayField(value.allowedSubjectCns, "auth.mtls.allowedSubjectCns", errors);
  stringArrayField(value.allowedSans, "auth.mtls.allowedSans", errors);
  boolField(value.acknowledgeCnOnly, "auth.mtls.acknowledgeCnOnly", errors);

  const hasIssuer = Array.isArray(value.allowedIssuers) && value.allowedIssuers.length > 0;
  const hasCn = Array.isArray(value.allowedSubjectCns) && value.allowedSubjectCns.length > 0;
  const hasSan = Array.isArray(value.allowedSans) && value.allowedSans.length > 0;
  if (!hasIssuer && !hasCn && !hasSan) {
    errors.push(
      "auth.mtls: expected at least one of allowedIssuers, allowedSubjectCns or allowedSans — " +
        "a unit that accepts every certificate the proxy verified is not an authentication policy",
    );
  }
  // Design section 5.6: CN-only cannot happen by omission.
  if (hasCn && !hasIssuer && value.acknowledgeCnOnly !== true) {
    errors.push(
      'auth.mtls: allowedSubjectCns without allowedIssuers requires "acknowledgeCnOnly": true. ' +
        "CN alone means anyone holding a certificate with that CN from any CA the reverse proxy " +
        "trusts for client authentication (design section 5.6).",
    );
  }
  return errors;
}

function validateIpAllow(value: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0) {
    return ["ipAllow: expected a non-empty array of CIDR ranges"];
  }
  if (value.length > 64) errors.push("ipAllow: at most 64 ranges");
  stringArrayField(value, "ipAllow", errors, (item) => cidrError(item));
  return errors;
}

function validateCors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["cors: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      ["origins", "methods", "headers", "exposeHeaders", "credentials", "maxAgeSec"],
      "cors",
    ),
  );
  if (!Array.isArray(value.origins) || value.origins.length === 0) {
    errors.push('cors.origins: expected a non-empty array of origins, or ["*"]');
  } else {
    stringArrayField(value.origins, "cors.origins", errors, (item) => {
      if (item === "*") return null;
      try {
        const url = new URL(item);
        return url.origin === item ? null : `expected an origin like https://app.example (no path)`;
      } catch {
        return "expected an origin like https://app.example";
      }
    });
  }
  stringArrayField(value.methods, "cors.methods", errors, (item) =>
    HTTP_METHODS.includes(item.toUpperCase()) ? null : `"${item}" is not an HTTP method`,
  );
  stringArrayField(value.headers, "cors.headers", errors, (item) =>
    HEADER_NAME.test(item) ? null : "is not a valid header name",
  );
  stringArrayField(value.exposeHeaders, "cors.exposeHeaders", errors, (item) =>
    HEADER_NAME.test(item) ? null : "is not a valid header name",
  );
  boolField(value.credentials, "cors.credentials", errors);
  intField(value.maxAgeSec, "cors.maxAgeSec", 0, 86_400, errors);
  // A wildcard origin with credentials is refused by every browser; refusing it here says why.
  if (value.credentials === true && Array.isArray(value.origins) && value.origins.includes("*")) {
    errors.push(
      'cors: credentials cannot be combined with the "*" origin — browsers refuse the pair, so the ' +
        "route would appear configured and never work. List the origins instead.",
    );
  }
  return errors;
}

function validateCheck(rule: Record<string, unknown>, where: string, errors: string[]): void {
  const checks = ["requireHeader", "requireQuery", "requireClientCert", "requireOperation"].filter(
    (k) => rule[k] !== undefined,
  );
  if (checks.length !== 1) {
    errors.push(
      `${where}: expected exactly one check of requireHeader, requireQuery, requireClientCert or ` +
        `requireOperation (found ${checks.length === 0 ? "none" : checks.join(", ")})`,
    );
    return;
  }

  if (rule.requireHeader !== undefined || rule.requireQuery !== undefined) {
    const isHeader = rule.requireHeader !== undefined;
    const check = (isHeader ? rule.requireHeader : rule.requireQuery) as unknown;
    const label = `${where}.${isHeader ? "requireHeader" : "requireQuery"}`;
    if (!isPlainObject(check)) {
      errors.push(`${label}: expected an object`);
      return;
    }
    const allowed = isHeader
      ? ["name", "present", "equals", "pattern", "credentialRef"]
      : ["name", "present", "equals", "pattern"];
    errors.push(...unknownKeys(check, allowed, label));
    if (typeof check.name !== "string" || (isHeader && !HEADER_NAME.test(check.name))) {
      errors.push(`${label}.name: expected a valid ${isHeader ? "header" : "query parameter"} name`);
    }
    const modes = allowed.slice(1).filter((k) => check[k] !== undefined);
    if (modes.length !== 1) {
      errors.push(
        `${label}: expected exactly one of ${allowed.slice(1).join(", ")} (found ${
          modes.length === 0 ? "none" : modes.join(", ")
        })`,
      );
    }
    if (check.present !== undefined && check.present !== true) {
      errors.push(`${label}.present: expected true`);
    }
    if (check.equals !== undefined && typeof check.equals !== "string") {
      errors.push(`${label}.equals: expected a string`);
    }
    if (check.credentialRef !== undefined) refField(check.credentialRef, `${label}.credentialRef`, errors);
    if (check.pattern !== undefined) {
      if (typeof check.pattern !== "string") errors.push(`${label}.pattern: expected a string`);
      else errors.push(...lintPattern(check.pattern, `${label}.pattern`));
    }
    return;
  }

  if (rule.requireClientCert !== undefined) {
    const check = rule.requireClientCert;
    const label = `${where}.requireClientCert`;
    if (!isPlainObject(check)) {
      errors.push(`${label}: expected an object`);
      return;
    }
    errors.push(...unknownKeys(check, ["issuers", "subjectCns", "sans"], label));
    stringArrayField(check.issuers, `${label}.issuers`, errors);
    stringArrayField(check.subjectCns, `${label}.subjectCns`, errors);
    stringArrayField(check.sans, `${label}.sans`, errors);
    if (
      !Array.isArray(check.issuers) &&
      !Array.isArray(check.subjectCns) &&
      !Array.isArray(check.sans)
    ) {
      errors.push(`${label}: expected at least one of issuers, subjectCns or sans`);
    }
    return;
  }

  const check = rule.requireOperation;
  const label = `${where}.requireOperation`;
  if (!isPlainObject(check)) {
    errors.push(`${label}: expected an object`);
    return;
  }
  errors.push(...unknownKeys(check, ["methods"], label));
  if (!Array.isArray(check.methods) || check.methods.length === 0) {
    errors.push(`${label}.methods: expected a non-empty array of HTTP methods`);
  } else {
    stringArrayField(check.methods, `${label}.methods`, errors, (item) =>
      HTTP_METHODS.includes(item.toUpperCase()) ? null : `"${item}" is not an HTTP method`,
    );
  }
}

function validatePreconditions(value: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value)) return ["preconditions: expected an array of rules"];
  if (value.length === 0) errors.push("preconditions: expected at least one rule");
  if (value.length > 20) errors.push("preconditions: at most 20 rules");
  value.forEach((rule, i) => {
    const where = `preconditions[${i}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${where}: expected an object`);
      return;
    }
    errors.push(
      ...unknownKeys(
        rule,
        ["requireHeader", "requireQuery", "requireClientCert", "requireOperation", "deny"],
        where,
      ),
    );
    validateCheck(rule, where, errors);

    const deny = rule.deny;
    if (!isPlainObject(deny)) {
      errors.push(`${where}.deny: expected an object`);
      return;
    }
    errors.push(...unknownKeys(deny, ["status", "reason", "headers", "body"], `${where}.deny`));
    if (!isInt(deny.status) || deny.status < 400 || deny.status > 599) {
      errors.push(`${where}.deny.status: expected an integer between 400 and 599`);
    }
    if (typeof deny.reason !== "string" || deny.reason.length === 0) {
      errors.push(`${where}.deny.reason: expected a non-empty string`);
    }
    if (deny.headers !== undefined) stringMap(deny.headers, `${where}.deny.headers`, errors);
    if (deny.body !== undefined) {
      if (typeof deny.body !== "string" && !isPlainObject(deny.body) && !Array.isArray(deny.body)) {
        errors.push(`${where}.deny.body: expected a JSON object, array or string`);
      }
      errors.push(...templateErrorsDeep(deny.body, `${where}.deny.body`));
    }
    errors.push(...templateErrorsDeep(deny.reason, `${where}.deny.reason`));
  });
  return errors;
}

const STATES = ["blocking", "warning", "disabled"];

function validateValidate(value: unknown, opts: { operationScoped?: boolean } = {}): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["validate: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      [
        "request",
        "response",
        "downgradeReason",
        "headers",
        "body",
        "always",
        "sample",
        "maxConcurrent",
        "onSaturated",
        "logEvents",
      ],
      "validate",
    ),
  );
  for (const direction of ["request", "response"] as const) {
    if (value[direction] !== undefined && !STATES.includes(value[direction] as string)) {
      errors.push(`validate.${direction}: expected blocking, warning or disabled`);
    }
  }
  boolField(value.headers, "validate.headers", errors);
  boolField(value.body, "validate.body", errors);

  const request = (value.request as string | undefined) ?? VALIDATE_DEFAULTS.request;
  if (request !== "blocking") {
    if (typeof value.downgradeReason !== "string" || value.downgradeReason.trim().length < 8) {
      errors.push(
        "validate.downgradeReason: required whenever request is not blocking, and long enough to " +
          "be a reason (design section 5.1). It is recorded in the audit log and listed in " +
          "GET /api/validation/downgrades.",
      );
    }
  } else if (value.downgradeReason !== undefined) {
    errors.push("validate.downgradeReason: only applies when request is not blocking");
  }

  if (value.always !== undefined) {
    if (opts.operationScoped) {
      errors.push(
        "validate.always: is route-level only. It is enforced at pipeline step 3, before the " +
          "operation is known at step 11, so a per-operation value could not be applied [R2-02].",
      );
    }
    if (!isPlainObject(value.always)) errors.push("validate.always: expected an object");
    else {
      const always = value.always;
      errors.push(
        ...unknownKeys(always, ["contentType", "maxBodyBytes", "maxDepth", "json", "xml"], "validate.always"),
      );
      stringArrayField(always.contentType, "validate.always.contentType", errors, (item) =>
        /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(item) ? null : "expected a media type",
      );
      intField(always.maxBodyBytes, "validate.always.maxBodyBytes", 1, 1024 * 1024 * 1024, errors);
      intField(always.maxDepth, "validate.always.maxDepth", 1, 512, errors);
      if (always.json !== undefined) {
        if (!isPlainObject(always.json)) errors.push("validate.always.json: expected an object");
        else {
          errors.push(
            ...unknownKeys(always.json, ["maxArrayLength", "duplicateKeys"], "validate.always.json"),
          );
          intField(always.json.maxArrayLength, "validate.always.json.maxArrayLength", 1, 10_000_000, errors);
          if (
            always.json.duplicateKeys !== undefined &&
            always.json.duplicateKeys !== "reject" &&
            always.json.duplicateKeys !== "last-wins"
          ) {
            errors.push('validate.always.json.duplicateKeys: expected "reject" or "last-wins"');
          }
        }
      }
      if (always.xml !== undefined) {
        if (!isPlainObject(always.xml)) errors.push("validate.always.xml: expected an object");
        else {
          errors.push(...unknownKeys(always.xml, ["maxElements"], "validate.always.xml"));
          intField(always.xml.maxElements, "validate.always.xml.maxElements", 1, 10_000_000, errors);
        }
      }
    }
  }

  if (value.sample !== undefined) {
    const response = (value.response as string | undefined) ?? VALIDATE_DEFAULTS.response;
    if (request === "blocking" && response === "blocking") {
      errors.push(
        "validate.sample: sampling exists only in warning mode. Sampling plus rejecting would make " +
          "the same payload succeed or fail depending on where a counter landed (design section 5.1).",
      );
    }
    if (!isPlainObject(value.sample)) errors.push("validate.sample: expected an object");
    else {
      const sample = value.sample;
      errors.push(
        ...unknownKeys(
          sample,
          ["alwaysUnderBytes", "rate", "coldStart", "onFailureEscalateSec", "key"],
          "validate.sample",
        ),
      );
      if (typeof sample.rate !== "number" || sample.rate <= 0 || sample.rate > 1) {
        errors.push("validate.sample.rate: expected a number greater than 0 and at most 1");
      }
      intField(sample.alwaysUnderBytes, "validate.sample.alwaysUnderBytes", 0, 16 * 1024 * 1024, errors);
      intField(sample.coldStart, "validate.sample.coldStart", 0, 10_000, errors);
      intField(sample.onFailureEscalateSec, "validate.sample.onFailureEscalateSec", 0, 86_400, errors);
      stringArrayField(sample.key, "validate.sample.key", errors, (item) =>
        item === "operation" || item === "subscription" ? null : 'expected "operation" or "subscription"',
      );
    }
  }

  intField(value.maxConcurrent, "validate.maxConcurrent", 1, 64, errors);
  if (value.onSaturated !== undefined && value.onSaturated !== "skip") {
    errors.push('validate.onSaturated: only "skip" is implemented — the pool never queues without bound');
  }
  if (value.logEvents !== undefined) {
    if (!isPlainObject(value.logEvents)) errors.push("validate.logEvents: expected an object");
    else {
      errors.push(...unknownKeys(value.logEvents, ["includeBodyExcerptBytes"], "validate.logEvents"));
      intField(
        value.logEvents.includeBodyExcerptBytes,
        "validate.logEvents.includeBodyExcerptBytes",
        0,
        4096,
        errors,
      );
    }
  }
  return errors;
}

function validateRewrite(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["rewrite: expected an object"];
  errors.push(...unknownKeys(value, ["stripBasePath", "path", "copyUnmatchedParams", "query"], "rewrite"));
  boolField(value.stripBasePath, "rewrite.stripBasePath", errors);
  boolField(value.copyUnmatchedParams, "rewrite.copyUnmatchedParams", errors);
  if (value.path !== undefined) {
    if (typeof value.path !== "string" || !value.path.startsWith("/")) {
      errors.push('rewrite.path: expected a path template starting with "/"');
    } else if (/[?#]/.test(value.path)) {
      errors.push("rewrite.path: must not contain a query string or fragment; use rewrite.query");
    }
  }
  if (value.query !== undefined) {
    if (!isPlainObject(value.query)) errors.push("rewrite.query: expected an object");
    else {
      errors.push(...unknownKeys(value.query, ["set", "remove"], "rewrite.query"));
      if (value.query.set !== undefined) {
        if (!isPlainObject(value.query.set)) errors.push("rewrite.query.set: expected an object");
        else {
          for (const [name, v] of Object.entries(value.query.set)) {
            if (typeof v !== "string") errors.push(`rewrite.query.set.${name}: expected a string`);
          }
          errors.push(...templateErrorsDeep(value.query.set, "rewrite.query.set"));
        }
      }
      stringArrayField(value.query.remove, "rewrite.query.remove", errors);
    }
  }
  return errors;
}

function validateHeaderRules(value: unknown, unit: string): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return [`${unit}: expected an object`];
  errors.push(...unknownKeys(value, ["remove", "set", "append", "skip"], unit));
  if (value.remove !== undefined) {
    stringArrayField(value.remove, `${unit}.remove`, errors, (item) =>
      HEADER_NAME.test(item) ? null : "expected a valid header name",
    );
  }
  for (const action of ["set", "append", "skip"] as const) {
    if (value[action] !== undefined) stringMap(value[action], `${unit}.${action}`, errors);
  }
  return errors;
}

function validateTransform(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["transform: expected an object"];
  errors.push(...unknownKeys(value, ["request", "response"], "transform"));
  if (value.request !== undefined && value.request !== "none") {
    errors.push(
      'transform.request: only "none" is implemented (deviation D21). Turning JSON into a SOAP ' +
        "envelope requires generating XML from the XSD — a writer, not a reader.",
    );
  }
  if (value.response !== undefined && value.response !== "none" && value.response !== "soap-to-json") {
    errors.push('transform.response: expected "none" or "soap-to-json"');
  }
  return errors;
}

function validateCache(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["cache: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      ["ttlSec", "vary", "varyBySubscription", "mustRevalidate", "downstream", "maxBodyBytes"],
      "cache",
    ),
  );
  if (!isInt(value.ttlSec) || value.ttlSec < 1 || value.ttlSec > 86_400) {
    errors.push("cache.ttlSec: expected an integer between 1 and 86400");
  }
  stringArrayField(value.vary, "cache.vary", errors, (item) =>
    HEADER_NAME.test(item) ? null : "expected a valid header name",
  );
  boolField(value.varyBySubscription, "cache.varyBySubscription", errors);
  boolField(value.mustRevalidate, "cache.mustRevalidate", errors);
  if (
    value.downstream !== undefined &&
    !["public", "private", "none"].includes(value.downstream as string)
  ) {
    errors.push('cache.downstream: expected "public", "private" or "none"');
  }
  intField(value.maxBodyBytes, "cache.maxBodyBytes", 1, 32 * 1024 * 1024, errors);
  return errors;
}

function validateRateLimit(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["rateLimit: expected an object"];
  errors.push(
    ...unknownKeys(value, ["calls", "periodSec", "per", "by", "scope", "emitHeaders"], "rateLimit"),
  );
  if (!isInt(value.calls) || value.calls < 1) errors.push("rateLimit.calls: expected an integer >= 1");
  intField(value.periodSec, "rateLimit.periodSec", 1, 86_400, errors);
  if (value.periodSec === undefined) errors.push("rateLimit.periodSec: required");
  if (value.per !== "instance") {
    errors.push('rateLimit.per: only "instance" is implemented (design section 5.7)');
  }
  if (value.by !== "subscription") errors.push('rateLimit.by: only "subscription" is implemented');
  if (value.scope !== "route" && value.scope !== "product") {
    errors.push('rateLimit.scope: expected "route" or "product"');
  }
  boolField(value.emitHeaders, "rateLimit.emitHeaders", errors);
  return errors;
}

function validateQuota(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["quota: expected an object"];
  errors.push(
    ...unknownKeys(value, ["calls", "periodSec", "per", "by", "scope", "emitHeaders"], "quota"),
  );
  if (!isInt(value.calls) || value.calls < 1) errors.push("quota.calls: expected an integer >= 1");
  intField(value.periodSec, "quota.periodSec", 60, 366 * 86_400, errors);
  if (value.periodSec === undefined) errors.push("quota.periodSec: required (at least 60 seconds)");
  if (value.per !== "fleet") {
    errors.push(
      'quota.per: only "fleet" is implemented — a per-instance monthly quota is not a quota ' +
        "(design section 5.7)",
    );
  }
  if (value.by !== "subscription") errors.push('quota.by: only "subscription" is implemented');
  if (value.scope !== "route" && value.scope !== "product") {
    errors.push('quota.scope: expected "route" or "product"');
  }
  boolField(value.emitHeaders, "quota.emitHeaders", errors);
  return errors;
}

function validateTimeout(value: unknown): string[] {
  if (!isInt(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    return [`timeoutMs: expected an integer between 1 and ${MAX_TIMEOUT_MS}`];
  }
  return [];
}

const RETRY_ON = ["502", "503", "504", "timeout", "connect"];

function validateRetries(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["retries: expected an object"];
  errors.push(...unknownKeys(value, ["attempts", "on", "idempotentOnly"], "retries"));
  if (!isInt(value.attempts) || value.attempts < 1 || value.attempts > 5) {
    errors.push("retries.attempts: expected an integer between 1 and 5 (additional attempts)");
  }
  if (!Array.isArray(value.on) || value.on.length === 0) {
    errors.push(`retries.on: expected a non-empty array of ${RETRY_ON.join(", ")}`);
  } else {
    stringArrayField(value.on, "retries.on", errors, (item) =>
      RETRY_ON.includes(item) ? null : `expected one of ${RETRY_ON.join(", ")}`,
    );
  }
  boolField(value.idempotentOnly, "retries.idempotentOnly", errors);
  return errors;
}

function validateCircuitBreaker(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["circuitBreaker: expected an object"];
  errors.push(
    ...unknownKeys(value, ["failures", "windowSec", "openSec", "halfOpenProbes"], "circuitBreaker"),
  );
  if (!isInt(value.failures) || value.failures < 1) {
    errors.push("circuitBreaker.failures: expected an integer >= 1");
  }
  intField(value.windowSec, "circuitBreaker.windowSec", 1, 3600, errors);
  if (value.windowSec === undefined) errors.push("circuitBreaker.windowSec: required");
  intField(value.openSec, "circuitBreaker.openSec", 1, 3600, errors);
  if (value.openSec === undefined) errors.push("circuitBreaker.openSec: required");
  intField(value.halfOpenProbes, "circuitBreaker.halfOpenProbes", 1, 100, errors);
  return errors;
}

function validateConcurrency(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["concurrency: expected an object"];
  errors.push(...unknownKeys(value, ["maxInFlight", "per", "retryAfterSec"], "concurrency"));
  if (!isInt(value.maxInFlight) || value.maxInFlight < 1 || value.maxInFlight > MAX_ROUTE_IN_FLIGHT) {
    errors.push(`concurrency.maxInFlight: expected an integer between 1 and ${MAX_ROUTE_IN_FLIGHT}`);
  }
  if (value.per !== "instance") {
    errors.push(
      'concurrency.per: only "instance" is implemented — the fleet ceiling is maxInFlight x instances',
    );
  }
  intField(value.retryAfterSec, "concurrency.retryAfterSec", 0, 3600, errors);
  return errors;
}

const BACKEND_AUTH_TYPES = [
  "none",
  "basic",
  "api-key",
  "oauth2-client-credentials",
  "hmac-sa-key-lite",
  "mtls",
];

function validateBackendAuth(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["backendAuth: expected an object"];
  const type = value.type;
  if (typeof type !== "string" || !BACKEND_AUTH_TYPES.includes(type)) {
    return [`backendAuth.type: expected one of ${BACKEND_AUTH_TYPES.join(", ")}`];
  }
  switch (type) {
    case "none":
    case "mtls":
      errors.push(...unknownKeys(value, ["type"], "backendAuth"));
      break;
    case "basic":
      errors.push(...unknownKeys(value, ["type", "credentialRef"], "backendAuth"));
      refField(value.credentialRef, "backendAuth.credentialRef", errors);
      break;
    case "api-key":
      errors.push(...unknownKeys(value, ["type", "credentialRef", "in", "name"], "backendAuth"));
      refField(value.credentialRef, "backendAuth.credentialRef", errors);
      if (value.in !== "header" && value.in !== "query") {
        errors.push('backendAuth.in: expected "header" or "query"');
      }
      if (typeof value.name !== "string" || value.name.length === 0) {
        errors.push("backendAuth.name: expected a non-empty string");
      } else if (value.in === "header" && !HEADER_NAME.test(value.name)) {
        errors.push(`backendAuth.name: "${value.name}" is not a valid header name`);
      }
      break;
    case "oauth2-client-credentials":
      errors.push(
        ...unknownKeys(value, ["type", "tokenProviderRef", "scope", "invalidateOnStatus"], "backendAuth"),
      );
      refField(value.tokenProviderRef, "backendAuth.tokenProviderRef", errors);
      if (value.scope !== undefined && typeof value.scope !== "string") {
        errors.push("backendAuth.scope: expected a string");
      }
      if (value.invalidateOnStatus !== undefined) {
        if (!Array.isArray(value.invalidateOnStatus)) {
          errors.push("backendAuth.invalidateOnStatus: expected an array of status codes");
        } else {
          value.invalidateOnStatus.forEach((status, index) => {
            if (!isInt(status) || status < 400 || status > 599) {
              errors.push(`backendAuth.invalidateOnStatus[${index}]: expected a 4xx or 5xx status`);
            }
          });
        }
      }
      break;
    case "hmac-sa-key-lite":
      errors.push(
        ...unknownKeys(value, ["type", "schemeRef", "dateHeader", "serviceShortcut"], "backendAuth"),
      );
      refField(value.schemeRef, "backendAuth.schemeRef", errors);
      if (value.dateHeader !== undefined && (typeof value.dateHeader !== "string" || !HEADER_NAME.test(value.dateHeader))) {
        errors.push("backendAuth.dateHeader: expected a valid header name");
      }
      if (typeof value.serviceShortcut !== "string" || value.serviceShortcut.length === 0) {
        errors.push("backendAuth.serviceShortcut: expected a non-empty string");
      }
      break;
  }
  return errors;
}

function validatePassthrough(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["passthrough: expected an object"];
  errors.push(
    ...unknownKeys(
      value,
      [
        "websocket",
        "sse",
        "streamIdleTimeoutSec",
        "maxConnectionSec",
        "maxConcurrentConnections",
        "maxBytesPerConnection",
      ],
      "passthrough",
    ),
  );
  boolField(value.websocket, "passthrough.websocket", errors);
  boolField(value.sse, "passthrough.sse", errors);
  intField(value.streamIdleTimeoutSec, "passthrough.streamIdleTimeoutSec", 1, 86_400, errors);
  intField(value.maxConnectionSec, "passthrough.maxConnectionSec", 1, 86_400, errors);
  intField(value.maxConcurrentConnections, "passthrough.maxConcurrentConnections", 1, 100_000, errors);
  intField(value.maxBytesPerConnection, "passthrough.maxBytesPerConnection", 0, 1024 ** 4, errors);
  if (value.websocket !== true && value.sse !== true) {
    errors.push(
      "passthrough: expected websocket or sse to be true — an attached unit that enables neither " +
        "changes nothing and reads as if it did",
    );
  }
  return errors;
}

function validateErrorFormat(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["errorFormat: expected an object"];
  errors.push(...unknownKeys(value, ["shape", "soapVersion"], "errorFormat"));
  if (!["problem+json", "soap-fault", "jsonrpc"].includes(value.shape as string)) {
    errors.push('errorFormat.shape: expected "problem+json", "soap-fault" or "jsonrpc"');
  }
  if (value.soapVersion !== undefined && value.soapVersion !== "1.1" && value.soapVersion !== "1.2") {
    errors.push('errorFormat.soapVersion: expected "1.1" or "1.2"');
  }
  if (value.shape !== "soap-fault" && value.soapVersion !== undefined) {
    errors.push("errorFormat.soapVersion: only applies when shape is soap-fault");
  }
  return errors;
}

/** Validates one unit's value. Returns human-readable errors; empty means valid. */
export function validateUnit(unitKey: string, value: unknown): string[] {
  const scoped = parseOperationUnitKey(unitKey);
  if (scoped) {
    if (!OPERATION_OVERRIDABLE.includes(scoped.unit)) {
      return [
        `${unitKey}: only ${OPERATION_OVERRIDABLE.join(", ")} may be overridden per operation. ` +
          "Route authentication has already run by the time the operation is known (pipeline step " +
          "11), so an auth override could only re-authenticate or loosen the route; per-operation " +
          "authorization is auth.jwt.scopeMap.",
      ];
    }
    if (scoped.unit === "validate") return validateValidate(value, { operationScoped: true });
    return validateUnit(scoped.unit, value);
  }

  switch (unitKey) {
    case "auth.subscriptionKey":
      return validateSubscriptionKey(value);
    case "auth.basic":
      return validateBasic(value);
    case "auth.jwt":
      return validateJwt(value);
    case "auth.introspection":
      return validateIntrospection(value);
    case "auth.mtls":
      return validateMtls(value);
    case "ipAllow":
      return validateIpAllow(value);
    case "cors":
      return validateCors(value);
    case "preconditions":
      return validatePreconditions(value);
    case "validate":
      return validateValidate(value);
    case "rewrite":
      return validateRewrite(value);
    case "headers.request":
      return validateHeaderRules(value, "headers.request");
    case "headers.response":
      return validateHeaderRules(value, "headers.response");
    case "transform":
      return validateTransform(value);
    case "cache":
      return validateCache(value);
    case "rateLimit":
      return validateRateLimit(value);
    case "quota":
      return validateQuota(value);
    case "timeoutMs":
      return validateTimeout(value);
    case "retries":
      return validateRetries(value);
    case "circuitBreaker":
      return validateCircuitBreaker(value);
    case "concurrency":
      return validateConcurrency(value);
    case "backendAuth":
      return validateBackendAuth(value);
    case "passthrough":
      return validatePassthrough(value);
    case "errorFormat":
      return validateErrorFormat(value);
    case DISABLED_KEY:
      return validateDisabled(value);
    default:
      return [
        `unknown policy unit "${unitKey}" (the vocabulary is closed; known units: ` +
          `${POLICY_UNITS.join(", ")}, and operations["<id>"].{${OPERATION_OVERRIDABLE.join("|")}})`,
      ];
  }
}

/**
 * `disabled` names units, and only units this vocabulary has. Naming a unit the document does not
 * carry is allowed and ignored: a promotion can drop a unit while leaving the list that mentioned
 * it, and refusing the whole document over a dangling name would block the promotion rather than
 * the mistake.
 */
function validateDisabled(value: unknown): string[] {
  if (!Array.isArray(value)) return [`${DISABLED_KEY}: expected an array of policy unit keys`];
  const errors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      errors.push(`${DISABLED_KEY}: expected an array of policy unit keys`);
      continue;
    }
    if (entry === DISABLED_KEY) {
      errors.push(`${DISABLED_KEY}: cannot disable itself`);
      continue;
    }
    if (!(POLICY_UNITS as readonly string[]).includes(entry) && !parseOperationUnitKey(entry)) {
      errors.push(`${DISABLED_KEY}: "${entry}" is not a policy unit`);
    }
  }
  return errors;
}

export interface DocumentOptions {
  kind?: string;
  /**
   * `global` relaxes the constraints a *resource* may satisfy: an environment-wide `rateLimit`
   * with per-resource authentication is legitimate, and the effective document is the real gate
   * (plan `[R2-17]`).
   */
  tier?: "resource" | "global";
}

/** Exported because "this route authenticates nobody" is asked in three places (plan §6.3). */
export const AUTH_UNITS = [
  "auth.subscriptionKey",
  "auth.basic",
  "auth.jwt",
  "auth.introspection",
  "auth.mtls",
];

/**
 * Validates the assembled document, however it was produced (design section 5): authored, edited,
 * merged during a promotion, or merged with the environment's global tier. Per-unit validity is
 * not enough — cross-unit constraints hold too.
 */
export function validateDocument(
  stored: Record<string, unknown>,
  opts: DocumentOptions = {},
): string[] {
  const errors: string[] = [];
  // Every unit's own value is checked as *stored*, disabled ones included: switching a policy off
  // is not licence to leave nonsense in it, and the value has to be valid on the day it is
  // switched back on.
  for (const [key, value] of Object.entries(stored)) errors.push(...validateUnit(key, value));
  // The cross-unit rules are about what actually runs, so they read the document the gateway will
  // be given. A disabled rateLimit does not count against anything, and must not demand a
  // subscription key on its behalf.
  const doc = activeDocument(stored);
  const global = opts.tier === "global";

  // Only auth.subscriptionKey resolves to a subscription, and that is what these count against.
  const counted = (["rateLimit", "quota"] as const).filter((unit) => doc[unit] !== undefined);
  if (!global && counted.length > 0 && doc["auth.subscriptionKey"] === undefined) {
    errors.push(
      `${counted.join(" and ")} count by "subscription", and only auth.subscriptionKey resolves to ` +
        "one, so it must be attached on the same route (directly or from the environment's global policy)",
    );
  }

  const errorFormat = doc.errorFormat as ErrorFormatUnit | undefined;
  if (errorFormat && opts.kind !== undefined) {
    if (errorFormat.shape === "soap-fault" && opts.kind !== "soap") {
      errors.push(`errorFormat.shape: soap-fault is only valid on a soap API (this one is "${opts.kind}")`);
    }
    if (errorFormat.shape === "jsonrpc" && opts.kind !== "mcp" && opts.kind !== "a2a") {
      errors.push(
        `errorFormat.shape: jsonrpc is only valid on an mcp or a2a API (this one is "${opts.kind}")`,
      );
    }
  }

  // Design section 5.8's exclusion table, as config errors rather than silent no-ops.
  const passthrough = doc.passthrough as PassthroughUnit | undefined;
  const validate = doc.validate as ValidateUnit | undefined;
  const transform = doc.transform as TransformUnit | undefined;
  if (passthrough?.websocket) {
    if (validate?.request !== undefined && validate.request !== "disabled") {
      errors.push(
        'passthrough.websocket with validate.request "' +
          validate.request +
          '": after the upgrade there is no complete message to validate, so request validation must be disabled',
      );
    }
    if (transform && (transform.request ?? "none") !== "none") {
      errors.push("passthrough.websocket: transform.request must be none");
    }
    if (transform && (transform.response ?? "none") !== "none") {
      errors.push("passthrough.websocket: transform.response must be none");
    }
    if (doc.cache !== undefined) errors.push("passthrough.websocket: cache cannot be attached");
  }
  if (passthrough?.sse) {
    if (validate?.response !== undefined && validate.response !== "disabled") {
      errors.push(
        "passthrough.sse: response validation would have to buffer the stream, so it must be disabled",
      );
    }
    if (transform && (transform.response ?? "none") !== "none") {
      errors.push("passthrough.sse: transform.response must be none");
    }
    if (doc.cache !== undefined) errors.push("passthrough.sse: cache cannot be attached");
  }

  if (transform?.response === "soap-to-json" && opts.kind !== undefined && opts.kind !== "soap") {
    errors.push(`transform.response: soap-to-json is only valid on a soap API (this one is "${opts.kind}")`);
  }

  if (!global) {
    for (const key of Object.keys(doc)) {
      const scoped = parseOperationUnitKey(key);
      if (!scoped) continue;
      if (scoped.unit === "rateLimit" || scoped.unit === "quota") {
        if (doc["auth.subscriptionKey"] === undefined) {
          errors.push(
            `${key}: counts by subscription, so auth.subscriptionKey must be attached on the route`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Advisory findings about a document that is nonetheless *valid*. Never blocks a write — every one
 * of them is a judgement that depends on traffic the control plane cannot see.
 */
export function lintDocument(
  doc: Record<string, unknown>,
  opts: { environment?: string; kind?: string } = {},
): string[] {
  const warnings: string[] = [];
  const concurrency = doc.concurrency as ConcurrencyUnit | undefined;
  const timeoutMs = typeof doc.timeoutMs === "number" ? doc.timeoutMs : DEFAULT_TIMEOUT_MS;
  const stated = doc.timeoutMs === undefined ? `the default ${DEFAULT_TIMEOUT_MS} ms` : `${timeoutMs} ms`;

  if (concurrency === undefined) {
    const seconds = Math.round(timeoutMs / 1000);
    warnings.push(
      `No concurrency limit. With a timeout of ${stated}, a backend that stops answering parks ` +
        `roughly one request per arriving request for ${seconds}s — at 200 calls a second that is ` +
        `${(200 * timeoutMs) / 1000} requests held at once on every instance, each holding two ` +
        `sockets. Attach "Concurrency limit" to shed at a ceiling instead, and the rest of this ` +
        `gateway keeps working when this backend does not.`,
    );
  }
  const authAttached = AUTH_UNITS.some((unit) => doc[unit] !== undefined);
  if (concurrency !== undefined && !authAttached) {
    warnings.push(
      "This route sheds at a concurrency ceiling but is open, so any caller can consume the " +
        "ceiling. A subscription key makes the traffic attributable.",
    );
  }

  const validate = doc.validate as ValidateUnit | undefined;
  if (validate && (validate.request ?? VALIDATE_DEFAULTS.request) !== "blocking") {
    warnings.push(
      `Request validation is "${validate.request}", which never rejects. It is an observation, not ` +
        "a gateway-enforced control, and this route appears in GET /api/validation/downgrades.",
    );
  }

  const cache = doc.cache as CacheUnit | undefined;
  if (cache && doc["auth.subscriptionKey"] !== undefined && cache.varyBySubscription !== true) {
    warnings.push(
      "This route caches without varying by subscription, so one consumer's response can be served " +
        "to another. Right for public reference data, wrong for anything else.",
    );
  }

  const jwt = doc["auth.jwt"] as JwtAuthUnit | undefined;
  if (jwt && (!jwt.audience || jwt.audience.length === 0)) {
    warnings.push(
      "auth.jwt has no audience, so any token that issuer signs is accepted — including one minted " +
        "for a different application. Set an audience or record why not.",
    );
  }

  const mtls = doc["auth.mtls"] as MtlsAuthUnit | undefined;
  if (mtls?.acknowledgeCnOnly) {
    warnings.push(
      "This route identifies callers by certificate CN alone. The control that matters is the " +
        "breadth of the reverse proxy's client-CA bundle; the route is listed in " +
        "GET /api/governance/exceptions.",
    );
  }

  const retries = doc.retries as RetriesUnit | undefined;
  const breaker = doc.circuitBreaker as CircuitBreakerUnit | undefined;
  if (retries && breaker === undefined) {
    warnings.push(
      "Retries without a circuit breaker multiply load on a backend that is already failing. " +
        "Attach a circuit breaker so a sick backend is taken out rather than retried into.",
    );
  }
  if (breaker && retries === undefined) {
    // The rule is in plan section 8.3: a failure is a connection error, a timeout, or a 5xx that
    // `retries.on` names. Without a `retries` unit no status is named, so a backend answering 503
    // forever never opens this breaker — which is the opposite of what attaching one looks like it
    // does. Said here rather than left to be discovered from an incident.
    warnings.push(
      "This circuit breaker will only ever open on connection errors and timeouts. A 5xx counts " +
        "as a failure when `retries.on` names it, and no retries unit is attached — so a backend " +
        "returning 503 will not trip it. Add `retries` (attempts may be 1) naming the statuses " +
        "that should count.",
    );
  }

  void opts;
  return warnings;
}

export function assembleDocument(
  entries: Array<{ unit_key: string; value_json: string }>,
): PolicyDocument {
  const doc: Record<string, unknown> = {};
  for (const entry of entries) doc[entry.unit_key] = JSON.parse(entry.value_json);
  return doc as PolicyDocument;
}

/** Drives the policy editor in the UI, so the form and the validator cannot disagree. */
export const UNIT_CATALOGUE: Array<{
  key: PolicyUnitKey;
  title: string;
  group: "identity" | "traffic" | "shape" | "backend" | "protocol";
  description: string;
  defaultValue: unknown;
  /** Which variants offer this unit. Absent means every kind. */
  appliesToKinds?: string[];
  global: boolean;
}> = [
  {
    key: "auth.subscriptionKey",
    title: "Subscription key",
    group: "identity",
    description:
      "Attached means a subscription key is required on this route. Absent means the route is open.",
    defaultValue: { in: "header", name: "X-Api-Key", forwardCredentials: false },
    global: true,
  },
  {
    key: "auth.basic",
    title: "Basic authentication",
    group: "identity",
    description:
      "HTTP Basic against a shared secret registered in INTEGRATIONS_FILE. The comparison is " +
      "constant-time; an owner never writes the secret.",
    defaultValue: { credentialRef: "", realm: "api" },
    global: true,
  },
  {
    key: "auth.jwt",
    title: "JWT",
    group: "identity",
    description:
      "Verifies a bearer token against an admin-registered issuer's JWKS, with the algorithm " +
      "allowlist, audience and scopes that issuer declares. scopeMap adds per-operation scopes.",
    defaultValue: { issuerRef: "", headerName: "Authorization", scheme: "Bearer", audience: [] },
    global: true,
  },
  {
    key: "auth.introspection",
    title: "Token introspection",
    group: "identity",
    description:
      "RFC 7662 introspection against an admin-registered issuer, with a per-instance cache whose " +
      "TTL bounds revocation lag.",
    defaultValue: { issuerRef: "", cacheTtlSec: 60 },
    global: true,
  },
  {
    key: "auth.mtls",
    title: "Client certificate",
    group: "identity",
    description:
      "Reads the verified client certificate the reverse proxy passes in headers. The gateway " +
      "refuses to activate a config using this without a trusted-proxy boundary configured.",
    defaultValue: { allowedIssuers: [], allowedSubjectCns: [] },
    global: true,
  },
  {
    key: "ipAllow",
    title: "IP allowlist",
    group: "identity",
    description:
      "CIDR ranges the effective client IP must fall inside. Behind a proxy that is the rightmost " +
      "untrusted address in X-Forwarded-For, not the proxy's own.",
    defaultValue: ["10.0.0.0/8"],
    global: true,
  },
  {
    key: "cors",
    title: "CORS",
    group: "shape",
    description:
      "Preflight and response headers. The headers are added to every response including the " +
      "gateway's own rejections, so a browser sees a 401 rather than an opaque CORS failure.",
    defaultValue: { origins: ["https://portal.example"], methods: ["GET"], maxAgeSec: 600 },
    global: true,
  },
  {
    key: "preconditions",
    title: "Preconditions",
    group: "identity",
    description:
      "Ordered deny rules evaluated after authentication and the limits (design section 5.2, step 10).",
    defaultValue: [
      {
        requireHeader: { name: "X-Request-Origin", equals: "skoda-portal" },
        deny: {
          status: 403,
          reason: "Forbidden - missing or invalid X-Request-Origin header",
          body: { statusCode: 403, message: "Forbidden - missing or invalid X-Request-Origin header" },
        },
      },
    ],
    global: true,
  },
  {
    key: "validate",
    title: "Validation",
    group: "shape",
    description:
      "Request and response validation against this API's own definition. Blocking by default — " +
      "this is the one unit whose absence is not 'off', it is 'at the defaults'. Downgrading " +
      "requires a reason and is listed in the governance report.",
    defaultValue: { request: "blocking", response: "disabled" },
    global: true,
  },
  {
    key: "rewrite",
    title: "Rewrite",
    group: "shape",
    description:
      "Strip the base path, rewrite the path from the matched operation's parameters, and set or " +
      "remove query parameters.",
    defaultValue: { stripBasePath: true },
    global: false,
  },
  {
    key: "headers.request",
    title: "Request headers",
    group: "shape",
    description: "remove, then set, then append, then skip. Values may use ${...} template variables.",
    defaultValue: { set: { "X-Subscription-Name": "${subscription.name}" } },
    global: true,
  },
  {
    key: "headers.response",
    title: "Response headers",
    group: "shape",
    description: "The same four actions, applied to the response on its way out.",
    defaultValue: { set: { "X-Served-By": "integration-portal" } },
    global: true,
  },
  {
    key: "transform",
    title: "Transform",
    group: "shape",
    description:
      "Convert a SOAP response body to JSON. The request direction is 'none' only: generating XML " +
      "from an XSD is a writer, not a reader (deviation D21).",
    defaultValue: { request: "none", response: "soap-to-json" },
    appliesToKinds: ["soap"],
    global: false,
  },
  {
    key: "cache",
    title: "Response cache",
    group: "traffic",
    description:
      "Per instance, in memory, bounded, keyed under the active config digest so activating a new " +
      "config empties it. GET and HEAD only.",
    defaultValue: { ttlSec: 60, varyBySubscription: true, downstream: "private" },
    global: false,
  },
  {
    key: "rateLimit",
    title: "Rate limit",
    group: "traffic",
    description:
      "Fixed window, per instance, per subscription. The fleet ceiling is calls x instances " +
      "(design section 5.7).",
    defaultValue: {
      calls: 5,
      periodSec: 60,
      per: "instance",
      by: "subscription",
      scope: "route",
      emitHeaders: true,
    },
    global: true,
  },
  {
    key: "quota",
    title: "Quota",
    group: "traffic",
    description:
      "Fleet-wide, aggregated on the config poll. Enforcement is the last fleet aggregate plus " +
      "this instance's delta since, so the worst-case overshoot is one poll interval of traffic.",
    defaultValue: {
      calls: 100_000,
      periodSec: 2_592_000,
      per: "fleet",
      by: "subscription",
      scope: "product",
      emitHeaders: true,
    },
    global: true,
  },
  {
    key: "timeoutMs",
    title: "Timeout",
    group: "backend",
    description:
      "Milliseconds for the whole upstream exchange, retries included — so attempts do not " +
      "multiply what a caller waits.",
    defaultValue: DEFAULT_TIMEOUT_MS,
    global: true,
  },
  {
    key: "retries",
    title: "Retries",
    group: "backend",
    description:
      "Additional attempts, each on the NEXT backend in the pool. A request whose body was already " +
      "streamed cannot be retried, so this applies with no body or with a buffered one.",
    defaultValue: { attempts: 1, on: ["502", "503", "504", "timeout", "connect"], idempotentOnly: true },
    global: true,
  },
  {
    key: "circuitBreaker",
    title: "Circuit breaker",
    group: "backend",
    description:
      "Per instance, per backend. A backend that fails repeatedly is taken out and probed back in " +
      "after openSec, so one instance's connectivity fault cannot trip the fleet.",
    defaultValue: { failures: 5, windowSec: 60, openSec: 30, halfOpenProbes: 1 },
    global: true,
  },
  {
    key: "concurrency",
    title: "Concurrency limit",
    group: "backend",
    description:
      "The most requests this route may have in flight to its backends on one instance. Past it, " +
      "requests are shed with 503 and Retry-After instead of queueing. This is what stops one " +
      "slow backend from consuming the whole gateway.",
    defaultValue: { maxInFlight: 64, per: "instance", retryAfterSec: 1 },
    global: true,
  },
  {
    key: "backendAuth",
    title: "Backend credential",
    group: "backend",
    description:
      "A named scheme, selected by name; the gateway implements it. Every reference resolves " +
      "through INTEGRATIONS_FILE, so no owner writes a URL the gateway will call.",
    defaultValue: { type: "none" },
    global: false,
  },
  {
    key: "passthrough",
    title: "Streaming",
    group: "protocol",
    description:
      "WebSocket and SSE. The upgrade runs the whole request-side pipeline; after it, bytes are " +
      "copied and bounded in bytes and seconds, never per message.",
    defaultValue: {
      sse: true,
      streamIdleTimeoutSec: 300,
      maxConnectionSec: 3600,
      maxConcurrentConnections: 50,
    },
    global: false,
  },
  {
    key: "errorFormat",
    title: "Error format",
    group: "protocol",
    description:
      "How a gateway rejection is rendered. The default is derived from the variant; attach this " +
      "unit only to override it.",
    defaultValue: { shape: "problem+json" },
    global: false,
  },
];

import { createHash, timingSafeEqual } from "node:crypto";
import { audiencesOf, decodeJwt, JwksCache, timeWindowOk, verifyJwtSignature } from "../../shared/jwt.ts";
import type { ConfigIssuer, ConfigReferences } from "../../shared/config-doc.ts";
import type {
  BasicAuthUnit,
  IntrospectionAuthUnit,
  JwtAuthUnit,
  MtlsAuthUnit,
} from "../../shared/policy.ts";

/**
 * The authentication methods of design section 5 other than the subscription key.
 *
 * Design section 2 budgets `jwx` for this in Go, "because hand-rolling that trades an audited
 * implementation for an unaudited one". There is no equivalent inside the dependency budget for
 * this runtime, so what is hand-rolled is kept to the smallest surface that can be reasoned about,
 * and every property that library would give is written down and tested:
 *
 *  - **The algorithm comes from the admin-registered issuer, never from the token.** `alg: "none"`
 *    and the HMAC-with-a-public-key confusion both die here, because the header's `alg` is checked
 *    *against the allowlist* and the key is selected by `kid` from the issuer's JWKS.
 *  - **`iss`, `aud`, `exp`, `nbf` are all checked**, with a bounded clock skew.
 *  - **JWKS is cached per instance with rotation**: an unknown `kid` triggers at most one refetch
 *    per cooldown, so a rotated key is picked up without a restart and an unknown one cannot be
 *    used to hammer the identity provider.
 *  - **Verification failures are indistinguishable from the outside**: one status, one message.
 *
 * The first and third of those, plus the signature itself, live in `shared/jwt.ts` since v5: the
 * control plane verifies an OIDC `id_token` and asks the identical question of it. What stays here
 * is this unit's *claim policy* — which audience, which scopes, which issuer — because that is the
 * part that differs.
 */

export interface Identity {
  /** Which unit authenticated this request. */
  method: "jwt" | "basic" | "introspection" | "mtls";
  subject: string;
  scopes: string[];
  claims: Record<string, unknown>;
  /** mTLS only. */
  certificate?: ClientCertificate;
}

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: number; detail: string; headers?: Record<string, string> };

// --------------------------------------------------------------------------- JWKS

// Re-exported so `server.ts` and the tests keep importing it from here: which module owns the
// cache is not something the data plane's callers should have to know.
export { JwksCache };

function scopesOf(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scp ?? claims.scopes;
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

const GENERIC = "the token was not accepted";

/**
 * Verifies a JWT against an admin-registered issuer. Every rejection returns the same message: a
 * caller learning *why* a token failed learns the shape of the check.
 */
export async function verifyJwt(
  token: string,
  unit: JwtAuthUnit,
  issuer: ConfigIssuer,
  jwks: JwksCache,
  nowMs = Date.now(),
): Promise<AuthResult> {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, status: 401, detail: GENERIC };
  const { claims } = decoded;

  // The algorithm is checked against the *issuer's* allowlist inside `verifyJwtSignature`, so
  // `alg: "none"` and an HMAC signed with a public key are both rejected before any key is looked
  // up. The key is selected by `kid` from this issuer's JWKS and no other.
  const signed = await verifyJwtSignature(
    decoded,
    { jwksUrl: issuer.jwksUrl, allowedAlgorithms: issuer.algorithms },
    jwks,
  );
  if (!signed) return { ok: false, status: 401, detail: GENERIC };

  const skew = (unit.clockSkewSec ?? 60) * 1000;
  if (!timeWindowOk(claims, nowMs, skew)) return { ok: false, status: 401, detail: GENERIC };
  if (claims.iss !== issuer.issuer) return { ok: false, status: 401, detail: GENERIC };

  const audience = unit.audience ?? issuer.audienceDefault ?? [];
  if (audience.length > 0) {
    const presented = audiencesOf(claims);
    if (!presented.some((a) => audience.includes(a))) {
      return { ok: false, status: 401, detail: GENERIC };
    }
  }

  const scopes = scopesOf(claims);
  for (const required of unit.requiredScopes ?? []) {
    if (!scopes.includes(required)) {
      return { ok: false, status: 403, detail: `the token is missing the scope "${required}"` };
    }
  }

  return {
    ok: true,
    identity: {
      method: "jwt",
      subject: typeof claims.sub === "string" ? claims.sub : "",
      scopes,
      claims,
    },
  };
}

/** Per-operation scopes, checked at step 11 where the operation is known (plan `[R3-14]`). */
export function scopeMapMisses(
  unit: JwtAuthUnit,
  identity: Identity,
  operationId: string | null,
  method: string,
  template: string | null,
): string[] {
  const map = unit.scopeMap;
  if (!map) return [];
  const candidates = [
    operationId,
    template ? `${method.toUpperCase()} ${template}` : null,
  ].filter((k): k is string => k !== null);
  for (const key of candidates) {
    const required = map[key];
    if (!required) continue;
    return required.filter((scope) => !identity.scopes.includes(scope));
  }
  return [];
}

// --------------------------------------------------------------------------- basic

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The estate's shared-secret gate is a `!=` on the whole `Authorization` header: timing-variable
 * and scheme-sensitive. This compares the sha256 of what was presented against the sha256 the
 * config carries, in constant time — a hash is enough for a check, so a hash is what travels.
 */
export function verifyBasic(
  header: string | null,
  unit: BasicAuthUnit,
  references: ConfigReferences,
): AuthResult {
  const challenge = { "www-authenticate": `Basic realm="${(unit.realm ?? "api").replace(/"/g, "")}"` };
  if (!header || !header.toLowerCase().startsWith("basic ")) {
    return { ok: false, status: 401, detail: "basic authentication is required", headers: challenge };
  }
  const expected = references.secretHashes[unit.credentialRef];
  if (!expected) {
    return {
      ok: false,
      status: 503,
      detail: `the credential "${unit.credentialRef}" is not configured on this gateway`,
    };
  }
  const presented = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(presented, "base64").toString("utf8");
  } catch {
    return { ok: false, status: 401, detail: "invalid credentials", headers: challenge };
  }
  const hash = createHash("sha256").update(decoded, "utf8").digest("hex");
  if (!constantTimeEquals(hash, expected)) {
    return { ok: false, status: 401, detail: "invalid credentials", headers: challenge };
  }
  const user = decoded.slice(0, decoded.indexOf(":") === -1 ? decoded.length : decoded.indexOf(":"));
  return { ok: true, identity: { method: "basic", subject: user, scopes: [], claims: {} } };
}

/** The same constant-time comparison, for `preconditions.requireHeader.credentialRef`. */
export function secretMatches(value: string, ref: string, references: ConfigReferences): boolean {
  const expected = references.secretHashes[ref];
  if (!expected) return false;
  return constantTimeEquals(createHash("sha256").update(value, "utf8").digest("hex"), expected);
}

// --------------------------------------------------------------------------- introspection

interface IntrospectionEntry {
  active: boolean;
  claims: Record<string, unknown>;
  expiresAtMs: number;
}

/**
 * RFC 7662. The cache is per instance and its TTL bounds revocation lag, which is stated in the UI
 * beside the field rather than left to be discovered. A lookup failure **denies**: an identity
 * provider being unreachable is not a reason to admit a token nobody verified.
 */
export class IntrospectionCache {
  private readonly entries = new Map<string, IntrospectionEntry>();
  private readonly inFlight = new Map<string, Promise<IntrospectionEntry>>();

  constructor(
    private readonly options: { fetchImpl?: typeof fetch; maxEntries?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  async check(
    token: string,
    unit: IntrospectionAuthUnit,
    issuer: ConfigIssuer,
  ): Promise<AuthResult> {
    if (!issuer.introspectionUrl) {
      return { ok: false, status: 503, detail: "this issuer has no introspection endpoint configured" };
    }
    const key = `${issuer.introspectionUrl}|${createHash("sha256").update(token).digest("hex")}`;
    const cached = this.entries.get(key);
    let entry = cached && cached.expiresAtMs > this.now ? cached : undefined;
    // Re-insertion makes the Map's own insertion order an LRU order, so the eviction below drops
    // the entry nobody has asked for rather than one that is in use.
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    if (!entry) {
      // Single-flight, for the same reason the token cache in design section 5.5 is: a popular API
      // on a cold cache would otherwise burst its identity provider on every expiry.
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = this.introspect(token, unit, issuer);
        this.inFlight.set(key, pending);
      }
      try {
        entry = await pending;
      } catch {
        return { ok: false, status: 401, detail: "the token could not be introspected" };
      } finally {
        this.inFlight.delete(key);
      }
      // The oldest entry, not the whole cache. Clearing it emptied ten thousand live tokens at
      // once, so every one of them re-introspected on its next request — a periodic burst at the
      // identity provider, which is the failure the single-flight above exists to prevent.
      while (this.entries.size >= (this.options.maxEntries ?? 10_000)) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
      this.entries.set(key, entry);
    }

    if (!entry.active) return { ok: false, status: 401, detail: "the token is not active" };
    // The token's own `exp` and `nbf`, which `active: true` does not imply: an introspection answer
    // is a statement about the instant it was made, and this entry outlives that instant by up to
    // `cacheTtlSec`. Without this the cache's lifetime silently replaces the token's — the check
    // `auth.jwt` makes through the same function (`verifyJwt`).
    if (!timeWindowOk(entry.claims, this.now, 0)) {
      return { ok: false, status: 401, detail: "the token is not active" };
    }
    const scopes = scopesOf(entry.claims);
    for (const required of unit.requiredScopes ?? []) {
      if (!scopes.includes(required)) {
        return { ok: false, status: 403, detail: `the token is missing the scope "${required}"` };
      }
    }
    return {
      ok: true,
      identity: {
        method: "introspection",
        subject: typeof entry.claims.sub === "string" ? entry.claims.sub : "",
        scopes,
        claims: entry.claims,
      },
    };
  }

  private async introspect(
    token: string,
    unit: IntrospectionAuthUnit,
    issuer: ConfigIssuer,
  ): Promise<IntrospectionEntry> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (issuer.introspectionCredential) {
      headers.authorization = `Basic ${Buffer.from(issuer.introspectionCredential, "utf8").toString("base64")}`;
    }
    const response = await doFetch(issuer.introspectionUrl!, {
      method: "POST",
      headers,
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`introspection returned HTTP ${response.status}`);
    const claims = (await response.json()) as Record<string, unknown>;
    const ttl = (unit.cacheTtlSec ?? 60) * 1000;
    // Never past the token's own expiry: caching a token for longer than it lives would hold a
    // dead answer, and `cacheTtlSec` is a bound on revocation lag rather than a grant of lifetime.
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : null;
    const until = this.now + ttl;
    return {
      active: claims.active === true,
      claims,
      expiresAtMs: exp === null ? until : Math.min(until, exp),
    };
  }
}

// --------------------------------------------------------------------------- client certificates

export interface ClientCertificate {
  /** The full subject DN as the proxy reported it. */
  subject: string;
  issuer: string;
  cn: string;
  sans: string[];
  thumbprint: string;
  /** The proxy's own verdict. A certificate it did not verify is not an identity. */
  verified: boolean;
}

/**
 * Design section 8.1: TLS terminates at the reverse proxy, which verifies the client certificate
 * and passes the result in headers. That makes the proxy↔gateway hop a trust boundary — a DN
 * header accepted from an untrusted peer is an authorization bypass, which is why the gateway
 * refuses to activate a config using this policy without `TRUSTED_PROXY_CIDRS` set.
 */
export function readClientCertificate(
  headers: Headers,
  names: { dn: string; issuer: string; verify: string; fingerprint: string; san: string },
): ClientCertificate | null {
  const subject = headers.get(names.dn);
  if (!subject) return null;
  const verifyHeader = (headers.get(names.verify) ?? "").toUpperCase();
  return {
    subject,
    issuer: headers.get(names.issuer) ?? "",
    cn: cnOf(subject),
    sans: (headers.get(names.san) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    thumbprint: headers.get(names.fingerprint) ?? "",
    // nginx sends `SUCCESS`; F5 profiles vary. Anything that is not an explicit success is not one.
    verified: verifyHeader === "SUCCESS" || verifyHeader === "OK" || verifyHeader === "TRUE",
  };
}

/** `CN=SAFMEC9, O=…` → `SAFMEC9`, tolerating the escaping RFC 4514 allows. */
export function cnOf(dn: string): string {
  const match = /(?:^|,)\s*CN=((?:\\.|[^,])*)/i.exec(dn);
  if (!match) return "";
  return match[1]!.replace(/\\(.)/g, "$1").trim();
}

export function verifyMtls(certificate: ClientCertificate | null, unit: MtlsAuthUnit): AuthResult {
  if (!certificate) {
    return { ok: false, status: 401, detail: "a verified client certificate is required" };
  }
  // The design's rule: the data plane requires a successful verify result before it reads any
  // field. A certificate the proxy did not verify is rejected regardless of its CN.
  if (!certificate.verified) {
    return { ok: false, status: 401, detail: "the client certificate was not verified by the proxy" };
  }
  if (unit.allowedIssuers && unit.allowedIssuers.length > 0) {
    if (!unit.allowedIssuers.some((issuer) => issuer === certificate.issuer)) {
      return { ok: false, status: 403, detail: "the client certificate's issuer is not allowed here" };
    }
  }
  if (unit.allowedSubjectCns && unit.allowedSubjectCns.length > 0) {
    if (!unit.allowedSubjectCns.includes(certificate.cn)) {
      return { ok: false, status: 403, detail: "the client certificate's subject is not allowed here" };
    }
  }
  if (unit.allowedSans && unit.allowedSans.length > 0) {
    if (!certificate.sans.some((san) => unit.allowedSans!.includes(san))) {
      return { ok: false, status: 403, detail: "the client certificate's SANs are not allowed here" };
    }
  }
  return {
    ok: true,
    identity: {
      method: "mtls",
      subject: certificate.subject,
      scopes: [],
      claims: {},
      certificate,
    },
  };
}

export function bearerToken(headers: Headers, headerName: string, scheme: string): string | null {
  const raw = headers.get(headerName);
  if (!raw) return null;
  if (!scheme) return raw.trim();
  const prefix = `${scheme.toLowerCase()} `;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  return raw.slice(prefix.length).trim() || null;
}

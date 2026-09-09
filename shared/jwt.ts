import { createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * The JWT primitives both planes need, in one place.
 *
 * The data plane verifies caller tokens for the `auth.jwt` policy unit; the control plane verifies
 * the `id_token` an OIDC provider returns from a code exchange (v5 plan §5.4, D34). Those are
 * different questions about different tokens, but the part that must not be got wrong — select the
 * key by `kid`, take the algorithm from the *configuration* rather than from the token, verify the
 * signature — is identical, and a second copy of it is a second place to get it wrong.
 *
 * What each caller keeps for itself is the claim policy: which audience, which issuer, which
 * scopes, whether a `nonce` matters. That is deliberately not here, because those answers differ.
 *
 * Two properties this file is responsible for:
 *
 *  - **`alg` is checked against an allowlist the caller supplies**, so `alg: "none"` and the
 *    HMAC-signed-with-a-public-key confusion both die before a key is looked up.
 *  - **JWKS is cached with rotation**: an unknown `kid` triggers at most one refetch per cooldown,
 *    so a rotated key is picked up without a restart and an unknown one cannot be used to hammer
 *    the identity provider.
 */

export interface JwkKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

/**
 * The signature algorithms either plane will accept, and how node's `verify` is told about each.
 * A token whose `alg` is not a key here is refused even if a caller allowlisted it, so an
 * allowlist typo cannot widen the set.
 */
export const ALG_TO_HASH: Record<
  string,
  { hash: string; padding?: number; dsaEncoding?: "ieee-p1363" }
> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", padding: 1 },
  PS384: { hash: "sha384", padding: 1 },
  PS512: { hash: "sha512", padding: 1 },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363" },
};

export class JwksCache {
  private readonly keys = new Map<string, Map<string, JwkKey>>();
  private readonly fetchedAtMs = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      /** Never refetch more often than this, whatever an unknown `kid` asks for. */
      minRefetchMs?: number;
      fetchImpl?: typeof fetch;
      log?: (message: string) => void;
    } = {},
  ) {}

  private get minRefetchMs(): number {
    return this.options.minRefetchMs ?? 60_000;
  }

  /**
   * The cooldown is the fleet's decision and changes when a configuration document is activated
   * (`shared/gateway-settings.ts`). The cached key sets and the fetch timestamps survive: they are
   * facts about the identity provider, not about how often we are willing to ask it.
   */
  setMinRefetchMs(minRefetchMs: number): void {
    this.options.minRefetchMs = minRefetchMs;
  }

  async keyFor(jwksUrl: string, kid: string | undefined): Promise<JwkKey | null> {
    const known = this.keys.get(jwksUrl);
    if (known) {
      const key = kid ? known.get(kid) : [...known.values()][0];
      if (key) return key;
    }
    const last = this.fetchedAtMs.get(jwksUrl) ?? 0;
    if (Date.now() - last < this.minRefetchMs) return null;
    await this.refresh(jwksUrl);
    const refreshed = this.keys.get(jwksUrl);
    if (!refreshed) return null;
    return (kid ? refreshed.get(kid) : [...refreshed.values()][0]) ?? null;
  }

  /** Single-flight: N concurrent requests on an unknown `kid` fetch once, not N times. */
  private async refresh(jwksUrl: string): Promise<void> {
    const existing = this.inFlight.get(jwksUrl);
    if (existing) return existing;
    const doFetch = this.options.fetchImpl ?? fetch;
    const promise = (async () => {
      try {
        const response = await doFetch(jwksUrl, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { keys?: JwkKey[] };
        const map = new Map<string, JwkKey>();
        for (const key of body.keys ?? []) {
          if (key.use && key.use !== "sig") continue;
          map.set(typeof key.kid === "string" ? key.kid : "", key);
        }
        this.keys.set(jwksUrl, map);
      } catch (err) {
        this.options.log?.(`JWKS ${jwksUrl} could not be fetched: ${(err as Error).message}`);
      } finally {
        this.fetchedAtMs.set(jwksUrl, Date.now());
        this.inFlight.delete(jwksUrl);
      }
    })();
    this.inFlight.set(jwksUrl, promise);
    return promise;
  }
}

export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** `header.payload`, which is what the signature is over. */
  signingInput: string;
  signature: Buffer;
}

/** Structure only — no signature check, no claim check. `null` for anything malformed. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(base64UrlDecode(headerPart).toString("utf8")) as Record<string, unknown>,
      claims: JSON.parse(base64UrlDecode(payloadPart).toString("utf8")) as Record<string, unknown>,
      signingInput: `${headerPart}.${payloadPart}`,
      signature: base64UrlDecode(signaturePart),
    };
  } catch {
    return null;
  }
}

/**
 * Verifies a decoded token's signature against a JWKS. The algorithm comes from `allowedAlgorithms`
 * — the token's own `alg` is only ever used to *look up* an entry in it, never to choose behaviour.
 *
 * Measured at 0.019 ms per call including the JWK import, of which the import is 0.002 ms (v5
 * review `[P1-02]`), so there is no imported-key cache and no reason for one.
 */
export async function verifyJwtSignature(
  decoded: DecodedJwt,
  // `jwksUrl` is optional because an issuer registered without one is a real configuration state
  // (`ConfigIssuer.jwksUrl` is optional), and the answer to "verify against no key set" is no.
  options: { jwksUrl: string | undefined; allowedAlgorithms: readonly string[] },
  jwks: JwksCache,
): Promise<boolean> {
  const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : "";
  const spec = ALG_TO_HASH[alg];
  if (!spec || !options.allowedAlgorithms.includes(alg)) return false;
  if (!options.jwksUrl) return false;

  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
  const jwk = await jwks.keyFor(options.jwksUrl, kid);
  if (!jwk) return false;

  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    return verifySignature(
      spec.hash,
      Buffer.from(decoded.signingInput, "utf8"),
      {
        key,
        ...(spec.padding ? { padding: spec.padding, saltLength: 32 } : {}),
        ...(spec.dsaEncoding ? { dsaEncoding: spec.dsaEncoding } : {}),
      } as never,
      decoded.signature,
    );
  } catch {
    return false;
  }
}

/**
 * `exp` and `nbf`, with a bounded skew. Absent is not a failure here: a caller that requires them
 * says so, because "must have an expiry" is a claim policy rather than a signature property.
 */
export function timeWindowOk(
  claims: Record<string, unknown>,
  nowMs: number,
  skewMs: number,
): boolean {
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : null;
  const nbf = typeof claims.nbf === "number" ? claims.nbf * 1000 : null;
  if (exp !== null && nowMs > exp + skewMs) return false;
  if (nbf !== null && nowMs + skewMs < nbf) return false;
  return true;
}

/** `aud` as a list, whichever of the two shapes the token used. */
export function audiencesOf(claims: Record<string, unknown>): string[] {
  if (Array.isArray(claims.aud)) return claims.aud.filter((a): a is string => typeof a === "string");
  return typeof claims.aud === "string" ? [claims.aud] : [];
}

/**
 * A dotted path into a claim set, because the two claims that matter most are nested: Keycloak's
 * realm roles live at `realm_access.roles`, not at the top level (v5 plan §5.5).
 */
export function claimAt(claims: Record<string, unknown>, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A claim that should be a list of strings, tolerating the single-string shape some IdPs use. */
export function stringListAt(claims: Record<string, unknown>, path: string): string[] {
  return listOfStrings(claimAt(claims, path));
}

function listOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The **scopes of ownership** a role claim carries — what an application's source group is matched against.
 *
 * Three shapes, because directories disagree and all three are in the wild:
 *
 *   ["/apim/orders", "/apim/platform"]        Keycloak's group mapper: paths
 *   "orders platform"                          one space-separated string
 *   { "api.developers": ["ORDERS", "EAI"] }    a role → subjects map
 *
 * The third is the one that needs explaining. A realm that scopes roles per application says "this
 * person holds `api.developers` **for** ORDERS and EAI", and it is ORDERS and EAI — the *values* —
 * that name the thing being owned. So the values are what an application is matched on, and holding any
 * role for an application is membership of the application that application maps to.
 *
 * That last part is a real flattening: this product's applications have members and administrators and
 * nothing in between, so a realm distinguishing `api.readers` from `api.developers` for the same
 * application collapses to one membership here.
 */
export function ownedSubjectsAt(claims: Record<string, unknown>, path: string): string[] {
  const value = claimAt(claims, path);
  if (!isMap(value)) return listOfStrings(value);
  const out = new Set<string>();
  for (const entry of Object.values(value)) for (const name of listOfStrings(entry)) out.add(name);
  return [...out];
}

/**
 * The **role names** a role claim carries. Same three shapes; the map is read the other way round,
 * because there its *keys* are the roles.
 *
 * Each key is offered twice — bare, and qualified by every subject it applies to, so
 * `{ "admin": ["PODP"] }` yields both `admin` and `PODP.admin`. A realm that scopes roles per
 * application may name the portal's administrator role either way and there is no way to tell
 * which from inside the token. Offering both costs one comparison and removes a configuration
 * failure whose only symptom is that nobody is an administrator.
 */
export function roleNamesAt(claims: Record<string, unknown>, path: string): string[] {
  const value = claimAt(claims, path);
  if (!isMap(value)) return listOfStrings(value);
  const out = new Set<string>();
  for (const [role, entry] of Object.entries(value)) {
    out.add(role);
    for (const subject of listOfStrings(entry)) out.add(`${subject}.${role}`);
  }
  return [...out];
}

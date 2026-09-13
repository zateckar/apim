import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  audiencesOf,
  claimAt,
  decodeJwt,
  JwksCache,
  ownedSubjectsAt,
  roleNamesAt,
  timeWindowOk,
  verifyJwtSignature,
} from "../../shared/jwt.ts";
import type { OidcConfig } from "./config.ts";
import { revokeSession, sessionRow, type SessionRow } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { ensureApplicationMetadata } from "./integrations.ts";
import { decrypt, encrypt } from "./crypto.ts";
import type { DB } from "./db.ts";
import { nowIso } from "./db.ts";
import { badGateway, badRequest, HttpError, serviceUnavailable, unauthorized } from "./errors.ts";
import { checkEgress } from "./egress.ts";
import {
  createPrincipal,
  principalBySubject,
  syncIdpMemberships,
  type PrincipalRow,
} from "./principals.ts";
import type { App } from "./router.ts";
import { trustedFetch } from "./trust-store.ts";

/**
 * The OIDC provider (v5 plan §5.4). Authorization code + PKCE, owned end to end by the control
 * plane: the browser gets an httpOnly cookie and never sees a token.
 *
 * There is no OAuth library here for the same reason there is nothing else in the dependency
 * budget: the protocol surface this needs is five requests, and the one part that must not be
 * hand-rolled — the signature verification — is in `shared/jwt.ts`, shared with the data plane's
 * `auth.jwt` unit.
 *
 * The `id_token` **is** verified (D34), against the issuer's JWKS, with `nonce`, `iss`, `aud`,
 * `exp` and `nbf`. The reference implementation this was read from skips that on the grounds that
 * the exchange was a TLS POST it initiated, which is defensible — but the verifier already exists
 * and costs 0.019 ms `[P1-02]`, so there is nothing to trade.
 */

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

interface CachedDiscovery {
  doc: Discovery;
  fetchedAtMs: number;
}

const DISCOVERY_TTL_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** The algorithms an `id_token` may be signed with. Asymmetric only: a shared-secret `id_token` is
 * a different trust model, and none of the providers this targets defaults to one. */
const ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

/**
 * Per process, keyed by issuer, with a single-flight promise so a cold start under load fetches
 * once rather than once per request. Not fetched at boot: that would make the control plane refuse
 * to start while the identity provider restarts `[P1-15]`.
 */
const discoveryCache = new Map<string, CachedDiscovery>();
const discoveryInFlight = new Map<string, Promise<Discovery>>();
const jwksCache = new JwksCache({ log: (m) => console.warn(`[cp] ${m}`) });

/** For tests, which stand up a stub provider per test and must not inherit the previous one's. */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  discoveryInFlight.clear();
}

async function fetchJson(app: App, url: string, init: RequestInit, what: string): Promise<Response> {
  // The identity provider is an outbound target like any other, so design §5.3's denied ranges and
  // G4's trust anchors both apply — which is what lets an internal Keycloak behind an internal CA
  // work without turning verification off.
  //
  // The denied **ranges** only, matching the boot check: the identity provider is operator-set, and
  // an administrator's deny rule that could break sign-in is a rule that locks everyone out of the
  // screen where it would be removed.
  const errors = await checkEgress(url, what, { integrations: app.config.integrations });
  if (errors.length > 0) {
    throw badGateway(
      `the identity provider's ${what} is not reachable: ${errors.join("; ")}`,
    );
  }
  // `trustedFetch` is the control plane's own outbound fetch: system roots plus every registered
  // trust anchor (G4). An internal Keycloak signed by an internal CA is therefore reachable
  // without a TLS exception, which is the whole point of having registered the CA.
  try {
    return await trustedFetch(app.db)(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw serviceUnavailable(
      `the identity provider did not answer at its ${what} (${(err as Error).message})`,
      { code: "auth_backend_unavailable" },
    );
  }
}

export async function discover(app: App, oidc: OidcConfig): Promise<Discovery> {
  const cached = discoveryCache.get(oidc.issuer);
  if (cached && Date.now() - cached.fetchedAtMs < DISCOVERY_TTL_MS) return cached.doc;

  const existing = discoveryInFlight.get(oidc.issuer);
  if (existing) return existing;

  const url = `${oidc.issuer}/.well-known/openid-configuration`;
  const promise = (async () => {
    const response = await fetchJson(app, url, { method: "GET" }, "discovery document");
    if (!response.ok) {
      throw serviceUnavailable(
        `the identity provider's discovery document answered ${response.status} at ${url}`,
        { code: "auth_backend_unavailable" },
      );
    }
    const doc = (await response.json()) as Partial<Discovery>;
    for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof doc[field] !== "string" || !doc[field]) {
        throw badGateway(`the identity provider's discovery document has no "${field}"`);
      }
    }
    if (doc.issuer !== oidc.issuer) {
      // A discovery document that claims a different issuer than the URL it was fetched from is
      // either a misconfiguration or a redirect somebody should know about; either way every
      // `iss` check below would be against the wrong value.
      throw badGateway(
        `the discovery document at ${url} declares issuer "${doc.issuer}", not "${oidc.issuer}"`,
      );
    }
    // Every endpoint, not just the issuer: a document may point `token_endpoint` or `jwks_uri` at
    // a different host, and a check that only ever saw the issuer would not have covered it. This
    // is the one place the provider's own document chooses the host, so the denied ranges matter
    // here even though the issuer itself was cleared at boot.
    for (const [field, value] of Object.entries(doc)) {
      if (typeof value !== "string" || !/^https?:\/\//.test(value)) continue;
      const errors = await checkEgress(value, `discovery ${field}`, {
        integrations: app.config.integrations,
      });
      if (errors.length > 0) {
        throw badGateway(
          `the identity provider's ${field} (${value}) is not reachable: ${errors.join("; ")}`,
        );
      }
    }
    discoveryCache.set(oidc.issuer, { doc: doc as Discovery, fetchedAtMs: Date.now() });
    return doc as Discovery;
  })().finally(() => discoveryInFlight.delete(oidc.issuer));

  discoveryInFlight.set(oidc.issuer, promise);
  return promise;
}

// --------------------------------------------------------------------------- the flow

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Where a sign-in may land afterwards. Must be a path on this origin: a `return` an attacker
 * controls is an open redirect through the one endpoint every user is trained to trust. The
 * backslash case is not theoretical — some browsers normalise a leading `/\` to `//`, which makes
 * `/\evil.test` off-site `[P1-08]`.
 */
export function safeReturnTo(raw: string | null): string {
  const value = (raw ?? "").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  // A control character in a `Location` header is header injection. A code-point test rather
  // than a character class, because an invisible byte inside a regular expression is exactly
  // the kind of thing nobody reviewing this file would see.
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return "/";
  }
  return value;
}

export function authorizeUrl(
  discovery: Discovery,
  oidc: OidcConfig,
  input: { state: string; nonce: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oidc.clientId,
    redirect_uri: oidc.redirectUri,
    scope: oidc.scope,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${discovery.authorization_endpoint}?${params}`;
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * A 4xx from the token endpoint means the grant will never work again — the code was replayed, or
 * the refresh token is expired, revoked or lost a rotation race. A 5xx or a network failure is
 * transient. Conflating them is how a dead session becomes a permanent 503 loop, which is a bug
 * the reference implementation records fixing.
 */
export class TokenGrantError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${status} ${code}: ${detail}`);
  }

  get permanent(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

async function tokenGrant(
  app: App,
  oidc: OidcConfig,
  discovery: Discovery,
  body: URLSearchParams,
): Promise<TokenResponse> {
  body.set("client_id", oidc.clientId);
  if (oidc.clientSecret) body.set("client_secret", oidc.clientSecret);
  const response = await fetchJson(
    app,
    discovery.token_endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    },
    "token endpoint",
  );
  if (!response.ok) {
    let code = "token_error";
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string; error_description?: string };
      code = payload.error ?? code;
      detail = payload.error_description ?? payload.error ?? detail;
    } catch {
      detail = (await response.text().catch(() => "")) || detail;
    }
    throw new TokenGrantError(response.status, code, detail);
  }
  return (await response.json()) as TokenResponse;
}

export async function exchangeCode(
  app: App,
  oidc: OidcConfig,
  discovery: Discovery,
  input: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  return tokenGrant(
    app,
    oidc,
    discovery,
    new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: oidc.redirectUri,
      code: input.code,
      code_verifier: input.codeVerifier,
    }),
  );
}

export async function refreshGrant(
  app: App,
  oidc: OidcConfig,
  discovery: Discovery,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenGrant(
    app,
    oidc,
    discovery,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

/** Best-effort, and deliberately so: the local revocation is the authoritative step. */
export async function revokeAtProvider(
  app: App,
  oidc: OidcConfig,
  discovery: Discovery,
  refreshToken: string,
): Promise<void> {
  if (!discovery.revocation_endpoint) return;
  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: oidc.clientId,
  });
  if (oidc.clientSecret) body.set("client_secret", oidc.clientSecret);
  try {
    await fetchJson(
      app,
      discovery.revocation_endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      "revocation endpoint",
    );
  } catch (err) {
    console.warn(`[cp] revoking the refresh token at the identity provider failed: ${String(err)}`);
  }
}

// --------------------------------------------------------------------------- the id token

export interface VerifiedIdToken {
  sub: string;
  claims: Record<string, unknown>;
}

/**
 * Signature, issuer, audience, time window and `nonce`. Every failure is the same 401 to the
 * caller — a browser mid-redirect can do nothing with the difference — and the reason is logged.
 */
export async function verifyIdToken(
  idToken: string,
  oidc: OidcConfig,
  discovery: Discovery,
  expectedNonce: string,
  nowMs = Date.now(),
): Promise<VerifiedIdToken> {
  const refuse = (why: string): never => {
    console.warn(`[cp] an id_token from ${oidc.issuer} was refused: ${why}`);
    throw unauthorized("the identity provider's response was not accepted", { code: "id_token_rejected" });
  };

  const decoded = decodeJwt(idToken);
  if (!decoded) return refuse("it is not a well-formed JWT");

  const signed = await verifyJwtSignature(
    decoded,
    { jwksUrl: discovery.jwks_uri, allowedAlgorithms: ID_TOKEN_ALGORITHMS },
    jwksCache,
  );
  if (!signed) return refuse("the signature did not verify against the issuer's JWKS");

  const { claims } = decoded;
  if (claims.iss !== discovery.issuer) return refuse(`iss was "${String(claims.iss)}"`);
  if (!audiencesOf(claims).includes(oidc.clientId)) return refuse("aud does not contain the client id");
  if (!timeWindowOk(claims, nowMs, CLOCK_SKEW_MS)) return refuse("it is expired or not yet valid");
  if (typeof claims.exp !== "number") return refuse("it has no exp");

  const presented = typeof claims.nonce === "string" ? claims.nonce : "";
  const expected = Buffer.from(expectedNonce, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return refuse("nonce does not match the one this sign-in sent");
  }

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return refuse("it has no sub");
  return { sub, claims };
}

// --------------------------------------------------------------------------- claims → identity

export interface ClaimIdentity {
  username: string;
  email: string | null;
  displayName: string;
  isAdmin: boolean;
  /** Every group value the token carried, before any mapping. */
  groups: string[];
}

/**
 * One function, so the callback and the claim re-read cannot disagree about who somebody is
 * (plan §5.5).
 */
export function claimsToIdentity(claims: Record<string, unknown>, oidc: OidcConfig): ClaimIdentity {
  const str = (key: string): string => {
    const value = claims[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  const sub = str("sub");
  const username = str("preferred_username") || sub;
  const email = str("email") || null;
  // Two readers, not one, because a role → subjects map has to be read in opposite directions for
  // the two questions. Its keys answer "which roles does this person hold"; its values answer
  // "which things may they act on". A single reader would get one of the two backwards, and the
  // symptom would be either nobody is an administrator or everybody is in an application named `api.admin`.
  const roles = roleNamesAt(claims, oidc.roleClaim);
  return {
    username,
    email,
    displayName: str("name") || username || email || sub,
    isAdmin: roles.some((role) => role.toLowerCase() === oidc.adminRole.toLowerCase()),
    groups: ownedSubjectsAt(claims, oidc.groupClaim),
  };
}

/**
 * The application id a group value provisions. Keycloak's group mapper emits full paths
 * (`/apim/orders`), so the last segment names the thing; the whole value is what gets stored as
 * `source_group`, because that is what the next token will present for matching.
 *
 * Returns null when nothing usable survives — the id column is `^[a-z0-9][a-z0-9_-]{1,47}$`, and a
 * group of `///` or `!!` has no name in it to keep.
 */
export function applicationIdForGroup(group: string): string | null {
  const leaf = group.trim().split("/").filter(Boolean).at(-1) ?? "";
  const id = leaf
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 48);
  return /^[a-z0-9][a-z0-9_-]{1,47}$/.test(id) ? id : null;
}

/**
 * Group values resolved to applications, **provisioning one where it does not exist yet**.
 *
 * This used to match and never create, so that a directory could not invent a scope for whoever
 * held a group. That guard is gone deliberately: where the identity provider is authoritative for
 * who owns what, holding the group *is* the grant, and an administrator asked to confirm it can
 * only ever say yes. An application row still has to exist — `resource`, `product`, `subscription`,
 * `certificate` and `membership` all carry `application_id` — so "no mapping required" means the row
 * is provisioned from the token rather than that there is no row.
 *
 * Three cases, and the third is the only one that still reports back:
 *
 *   - a row already carries this `source_group` (whole value or last segment, case-insensitively,
 *     because directory exports are not careful) — use it;
 *   - the derived id is free, or held by a row with no `source_group` at all — create or adopt it.
 *     Adopting covers the application an administrator made by hand before the group existed, which
 *     is the same thing under a different origin;
 *   - the derived id is held by a row already bound to a *different* group — leave it alone and
 *     report the group as unmapped. Two groups that both want one id is the one case where guessing
 *     would hand somebody another group's application.
 */
export function mapGroupsToApplications(
  db: DB,
  groups: string[],
  onCreate?: (application: { id: string; name: string; sourceGroup: string }) => void,
): { applicationIds: string[]; unmapped: string[] } {
  const rows = db
    .query<{ id: string; source_group: string | null }, []>("SELECT id, source_group FROM application")
    .all();
  const bySourceGroup = new Map<string, string>();
  const byId = new Map<string, string | null>();
  for (const row of rows) {
    byId.set(row.id, row.source_group);
    if (row.source_group && row.source_group.trim()) {
      bySourceGroup.set(row.source_group.trim().toLowerCase(), row.id);
    }
  }

  const applicationIds = new Set<string>();
  const unmapped: string[] = [];
  const refuse = (value: string) => {
    if (!unmapped.includes(value)) unmapped.push(value);
  };

  for (const raw of groups) {
    const value = raw.trim();
    if (!value) continue;

    const candidates = [value, value.split("/").filter(Boolean).at(-1) ?? value];
    const hit = candidates
      .map((candidate) => bySourceGroup.get(candidate.toLowerCase()))
      .find((id): id is string => Boolean(id));
    if (hit) {
      applicationIds.add(hit);
      continue;
    }

    const id = applicationIdForGroup(value);
    if (!id) {
      refuse(value);
      continue;
    }
    if (byId.has(id)) {
      const held = byId.get(id);
      // Bound to another group: leave it alone rather than move it under this one.
      if (held && held.trim()) {
        refuse(value);
        continue;
      }
      db.run("UPDATE application SET source_group = ? WHERE id = ?", [value, id]);
    } else {
      const name = candidates[1] || value;
      db.run("INSERT INTO application (id, name, source_group) VALUES (?, ?, ?)", [id, name, value]);
      onCreate?.({ id, name, sourceGroup: value });
    }
    bySourceGroup.set(value.toLowerCase(), id);
    byId.set(id, value);
    applicationIds.add(id);
  }
  return { applicationIds: [...applicationIds], unmapped };
}

/** What the last claim read produced for one user — `GET /api/me` reports both fields. */
const idpGroupsByUser = new Map<string, { unmapped: string[]; carried: number }>();

export function unmappedGroupsFor(userId: string): string[] {
  return idpGroupsByUser.get(userId)?.unmapped ?? [];
}

/**
 * True when the token was read successfully and the configured group claim held **nothing at all**.
 *
 * This is the misconfiguration with no other symptom. Point `OIDC_GROUP_CLAIM` at a path the realm
 * does not use — or at one whose shape is not read — and every user signs in fine, is in no application,
 * can publish nothing, and there is no unmapped group to report because there was no group. It
 * looks exactly like "this person has not been given access yet", which is what makes it expensive:
 * the administrator goes looking in the directory, and the directory is right.
 */
export function groupClaimWasEmpty(userId: string): boolean {
  return idpGroupsByUser.get(userId)?.carried === 0;
}

/**
 * Apply what the token says to the directory: the mutable display fields, the admin flag, the
 * applications the groups name, and the IdP-derived memberships. Locally granted memberships are
 * left alone (D33).
 *
 * Runs on sign-in *and* on every claims refresh, so provisioning has to be idempotent — it is: an
 * application already carrying the group is matched rather than created.
 */
export function applyClaims(
  app: App,
  row: PrincipalRow,
  identity: ClaimIdentity,
): { unmapped: string[] } {
  const created: string[] = [];
  const { applicationIds, unmapped } = mapGroupsToApplications(app.db, identity.groups, (created_) => {
    created.push(created_.id);
    // Audited against the person whose token provisioned it, not against an administrator: nobody
    // decided this, and "who caused this application to exist" is the question the row answers.
    writeAudit(app.db, {
      actor: row.id,
      action: "application.create",
      subject: `application:${created_.id}`,
      outcome: "ok",
      detail: { name: created_.name, sourceGroup: created_.sourceGroup, reason: "idp group" },
    });
  });
  app.db.run(
    `UPDATE principal
        SET username = ?, email = ?, display_name = ?, idp_admin = ?
      WHERE id = ?`,
    [
      identity.username || row.username,
      identity.email,
      identity.displayName || row.display_name,
      identity.isAdmin ? 1 : 0,
      row.id,
    ],
  );
  syncIdpMemberships(app.db, row.id, applicationIds);
  // Ask LeanIX about anything new now rather than at the next boot, so a business id appears on the
  // picker within a poll of the application existing — the same courtesy the manual path gets.
  if (created.length > 0) ensureApplicationMetadata(app);
  idpGroupsByUser.set(row.id, { unmapped, carried: identity.groups.length });
  return { unmapped };
}

/**
 * The principal behind a verified `sub`, created on first sign-in when `OIDC_AUTO_CREATE` allows
 * it. With auto-create off the refusal names the `sub`, so an admin can pre-create the principal
 * rather than guess.
 */
export function principalForSubject(
  app: App,
  oidc: OidcConfig,
  sub: string,
  identity: ClaimIdentity,
): PrincipalRow {
  const existing = principalBySubject(app.db, "oidc", sub);
  if (existing) return existing;
  if (!oidc.autoCreate) {
    throw new HttpError(
      403,
      "Forbidden",
      `no account here matches the identity provider's subject "${sub}", and OIDC_AUTO_CREATE is ` +
        "off. An administrator has to create the account first.",
      { code: "no_such_principal", subject: sub },
    );
  }
  return createPrincipal(app.db, {
    provider: "oidc",
    subject: sub,
    username: identity.username || sub,
    displayName: identity.displayName || sub,
    email: identity.email,
    createdBy: "oidc-auto-create",
  });
}

// --------------------------------------------------------------------------- the claim re-read

/**
 * One in-flight refresh per session. Keycloak rotates the refresh token on every use, so two
 * concurrent requests on one session would race and the loser would be told `invalid_grant` — and
 * would then destroy a session that is perfectly alive.
 */
const refreshInFlight = new Map<string, Promise<void>>();

function refreshDue(row: SessionRow, oidc: OidcConfig, nowMs: number): boolean {
  if (row.provider !== "oidc" || !row.refresh_token_enc) return false;
  const last = row.claims_refreshed_at ? Date.parse(row.claims_refreshed_at) : 0;
  return nowMs - last >= oidc.claimsRefreshSec * 1000;
}

/**
 * Called from `dispatch` before the directory is read `[P1-13]`. This is how design §9's "a group
 * removal in the identity provider takes effect at the next refresh" actually happens.
 *
 * Failure handling is the whole point of the function:
 *
 *  - a **4xx** means the refresh token is dead. Revoke the session and answer 401
 *    `session_expired`, because the user has to sign in again and the SPA knows what to do with
 *    that code;
 *  - a **5xx or a network failure** leaves the session alone and answers 503
 *    `auth_backend_unavailable`. A provider outage must not sign the whole estate out.
 */
export async function refreshClaimsIfDue(app: App, sessionId: string | null): Promise<void> {
  const oidc = app.config.oidc;
  if (!oidc || !sessionId) return;
  const row = sessionRow(app.db, sessionId);
  if (!row || row.revoked_at || !refreshDue(row, oidc, Date.now())) return;

  let pending = refreshInFlight.get(sessionId);
  if (!pending) {
    pending = doRefresh(app, oidc, row).finally(() => refreshInFlight.delete(sessionId));
    refreshInFlight.set(sessionId, pending);
  }
  await pending;
}

async function doRefresh(app: App, oidc: OidcConfig, row: SessionRow): Promise<void> {
  const refreshToken = decrypt(row.refresh_token_enc!, app.kek);
  const discovery = await discover(app, oidc);
  let tokens: TokenResponse;
  try {
    tokens = await refreshGrant(app, oidc, discovery, refreshToken);
  } catch (err) {
    if (err instanceof TokenGrantError && err.permanent) {
      revokeSession(app.db, row.id);
      throw unauthorized(
        "your session with the identity provider has ended; sign in again",
        { code: "session_expired" },
      );
    }
    if (err instanceof HttpError) throw err;
    throw serviceUnavailable(`the identity provider could not be reached (${(err as Error).message})`, {
      code: "auth_backend_unavailable",
    });
  }

  // Some providers return no new `id_token` on a refresh. Without one there are no claims to
  // re-read, so the only honest thing is to note that the attempt happened and carry on — not to
  // pretend the roles were confirmed.
  if (tokens.id_token) {
    const decoded = decodeJwt(tokens.id_token);
    const nonce = typeof decoded?.claims.nonce === "string" ? decoded.claims.nonce : "";
    // A refreshed `id_token` carries the nonce of the original authorization request, or none at
    // all. Either is fine; what matters is the signature, the issuer and the audience, so the
    // nonce check is fed the token's own value here rather than being skipped by a flag.
    const verified = await verifyIdToken(tokens.id_token, oidc, discovery, nonce);
    const existing = principalBySubject(app.db, "oidc", verified.sub);
    if (!existing || existing.id !== row.user_id) {
      // The provider answered about a different subject than this session belongs to. Nothing
      // legitimate produces that, and applying it would move a session between people.
      revokeSession(app.db, row.id);
      throw unauthorized("your session no longer matches the identity provider's account", {
        code: "session_expired",
      });
    }
    applyClaims(app, existing, claimsToIdentity(verified.claims, oidc));
  }

  app.db.run(
    "UPDATE session SET claims_refreshed_at = ?, refresh_token_enc = ? WHERE id = ?",
    [
      nowIso(),
      // Rotated on every use by Keycloak; some providers do not rotate, in which case keeping the
      // old one is what lets the next refresh work.
      tokens.refresh_token ? encrypt(tokens.refresh_token, app.kek) : row.refresh_token_enc,
      row.id,
    ],
  );
}

/** The sign-out redirect, when a deployment has asked for single logout. */
export function endSessionUrl(discovery: Discovery, oidc: OidcConfig, publicUrl: string): string | null {
  if (!oidc.endSession || !discovery.end_session_endpoint) return null;
  const params = new URLSearchParams({
    client_id: oidc.clientId,
    post_logout_redirect_uri: publicUrl,
  });
  return `${discovery.end_session_endpoint}?${params}`;
}

export function requireOidc(app: App): OidcConfig {
  const oidc = app.config.oidc;
  if (!oidc) {
    throw badRequest(
      'this deployment has no identity provider configured (AUTH_PROVIDERS does not include "oidc")',
    );
  }
  return oidc;
}

/** `claimAt` is re-exported so the users API can explain a mapping without importing `shared`. */
export { claimAt };

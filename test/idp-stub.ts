import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { OidcConfig } from "../control-plane/src/config.ts";

/**
 * An OpenID Connect provider, in process, with a real RSA key.
 *
 * A mock that returned "yes, verified" would test nothing this code is worried about — the whole
 * argument for D34 is that the `id_token` signature *is* checked, so the fixture has to be able to
 * produce a token that genuinely does not verify. Everything here is therefore real: real JWKS,
 * real RS256 signatures, real PKCE (the token endpoint refuses a verifier that does not hash to the
 * challenge the authorization request carried).
 *
 * It is one Bun server on 127.0.0.1, which the repository's egress allowlist permits — so the
 * control plane's own `checkEgress` runs against it rather than being bypassed.
 */

export interface IssuedCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
}

export interface StubIdpOptions {
  /** Extra members on the discovery document — a foreign host, a missing field, and so on. */
  discoveryExtras?: Record<string, unknown>;
  /** Overrides the document's own `issuer`, for the "declares a different issuer" refusal. */
  declaredIssuer?: string;
  /** Advertise `revocation_endpoint` and `end_session_endpoint`, whose URLs need the live port. */
  revocation?: boolean;
  endSession?: boolean;
}

export interface StubIdp {
  issuer: string;
  clientId: string;
  stop(): void;
  /** What the next `id_token` will claim. Mutated between requests to model a role or group change. */
  claims: Record<string, unknown>;
  /** Every form body the token endpoint received, in order. */
  tokenRequests: Array<Record<string, string>>;
  /** Set to make the token endpoint answer with this instead of a grant. */
  tokenFailure: { status: number; body: Record<string, unknown> } | null;
  /** Set to drop the `id_token` from the next token response, which some providers do on refresh. */
  omitIdToken: boolean;
  /** Set to sign the next `id_token` with a key the JWKS does not carry. */
  signWithWrongKey: boolean;
  /** Refresh tokens handed out, newest last — Keycloak rotates on every use and so does this. */
  refreshTokens: string[];
  revocations: string[];
  /** Turn an authorization redirect into a code, the way the user's browser would. */
  authorize(location: string): { code: string; state: string };
  /** A token this provider would consider valid, for tests that bypass the flow. */
  signIdToken(overrides?: Record<string, unknown>): string;
  /** The matching control-plane configuration. */
  oidcConfig(publicUrl: string, overrides?: Partial<OidcConfig>): OidcConfig;
}

const KID = "stub-key-1";

export function startStubIdp(options: StubIdpOptions = {}): StubIdp {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // A second key that is never published, so a token signed with it is well-formed, correctly
  // structured, and must still be refused.
  const decoy = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  const codes = new Map<string, IssuedCode>();
  const clientId = "integration-portal";

  const state: StubIdp = {
    issuer: "",
    clientId,
    claims: {
      sub: "keycloak-subject-1",
      preferred_username: "pavel",
      name: "Pavel Publisher",
      email: "pavel@example.test",
      realm_access: { roles: ["default-roles", "apim-admin"] },
      groups: ["/apim/platform"],
    },
    tokenRequests: [],
    tokenFailure: null,
    omitIdToken: false,
    signWithWrongKey: false,
    refreshTokens: [],
    revocations: [],
    stop: () => server.stop(true),
    authorize(location: string) {
      const url = new URL(location);
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      const stateValue = url.searchParams.get("state") ?? "";
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        throw new Error("the authorization request did not ask for S256 PKCE");
      }
      if (url.searchParams.get("client_id") !== clientId) {
        throw new Error(`the authorization request carried client_id ${url.searchParams.get("client_id")}`);
      }
      const code = `code_${codes.size}_${Math.random().toString(36).slice(2, 8)}`;
      codes.set(code, {
        challenge,
        nonce,
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: stateValue };
    },
    signIdToken(overrides: Record<string, unknown> = {}) {
      return signJwt({ ...baseClaims(), ...overrides });
    },
    oidcConfig(publicUrl: string, overrides: Partial<OidcConfig> = {}): OidcConfig {
      return {
        issuer: state.issuer,
        clientId,
        clientSecret: null,
        redirectUri: `${publicUrl}/auth/callback`,
        scope: "openid profile email offline_access",
        roleClaim: "realm_access.roles",
        adminRole: "apim-admin",
        groupClaim: "groups",
        claimsRefreshSec: 300,
        autoCreate: true,
        endSession: false,
        displayName: "Stub ID",
        ...overrides,
      };
    },
  };

  function baseClaims(): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: state.issuer,
      aud: clientId,
      iat: now,
      exp: now + 300,
      ...state.claims,
    };
  }

  function signJwt(claims: Record<string, unknown>): string {
    const header = { alg: "RS256", typ: "JWT", kid: KID };
    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signingInput = `${b64(header)}.${b64(claims)}`;
    const key = state.signWithWrongKey ? decoy.privateKey : privateKey;
    const signature = signBytes("sha256", Buffer.from(signingInput, "utf8"), key);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  function grant(nonce: string): Record<string, unknown> {
    const refresh = `refresh_${state.refreshTokens.length}_${Math.random().toString(36).slice(2, 8)}`;
    state.refreshTokens.push(refresh);
    return {
      token_type: "Bearer",
      access_token: "access-token-nobody-here-stores",
      expires_in: 300,
      refresh_token: refresh,
      // The authorization request's nonce first, `claims` last: by default the token echoes the
      // nonce it was asked for, and a test that sets `claims.nonce` explicitly overrides it.
      ...(state.omitIdToken
        ? {}
        : { id_token: signJwt({ ...(nonce ? { nonce } : {}), ...baseClaims() }) }),
    };
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: options.declaredIssuer ?? state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
          // Composed here rather than passed in, because the port is not known until the server
          // is listening and the caller has to be able to ask for these by name.
          ...(options.revocation ? { revocation_endpoint: `${state.issuer}/revoke` } : {}),
          ...(options.endSession ? { end_session_endpoint: `${state.issuer}/logout` } : {}),
          ...(options.discoveryExtras ?? {}),
        });
      }

      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });

      if (url.pathname === "/token") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        state.tokenRequests.push(form);
        if (state.tokenFailure) {
          return Response.json(state.tokenFailure.body, { status: state.tokenFailure.status });
        }
        if (form.grant_type === "authorization_code") {
          const issued = codes.get(form.code ?? "");
          // Single use, like the real thing: a replayed code is `invalid_grant`.
          if (!issued) return Response.json({ error: "invalid_grant" }, { status: 400 });
          codes.delete(form.code!);
          const presented = createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url");
          if (presented !== issued.challenge) {
            return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
          }
          return Response.json(grant(issued.nonce));
        }
        if (form.grant_type === "refresh_token") {
          if (!state.refreshTokens.includes(form.refresh_token ?? "")) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json(grant(""));
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      if (url.pathname === "/revoke") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        state.revocations.push(form.token ?? "");
        return new Response(null, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  state.issuer = `http://127.0.0.1:${server.port}`;
  return state;
}

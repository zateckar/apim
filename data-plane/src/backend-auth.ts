import { createHmac } from "node:crypto";
import type { ConfigReferences, ConfigTokenProvider } from "../../shared/config-doc.ts";
import type { BackendAuthUnit } from "../../shared/policy.ts";

/**
 * The named backend-auth schemes of design section 5.5.
 *
 * Backends that need a credential are the largest driver of expression-language policy in the
 * estate, and every instance is one of a handful of schemes. The gateway implements the schemes;
 * policy selects one by name, and every reference resolves through the admin-registered
 * `INTEGRATIONS_FILE` — so no owner writes a URL the gateway will call or a secret it will store.
 *
 * Three properties differ from the policies these replace, and each is a live defect in the estate:
 *
 *  - **Single-flight token fetch.** Concurrent requests on a cold or just-expired cache share one
 *    fetch. The hand-rolled version stampedes: every in-flight request runs its own `send-request`,
 *    so a popular API bursts its identity provider on every expiry.
 *  - **Fails closed.** A failed token fetch returns 503. The hand-rolled version uses
 *    `ignore-error="true"` and forwards with an empty `Authorization`, turning an IdP blip into a
 *    backend 401.
 *  - **The HMAC signature is computed per request and never cached**, because it covers a
 *    second-resolution timestamp. The current policy appears to cache it but does not — it writes
 *    into a variable named `Authorization` while the `choose` tests one named `SaKeyLite` — and the
 *    API works *because* of that bug.
 */

export interface BackendAuthContext {
  method: string;
  /** The operation template, for `hmac-sa-key-lite`'s canonical string. */
  operationTemplate: string;
  references: ConfigReferences;
  now?: Date;
}

export type BackendAuthResult =
  | { ok: true; headers: Record<string, string>; query?: Record<string, string> }
  | { ok: false; status: number; detail: string };

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export class TokenCache {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<CachedToken>>();
  /** Counts fetches, so "exactly one fetch for N concurrent requests" is assertable. */
  fetches = 0;

  constructor(
    private readonly options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  invalidate(key: string): void {
    this.tokens.delete(key);
  }

  async get(key: string, provider: ConfigTokenProvider, scope: string | undefined): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAtMs > this.now) return cached.value;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.fetchToken(provider, scope);
      this.inFlight.set(key, pending);
    }
    try {
      const token = await pending;
      this.tokens.set(key, token);
      return token.value;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchToken(provider: ConfigTokenProvider, scope: string | undefined): Promise<CachedToken> {
    this.fetches++;
    const doFetch = this.options.fetchImpl ?? fetch;
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const effectiveScope = scope ?? provider.scope;
    if (effectiveScope) body.set("scope", effectiveScope);

    const response = await doFetch(provider.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(provider.credential, "utf8").toString("base64")}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the token endpoint returned HTTP ${response.status}`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof payload.access_token !== "string") {
      throw new Error("the token endpoint returned no access_token");
    }
    const skew = provider.skewSec ?? 30;
    const lifetime = Math.max(1, (payload.expires_in ?? 300) - skew);
    return { value: payload.access_token, expiresAtMs: this.now + lifetime * 1000 };
  }
}

export const DEFAULT_INVALIDATE_ON = [401, 403];

/** The cache key an `invalidateOnStatus` response invalidates. */
export function tokenCacheKey(unit: BackendAuthUnit): string | null {
  if (unit.type !== "oauth2-client-credentials") return null;
  return `${unit.tokenProviderRef}|${unit.scope ?? ""}`;
}

export async function applyBackendAuth(
  unit: BackendAuthUnit | undefined,
  context: BackendAuthContext,
  tokens: TokenCache,
): Promise<BackendAuthResult> {
  if (!unit || unit.type === "none" || unit.type === "mtls") return { ok: true, headers: {} };

  switch (unit.type) {
    case "basic": {
      const secret = context.references.secrets[unit.credentialRef];
      if (secret === undefined) {
        return { ok: false, status: 503, detail: `credential "${unit.credentialRef}" is not configured` };
      }
      return {
        ok: true,
        headers: { authorization: `Basic ${Buffer.from(secret, "utf8").toString("base64")}` },
      };
    }
    case "api-key": {
      const secret = context.references.secrets[unit.credentialRef];
      if (secret === undefined) {
        return { ok: false, status: 503, detail: `credential "${unit.credentialRef}" is not configured` };
      }
      return unit.in === "header"
        ? { ok: true, headers: { [unit.name.toLowerCase()]: secret } }
        : { ok: true, headers: {}, query: { [unit.name]: secret } };
    }
    case "oauth2-client-credentials": {
      const provider = context.references.tokenProviders[unit.tokenProviderRef];
      if (!provider) {
        return {
          ok: false,
          status: 503,
          detail: `token provider "${unit.tokenProviderRef}" is not configured`,
        };
      }
      try {
        const token = await tokens.get(tokenCacheKey(unit)!, provider, unit.scope);
        return { ok: true, headers: { authorization: `Bearer ${token}` } };
      } catch (err) {
        // Fails closed. The policy this replaces forwards with an empty Authorization, which turns
        // an identity-provider blip into a backend 401 nobody can diagnose.
        return {
          ok: false,
          status: 503,
          detail: `could not obtain a backend token: ${(err as Error).message}`,
        };
      }
    }
    case "hmac-sa-key-lite": {
      const scheme = context.references.hmacSchemes[unit.schemeRef];
      if (!scheme) {
        return { ok: false, status: 503, detail: `HMAC scheme "${unit.schemeRef}" is not configured` };
      }
      const date = (context.now ?? new Date()).toUTCString();
      const signature = saKeyLiteSignature({
        method: context.method,
        appId: scheme.appId,
        appKey: scheme.appKey,
        serviceShortcut: unit.serviceShortcut,
        operationTemplate: context.operationTemplate,
        date,
      });
      return {
        ok: true,
        headers: {
          [(unit.dateHeader ?? "x-sa-date").toLowerCase()]: date,
          authorization: `SaKeyLite ${scheme.appId}:${signature}`,
        },
      };
    }
  }
}

/**
 * The `SaKeyLite` canonical string: method, then the empty content-type, content-MD5 and date
 * lines, then the `x-sa-date` header, then `/{appId}/{serviceShortcut}{operationTemplate}` —
 * signed HMAC-SHA256 with the base64-decoded application key.
 *
 * Per request, never cached: it covers a second-resolution timestamp, so two requests a second
 * apart must produce different values.
 */
export function saKeyLiteSignature(input: {
  method: string;
  appId: string;
  appKey: string;
  serviceShortcut: string;
  operationTemplate: string;
  date: string;
}): string {
  const canonical = [
    input.method.toUpperCase(),
    "",
    "",
    "",
    `x-sa-date:${input.date}`,
    `/${input.appId}/${input.serviceShortcut}${input.operationTemplate}`,
  ].join("\n");
  return createHmac("sha256", Buffer.from(input.appKey, "base64"))
    .update(canonical, "utf8")
    .digest("base64");
}

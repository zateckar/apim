import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { ipInCidr, ipv4ToInt } from "../../shared/net.ts";

/**
 * Design section 5.3: moving a URL out of policy does not close SSRF, because the owner still
 * writes it and the platform still fetches it. Every owner-supplied URL — backend bindings, spec
 * imports and MCP/A2A discovery alike — passes this allowlist at write time, and redirects are
 * never followed.
 *
 * `INTEGRATIONS_FILE` is also where every *reference* a policy may name resolves: JWT issuers,
 * OAuth token providers, HMAC schemes and shared secrets. That is what keeps design section 5's
 * promise that no URL an owner writes is fetched and no secret an owner writes is stored.
 *
 * Not implemented in the MVP, and stated rather than implied: per-request DNS pinning against
 * rebinding. The write-time resolution below closes the static case only.
 */
export interface EgressRule {
  scheme: "http" | "https";
  hostPattern: string;
  ports?: number[];
  portRange?: [number, number];
}

/**
 * Design section 5.1's `always` block for XML, as admin ceilings rather than policy: no route
 * setting relaxes them, and the reader refuses DTDs and entities outright.
 */
export interface XmlLimits {
  maxPrefixBytes: number;
  maxDepth: number;
  maxElements: number;
  maxBytes: number;
  contentTypes: string[];
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxPrefixBytes: 8192,
  maxDepth: 32,
  maxElements: 100_000,
  maxBytes: 8 * 1024 * 1024,
  contentTypes: ["text/xml", "application/soap+xml"],
};

/** Design section 11: per-route `validate` values are clamped by these, so one API's policy cannot
 * commandeer the instance and payload logging cannot be enabled by a resource owner alone. */
export interface ValidationCeilings {
  maxBodyBytes: number;
  minSampleRate: number;
  maxConcurrent: number;
  maxIncludeBodyExcerptBytes: number;
}

export const DEFAULT_VALIDATION_CEILINGS: ValidationCeilings = {
  maxBodyBytes: 8 * 1024 * 1024,
  minSampleRate: 0.01,
  maxConcurrent: 8,
  maxIncludeBodyExcerptBytes: 0,
};

/** A vetted token issuer. `issuerRef` in policy resolves to exactly one of these. */
export interface IssuerDef {
  issuer: string;
  jwksUrl?: string;
  algorithms: string[];
  audienceDefault?: string[];
  introspectionUrl?: string;
  /** The client credential the introspection call presents, as HTTP Basic. */
  credentialRef?: string;
}

/** A vetted OAuth2 token endpoint. `tokenProviderRef` in `backendAuth` resolves to one of these. */
export interface TokenProviderDef {
  tokenUrl: string;
  credentialRef: string;
  grant: "client_credentials";
  scope?: string;
  /** Seconds subtracted from `expires_in` before a cached token is considered stale. */
  skewSec?: number;
}

/** `SaKeyLite`'s per-environment application id and key (design section 5.5). */
export interface HmacSchemeDef {
  appIdRef: string;
  appKeyRef: string;
}

/** A named secret. `value` inline for development, `file` for anything real. */
export interface SharedSecretDef {
  value?: string;
  file?: string;
}

export interface Integrations {
  egressAllowlist: EgressRule[];
  denyCidrs: string[];
  xml?: XmlLimits;
  validationCeilings?: ValidationCeilings;
  issuers?: Record<string, IssuerDef>;
  tokenProviders?: Record<string, TokenProviderDef>;
  hmacSchemes?: Record<string, HmacSchemeDef>;
  sharedSecrets?: Record<string, SharedSecretDef>;
  /** Informational: the reverse proxy's client trust bundle, so CN-only's blast radius is recorded. */
  clientCaBundle?: { description?: string; issuers?: string[] };
  tlsExceptionMaxDays?: number;
}

export const DEFAULT_TLS_EXCEPTION_MAX_DAYS = 30;

/**
 * Resolves a `credentialRef` to its value. Called at boot for validation and at config-build time
 * for the values the gateway must present; never from a request path.
 */
export function resolveSecret(integrations: Integrations, ref: string): string | null {
  const entry = integrations.sharedSecrets?.[ref];
  if (!entry) return null;
  if (typeof entry.value === "string") return entry.value;
  if (typeof entry.file === "string") {
    try {
      return readFileSync(entry.file, "utf8").trim();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Design section 11: a wrong or missing value is a startup failure that names the variable, never
 * a silent downgrade. A dangling `credentialRef` is the case that matters — a policy referencing
 * it would otherwise fail at the first request rather than at boot.
 */
export function validateIntegrations(integrations: Integrations, path: string): void {
  const errors: string[] = [];
  const secret = (ref: string | undefined, where: string) => {
    if (ref === undefined) return;
    if (!integrations.sharedSecrets?.[ref]) {
      errors.push(`${where}: credentialRef "${ref}" is not in sharedSecrets`);
      return;
    }
    if (resolveSecret(integrations, ref) === null) {
      errors.push(`${where}: credentialRef "${ref}" resolves to nothing (no value, or an unreadable file)`);
    }
  };

  for (const [name, issuer] of Object.entries(integrations.issuers ?? {})) {
    if (typeof issuer.issuer !== "string" || issuer.issuer.length === 0) {
      errors.push(`issuers.${name}.issuer: expected the iss value tokens carry`);
    }
    if (!issuer.jwksUrl && !issuer.introspectionUrl) {
      errors.push(
        `issuers.${name}: expected a jwksUrl (for auth.jwt), an introspectionUrl ` +
          "(for auth.introspection), or both — an issuer with neither can verify nothing",
      );
    }
    if (!Array.isArray(issuer.algorithms) || issuer.algorithms.length === 0) {
      errors.push(
        `issuers.${name}.algorithms: expected a non-empty allowlist. Without one, a token signed ` +
          "with an algorithm nobody vetted would be accepted.",
      );
    }
    secret(issuer.credentialRef, `issuers.${name}`);
  }
  for (const [name, provider] of Object.entries(integrations.tokenProviders ?? {})) {
    if (typeof provider.tokenUrl !== "string") {
      errors.push(`tokenProviders.${name}.tokenUrl: expected a URL`);
    }
    if (provider.grant !== "client_credentials") {
      errors.push(`tokenProviders.${name}.grant: only "client_credentials" is implemented`);
    }
    secret(provider.credentialRef, `tokenProviders.${name}`);
  }
  for (const [name, scheme] of Object.entries(integrations.hmacSchemes ?? {})) {
    secret(scheme.appIdRef, `hmacSchemes.${name}.appIdRef`);
    secret(scheme.appKeyRef, `hmacSchemes.${name}.appKeyRef`);
  }
  if (errors.length > 0) {
    throw new Error(`${path}: ${errors.join("; ")}`);
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function portAllowed(rule: EgressRule, port: number): boolean {
  if (rule.ports?.includes(port)) return true;
  if (rule.portRange && port >= rule.portRange[0] && port <= rule.portRange[1]) return true;
  return false;
}

export { ipInCidr, ipv4ToInt } from "../../shared/net.ts";

/** Empty array means the URL may be fetched. */
export async function checkEgress(
  rawUrl: string,
  integrations: Integrations,
  where = "url",
): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [`${where}: not a valid absolute URL`];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return [`${where}: only http and https are allowed`];
  }
  if (url.username || url.password) {
    return [`${where}: credentials in the URL are not allowed`];
  }

  const scheme = url.protocol.slice(0, -1) as "http" | "https";
  const port = portOf(url);
  const matched = integrations.egressAllowlist.some(
    (rule) =>
      rule.scheme === scheme && hostMatches(url.hostname, rule.hostPattern) && portAllowed(rule, port),
  );
  if (!matched) {
    return [
      `${where}: ${scheme}://${url.hostname}:${port} is not in the egress allowlist ` +
        `(admin-registered in INTEGRATIONS_FILE, design section 5.3)`,
    ];
  }

  const denied = await resolvesIntoDeniedRange(url.hostname, integrations.denyCidrs);
  if (denied) return [`${where}: resolves to ${denied.ip}, inside denied range ${denied.cidr}`];
  return [];
}

async function resolvesIntoDeniedRange(
  hostname: string,
  denyCidrs: string[],
): Promise<{ ip: string; cidr: string } | null> {
  const addresses: string[] = [];
  if (ipv4ToInt(hostname) !== null) {
    addresses.push(hostname);
  } else {
    try {
      const results = await lookup(hostname, { all: true });
      for (const r of results) if (r.family === 4) addresses.push(r.address);
    } catch {
      // A name that does not resolve is not a policy failure here; the fetch will fail loudly.
      return null;
    }
  }
  for (const ip of addresses) {
    for (const cidr of denyCidrs) {
      if (ipInCidr(ip, cidr)) return { ip, cidr };
    }
  }
  return null;
}

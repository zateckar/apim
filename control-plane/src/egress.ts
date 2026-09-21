import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import {
  canonicalIp,
  internalIpv6Range,
  ipInCidr,
  ipv4ToInt,
  ipv6ToBytes,
  mappedIpv4,
} from "../../shared/net.ts";

/**
 * Design section 5.3, as revised in v1.4.0: moving a URL out of policy does not close SSRF, because
 * the owner still writes it and the platform still fetches it. Every owner-supplied URL — backend
 * bindings, spec imports and MCP/A2A discovery alike — passes this check at write time, and
 * redirects are never followed.
 *
 * What changed is which way round the boundary is stated. It used to be an **allowlist** here:
 * every backend host had to be registered in `INTEGRATIONS_FILE` and the control plane restarted.
 * At a self-service estate's size that made registering an API a ticket, and a list that is a
 * ticket is a list nobody reads. Egress is now allowed by default and forbidden two ways:
 *
 *  - `denyCidrs`, still in the file, applied **after** DNS resolution, which nothing clickable can
 *    widen. See `egress-governance`, *Keep the denied ranges in the file*.
 *  - deny **rules**, which an administrator states in the portal with a reason, and which take
 *    effect on routes already running — the config builder omits a route whose backend matches one.
 *
 * `INTEGRATIONS_FILE` is still where every *reference* a policy may name resolves: JWT issuers,
 * OAuth token providers, HMAC schemes and shared secrets. That is what keeps design section 5's
 * promise that no secret an owner writes is stored.
 *
 * Not implemented, and stated rather than implied: per-request DNS pinning against rebinding. The
 * write-time resolution below closes the static case only.
 */

/** A port set. Neither field means every port. */
export interface PortSpec {
  ports?: number[];
  portRange?: [number, number];
}

/**
 * One administrator-stated host the estate does not reach. Held in `egress_deny_rule`, not in the
 * file, because at this estate's size this is the half that changes — and the half whose changes
 * want a reason, an author and an audit line attached.
 */
export interface DenyRule extends PortSpec {
  id: string;
  /** `null` applies to every environment; a name applies to that one only. */
  environment: string | null;
  /** `null` matches both schemes. */
  scheme: "http" | "https" | null;
  /** An exact host, or `*.suffix` — which does not match the bare suffix. */
  hostPattern: string;
  reason: string;
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
  /**
   * IPv4 ranges nothing may reach, applied after resolution. IPv4-only by construction —
   * `shared/net.ts` says so — which is why `checkEgress` refuses an IPv6 literal outright rather
   * than letting it past a range that could never match it.
   */
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

/** A rule declaring neither `ports` nor `portRange` covers every port. */
function portMatches(spec: PortSpec, port: number): boolean {
  if (!spec.ports && !spec.portRange) return true;
  if (spec.ports?.includes(port)) return true;
  if (spec.portRange && port >= spec.portRange[0] && port <= spec.portRange[1]) return true;
  return false;
}

/**
 * The first rule that forbids this URL, or `null`.
 *
 * `environment` is the one whose gateways would carry the binding. Passing `null` — a spec import or
 * an MCP/A2A discovery fetch, which happen before the definition is an act in any one environment —
 * consults **estate-wide** rules only, because an environment-scoped rule is a statement about that
 * environment's gateways rather than about the platform.
 */
export function matchingDenyRule(
  rawUrl: string,
  rules: DenyRule[],
  environment: string | null,
): DenyRule | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const scheme = url.protocol.slice(0, -1) as "http" | "https";
  const port = portOf(url);
  for (const rule of rules) {
    if (rule.environment !== null && rule.environment !== environment) continue;
    if (rule.scheme !== null && rule.scheme !== scheme) continue;
    if (!hostMatches(url.hostname, rule.hostPattern)) continue;
    if (!portMatches(rule, port)) continue;
    return rule;
  }
  return null;
}

export { ipInCidr, ipv4ToInt } from "../../shared/net.ts";

/**
 * What a URL is checked against. `rules` is omitted at boot deliberately: `OIDC_ISSUER`, `ELK_URL`
 * and the playground targets are set by the operator in the environment, not written by an owner,
 * and running them through an administrator-editable control would let a rule created in the portal
 * brick the next restart (`runtime-configuration`, *An administrator's deny rule cannot prevent a
 * restart*).
 */
export interface EgressScope {
  integrations: Integrations;
  rules?: DenyRule[];
  /** The environment the URL would be used in; `null` consults estate-wide rules only. */
  environment?: string | null;
}

/** Empty array means the URL may be fetched. */
export async function checkEgress(
  rawUrl: string,
  where: string,
  scope: EgressScope,
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
  // `URL` keeps the brackets on an IPv6 literal, which is the only host form that reaches here
  // wearing them. Refused rather than resolved: `denyCidrs` is IPv4-only, so `http://[::1]:9000`
  // would otherwise walk straight past a denied `127.0.0.0/8`.
  if (url.hostname.startsWith("[")) {
    return [
      `${where}: ${url.hostname} is an IPv6 literal, which cannot be checked against the denied ` +
        "ranges — use a hostname, or an IPv4 address",
    ];
  }

  const rule = matchingDenyRule(rawUrl, scope.rules ?? [], scope.environment ?? null);
  if (rule) {
    const scopeName = rule.environment === null ? "every environment" : rule.environment;
    return [
      `${where}: ${url.hostname} is blocked by the rule "${rule.hostPattern}" (${scopeName}) — ` +
        `${rule.reason}`,
    ];
  }

  const denied = await resolvesIntoDeniedRange(url.hostname, scope.integrations.denyCidrs);
  if (denied) return [`${where}: resolves to ${denied.ip}, inside denied range ${denied.cidr}`];
  return [];
}

/**
 * Every address this name resolves to, checked — **including** the `AAAA` answers.
 *
 * Those used to be filtered out, on the assumption that `denyCidrs` being IPv4-only made them
 * unanswerable. It does not: it makes them *uncheckable against that list*, which is a reason to
 * judge them another way rather than to admit them. A host whose `A` record was public and whose
 * `AAAA` record was `::1` passed this check and was then reached over IPv6, and a host with no `A`
 * record at all passed with no address examined at all. That is the same hole `checkEgress` refuses
 * an IPv6 literal to avoid, one hop behind a name.
 *
 * So each family is judged by the rule that can see it: IPv4 against the operator's `denyCidrs`,
 * IPv6 against the ranges that are internal by definition (`internalIpv6Range`). An IPv4-mapped
 * answer is an IPv4 host and goes through `denyCidrs` like any other. A genuine IPv6 address in no
 * named range is public and allowed, so an ordinary dual-stack backend is unaffected.
 */
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
      for (const r of results) addresses.push(r.address);
    } catch {
      // A name that does not resolve is not a policy failure here; the fetch will fail loudly.
      return null;
    }
  }
  for (const address of addresses) {
    const bytes = ipv4ToInt(canonicalIp(address)) === null ? ipv6ToBytes(address) : null;
    // An IPv4 answer, or an IPv6 one that is only an IPv4 address in IPv6 clothing.
    const ip = bytes ? mappedIpv4(bytes) : canonicalIp(address);
    if (ip !== null) {
      for (const cidr of denyCidrs) {
        if (ipInCidr(ip, cidr)) return { ip, cidr };
      }
      continue;
    }
    if (!bytes) {
      // Neither family parsed. The resolver produced something this cannot judge, and admitting an
      // address nothing checked is the failure this function exists to prevent.
      return { ip: address, cidr: "an address this platform cannot parse" };
    }
    const range = internalIpv6Range(bytes);
    if (range) return { ip: address, cidr: range };
  }
  return null;
}

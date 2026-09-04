/**
 * Routing rules shared by both planes, so "what does this base path match" has exactly one
 * answer. Design section 4: `route` carries UNIQUE(environment, host, base_path); frontend
 * routing is a row with a constraint, not an implication of the spec's `servers` block.
 */

/** Reserved on the data plane: a route base path may not shadow the gateway's own endpoints. */
export const RESERVED_BASE_PATHS = ["/healthz", "/readyz"];

export const MAX_BASE_PATH_LENGTH = 128;

export interface NormalizedBasePath {
  basePath: string;
  errors: string[];
}

/**
 * Must start with `/`, no trailing slash except the single-character root, no query or fragment.
 * Paths are matched case-sensitively (HTTP paths are), hosts case-insensitively.
 */
export function normalizeBasePath(input: unknown): NormalizedBasePath {
  const errors: string[] = [];
  if (typeof input !== "string" || input.length === 0) {
    return { basePath: "", errors: ["basePath: expected a non-empty string"] };
  }
  let value = input.trim();
  if (!value.startsWith("/")) errors.push('basePath: must start with "/"');
  if (value.includes("?") || value.includes("#")) {
    errors.push("basePath: must not contain a query string or fragment");
  }
  if (/\s/.test(value)) errors.push("basePath: must not contain whitespace");
  if (value.includes("//")) errors.push('basePath: must not contain "//"');
  if (value.length > MAX_BASE_PATH_LENGTH) {
    errors.push(`basePath: longer than ${MAX_BASE_PATH_LENGTH} characters`);
  }
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (RESERVED_BASE_PATHS.includes(value)) {
    errors.push(`basePath: "${value}" is reserved by the data plane`);
  }
  return { basePath: value, errors };
}

export function normalizeHost(input: unknown): { host: string; errors: string[] } {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { host: "*", errors: [] };
  }
  const host = input.trim().toLowerCase();
  if (host === "*") return { host, errors: [] };
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { host, errors: ['host: expected a hostname or "*"'] };
  }
  return { host, errors: [] };
}

/** The `Host` header with any port stripped, lowercased. */
export function hostKey(hostHeader: string | null): string {
  if (!hostHeader) return "";
  const value = hostHeader.trim().toLowerCase();
  // IPv6 literal: [::1]:8081
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * A path is under a base path only at a segment boundary, so `/petstoreXYZ` does not match
 * `/petstore`. The root base path `/` matches everything.
 */
export function pathMatchesBase(path: string, basePath: string): boolean {
  if (basePath === "/") return true;
  return path === basePath || path.startsWith(basePath + "/");
}

/** What remains after `rewrite.stripBasePath`. Always starts with `/`. */
export function stripBasePath(path: string, basePath: string): string {
  if (basePath === "/") return path;
  if (path === basePath) return "/";
  if (path.startsWith(basePath + "/")) return path.slice(basePath.length);
  return path;
}

/**
 * Backend URL join by concatenation. `new URL(path, base)` would discard the backend's own path
 * segment, turning https://petstore.swagger.io/v2 + /pet/1 into https://petstore.swagger.io/pet/1.
 */
export function joinBackend(backendUrl: string, path: string, query: string): string {
  const base = new URL(backendUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : "/" + path;
  return `${base.origin}${basePath}${suffix}${query}`;
}

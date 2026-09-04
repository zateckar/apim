/**
 * The refusals, on their own, so that a module which decides something can say no without
 * depending on the HTTP layer that will report it.
 *
 * These lived in `router.ts` until v5, when the directory (`principals.ts`) needed to raise a
 * `conflict` — and `router.ts` needs the directory to resolve a session's user. Extracting the four
 * lines both sides wanted breaks the cycle instead of relying on ES modules tolerating it.
 *
 * `router.ts` re-exports every name here, so nothing else had to change.
 *
 * `extra` is spread into the `application/problem+json` body, which is how a refusal carries the
 * remedy the UI links to (`fix: { screen, resourceId, environment }`).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(`${status} ${title}: ${detail}`);
  }
}

export function badRequest(detail: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, "Bad Request", detail, extra);
}
export function unauthorized(detail: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(401, "Unauthorized", detail, extra);
}
export function forbidden(detail: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(403, "Forbidden", detail, extra);
}
export function notFound(detail: string): HttpError {
  return new HttpError(404, "Not Found", detail);
}
export function conflict(detail: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(409, "Conflict", detail, extra);
}
export function tooManyRequests(detail: string, retryAfterSec: number): HttpError {
  return new HttpError(429, "Too Many Requests", detail, { retryAfterSec });
}
/**
 * Something the control plane reached out to did not answer. Distinct from `badRequest` on
 * purpose: the caller's request was fine, an endpoint somebody registered is down, and telling
 * them to fix their request would send them looking in the wrong place.
 */
export function badGateway(detail: string): HttpError {
  return new HttpError(502, "Bad Gateway", detail);
}
/** An upstream this process depends on is unreachable, and the next attempt may well work. */
export function serviceUnavailable(detail: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(503, "Service Unavailable", detail, extra);
}

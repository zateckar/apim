import { sha256Hex } from "../../../shared/canonical.ts";
import { badRequest, forbidden, HttpError, notFound, type Ctx } from "../router.ts";
import { can, type User } from "../auth.ts";
import { nowIso } from "../db.ts";

export interface ResourceRow {
  id: string;
  kind: string;
  name: string;
  application_id: string;
  api_version: string;
  lifecycle: string;
  sunset_at: string | null;
  created_at: string;
  updated_at: string;
  /** The catalog's marketing columns (schema-003). They belong to the resource, not to a listing
   * that could disagree with it. */
  summary: string | null;
  description: string | null;
  tags_json: string;
  docs_url: string | null;
  icon: string | null;
  visibility: string;
  /** Where a discovered contract came from, so `regenerate` knows what to re-ask (goals G4, G5). */
  discovery_url: string | null;
  /** The catalogue's taxonomy (schema-007). The domain is the first segment of the published path;
   * `null` means the row predates domains and gets one on its next save. */
  domain: string | null;
  subdomain: string | null;
}

export function getResource(ctx: Ctx, id: string): ResourceRow {
  const row = ctx.app.db
    .query<ResourceRow, [string]>("SELECT * FROM resource WHERE id = ?")
    .get(id);
  if (!row) throw notFound(`no resource ${id}`);
  return row;
}

export function assertCan(user: User | null, applicationId: string | null | undefined, what: string): void {
  if (!can(user, applicationId)) {
    throw forbidden(`${what}: you are not a member of the owning application and not an admin`);
  }
}

/**
 * Bumps `updated_at`, which is what the ETag is over. Anything that changes what a resource's
 * config would render to calls this — including things stored outside the `resource` row, like a
 * binding or a TLS exception, because a stale ETag is how two editors stop seeing each other.
 */
export function touch(ctx: Ctx, resourceId: string): void {
  ctx.app.db.run("UPDATE resource SET updated_at = ? WHERE id = ?", [nowIso(), resourceId]);
}

export function etagOf(row: { id: string; updated_at: string }): string {
  return `"${sha256Hex(`${row.id}|${row.updated_at}`)}"`;
}

/** Design section 9: PATCH requires If-Match, so two owners editing at once get a conflict. */
export function assertIfMatch(ctx: Ctx, row: { id: string; updated_at: string }): void {
  const header = ctx.req.headers.get("if-match");
  if (!header) {
    throw new HttpError(
      428,
      "Precondition Required",
      "If-Match is required on this request; GET the resource first and send back its ETag",
    );
  }
  const expected = etagOf(row);
  const presented = header.split(",").map((v) => v.trim().replace(/^W\//, ""));
  if (!presented.includes("*") && !presented.includes(expected)) {
    throw new HttpError(
      412,
      "Precondition Failed",
      `If-Match does not match the current ETag ${expected}; someone else changed this resource`,
    );
  }
}

export function environmentOf(ctx: Ctx, fallbackToQuery = true): string {
  const fromQuery = fallbackToQuery ? ctx.url.searchParams.get("environment") : null;
  const environment = fromQuery ?? ctx.app.config.promotionChain[0]!;
  if (!ctx.app.config.promotionChain.includes(environment)) {
    throw badRequest(
      `unknown environment "${environment}" (PROMOTION_CHAIN is ${ctx.app.config.promotionChain.join(",")})`,
    );
  }
  return environment;
}

export interface Page {
  limit: number;
  offset: number;
}

/** Design section 14: `?limit=&cursor=` is a contract, not a per-route decision. */
export function pageOf(ctx: Ctx): Page {
  const limitRaw = ctx.url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequest("limit: expected an integer between 1 and 200");
  }
  const cursor = ctx.url.searchParams.get("cursor");
  let offset = 0;
  if (cursor) {
    offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(offset) || offset < 0) throw badRequest("cursor: not a valid cursor");
  }
  return { limit, offset };
}

export function nextCursor(page: Page, returned: number): string | null {
  return returned < page.limit ? null : Buffer.from(String(page.offset + returned)).toString("base64url");
}

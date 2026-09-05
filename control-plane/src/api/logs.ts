import { badRequest, json, requireUser, Router, type Ctx } from "../router.ts";
import {
  createLogSearch,
  readableResourceIds,
  STATUS_CLASSES,
  type LogQuery,
  type LogSearchProvider,
  type StatusClass,
} from "../logs.ts";
import { environmentOf, pageOf } from "./common.ts";

/**
 * The two reads the Logs tab makes, and nothing else.
 *
 * There is no write here and no per-resource route: the resource is a *filter*, and the same two
 * endpoints answer "this API's traffic" and "everything I can see". Authorization is applied by
 * turning the caller into a list of resource ids before the query is built, so a caller cannot
 * name a resource they may not read — the worst a wrong id does is return nothing.
 */

/** One provider per process. The mock caches per-resource context and the ELK client is stateless. */
let cached: { provider: LogSearchProvider; key: string } | null = null;

function providerFor(ctx: Ctx): LogSearchProvider {
  const key = `${ctx.app.config.logs.provider}|${ctx.app.config.logs.url ?? ""}|${ctx.app.config.logs.index}`;
  if (!cached || cached.key !== key) cached = { provider: createLogSearch(ctx.app), key };
  return cached.provider;
}

/** Exposed so a test can drop a stub in, and so a config change in-process is not sticky. */
export function resetLogSearchCache(): void {
  cached = null;
}

function queryOf(ctx: Ctx): LogQuery {
  const user = requireUser(ctx);
  const environment = environmentOf(ctx);
  const page = pageOf(ctx);
  const params = ctx.url.searchParams;

  const to = params.get("to") ? new Date(params.get("to")!) : new Date();
  if (Number.isNaN(to.getTime())) throw badRequest("to: expected an ISO-8601 timestamp");
  const sinceMin = Number(params.get("sinceMin") ?? 60);
  if (!Number.isInteger(sinceMin) || sinceMin < 1) {
    throw badRequest("sinceMin: expected a positive integer number of minutes");
  }
  const from = params.get("from") ? new Date(params.get("from")!) : new Date(to.getTime() - sinceMin * 60_000);
  if (Number.isNaN(from.getTime())) throw badRequest("from: expected an ISO-8601 timestamp");
  if (from >= to) throw badRequest("from must be before to");

  const maxHours = ctx.app.config.logs.maxRangeHours;
  if (to.getTime() - from.getTime() > maxHours * 3600_000) {
    throw badRequest(
      `that window is wider than the ${maxHours} hours this portal will ask the log index for ` +
        "(LOGS_MAX_RANGE_HOURS). Narrow the range.",
    );
  }

  const statusClass = params.get("status");
  if (statusClass && !STATUS_CLASSES.includes(statusClass as StatusClass)) {
    throw badRequest(`status: expected one of ${STATUS_CLASSES.join(", ")}`);
  }
  const method = params.get("method");
  if (method && !/^[A-Za-z]{3,10}$/.test(method)) throw badRequest("method: expected an HTTP method name");
  const minDurationRaw = params.get("minDurationMs");
  const minDurationMs = minDurationRaw === null ? undefined : Number(minDurationRaw);
  if (minDurationMs !== undefined && (!Number.isFinite(minDurationMs) || minDurationMs < 0)) {
    throw badRequest("minDurationMs: expected a non-negative number");
  }

  return {
    environment,
    resourceIds: readableResourceIds(ctx.app, user, environment, params.get("resourceId") ?? undefined),
    from,
    to,
    statusClass: (statusClass as StatusClass) ?? undefined,
    method: method ?? undefined,
    pathContains: params.get("path")?.slice(0, 200) || undefined,
    subscriptionId: params.get("subscriptionId") ?? undefined,
    minDurationMs,
    limit: page.limit,
    offset: page.offset,
  };
}

export function registerLogRoutes(router: Router): void {
  router.add("GET", "/api/logs", "session", async (ctx) => {
    const query = queryOf(ctx);
    const provider = providerFor(ctx);
    const page = await provider.search(query);
    return json({
      ...page,
      // Echoed so the screen can say what it is showing without re-deriving it, and so a
      // bookmarked window is unambiguous when the default changes.
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      provider: provider.kind,
      // `null` when the page is the last one; the shape `pageOf`/`nextCursor` uses everywhere else.
      nextCursor:
        query.offset + page.items.length < page.total
          ? Buffer.from(String(query.offset + page.items.length)).toString("base64url")
          : null,
    });
  });

  router.add("GET", "/api/logs/histogram", "session", async (ctx) => {
    const query = queryOf(ctx);
    const bucketsRaw = ctx.url.searchParams.get("buckets");
    const buckets = bucketsRaw ? Number(bucketsRaw) : 48;
    if (!Number.isInteger(buckets) || buckets < 4 || buckets > 240) {
      throw badRequest("buckets: expected an integer between 4 and 240");
    }
    const provider = providerFor(ctx);
    const histogram = await provider.histogram(query, buckets);
    return json({
      ...histogram,
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      provider: provider.kind,
    });
  });
}

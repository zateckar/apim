import { RESOURCE_KINDS, type ApiModel, type ApiOperation } from "../../../shared/types.ts";
import { can } from "../auth.ts";
import { bm25Expression, matchExpression } from "../search.ts";
import { badRequest, json, notFound, readJson, requireUser, Router, type Ctx } from "../router.ts";
import { createSubscription } from "./catalog.ts";
import { environmentOf, pageOf, nextCursor, type ResourceRow } from "./common.ts";
import { DOMAINS, findDomain } from "../../../shared/domains.ts";

/**
 * The Catalog (goal G6, plan section 11.2) — a marketplace over APIs, MCP servers and A2A agents.
 *
 * It is a read model over what already exists, and deliberately not a second source of truth: a
 * listing is a resource, its marketing text lives on the resource row, and "which environments is
 * this live in" is answered from releases rather than from anything a publisher types. A listing
 * that could disagree with the thing it lists would be worse than no listing.
 *
 * Three rules decide what a caller sees `[R2-11]`:
 *
 *  - Anything with at least one converged release is visible to everybody.
 *  - Something not yet published is visible to people who own it, badged as such — otherwise a
 *    publisher cannot see their own work until they release it.
 *  - `unlisted` is visible only to people who own it, whatever its release state. That is the
 *    switch that also makes an A2A agent's card private (`[R1-17]`), so it is one decision.
 */

/**
 * A ceiling on how many rows are ranked in memory. The catalog is an estate of APIs, not a web
 * index, so this is far above any real one — but it is stated and reported rather than silently
 * truncating a result set.
 */
const RANK_CEILING = 2000;

type Sort = "relevance" | "name" | "newest" | "popular";

interface Candidate {
  row: ResourceRow;
  score: number;
}

/**
 * Ranked candidates, plus whether the *candidate* query hit `RANK_CEILING` — which is not the same
 * question as whether the answer is long. The filters below run after the ceiling, so a search that
 * fetched 2000 rows and kept 40 of them has still lost everything past the 2000th, and reporting
 * truncation from the surviving count would say "no" in exactly that case.
 */
interface Ranked {
  items: Candidate[];
  ceilingHit: boolean;
}

export function registerMarketRoutes(router: Router): void {
  router.add("GET", "/api/catalog", "session", (ctx) => {
    const page = pageOf(ctx);
    const filters = readFilters(ctx);
    const ranked = rank(ctx, filters);
    const slice = ranked.items.slice(page.offset, page.offset + page.limit);
    return json({
      items: slice.map((candidate) => cardFor(ctx, candidate.row)),
      total: ranked.items.length,
      truncated: ranked.ceilingHit,
      cursor: nextCursor(page, slice.length),
    });
  });

  // Before `/:resourceId`, because the router is first-match-wins and `facets` is not an id.
  router.add("GET", "/api/catalog/facets", "session", (ctx) => {
    const { rows: visible, ceilingHit } = visibleResources(ctx);
    const kinds: Record<string, number> = {};
    const tags: Record<string, number> = {};
    const applications: Record<string, number> = {};
    // Counted over the visible set rather than over `release`, so every facet answers the same
    // question the filter it drives does. A `GROUP BY` over the whole table would count an
    // unlisted resource's release for a caller who cannot see the resource — a count that is both
    // a small leak and a number the filter then contradicts.
    const environments: Record<string, number> = {};
    const domains: Record<string, number> = {};
    for (const row of visible) {
      kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
      applications[row.application_id] = (applications[row.application_id] ?? 0) + 1;
      domains[row.domain ?? UNCLASSIFIED] = (domains[row.domain ?? UNCLASSIFIED] ?? 0) + 1;
      for (const tag of tagsFor(ctx, row.id)) tags[tag] = (tags[tag] ?? 0) + 1;
      for (const environment of liveEnvironments(ctx, row.id)) {
        environments[environment] = (environments[environment] ?? 0) + 1;
      }
    }
    // Topics are catalog items in the same taxonomy, and the Catalog screen counts them beside the
    // APIs — a domain that reads "11 APIs" while holding four topics is describing half an estate.
    const topics: Record<string, number> = {};
    for (const row of ctx.app.db
      .query<{ domain: string | null }, []>(
        "SELECT domain FROM kafka_topic WHERE state != 'deleted'",
      )
      .all()) {
      topics[row.domain ?? UNCLASSIFIED] = (topics[row.domain ?? UNCLASSIFIED] ?? 0) + 1;
    }

    return json({
      kinds: counted(kinds),
      tags: counted(tags).slice(0, 50),
      applications: counted(applications),
      /*
       * In taxonomy order rather than by count, with "Other" last: the domain list is a fixed
       * structure the estate is filed into, so a domain that happens to be empty today still
       * belongs in it — and one that reorders itself as APIs are published is not a structure.
       */
      domains: [
        ...DOMAINS.map((domain) => ({
          value: domain.name,
          count: domains[domain.name] ?? 0,
          topics: topics[domain.name] ?? 0,
        })),
        {
          value: UNCLASSIFIED,
          count: domains[UNCLASSIFIED] ?? 0,
          topics: topics[UNCLASSIFIED] ?? 0,
        },
      ],
      // In promotion-chain order, because dev → test → prod is how the estate is read.
      environments: ctx.app.config.promotionChain
        .filter((environment) => environments[environment])
        .map((environment) => ({ value: environment, count: environments[environment]! })),
      total: visible.length,
      truncated: ceilingHit,
    });
  });

  router.add("GET", "/api/catalog/:resourceId", "session", (ctx) => {
    const row = ctx.app.db
      .query<ResourceRow, [string]>("SELECT * FROM resource WHERE id = ?")
      .get(ctx.params.resourceId!);
    if (!row || !isVisible(ctx, row)) throw notFound(`no listing ${ctx.params.resourceId}`);

    const model = latestModel(ctx, row.id);
    const card = cardFor(ctx, row);
    const routes = ctx.app.db
      .query<{ environment: string; host: string; base_path: string }, [string]>(
        "SELECT environment, host, base_path FROM route WHERE resource_id = ?",
      )
      .all(row.id);

    return json({
      ...card,
      description: row.description ?? model?.description ?? null,
      docsUrl: row.docs_url,
      operations: operationsView(row.kind, model),
      // Which URL to call, per environment. Not derivable by a consumer from anything else, and
      // the first thing they need.
      endpoints: routes.map((route) => ({
        environment: route.environment,
        host: route.host,
        basePath: route.base_path,
        live: card.environments.includes(route.environment),
      })),
      // A ready-to-paste call, built from the live route and the key header this route actually
      // requires — an example that does not work is worse than none.
      example: exampleFor(ctx, row, model, routes),
      versions: ctx.app.db
        .query<{ id: string; api_version: string; lifecycle: string }, [string, string]>(
          "SELECT id, api_version, lifecycle FROM resource WHERE application_id = ? AND name = ? ORDER BY api_version",
        )
        .all(row.application_id, row.name),
      traffic: trafficFor(ctx, row.id),
      ...(model?.mcp ? { mcp: { protocolVersion: model.mcp.protocolVersion, serverInfo: model.mcp.serverInfo } } : {}),
      ...(model?.a2a
        ? {
            a2a: {
              protocolVersion: model.a2a.protocolVersion,
              skills: model.a2a.skills,
              capabilities: model.a2a.capabilities,
              cardPath: "/.well-known/agent-card.json",
            },
          }
        : {}),
    });
  });

  /**
   * Subscribe from the catalog. A thin alias for `POST /api/subscriptions` with the product in the
   * path, because that is the shape the Subscribe dialog has in hand — the product is what it is
   * looking at, and the application is what the consumer chose.
   */
  router.add("POST", "/api/catalog/:productId/subscribe", "session", async (ctx) => {
    const body = await readJson<{ applicationId?: string; environment?: string; purpose?: string }>(ctx);
    return createSubscription(ctx, {
      productId: ctx.params.productId,
      applicationId: body.applicationId,
      purpose: body.purpose,
      environment: body.environment ?? environmentOf(ctx),
    });
  });

  /**
   * What a consumer needs to answer "am I about to be cut off" (plan `[R2-38]`): the quota already
   * spent against the fleet aggregate, when the window resets, and how often they have been
   * rejected lately.
   */
  router.add("GET", "/api/subscriptions/:id/usage", "session", (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.app.db
      .query<
        { id: string; environment: string; state: string; app_application: string; product_id: string },
        [string]
      >(
        `SELECT s.id, s.environment, s.state, a.id AS app_application, s.product_id
           FROM subscription s JOIN application a ON a.id = s.application_id
          WHERE s.id = ?`,
      )
      .get(ctx.params.id!);
    if (!row) throw notFound(`no subscription ${ctx.params.id}`);
    if (!can(user, row.app_application)) throw notFound(`no subscription ${ctx.params.id}`);

    const counters = ctx.app.db
      .query<
        { scope_kind: string; scope_id: string; period_sec: number; window_start: string; count: number },
        [string, string]
      >(
        `SELECT scope_kind, scope_id, period_sec, window_start, count
           FROM usage_counter WHERE subscription_id = ? AND environment = ?
          ORDER BY window_start DESC LIMIT 100`,
      )
      .all(row.id, row.environment);

    const now = Date.now();
    const windows = counters
      .map((entry) => {
        const endsAt = Date.parse(entry.window_start) + entry.period_sec * 1000;
        return {
          scopeKind: entry.scope_kind,
          scopeId: entry.scope_id,
          periodSec: entry.period_sec,
          windowStart: entry.window_start,
          used: entry.count,
          // Pending deltas are not written yet, so this is a floor rather than an exact figure —
          // which is what "enforcement, not a ledger" means (deviation D15).
          resetsInSec: Math.max(0, Math.round((endsAt - now) / 1000)),
          open: endsAt > now,
        };
      })
      .filter((entry) => entry.open);

    const rejections = ctx.app.db
      .query<{ outcome: string; n: number }, [string]>(
        `SELECT outcome, SUM(count) AS n FROM telemetry_rollup
          WHERE subscription_id = ? AND outcome IN ('rate-limited', 'quota-exceeded')
          GROUP BY outcome`,
      )
      .all(row.id);

    return json({
      id: row.id,
      state: row.state,
      environment: row.environment,
      windows,
      rejections: Object.fromEntries(rejections.map((entry) => [entry.outcome, entry.n])),
      note:
        "Quota counters are enforcement state, not billing records: they are dropped when their " +
        "window closes and a lost instance report under-counts rather than being reconciled.",
    });
  });
}

// --------------------------------------------------------------------------- ranking

interface Filters {
  q: string | null;
  kind: string | null;
  tag: string | null;
  application: string | null;
  environment: string | null;
  /** A domain label, or the literal `other` for everything the taxonomy does not yet cover. */
  domain: string | null;
  sort: Sort;
}

/** The bucket unclassified rows fall into, on both the filter and the facet. */
export const UNCLASSIFIED = "other";

function readFilters(ctx: Ctx): Filters {
  const sort = (ctx.url.searchParams.get("sort") ?? "relevance") as Sort;
  if (!["relevance", "name", "newest", "popular"].includes(sort)) {
    throw badRequest('sort: expected relevance, name, newest or popular');
  }
  const kind = ctx.url.searchParams.get("kind");
  if (kind && !RESOURCE_KINDS.includes(kind as never)) {
    throw badRequest(`kind: expected one of ${RESOURCE_KINDS.join(", ")}`);
  }
  const environment = ctx.url.searchParams.get("environment");
  if (environment && !ctx.app.config.promotionChain.includes(environment)) {
    throw badRequest(`unknown environment "${environment}"`);
  }
  const domain = ctx.url.searchParams.get("domain");
  if (domain && domain !== UNCLASSIFIED && !findDomain(domain)) {
    throw badRequest(`domain: "${domain}" is not one of ${DOMAINS.map((d) => d.name).join(", ")}`);
  }
  return {
    q: ctx.url.searchParams.get("q"),
    kind,
    tag: ctx.url.searchParams.get("tag"),
    application: ctx.url.searchParams.get("application"),
    environment,
    domain,
    sort,
  };
}

/**
 * Candidates, scored and ordered. The full-text half runs in SQLite; the ordering half runs here,
 * because `popular` and the relevance boost both need counts that live in other tables and a
 * catalog is an estate rather than a corpus.
 */
function rank(ctx: Ctx, filters: Filters): Ranked {
  const match = buildMatch(filters);
  if (match === "impossible") return { items: [], ceilingHit: false };
  let candidates: Candidate[];

  if (match) {
    const rows = ctx.app.db
      .query<ResourceRow & { score: number }, [string, number]>(
        `SELECT r.*, ${bm25Expression()} AS score
           FROM resource_fts JOIN resource r ON r.id = resource_fts.resource_id
          WHERE resource_fts MATCH ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(match, RANK_CEILING);
    // bm25 is negative and more negative is better, so it is flipped into "higher is better" here
    // and nowhere else.
    candidates = rows.map((row) => ({ row, score: -row.score }));
  } else {
    const rows = ctx.app.db
      .query<ResourceRow, [number]>("SELECT * FROM resource ORDER BY name LIMIT ?")
      .all(RANK_CEILING);
    candidates = rows.map((row) => ({ row, score: 0 }));
  }

  // Read before the filters run: afterwards there is no way to tell a short answer from a
  // truncated one.
  const ceilingHit = candidates.length >= RANK_CEILING;

  candidates = candidates.filter((candidate) => isVisible(ctx, candidate.row));
  if (filters.kind) candidates = candidates.filter((c) => c.row.kind === filters.kind);
  if (filters.application) candidates = candidates.filter((c) => c.row.application_id === filters.application);
  if (filters.environment) {
    candidates = candidates.filter((c) =>
      liveEnvironments(ctx, c.row.id).includes(filters.environment!),
    );
  }
  if (filters.domain) {
    candidates = candidates.filter((c) =>
      filters.domain === UNCLASSIFIED ? !c.row.domain : c.row.domain === filters.domain,
    );
  }

  const popularity = popularityMap(ctx);
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: candidate.score + boostOf(popularity.get(candidate.row.id)),
  }));

  switch (filters.sort) {
    case "name":
      return { items: scored.sort((a, b) => a.row.name.localeCompare(b.row.name)), ceilingHit };
    case "newest":
      return {
        items: scored.sort((a, b) => b.row.created_at.localeCompare(a.row.created_at)),
        ceilingHit,
      };
    case "popular":
      return {
        items: scored.sort((a, b) => {
          const left = popularity.get(a.row.id) ?? { subscribers: 0, requests: 0 };
          const right = popularity.get(b.row.id) ?? { subscribers: 0, requests: 0 };
          // Subscribers first, requests as the tie-break: a product ten applications depend on is more
          // popular than one application hammering an endpoint `[R2-39]`.
          if (right.subscribers !== left.subscribers) return right.subscribers - left.subscribers;
          if (right.requests !== left.requests) return right.requests - left.requests;
          return a.row.name.localeCompare(b.row.name);
        }),
        ceilingHit,
      };
    default:
      return {
        items: scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name)),
        ceilingHit,
      };
  }
}

/**
 * The user's words and the tag filter as one FTS5 expression. A tag is a column filter rather than
 * a SQL predicate because the effective tag set includes an A2A card's skill tags, which live in
 * the projection rather than on the resource row.
 */
function buildMatch(filters: Filters): string | null | "impossible" {
  const parts: string[] = [];
  if (filters.q) {
    const expression = matchExpression(filters.q);
    // A query of pure punctuation matches nothing rather than everything: the caller asked for
    // something, and answering with the whole catalog would look like the filter was ignored.
    // Answered here rather than in SQLite, because "match nothing" has no FTS5 spelling.
    if (!expression) return "impossible";
    parts.push(expression);
  }
  if (filters.tag) {
    const tag = filters.tag.trim().toLowerCase().replace(/"/g, '""');
    if (!tag) return "impossible";
    parts.push(`tags : "${tag}"`);
  }
  return parts.length > 0 ? parts.join(" AND ") : null;
}

function boostOf(entry: { subscribers: number; requests: number } | undefined): number {
  if (!entry) return 0;
  // Logarithmic, so a popular listing wins ties and near-ties without burying an exact name match
  // under something merely busy.
  return Math.log10(1 + entry.subscribers) * 2 + Math.log10(1 + entry.requests) * 0.5;
}

function popularityMap(ctx: Ctx): Map<string, { subscribers: number; requests: number }> {
  const map = new Map<string, { subscribers: number; requests: number }>();
  const subscribers = ctx.app.db
    .query<{ resource_id: string; n: number }, []>(
      `SELECT pm.resource_id, COUNT(DISTINCT s.application_id) AS n
         FROM subscription s JOIN product_member pm ON pm.product_id = s.product_id
        WHERE s.state = 'active'
        GROUP BY pm.resource_id`,
    )
    .all();
  for (const entry of subscribers) map.set(entry.resource_id, { subscribers: entry.n, requests: 0 });

  const requests = ctx.app.db
    .query<{ resource_id: string; n: number }, []>(
      "SELECT resource_id, SUM(count) AS n FROM telemetry_rollup GROUP BY resource_id",
    )
    .all();
  for (const entry of requests) {
    const existing = map.get(entry.resource_id) ?? { subscribers: 0, requests: 0 };
    existing.requests = entry.n;
    map.set(entry.resource_id, existing);
  }
  return map;
}

// --------------------------------------------------------------------------- visibility

function isVisible(ctx: Ctx, row: ResourceRow): boolean {
  const mine = can(ctx.user, row.application_id);
  if (row.visibility === "unlisted") return mine;
  return mine || liveEnvironments(ctx, row.id).length > 0;
}

/**
 * The same ceiling as `rank`, and the same reason for reporting it separately: a facet count over a
 * truncated estate is a wrong number, and a wrong number nobody flags is worse than a missing one.
 */
function visibleResources(ctx: Ctx): { rows: ResourceRow[]; ceilingHit: boolean } {
  const all = ctx.app.db
    .query<ResourceRow, [number]>("SELECT * FROM resource ORDER BY name LIMIT ?")
    .all(RANK_CEILING);
  return { rows: all.filter((row) => isVisible(ctx, row)), ceilingHit: all.length >= RANK_CEILING };
}

function liveEnvironments(ctx: Ctx, resourceId: string): string[] {
  return ctx.app.db
    .query<{ environment: string }, [string]>(
      "SELECT DISTINCT environment FROM release WHERE resource_id = ? AND state = 'converged'",
    )
    .all(resourceId)
    .map((entry) => entry.environment);
}

// --------------------------------------------------------------------------- projections

function cardFor(ctx: Ctx, row: ResourceRow) {
  const model = latestModel(ctx, row.id);
  const environments = liveEnvironments(ctx, row.id);
  const products = ctx.app.db
    .query<{ id: string; name: string; lifecycle: string; summary: string | null }, [string]>(
      `SELECT p.id, p.name, p.lifecycle, p.summary FROM product_member pm
         JOIN product p ON p.id = pm.product_id
        WHERE pm.resource_id = ?`,
    )
    .all(row.id);
  const subscribers = ctx.app.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(DISTINCT s.application_id) AS n FROM subscription s
         JOIN product_member pm ON pm.product_id = s.product_id
        WHERE pm.resource_id = ? AND s.state = 'active'`,
    )
    .get(row.id);
  // "Do I already have a key for this" — asked of the caller's own applications, so the answer is about
  // them rather than about the estate. Placeholders are generated from the application count, never
  // interpolated values.
  const mineApplications = ctx.user?.applications ?? [];
  const subscribed =
    mineApplications.length === 0
      ? 0
      : (ctx.app.db
          .query<{ n: number }, string[]>(
            `SELECT COUNT(*) AS n FROM subscription s
               JOIN product_member pm ON pm.product_id = s.product_id
               JOIN application a ON a.id = s.application_id
              WHERE pm.resource_id = ? AND s.state = 'active'
                AND a.id IN (${mineApplications.map(() => "?").join(", ")})`,
          )
          .get(row.id, ...mineApplications)?.n ?? 0);

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    title: model?.title ?? row.name,
    apiVersion: row.api_version,
    icon: row.icon,
    summary: row.summary ?? firstSentence(model?.description) ?? null,
    tags: tagsFor(ctx, row.id),
    // The taxonomy, so a card can be filed under its domain without a second request. `null` for a
    // row published before domains existed — the catalog files those under "Other" rather than
    // dropping them, because a catalog that hides what it cannot classify is not an inventory.
    domain: row.domain,
    subdomain: row.subdomain,
    applicationId: row.application_id,
    lifecycle: row.lifecycle,
    visibility: row.visibility,
    environments,
    /** True when the caller can see this only because they own it. The card badges it. */
    unpublished: environments.length === 0,
    operationCount: countFor(row.kind, model),
    subscriberCount: subscribers?.n ?? 0,
    subscribed: subscribed > 0,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      lifecycle: product.lifecycle,
      summary: product.summary,
    })),
    updatedAt: row.updated_at,
  };
}

/** The effective tag set: the owner's tags plus whatever the contract implied (A2A skill tags). */
function tagsFor(ctx: Ctx, resourceId: string): string[] {
  const row = ctx.app.db
    .query<{ tags: string }, [string]>("SELECT tags FROM resource_fts WHERE resource_id = ?")
    .get(resourceId);
  if (!row?.tags) return [];
  return [...new Set(row.tags.split(/\s+/).filter(Boolean))];
}

function countFor(kind: string, model: ApiModel | null): number {
  if (!model) return 0;
  if (kind === "mcp") return model.mcp?.tools.length ?? 0;
  if (kind === "a2a") return model.a2a?.skills.length ?? 0;
  return model.operations.length;
}

/** What the Operations tab renders — one shape per variant, because they are different things. */
function operationsView(kind: string, model: ApiModel | null) {
  if (!model) return [];
  if (kind === "mcp") {
    return (model.mcp?.tools ?? []).map((tool) => ({
      id: `tools/call:${tool.name}`,
      name: tool.name,
      title: tool.title ?? tool.name,
      summary: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
    }));
  }
  if (kind === "a2a") {
    return (model.a2a?.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      title: skill.name,
      summary: skill.description ?? null,
      tags: skill.tags,
      examples: skill.examples ?? [],
    }));
  }
  return model.operations.map((operation) => ({
    id: operation.operationId,
    name: operation.operationId,
    method: operation.method,
    path: operation.path,
    summary: operation.summary ?? null,
    ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
  }));
}

/**
 * A call somebody can paste. Built from the live route and the key header the effective policy
 * actually requires — an example carrying the wrong header name is worse than no example, because
 * it fails in a way that looks like the platform is broken.
 */
function exampleFor(
  ctx: Ctx,
  row: ResourceRow,
  model: ApiModel | null,
  routes: Array<{ environment: string; host: string; base_path: string }>,
) {
  const live = liveEnvironments(ctx, row.id);
  const route = routes.find((entry) => live.includes(entry.environment)) ?? routes[0];
  if (!route) return null;
  const host = route.host === "*" ? "<gateway-host>" : route.host;
  const base = `https://${host}${route.base_path === "/" ? "" : route.base_path}`;

  const keyUnit = ctx.app.db
    .query<{ value_json: string }, [string, string]>(
      `SELECT value_json FROM policy_entry
        WHERE resource_id = ? AND environment = ? AND unit_key = 'auth.subscriptionKey'`,
    )
    .get(row.id, route.environment);
  const key = keyUnit ? (JSON.parse(keyUnit.value_json) as { in: string; name: string }) : null;
  const auth = key
    ? key.in === "header"
      ? `-H '${key.name}: $SUBSCRIPTION_KEY'`
      : ""
    : "";
  const query = key && key.in === "query" ? `?${key.name}=$SUBSCRIPTION_KEY` : "";

  if (row.kind === "mcp") {
    const tool = model?.mcp?.tools[0];
    const body = tool
      ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: {} } }
      : { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    return {
      environment: route.environment,
      language: "bash",
      text: `curl -X POST '${base}${query}' ${auth} -H 'content-type: application/json' \\\n  -d '${JSON.stringify(body)}'`.trim(),
    };
  }
  if (row.kind === "a2a") {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", kind: "message", parts: [{ kind: "text", text: "hello" }] } },
    };
    return {
      environment: route.environment,
      language: "bash",
      text:
        `# The agent card, rewritten to this gateway:\n` +
        `curl '${base}/.well-known/agent-card.json'\n\n` +
        `curl -X POST '${base}${query}' ${auth} -H 'content-type: application/json' \\\n  -d '${JSON.stringify(body)}'`.trim(),
    };
  }
  if (row.kind === "soap") {
    return {
      environment: route.environment,
      language: "bash",
      text: `curl -X POST '${base}${query}' ${auth} -H 'content-type: text/xml; charset=utf-8' \\\n  --data-binary @request.xml`.trim(),
    };
  }
  /*
   * Which operation to show. The card above this promises it "works as pasted once you substitute
   * the key", so the choice matters: the *first* operation in the document is whichever one its
   * author happened to write first, and for the petstore that is `POST /pet` — a call that cannot
   * work as pasted, because blocking validation will refuse an empty body. So: prefer a GET with
   * no path parameters, then any GET, then whatever there is, and say what still has to be filled
   * in rather than pretending nothing does.
   */
  const operations = model?.operations ?? [];
  const templated = (operation: ApiOperation) => /\{[^}]+\}/.test(operation.path);
  const first =
    operations.find((operation) => operation.method.toUpperCase() === "GET" && !templated(operation)) ??
    operations.find((operation) => operation.method.toUpperCase() === "GET") ??
    operations[0];
  if (!first) {
    return {
      environment: route.environment,
      language: "bash",
      text: `curl '${base}/${query}' ${auth}`.trim(),
    };
  }

  const method = first.method.toUpperCase();
  const lines: string[] = [];
  // Path parameters are left as the contract writes them, and pointed at — a curl carrying a
  // literal `{petId}` looks copy-pasteable and 404s.
  if (templated(first)) lines.push(`# Substitute the path parameters in braces:`);
  const body = first.requestBody;
  if (body) {
    lines.push(
      `curl -X ${method} '${base}${first.path}${query}' ${auth} -H 'content-type: application/json' \\`.trim(),
    );
    // No invented body: the schema is on the Operations tab, and a made-up one that failed
    // validation would be worse than an honest placeholder.
    lines.push(`  -d @${first.operationId}.json   # the ${body.required ? "required" : "optional"} request body`);
  } else {
    lines.push(`curl -X ${method} '${base}${first.path}${query}' ${auth}`.trim());
  }
  return { environment: route.environment, language: "bash", text: lines.join("\n") };
}

/** The sparkline the telemetry rollup already has: requests per window, oldest first. */
function trafficFor(ctx: Ctx, resourceId: string) {
  return ctx.app.db
    .query<{ window_start: string; n: number }, [string]>(
      `SELECT window_start, SUM(count) AS n FROM telemetry_rollup
        WHERE resource_id = ? GROUP BY window_start ORDER BY window_start DESC LIMIT 60`,
    )
    .all(resourceId)
    .reverse()
    .map((entry) => ({ windowStart: entry.window_start, requests: entry.n }));
}

function latestModel(ctx: Ctx, resourceId: string): ApiModel | null {
  const row = ctx.app.db
    .query<{ model: string }, [string]>(
      "SELECT model FROM revision WHERE resource_id = ? ORDER BY rev DESC LIMIT 1",
    )
    .get(resourceId);
  if (!row) return null;
  try {
    return JSON.parse(row.model) as ApiModel;
  } catch {
    return null;
  }
}

function firstSentence(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
}

function counted(map: Record<string, number>) {
  return Object.entries(map)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

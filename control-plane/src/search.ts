import type { ApiModel } from "../../shared/types.ts";
import type { DB } from "./db.ts";

/**
 * The catalog's index (goal G6, plan section 11.1).
 *
 * One FTS5 row per resource, rebuilt at every write that could change what it contains. Not an
 * external-content table and not trigger-maintained, for one reason: half of what a consumer
 * searches for — operation ids, tool names, skill descriptions — lives inside `revision.model` as
 * JSON, which SQL triggers cannot read `[R2-10]`. So the projection is maintained here, in the one
 * place that already knows when a revision, a release or a resource's metadata changed.
 *
 * Two things are deliberate:
 *
 *  - **Rebuild, never patch.** `reindex` deletes and re-inserts one resource's row. An incremental
 *    update would have to know which of six inputs changed, and the cost of getting that wrong is a
 *    stale search result nobody can explain.
 *  - **The user's words are never FTS5 syntax.** A query is escaped and rebuilt as a quoted-plus-
 *    prefix expression, so `pet*` searches for the string rather than being interpreted, and a
 *    stray `"` or `NEAR(` cannot reach the parser `[R1-18]`.
 */

/** Plan section 11.1's weights: a name match beats a description match by design. */
const WEIGHTS = { name: 8, title: 6, tags: 4, summary: 3, description: 2, operations: 1 } as const;

export interface IndexRow {
  resourceId: string;
  name: string;
  title: string;
  summary: string;
  description: string;
  tags: string;
  operations: string;
}

interface ResourceIndexInput {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  tags_json: string;
  model: string | null;
}

/**
 * What a consumer might type to find this resource. Operation *ids* and paths as well as prose,
 * because "the API with the addPet tool" is how people actually search — and MCP tools and A2A
 * skills are the only names those variants have.
 */
export function indexRowFor(input: ResourceIndexInput): IndexRow {
  const model = parseModel(input.model);
  const words: string[] = [];

  for (const operation of model?.operations ?? []) {
    words.push(operation.operationId);
    if (operation.path && operation.path !== "/") words.push(operation.path);
    if (operation.summary) words.push(operation.summary);
    if (operation.selector && operation.selector !== operation.operationId) {
      words.push(operation.selector);
    }
  }
  for (const tool of model?.mcp?.tools ?? []) {
    words.push(tool.name);
    if (tool.title) words.push(tool.title);
    if (tool.description) words.push(tool.description);
  }
  for (const skill of model?.a2a?.skills ?? []) {
    words.push(skill.name);
    if (skill.description) words.push(skill.description);
    words.push(...skill.tags);
  }

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(input.tags_json || "[]") as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    // A malformed tags column is a resource with no tags, not a failed reindex.
  }
  // A2A skill tags are catalog facets too (plan section 10.1), so they join the tag column rather
  // than only the operation text — a facet nobody can filter by is not a facet.
  for (const skill of model?.a2a?.skills ?? []) tags.push(...skill.tags);

  return {
    resourceId: input.id,
    name: input.name,
    title: model?.title ?? input.name,
    summary: input.summary ?? "",
    description: input.description ?? model?.description ?? "",
    tags: [...new Set(tags)].join(" "),
    operations: words.join(" "),
  };
}

/** Re-projects one resource. Cheap enough to call from every write that touches it. */
export function reindexResource(db: DB, resourceId: string): void {
  const row = db
    .query<ResourceIndexInput, [string]>(
      `SELECT r.id, r.name, r.summary, r.description, r.tags_json,
              (SELECT rev.model FROM revision rev WHERE rev.resource_id = r.id
                ORDER BY rev.rev DESC LIMIT 1) AS model
         FROM resource r WHERE r.id = ?`,
    )
    .get(resourceId);

  db.run("DELETE FROM resource_fts WHERE resource_id = ?", [resourceId]);
  if (!row) return;
  const index = indexRowFor(row);
  db.run(
    `INSERT INTO resource_fts (resource_id, name, title, summary, description, tags, operations)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      index.resourceId,
      index.name,
      index.title,
      index.summary,
      index.description,
      index.tags,
      index.operations,
    ],
  );
}

/** Rebuilds the whole index. Used by the migration and by `bun run seed`. */
export function reindexAll(db: DB): number {
  const rows = db.query<{ id: string }, []>("SELECT id FROM resource").all();
  const write = db.transaction(() => {
    db.run("DELETE FROM resource_fts");
    for (const row of rows) reindexResource(db, row.id);
  });
  write();
  return rows.length;
}

/**
 * A user's words as an FTS5 MATCH expression, with none of their punctuation surviving.
 *
 * `pet inv` becomes `("pet" OR pet*) AND ("inv" OR inv*)`: every term must appear, but each may
 * match as a whole word or as a prefix, so search-as-you-type finds `inventory` from `inv`. The
 * quoting is what makes injection impossible — inside a double-quoted FTS5 string the only
 * special character is `"`, which is doubled.
 */
export function matchExpression(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms
    .map((term) => {
      const quoted = `"${term.replace(/"/g, '""')}"`;
      // The prefix form is unquoted by necessity, so it is built from the sanitised term only.
      return term.length >= 2 ? `(${quoted} OR ${term}*)` : quoted;
    })
    .join(" AND ");
}

/** The `bm25()` call for `ORDER BY`, with plan section 11.1's column weights. */
export function bm25Expression(): string {
  return (
    `bm25(resource_fts, 0.0, ${WEIGHTS.name}.0, ${WEIGHTS.title}.0, ${WEIGHTS.summary}.0, ` +
    `${WEIGHTS.description}.0, ${WEIGHTS.tags}.0, ${WEIGHTS.operations}.0)`
  );
}

function parseModel(raw: string | null): ApiModel | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ApiModel;
  } catch {
    return null;
  }
}

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../control-plane/src/db.ts";
import { CONFIG_VERSION } from "../shared/config-doc.ts";
import { makeCp, makeDp, poll, serveCp } from "./helpers.ts";

/**
 * Migration 2 rebuilds `resource`, which is the one migration that can destroy the database:
 * `openDb` sets `PRAGMA foreign_keys = ON`, SQLite ignores that pragma inside a transaction, and
 * with foreign keys on `DROP TABLE resource` deletes its rows first — cascading through every
 * revision, policy, route, binding, release and applied row (review V1-02).
 *
 * The fixture is a real v1 database captured from a running system, not a synthetic one.
 */
const FIXTURE = "test/fixtures/v1-seeded.sqlite";
const CHILD_TABLES = [
  "revision",
  "policy_entry",
  "route",
  "binding",
  "release",
  "applied",
  "product_member",
  "subscription",
  "audit",
];

function counts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ["resource", ...CHILD_TABLES]) {
    out[table] = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

describe("migrations", () => {
  test("upgrades a seeded v1 database with every child row intact", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);

    const before = new Database(path);
    const beforeCounts = counts(before);
    expect(beforeCounts.resource).toBeGreaterThan(0);
    expect(beforeCounts.revision).toBeGreaterThan(0);
    before.close();

    const db = openDb(path);
    try {
      expect(counts(db)).toEqual(beforeCounts);

      const versions = db
        .query("SELECT version FROM schema_version ORDER BY version")
        .all() as Array<{ version: number }>;
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);

      // v3 adds tables and columns but rebuilds nothing, so every v2 row is still where it was.
      for (const table of ["artifact", "global_policy_entry", "certificate", "tls_exception", "usage_counter"]) {
        expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      const resourceColumns = (db.query("PRAGMA table_info(resource)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      for (const column of ["summary", "tags_json", "visibility", "discovery_url"]) {
        expect(resourceColumns).toContain(column);
      }
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'resource_fts'").get(),
      ).toEqual({ name: "resource_fts" });

      const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'resource'").get() as { sql: string })
        .sql;
      expect(sql).toContain("UNIQUE (team_id, name, api_version)");

      // The rebuild must not have taken the audit triggers with it.
      const triggers = db
        .query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(triggers.map((t) => t.name)).toContain("audit_no_update");
      expect(triggers.map((t) => t.name)).toContain("release_state_history");

      expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
      // Foreign keys are back on after a migration that turned them off.
      expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The v3 migration ends by rebuilding the whole search index, and that call is the difference
   * between an upgraded installation whose Catalog works and one whose Catalog is empty until
   * somebody happens to edit every API. Nothing else would notice: the tables exist, the API
   * answers, and the answer is `[]`.
   */
  test("upgrading backfills the catalog index for APIs that already existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);
    const db = openDb(path);
    try {
      const resources = (db.query("SELECT COUNT(*) AS n FROM resource").get() as { n: number }).n;
      const indexed = (db.query("SELECT COUNT(*) AS n FROM resource_fts").get() as { n: number }).n;
      expect(indexed).toBe(resources);

      // And it is a real index, not a row of empty columns: the fixture's petstore is findable by
      // an operation id that only exists inside `revision.model`.
      const hit = db
        .query<{ resource_id: string }, [string]>(
          "SELECT resource_id FROM resource_fts WHERE resource_fts MATCH ? LIMIT 1",
        )
        .get('"petstore"');
      expect(hit).not.toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The new columns have to arrive with values, not nulls. `visibility` is the one that matters:
   * it is not presentation — it decides whether an A2A card is served publicly — so a NULL there
   * would be a resource that is neither listed nor unlisted.
   */
  test("the new resource columns get defaults rather than nulls", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);
    const db = openDb(path);
    try {
      const rows = db
        .query<{ visibility: string; tags_json: string; summary: string | null }, []>(
          "SELECT visibility, tags_json, summary FROM resource",
        )
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.visibility).toBe("listed");
        expect(JSON.parse(row.tags_json)).toEqual([]);
        // Marketing metadata nobody has written yet is null, which the UI renders as "no summary".
        expect(row.summary).toBeNull();
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * v4 adds two tables and three columns and rebuilds nothing. The columns are the ones worth
   * asserting: `pruned_at` NULL is what says "this revision still has its content", and `source`
   * has to arrive with a value rather than a null, because the revision list reads it for every
   * row and "unknown provenance" is not one of the answers it can render.
   */
  test("upgrading to v4 adds the trust store, playground history and revision provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);
    const db = openDb(path);
    try {
      for (const table of ["trust_anchor", "playground_call"]) {
        expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      const revisionColumns = (db.query("PRAGMA table_info(revision)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      for (const column of ["pruned_at", "source", "source_detail"]) {
        expect(revisionColumns).toContain(column);
      }

      const rows = db
        .query<{ pruned_at: string | null; source: string; source_detail: string | null }, []>(
          "SELECT pruned_at, source, source_detail FROM revision",
        )
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.pruned_at).toBeNull();
        expect(row.source).toBe("upload");
        expect(row.source_detail).toBeNull();
      }

      // The live-anchor index is partial, so registering a CA again after removing it is allowed
      // while a live duplicate is not (review [P1-06]). That is a property of the index, so it is
      // asserted against the index rather than against the endpoint that relies on it.
      const indexSql = (
        db
          .query("SELECT sql FROM sqlite_master WHERE name = 'trust_anchor_live_unique'")
          .get() as { sql: string }
      ).sql;
      expect(indexSql).toContain("WHERE removed_at IS NULL");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * v5 introduces the directory, and the only part of it that can go wrong quietly is the
   * backfill. Every `membership.user_id`, `revision.created_by` and `release.released_by` in a v4
   * database is a bare id that nothing described; if migration 5 does not turn each of them into a
   * principal, the upgraded portal comes up with memberships pointing at people who do not exist —
   * and the first symptom is an owner's API becoming unreachable to them, not an error.
   */
  test("upgrading to v5 backfills a principal for everybody the database already knew", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);
    const db = openDb(path);
    try {
      const members = db
        .query<{ user_id: string }, []>("SELECT DISTINCT user_id FROM membership")
        .all()
        .map((row) => row.user_id);
      expect(members.length).toBeGreaterThan(0);

      // Not "some principals exist" — every id the fixture used, with its own id preserved, because
      // that id is also what `revision.created_by` says.
      for (const id of members) {
        const row = db
          .query<{ provider: string; role: string; created_by: string }, [string]>(
            "SELECT provider, role, created_by FROM principal WHERE id = ?",
          )
          .get(id);
        expect(row).not.toBeNull();
        expect(row!.provider).toBe("dev");
        // The migration does not guess at authority. Whoever was an admin becomes one again through
        // the dev directory's own upsert at boot, not through a migration inventing a role.
        expect(row!.role).toBe("member");
        expect(row!.created_by).toBe("migration-005");
      }

      // The provenance columns arrive with values. A NULL `source` would be a membership the claim
      // sync could not decide whether to delete.
      const sources = db
        .query<{ source: string | null }, []>("SELECT source FROM membership")
        .all();
      expect(sources.length).toBeGreaterThan(0);
      for (const row of sources) expect(row.source).toBe("local");

      // Local usernames are unique; OIDC ones are the identity provider's business (`[P1-12]`).
      const indexSql = (
        db
          .query("SELECT sql FROM sqlite_master WHERE name = 'principal_local_username'")
          .get() as { sql: string }
      ).sql;
      expect(indexSql).toContain("WHERE provider = 'local'");

      expect(db.query("SELECT COUNT(*) AS n FROM auth_flow").get()).toEqual({ n: 0 });

      const sessionColumns = (db.query("PRAGMA table_info(session)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      for (const column of ["provider", "refresh_token_enc", "claims_refreshed_at", "last_seen_at"]) {
        expect(sessionColumns).toContain(column);
      }

      // Additive, so the v1 hazard cannot have recurred: every row still points at something.
      expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("running twice is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "v1.sqlite");
    copyFileSync(FIXTURE, path);
    const first = openDb(path);
    const after = counts(first);
    first.close();

    const second = openDb(path);
    try {
      expect(counts(second)).toEqual(after);
      expect(
        (second.query("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n,
      ).toBe(5);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release cannot reach superseded or withdrawn except from converged", () => {
    const dir = mkdtempSync(join(tmpdir(), "apim-migrate-"));
    const path = join(dir, "fresh.sqlite");
    const db = openDb(path);
    try {
      db.run("INSERT INTO team (id, name) VALUES ('t', 'T')");
      db.run(
        "INSERT INTO resource (id, kind, name, team_id, created_at, updated_at) VALUES ('r','rest','n','t','x','x')",
      );
      db.run(
        `INSERT INTO revision (id, resource_id, rev, model, original, original_format, version_digest,
                               created_by, created_at)
         VALUES ('rv','r',1,'{}','{}','openapi-3.1','d','me','x')`,
      );
      db.run(
        `INSERT INTO release (id, resource_id, revision_id, environment, state, version_digest,
                              released_by, released_at)
         VALUES ('rel','r','rv','dev','pending','d','me','x')`,
      );

      // The promotion gate reads history, so history has to survive (review V2-02).
      expect(() =>
        db.run("UPDATE release SET state = 'withdrawn' WHERE id = 'rel'"),
      ).toThrow(/only from converged/);

      db.run("UPDATE release SET state = 'converged' WHERE id = 'rel'");
      db.run("UPDATE release SET state = 'superseded' WHERE id = 'rel'");
      expect(
        (db.query("SELECT state FROM release WHERE id = 'rel'").get() as { state: string }).state,
      ).toBe("superseded");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The wire contract's version skew (plan §10). Both halves are asserted, because each is useless
 * alone: a control plane that refuses an old instance without recording why leaves a gateway that
 * is still serving stale config looking merely slow, and an instance that notices the refusal but
 * stops serving would turn a version skew into an outage.
 */
describe("wire version 4", () => {
  test("the config document carries an empty trust store until an anchor is registered", async () => {
    const cp = makeCp();
    try {
      const { config } = await poll(cp);
      expect(config?.configVersion).toBe(CONFIG_VERSION);
      expect(config?.trustAnchors).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test("an older instance is refused with both versions named, and the refusal is recorded", async () => {
    const cp = makeCp();
    try {
      const { response } = await poll(cp, { wireVersion: CONFIG_VERSION - 1 });
      expect(response.status).toBe(400);
      const problem = (await response.json()) as {
        detail: string;
        expected: number;
        received: number;
      };
      // Both numbers, as machine-readable members rather than only inside the prose: the instance
      // reads them to tell a version skew from any other 400.
      expect(problem.expected).toBe(CONFIG_VERSION);
      expect(problem.received).toBe(CONFIG_VERSION - 1);
      expect(problem.detail).toContain(String(CONFIG_VERSION));

      // The instance cannot report its own block — every poll it makes is refused — so the
      // control plane wrote it down when it saw one.
      const row = cp.app.db
        .query<{ process_json: string | null }, []>("SELECT process_json FROM gateway_instance")
        .get();
      const process = JSON.parse(row?.process_json ?? "{}") as { activationBlocked?: string };
      expect(process.activationBlocked).toContain("wire version");
      expect(process.activationBlocked).toContain(String(CONFIG_VERSION));
    } finally {
      cp.close();
    }
  });

  test("a gateway speaking the previous version keeps serving and says why", async () => {
    const cp = makeCp();
    const served = serveCp(cp);
    const dp = makeDp(served.url, cp.token, cp.dir, { wireVersion: CONFIG_VERSION - 1 });
    try {
      expect(await dp.client.pollOnce()).toBe("blocked");
      // Not "error": nothing this instance does will make the next poll succeed, and the fleet
      // view has to be able to say that rather than showing a transient failure.
      expect(dp.client.activationBlocked).toContain("wire version");
      expect(dp.client.activationBlocked).toContain("keeps serving");
      expect(dp.health().activationBlocked).toBe(dp.client.activationBlocked);
      // It has nothing to serve here, and it did not throw trying: an old build stays up.
      expect(dp.client.table).toBeNull();
      expect(dp.client.decommissioned).toBe(false);
    } finally {
      dp.stop();
      served.stop();
      cp.close();
    }
  });
});

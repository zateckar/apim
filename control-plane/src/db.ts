import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { reindexAll } from "./search.ts";

export type DB = Database;

/**
 * Numbered migrations run at boot, tracked in `schema_version` (design section 13). SQLite's
 * ALTER TABLE is limited, so every change is a new numbered step rather than an edit.
 *
 * `foreignKeysOff` marks a migration that rebuilds a table. It is not cosmetic: `openDb` sets
 * `PRAGMA foreign_keys = ON`, SQLite *silently ignores* that pragma inside a transaction, and
 * with foreign keys on `DROP TABLE resource` deletes its rows first — cascading through every
 * revision, policy, route, binding, release and applied row in the database. The pragma
 * therefore has to be toggled outside the transaction, by the runner, and `foreign_key_check`
 * has to be read rather than merely executed (review V1-02, V2-04).
 */
interface Migration {
  version: number;
  name: string;
  file: string;
  foreignKeysOff?: boolean;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial", file: "schema.sql" },
  { version: 2, name: "v2", file: "schema-002.sql", foreignKeysOff: true },
  { version: 3, name: "v3", file: "schema-003.sql" },
  { version: 4, name: "v4", file: "schema-004.sql" },
  { version: 5, name: "v5", file: "schema-005.sql" },
  { version: 6, name: "application ownership and workflows", file: "schema-006.sql", foreignKeysOff: true },
  {
    version: 7,
    name: "dev application ids, domains, gateway hostnames",
    file: "schema-007.sql",
    // It rewrites primary keys and every column that references them, so the constraint is off
    // while it runs and `foreign_key_check` decides afterwards whether it succeeded.
    foreignKeysOff: true,
  },
  {
    version: 8,
    name: "an environment has gateways, plural",
    file: "schema-008.sql",
    // Rebuilds `target`, which `gateway_instance` and `applied` reference.
    foreignKeysOff: true,
  },
  { version: 9, name: "a subscription's two keys have two ages", file: "schema-009.sql" },
];

/**
 * The migrations live in `control-plane/migrations/`, beside the code that runs them but not
 * *among* it: they are data this module reads at boot, not modules anything imports, and mixing
 * them into `src/` made the one directory somebody greps for a function also the directory that
 * answers for the schema's history.
 */
function sqlFor(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), "utf8");
}

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const hasVersions = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  const current = hasVersions
    ? (db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_version").get()?.v ?? 0)
    : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      db.exec(sqlFor(migration.file));
      if (migration.foreignKeysOff) {
        // `query` rather than `prepare`: a prepared statement that is never finalized keeps the
        // database file open, which on Windows makes the file undeletable afterwards.
        const violations = db.query("PRAGMA foreign_key_check").all() as Array<{
          table: string;
          rowid: number;
          parent: string;
        }>;
        if (violations.length > 0) {
          const first = violations[0]!;
          throw new Error(
            `migration ${migration.version} (${migration.name}) left ${violations.length} ` +
              `foreign key violation(s), first in ${first.table} rowid ${first.rowid} ` +
              `referencing ${first.parent}; rolling back`,
          );
        }
      }
      db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [
        migration.version,
        new Date().toISOString(),
      ]);
    });

    if (!migration.foreignKeysOff) {
      apply();
      continue;
    }
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      apply();
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  // The catalog's index is a projection over data the migrations only moved, and SQL cannot build
  // it: what it indexes includes operation ids inside `revision.model` as JSON `[R2-10]`. So it is
  // built here, after the schema is current, and an upgraded database arrives searchable rather
  // than empty until somebody happens to edit every resource.
  if (current < 3) reindexAll(db);
}

export function nowIso(): string {
  return new Date().toISOString();
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `res_k3f9…` — readable in logs, no collision handling needed at this scale. */
export function newId(prefix: string): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyVecMigration, loadVec } from "../embed/vec.js";
import { createStore, type Store } from "./repo.js";
import { SCHEMA_V1, SCHEMA_V4, SCHEMA_V5 } from "./schema.js";

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Database schema version ${found} is newer than supported version ${supported}`);
    this.name = "SchemaTooNewError";
  }
}

interface Migration {
  version: number;
  apply(db: Database.Database): void;
}

/** Numbered, ordered migrations. v1 is the base schema; later versions append here. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply(db) {
      db.exec(SCHEMA_V1);
    },
  },
  {
    // vec_descriptions and vec_code for the M0 embedding model (spec section 9). A no-op when
    // sqlite-vec cannot be loaded; `ensureVecTables` creates the tables later where it can.
    version: 2,
    apply(db) {
      applyVecMigration(db);
    },
  },
  {
    // files.directives: JSON array of leading directive strings ("use client"), NULL on older rows (spec section 9).
    version: 3,
    apply(db) {
      // Idempotent: a database whose schema_version was reset already has the column.
      const cols = db.prepare("PRAGMA table_info(files)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "directives")) db.exec("ALTER TABLE files ADD COLUMN directives TEXT");
    },
  },
  {
    // adapter_nodes: generic nodes from framework adapters, with the same per-file layer rules as symbols (spec section 9).
    version: 4,
    apply(db) {
      db.exec(SCHEMA_V4);
    },
  },
  {
    // symbols.near_minhash (near tier, #131) and pending_files (the hook's batch of edits, #131). Forgetting head_sha
    // makes the next heal a full main re-index, which fills near_minhash for every symbol (spec section 9).
    version: 5,
    apply(db) {
      const cols = db.prepare("PRAGMA table_info(symbols)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "near_minhash"))
        db.exec("ALTER TABLE symbols ADD COLUMN near_minhash BLOB");
      db.exec(SCHEMA_V5);
      // A pending_files table from a pre-release build of v5 lacks this column.
      const pcols = db.prepare("PRAGMA table_info(pending_files)").all() as { name: string }[];
      if (!pcols.some((c) => c.name === "reindexed"))
        db.exec("ALTER TABLE pending_files ADD COLUMN reindexed INTEGER NOT NULL DEFAULT 0");
      db.exec("DELETE FROM meta WHERE key = 'head_sha'");
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function currentVersion(db: Database.Database): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const r = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return r ? Number(r.value) : 0;
}

function migrate(db: Database.Database): void {
  // Checked inside BEGIN IMMEDIATE so concurrent first-time openers serialise.
  db.transaction(() => {
    const current = currentVersion(db);
    if (current > LATEST_SCHEMA_VERSION) throw new SchemaTooNewError(current, LATEST_SCHEMA_VERSION);
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      m.apply(db);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
    }
  }).immediate();
}

/**
 * A pending_files table written by a pre-release build of migration v5 lacks `reindexed`; the migration does not run
 * again on such a database, so the column is added here, on open (#131). A read only when it is already there.
 */
function ensurePendingReindexed(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(pending_files)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "reindexed"))
    db.exec("ALTER TABLE pending_files ADD COLUMN reindexed INTEGER NOT NULL DEFAULT 0");
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    const vec = loadVec(db); // fail open: without sqlite-vec everything but vector search still works
    migrate(db);
    ensurePendingReindexed(db);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('vec_available', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(vec ? "1" : "0");
  } catch (err) {
    db.close();
    throw err;
  }
  return createStore(db);
}

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

/** Splits camelCase, PascalCase, snake_case and digits into lowercase words. */
export function splitIdentifier(id: string): string[] {
  return (id.match(WORD) ?? []).map((w) => w.toLowerCase());
}

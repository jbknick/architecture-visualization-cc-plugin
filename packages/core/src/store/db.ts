import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { createVecTables, loadVec } from "../embed/vec.js";
import { attachOverlay } from "./overlay.js";
import { createStore, type Store } from "./repo.js";
import { SCHEMA } from "./schema.js";

/**
 * The one store schema version (spec section 9). There are no numbered migrations: a store whose `meta.schema_version`
 * is not this number is deleted and rebuilt from scratch by the next non-hook command (`resetStaleStore`). Any change
 * that makes a full re-index necessary bumps it: a schema change, or a change to what indexing writes for unchanged
 * files (the extractor, an adapter or the resolver), because incremental indexing only rewrites changed files.
 */
export const SCHEMA_VERSION = 13;

/** The store was built by a different version of Gantry (older, or newer) than this one. */
export class StaleStoreError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number,
    readonly dbPath: string,
  ) {
    super(
      `The index at ${dbPath} was built by a different version of Gantry (schema ${found}, now ${expected}); a non-hook command rebuilds it`,
    );
    this.name = "StaleStoreError";
  }
}

/** The `meta.schema_version` of an open database; undefined when it has no `meta` table (a new file). */
function storedVersion(db: Database.Database): number | undefined {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return undefined;
  const r = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const n = r ? Number(r.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** The `schema_version` stored in `dbPath`; undefined when the file is missing or has no `meta` table. */
export function readSchemaVersion(dbPath: string): number | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    return storedVersion(db);
  } finally {
    db.close();
  }
}

/** A `meta` value of the store in `dbPath`; undefined when the file, the `meta` table or the key is missing. */
export function readMeta(dbPath: string, key: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const row =
      storedVersion(db) === undefined
        ? undefined
        : db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return (row as { value: string } | undefined)?.value;
  } finally {
    db.close();
  }
}

function initOrCheck(db: Database.Database, dbPath: string, vec: boolean): void {
  // Checked inside BEGIN IMMEDIATE so concurrent first-time openers serialise.
  db.transaction(() => {
    const found = storedVersion(db);
    if (found === undefined) {
      db.exec(SCHEMA);
      if (vec) createVecTables(db);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (found !== SCHEMA_VERSION) {
      throw new StaleStoreError(found, SCHEMA_VERSION, dbPath);
    }
  }).immediate();
}

/**
 * Opens (creating) the store at `dbPath` and attaches the overlay (`overlay.db`, see `overlay.ts`) as `overlay`.
 * The overlay defaults to `overlay.db` beside `dbPath`; callers that have `GantryPaths` pass `paths.overlayPath`.
 * `repo` is the repo the caller works in (`paths.repo`): `store.repo()` answers it, which a store of several repos
 * cannot know on its own.
 */
export function openStore(dbPath: string, opts: { overlayPath?: string; repo?: string } = {}): Store {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    const vec = loadVec(db); // fail open: without sqlite-vec everything but vector search still works
    initOrCheck(db, dbPath, vec);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('vec_available', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(vec ? "1" : "0");
    const overlay =
      opts.overlayPath ?? (dbPath === ":memory:" ? ":memory:" : join(dirname(dbPath), "overlay.db"));
    attachOverlay(db, overlay);
  } catch (err) {
    db.close();
    throw err;
  }
  return createStore(db, opts.repo);
}

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

/** Splits camelCase, PascalCase, snake_case and digits into lowercase words. */
export function splitIdentifier(id: string): string[] {
  return (id.match(WORD) ?? []).map((w) => w.toLowerCase());
}

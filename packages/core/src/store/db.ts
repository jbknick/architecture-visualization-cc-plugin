import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { createStore, type Store } from "./repo.js";
import { SCHEMA_V1 } from "./schema.js";

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

export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
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

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ParsedFile } from "./index.js";

/**
 * Bump when `parseSource` output changes for the same input (new fields, different symbol ids, ...):
 * every cached entry written under another version is dropped on open.
 */
export const PARSE_CACHE_VERSION = 2;

export const PARSE_CACHE_FILE = "parse-cache.db";

interface Wire extends Omit<ParsedFile, "bodies"> {
  bodies: [string, { start: number; end: number }][];
}

export function encodeParsed(pf: ParsedFile): string {
  const wire: Wire = { ...pf, bodies: [...pf.bodies] };
  return JSON.stringify(wire);
}

export function decodeParsed(data: string): ParsedFile {
  const wire = JSON.parse(data) as Wire;
  return { ...wire, bodies: new Map(wire.bodies) };
}

/** A `ParsedFile` map that decodes cached entries on first `get`, so unread files cost nothing. */
export class LazyParsedMap extends Map<string, ParsedFile> {
  private readonly raw = new Map<string, string>();

  setRaw(fileId: string, data: string): void {
    this.raw.set(fileId, data);
  }

  override has(key: string): boolean {
    return super.has(key) || this.raw.has(key);
  }

  override get(key: string): ParsedFile | undefined {
    let v = super.get(key);
    if (v === undefined) {
      const data = this.raw.get(key);
      if (data === undefined) return undefined;
      v = decodeParsed(data);
      this.raw.delete(key);
      super.set(key, v);
    }
    return v;
  }
}

/**
 * Disposable parse results per file, keyed by path and validated by content hash, in a sidecar SQLite
 * file in the data dir. It is a pure accelerator: any failure to open, read or write it degrades to
 * parsing, and deleting the file is always safe. It is not part of the store schema.
 */
export class ParseCache {
  private constructor(private readonly db: Database.Database) {}

  static open(dataDir: string): ParseCache | undefined {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const db = new Database(path.join(dataDir, PARSE_CACHE_FILE), { timeout: 2000 });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = OFF");
      const version = db.pragma("user_version", { simple: true }) as number;
      if (version !== PARSE_CACHE_VERSION) {
        db.transaction(() => {
          db.exec("DROP TABLE IF EXISTS parsed");
          db.exec("CREATE TABLE parsed(path TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL)");
          db.pragma(`user_version = ${PARSE_CACHE_VERSION}`);
        }).immediate();
      }
      return new ParseCache(db);
    } catch {
      return undefined;
    }
  }

  /** path -> { hash, data } for every cached file. */
  loadAll(): Map<string, { hash: string; data: string }> {
    const out = new Map<string, { hash: string; data: string }>();
    try {
      for (const r of this.db.prepare("SELECT path, hash, data FROM parsed").iterate() as Iterable<{
        path: string;
        hash: string;
        data: string;
      }>) {
        out.set(r.path, { hash: r.hash, data: r.data });
      }
    } catch {
      out.clear();
    }
    return out;
  }

  /** Upserts fresh entries and, when `keep` is given, deletes rows for every other path. */
  save(entries: { path: string; hash: string; data: string }[], keep?: Set<string>): void {
    try {
      this.db
        .transaction(() => {
          const up = this.db.prepare(
            "INSERT INTO parsed(path, hash, data) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, data = excluded.data",
          );
          for (const e of entries) up.run(e.path, e.hash, e.data);
          if (keep) {
            const del = this.db.prepare("DELETE FROM parsed WHERE path = ?");
            const rows = this.db.prepare("SELECT path FROM parsed").all() as { path: string }[];
            for (const r of rows) if (!keep.has(r.path)) del.run(r.path);
          }
        })
        .immediate();
    } catch {
      // The cache is best effort.
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

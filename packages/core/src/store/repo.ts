import type BetterSqlite3 from "better-sqlite3";
import type {
  EdgeKind,
  EdgeRecord,
  FileRecord,
  FtsRow,
  Layer,
  SymbolKind,
  SymbolRecord,
  WorkspaceRecord,
} from "../types.js";

export type Database = BetterSqlite3.Database;

export interface Store {
  db: Database;
  close(): void;
  /** Runs `fn` inside `BEGIN IMMEDIATE`; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;
  getMeta(k: string): string | undefined;
  setMeta(k: string, v: string): void;
  upsertWorkspaces(ws: WorkspaceRecord[]): void;
  /** All workspaces ordered by id. */
  listWorkspaces(): WorkspaceRecord[];
  /** Deletes the old rows for that file+layer first, then inserts the new ones. */
  replaceFile(layer: Layer, file: FileRecord, symbols: SymbolRecord[], edges: EdgeRecord[]): void;
  markDeleted(layer: Layer, fileId: string): void;
  clearWorking(fileId?: string): void;
  effectiveFiles(): FileRecord[];
  /** One file of the effective view (working over main), or undefined if absent or deleted. */
  effectiveFile(fileId: string): FileRecord | undefined;
  effectiveSymbols(filter?: { fileId?: string; kind?: SymbolKind[]; exported?: boolean }): SymbolRecord[];
  effectiveEdges(filter?: { src?: string; dst?: string; kind?: EdgeKind[] }): EdgeRecord[];
  getSymbol(id: string): SymbolRecord | undefined;
  fts: { upsert(symbolId: string, row: FtsRow): void; remove(symbolId: string): void };
  /**
   * Changes whenever the files, symbols or edges seen through this store may have changed: writes made
   * through this store (a local counter) and writes made by other connections (`PRAGMA data_version`).
   * Caches built from the index (the duplicate engine's LSH index) key on it.
   */
  generation(): string;
}

/**
 * Effective view: for each file id the working row wins over main; a working file
 * with deleted=1 hides the file (and so its symbols and edges). Symbols and edges
 * follow the layer chosen for their file.
 */
const EFF_FILES = `eff_files AS (
  SELECT * FROM files WHERE layer = 'working'
  UNION ALL
  SELECT m.* FROM files m WHERE m.layer = 'main'
    AND NOT EXISTS (SELECT 1 FROM files w WHERE w.id = m.id AND w.layer = 'working')
)`;

interface FileRow {
  id: string;
  path: string;
  workspace_id: string | null;
  content_hash: string;
  mtime_ms: number;
  deleted: number;
  directives?: string | null;
}
interface SymbolRow {
  id: string;
  file_id: string;
  name: string;
  kind: SymbolKind;
  exported: number;
  signature: string;
  start_line: number;
  end_line: number;
  loc: number;
  complexity: number;
  stmt_count: number;
  exact_hash: string;
  shape_hash: string;
  minhash: Buffer;
}
interface EdgeRow {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: "high" | "low";
  count: number;
  evidence: string;
  file_id: string;
}

/** 64 little-endian uint32 values, regardless of host byte order. */
export function encodeMinhash(m: Uint32Array): Buffer {
  const buf = Buffer.alloc(m.length * 4);
  for (let i = 0; i < m.length; i++) buf.writeUInt32LE(m[i] as number, i * 4);
  return buf;
}

export function decodeMinhash(b: Buffer | null): Uint32Array {
  if (!b) return new Uint32Array(0);
  const out = new Uint32Array(b.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = b.readUInt32LE(i * 4);
  return out;
}

const toSymbol = (r: SymbolRow): SymbolRecord => ({
  id: r.id,
  fileId: r.file_id,
  name: r.name,
  kind: r.kind,
  exported: r.exported === 1,
  signature: r.signature,
  startLine: r.start_line,
  endLine: r.end_line,
  loc: r.loc,
  complexity: r.complexity,
  stmtCount: r.stmt_count,
  exactHash: r.exact_hash,
  shapeHash: r.shape_hash,
  minhash: decodeMinhash(r.minhash),
});

const toEdge = (r: EdgeRow): EdgeRecord => ({
  src: r.src,
  dst: r.dst,
  kind: r.kind,
  confidence: r.confidence,
  count: r.count,
  evidence: JSON.parse(r.evidence ?? "[]") as string[],
  fileId: r.file_id,
});

interface WorkspaceRow {
  id: string;
  name: string;
  dir: string;
  kind: WorkspaceRecord["kind"];
  frameworks: string | null;
  deps: string | null;
  exports_map: string | null;
}

const toWorkspace = (r: WorkspaceRow): WorkspaceRecord => ({
  id: r.id,
  name: r.name,
  dir: r.dir,
  kind: r.kind,
  frameworks: JSON.parse(r.frameworks ?? "[]") as string[],
  deps: JSON.parse(r.deps ?? "[]") as string[],
  exportsMap: r.exports_map ? (JSON.parse(r.exports_map) as WorkspaceRecord["exportsMap"]) : null,
});

function parseDirectives(raw: string | null | undefined): { directives?: string[] } {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0)
      return { directives: v.filter((x): x is string => typeof x === "string") };
  } catch {
    // malformed value: treat as no directives
  }
  return {};
}

const toFile = (r: FileRow): FileRecord => ({
  id: r.id,
  path: r.path,
  workspaceId: r.workspace_id,
  contentHash: r.content_hash,
  mtimeMs: r.mtime_ms,
  deleted: r.deleted === 1,
  ...parseDirectives(r.directives),
});

export function createStore(db: Database): Store {
  const cache = new Map<string, BetterSqlite3.Statement>();
  const stmt = (sql: string): BetterSqlite3.Statement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const tx = <T>(fn: () => T): T => db.transaction(fn).immediate();
  let localWrites = 0;

  const putFile = (layer: Layer, f: FileRecord): void => {
    stmt(
      `INSERT INTO files(id, layer, path, workspace_id, content_hash, mtime_ms, deleted, directives)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, layer) DO UPDATE SET path = excluded.path, workspace_id = excluded.workspace_id,
         content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, deleted = excluded.deleted,
         directives = excluded.directives`,
    ).run(
      f.id,
      layer,
      f.path,
      f.workspaceId,
      f.contentHash,
      f.mtimeMs,
      f.deleted ? 1 : 0,
      JSON.stringify(f.directives ?? []),
    );
  };

  const deleteFileRows = (layer: Layer, fileId: string): void => {
    stmt("DELETE FROM symbols WHERE layer = ? AND file_id = ?").run(layer, fileId);
    stmt("DELETE FROM edges WHERE layer = ? AND file_id = ?").run(layer, fileId);
  };

  const store: Store = {
    db,
    close() {
      db.close();
    },
    tx,
    getMeta(k) {
      const r = stmt("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined;
      return r?.value;
    },
    setMeta(k, v) {
      stmt(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(k, v);
    },
    upsertWorkspaces(ws) {
      tx(() => {
        const s = stmt(
          `INSERT INTO workspaces(id, name, dir, kind, frameworks, deps, exports_map)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, dir = excluded.dir, kind = excluded.kind,
             frameworks = excluded.frameworks, deps = excluded.deps, exports_map = excluded.exports_map`,
        );
        for (const w of ws) {
          s.run(
            w.id,
            w.name,
            w.dir,
            w.kind,
            JSON.stringify(w.frameworks),
            JSON.stringify(w.deps),
            JSON.stringify(w.exportsMap),
          );
        }
      });
    },
    listWorkspaces() {
      const rows = stmt("SELECT * FROM workspaces ORDER BY id").all() as WorkspaceRow[];
      return rows.map(toWorkspace);
    },
    generation() {
      return `${localWrites}:${db.pragma("data_version", { simple: true }) as number}`;
    },
    replaceFile(layer, file, symbols, edges) {
      localWrites++;
      tx(() => {
        deleteFileRows(layer, file.id);
        putFile(layer, file);
        const si = stmt(
          `INSERT INTO symbols(id, layer, file_id, name, kind, exported, signature, start_line, end_line,
             loc, complexity, stmt_count, exact_hash, shape_hash, minhash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id, layer) DO UPDATE SET file_id = excluded.file_id, name = excluded.name,
             kind = excluded.kind, exported = excluded.exported, signature = excluded.signature,
             start_line = excluded.start_line, end_line = excluded.end_line, loc = excluded.loc,
             complexity = excluded.complexity, stmt_count = excluded.stmt_count,
             exact_hash = excluded.exact_hash, shape_hash = excluded.shape_hash, minhash = excluded.minhash`,
        );
        for (const s of symbols) {
          si.run(
            s.id,
            layer,
            s.fileId,
            s.name,
            s.kind,
            s.exported ? 1 : 0,
            s.signature,
            s.startLine,
            s.endLine,
            s.loc,
            s.complexity,
            s.stmtCount,
            s.exactHash,
            s.shapeHash,
            encodeMinhash(s.minhash),
          );
        }
        const ei = stmt(
          `INSERT INTO edges(src, dst, kind, layer, confidence, count, evidence, file_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(src, dst, kind, layer) DO UPDATE SET confidence = excluded.confidence,
             count = excluded.count, evidence = excluded.evidence, file_id = excluded.file_id`,
        );
        for (const e of edges) {
          ei.run(e.src, e.dst, e.kind, layer, e.confidence, e.count, JSON.stringify(e.evidence), e.fileId);
        }
      });
    },
    markDeleted(layer, fileId) {
      localWrites++;
      tx(() => {
        deleteFileRows(layer, fileId);
        const existing = stmt("SELECT * FROM files WHERE id = ? AND layer = ?").get(fileId, layer) as
          | FileRow
          | undefined;
        const base: FileRecord = existing
          ? toFile(existing)
          : {
              id: fileId,
              path: fileId.startsWith("file:") ? fileId.slice(5) : fileId,
              workspaceId: null,
              contentHash: "",
              mtimeMs: 0,
              deleted: true,
            };
        putFile(layer, { ...base, deleted: true });
      });
    },
    clearWorking(fileId) {
      localWrites++;
      tx(() => {
        if (fileId === undefined) {
          stmt("DELETE FROM files WHERE layer = 'working'").run();
          stmt("DELETE FROM symbols WHERE layer = 'working'").run();
          stmt("DELETE FROM edges WHERE layer = 'working'").run();
        } else {
          stmt("DELETE FROM files WHERE layer = 'working' AND id = ?").run(fileId);
          deleteFileRows("working", fileId);
        }
      });
    },
    effectiveFile(fileId) {
      const row = stmt(`WITH ${EFF_FILES} SELECT * FROM eff_files WHERE id = ? AND deleted = 0`).get(
        fileId,
      ) as FileRow | undefined;
      return row ? toFile(row) : undefined;
    },
    effectiveFiles() {
      const rows = stmt(
        `WITH ${EFF_FILES} SELECT * FROM eff_files WHERE deleted = 0 ORDER BY id`,
      ).all() as FileRow[];
      return rows.map(toFile);
    },
    effectiveSymbols(filter = {}) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (filter.fileId !== undefined) {
        where.push("s.file_id = ?");
        args.push(filter.fileId);
      }
      if (filter.kind) {
        where.push(`s.kind IN (${filter.kind.map(() => "?").join(",")})`);
        args.push(...filter.kind);
      }
      if (filter.exported !== undefined) {
        where.push("s.exported = ?");
        args.push(filter.exported ? 1 : 0);
      }
      const sql = `WITH ${EFF_FILES}
        SELECT s.* FROM symbols s JOIN eff_files f ON f.id = s.file_id AND f.layer = s.layer
        WHERE f.deleted = 0${where.map((w) => ` AND ${w}`).join("")}
        ORDER BY s.id`;
      return (stmt(sql).all(...args) as SymbolRow[]).map(toSymbol);
    },
    effectiveEdges(filter = {}) {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.src !== undefined) {
        where.push("e.src = ?");
        args.push(filter.src);
      }
      if (filter.dst !== undefined) {
        where.push("e.dst = ?");
        args.push(filter.dst);
      }
      if (filter.kind) {
        where.push(`e.kind IN (${filter.kind.map(() => "?").join(",")})`);
        args.push(...filter.kind);
      }
      const sql = `WITH ${EFF_FILES}
        SELECT e.* FROM edges e JOIN eff_files f ON f.id = e.file_id AND f.layer = e.layer
        WHERE f.deleted = 0${where.map((w) => ` AND ${w}`).join("")}
        ORDER BY e.src, e.dst, e.kind`;
      return (stmt(sql).all(...args) as EdgeRow[]).map(toEdge);
    },
    getSymbol(id) {
      const r = stmt(
        `WITH ${EFF_FILES}
         SELECT s.* FROM symbols s JOIN eff_files f ON f.id = s.file_id AND f.layer = s.layer
         WHERE f.deleted = 0 AND s.id = ? ORDER BY s.id LIMIT 1`,
      ).get(id) as SymbolRow | undefined;
      return r ? toSymbol(r) : undefined;
    },
    fts: {
      upsert(symbolId, row) {
        tx(() => {
          stmt("DELETE FROM fts_symbols WHERE symbol_id = ?").run(symbolId);
          stmt(
            `INSERT INTO fts_symbols(symbol_id, name_tokens, suggested_name, path, behavior, search_terms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(symbolId, row.nameTokens, row.suggestedName, row.path, row.behavior, row.searchTerms);
        });
      },
      remove(symbolId) {
        stmt("DELETE FROM fts_symbols WHERE symbol_id = ?").run(symbolId);
      },
    },
  };
  return store;
}

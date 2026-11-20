import type BetterSqlite3 from "better-sqlite3";
import { pathOfFileId } from "../ids.js";
import { langOfPath } from "../lang/index.js";
import { restoreMainFts } from "../search/descfts.js";
import type {
  AdapterNodeRecord,
  EdgeKind,
  EdgeRecord,
  FileRecord,
  FtsRow,
  Lang,
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
  /** The repo name in every id of this store (`meta.repo`, written by the indexer); throws when nothing was indexed yet. */
  repo(): string;
  upsertWorkspaces(ws: WorkspaceRecord[]): void;
  /** All workspaces ordered by id. */
  listWorkspaces(): WorkspaceRecord[];
  /**
   * Deletes the old rows (symbols, edges, adapter nodes) for that file+layer first, then inserts the new ones.
   * `adapterNodes` defaults to none, so a caller that rewrites a file must pass the nodes it wants to keep.
   */
  replaceFile(
    layer: Layer,
    file: FileRecord,
    symbols: SymbolRecord[],
    edges: EdgeRecord[],
    adapterNodes?: AdapterNodeRecord[],
  ): void;
  markDeleted(layer: Layer, fileId: string): void;
  clearWorking(fileId?: string): void;
  effectiveFiles(): FileRecord[];
  /** One file of the effective view (working over main), or undefined if absent or deleted. */
  effectiveFile(fileId: string): FileRecord | undefined;
  /**
   * Symbols whose name contains `text` (ASCII case-insensitive, literal), not in `excludeIds`, ordered by name then
   * id, at most `limit`. The scan runs in SQL, so it stays cheap on large repositories.
   */
  effectiveSymbolsByName(text: string, excludeIds: string[], limit: number): SymbolRecord[];
  effectiveSymbols(filter?: { fileId?: string; kind?: SymbolKind[]; exported?: boolean }): SymbolRecord[];
  effectiveEdges(filter?: { src?: string; dst?: string; kind?: EdgeKind[] }): EdgeRecord[];
  /** Adapter nodes of the effective view (working rows win per file, like symbols), ordered by id. */
  effectiveAdapterNodes(filter?: { kind?: string; ws?: string; fileId?: string }): AdapterNodeRecord[];
  /** Effective edges stored on the given files (all kinds), ordered like `effectiveEdges`. One query for the lot. */
  effectiveEdgesOfFiles(fileIds: readonly string[]): EdgeRecord[];
  /** Effective adapter nodes stored on the given files, ordered by id. */
  effectiveAdapterNodesOfFiles(fileIds: readonly string[]): AdapterNodeRecord[];
  /** Ids of the files that have an effective `imports` edge into one of `fileIds` (an import or a re-export source). */
  effectiveImporters(fileIds: readonly string[]): string[];
  /** Ids of the files that carry adapter output (a node or an edge of the adapter kinds) in either layer. */
  filesWithAdapterOutput(): string[];
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
  lang: string;
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
  near_minhash?: Buffer | null;
  renamed_hash?: string | null;
  lang: string;
}
interface AdapterNodeRow {
  id: string;
  kind: string;
  ws: string | null;
  label: string;
  file_id: string;
  data: string | null;
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
  lang: r.lang as Lang,
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
  ...(r.near_minhash ? { nearMinhash: decodeMinhash(r.near_minhash) } : {}),
  ...(r.renamed_hash ? { renamedHash: r.renamed_hash } : {}),
});

const toAdapterNode = (r: AdapterNodeRow): AdapterNodeRecord => {
  let data: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(r.data ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) data = v as Record<string, unknown>;
  } catch {
    // malformed value: treat as no data
  }
  return { id: r.id, kind: r.kind, ws: r.ws, label: r.label, fileId: r.file_id, data };
};

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
  lang: r.lang as Lang,
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
      `INSERT INTO files(id, layer, path, workspace_id, content_hash, mtime_ms, deleted, directives, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, layer) DO UPDATE SET path = excluded.path, workspace_id = excluded.workspace_id,
         content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, deleted = excluded.deleted,
         directives = excluded.directives, lang = excluded.lang`,
    ).run(
      f.id,
      layer,
      f.path,
      f.workspaceId,
      f.contentHash,
      f.mtimeMs,
      f.deleted ? 1 : 0,
      JSON.stringify(f.directives ?? []),
      f.lang,
    );
  };

  /**
   * Search rows of dropped working-layer symbols, for one file or all. A symbol main does not have loses its row, so
   * `fts_symbols` keeps no row for a symbol that is in neither layer. A symbol main also has gets its row rewritten
   * from the main layer, so it does not keep the working text (#165). Skips the FTS scan when there are none.
   */
  const dropWorkingOnlyFts = (fileId?: string): void => {
    const sel =
      "SELECT w.id, EXISTS (SELECT 1 FROM symbols m WHERE m.id = w.id AND m.layer = 'main') AS in_main FROM symbols w WHERE w.layer = 'working'";
    const rows = (fileId === undefined ? stmt(sel).all() : stmt(`${sel} AND w.file_id = ?`).all(fileId)) as {
      id: string;
      in_main: number;
    }[];
    const gone = rows.filter((r) => !r.in_main).map((r) => r.id);
    if (gone.length > 0)
      stmt("DELETE FROM fts_symbols WHERE symbol_id IN (SELECT value FROM json_each(?))").run(
        JSON.stringify(gone),
      );
    restoreMainFts(
      db,
      rows.filter((r) => r.in_main).map((r) => r.id),
    );
  };

  const deleteFileRows = (layer: Layer, fileId: string): void => {
    stmt("DELETE FROM symbols WHERE layer = ? AND file_id = ?").run(layer, fileId);
    stmt("DELETE FROM edges WHERE layer = ? AND file_id = ?").run(layer, fileId);
    stmt("DELETE FROM adapter_nodes WHERE layer = ? AND file_id = ?").run(layer, fileId);
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
    repo() {
      const r = store.getMeta("repo");
      if (r === undefined) throw new Error("The store has no repo name: it was not indexed");
      return r;
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
    replaceFile(layer, file, symbols, edges, adapterNodes = []) {
      localWrites++;
      tx(() => {
        deleteFileRows(layer, file.id);
        putFile(layer, file);
        const si = stmt(
          `INSERT INTO symbols(id, layer, file_id, name, kind, exported, signature, start_line, end_line,
             loc, complexity, stmt_count, exact_hash, shape_hash, minhash, near_minhash, renamed_hash, lang)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id, layer) DO UPDATE SET file_id = excluded.file_id, name = excluded.name,
             kind = excluded.kind, exported = excluded.exported, signature = excluded.signature,
             start_line = excluded.start_line, end_line = excluded.end_line, loc = excluded.loc,
             complexity = excluded.complexity, stmt_count = excluded.stmt_count,
             exact_hash = excluded.exact_hash, shape_hash = excluded.shape_hash, minhash = excluded.minhash,
             near_minhash = excluded.near_minhash, renamed_hash = excluded.renamed_hash, lang = excluded.lang`,
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
            s.nearMinhash && s.nearMinhash.length > 0 ? encodeMinhash(s.nearMinhash) : null,
            s.renamedHash ? s.renamedHash : null,
            s.lang,
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
        const ai = stmt(
          `INSERT INTO adapter_nodes(id, layer, kind, ws, label, file_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id, layer) DO UPDATE SET kind = excluded.kind, ws = excluded.ws, label = excluded.label,
             file_id = excluded.file_id, data = excluded.data`,
        );
        for (const n of adapterNodes) {
          ai.run(n.id, layer, n.kind, n.ws, n.label, n.fileId, JSON.stringify(n.data));
        }
      });
    },
    markDeleted(layer, fileId) {
      localWrites++;
      tx(() => {
        if (layer === "working") dropWorkingOnlyFts(fileId);
        deleteFileRows(layer, fileId);
        const existing = stmt("SELECT * FROM files WHERE id = ? AND layer = ?").get(fileId, layer) as
          | FileRow
          | undefined;
        const base: FileRecord = existing
          ? toFile(existing)
          : {
              id: fileId,
              path: pathOfFileId(fileId),
              lang: langOfPath(pathOfFileId(fileId)),
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
        dropWorkingOnlyFts(fileId);
        if (fileId === undefined) {
          stmt("DELETE FROM files WHERE layer = 'working'").run();
          stmt("DELETE FROM symbols WHERE layer = 'working'").run();
          stmt("DELETE FROM edges WHERE layer = 'working'").run();
          stmt("DELETE FROM adapter_nodes WHERE layer = 'working'").run();
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
    effectiveSymbolsByName(text, excludeIds, limit) {
      const sql = `WITH ${EFF_FILES}
        SELECT s.* FROM symbols s JOIN eff_files f ON f.id = s.file_id AND f.layer = s.layer
        WHERE f.deleted = 0 AND instr(lower(s.name), lower(?)) > 0
          AND s.id NOT IN (SELECT value FROM json_each(?))
        ORDER BY s.name, s.id LIMIT ?`;
      return (stmt(sql).all(text, JSON.stringify(excludeIds), limit) as SymbolRow[]).map(toSymbol);
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
    effectiveAdapterNodes(filter = {}) {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.kind !== undefined) {
        where.push("n.kind = ?");
        args.push(filter.kind);
      }
      if (filter.ws !== undefined) {
        where.push("n.ws = ?");
        args.push(filter.ws);
      }
      if (filter.fileId !== undefined) {
        where.push("n.file_id = ?");
        args.push(filter.fileId);
      }
      const sql = `WITH ${EFF_FILES}
        SELECT n.* FROM adapter_nodes n JOIN eff_files f ON f.id = n.file_id AND f.layer = n.layer
        WHERE f.deleted = 0${where.map((w) => ` AND ${w}`).join("")}
        ORDER BY n.id`;
      return (stmt(sql).all(...args) as AdapterNodeRow[]).map(toAdapterNode);
    },
    effectiveEdgesOfFiles(fileIds) {
      if (fileIds.length === 0) return [];
      const sql = `WITH ${EFF_FILES}
        SELECT e.* FROM edges e JOIN eff_files f ON f.id = e.file_id AND f.layer = e.layer
        WHERE f.deleted = 0 AND e.file_id IN (SELECT value FROM json_each(?))
        ORDER BY e.src, e.dst, e.kind`;
      return (stmt(sql).all(JSON.stringify(fileIds)) as EdgeRow[]).map(toEdge);
    },
    effectiveAdapterNodesOfFiles(fileIds) {
      if (fileIds.length === 0) return [];
      const sql = `WITH ${EFF_FILES}
        SELECT n.* FROM adapter_nodes n JOIN eff_files f ON f.id = n.file_id AND f.layer = n.layer
        WHERE f.deleted = 0 AND n.file_id IN (SELECT value FROM json_each(?))
        ORDER BY n.id`;
      return (stmt(sql).all(JSON.stringify(fileIds)) as AdapterNodeRow[]).map(toAdapterNode);
    },
    effectiveImporters(fileIds) {
      if (fileIds.length === 0) return [];
      const sql = `WITH ${EFF_FILES}
        SELECT DISTINCT e.file_id AS id FROM edges e JOIN eff_files f ON f.id = e.file_id AND f.layer = e.layer
        WHERE f.deleted = 0 AND e.kind = 'imports' AND e.dst IN (SELECT value FROM json_each(?))`;
      return (stmt(sql).all(JSON.stringify(fileIds)) as { id: string }[]).map((r) => r.id);
    },
    filesWithAdapterOutput() {
      const rows = stmt(
        `SELECT file_id AS id FROM adapter_nodes
         UNION SELECT file_id AS id FROM edges WHERE kind IN ('serves','handles','requests','reads','writes')`,
      ).all() as { id: string }[];
      return rows.map((r) => r.id);
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

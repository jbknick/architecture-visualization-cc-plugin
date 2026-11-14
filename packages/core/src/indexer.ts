import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import { discoverFiles, isIndexable } from "./discover/index.js";
import { hashSymbol } from "./hash/index.js";
import { encodeParsed, LazyParsedMap, ParseCache } from "./parse/cache.js";
import { type ParsedFile, parseSource } from "./parse/index.js";
import { ensureDataDir, type GantryPaths } from "./paths/index.js";
import { createResolver, type SpecifierClass } from "./resolve/index.js";
import { openStore, type Store, splitIdentifier } from "./store/index.js";
import type { EdgeRecord, FileRecord, Layer, SymbolKind, SymbolRecord, WorkspaceRecord } from "./types.js";
import { detectWorkspaces, workspaceForPath } from "./workspace/index.js";

export interface IndexResult {
  files: number;
  symbols: number;
  functionLike: number;
  edges: number;
  unresolved: { specifier: string; from: string }[];
  /** Distinct (file, specifier) pairs by resolution class, for the whole run (used by the M1 benchmark). */
  specifierCounts: Record<SpecifierClass, number>;
  parseErrors: { file: string; errors: string[] }[];
  ms: number;
}

export interface IndexOptions {
  layer: Layer;
  /** Repo-relative posix paths. When given, only these are re-indexed (plus importers whose edges changed). */
  files?: string[];
  /** In-memory text per repo-relative path (for example staged blobs); wins over the working tree. */
  sources?: Map<string, string>;
  /** Use an already open store (the caller keeps ownership and closes it). Default: open `paths.dbPath`. */
  store?: Store;
}

const READ_CONCURRENCY = 16;
const TX_BATCH = 200;
const FUNCTION_LIKE: ReadonlySet<SymbolKind> = new Set(["function", "method", "component", "hook"]);

interface Entry {
  path: string;
  id: string;
  workspaceId: string;
  mtimeMs: number;
  /** undefined when the file could not be read (it no longer exists). */
  source?: string;
  contentHash?: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const langOf = (p: string): "ts" | "tsx" => (p.endsWith(".tsx") ? "tsx" : "ts");

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function headSha(root: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

async function readEntry(root: string, e: Entry, sources?: Map<string, string>): Promise<Entry> {
  const mem = sources?.get(e.path);
  if (mem !== undefined) return { ...e, source: mem, contentHash: sha256(Buffer.from(mem, "utf8")) };
  try {
    const bytes = await fs.promises.readFile(path.join(root, e.path));
    return { ...e, source: bytes.toString("utf8"), contentHash: sha256(bytes) };
  } catch {
    return e;
  }
}

const edgeKey = (e: EdgeRecord): string =>
  `${e.src}\0${e.dst}\0${e.kind}\0${e.confidence}\0${e.count}\0${JSON.stringify(e.evidence)}\0${e.fileId}`;

function sameEdges(a: EdgeRecord[], b: EdgeRecord[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(edgeKey).sort();
  const kb = b.map(edgeKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function readJsonHash(root: string, rel: string): { hash: string; mtimeMs: number } {
  try {
    const abs = path.join(root, rel);
    return { hash: sha256(fs.readFileSync(abs)), mtimeMs: fs.statSync(abs).mtimeMs };
  } catch {
    return { hash: "", mtimeMs: 0 };
  }
}

/**
 * Discovery, parse, hash, resolve, store. Deterministic: files are processed in path order.
 *
 * Targeted runs (`files`) still need every file's parse result, because the resolver follows barrels
 * through the whole export graph; unchanged files come from the parse cache (`parse/cache.ts`, keyed by
 * path and content hash) instead of being parsed again. Only the targets are hashed and written, plus any other file
 * whose resolved edges differ from the effective ones already stored (importers of a file whose
 * symbols changed). `depends_on` edges are stored on a `files` row for each workspace
 * `package.json` (id `file:<dir>/package.json`) in the main layer, so effective views return them.
 */
export async function indexRepo(paths: GantryPaths, opts: IndexOptions): Promise<IndexResult> {
  const t0 = performance.now();
  const { layer, sources } = opts;
  const root = paths.root;
  const ownStore = !opts.store;
  if (ownStore) ensureDataDir(paths);
  const store = opts.store ?? openStore(paths.dbPath);
  try {
    // Describe-side code (fact sheets, templates) reads file text and only has the store.
    if (store.getMeta("repo_root") !== root) store.setMeta("repo_root", root);
    const config = loadConfig(paths);
    const workspaces = detectWorkspaces(root, config);

    // 1. Which files exist, and which of them are targets of this run.
    const discovered = discoverFiles(paths, config, workspaces);
    const entries = new Map<string, Entry>();
    for (const d of discovered) {
      entries.set(d.path, {
        path: d.path,
        id: `file:${d.path}`,
        workspaceId: d.workspaceId,
        mtimeMs: d.mtimeMs,
      });
    }
    const targets = new Set<string>();
    if (opts.files) {
      for (const raw of opts.files) {
        const p = raw.split(path.sep).join("/").replace(/^\.\//, "");
        if (!isIndexable(p, config)) continue;
        targets.add(p);
        if (!entries.has(p)) {
          entries.set(p, {
            path: p,
            id: `file:${p}`,
            workspaceId: workspaceForPath(workspaces, p).id,
            mtimeMs: 0,
          });
        }
      }
    }
    for (const [p] of sources ?? []) {
      if (!entries.has(p) && isIndexable(p, config)) {
        entries.set(p, {
          path: p,
          id: `file:${p}`,
          workspaceId: workspaceForPath(workspaces, p).id,
          mtimeMs: 0,
        });
      }
    }

    // 2. Read (bounded concurrency) and parse everything the resolver needs.
    const list = [...entries.values()].sort((a, b) => cmp(a.path, b.path));
    const read = await mapPool(list, READ_CONCURRENCY, (e) => readEntry(root, e, sources));
    const present = read.filter((e) => e.source !== undefined);
    const parsed = new LazyParsedMap();
    const cache = ParseCache.open(paths.dataDir);
    try {
      const cached = cache?.loadAll();
      const fresh: { path: string; hash: string; data: string }[] = [];
      for (const e of present) {
        const hit = cached?.get(e.path);
        if (hit && hit.hash === e.contentHash) {
          parsed.setRaw(e.id, hit.data);
          continue;
        }
        const pf = parseSource(e.path, e.source as string);
        parsed.set(e.id, pf);
        fresh.push({ path: e.path, hash: e.contentHash as string, data: encodeParsed(pf) });
      }
      // Entries for paths that no longer exist are only pruned when this run saw the whole tree.
      cache?.save(fresh, !opts.files && !sources ? new Set(present.map((e) => e.path)) : undefined);
    } finally {
      cache?.close();
    }

    const resolver = createResolver({ root, workspaces, parsed });
    store.upsertWorkspaces(workspaces);

    // 3. Decide what to write.
    const full = !opts.files;
    const existsNow = new Set(present.map((e) => e.id));
    const mainFiles = new Map<string, FileRecord>();
    for (const row of store.db
      .prepare("SELECT id, content_hash FROM files WHERE layer = 'main' AND deleted = 0")
      .all() as { id: string; content_hash: string }[]) {
      mainFiles.set(row.id, {
        id: row.id,
        path: "",
        workspaceId: null,
        contentHash: row.content_hash,
        mtimeMs: 0,
        deleted: false,
      });
    }

    const toWrite: Entry[] = [];
    const clearWorking: string[] = [];
    const markDeleted: string[] = [];
    for (const e of present) {
      if (!full && !targets.has(e.path) && !sources?.has(e.path)) continue;
      if (layer === "working") {
        const m = mainFiles.get(e.id);
        if (m && m.contentHash === e.contentHash) {
          clearWorking.push(e.id);
          continue;
        }
      }
      toWrite.push(e);
    }
    const missing = (full ? [...mainFiles.keys()] : [...targets].map((p) => `file:${p}`)).filter(
      (id) => !existsNow.has(id),
    );
    // package.json rows carrying depends_on edges are not source files; never treat them as deleted.
    const wsEdges = resolver.workspaceEdges();
    const pkgIds = new Set(wsEdges.map((e) => e.fileId));
    for (const id of missing) if (!(full && pkgIds.has(id))) markDeleted.push(id);

    // 4. Write per file, one transaction per TX_BATCH files.
    const written = new Set<string>();
    const result: IndexResult = {
      files: 0,
      symbols: 0,
      functionLike: 0,
      edges: 0,
      unresolved: [],
      specifierCounts: {
        file: 0,
        external: 0,
        builtin: 0,
        virtual: 0,
        generated: 0,
        excluded: 0,
        unresolved: 0,
      },
      parseErrors: [],
      ms: 0,
    };
    // fts_symbols has no index on symbol_id (UNINDEXED column), so a per-symbol delete scans the whole
    // table. A full main index therefore rebuilds the table in one pass, carrying over any
    // description-derived columns, instead of upserting symbol by symbol.
    const rebuildFts = full && layer === "main";
    const prevFts = new Map<string, { suggested: string; behavior: string; terms: string }>();
    const ftsInsert = store.db.prepare(
      `INSERT INTO fts_symbols(symbol_id, name_tokens, suggested_name, path, behavior, search_terms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    if (rebuildFts) {
      for (const r of store.db
        .prepare("SELECT symbol_id, suggested_name, behavior, search_terms FROM fts_symbols")
        .all() as { symbol_id: string; suggested_name: string; behavior: string; search_terms: string }[]) {
        prevFts.set(r.symbol_id, {
          suggested: r.suggested_name,
          behavior: r.behavior,
          terms: r.search_terms,
        });
      }
      store.tx(() => store.db.exec("DELETE FROM fts_symbols"));
    }
    const oldFtsIds = (l: Layer, fileId: string): string[] =>
      (
        store.db.prepare("SELECT id FROM symbols WHERE layer = ? AND file_id = ?").all(l, fileId) as {
          id: string;
        }[]
      ).map((r) => r.id);

    const writeOne = (e: Entry): void => {
      const pf = parsed.get(e.id) as ParsedFile;
      const source = e.source as string;
      const lang = langOf(e.path);
      const symbols: SymbolRecord[] = pf.symbols.map((s) => {
        const body = pf.bodies.get(s.id);
        const h = body
          ? hashSymbol(source, body, lang)
          : { exactHash: "", shapeHash: "", minhash: new Uint32Array(64) };
        return { ...s, ...h };
      });
      const edges = resolver.edgesForFile(e.id);
      const file: FileRecord = {
        id: e.id,
        path: e.path,
        workspaceId: e.workspaceId,
        contentHash: e.contentHash as string,
        mtimeMs: Math.round(e.mtimeMs),
        deleted: false,
      };
      const old = layer === "main" && !rebuildFts ? oldFtsIds("main", e.id) : [];
      store.replaceFile(layer, file, symbols, edges);
      const keep = new Set(symbols.map((s) => s.id));
      for (const id of old) if (!keep.has(id)) store.fts.remove(id);
      for (const s of symbols) {
        const nameTokens = splitIdentifier(s.name).join(" ");
        if (rebuildFts) {
          const p = prevFts.get(s.id);
          ftsInsert.run(s.id, nameTokens, p?.suggested ?? "", e.path, p?.behavior ?? "", p?.terms ?? "");
        } else {
          store.fts.upsert(s.id, {
            nameTokens,
            suggestedName: "",
            path: e.path,
            behavior: "",
            searchTerms: "",
          });
        }
      }
      written.add(e.id);
      result.files++;
      result.symbols += symbols.length;
      result.functionLike += symbols.filter((s) => FUNCTION_LIKE.has(s.kind)).length;
      result.edges += edges.length;
      if (pf.errors.length > 0) result.parseErrors.push({ file: e.path, errors: pf.errors });
    };

    for (let i = 0; i < toWrite.length; i += TX_BATCH) {
      const batch = toWrite.slice(i, i + TX_BATCH);
      store.tx(() => {
        for (const e of batch) writeOne(e);
      });
    }

    store.tx(() => {
      for (const id of clearWorking) store.clearWorking(id);
      for (const id of markDeleted) {
        if (layer === "main") removeMainFile(store, id, !rebuildFts);
        else store.markDeleted("working", id);
      }

      // Importers: files we did not write whose resolved edges differ from the effective ones.
      if (!full || layer === "working") {
        const eff = new Map<string, EdgeRecord[]>();
        for (const ed of store.effectiveEdges()) {
          if (ed.kind === "depends_on") continue;
          const a = eff.get(ed.fileId) ?? [];
          a.push(ed);
          eff.set(ed.fileId, a);
        }
        const effFiles = new Map(store.effectiveFiles().map((f) => [f.id, f]));
        for (const e of present) {
          if (written.has(e.id)) continue;
          const file = effFiles.get(e.id);
          if (!file) continue;
          const fresh = resolver.edgesForFile(e.id);
          if (sameEdges(fresh, eff.get(e.id) ?? [])) continue;
          store.replaceFile(layer, file, store.effectiveSymbols({ fileId: e.id }), fresh);
          written.add(e.id);
          result.edges += fresh.length;
        }
      }

      if (layer === "main") {
        if (full) removeStaleMain(store, new Set([...existsNow, ...pkgIds]), !rebuildFts);
        writeDependsOn(store, root, workspaces, wsEdges);
        if (full) {
          result.edges += wsEdges.length;
          const sha = headSha(root);
          if (sha) store.setMeta("head_sha", sha);
          store.setMeta("indexed_at", new Date().toISOString());
        }
      }
    });

    const pathOf = (id: string): string => (id.startsWith("file:") ? id.slice(5) : id);
    const stats = resolver.stats();
    result.specifierCounts = stats.counts;
    result.unresolved = stats.unresolved
      .filter((u) => written.has(u.fromFileId) || full)
      .map((u) => ({ specifier: u.specifier, from: pathOf(u.fromFileId) }));
    result.parseErrors.sort((a, b) => cmp(a.file, b.file));
    result.ms = Math.round(performance.now() - t0);
    return result;
  } finally {
    if (ownStore) store.close();
  }
}

function removeMainFile(store: Store, fileId: string, removeFts: boolean): void {
  const syms = store.db
    .prepare("SELECT id FROM symbols WHERE layer = 'main' AND file_id = ?")
    .all(fileId) as {
    id: string;
  }[];
  if (removeFts) for (const s of syms) store.fts.remove(s.id);
  store.db.prepare("DELETE FROM symbols WHERE layer = 'main' AND file_id = ?").run(fileId);
  store.db.prepare("DELETE FROM edges WHERE layer = 'main' AND file_id = ?").run(fileId);
  store.db.prepare("DELETE FROM files WHERE layer = 'main' AND id = ?").run(fileId);
}

function removeStaleMain(store: Store, keep: Set<string>, removeFts: boolean): void {
  const rows = store.db.prepare("SELECT id FROM files WHERE layer = 'main'").all() as { id: string }[];
  for (const r of rows) if (!keep.has(r.id)) removeMainFile(store, r.id, removeFts);
}

/**
 * Stores each workspace's `depends_on` edges on a main-layer `files` row for its package.json
 * (`file:<dir>/package.json`, no symbols) so the effective views include them. Rows for package.json
 * files that no longer carry any edge are removed.
 */
function writeDependsOn(
  store: Store,
  root: string,
  workspaces: WorkspaceRecord[],
  edges: EdgeRecord[],
): void {
  const byFile = new Map<string, EdgeRecord[]>();
  for (const e of edges) {
    const a = byFile.get(e.fileId) ?? [];
    a.push(e);
    byFile.set(e.fileId, a);
  }
  const wsOfDir = new Map(workspaces.map((w) => [`file:${w.dir === "." ? "" : `${w.dir}/`}package.json`, w]));
  for (const [fileId, es] of [...byFile].sort((a, b) => cmp(a[0], b[0]))) {
    const rel = fileId.slice(5);
    const { hash, mtimeMs } = readJsonHash(root, rel);
    store.replaceFile(
      "main",
      {
        id: fileId,
        path: rel,
        workspaceId: wsOfDir.get(fileId)?.id ?? null,
        contentHash: hash,
        mtimeMs: Math.round(mtimeMs),
        deleted: false,
      },
      [],
      es,
    );
  }
}

type Json = Record<string, unknown>;

/** Sorted, timestamp-free snapshot of the effective graph (used by `gantry index --dump` and snapshot tests). */
export function dumpGraph(store: Store): {
  workspaces: unknown[];
  files: unknown[];
  symbols: unknown[];
  edges: unknown[];
} {
  const wsRows = store.db.prepare("SELECT * FROM workspaces ORDER BY id").all() as Json[];
  const workspaces = wsRows.map((w) => ({
    id: w.id,
    name: w.name,
    dir: w.dir,
    kind: w.kind,
    frameworks: JSON.parse((w.frameworks as string) ?? "[]"),
    deps: JSON.parse((w.deps as string) ?? "[]"),
    exportsMap: JSON.parse((w.exports_map as string) ?? "null"),
  }));
  const files = store.effectiveFiles().map((f) => ({
    id: f.id,
    path: f.path,
    workspaceId: f.workspaceId,
    contentHash: f.contentHash,
  }));
  // minhash is omitted: it is 64 words per symbol and is fully determined by the source.
  const symbols = store.effectiveSymbols().map(({ minhash: _m, ...s }) => s);
  // similar_to edges are derived (rebuilt by init/heal/embed from hashes and vectors), not part of the index.
  const edges = store.effectiveEdges().filter((e) => e.kind !== "similar_to");
  return { workspaces, files, symbols, edges };
}

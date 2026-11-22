import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Adapter } from "./adapters/framework.js";
import { runAdapters } from "./adapters/index.js";
import { type GantryConfig, loadConfig } from "./config/index.js";
import { discoverFiles, isIndexable } from "./discover/index.js";
import { hashSymbol } from "./hash/index.js";
import { fileId as makeFileId, pathOfFileId, repoOfId } from "./ids.js";
import { createLangResolver, detectAllWorkspaces, langOfPath, parseFile } from "./lang/index.js";
import { encodeParsed, LazyParsedMap, ParseCache } from "./parse/cache.js";
import type { ParsedFile } from "./parse/index.js";
import { ensureDataDir, type GantryPaths } from "./paths/index.js";
import { type LoadedRecipe, loadRecipe, recipeNotes } from "./recipe/load.js";
import type { SpecifierClass } from "./resolve/index.js";
import { SiblingFiles, type SiblingRepo } from "./resolve/sibling.js";
import { refreshDescriptionFts } from "./search/descfts.js";
import { openStore, type Store, splitIdentifier } from "./store/index.js";
import type {
  AdapterNodeRecord,
  EdgeRecord,
  FileRecord,
  Layer,
  SymbolKind,
  SymbolRecord,
  WorkspaceRecord,
} from "./types.js";
import { workspaceForPath } from "./workspace/index.js";

export interface IndexResult {
  files: number;
  symbols: number;
  functionLike: number;
  edges: number;
  unresolved: {
    specifier: string;
    from: string;
    reason?: "alias_not_static";
    alias?: string;
    /** A specifier several repos publish: the workspaces that do. */
    candidates?: string[];
  }[];
  /** Distinct (file, specifier) pairs by resolution class, for the whole run (used by the M1 benchmark). */
  specifierCounts: Record<SpecifierClass, number>;
  parseErrors: { file: string; errors: string[] }[];
  /** Notes on the repo's recipe (spec section 5), for stderr: no recipe, or a rule that was skipped. */
  recipeNotes: string[];
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
  /** The adapters to run; default `ADAPTERS`. Tests use it to run one adapter alone. */
  adapters?: readonly Adapter<unknown>[];
  /** A recipe to use instead of the one the layer reads (`gantry recipe check --nodes` applies a file it was given). */
  recipe?: LoadedRecipe;
}

const READ_CONCURRENCY = 16;
/** Files parsed between two turns of the event loop (see `eventLoopTurn`). */
const TURN_EVERY = 100;
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

/**
 * Text that an import of one of `paths` contains at its end: `/name"`, `/name'`, a template quote or `/name.` for the
 * file name without its extension (and, for an `index` file, for the folder name), and the quoted package name of the
 * workspace for an `index` file. A file whose text has none of these cannot be importing one of the paths, which is
 * how a file that was waiting for one (a missing file that now exists, a deleted one that is back) is found without
 * resolving every file.
 */
function importNeedles(paths: string[], workspaces: WorkspaceRecord[]): string[] {
  const names = new Set<string>();
  const quoted = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    const stem = (parts[parts.length - 1] ?? "").replace(/\.[^.]*$/, "");
    names.add(stem);
    if (stem === "index") {
      names.add(parts[parts.length - 2] ?? "");
      quoted.add(workspaceForPath(workspaces, p).name);
    }
  }
  names.delete("");
  quoted.delete("");
  const out: string[] = [];
  for (const n of names) out.push(`/${n}"`, `/${n}'`, `/${n}\``, `/${n}.`, `"${n}"`, `'${n}'`);
  for (const n of quoted) out.push(`"${n}"`, `'${n}'`);
  return out;
}

/**
 * Lets the event loop run once. The tree-sitter trees behind the Go parser (`@ast-grep/napi`) are freed by finalizers
 * that Node queues for the next turn of the loop, so a loop that never yields keeps every tree it has dropped. On
 * grafana (7,200 Go files) the parse loop alone held 3.9 GiB of native memory, against 1.7 GiB with a turn every
 * `TURN_EVERY` files (#358). Call it inside any long loop that parses Go.
 */
const eventLoopTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

const nodeKey = (n: AdapterNodeRecord): string =>
  `${n.id}\0${n.kind}\0${n.ws}\0${n.label}\0${n.fileId}\0${JSON.stringify(n.data)}`;

function sameNodes(a: AdapterNodeRecord[], b: AdapterNodeRecord[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(nodeKey).sort();
  const kb = b.map(nodeKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function groupByFile<T extends { fileId: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const a = m.get(it.fileId) ?? [];
    a.push(it);
    m.set(it.fileId, a);
  }
  return m;
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
  const ownStore = !opts.store;
  if (ownStore) ensureDataDir(paths);
  const store = opts.store ?? openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    // A run over the whole tree indexes every repo of the workspace, in name order; a targeted run (`files` or
    // `sources`, relative to the repo the command runs in) indexes that repo only.
    const whole = opts.files === undefined && opts.sources === undefined;
    const members = whole ? paths.workspace.repos : [{ name: paths.repo, root: paths.root }];
    // A repo that left the workspace file, or changed its name, loses its rows.
    if (whole && opts.layer === "main") {
      store.removeReposExcept(paths.workspace.repos.map((r) => r.name));
    }
    const cache = ParseCache.open(paths.dataDir);
    const seen = new Set<string>();
    const results: IndexResult[] = [];
    // Every repo's workspaces are known before any repo is parsed, so an import in one repo can name a package of another.
    const known = discoverRepos(paths);
    try {
      for (const m of [...members].sort((a, b) => cmp(a.name, b.name))) {
        const r = await indexOneRepo(
          { ...paths, root: m.root, repo: m.name },
          opts,
          store,
          cache,
          seen,
          known,
        );
        results.push(r);
      }
      // Cache entries of files that no longer exist are only pruned when this run saw the whole tree of every repo.
      if (whole) cache?.prune(seen);
      // A repo that left the workspace and came back has no search rows: put its stored descriptions back into them.
      if (whole && opts.layer === "main") refreshDescriptionFts(store);
    } finally {
      cache?.close();
    }
    return mergeResults(results, Math.round(performance.now() - t0));
  } finally {
    if (ownStore) store.close();
  }
}

interface KnownRepo {
  root: string;
  config: GantryConfig;
  workspaces: WorkspaceRecord[];
}

/** The config and workspaces of every repo of the workspace (the repo the command runs in included). */
function discoverRepos(paths: GantryPaths): Map<string, KnownRepo> {
  const repos = paths.workspace.repos.some((r) => r.name === paths.repo)
    ? paths.workspace.repos
    : [...paths.workspace.repos, { name: paths.repo, root: paths.root }];
  const known = new Map<string, KnownRepo>();
  for (const r of repos) {
    const config = loadConfig({ ...paths, root: r.root, repo: r.name });
    known.set(r.name, { root: r.root, config, workspaces: detectAllWorkspaces(r.root, config, r.name) });
  }
  return known;
}

function siblingsOf(repo: string, known: Map<string, KnownRepo>): SiblingRepo[] {
  return [...known]
    .filter(([name]) => name !== repo)
    .map(([name, k]) => ({
      repo: name,
      root: k.root,
      workspaces: k.workspaces,
      parsed: new SiblingFiles(name, k.root, k.config),
    }));
}

function mergeResults(parts: IndexResult[], ms: number): IndexResult {
  const first = parts[0] as IndexResult;
  if (parts.length === 1) return { ...first, ms };
  const out: IndexResult = { ...first, ms, unresolved: [], parseErrors: [], recipeNotes: [] };
  out.files = 0;
  out.symbols = 0;
  out.functionLike = 0;
  out.edges = 0;
  out.specifierCounts = { ...first.specifierCounts };
  for (const k of Object.keys(out.specifierCounts) as SpecifierClass[]) out.specifierCounts[k] = 0;
  for (const r of parts) {
    out.files += r.files;
    out.symbols += r.symbols;
    out.functionLike += r.functionLike;
    out.edges += r.edges;
    out.unresolved.push(...r.unresolved);
    out.parseErrors.push(...r.parseErrors);
    out.recipeNotes.push(...r.recipeNotes);
    for (const k of Object.keys(out.specifierCounts) as SpecifierClass[]) {
      out.specifierCounts[k] += r.specifierCounts[k];
    }
  }
  return out;
}

/** One repo of the workspace, indexed with its own root, git state, recipe and excludes. `paths.root` and `paths.repo` name it. */
async function indexOneRepo(
  paths: GantryPaths,
  opts: IndexOptions,
  store: Store,
  cache: ParseCache | undefined,
  seen: Set<string>,
  known: Map<string, KnownRepo>,
): Promise<IndexResult> {
  const t0 = performance.now();
  const { layer, sources } = opts;
  const root = paths.root;
  const repo = paths.repo;
  // Describe-side code (fact sheets, templates) reads file text and finds the repo's root in the store.
  store.upsertRepo(repo, root);
  const { config, workspaces } = known.get(repo) as KnownRepo;

  // 1. Which files exist, and which of them are targets of this run.
  const discovered = discoverFiles(paths, config, workspaces);
  const entries = new Map<string, Entry>();
  for (const d of discovered) {
    entries.set(d.path, {
      path: d.path,
      id: makeFileId(repo, d.path),
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
          id: makeFileId(repo, p),
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
        id: makeFileId(repo, p),
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
  const cached = cache?.loadAll();
  const fresh: { key: string; hash: string; data: string }[] = [];
  let parsedCount = 0;
  for (const e of present) {
    seen.add(e.id);
    if (++parsedCount % TURN_EVERY === 0) await eventLoopTurn();
    const hit = cached?.get(e.id);
    if (hit && hit.hash === `${repo}\n${e.contentHash}`) {
      parsed.setRaw(e.id, hit.data);
      continue;
    }
    const pf = parseFile(repo, e.path, e.source as string);
    parsed.set(e.id, pf);
    fresh.push({ key: e.id, hash: `${repo}\n${e.contentHash}`, data: encodeParsed(pf) });
  }
  cache?.save(fresh);

  const resolver = createLangResolver({ root, repo, workspaces, parsed, siblings: siblingsOf(repo, known) });
  store.upsertWorkspaces(workspaces);

  // Framework adapters (routes, server functions, Hono endpoints). Their results depend on other files (route
  // parents, mounts across imports, loader calls), so they run over the full read set on every run; each node and
  // edge is then stored with the file it names, replaced per file like symbols.
  // The recipe of the tree being indexed: the main layer reads it from HEAD, the working layer from disk.
  const recipe = opts.recipe ?? loadRecipe(root, { layer });
  const routes = runAdapters(
    {
      root,
      repo,
      workspaces,
      recipe,
      // The framework adapters read TypeScript only; the recipe adapter also reads Go (`Adapter.languages`).
      files: present.map((e) => ({
        path: e.path,
        id: e.id,
        workspaceId: e.workspaceId,
        source: e.source as string,
      })),
      parsed,
      resolver,
    },
    opts.adapters,
  );
  const routeEdges = groupByFile(routes.edges);
  const routeNodes = groupByFile(routes.nodes);

  // 3. Decide what to write.
  const full = !opts.files;
  const existsNow = new Set(present.map((e) => e.id));
  const mainFiles = new Map<string, FileRecord>();
  for (const row of store.db
    .prepare("SELECT id, content_hash FROM files WHERE layer = 'main' AND deleted = 0 AND repo = ?")
    .all(repo) as { id: string; content_hash: string }[]) {
    mainFiles.set(row.id, {
      id: row.id,
      path: "",
      lang: "typescript",
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
  const missing = (full ? [...mainFiles.keys()] : [...targets].map((p) => makeFileId(repo, p))).filter(
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
      ambiguous: 0,
      unresolved: 0,
    },
    parseErrors: [],
    recipeNotes: recipeNotes(recipe),
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
    // Only this repo's search rows are rebuilt; those of the other repos of the workspace stay.
    const symPrefix = `sym:${repo}:`;
    for (const r of store.db
      .prepare(
        "SELECT symbol_id, suggested_name, behavior, search_terms FROM fts_symbols WHERE substr(symbol_id, 1, ?) = ?",
      )
      .all(symPrefix.length, symPrefix) as {
      symbol_id: string;
      suggested_name: string;
      behavior: string;
      search_terms: string;
    }[]) {
      prevFts.set(r.symbol_id, {
        suggested: r.suggested_name,
        behavior: r.behavior,
        terms: r.search_terms,
      });
    }
    store.tx(() =>
      store.db
        .prepare("DELETE FROM fts_symbols WHERE substr(symbol_id, 1, ?) = ?")
        .run(symPrefix.length, symPrefix),
    );
  }
  // A targeted run looks FTS rows up by rowid: one scan of the table per write batch instead of one per symbol
  // (a delete by the UNINDEXED symbol_id column scans the whole table; on 9,000 symbols that was most of a
  // 20-file refresh). Rebuilt at the start of every batch transaction, so a concurrent writer is seen.
  let ftsRowids: Map<string, number[]> | null = null;
  const ftsDelete = store.db.prepare("DELETE FROM fts_symbols WHERE rowid = ?");
  const rowidsOf = (): Map<string, number[]> => {
    if (ftsRowids) return ftsRowids;
    const map = new Map<string, number[]>();
    for (const r of store.db.prepare("SELECT rowid AS r, symbol_id AS id FROM fts_symbols").all() as {
      r: number;
      id: string;
    }[]) {
      const list = map.get(r.id);
      if (list) list.push(r.r);
      else map.set(r.id, [r.r]);
    }
    ftsRowids = map;
    return map;
  };
  const ftsRemove = (id: string): void => {
    const map = rowidsOf();
    for (const r of map.get(id) ?? []) ftsDelete.run(r);
    map.delete(id);
  };
  const ftsUpsert = (id: string, cols: [string, string, string, string, string]): void => {
    ftsRemove(id);
    const r = ftsInsert.run(id, ...cols);
    rowidsOf().set(id, [Number(r.lastInsertRowid)]);
  };
  const oldFtsIds = (l: Layer, fileId: string): string[] =>
    (
      store.db.prepare("SELECT id FROM symbols WHERE layer = ? AND file_id = ?").all(l, fileId) as {
        id: string;
      }[]
    ).map((r) => r.id);

  const writeOne = (e: Entry): void => {
    const pf = parsed.get(e.id) as ParsedFile;
    const source = e.source as string;
    const lang = langOfPath(e.path);
    const symbols: SymbolRecord[] = pf.symbols.map((s) => {
      const body = pf.bodies.get(s.id);
      const h = body
        ? hashSymbol(source, body, e.path)
        : {
            exactHash: "",
            renamedHash: "",
            shapeHash: "",
            minhash: new Uint32Array(64),
            nearMinhash: new Uint32Array(0),
          };
      return { ...s, lang, ...h };
    });
    const edges = [...resolver.edgesForFile(e.id), ...(routeEdges.get(e.id) ?? [])];
    const file: FileRecord = {
      id: e.id,
      path: e.path,
      lang,
      workspaceId: e.workspaceId,
      contentHash: e.contentHash as string,
      mtimeMs: Math.round(e.mtimeMs),
      deleted: false,
      ...(pf.directives && pf.directives.length > 0 ? { directives: pf.directives } : {}),
    };
    // Rows of symbols this write drops. On the working layer a symbol that main still has keeps its row (main's
    // copy is still in the store); one that only the old working row had is gone for good.
    const old = rebuildFts ? [] : oldFtsIds(layer, e.id);
    store.replaceFile(layer, file, symbols, edges, routeNodes.get(e.id) ?? []);
    const keep = new Set(symbols.map((s) => s.id));
    if (layer === "working" && old.length > 0) for (const id of oldFtsIds("main", e.id)) keep.add(id);
    for (const id of old) if (!keep.has(id)) ftsRemove(id);
    for (const s of symbols) {
      const nameTokens = splitIdentifier(s.name).join(" ");
      if (rebuildFts) {
        const p = prevFts.get(s.id);
        ftsInsert.run(s.id, nameTokens, p?.suggested ?? "", e.path, p?.behavior ?? "", p?.terms ?? "");
      } else {
        ftsUpsert(s.id, [nameTokens, "", e.path, "", ""]);
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
      ftsRowids = null;
      for (const e of batch) writeOne(e);
    });
    ftsRowids = null;
    await eventLoopTurn();
  }

  store.tx(() => {
    for (const id of clearWorking) store.clearWorking(id);
    for (const id of markDeleted) {
      if (layer === "main") removeMainFile(store, id, !rebuildFts);
      else store.markDeleted("working", id);
    }

    // Importers: files we did not write whose resolved edges differ from the effective ones.
    if (full && layer === "working") {
      // A whole-tree working run has no edited set to start from: every file is checked.
      const eff = new Map<string, EdgeRecord[]>();
      for (const ed of store.effectiveEdges()) {
        if (ed.kind === "depends_on") continue;
        const a = eff.get(ed.fileId) ?? [];
        a.push(ed);
        eff.set(ed.fileId, a);
      }
      const effNodes = groupByFile(store.effectiveAdapterNodes());
      const effFiles = new Map(store.effectiveFiles().map((f) => [f.id, f]));
      for (const e of present) {
        if (written.has(e.id)) continue;
        const file = effFiles.get(e.id);
        if (!file) continue;
        const fresh = [...resolver.edgesForFile(e.id), ...(routeEdges.get(e.id) ?? [])];
        const freshNodes = routeNodes.get(e.id) ?? [];
        if (sameEdges(fresh, eff.get(e.id) ?? []) && sameNodes(freshNodes, effNodes.get(e.id) ?? []))
          continue;
        store.replaceFile(layer, file, store.effectiveSymbols({ fileId: e.id }), fresh, freshNodes);
        written.add(e.id);
        result.edges += fresh.length;
      }
    } else if (!full) {
      // A targeted run re-resolves only the files whose edges can have changed: the importers of what was
      // written or deleted (walked on through the ones that changed, which is how a barrel passes a change on),
      // the files that carry adapter output (adapters look across files), and the files whose text names a
      // written file (an import that was waiting for it). Cost follows the edit, not the repository (#360).
      const presentById = new Map(present.map((e) => [e.id, e]));
      const checked = new Set<string>();
      const queue = new Set<string>();
      const enqueue = (id: string): void => {
        if (!checked.has(id) && !written.has(id) && presentById.has(id)) queue.add(id);
      };
      // A file whose working row was just dropped (its content is main's again) changed back, so its importers did too.
      const changedIds = [...written, ...markDeleted, ...clearWorking];
      for (const id of store.effectiveImporters(changedIds)) enqueue(id);
      for (const id of store.filesWithAdapterOutput()) enqueue(id);
      for (const id of [...routeEdges.keys(), ...routeNodes.keys()]) enqueue(id);
      const needles = importNeedles([...written, ...clearWorking].map(pathOfFileId), workspaces);
      if (needles.length > 0) {
        for (const e of present) if (needles.some((n) => (e.source as string).includes(n))) enqueue(e.id);
      }
      while (queue.size > 0) {
        const round = [...queue];
        queue.clear();
        for (const id of round) checked.add(id);
        const eff = new Map<string, EdgeRecord[]>();
        for (const ed of store.effectiveEdgesOfFiles(round)) {
          if (ed.kind === "depends_on") continue;
          const a = eff.get(ed.fileId) ?? [];
          a.push(ed);
          eff.set(ed.fileId, a);
        }
        const effNodes = groupByFile(store.effectiveAdapterNodesOfFiles(round));
        const changed: string[] = [];
        for (const id of round) {
          const file = store.effectiveFile(id);
          if (!file) continue;
          const fresh = [...resolver.edgesForFile(id), ...(routeEdges.get(id) ?? [])];
          const freshNodes = routeNodes.get(id) ?? [];
          if (sameEdges(fresh, eff.get(id) ?? []) && sameNodes(freshNodes, effNodes.get(id) ?? [])) continue;
          store.replaceFile(layer, file, store.effectiveSymbols({ fileId: id }), fresh, freshNodes);
          written.add(id);
          changed.push(id);
          result.edges += fresh.length;
        }
        for (const id of store.effectiveImporters(changed)) enqueue(id);
      }
    }

    if (layer === "main") {
      if (full) removeStaleMain(store, repo, new Set([...existsNow, ...pkgIds]), !rebuildFts);
      writeDependsOn(store, root, repo, workspaces, wsEdges);
      if (full) {
        result.edges += wsEdges.length;
        const sha = headSha(root);
        if (sha) store.setHeadSha(repo, sha);
        store.setMeta("indexed_at", new Date().toISOString());
      }
    }
  });

  const pathOf = (id: string): string => pathOfFileId(id);
  const stats = resolver.stats();
  result.specifierCounts = stats.counts;
  result.unresolved = stats.unresolved
    .filter((u) => written.has(u.fromFileId) || full)
    .map((u) => ({
      specifier: u.specifier,
      from: pathOf(u.fromFileId),
      ...(u.reason ? { reason: u.reason, alias: u.alias as string } : {}),
      ...(u.candidates ? { candidates: u.candidates } : {}),
    }));
  result.parseErrors.sort((a, b) => cmp(a.file, b.file));
  result.ms = Math.round(performance.now() - t0);
  return result;
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
  store.db.prepare("DELETE FROM adapter_nodes WHERE layer = 'main' AND file_id = ?").run(fileId);
  store.db.prepare("DELETE FROM files WHERE layer = 'main' AND id = ?").run(fileId);
}

function removeStaleMain(store: Store, repo: string, keep: Set<string>, removeFts: boolean): void {
  const rows = store.db.prepare("SELECT id FROM files WHERE layer = 'main' AND repo = ?").all(repo) as {
    id: string;
  }[];
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
  repo: string,
  workspaces: WorkspaceRecord[],
  edges: EdgeRecord[],
): void {
  const byFile = new Map<string, EdgeRecord[]>();
  for (const e of edges) {
    const a = byFile.get(e.fileId) ?? [];
    a.push(e);
    byFile.set(e.fileId, a);
  }
  const manifestOf = (w: WorkspaceRecord): string => (w.lang === "go" ? "go.mod" : "package.json");
  const wsOfDir = new Map(
    workspaces.map((w) => [makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}${manifestOf(w)}`), w]),
  );
  for (const [fileId, es] of [...byFile].sort((a, b) => cmp(a[0], b[0]))) {
    const rel = pathOfFileId(fileId);
    const { hash, mtimeMs } = readJsonHash(root, rel);
    store.replaceFile(
      "main",
      {
        id: fileId,
        path: rel,
        lang: wsOfDir.get(fileId)?.lang ?? "typescript", // a manifest belongs to the language that found the workspace
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
  repos: { name: string }[];
  workspaces: unknown[];
  files: unknown[];
  symbols: unknown[];
  edges: unknown[];
  adapterNodes?: unknown[];
} {
  // Names only: a local path would make the dump depend on the machine.
  const repos = store.listRepos().map((r) => ({ name: r.name }));
  const wsRows = store.db.prepare("SELECT * FROM workspaces ORDER BY id").all() as Json[];
  const workspaces = wsRows.map((w) => ({
    id: w.id,
    repo: w.repo,
    name: w.name,
    dir: w.dir,
    kind: w.kind,
    frameworks: JSON.parse((w.frameworks as string) ?? "[]"),
    deps: JSON.parse((w.deps as string) ?? "[]"),
    exportsMap: JSON.parse((w.exports_map as string) ?? "null"),
  }));
  const files = store.effectiveFiles().map((f) => ({
    id: f.id,
    repo: repoOfId(f.id),
    path: f.path,
    lang: f.lang,
    workspaceId: f.workspaceId,
    contentHash: f.contentHash,
    ...(f.directives && f.directives.length > 0 ? { directives: f.directives } : {}),
  }));
  // minhash and nearMinhash (64 words per symbol each) and renamedHash (a 32-char hex string) are omitted: fully determined by the source.
  const symbols = store
    .effectiveSymbols()
    .map(({ minhash: _m, nearMinhash: _t, renamedHash: _r, ...s }) => s);
  // similar_to edges are derived (rebuilt by init/heal/embed from hashes and vectors), not part of the index.
  const edges = store.effectiveEdges().filter((e) => e.kind !== "similar_to");
  // Adapter nodes (routes) appear only when an adapter found some, so repositories without them dump as before.
  const adapterNodes = store.effectiveAdapterNodes();
  return { repos, workspaces, files, symbols, edges, ...(adapterNodes.length > 0 ? { adapterNodes } : {}) };
}

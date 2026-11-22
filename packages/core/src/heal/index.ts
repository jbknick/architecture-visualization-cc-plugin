import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeCatalog } from "../catalog/index.js";
import { loadConfig } from "../config/index.js";
import { isIndexable } from "../discover/index.js";
import { rebuildSimilarEdges } from "../dup/index.js";
import { fileId } from "../ids.js";
import { indexRepo } from "../indexer.js";
import { reattachOverlay } from "../overlay/reattach.js";
import { type GantryPaths, pathsForRepo } from "../paths/index.js";
import { loadRecipe } from "../recipe/load.js";
import { isQueryFile } from "../recipe/query-files.js";
import { refreshDescriptionFts } from "../search/descfts.js";
import { openStore, type Store } from "../store/index.js";

/** Above this share of indexed files touched by a diff, a full main re-index is cheaper than patching. */
const FULL_REINDEX_RATIO = 0.3;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/** Changes to these files can move workspace boundaries or resolution for files that did not change. */
const STRUCTURAL = /(^|\/)(package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml|nx\.json|turbo\.json)$/;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/**
 * Every git call here only reads. `--no-optional-locks` keeps `git status` from taking `.git/index.lock` to refresh
 * the index, so the explorer's stale check (on every request) never collides with the user's own commit or rebase.
 */
function git(root: string, args: string[], input?: string): { ok: boolean; out: Buffer } {
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], {
    cwd: root,
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
}

function revParseHead(root: string): string | undefined {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.toString("utf8").trim() || undefined : undefined;
}

/** `git diff --name-status -z --no-renames old new` as [status letter, path] pairs. */
function diffNameStatus(root: string, from: string, to: string): [string, string][] | undefined {
  const r = git(root, ["diff", "--name-status", "-z", "--no-renames", from, to]);
  if (!r.ok) return undefined;
  const tok = r.out.toString("utf8").split("\0");
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < tok.length; i += 2)
    out.push([(tok[i] as string)[0] as string, tok[i + 1] as string]);
  return out;
}

/** Blob text at `rev:<path>` for many paths in one `git cat-file --batch` process. Missing paths are omitted. */
function readBlobs(root: string, rev: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const usable = paths.filter((p) => !p.includes("\n"));
  if (usable.length === 0) return out;
  const r = git(root, ["cat-file", "--batch"], `${usable.map((p) => `${rev}:${p}`).join("\n")}\n`);
  const buf = r.out;
  let pos = 0;
  for (const p of usable) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<spec> missing"
    const size = Number(m[2]);
    if (m[1] === "blob") out.set(p, buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1;
  }
  return out;
}

interface FileRow {
  id: string;
  path: string;
  content_hash: string;
  mtime_ms: number;
  deleted: number;
}

function layerRows(store: Store, layer: "main" | "working", repo: string): Map<string, FileRow> {
  const rows = store.db
    .prepare("SELECT id, path, content_hash, mtime_ms, deleted FROM files WHERE layer = ? AND repo = ?")
    .all(layer, repo) as FileRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function diskHash(root: string, rel: string): string | undefined {
  try {
    return sha256(fs.readFileSync(path.join(root, rel)));
  } catch {
    return undefined;
  }
}

/**
 * Drops working rows that the working tree no longer differs from main on: same bytes as main's row,
 * or an orphan row for a file that is gone on both sides.
 */
function pruneWorking(store: Store, root: string, repo: string, ids: Iterable<string>): void {
  const working = layerRows(store, "working", repo);
  const main = layerRows(store, "main", repo);
  for (const id of ids) {
    const w = working.get(id);
    if (!w) continue;
    const m = main.get(id);
    const h = diskHash(root, w.path);
    const mainLive = m !== undefined && m.deleted === 0;
    if (h === undefined) {
      if (!mainLive) store.clearWorking(id);
    } else if (!w.deleted && mainLive && h === m?.content_hash) {
      store.clearWorking(id);
    }
  }
}

/** Working rows with main's content hash and main's edges carry nothing; the effective view is the same without them. */
function dropRedundantWorking(store: Store, repo: string): void {
  const rows = store.db
    .prepare(
      `SELECT w.id FROM files w JOIN files m ON m.id = w.id AND m.layer = 'main' AND m.deleted = 0
       WHERE w.layer = 'working' AND w.deleted = 0 AND w.content_hash = m.content_hash AND w.repo = ?`,
    )
    .all(repo) as { id: string }[];
  const edges = store.db.prepare(
    "SELECT src, dst, kind, confidence, count, evidence, level, text_file_id, source FROM edges WHERE layer = ? AND file_id = ? ORDER BY src, dst, kind",
  );
  const nodes = store.db.prepare(
    "SELECT id, kind, ws, label, data FROM adapter_nodes WHERE layer = ? AND file_id = ? ORDER BY id",
  );
  for (const { id } of rows) {
    if (
      JSON.stringify(edges.all("working", id)) === JSON.stringify(edges.all("main", id)) &&
      JSON.stringify(nodes.all("working", id)) === JSON.stringify(nodes.all("main", id))
    ) {
      store.clearWorking(id);
    }
  }
}

/**
 * Holds the store write lock across async work: `BEGIN IMMEDIATE` waits up to the busy timeout, and
 * the indexer's own transactions nest inside it as savepoints. A failure rolls everything back.
 */
async function withWriteLock<T>(paths: GantryPaths, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const r = await fn(store);
      store.db.exec("COMMIT");
      return r;
    } catch (err) {
      if (store.db.inTransaction) store.db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    store.close();
  }
}

function indexedFileCount(store: Store, repo: string): number {
  const r = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM files WHERE layer = 'main' AND deleted = 0 AND repo = ? AND path NOT LIKE '%package.json'",
    )
    .get(repo) as { n: number };
  return r.n;
}

/** The repos a heal or refresh covers: the one named, or every repo of the workspace in name order. */
function targets(paths: GantryPaths, repo: string | undefined): GantryPaths[] {
  return repo !== undefined
    ? [pathsForRepo(paths, repo)]
    : paths.workspace.repos.map((r) => pathsForRepo(paths, r.name));
}

/**
 * Brings the main layer to `HEAD` (spec section 11), repo by repo. With `opts.repo` only that repo is healed; without it
 * every repo of the workspace is, in turn. Rows of the other repos are never deleted or rewritten.
 */
export async function heal(
  paths: GantryPaths,
  opts?: { from?: string; reattach?: boolean; repo?: string },
): Promise<{ changed: number; full: boolean; ms: number }> {
  const t0 = performance.now();
  if (opts?.from !== undefined && opts.repo === undefined && paths.workspace.repos.length > 1) {
    throw new Error("a starting commit names one repo: pass the repo with it");
  }
  let changed = 0;
  let full = false;
  for (const p of targets(paths, opts?.repo)) {
    const r = await healRepo(p, { from: opts?.from, reattach: opts?.reattach });
    changed += r.changed;
    full ||= r.full;
  }
  return { changed, full, ms: Math.round(performance.now() - t0) };
}

/**
 * One repo: incremental from `repos.head_sha` of `paths.repo` (or `opts.from`) when the diff is small, a full re-index
 * of that repo otherwise. Never calls a model. With `opts.reattach` it also
 * re-attaches hand-picked overlay entries to moved functions (#288); a Claude Code hook never sets it (budget).
 */
async function healRepo(
  paths: GantryPaths,
  opts?: { from?: string; reattach?: boolean },
): Promise<{ changed: number; full: boolean; ms: number }> {
  const t0 = performance.now();
  const done = (changed: number, full: boolean) => ({
    changed,
    full,
    ms: Math.round(performance.now() - t0),
  });
  const root = paths.root;

  return withWriteLock(paths, async (store) => {
    // Read after taking the lock: a concurrent heal that finished first leaves head_sha == HEAD.
    const oldSha = opts?.from ?? store.headSha(paths.repo);
    const newSha = revParseHead(root);
    if (!newSha) return done(0, false);
    if (oldSha === newSha) {
      // Nothing to heal, but a hook may have healed this commit without re-attaching (hooks never do).
      if (opts?.reattach) reattachOverlay(store);
      return done(0, false);
    }

    const reachable = oldSha !== undefined && git(root, ["cat-file", "-e", `${oldSha}^{commit}`]).ok;
    const config = loadConfig(paths);
    const diff = reachable ? diffNameStatus(root, oldSha as string, newSha) : undefined;
    const total = indexedFileCount(store, paths.repo);

    // A query file (read by a recipe's `query` rule) is not indexable but its edit changes the edges of Go files.
    const recipe = loadRecipe(root, { layer: "main" }).recipe;
    const changedPaths = diff?.filter(([, p]) => isIndexable(p, config) || isQueryFile(recipe, p)) ?? [];
    const structural = diff?.some(([, p]) => STRUCTURAL.test(p)) ?? false;
    const full = !diff || structural || total === 0 || changedPaths.length > total * FULL_REINDEX_RATIO;

    let changed: number;
    if (full) {
      const r = await indexRepo(paths, { layer: "main", store, singleRepo: true });
      changed = r.files;
      store.setHeadSha(paths.repo, newSha);
      pruneWorking(store, root, paths.repo, layerRows(store, "working", paths.repo).keys());
    } else {
      const live = changedPaths.filter(([s]) => s !== "D").map(([, p]) => p);
      const gone = changedPaths.filter(([s]) => s === "D").map(([, p]) => p);
      changed = changedPaths.length;
      if (changed > 0) {
        // Blobs, not the working tree: main must equal HEAD whatever the tree looks like.
        const sources = readBlobs(root, newSha, live);
        const ghosts = live.filter((p) => !sources.has(p)); // not a blob at `new` (e.g. a submodule)
        await indexRepo(paths, {
          layer: "main",
          files: [...sources.keys(), ...gone, ...ghosts],
          sources,
          store,
        });
        store.setMeta("indexed_at", new Date().toISOString());
        pruneWorking(
          store,
          root,
          paths.repo,
          changedPaths.map(([, p]) => fileId(paths.repo, p)),
        );
        // Edges of the files still modified in the tree may point into what just changed.
        const keep = [...layerRows(store, "working", paths.repo).values()]
          .filter((w) => !w.deleted && isIndexable(w.path, config))
          .map((w) => w.path);
        if (keep.length > 0) await indexRepo(paths, { layer: "working", files: keep, store });
        dropRedundantWorking(store, paths.repo);
      }
      store.setHeadSha(paths.repo, newSha);
    }
    // Derived edges follow the main layer; exact and near only (vector edges are rebuilt by `gantry embed`).
    if (changed > 0) await rebuildSimilarEdges(store, { tiers: ["exact", "near"], repo: paths.repo });
    if (changed > 0) {
      // Incremental indexing rewrites FTS rows without description columns; then the catalog follows the graph.
      refreshDescriptionFts(store);
      try {
        writeCatalog(store, paths);
      } catch {
        // the catalog is a convenience; a failed write must not fail a heal
      }
    }
    // Hand-picked overlay entries follow their function to its new id (spec section 11). It runs even when this
    // heal changed nothing: it writes only when an id changes.
    if (opts?.reattach) reattachOverlay(store);
    return done(changed, full);
  });
}

/** Paths from `git status --porcelain=v1 -z --untracked-files=all`, renames contributing both names. */
function statusPaths(root: string): string[] {
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!r.ok) return [];
  const tok = r.out.toString("utf8").split("\0");
  const out: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i] as string;
    if (t.length < 4) continue;
    out.push(t.slice(3));
    if (t[0] === "R" || t[0] === "C" || t[1] === "R" || t[1] === "C") {
      const orig = tok[++i];
      if (orig) out.push(orig);
    }
  }
  return out;
}

/**
 * Makes the working layer equal the working tree: re-indexes dirty files whose mtime differs from the
 * stored one, marks removed files deleted, and drops working rows for files that match main again.
 */
export async function refreshWorking(
  paths: GantryPaths,
  opts?: { reattach?: boolean; repo?: string },
): Promise<{ reindexed: number; cleared: number; ms: number }> {
  const t0 = performance.now();
  let reindexed = 0;
  let cleared = 0;
  for (const p of targets(paths, opts?.repo)) {
    const r = await refreshWorkingRepo(p, opts?.reattach);
    reindexed += r.reindexed;
    cleared += r.cleared;
  }
  return { reindexed, cleared, ms: Math.round(performance.now() - t0) };
}

async function refreshWorkingRepo(
  paths: GantryPaths,
  reattach: boolean | undefined,
): Promise<{ reindexed: number; cleared: number; ms: number }> {
  const t0 = performance.now();
  const root = paths.root;
  const config = loadConfig(paths);

  return withWriteLock(paths, async (store) => {
    const dirty = new Set(statusPaths(root).filter((p) => isIndexable(p, config)));
    const working = layerRows(store, "working", paths.repo);
    const main = layerRows(store, "main", paths.repo);
    const before = new Set(working.keys());

    const reindex: string[] = [];
    const targets = new Set<string>();
    for (const p of [...dirty].sort()) {
      const id = fileId(paths.repo, p);
      const w = working.get(id);
      let mtime: number | undefined;
      try {
        mtime = Math.round(fs.statSync(path.join(root, p)).mtimeMs);
      } catch {
        mtime = undefined;
      }
      const m = main.get(id);
      const mainLive = m !== undefined && m.deleted === 0;
      if (mtime === undefined) {
        if (w?.deleted) continue;
        if (mainLive) targets.add(p);
        else if (w) store.clearWorking(id); // created and removed before it ever reached main
        continue;
      }
      const row = w ?? m;
      if (!row || row.deleted || row.mtime_ms !== mtime) {
        reindex.push(p);
        targets.add(p);
      }
    }
    // Rows for files git no longer lists: the tree matches HEAD there again, unless the row only
    // carries re-resolved edges for an unchanged file.
    for (const w of working.values()) {
      if (dirty.has(w.path)) continue;
      const m = main.get(w.id);
      const edgeOnly = !w.deleted && m !== undefined && m.deleted === 0 && m.content_hash === w.content_hash;
      if (edgeOnly) continue;
      store.clearWorking(w.id);
      // Fixes importers' edges below; a file that is gone on both sides has nothing to index.
      if (isIndexable(w.path, config) && (m !== undefined || diskHash(root, w.path) !== undefined)) {
        targets.add(w.path);
      }
    }

    if (targets.size > 0) {
      await indexRepo(paths, { layer: "working", files: [...targets], store });
      refreshDescriptionFts(store); // re-indexed rows start without their description columns
    }
    dropRedundantWorking(store, paths.repo);
    store.setMeta("last_refresh_at", new Date().toISOString());

    const after = layerRows(store, "working", paths.repo);
    let cleared = 0;
    for (const id of before) if (!after.has(id)) cleared++;
    if (reattach) reattachOverlay(store);
    return { reindexed: reindex.length, cleared, ms: Math.round(performance.now() - t0) };
  });
}

export interface StaleFiles {
  /** Repo-relative paths that the next heal plus `refreshWorking` would re-index or drop, sorted. */
  files: string[];
  /** True when `HEAD` is not the commit the main layer was built for (a heal is due). */
  head: boolean;
}

function hasMainIndex(paths: GantryPaths): boolean {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    return store.getMeta("indexed_at") !== undefined;
  } finally {
    store.close();
  }
}

/**
 * Builds the index of a store that `resetStaleStore` just deleted (spec section 11): a heal, which indexes everything
 * because the new store has no `head_sha`; outside a commit (no `HEAD`) it is a plain full main index.
 */
export async function rebuildIndex(paths: GantryPaths): Promise<void> {
  await heal(paths, { reattach: true });
  if (!hasMainIndex(paths)) await indexRepo(paths, { layer: "main" });
}

/** True when `HEAD` of any repo of the workspace is not the commit its main layer was built for, so a heal is due. One `git rev-parse` per repo. */
export function healPending(paths: GantryPaths, store: Store): boolean {
  return paths.workspace.repos.some((r) => {
    const headSha = revParseHead(r.root);
    return headSha !== undefined && store.headSha(r.name) !== headSha;
  });
}

/**
 * What changed since the index was last brought up to date, without re-indexing or writing anything (spec section
 * 11 (c)): the same `git status` plus mtime test as `refreshWorking`, and the `git diff` of a pending heal. Cheap
 * enough to run before every explorer request; reads through the caller's open store. `repo` names another repo of the
 * workspace (default: the repo `paths` is for).
 */
export function staleFiles(workspacePaths: GantryPaths, store: Store, repo?: string): StaleFiles {
  const paths = repo === undefined ? workspacePaths : pathsForRepo(workspacePaths, repo);
  const root = paths.root;
  const config = loadConfig(paths);
  const out = new Set<string>();
  const stored = store.headSha(paths.repo);
  const headSha = revParseHead(root);
  const head = headSha !== undefined && stored !== headSha;
  if (head && stored !== undefined && git(root, ["cat-file", "-e", `${stored}^{commit}`]).ok) {
    for (const [, p] of diffNameStatus(root, stored, headSha as string) ?? [])
      if (isIndexable(p, config)) out.add(p);
  }

  const dirty = new Set(statusPaths(root).filter((p) => isIndexable(p, config)));
  const working = layerRows(store, "working", paths.repo);
  const main = layerRows(store, "main", paths.repo);
  for (const p of dirty) {
    const id = fileId(paths.repo, p);
    const w = working.get(id);
    const m = main.get(id);
    const mainLive = m !== undefined && m.deleted === 0;
    let mtime: number | undefined;
    try {
      mtime = Math.round(fs.statSync(path.join(root, p)).mtimeMs);
    } catch {
      mtime = undefined;
    }
    if (mtime === undefined) {
      if (w?.deleted) continue;
      if (mainLive || w) out.add(p);
      continue;
    }
    const row = w ?? m;
    if (!row || row.deleted || row.mtime_ms !== mtime) out.add(p);
  }
  for (const w of working.values()) {
    if (dirty.has(w.path)) continue;
    const m = main.get(w.id);
    const edgeOnly = !w.deleted && m !== undefined && m.deleted === 0 && m.content_hash === w.content_hash;
    if (!edgeOnly) out.add(w.path);
  }
  return { files: [...out].sort(), head };
}

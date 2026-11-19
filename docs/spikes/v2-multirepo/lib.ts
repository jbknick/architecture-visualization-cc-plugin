// Prototype helpers for the v2-multirepo spike: one store with a repo column, built by merging each repo's own
// indexRepo pass; per-repo replace; row hashes; duplicate groups. Prototype only, nothing here is production code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type GantryPaths,
  indexRepo,
  openStore,
  resolvePaths,
  type Store,
} from "../../../packages/core/dist/index.js";

type Db = Store["db"];

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An environment whose HOME is `home`, so the data dir (`~/.gantry/data/repos/<hash>`) is fresh and ours. */
export function envFor(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  e.CLAUDE_PLUGIN_DATA = undefined;
  e.CLAUDE_PLUGIN_ROOT = undefined;
  return e;
}

export const pathsFor = (root: string, home: string): GantryPaths => resolvePaths(root, envFor(home));

export function loadAvg(): string {
  return execFileSync("uptime", { encoding: "utf8" })
    .replace(/^.*load averages?: /, "")
    .trim();
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** A private copy of a pinned clone at the same commit, with the same `origin` URL (so the repo name is the same). */
export function copyClone(src: string, dest: string): void {
  const sha = git(src, "rev-parse", "HEAD");
  const url = git(src, "remote", "get-url", "origin");
  execFileSync("git", ["clone", "-q", "--no-checkout", src, dest], { stdio: "ignore" });
  git(dest, "checkout", "-q", "--detach", sha);
  git(dest, "remote", "set-url", "origin", url);
}

/** Index one repo into its own store (the "separate store" case). */
export async function indexSeparate(
  paths: GantryPaths,
): Promise<{ ms: number; files: number; symbols: number }> {
  const r = await indexRepo(paths, { layer: "main" });
  return { ms: r.ms, files: r.files, symbols: r.symbols };
}

/** Folds the WAL into the main file and returns the file size in bytes. */
export function dbBytes(dbPath: string): number {
  const s = openStore(dbPath);
  s.db.pragma("wal_checkpoint(TRUNCATE)");
  s.close();
  return fs.statSync(dbPath).size;
}

/** The one store: the stock schema plus a `repo` column on `files` and `workspaces` (workspace key becomes (repo, id)). */
export function createCombined(dbPath: string): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = openStore(dbPath);
  store.db.exec(`
    DROP TABLE workspaces;
    CREATE TABLE workspaces(repo TEXT NOT NULL, id TEXT, name TEXT, dir TEXT,
      kind TEXT CHECK(kind IN ('app','package','unknown')), frameworks TEXT, deps TEXT, exports_map TEXT,
      PRIMARY KEY(repo, id));
    ALTER TABLE files ADD COLUMN repo TEXT;
    CREATE INDEX files_repo ON files(repo);
  `);
  return store;
}

const META_KEYS = ["repo", "repo_root", "head_sha", "indexed_at"];

/** Copies every row of a finished single-repo store into the combined store, tagging files and workspaces with `repo`. */
export function mergeRepo(store: Store, srcDbPath: string, repo: string): void {
  store.db.prepare("ATTACH DATABASE ? AS src").run(srcDbPath);
  try {
    store.tx(() => {
      const d = store.db;
      d.prepare(
        `INSERT INTO workspaces(repo, id, name, dir, kind, frameworks, deps, exports_map)
         SELECT ?, id, name, dir, kind, frameworks, deps, exports_map FROM src.workspaces`,
      ).run(repo);
      d.prepare(
        `INSERT INTO files(id, layer, path, workspace_id, content_hash, mtime_ms, deleted, directives, lang, repo)
         SELECT id, layer, path, workspace_id, content_hash, mtime_ms, deleted, directives, lang, ? FROM src.files`,
      ).run(repo);
      d.exec("INSERT INTO symbols SELECT * FROM src.symbols");
      d.exec("INSERT INTO edges SELECT * FROM src.edges");
      d.exec("INSERT INTO adapter_nodes SELECT * FROM src.adapter_nodes");
      d.exec(
        `INSERT INTO fts_symbols(symbol_id, name_tokens, suggested_name, path, behavior, search_terms)
         SELECT symbol_id, name_tokens, suggested_name, path, behavior, search_terms FROM src.fts_symbols`,
      );
      // `meta` is one flat key space: per-repo keys get the repo in the key.
      const metaIns = d.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
      for (const k of META_KEYS) {
        const r = d.prepare("SELECT value FROM src.meta WHERE key = ?").get(k) as
          | { value: string }
          | undefined;
        if (r) metaIns.run(`${repo}|${k}`, r.value);
      }
    });
  } finally {
    store.db.exec("DETACH DATABASE src");
  }
}

/** Removes every row of `repo` from the combined store (files, symbols, edges, adapter nodes, workspaces, search rows). */
export function dropRepo(store: Store, repo: string): void {
  store.tx(() => {
    const d = store.db;
    const inRepo = "SELECT id FROM files WHERE repo = ?";
    d.prepare(`DELETE FROM symbols WHERE file_id IN (${inRepo})`).run(repo);
    d.prepare(`DELETE FROM edges WHERE file_id IN (${inRepo})`).run(repo);
    d.prepare(`DELETE FROM adapter_nodes WHERE file_id IN (${inRepo})`).run(repo);
    d.prepare("DELETE FROM files WHERE repo = ?").run(repo);
    d.prepare("DELETE FROM workspaces WHERE repo = ?").run(repo);
    const prefix = `sym:${repo}:`;
    d.prepare("DELETE FROM fts_symbols WHERE substr(symbol_id, 1, ?) = ?").run(prefix.length, prefix);
  });
}

type Row = Record<string, unknown>;

/** sha256 over one repo's rows, ordered by id, per table and overall. `derived` adds the similar_to edges. */
export function repoRowHashes(db: Db, repo: string, derived: boolean): Record<string, string> {
  const similar = derived ? "" : "AND e.kind != 'similar_to'";
  const q: Record<string, string> = {
    files: "SELECT * FROM files WHERE repo = @repo ORDER BY id, layer",
    symbols: `SELECT s.* FROM symbols s JOIN files f ON f.id = s.file_id AND f.layer = s.layer
              WHERE f.repo = @repo ORDER BY s.id, s.layer`,
    edges: `SELECT e.* FROM edges e JOIN files f ON f.id = e.file_id AND f.layer = e.layer
            WHERE f.repo = @repo ${similar} ORDER BY e.src, e.dst, e.kind, e.layer`,
    adapter_nodes: `SELECT n.* FROM adapter_nodes n JOIN files f ON f.id = n.file_id AND f.layer = n.layer
                    WHERE f.repo = @repo ORDER BY n.id, n.layer`,
  };
  const out: Record<string, string> = {};
  const all = createHash("sha256");
  for (const [table, sql] of Object.entries(q)) {
    const h = createHash("sha256");
    for (const row of db.prepare(sql).iterate({ repo }) as Iterable<Row>) {
      const line = JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v));
      h.update(line).update("\n");
    }
    const hex = h.digest("hex");
    out[table] = hex;
    all.update(table).update(hex);
  }
  out.all = all.digest("hex");
  return out;
}

export interface Group {
  key: string;
  members: string[];
}

/** Duplicate groups: connected components (>= 2 symbols) of the main-layer `similar_to` edges. */
export function dupGroups(db: Db): { groups: Group[]; edges: string[] } {
  const rows = db
    .prepare("SELECT src, dst, evidence FROM edges WHERE kind = 'similar_to' AND layer = 'main'")
    .all() as { src: string; dst: string; evidence: string }[];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while ((parent.get(r) as string) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const e of rows) parent.set(find(e.src), find(e.dst));
  const by = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    by.set(r, [...(by.get(r) ?? []), id]);
  }
  const groups = [...by.values()].map((m) => {
    const members = m.sort();
    return { key: members.join("|"), members };
  });
  groups.sort((a, b) => (a.key < b.key ? -1 : 1));
  const edges = rows.map((e) => `${e.src}|${e.dst}|${e.evidence}`).sort();
  return { groups, edges };
}

// Turns an estimated area (node ids) and a pull request into file sets, for run.ts (radius) and score.ts.
// Everything here reads git only (the history clone), so a score never depends on an index.
import { join } from "node:path";
import {
  type GantryPaths,
  isIndexable,
  loadConfig,
  parseId,
  reviewDiff,
} from "../../../packages/core/src/index.js";
import { git, historyClone, type Pr } from "./lib.js";

export interface AreaNode {
  id: string;
  confidence: number;
}

const config = loadConfig({ configPath: "/nonexistent", globalConfigPath: "/nonexistent" } as GantryPaths);

/** GantryPaths over the bare history clone: reviewDiff only reads blobs with `git show` and needs root, repo and config. */
export function clonePaths(repoName: string, slug: string): GantryPaths {
  const root = historyClone(repoName);
  return {
    root,
    repo: slug,
    worktreeHash: "",
    dataDir: join(root, "none"),
    dbPath: join(root, "none", "gantry.db"),
    overlayPath: join(root, "none", "overlay.db"),
    configPath: "/nonexistent",
    catalogDir: "",
    logsDir: "",
    globalConfigPath: "/nonexistent",
    shimPath: "",
  };
}

const treeCache = new Map<string, string[]>();
/** Every indexable file of a commit (`git ls-tree`), sorted. */
export function indexableFilesAt(repoName: string, commit: string): string[] {
  const key = `${repoName}@${commit}`;
  let files = treeCache.get(key);
  if (!files) {
    files = git(historyClone(repoName), "ls-tree", "-r", "--name-only", commit)
      .split("\n")
      .filter((p) => p !== "" && isIndexable(p, config));
    treeCache.set(key, files);
  }
  return files;
}

const wsCache = new Map<string, Map<string, string>>();
/** Workspace name -> directory, from the package.json files of a commit (only read when an area names a `ws:` node). */
function workspacesAt(repoName: string, commit: string): Map<string, string> {
  const key = `${repoName}@${commit}`;
  let map = wsCache.get(key);
  if (!map) {
    map = new Map();
    const clone = historyClone(repoName);
    const manifests = git(clone, "ls-tree", "-r", "--name-only", commit)
      .split("\n")
      .filter((p) => (p === "package.json" || p.endsWith("/package.json")) && !p.includes("node_modules/"));
    for (const m of manifests) {
      try {
        const name = (JSON.parse(git(clone, "show", `${commit}:${m}`)) as { name?: string }).name;
        if (name) map.set(name, m === "package.json" ? "" : m.slice(0, -"/package.json".length));
      } catch {
        // an unreadable or invalid manifest names no workspace
      }
    }
    wsCache.set(key, map);
  }
  return map;
}

/** The files a node stands for at `base`: a `sym:` or `file:` its file, a `dir:` or `ws:` every indexable file under it. */
export function nodeFiles(repoName: string, base: string, id: string): string[] {
  const parsed = parseId(id);
  if (parsed && (parsed.kind === "sym" || parsed.kind === "file") && parsed.path) return [parsed.path];
  // The short form a person types, which the tools accept too (spec section 6, `qualifyId`): `file:<path>`, `sym:<path>#<name>`.
  if (id.startsWith("file:")) return [id.slice("file:".length)];
  if (id.startsWith("sym:") && id.includes("#")) return [id.slice("sym:".length, id.lastIndexOf("#"))];
  let dir: string | undefined;
  if (id.startsWith("dir:")) dir = id.slice("dir:".length).replace(/^\/+|\/+$/g, "");
  else if (id.startsWith("ws:")) dir = workspacesAt(repoName, base).get(id.slice("ws:".length));
  if (dir === undefined) return [];
  const prefix = dir === "" ? "" : `${dir}/`;
  return indexableFilesAt(repoName, base).filter((p) => p.startsWith(prefix));
}

export function areaFiles(repoName: string, base: string, area: readonly AreaNode[]): Set<string> {
  const out = new Set<string>();
  for (const n of area) for (const f of nodeFiles(repoName, base, n.id)) out.add(f);
  return out;
}

/** The indexable files a pull request changed: `reviewDiff(base, merge)` files, deleted files included. */
export async function actualFiles(
  pr: Pr,
  slug: string,
): Promise<{ files: Set<string>; diff: Awaited<ReturnType<typeof reviewDiff>> }> {
  const diff = await reviewDiff(clonePaths(pr.repo, slug), pr.base, pr.merge);
  return { files: new Set(diff.files.map((f) => f.path)), diff };
}

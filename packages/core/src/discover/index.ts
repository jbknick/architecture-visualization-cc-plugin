import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { BUILTIN_EXCLUDES, type GantryConfig } from "../config/index.js";
import type { GantryPaths } from "../paths/index.js";
import type { WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";

export interface DiscoveredFile {
  path: string;
  workspaceId: string;
  size: number;
  mtimeMs: number;
}

/** Files larger than this are skipped (issue #12 step 5). */
export const MAX_FILE_BYTES = 1024 * 1024;

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Sensitive path patterns (spec section 5). Matched by path only, never by content.
 * Exported so the MCP server and hooks reuse the same list.
 */
export const SENSITIVE_PATTERNS: readonly string[] = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "id_rsa*",
  ".npmrc",
  "credentials*",
  "secrets*",
  "*.tfvars",
];

const matcherCache = new Map<string, (s: string) => boolean>();
function matcher(pattern: string, nocase = false): (s: string) => boolean {
  const key = `${nocase ? "i" : "s"}:${pattern}`;
  let m = matcherCache.get(key);
  if (!m) {
    m = picomatch(pattern, { dot: true, nocase });
    matcherCache.set(key, m);
  }
  return m;
}

/**
 * Normalise to a clean repo-relative POSIX path, or null when the path is empty, absolute,
 * has a drive letter, or escapes the repo root via `..`.
 */
function safeNormalize(repoRelPath: string): string | null {
  const slashed = repoRelPath.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const p = path.posix.normalize(slashed);
  if (p === "." || p === ".." || p.startsWith("../") || p.startsWith("/")) return null;
  return p;
}

function normalize(repoRelPath: string): string {
  return safeNormalize(repoRelPath) ?? repoRelPath.replace(/\\/g, "/");
}

/**
 * A pattern matches a path when it matches the path itself, any ancestor directory
 * (so `dist` excludes everything below it), or, for slash-free patterns, any single
 * path segment (so `dist` and `secrets*` match at any depth).
 */
function matchesAny(patterns: readonly string[], p: string, nocase = false): boolean {
  const segments = p.split("/");
  const prefixes: string[] = [];
  for (let i = 1; i <= segments.length; i++) prefixes.push(segments.slice(0, i).join("/"));
  for (const pattern of patterns) {
    const m = matcher(pattern, nocase);
    if (prefixes.some((pre) => m(pre))) return true;
    if (!pattern.includes("/") && segments.some((s) => m(s))) return true;
  }
  return false;
}

/** Path-only sensitivity check: basename and full path (and each directory segment). Never reads the file. */
export function isSensitive(repoRelPath: string): boolean {
  return matchesAny(SENSITIVE_PATTERNS, normalize(repoRelPath), true);
}

/**
 * Path-only indexability: extension, built-in excludes, sensitive files and user excludes.
 * `discoverFiles` additionally applies filesystem rules (nested git dirs, size).
 */
export function isIndexable(repoRelPath: string, config: GantryConfig): boolean {
  const p = safeNormalize(repoRelPath);
  if (p === null) return false;
  if (!EXTENSIONS.includes(path.posix.extname(p))) return false;
  if (isSensitive(p)) return false;
  if (matchesAny(BUILTIN_EXCLUDES, p)) return false;
  if (matchesAny(config.exclude, p)) return false;
  return true;
}

function gitCandidates(root: string): string[] {
  const res = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${res.error?.message ?? res.stderr}`);
  }
  return [...new Set(res.stdout.split("\0").filter((s) => s.length > 0))];
}

/** Files Gantry may parse, sorted by path. Never opens file contents. */
export function discoverFiles(
  paths: GantryPaths,
  config: GantryConfig,
  ws: WorkspaceRecord[],
): DiscoveredFile[] {
  const root = paths.root;
  const nestedCache = new Map<string, boolean>();
  const hasGit = (dir: string): boolean => {
    let v = nestedCache.get(dir);
    if (v === undefined) {
      v = fs.existsSync(path.join(root, dir, ".git"));
      nestedCache.set(dir, v);
    }
    return v;
  };
  const inNestedRepo = (p: string): boolean => {
    const segs = p.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) if (hasGit(segs.slice(0, i).join("/"))) return true;
    return false;
  };

  // A candidate is rejected when any ancestor directory is a symlink or resolves outside the root.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  const dirCache = new Map<string, boolean>([["", true]]);
  const dirSafe = (dir: string): boolean => {
    const cached = dirCache.get(dir);
    if (cached !== undefined) return cached;
    let ok = false;
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (dirSafe(parent)) {
      try {
        const abs = path.join(root, dir);
        if (!fs.lstatSync(abs).isSymbolicLink()) {
          const real = fs.realpathSync(abs);
          ok = real === realRoot || real.startsWith(realRoot + path.sep);
        }
      } catch {
        ok = false;
      }
    }
    dirCache.set(dir, ok);
    return ok;
  };

  const out: DiscoveredFile[] = [];
  let tooLarge = 0;
  for (const rel of gitCandidates(root)) {
    if (!isIndexable(rel, config)) continue;
    if (inNestedRepo(rel)) continue;
    const dir = path.posix.dirname(rel);
    if (!dirSafe(dir === "." ? "" : dir)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(root, rel));
    } catch {
      continue; // tracked but deleted
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      tooLarge++;
      continue;
    }
    out.push({ path: rel, workspaceId: workspaceForPath(ws, rel).id, size: st.size, mtimeMs: st.mtimeMs });
  }
  if (tooLarge > 0) process.stderr.write(`gantry: skipped ${tooLarge} file(s) larger than 1 MB\n`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { workspaceId } from "../ids.js";
import type { ExportsEntry, WorkspaceRecord } from "../types.js";

/** The slice of GantryConfig (spec section 5) that workspace detection reads. */
export interface WorkspaceDetectionConfig {
  workspaces: { overrides: Record<string, { kind?: "app" | "package" }> };
}

type Json = Record<string, unknown>;

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const FRAMEWORKS = [
  "react",
  "@tanstack/react-start",
  "@tanstack/react-router",
  "hono",
  "@orpc/server",
  "drizzle-orm",
  "next",
];
const CONDITIONS = ["import", "types", "default"];

function readJson(file: string): Json | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** JSON with comments and trailing commas, the form tsconfig files use. Null when it does not parse to an object. */
export function readJsonc(file: string): Json | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  try {
    const v: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/**
 * Repo-relative dirs of the projects the root tsconfig.json references, followed transitively through each
 * referenced tsconfig's own `references`. A `path` to a file names that tsconfig; a directory names its tsconfig.json.
 * Paths outside the repo or inside SKIP_DIRS are dropped, and the root is never listed (its own workspace always exists); each tsconfig is read once, so cycles end.
 */
function tsconfigReferenceDirs(root: string): string[] {
  const base = resolve(root);
  const dirs = new Set<string>();
  const seen = new Set<string>();
  const visit = (tsconfig: string): void => {
    if (seen.has(tsconfig)) return;
    seen.add(tsconfig);
    const refs = readJsonc(tsconfig)?.references;
    if (!Array.isArray(refs)) return;
    for (const ref of refs) {
      const p = ref && typeof ref === "object" ? str((ref as Json).path) : undefined;
      if (p === undefined) continue;
      let target = resolve(dirname(tsconfig), p);
      if (isDir(target)) target = join(target, "tsconfig.json");
      if (!existsSync(target)) continue;
      const rel = relative(base, dirname(target));
      const dir = rel.split(sep).join("/");
      if (
        isAbsolute(rel) ||
        dir === ".." ||
        dir.startsWith("../") ||
        dir.split("/").some((d) => SKIP_DIRS.has(d))
      )
        continue;
      // A symlinked directory inside the repo that points outside it is outside too.
      const real = relative(realpathSync(base), realpathSync(dirname(target)));
      if (isAbsolute(real) || real === ".." || real.startsWith(`..${sep}`)) continue;
      if (dir !== "") dirs.add(dir);
      visit(target);
    }
  };
  visit(join(base, "tsconfig.json"));
  return [...dirs];
}

/** Minimal parser for the `packages:` list of pnpm-workspace.yaml. */
function parsePnpmPackages(text: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      inList = /^packages\s*:\s*$/.test(line);
      continue;
    }
    const m = inList ? /^\s*-\s*(.+?)\s*$/.exec(line) : null;
    if (m?.[1]) out.push(m[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}

/** All repo-relative posix dirs containing `file`, skipping node_modules, .git and nested worktrees. */
function dirsContaining(root: string, file: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel === "." ? root : join(root, rel);
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === file)) found.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const child = rel === "." ? e.name : `${rel}/${e.name}`;
      if (child === ".claude/worktrees" || child.endsWith("/.claude/worktrees")) continue;
      walk(child);
    }
  };
  walk(".");
  return found;
}

function expandGlobs(root: string, globs: string[], marker: string): string[] {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const g of globs) {
    const clean = g.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean.startsWith("!")) exclude.push(clean.slice(1));
    else include.push(clean);
  }
  if (include.length === 0) return [];
  const inc = picomatch(include);
  const exc = exclude.length ? picomatch(exclude) : () => false;
  return dirsContaining(root, marker).filter((d) => d !== "." && inc(d) && !exc(d));
}

function packageJsonWorkspaces(pkg: Json | null): string[] | null {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
  if (ws && typeof ws === "object") {
    const p = (ws as Json).packages;
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === "string");
  }
  return null;
}

function pickTarget(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = pickTarget(item);
      if (t) return t;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const c of CONDITIONS) {
      if (c in v) {
        const t = pickTarget((v as Json)[c]);
        if (t) return t;
      }
    }
  }
  return null;
}

/** Flatten a package.json `exports` field; first match among import, types, default. */
export function flattenExports(exp: unknown): ExportsEntry[] | null {
  if (exp === undefined || exp === null) return null;
  const entries: ExportsEntry[] = [];
  const isSubpathMap =
    typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
  if (isSubpathMap) {
    for (const [subpath, v] of Object.entries(exp as Json)) {
      if (!subpath.startsWith(".")) continue;
      const target = pickTarget(v);
      if (target) entries.push({ subpath, target });
    }
  } else {
    const target = pickTarget(exp);
    if (target) entries.push({ subpath: ".", target });
  }
  return entries.sort((a, b) => (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0));
}

/**
 * Dependency names a package.json declares, read from disk now (not from the stored workspace records):
 * the double-check of an undeclared-import finding (spec section 14). Undefined when the file is missing or invalid.
 */
export function declaredOnDisk(root: string, manifest: string): string[] | undefined {
  try {
    const j = JSON.parse(readFileSync(join(root, manifest), "utf8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
    const names = new Set(depNames(j as Json));
    const opt = (j as Json).optionalDependencies;
    if (opt && typeof opt === "object") for (const k of Object.keys(opt)) names.add(k);
    return [...names].sort();
  } catch {
    return undefined;
  }
}

function depNames(pkg: Json | null): string[] {
  const names = new Set<string>();
  for (const f of ["dependencies", "devDependencies", "peerDependencies"]) {
    const d = pkg?.[f];
    if (d && typeof d === "object") for (const k of Object.keys(d)) names.add(k);
  }
  return [...names].sort();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function classify(abs: string, dir: string, pkg: Json | null, deps: string[]): WorkspaceRecord["kind"] {
  const has = (d: string) => deps.includes(d);
  const frameworkApp =
    has("@tanstack/react-start") ||
    has("next") ||
    (has("@tanstack/react-router") && isDir(join(abs, "src/routes"))) ||
    (has("vite") && existsSync(join(abs, "index.html"))) ||
    (has("hono") && (existsSync(join(abs, "wrangler.toml")) || existsSync(join(abs, "wrangler.jsonc"))));
  if (dir.startsWith("apps/") || frameworkApp) return "app";
  if (dir.startsWith("packages/") || dir.startsWith("libs/") || pkg?.exports != null || pkg?.main != null)
    return "package";
  return "unknown";
}

function buildRecord(
  root: string,
  repo: string,
  dir: string,
  config: WorkspaceDetectionConfig,
): WorkspaceRecord {
  const abs = dir === "." ? root : join(root, dir);
  const pkg = readJson(join(abs, "package.json"));
  const project = existsSync(join(abs, "project.json")) ? readJson(join(abs, "project.json")) : null;
  const name = str(pkg?.name) ?? str(project?.name) ?? (dir === "." ? basename(root) : dir);
  const deps = depNames(pkg);
  const record: WorkspaceRecord = {
    id: workspaceId(repo, dir === "." ? "." : name),
    name,
    dir,
    kind: classify(abs, dir, pkg, deps),
    frameworks: FRAMEWORKS.filter((f) => deps.includes(f)),
    deps,
    exportsMap: flattenExports(pkg?.exports),
  };
  const main = str(pkg?.main);
  if (main !== undefined) record.main = main;
  const types = str(pkg?.types) ?? str(pkg?.typings);
  if (types !== undefined) record.types = types;
  const overrides = config.workspaces.overrides;
  const ov = overrides[record.id] ?? overrides[name] ?? overrides[dir];
  if (ov?.kind) record.kind = ov.kind;
  return record;
}

/**
 * Detect workspaces: pnpm-workspace.yaml, then package.json `workspaces`, then Nx
 * project.json files, then the projects the root tsconfig.json references, else a single root workspace. The root is always `ws:<repo>:.`.
 */
export function detectWorkspaces(
  root: string,
  config: WorkspaceDetectionConfig,
  repo: string,
): WorkspaceRecord[] {
  const rootPkg = readJson(join(root, "package.json"));
  const pnpmFile = join(root, "pnpm-workspace.yaml");
  const npmGlobs = packageJsonWorkspaces(rootPkg);
  let dirs: string[];
  if (existsSync(pnpmFile)) {
    dirs = expandGlobs(root, parsePnpmPackages(readFileSync(pnpmFile, "utf8")), "package.json");
  } else if (npmGlobs) {
    dirs = expandGlobs(root, npmGlobs, "package.json");
  } else {
    dirs = dirsContaining(root, "project.json").filter((d) => d !== ".");
    if (dirs.length === 0) dirs = tsconfigReferenceDirs(root);
  }
  const all = [...new Set([".", ...dirs])].sort();
  const records = all.map((d) => buildRecord(root, repo, d, config));
  // Keep ids unique: a repeated package name falls back to the directory.
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) r.id = workspaceId(repo, r.dir);
    seen.add(r.id);
  }
  return records;
}

/** Longest workspace dir prefix of a repo-relative path, else the root workspace. */
export function workspaceForPath(ws: WorkspaceRecord[], repoRelPath: string): WorkspaceRecord {
  const p = repoRelPath.replace(/^\.\//, "");
  let best: WorkspaceRecord | undefined;
  for (const w of ws) {
    if (w.dir === ".") continue;
    if ((p === w.dir || p.startsWith(`${w.dir}/`)) && (!best || w.dir.length > best.dir.length)) best = w;
  }
  // A repo can hold a TypeScript and a Go workspace at the root; a `.go` path belongs to the Go one.
  const roots = ws.filter((w) => w.dir === ".");
  const goFile = p.endsWith(".go");
  const fallback = best ?? roots.find((w) => (w.lang === "go") === goFile) ?? roots[0] ?? ws[0];
  if (!fallback) throw new Error("workspaceForPath: no workspaces");
  return fallback;
}

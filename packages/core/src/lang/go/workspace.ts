import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileId as makeFileId, workspaceId } from "../../ids.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import type { WorkspaceDetectionConfig } from "../../workspace/index.js";
import { goAvailable, warnGoSkipped } from "./grammar.js";

/** Directories a Go module search never enters (the Go tool ignores `vendor` and `testdata`; dot folders are hidden). */
const SKIP_DIRS = new Set(["vendor", "testdata", "node_modules"]);

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Text of a go.mod / go.work without `//` comments. */
const stripComments = (text: string): string => text.replace(/\/\/.*$/gm, "");

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, "");

/** Module path of a go.mod; null when it has no `module` line. */
export function parseModulePath(goMod: string): string | null {
  const m = /^\s*module\s+(\S+)/m.exec(stripComments(goMod));
  return m?.[1] ? unquote(m[1]) : null;
}

/** The module paths named by `require` lines (single and block form), sorted and unique. */
export function parseRequires(goMod: string): string[] {
  const out = new Set<string>();
  let inBlock = false;
  for (const raw of stripComments(goMod).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else {
        const m = /^(\S+)\s+\S+/.exec(line);
        if (m?.[1]) out.add(unquote(m[1]));
      }
      continue;
    }
    if (/^require\s*\(\s*$/.test(line)) inBlock = true;
    else {
      const m = /^require\s+(\S+)\s+\S+/.exec(line);
      if (m?.[1]) out.add(unquote(m[1]));
    }
  }
  return [...out].sort();
}

/** The directories a go.work lists with `use` (single and block form), as written (`.`, `./tools`) normalised to repo-relative. */
export function parseGoWorkUses(goWork: string): string[] {
  const out: string[] = [];
  const norm = (d: string): string => {
    const t = unquote(d).replace(/^\.\//, "").replace(/\/+$/, "");
    return t === "" ? "." : t;
  };
  let inBlock = false;
  for (const raw of stripComments(goWork).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else out.push(norm(line));
      continue;
    }
    if (/^use\s*\(\s*$/.test(line)) inBlock = true;
    else {
      const m = /^use\s+(\S+)/.exec(line);
      if (m?.[1]) out.push(norm(m[1]));
    }
  }
  return out;
}

/** Repo-relative posix dirs that contain a go.mod (root is `.`), sorted. */
function moduleDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === "." ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "go.mod")) found.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(rel === "." ? e.name : `${rel}/${e.name}`);
    }
  };
  walk(".");
  return found.sort();
}

/** True when a `.go` file of the module in `dir` declares `package main` (nested modules and skipped folders excluded). */
function hasMainPackage(root: string, dir: string, nested: ReadonlySet<string>): boolean {
  const walk = (rel: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === "." ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const child = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || nested.has(child)) continue;
        if (walk(child)) return true;
      } else if (e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go")) {
        const text = read(join(root, child));
        if (text !== null && /^package main\b/m.test(text)) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/**
 * Go modules as workspaces (spec section 5): every directory with a `go.mod` is `ws:<repo>:<module path>`, kind `app` when
 * it holds a `package main` and `package` otherwise; `require` lines are the workspace's `deps`.
 * Empty when the Go grammar is unavailable on this platform (the skip line is printed once).
 */
export function detectGoWorkspaces(
  root: string,
  config: WorkspaceDetectionConfig,
  repo: string,
): WorkspaceRecord[] {
  const dirs = moduleDirs(root);
  if (dirs.length === 0) return [];
  if (!goAvailable()) {
    warnGoSkipped();
    return [];
  }
  const dirSet = new Set(dirs);
  const records: WorkspaceRecord[] = [];
  for (const dir of dirs) {
    const abs = dir === "." ? root : join(root, dir);
    const text = read(join(abs, "go.mod"));
    const path = text === null ? null : parseModulePath(text);
    if (text === null || path === null) continue;
    const nested = new Set([...dirSet].filter((d) => d !== dir && (dir === "." || d.startsWith(`${dir}/`))));
    const record: WorkspaceRecord = {
      id: workspaceId(repo, path),
      name: path,
      dir,
      kind: hasMainPackage(root, dir, nested) ? "app" : "package",
      frameworks: [],
      deps: parseRequires(text),
      exportsMap: null,
      lang: "go",
    };
    const ov =
      config.workspaces.overrides[record.id] ??
      config.workspaces.overrides[path] ??
      config.workspaces.overrides[dir];
    if (ov?.kind) record.kind = ov.kind;
    records.push(record);
  }
  // Keep ids unique: a module path declared twice falls back to the directory.
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) r.id = workspaceId(repo, r.dir);
    seen.add(r.id);
  }
  return records;
}

/**
 * `depends_on` edges between Go workspaces, from `require` lines that name a sibling module. When the repo has a root
 * `go.work`, only modules it lists with `use` belong together; without one every module in the repo is a sibling.
 * The edge belongs to the requiring module's `go.mod` file.
 */
export function goDependsOnEdges(repo: string, root: string, workspaces: WorkspaceRecord[]): EdgeRecord[] {
  const go = workspaces.filter((w) => w.lang === "go");
  const work = read(join(root, "go.work"));
  const listed = work === null ? null : new Set(parseGoWorkUses(work));
  const group = listed === null ? go : go.filter((w) => listed.has(w.dir));
  const byName = new Map(group.map((w) => [w.name, w]));
  const edges: EdgeRecord[] = [];
  for (const w of group) {
    const modFile = makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}go.mod`);
    for (const dep of w.deps) {
      const target = byName.get(dep);
      if (!target || target.id === w.id) continue;
      edges.push({
        src: w.id,
        dst: target.id,
        kind: "depends_on",
        confidence: "high",
        count: 1,
        evidence: [],
        fileId: modFile,
      });
    }
  }
  return edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

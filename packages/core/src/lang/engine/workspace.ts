import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { fileId as makeFileId, workspaceId } from "../../ids.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import type { WorkspaceDetectionConfig } from "../../workspace/index.js";
import { grammarAvailable, warnSkipped } from "./grammar.js";
import type { LanguagePack } from "./pack.js";

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, "");

const strip = (pack: LanguagePack, text: string): string => text.replace(pack.workspace.comment, "");

/** The workspace name a manifest declares; null when it declares none. */
export function parseManifestName(pack: LanguagePack, manifest: string): string | null {
  const m = pack.workspace.name.exec(strip(pack, manifest));
  return m?.[1] ? unquote(m[1]) : null;
}

/**
 * The entries of a manifest directive, in single form (`<directive> a b`) and block form (`<directive> (` then one entry
 * per line, then `)`), as written. An entry is its first token; `tokens` is how many tokens a line must have.
 */
function directiveEntries(pack: LanguagePack, manifest: string, directive: string, tokens: number): string[] {
  const rest = "\\s+\\S+".repeat(Math.max(0, tokens - 1));
  const single = new RegExp(`^${directive}\\s+(\\S+)${rest}`);
  const block = new RegExp(`^(\\S+)${rest}`);
  const open = new RegExp(`^${directive}\\s*\\(\\s*$`);
  const out: string[] = [];
  let inBlock = false;
  for (const raw of strip(pack, manifest).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else {
        const m = block.exec(line);
        if (m?.[1]) out.push(unquote(m[1]));
      }
      continue;
    }
    if (open.test(line)) inBlock = true;
    else {
      const m = single.exec(line);
      if (m?.[1]) out.push(unquote(m[1]));
    }
  }
  return out;
}

/** The dependency names a manifest lists (single and block form), sorted and unique. */
export function parseManifestDeps(pack: LanguagePack, manifest: string): string[] {
  const d = pack.workspace.deps;
  return [...new Set(directiveEntries(pack, manifest, d.directive, d.tokens))].sort();
}

/** The directories the group manifest lists, as written (`.`, `./tools`) normalised to repo-relative. */
export function parseGroupMembers(pack: LanguagePack, manifest: string): string[] {
  const g = pack.workspace.group;
  return directiveEntries(pack, manifest, g.directive, g.tokens).map((d) => {
    const t = d.replace(/^\.\//, "").replace(/\/+$/, "");
    return t === "" ? "." : t;
  });
}

/** Repo-relative posix dirs that contain a manifest (root is `.`), sorted. */
function manifestDirs(pack: LanguagePack, root: string): string[] {
  const skip = new Set(pack.workspace.skipDirs);
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === "." ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === pack.workspace.manifest)) found.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || skip.has(e.name)) continue;
      walk(rel === "." ? e.name : `${rel}/${e.name}`);
    }
  };
  walk(".");
  return found.sort();
}

/** True when a source file of the workspace in `dir` that is not a test matches the pack's `main` pattern. */
function hasMain(pack: LanguagePack, root: string, dir: string, nested: ReadonlySet<string>): boolean {
  const skip = new Set(pack.workspace.skipDirs);
  const isTest = picomatch([...pack.testPatterns], { dot: true });
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
        if (e.name.startsWith(".") || skip.has(e.name) || nested.has(child)) continue;
        if (walk(child)) return true;
      } else if (e.isFile() && pack.extensions.some((x) => e.name.endsWith(x)) && !isTest(child)) {
        const text = read(join(root, child));
        if (text !== null && pack.workspace.main.test(text)) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/**
 * The workspaces of a pack's language (spec section 5): every directory with the manifest is `ws:<repo>:<name>`, kind
 * `app` when it holds a main file and `package` otherwise; the manifest's dependencies are the workspace's `deps`.
 * Empty when the grammar is unavailable on this platform (the skip line is printed once).
 */
export function detectPackWorkspaces(
  pack: LanguagePack,
  root: string,
  config: WorkspaceDetectionConfig,
  repo: string,
): WorkspaceRecord[] {
  const dirs = manifestDirs(pack, root);
  if (dirs.length === 0) return [];
  if (!grammarAvailable(pack)) {
    warnSkipped(pack);
    return [];
  }
  const dirSet = new Set(dirs);
  const manifest = pack.workspace.manifest;
  const records: WorkspaceRecord[] = [];
  for (const dir of dirs) {
    const abs = dir === "." ? root : join(root, dir);
    const text = read(join(abs, manifest));
    const name = text === null ? null : parseManifestName(pack, text);
    if (text === null || name === null) continue;
    const nested = new Set([...dirSet].filter((d) => d !== dir && (dir === "." || d.startsWith(`${dir}/`))));
    const record: WorkspaceRecord = {
      id: workspaceId(repo, name),
      name,
      dir,
      kind: hasMain(pack, root, dir, nested) ? "app" : "package",
      frameworks: [],
      deps: parseManifestDeps(pack, text),
      exportsMap: null,
      lang: pack.id as WorkspaceRecord["lang"],
    };
    const ov =
      config.workspaces.overrides[record.id] ??
      config.workspaces.overrides[name] ??
      config.workspaces.overrides[dir];
    if (ov?.kind) record.kind = ov.kind;
    records.push(record);
  }
  // Keep ids unique: a name declared twice falls back to the directory.
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) r.id = workspaceId(repo, r.dir);
    seen.add(r.id);
  }
  return records;
}

/**
 * `depends_on` edges between the workspaces of a pack's language, from dependency entries that name a sibling. When the
 * repo has the group manifest, only the directories it lists belong together; without one every workspace of the
 * language in the repo is a sibling. The edge belongs to the requiring workspace's manifest file.
 */
export function packDependsOnEdges(
  pack: LanguagePack,
  repo: string,
  root: string,
  workspaces: WorkspaceRecord[],
): EdgeRecord[] {
  const own = workspaces.filter((w) => w.lang === pack.id);
  const work = read(join(root, pack.workspace.group.file));
  const listed = work === null ? null : new Set(parseGroupMembers(pack, work));
  const group = listed === null ? own : own.filter((w) => listed.has(w.dir));
  const byName = new Map(group.map((w) => [w.name, w]));
  const edges: EdgeRecord[] = [];
  for (const w of group) {
    const modFile = makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}${pack.workspace.manifest}`);
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

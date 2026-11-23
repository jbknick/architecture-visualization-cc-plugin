import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import picomatch from "picomatch";
import { fileId as makeFileId, workspaceId } from "../../ids.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import type { WorkspaceDetectionConfig } from "../../workspace/index.js";
import { readConfig } from "./config.js";
import { grammarAvailable, warnSkipped } from "./grammar.js";
import type { LanguagePack, ManifestRule } from "./pack.js";
import { readXml } from "./xml.js";

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Removes the quote characters the rule names from the ends of a manifest value. */
const unquote = (rule: ManifestRule, s: string): string => {
  const q = rule.quotes;
  const head = s.length > 0 && q.includes(s.charAt(0)) ? s.slice(1) : s;
  return head.length > 0 && q.includes(head.charAt(head.length - 1)) ? head.slice(0, -1) : head;
};

const strip = (rule: ManifestRule, text: string): string => text.replace(rule.comment, "");

/** The strings of a manifest by the path of the element or key that holds them; null for a manifest that is read as text. */
function keyedValues(rule: ManifestRule, manifest: string): Map<string, string[]> | null {
  if (rule.format === "xml") return readXml(manifest);
  if (rule.format === "text") return null;
  return readConfig(manifest, rule.format).values;
}

/** The name of a workspace as it is compared with the names that dependency entries give (`sameName` of the pack). */
export function nameKey(pack: LanguagePack, name: string): string {
  const s = pack.workspace.sameName;
  if (!s) return name;
  const folded = name.replace(s.fold, s.as);
  return s.lower ? folded.toLowerCase() : folded;
}

/** True when the workspace `from` lists the workspace `on` among its dependencies. */
export const dependsOn = (
  pack: LanguagePack,
  from: Pick<WorkspaceRecord, "deps">,
  on: Pick<WorkspaceRecord, "name">,
): boolean => from.deps.some((d) => nameKey(pack, d) === nameKey(pack, on.name));

/** Where a manifest sits: the folder it is in (repo-relative, `.` for the root) and the folder of the repo. */
interface Place {
  abs: string;
  dir: string;
  root: string;
}

/** The workspace name a manifest declares; null when it declares none. `place` is needed for names taken from a folder or from another file. */
export function parseManifestName(
  pack: LanguagePack,
  manifest: string,
  rule: ManifestRule = pack.workspace.manifests[0] as ManifestRule,
  place?: Place,
): string | null {
  const table = keyedValues(rule, manifest);
  for (const s of rule.name) {
    if ("directory" in s) {
      const n = place ? basename(place.dir === "." ? place.root : place.dir) : "";
      if (n !== "") return n;
    } else if ("path" in s) {
      const v = table?.get(s.path)?.[0];
      if (v) return v;
    } else {
      let text: string | null = manifest;
      if (s.files) {
        text = null;
        for (const f of s.files) {
          text = place ? read(join(place.abs, f)) : null;
          if (text !== null) break;
        }
      }
      const m = text === null ? null : s.pattern.exec(strip(rule, text));
      if (m?.[1]) return unquote(rule, m[1]);
    }
  }
  return null;
}

/**
 * The entries of a manifest directive, in single form (`<directive> a b`) and block form (`<directive> (` then one entry
 * per line, then `)`), as written. An entry is its first token; `tokens` is how many tokens a line must have.
 */
function directiveEntries(rule: ManifestRule, manifest: string, directive: string, tokens: number): string[] {
  const rest = "\\s+\\S+".repeat(Math.max(0, tokens - 1));
  const single = new RegExp(`^${directive}\\s+(\\S+)${rest}`);
  const block = new RegExp(`^(\\S+)${rest}`);
  const open = new RegExp(`^${directive}\\s*\\(\\s*$`);
  const out: string[] = [];
  let inBlock = false;
  for (const raw of strip(rule, manifest).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else {
        const m = block.exec(line);
        if (m?.[1]) out.push(unquote(rule, m[1]));
      }
      continue;
    }
    if (open.test(line)) inBlock = true;
    else {
      const m = single.exec(line);
      if (m?.[1]) out.push(unquote(rule, m[1]));
    }
  }
  return out;
}

/** The dependency names a manifest lists, sorted and unique. */
export function parseManifestDeps(
  pack: LanguagePack,
  manifest: string,
  rule: ManifestRule = pack.workspace.manifests[0] as ManifestRule,
): string[] {
  const d = rule.deps;
  let names: string[];
  if ("directive" in d) names = directiveEntries(rule, manifest, d.directive, d.tokens);
  else if ("pattern" in d) {
    const text = strip(rule, manifest);
    const region = d.within ? (d.within.exec(text)?.[1] ?? "") : text;
    names = [...region.matchAll(d.pattern)].map((m) => m[1] ?? "").filter((n) => n !== "");
  } else {
    const found =
      "keys" in d
        ? (readConfig(manifest, rule.format as "toml" | "ini").keys.get(d.keys) ?? [])
        : (keyedValues(rule, manifest)?.get(d.path) ?? []);
    const entry = d.entry;
    names = found
      .map((s) => {
        const m = entry?.exec(s.trim());
        return entry ? (m ? (m[1] ?? m[0]) : "") : s;
      })
      .filter((n) => n !== "");
  }
  return [...new Set(names)].sort();
}

/** The directories the group manifest lists, as written (`.`, `./tools`) normalised to repo-relative. */
export function parseGroupMembers(pack: LanguagePack, manifest: string): string[] {
  const g = pack.workspace.group;
  const rule = pack.workspace.manifests[0] as ManifestRule;
  if (!g) return [];
  return directiveEntries(rule, manifest, g.directive, g.tokens).map((d) => {
    const t = d.replace(/^\.\//, "").replace(/\/+$/, "");
    return t === "" ? "." : t;
  });
}

/**
 * The manifest that makes a folder a workspace: the first, in the order of the pack's rules, that the folder holds and that
 * gives a name. Its rule, file name, text and the name.
 */
function manifestIn(
  pack: LanguagePack,
  abs: string,
  place: Place,
): { rule: ManifestRule; file: string; text: string; name: string } | null {
  for (const rule of pack.workspace.manifests)
    for (const file of rule.files) {
      if (!existsSync(join(abs, file))) continue;
      const text = read(join(abs, file));
      const name = text === null ? null : parseManifestName(pack, text, rule, place);
      if (text !== null && name !== null) return { rule, file, text, name };
    }
  return null;
}

/** Repo-relative posix dirs that contain a manifest (root is `.`), sorted. */
function manifestDirs(pack: LanguagePack, root: string): string[] {
  const skip = new Set(pack.workspace.skipDirs);
  const names = new Set(pack.workspace.manifests.flatMap((r) => r.files));
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === "." ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && names.has(e.name))) found.push(rel);
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
 * The workspaces of a pack's language (spec section 5): every directory with a manifest is `ws:<repo>:<name>`, kind
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
  const records: WorkspaceRecord[] = [];
  for (const dir of dirs) {
    const abs = dir === "." ? root : join(root, dir);
    const found = manifestIn(pack, abs, { abs, dir, root });
    if (found === null) continue;
    const { name, text } = found;
    const nested = new Set([...dirSet].filter((d) => d !== dir && (dir === "." || d.startsWith(`${dir}/`))));
    const record: WorkspaceRecord = {
      id: workspaceId(repo, name),
      name,
      dir,
      kind: hasMain(pack, root, dir, nested) ? "app" : "package",
      frameworks: [],
      deps: parseManifestDeps(pack, text, found.rule),
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

/** The names of the manifest files a pack's workspaces have. */
export const manifestFiles = (pack: LanguagePack): string[] => [
  ...new Set(pack.workspace.manifests.flatMap((r) => r.files)),
];

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
  const g = pack.workspace.group;
  const work = g ? read(join(root, g.file)) : null;
  const listed = work === null ? null : new Set(parseGroupMembers(pack, work));
  const group = listed === null ? own : own.filter((w) => listed.has(w.dir));
  const byName = new Map(group.map((w) => [nameKey(pack, w.name), w]));
  const edges: EdgeRecord[] = [];
  for (const w of group) {
    const abs = w.dir === "." ? root : join(root, w.dir);
    const found = manifestIn(pack, abs, { abs, dir: w.dir, root });
    if (!found) continue;
    const modFile = makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}${found.file}`);
    for (const dep of w.deps) {
      const target = byName.get(nameKey(pack, dep));
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

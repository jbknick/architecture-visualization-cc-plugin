import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import picomatch from "picomatch";
import { fileId as makeFileId, workspaceId } from "../../ids.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import type { WorkspaceDetectionConfig } from "../../workspace/index.js";
import { CLOJURE_EXTENSIONS, CLOJURE_ID, CLOJURE_TEST_PATTERNS } from "./ids.js";
import { type Coll, type Form, isSym, kwText, readForms, symText } from "./reader.js";

/**
 * Clojure workspaces (spec section 7, Clojure workspaces): a folder with a `project.clj`, `deps.edn`, `shadow-cljs.edn`
 * or `bb.edn` is a workspace. A `project.clj` names it (`(defproject acme/app ...)`); a folder with only the others is
 * named by the folder. The dependencies are the libraries the manifests list; one that is a workspace of the repo, by its
 * name or by the folder its `:local/root` names, is a `depends_on` edge.
 */

/** The manifests in the order they are read; the first that a folder holds is the one its `depends_on` edges belong to. */
const MANIFESTS = ["project.clj", "deps.edn", "shadow-cljs.edn", "bb.edn"] as const;
const SKIP_DIRS = new Set(["node_modules", "target", "out", "checkouts"]);
const MAIN = /\(defn-?\s+(?:\^[^\s]+\s+)*-main[\s)]/;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** One library a manifest lists: its name as written and, for a `:local/root`, the repo-relative folder it names. */
export interface ClojureDep {
  name: string;
  localRoot?: string;
}

export interface ClojureManifest {
  file: string;
  /** The name `defproject` declares; null for the other manifests. */
  name: string | null;
  deps: ClojureDep[];
  /** `shadow-cljs.edn` with `:builds`: the folder builds an app. */
  builds: boolean;
}

/** The value of `key` in a map form. */
function get(m: Form | undefined, key: string): Form | undefined {
  if (m?.t !== "map") return undefined;
  for (let k = 0; k + 1 < m.items.length; k += 2) if (kwText(m.items[k]) === key) return m.items[k + 1];
  return undefined;
}

/** `[[a/b "1.0"] [c "2.0"]]`: the name of each entry. */
const vectorDeps = (v: Form | undefined): ClojureDep[] =>
  v?.t === "vec"
    ? v.items.flatMap((x) =>
        x.t === "vec" && x.items[0]?.t === "sym" ? [{ name: symText(x.items[0]) }] : [],
      )
    : [];

/** `{a/b {:mvn/version "1.0"} c {:local/root "../c"}}`: the name of each key, with its local root (repo-relative). */
function mapDeps(m: Form | undefined, dir: string): ClojureDep[] {
  if (m?.t !== "map") return [];
  const out: ClojureDep[] = [];
  for (let k = 0; k + 1 < m.items.length; k += 2) {
    const key = m.items[k] as Form;
    if (key.t !== "sym") continue;
    const local = get(m.items[k + 1], ":local/root");
    const dep: ClojureDep = { name: symText(key) };
    if (local?.t === "str") {
      const rel = posix.normalize(posix.join(dir === "." ? "" : dir, local.text.slice(1, -1)));
      dep.localRoot = rel === "" || rel === "./" ? "." : rel.replace(/\/+$/, "");
    }
    out.push(dep);
  }
  return out;
}

/** Reads one manifest of the folder `dir` (repo-relative); null when it is not one of the four or holds no form. */
export function readManifest(file: string, text: string, dir: string): ClojureManifest | null {
  const forms = readForms(text).forms;
  if (file === "project.clj") {
    const p = forms.find((f) => f.t === "list" && isSym(f.items[0], "defproject")) as Coll | undefined;
    if (p?.items[1]?.t !== "sym") return null;
    let deps: ClojureDep[] = [];
    for (let k = 3; k + 1 < p.items.length; k++)
      if (kwText(p.items[k]) === ":dependencies") deps = vectorDeps(p.items[k + 1]);
    return { file, name: symText(p.items[1]), deps, builds: false };
  }
  const m = forms[0];
  if (m?.t !== "map") return null;
  if (file === "shadow-cljs.edn")
    return {
      file,
      name: null,
      deps: vectorDeps(get(m, ":dependencies")),
      builds: get(m, ":builds") !== undefined,
    };
  return { file, name: null, deps: mapDeps(get(m, ":deps"), dir), builds: false };
}

/** The manifests a folder holds, in the order of `MANIFESTS`. */
function manifestsIn(root: string, dir: string): ClojureManifest[] {
  const abs = dir === "." ? root : join(root, dir);
  const out: ClojureManifest[] = [];
  for (const file of MANIFESTS) {
    const text = read(join(abs, file));
    const m = text === null ? null : readManifest(file, text, dir);
    if (m) out.push(m);
  }
  return out;
}

/** Repo-relative folders that hold a manifest, sorted. */
function manifestDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel === "." ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && (MANIFESTS as readonly string[]).includes(e.name))) found.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(rel === "." ? e.name : `${rel}/${e.name}`);
    }
  };
  walk(".");
  return found.sort(cmp);
}

/** True when a source file of the workspace in `dir` that is not a test declares `-main`. */
function hasMain(root: string, dir: string, nested: ReadonlySet<string>): boolean {
  const isTest = picomatch(CLOJURE_TEST_PATTERNS, { dot: true });
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
      } else if (e.isFile() && CLOJURE_EXTENSIONS.some((x) => e.name.endsWith(x)) && !isTest(child)) {
        const text = read(join(root, child));
        if (text !== null && MAIN.test(text)) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/** The workspaces of Clojure in a repo, one per folder with a manifest. */
export function detectClojureWorkspaces(
  root: string,
  config: WorkspaceDetectionConfig,
  repo: string,
): WorkspaceRecord[] {
  const dirs = manifestDirs(root);
  const records: WorkspaceRecord[] = [];
  for (const dir of dirs) {
    const ms = manifestsIn(root, dir);
    if (ms.length === 0) continue;
    const name = ms.find((m) => m.name !== null)?.name ?? basename(dir === "." ? root : dir);
    const nested = new Set(dirs.filter((d) => d !== dir && (dir === "." || d.startsWith(`${dir}/`))));
    const record: WorkspaceRecord = {
      id: workspaceId(repo, name),
      name,
      dir,
      kind: ms.some((m) => m.builds) || hasMain(root, dir, nested) ? "app" : "package",
      frameworks: [],
      deps: [...new Set(ms.flatMap((m) => m.deps.map((d) => d.name)))].sort(cmp),
      exportsMap: null,
      lang: CLOJURE_ID,
    };
    const ov =
      config.workspaces.overrides[record.id] ??
      config.workspaces.overrides[name] ??
      config.workspaces.overrides[dir];
    if (ov?.kind) record.kind = ov.kind;
    records.push(record);
  }
  // Keep ids unique: a name declared twice falls back to the folder.
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) r.id = workspaceId(repo, r.dir);
    seen.add(r.id);
  }
  return records;
}

/** The part of a library name after its group: `acme/core` is `core`. */
const artifact = (name: string): string => name.slice(name.indexOf("/") + 1);

/** True when the dependency names the workspace: by its `:local/root`, by the name, or by the name without its group. */
const names = (dep: ClojureDep, w: Pick<WorkspaceRecord, "name" | "dir">): boolean =>
  dep.localRoot !== undefined
    ? dep.localRoot === w.dir
    : dep.name === w.name || artifact(dep.name) === artifact(w.name);

/**
 * The manifests of the Clojure workspaces of a repo, each folder read once. A resolver holds one, so a manifest is read
 * again by the next index run.
 */
export class ClojureManifests {
  private readonly byDir = new Map<string, ClojureManifest[]>();
  constructor(private readonly root: string) {}

  of(dir: string): ClojureManifest[] {
    let ms = this.byDir.get(dir);
    if (!ms) {
      ms = manifestsIn(this.root, dir);
      this.byDir.set(dir, ms);
    }
    return ms;
  }

  /** True when the workspace in `fromDir` lists the workspace `on` among its dependencies. */
  dependsOn(fromDir: string, on: Pick<WorkspaceRecord, "name" | "dir">): boolean {
    return this.of(fromDir).some((m) => m.deps.some((d) => names(d, on)));
  }
}

/**
 * `depends_on` edges between the Clojure workspaces of the repo, from the libraries the manifests list. The edge belongs
 * to the first manifest of the requiring workspace's folder that lists the dependency.
 */
export function clojureDependsOnEdges(
  repo: string,
  manifests: ClojureManifests,
  workspaces: WorkspaceRecord[],
): EdgeRecord[] {
  const own = workspaces.filter((w) => w.lang === CLOJURE_ID);
  const edges: EdgeRecord[] = [];
  for (const w of own) {
    const ms = manifests.of(w.dir);
    for (const target of own) {
      if (target.id === w.id) continue;
      const m = ms.find((x) => x.deps.some((d) => names(d, target)));
      if (!m) continue;
      edges.push({
        src: w.id,
        dst: target.id,
        kind: "depends_on",
        confidence: "high",
        count: 1,
        evidence: [],
        fileId: makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}${m.file}`),
      });
    }
  }
  return edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
}

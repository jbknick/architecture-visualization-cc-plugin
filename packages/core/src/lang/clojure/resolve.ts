import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathOfFileId } from "../../ids.js";
import type { ResolveContext, Resolver } from "../../resolve/index.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import { EdgeSet } from "../engine/resolve/edges.js";
import { type FileFacts, factsOf, Lines } from "./facts.js";
import { CLOJURE_EXTENSIONS, CLOJURE_ID } from "./ids.js";
import { definitionIds } from "./parse.js";
import type { Form, Sym } from "./reader.js";
import { type Env, ScopeWalk } from "./scope.js";
import { ClojureManifests, clojureDependsOnEdges } from "./workspace.js";

/**
 * Clojure call edges (spec section 7, level 1): a reference to a var of the repo is resolved by names alone, from the
 * namespace a file's `ns` form declares and the names its requires bind. `alias/name` goes through the alias (or names a
 * namespace of the repo in full), a bare name through `:refer`, then the namespace of the file, then the one namespace
 * among those brought in whole (`:refer :all`, `:use`) that defines it. A local binding hides a var of its spelling.
 * Every reference from the code of a definition is a `calls` edge, called or passed as a value.
 */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Platform = "clj" | "cljs" | "cljc";

interface FileInfo {
  fileId: string;
  rel: string;
  platform: Platform;
  workspace: WorkspaceRecord | undefined;
  facts: FileFacts;
  ids: string[];
  /** Var name to the symbol id of its first definition in the file. */
  vars: Map<string, string>;
  /** The vars the file defines with `defmacro`: ClojureScript code uses the macros of a `.clj` file. */
  macros: Set<string>;
  lines: Lines;
}

interface Target {
  id: string;
  confidence: "high" | "low";
}

const platformOf = (rel: string): Platform =>
  rel.endsWith(".cljs") ? "cljs" : rel.endsWith(".cljc") ? "cljc" : "clj";

/** True when code of the platform `from` can load a file of the platform `to` (a macro aside: see `varIn`). */
const loads = (from: Platform, to: Platform): boolean => from === "cljc" || to === "cljc" || from === to;

const depth = (w: WorkspaceRecord): number => (w.dir === "." ? 0 : w.dir.length);

/** The Clojure workspace that holds `rel`: the one with the longest folder. */
export function clojureWorkspaceOf(
  workspaces: readonly WorkspaceRecord[],
  rel: string,
): WorkspaceRecord | undefined {
  let best: WorkspaceRecord | undefined;
  for (const w of workspaces) {
    if (w.lang !== CLOJURE_ID) continue;
    if ((w.dir === "." || rel.startsWith(`${w.dir}/`)) && (!best || depth(w) > depth(best))) best = w;
  }
  return best;
}

/** A resolved reference of one file: the range of the symbol written and its target. */
interface Ref {
  s: number;
  e: number;
  caller: string | null;
  target: Target;
  line: number;
}

class ClojureResolver {
  private files: FileInfo[] | undefined;
  private byFile = new Map<string, FileInfo>();
  private byNs = new Map<string, FileInfo[]>();
  /** The references of the last file `targetAt` read, by range; one file at a time. */
  private last: { fileId: string; refs: Map<string, string>; heads: Map<string, string> } | undefined;

  private readonly manifests: ClojureManifests;

  constructor(private readonly ctx: ResolveContext) {
    this.manifests = new ClojureManifests(ctx.root);
  }

  /** Reads every Clojure file of the repo once, for its namespace and definitions. */
  private index(): FileInfo[] {
    if (this.files) return this.files;
    const files: FileInfo[] = [];
    const ids = [...this.ctx.parsed.keys()].sort(cmp);
    for (const fileId of ids) {
      const rel = pathOfFileId(fileId);
      if (!CLOJURE_EXTENSIONS.some((x) => rel.endsWith(x))) continue;
      let source: string;
      try {
        source = readFileSync(join(this.ctx.root, rel), "utf8");
      } catch {
        continue;
      }
      const facts = factsOf(source);
      const defIds = definitionIds(this.ctx.repo, rel, facts.definitions);
      const vars = new Map<string, string>();
      const macros = new Set<string>();
      facts.definitions.forEach((d, k) => {
        if (d.var !== "" && !vars.has(d.var)) vars.set(d.var, defIds[k] as string);
        if (d.role === "def" && (d.form.items[0] as Sym).name === "defmacro") macros.add(d.var);
      });
      const info: FileInfo = {
        fileId,
        rel,
        platform: platformOf(rel),
        workspace: clojureWorkspaceOf(this.ctx.workspaces, rel),
        facts,
        ids: defIds,
        vars,
        macros,
        lines: new Lines(source),
      };
      files.push(info);
      this.byFile.set(fileId, info);
      if (facts.ns !== null) {
        const list = this.byNs.get(facts.ns) ?? [];
        list.push(info);
        this.byNs.set(facts.ns, list);
      }
    }
    this.files = files;
    return files;
  }

  /**
   * The var `name` of the namespace `ns` as code of `from` sees it: among the files of that namespace that `from`'s
   * platform loads and that define the var, the file itself, else the only one in its workspace, else the only one in a
   * workspace it depends on, else the only one in the repo. Several at the first tier that has any give no target.
   */
  private varIn(from: FileInfo, ns: string, name: string): string | null {
    const files = (this.byNs.get(ns) ?? []).filter(
      (f) =>
        f.vars.has(name) &&
        (loads(from.platform, f.platform) || (from.platform === "cljs" && f.macros.has(name))),
    );
    if (files.length === 0) return null;
    if (files.includes(from)) return from.vars.get(name) as string;
    const tiers = [
      files.filter((f) => f.workspace?.id === from.workspace?.id),
      files.filter(
        (f) =>
          f.workspace !== undefined &&
          from.workspace !== undefined &&
          this.manifests.dependsOn(from.workspace.dir, f.workspace),
      ),
      files,
    ];
    for (const t of tiers) {
      if (t.length === 0) continue;
      return t.length === 1 ? ((t[0] as FileInfo).vars.get(name) as string) : null;
    }
    return null;
  }

  /** The target of a symbol written in `from` with the locals `env`, or null when it names no var of the repo. */
  resolve(from: FileInfo, s: Sym, env: Env): Target | null {
    const req = from.facts.requires;
    if (s.ns !== undefined) {
      const ns = req.aliases.get(s.ns) ?? (this.byNs.has(s.ns) ? s.ns : null);
      if (ns === null) return null;
      const id = this.varIn(from, ns, s.name);
      return id ? { id, confidence: "high" } : null;
    }
    if (env.has(s.name)) return null;
    // `(Circle. r)` constructs the record or type `Circle`.
    if (s.name.length > 1 && s.name.endsWith(".") && !s.name.startsWith("."))
      return this.resolve(from, { ...s, name: s.name.slice(0, -1) }, env);
    const r = req.refers.get(s.name);
    if (r) {
      const id = this.varIn(from, r.ns, r.name);
      return id ? { id, confidence: "high" } : null;
    }
    if (from.facts.ns !== null) {
      const id = this.varIn(from, from.facts.ns, s.name);
      if (id) return { id, confidence: "high" };
    }
    const found = new Set<string>();
    for (const ns of req.all) {
      const id = this.varIn(from, ns, s.name);
      if (id) found.add(id);
    }
    return found.size === 1 ? { id: [...found][0] as string, confidence: "low" } : null;
  }

  /** Every reference of the code of the file's definitions, with the definition it is in. */
  private refsOf(info: FileInfo): Ref[] {
    const refs: Ref[] = [];
    let caller: string | null = null;
    const walk = new ScopeWalk((s, env) => {
      const target = this.resolve(info, s, env);
      if (target) refs.push({ s: s.s, e: s.e, caller, target, line: info.lines.lineOf(s.s) });
    });
    info.facts.definitions.forEach((d, k) => {
      if (d.role !== "def" && d.role !== "defmethod") return;
      caller = info.ids[k] as string;
      walk.definition(d);
    });
    return refs;
  }

  edgesForFile(fileId: string): EdgeRecord[] {
    this.index();
    const info = this.byFile.get(fileId);
    const pf = this.ctx.parsed.get(fileId);
    if (!pf) return [];
    const out: EdgeRecord[] = [];
    const contains = (src: string, dst: string): EdgeRecord => ({
      src,
      dst,
      kind: "contains",
      confidence: "high",
      count: 1,
      evidence: [],
      fileId,
    });
    const ws = clojureWorkspaceOf(this.ctx.workspaces, pathOfFileId(fileId));
    if (ws) out.push(contains(ws.id, fileId));
    for (const s of pf.symbols) out.push(contains(fileId, s.id));
    if (info) {
      const set = new EdgeSet(fileId, 1);
      for (const r of this.refsOf(info)) {
        if (r.caller === null || r.caller === r.target.id) continue;
        set.add(r.caller, r.target.id, "calls", r.target.confidence, `${info.rel}:${r.line}`);
      }
      out.push(...set.edges());
    }
    return out.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  }

  /** The var a symbol, or the head of a call, at exactly this range refers to. */
  targetAt(fileId: string, start: number, end: number): string | null {
    this.index();
    const info = this.byFile.get(fileId);
    if (!info) return null;
    if (this.last?.fileId !== fileId) {
      const refs = new Map<string, string>();
      for (const r of this.refsOf(info)) refs.set(`${r.s}:${r.e}`, r.target.id);
      const heads = new Map<string, string>();
      const lists = (forms: readonly Form[]): void => {
        for (const f of forms) {
          if (!("items" in f)) continue;
          const h = f.items[0];
          if (f.t === "list" && h?.t === "sym") heads.set(`${f.s}:${f.e}`, `${h.s}:${h.e}`);
          lists(f.items);
        }
      };
      lists(info.facts.tops);
      this.last = { fileId, refs, heads };
    }
    const key = `${start}:${end}`;
    const head = this.last.heads.get(key);
    return this.last.refs.get(head ?? key) ?? null;
  }

  workspaceEdges(): EdgeRecord[] {
    return clojureDependsOnEdges(this.ctx.repo, this.manifests, this.ctx.workspaces);
  }
}

/** The resolver of the Clojure module: `contains` and `calls` edges, the target at a place, and `depends_on` between workspaces. */
export function createClojureResolver(ctx: ResolveContext): Resolver {
  const r = new ClojureResolver(ctx);
  return {
    resolveSpecifier: () => ({ kind: "unresolved" }),
    resolveSymbol: () => null,
    targetAt: (fileId, start, end) => r.targetAt(fileId, start, end),
    typeNameAt: () => null,
    edgesForFile: (fileId) => r.edgesForFile(fileId),
    workspaceEdges: () => r.workspaceEdges(),
    stats: () => ({
      counts: {
        file: 0,
        external: 0,
        builtin: 0,
        virtual: 0,
        generated: 0,
        excluded: 0,
        ambiguous: 0,
        unresolved: 0,
      },
      unresolved: [],
    }),
  };
}

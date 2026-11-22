import { symId } from "../../../ids.js";
import type { ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord } from "../../../types.js";
import type { LanguagePack, TypingRules } from "../pack.js";
import { defaultImportName } from "../parse.js";
import type { FileEntry, ImportIndex } from "./imports.js";
import { Reader } from "./read.js";
import { withTree } from "./source.js";
import type { Expr, Results, TypeDecl, TypeRef } from "./typing.js";

/** A type as far as the resolver reads it: a named type, or a sequence or map with element types. */
export type Ty =
  | { k: "named"; pkg: string; name: string }
  | { k: "seq"; elem: Ty | null }
  | { k: "map"; key: Ty | null; elem: Ty | null };

export type Named = Extract<Ty, { k: "named" }>;

export interface FuncInfo {
  results: Results;
  file: FileInfo;
}

export interface TypeInfo extends TypeDecl {
  file: FileInfo;
}

export interface VarInfo {
  declared: { type: TypeRef | null } | null;
  value: Expr | null;
  file: FileInfo;
}

export interface Pkg {
  path: string;
  name: string;
  /** A package that nothing imports (its name ends as the pack's `package.separate` says). */
  separate: boolean;
  funcs: Map<string, FuncInfo>;
  types: Map<string, TypeInfo>;
  /** Keyed `Recv.Name` with the receiver's base type. */
  methods: Map<string, FuncInfo>;
  vars: Map<string, VarInfo>;
}

/** A file of the index: where its names come from. */
export interface FileInfo {
  rel: string;
  fileId: string;
  /** Local import name to import path. Imports that bind no name are left out. */
  imports: Map<string, string>;
  pkg: Pkg;
}

/** What a method lookup found. `file` and `name` give the symbol: `sym:<repo>:<file>#<name>`. */
export interface MethodHit {
  kind: "method" | "interface-method" | "func-field";
  file: FileInfo;
  name: string;
  results: Results;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The package index behind level 2 call resolution (spec section 7): one `Pkg` per package path over the files the
 * indexer parsed (functions with result types, types with fields, embedded types and interface method sets, methods by
 * receiver base type, package-level variables), imports mapped through the workspaces, and the type helpers the
 * inference in `typed.ts` stands on. It is built from plain data; the tree of a file is gone once its declarations are
 * read.
 */
export class TypeIndex {
  readonly pkgs = new Map<string, Pkg>();
  /** Files in path order. */
  readonly files: FileInfo[] = [];
  readonly byFileId = new Map<string, FileInfo>();
  /** Every symbol id of the parsed files: an edge is emitted only to a symbol that exists. */
  readonly symbolIds = new Set<string>();
  readonly repo: string;
  private readonly typing: TypingRules;
  private readonly predeclared: ReadonlySet<string>;
  private readonly rawImports = new Map<string, { alias: string | null; specifier: string }[]>();
  private readonly order = new Map<string, TypeInfo[]>();
  private implementsByFile: Map<string, EdgeRecord[]> | null = null;

  constructor(
    private readonly pack: LanguagePack,
    ctx: ResolveContext,
    imports: ImportIndex,
    reader: Reader,
  ) {
    if (!pack.nodes.typing) throw new Error(`${pack.id}: the pack has no typing rules`);
    this.typing = pack.nodes.typing;
    this.predeclared = new Set(this.typing.type.predeclared);
    this.repo = ctx.repo;
    for (const entry of imports.files) {
      for (const s of entry.parsed.symbols) this.symbolIds.add(s.id);
      if (!entry.workspace) continue;
      const decls = withTree(pack, ctx.root, entry.rel, (root) => reader.declarations(root));
      if (!decls) continue;
      const test = decls.packageName.endsWith(this.typing.package.separate);
      const path = this.packagePath(entry);
      const key = test ? `${path} [test]` : path;
      let pkg = this.pkgs.get(key);
      if (!pkg) {
        pkg = {
          path: key,
          name: decls.packageName,
          separate: test,
          funcs: new Map(),
          types: new Map(),
          methods: new Map(),
          vars: new Map(),
        };
        this.pkgs.set(key, pkg);
      }
      const file: FileInfo = { rel: entry.rel, fileId: entry.fileId, imports: new Map(), pkg };
      this.files.push(file);
      this.byFileId.set(entry.fileId, file);
      this.rawImports.set(entry.fileId, decls.imports);
      for (const f of decls.funcs)
        if (!pkg.funcs.has(f.name)) pkg.funcs.set(f.name, { results: f.results, file });
      for (const m of decls.methods)
        if (!pkg.methods.has(m.key)) pkg.methods.set(m.key, { results: m.results, file });
      for (const t of decls.types) {
        if (pkg.types.has(t.name)) continue;
        const info: TypeInfo = { ...t, file };
        pkg.types.set(t.name, info);
        const list = this.order.get(entry.fileId) ?? [];
        list.push(info);
        this.order.set(entry.fileId, list);
      }
      for (const v of decls.vars)
        if (!pkg.vars.has(v.name)) pkg.vars.set(v.name, { declared: v.declared, value: v.value, file });
    }
    for (const f of this.files) this.mapImports(f);
  }

  symbolId(file: string, name: string): string {
    return symId(this.repo, file, name);
  }

  /** The types a file declared that the index took (a name an earlier file of the package declared first is not one). */
  typesOf(fileId: string): TypeInfo[] {
    return (this.order.get(fileId) ?? []).filter((t) => t.file.fileId === fileId);
  }

  /** Package path of a file: the workspace name, then the folder below the workspace's own. */
  private packagePath(entry: FileEntry): string {
    const w = entry.workspace as NonNullable<FileEntry["workspace"]>;
    const sep = this.pack.nodes.import.separator;
    const sub = w.dir === "." ? entry.dir : entry.dir === w.dir ? "." : entry.dir.slice(w.dir.length + 1);
    return sub === "." ? w.name : `${w.name}${sep}${sub.split("/").join(sep)}`;
  }

  /** Local name of an import without an alias: the package's own name for a package of the repo, the path's last piece otherwise. */
  private localName(path: string): string {
    return this.pkgs.get(path)?.name ?? defaultImportName(this.pack, path);
  }

  private mapImports(f: FileInfo): void {
    for (const i of this.rawImports.get(f.fileId) ?? []) {
      if (i.specifier === "" || (i.alias !== null && this.typing.unboundAliases.includes(i.alias))) continue;
      f.imports.set(i.alias ?? this.localName(i.specifier), i.specifier);
    }
    this.rawImports.delete(f.fileId);
  }

  typeInfo(r: Named): TypeInfo | undefined {
    return this.pkgs.get(r.pkg)?.types.get(r.name);
  }

  /** Resolves a type as written in `file` to a named type, sequence or map; null for anything else. */
  resolveType(t: TypeRef | null, file: FileInfo): Ty | null {
    if (!t) return null;
    switch (t.k) {
      case "name":
        if (!file.pkg.types.has(t.name) && this.predeclared.has(t.name)) return null;
        return { k: "named", pkg: file.pkg.path, name: t.name };
      case "qual": {
        const path = file.imports.get(t.qualifier);
        return path ? { k: "named", pkg: path, name: t.name } : null;
      }
      case "seq":
        return { k: "seq", elem: this.resolveType(t.elem, file) };
      case "map":
        return { k: "map", key: this.resolveType(t.key, file), elem: this.resolveType(t.elem, file) };
    }
  }

  /** Follows aliases (`type A = B`) to the target. */
  canon(t: Ty | null, depth = 0): Ty | null {
    if (!t || depth > 8 || t.k !== "named") return t;
    const ti = this.typeInfo(t);
    if (ti?.kind === "alias") return this.canon(this.resolveType(ti.target, ti.file), depth + 1);
    return t;
  }

  /** A named type whose declared underlying type is a sequence or map reads as that composite. */
  shape(t: Ty | null): Ty | null {
    const c = this.canon(t);
    if (!c) return null;
    if (c.k !== "named") return c;
    const ti = this.typeInfo(c);
    if (ti?.kind === "other") {
      const u = this.resolveType(ti.target, ti.file);
      if (u && u.k !== "named") return u;
    }
    return c;
  }

  fieldType(r: Named, name: string, depth = 0): Ty | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 4) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "class") return null;
    if (ti.fields.has(name)) return this.resolveType(ti.fields.get(name) ?? null, ti.file);
    for (const e of ti.embedded) {
      const er = this.resolveType(e.type, ti.file);
      if (er?.k !== "named") continue;
      if (er.name === name) return er;
      const sub = this.fieldType(er, name, depth + 1);
      if (sub) return sub;
    }
    return null;
  }

  /** Method `m` of a named type: declared on it, promoted through embedding, or a method of an interface. */
  lookupMethod(r: Named, m: string, depth = 0, viaClass = false): MethodHit | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const pkg = this.pkgs.get(c.pkg);
    if (!pkg) return null;
    const own = pkg.methods.get(`${c.name}.${m}`);
    if (own) return { kind: "method", file: own.file, name: `${c.name}.${m}`, results: own.results };
    const ti = pkg.types.get(c.name);
    if (!ti) return null;
    if (ti.kind === "interface") {
      // A direct call is the interface's own method; one promoted through a class names the declaring interface.
      const hit = this.interfaceMethod(c, m, 0);
      if (!hit) return null;
      return { ...hit, kind: viaClass ? "method" : "interface-method" };
    }
    if (ti.kind === "class") {
      if (ti.fields.has(m)) return { kind: "func-field", file: ti.file, name: "", results: [] };
      for (const e of ti.embedded) {
        const er = this.resolveType(e.type, ti.file);
        const sub = er?.k === "named" ? this.lookupMethod(er, m, depth + 1, true) : null;
        if (sub) return sub;
      }
    }
    return null;
  }

  /** Interface method lookup; the hit names the interface that declares the method (embedded ones included). */
  interfaceMethod(r: Named, m: string, depth: number): MethodHit | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "interface") return null;
    const own = ti.methods.get(m);
    if (own) return { kind: "interface-method", file: ti.file, name: `${c.name}.${m}`, results: own };
    for (const e of ti.embeds) {
      const er = this.resolveType(e, ti.file);
      const hit = er?.k === "named" ? this.interfaceMethod(er, m, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  }

  // --- interface satisfaction by method names -------------------------------------------------

  /** Method names of an in-repo interface, embedded interfaces included; null when one is outside the repo or open. */
  interfaceNames(r: Named, depth = 0): Set<string> | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "interface" || ti.open) return null;
    const out = new Set(ti.methods.keys());
    for (const e of ti.embeds) {
      const er = this.resolveType(e, ti.file);
      const sub = er?.k === "named" ? this.interfaceNames(er, depth + 1) : null;
      if (!sub) return null;
      for (const n of sub) out.add(n);
    }
    return out;
  }

  /** Method names of a concrete type: its own (value or pointer receiver) and those promoted through embedding. */
  methodNames(r: Named, depth = 0): Set<string> {
    const out = new Set<string>();
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return out;
    const pkg = this.pkgs.get(c.pkg);
    if (!pkg) return out;
    for (const k of pkg.methods.keys()) if (k.startsWith(`${c.name}.`)) out.add(k.slice(c.name.length + 1));
    const ti = pkg.types.get(c.name);
    if (ti?.kind === "class") {
      for (const e of ti.embedded) {
        const er = this.resolveType(e.type, ti.file);
        if (er?.k !== "named") continue;
        const sub =
          this.typeInfo(er)?.kind === "interface"
            ? (this.interfaceNames(er) ?? new Set<string>())
            : this.methodNames(er, depth + 1);
        for (const n of sub) out.add(n);
      }
    }
    return out;
  }

  /**
   * `implements` edges at low confidence, by method names alone: a named in-repo type whose method names (value or
   * pointer receiver, promoted ones included) cover the method set of an in-repo interface. Interfaces that embed one
   * from outside the repo are skipped. Grouped by the file of the implementing type.
   */
  implementers(): Map<string, EdgeRecord[]> {
    if (this.implementsByFile) return this.implementsByFile;
    const out = new Map<string, EdgeRecord[]>();
    this.implementsByFile = out;
    const pkgs = [...this.pkgs.values()].filter((p) => !p.separate).sort((a, b) => cmp(a.path, b.path));
    const types: { name: string; info: TypeInfo; names: Set<string> }[] = [];
    const byMethod = new Map<string, number[]>();
    const ifaces: { name: string; info: TypeInfo; want: string[] }[] = [];
    for (const p of pkgs) {
      for (const name of [...p.types.keys()].sort()) {
        const info = p.types.get(name);
        if (!info || info.generic || info.kind === "alias") continue;
        const ref: Named = { k: "named", pkg: p.path, name };
        if (info.kind === "interface") {
          const want = this.interfaceNames(ref);
          if (want && want.size > 0) ifaces.push({ name, info, want: [...want].sort() });
          continue;
        }
        const i = types.length;
        types.push({ name, info, names: this.methodNames(ref) });
        for (const m of types[i]?.names ?? []) {
          const list = byMethod.get(m) ?? [];
          list.push(i);
          byMethod.set(m, list);
        }
      }
    }
    for (const iface of ifaces) {
      let candidates: number[] | undefined;
      for (const m of iface.want) {
        const list = byMethod.get(m);
        if (!list) {
          candidates = [];
          break;
        }
        if (!candidates || list.length < candidates.length) candidates = list;
      }
      for (const i of candidates ?? []) {
        const t = types[i];
        if (!t || !iface.want.every((m) => t.names.has(m))) continue;
        const src = this.symbolId(t.info.file.rel, t.name);
        const dst = this.symbolId(iface.info.file.rel, iface.name);
        if (src === dst || !this.symbolIds.has(src) || !this.symbolIds.has(dst)) continue;
        const fileId = t.info.file.fileId;
        const list = out.get(fileId) ?? [];
        list.push({
          src,
          dst,
          kind: "implements",
          confidence: "low",
          count: 1,
          evidence: [`${t.info.file.rel}:${t.info.line}`],
          fileId,
        });
        out.set(fileId, list);
      }
    }
    return out;
  }
}

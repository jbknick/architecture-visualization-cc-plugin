import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathOfFileId, symId } from "../../ids.js";
import type { ResolveContext } from "../../resolve/index.js";
import { type GoNode, parseGo } from "./grammar.js";

/**
 * The package index behind Go call, `extends` and `implements` edges (spec section 7): one `Pkg` per package path over
 * the files the indexer parsed (functions with result types, types with struct fields and embedded fields,
 * interface method sets, methods by receiver base type, package-level vars), imports mapped through each workspace's
 * `go.mod` module path, and the type helpers the local inference in `calls.ts` stands on. Syntax only.
 */

export const PREDECLARED_TYPES = new Set(
  "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr".split(
    " ",
  ),
);

/** A type as far as the inference reads it: a named type, or a slice/array/channel or map with element types. */
export type Ty =
  | { k: "named"; pkg: string; name: string }
  | { k: "seq"; elem: Ty | null }
  | { k: "map"; key: Ty | null; elem: Ty | null };

export type Named = Extract<Ty, { k: "named" }>;

/** A type expression with the file it was written in (imports and package scope are per file). */
export interface TypeNode {
  node: GoNode;
  ctx: FileCtx;
}

export interface FuncInfo {
  results: TypeNode[];
  /** Repo-relative path of the declaring file. */
  file: string;
}

export interface TypeInfo {
  kind: "struct" | "interface" | "alias" | "other";
  ctx: FileCtx;
  /** 1-based line of the declaration. */
  line: number;
  generic: boolean;
  fields: Map<string, GoNode>;
  /** Embedded field types of a struct. */
  embedded: GoNode[];
  /** Methods declared in an interface body. */
  ifaceMethods: Map<string, FuncInfo>;
  /** Embedded types of an interface body. */
  ifaceEmbeds: GoNode[];
  /** True when the interface body has an element that is not a plain named type (union, `~T`). */
  ifaceOpaque: boolean;
  /** The type expression after the name. */
  target: GoNode;
}

export interface VarInfo {
  type: GoNode | null;
  value: GoNode | null;
  ctx: FileCtx;
}

export interface Pkg {
  path: string;
  name: string;
  /** External test package (`package x_test`): never an import target. */
  test: boolean;
  funcs: Map<string, FuncInfo>;
  types: Map<string, TypeInfo>;
  /** Keyed `Recv.Name` with the receiver's base type. */
  methods: Map<string, FuncInfo>;
  vars: Map<string, VarInfo>;
}

export interface FileCtx {
  rel: string;
  fileId: string;
  root: GoNode;
  /** Local import name to import path. Blank and dot imports are left out. */
  imports: Map<string, string>;
  pkg: Pkg;
}

/** What a method lookup found. `file` and `name` give the symbol: `sym:<repo>:<file>#<name>`. */
export interface MethodHit {
  kind: "method" | "interface-method" | "func-field";
  file: string;
  name: string;
  results: TypeNode[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const SPEC_LISTS = (n: GoNode, kinds: ReadonlySet<string>, into: GoNode[] = []): GoNode[] => {
  for (const c of n.namedChildren()) {
    if (kinds.has(c.kind())) into.push(c);
    else if (c.kind().endsWith("_list")) SPEC_LISTS(c, kinds, into);
  }
  return into;
};

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, "");

/** Strips `*`, parentheses and type arguments: `*S[T]` becomes `S`. */
export function baseOfType(n: GoNode | null): GoNode | null {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (k === "pointer_type" || k === "parenthesized_type") cur = cur.namedChildren()[0] ?? null;
    else if (k === "generic_type") cur = cur.field("type");
    else return cur;
  }
  return null;
}

/** Result types of a function or interface method, one per returned value. */
function resultsOf(decl: GoNode, ctx: FileCtx): TypeNode[] {
  const r = decl.field("result");
  if (!r) return [];
  if (r.kind() !== "parameter_list") return [{ node: r, ctx }];
  const out: TypeNode[] = [];
  for (const p of r.namedChildren()) {
    const t = p.field("type");
    if (!t) continue;
    const names = p.fieldChildren("name").filter((n) => n.kind() === "identifier").length;
    for (let i = 0; i < Math.max(1, names); i++) out.push({ node: t, ctx });
  }
  return out;
}

/** Package path to directory pieces: the longest Go workspace holding `rel` gives the module path. */
function packagePath(ctx: ResolveContext, rel: string): string | null {
  let best: (typeof ctx.workspaces)[number] | undefined;
  for (const w of ctx.workspaces) {
    if (w.lang !== "go") continue;
    if (w.dir === "." || rel.startsWith(`${w.dir}/`)) {
      if (!best || (w.dir === "." ? 0 : w.dir.length) > (best.dir === "." ? 0 : best.dir.length)) best = w;
    }
  }
  if (!best) return null;
  const slash = rel.lastIndexOf("/");
  const dir = slash < 0 ? "." : rel.slice(0, slash);
  const sub = best.dir === "." ? dir : dir === best.dir ? "." : dir.slice(best.dir.length + 1);
  return sub === "." ? best.name : `${best.name}/${sub}`;
}

function packageNameOf(root: GoNode): string {
  const clause = root.namedChildren().find((c) => c.kind() === "package_clause");
  return clause?.namedChildren()[0]?.text() ?? "?";
}

export class GoIndex {
  readonly pkgs = new Map<string, Pkg>();
  /** Files in path order. */
  readonly files: FileCtx[] = [];
  readonly byFileId = new Map<string, FileCtx>();
  /** Every symbol id of the parsed files: an edge is emitted only to a symbol that exists. */
  readonly symbolIds = new Set<string>();
  readonly repo: string;

  constructor(ctx: ResolveContext) {
    this.repo = ctx.repo;
    const rels: { rel: string; fileId: string }[] = [];
    for (const fileId of ctx.parsed.keys()) {
      const rel = pathOfFileId(fileId);
      if (!rel.endsWith(".go")) continue;
      rels.push({ rel, fileId });
      for (const s of ctx.parsed.get(fileId)?.symbols ?? []) this.symbolIds.add(s.id);
    }
    rels.sort((a, b) => cmp(a.rel, b.rel));
    for (const { rel, fileId } of rels) {
      const pkgPath = packagePath(ctx, rel);
      if (pkgPath === null) continue;
      let source: string;
      try {
        source = readFileSync(join(ctx.root, rel), "utf8");
      } catch {
        continue;
      }
      let root: GoNode;
      try {
        root = parseGo(source);
      } catch {
        continue;
      }
      const name = packageNameOf(root);
      const test = name.endsWith("_test");
      const key = test ? `${pkgPath} [test]` : pkgPath;
      let pkg = this.pkgs.get(key);
      if (!pkg) {
        pkg = {
          path: key,
          name,
          test,
          funcs: new Map(),
          types: new Map(),
          methods: new Map(),
          vars: new Map(),
        };
        this.pkgs.set(key, pkg);
      }
      const fc: FileCtx = { rel, fileId, root, imports: new Map(), pkg };
      this.files.push(fc);
      this.byFileId.set(fileId, fc);
    }
    for (const f of this.files) this.declare(f);
    for (const f of this.files) this.mapImports(f);
  }

  symbolId(file: string, name: string): string {
    return symId(this.repo, file, name);
  }

  /** Default import name of an import path: the `package` clause for an in-repo package, a guess from the path otherwise. */
  private defaultName(path: string): string {
    const p = this.pkgs.get(path);
    if (p) return p.name;
    const parts = path.split("/");
    let last = parts[parts.length - 1] as string;
    if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] as string;
    return last
      .replace(/\.v\d+$/, "")
      .replace(/^go-/, "")
      .replace(/-go$/, "")
      .replace(/[.-]/g, "_");
  }

  private mapImports(f: FileCtx): void {
    for (const d of f.root.namedChildren()) {
      if (d.kind() !== "import_declaration") continue;
      for (const s of SPEC_LISTS(d, new Set(["import_spec"]))) {
        const path = unquote(s.field("path")?.text() ?? "");
        const alias = s.field("name")?.text();
        if (path === "" || alias === "_" || alias === ".") continue;
        f.imports.set(alias ?? this.defaultName(path), path);
      }
    }
  }

  private declare(ctx: FileCtx): void {
    const { pkg } = ctx;
    for (const d of ctx.root.namedChildren()) {
      switch (d.kind()) {
        case "function_declaration": {
          const n = d.field("name")?.text();
          if (n && n !== "init" && n !== "_" && !pkg.funcs.has(n))
            pkg.funcs.set(n, { results: resultsOf(d, ctx), file: ctx.rel });
          break;
        }
        case "method_declaration": {
          const n = d.field("name")?.text();
          const p = d
            .field("receiver")
            ?.namedChildren()
            .find((c) => c.kind() === "parameter_declaration");
          const recv = baseOfType(p?.field("type") ?? null)?.text();
          const key = `${recv}.${n}`;
          if (n && recv && !pkg.methods.has(key))
            pkg.methods.set(key, { results: resultsOf(d, ctx), file: ctx.rel });
          break;
        }
        case "type_declaration":
          for (const s of SPEC_LISTS(d, new Set(["type_spec", "type_alias"]))) {
            const n = s.field("name")?.text();
            const t = s.field("type");
            if (!n || !t || pkg.types.has(n)) continue;
            pkg.types.set(n, this.typeInfoOf(s, t, ctx));
          }
          break;
        case "var_declaration":
          for (const s of SPEC_LISTS(d, new Set(["var_spec"]))) {
            const names = s.fieldChildren("name").filter((x) => x.kind() === "identifier");
            const values = s.field("value")?.namedChildren() ?? [];
            names.forEach((nm, i) => {
              const n = nm.text();
              if (n === "_" || pkg.vars.has(n)) return;
              pkg.vars.set(n, {
                type: s.field("type"),
                value: values.length === names.length ? (values[i] ?? null) : null,
                ctx,
              });
            });
          }
          break;
      }
    }
  }

  private typeInfoOf(spec: GoNode, t: GoNode, ctx: FileCtx): TypeInfo {
    const info: TypeInfo = {
      kind: spec.kind() === "type_alias" ? "alias" : "other",
      ctx,
      line: spec.range().start.line + 1,
      generic: spec.field("type_parameters") !== null,
      fields: new Map(),
      embedded: [],
      ifaceMethods: new Map(),
      ifaceEmbeds: [],
      ifaceOpaque: false,
      target: t,
    };
    if (info.kind === "alias") return info;
    if (t.kind() === "struct_type") {
      info.kind = "struct";
      const list = t.namedChildren().find((c) => c.kind() === "field_declaration_list");
      for (const fd of list?.namedChildren() ?? []) {
        if (fd.kind() !== "field_declaration") continue;
        const ft = fd.field("type");
        if (!ft) continue;
        const names = fd.fieldChildren("name").filter((x) => x.kind() === "field_identifier");
        if (names.length === 0) info.embedded.push(ft);
        for (const nm of names) info.fields.set(nm.text(), ft);
      }
    } else if (t.kind() === "interface_type") {
      info.kind = "interface";
      for (const c of t.namedChildren()) {
        if (c.kind() === "method_elem") {
          const nm = c.field("name")?.text();
          if (nm) info.ifaceMethods.set(nm, { results: resultsOf(c, ctx), file: ctx.rel });
        } else if (c.kind() === "type_elem") {
          const parts = c.namedChildren();
          const e = parts[0];
          if (parts.length === 1 && e && (e.kind() === "type_identifier" || e.kind() === "qualified_type"))
            info.ifaceEmbeds.push(e);
          else info.ifaceOpaque = true;
        }
      }
    }
    return info;
  }

  typeInfo(r: Named): TypeInfo | undefined {
    return this.pkgs.get(r.pkg)?.types.get(r.name);
  }

  /** Resolves a type expression to a named type, slice or map; null for anything else (func, struct literal, predeclared). */
  resolveType(t: TypeNode | null, depth = 0): Ty | null {
    if (!t || depth > 8) return null;
    const b = baseOfType(t.node);
    if (!b) return null;
    switch (b.kind()) {
      case "type_identifier": {
        const name = b.text();
        if (!t.ctx.pkg.types.has(name) && PREDECLARED_TYPES.has(name)) return null;
        return { k: "named", pkg: t.ctx.pkg.path, name };
      }
      case "qualified_type": {
        const alias = b.field("package")?.text() ?? "";
        const name = b.field("name")?.text() ?? "";
        const path = t.ctx.imports.get(alias);
        return path ? { k: "named", pkg: path, name } : null;
      }
      case "slice_type":
      case "array_type":
      case "implicit_length_array_type": {
        const e = b.field("element");
        return { k: "seq", elem: e ? this.resolveType({ node: e, ctx: t.ctx }, depth + 1) : null };
      }
      case "channel_type": {
        const e = b.field("value");
        return { k: "seq", elem: e ? this.resolveType({ node: e, ctx: t.ctx }, depth + 1) : null };
      }
      case "map_type": {
        const k = b.field("key");
        const v = b.field("value");
        return {
          k: "map",
          key: k ? this.resolveType({ node: k, ctx: t.ctx }, depth + 1) : null,
          elem: v ? this.resolveType({ node: v, ctx: t.ctx }, depth + 1) : null,
        };
      }
    }
    return null;
  }

  /** Follows aliases (`type A = B`) to the target. */
  canon(t: Ty | null, depth = 0): Ty | null {
    if (!t || depth > 8 || t.k !== "named") return t;
    const ti = this.typeInfo(t);
    if (ti?.kind === "alias")
      return this.canon(this.resolveType({ node: ti.target, ctx: ti.ctx }), depth + 1);
    return t;
  }

  /** A named type whose declared underlying type is a slice, array or map reads as that composite. */
  shape(t: Ty | null): Ty | null {
    const c = this.canon(t);
    if (!c) return null;
    if (c.k !== "named") return c;
    const ti = this.typeInfo(c);
    if (ti?.kind === "other") {
      const u = this.resolveType({ node: ti.target, ctx: ti.ctx });
      if (u && u.k !== "named") return u;
    }
    return c;
  }

  fieldType(r: Named, name: string, depth = 0): Ty | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 4) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "struct") return null;
    const f = ti.fields.get(name);
    if (f) return this.resolveType({ node: f, ctx: ti.ctx });
    for (const e of ti.embedded) {
      const er = this.resolveType({ node: e, ctx: ti.ctx });
      if (er?.k !== "named") continue;
      if (er.name === name) return er;
      const sub = this.fieldType(er, name, depth + 1);
      if (sub) return sub;
    }
    return null;
  }

  /** Method `m` of a named type: declared on it, promoted through struct embedding, or a method of an interface. */
  lookupMethod(r: Named, m: string, depth = 0, viaStruct = false): MethodHit | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const pkg = this.pkgs.get(c.pkg);
    if (!pkg) return null;
    const own = pkg.methods.get(`${c.name}.${m}`);
    if (own) return { kind: "method", file: own.file, name: `${c.name}.${m}`, results: own.results };
    const ti = pkg.types.get(c.name);
    if (!ti) return null;
    if (ti.kind === "interface") {
      // A direct call is the interface's own method; one promoted through a struct names the declaring interface.
      const hit = this.interfaceMethod(c, m, 0);
      if (!hit) return null;
      return { ...hit, kind: viaStruct ? "method" : "interface-method" };
    }
    if (ti.kind === "struct") {
      if (ti.fields.has(m)) return { kind: "func-field", file: "", name: "", results: [] };
      for (const e of ti.embedded) {
        const er = this.resolveType({ node: e, ctx: ti.ctx });
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
    const own = ti.ifaceMethods.get(m);
    if (own)
      return { kind: "interface-method", file: own.file, name: `${c.name}.${m}`, results: own.results };
    for (const e of ti.ifaceEmbeds) {
      const er = this.resolveType({ node: e, ctx: ti.ctx });
      const hit = er?.k === "named" ? this.interfaceMethod(er, m, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  }

  // --- interface satisfaction by method names -------------------------------------------------

  /** Method names of an in-repo interface, embedded interfaces included; null when one is outside the repo or opaque. */
  interfaceNames(r: Named, depth = 0): Set<string> | null {
    const c = this.canon(r);
    if (!c || c.k !== "named" || depth > 5) return null;
    const ti = this.typeInfo(c);
    if (ti?.kind !== "interface" || ti.ifaceOpaque) return null;
    const out = new Set(ti.ifaceMethods.keys());
    for (const e of ti.ifaceEmbeds) {
      const er = this.resolveType({ node: e, ctx: ti.ctx });
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
    if (ti?.kind === "struct") {
      for (const e of ti.embedded) {
        const er = this.resolveType({ node: e, ctx: ti.ctx });
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
}

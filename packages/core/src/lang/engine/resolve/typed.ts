import type { ParsedFile } from "../../../parse/index.js";
import type { ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord } from "../../../types.js";
import type { SyntaxNode } from "../grammar.js";
import type { CallResolver } from "../module.js";
import type { LanguagePack, TypingRules } from "../pack.js";
import { EdgeSet } from "./edges.js";
import { ImportIndex } from "./imports.js";
import { Reader } from "./read.js";
import { LastTree, withTree } from "./source.js";
import {
  type Bindings,
  type FileInfo,
  type MethodHit,
  type Named,
  type Ty,
  TypeIndex,
  type VarInfo,
} from "./typeindex.js";
import type { CallExpr, Callee, Decl, DeclSource, Expr, LocalBody, Results, TypeRef } from "./typing.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The deepest chain of expressions the types of which are followed. */
const MAX_DEPTH = 12;

export interface Local {
  /** Source offset from which the name is visible. */
  pos: number;
  decl: Decl;
  memo?: Ty | null;
  /** True when `memo` rests on a fact only the flow resolver reads. */
  flow?: boolean;
  busy: boolean;
}
export type Scope = Map<string, Local[]>;

export interface Env {
  file: FileInfo;
  scope: Scope;
  /** The type whose body the code is in; null outside a type body. */
  owner: Named | null;
}

/** A call the resolver found in a file: the edge it makes, and whether a fact only the flow resolver reads was used. */
export interface Site {
  src: string;
  dst: string;
  confidence: "high" | "low";
  evidence: string;
  flow: boolean;
}

/** A function or method of the repo: the file that declares it and the offset of its declaration, which names its symbol. */
interface Target {
  file: FileInfo;
  start: number;
}

/**
 * What a callee resolves to. `targets` are the functions or methods it may be: one for a call that is certain, several
 * for overloads that the number of arguments does not tell apart.
 */
interface Resolved {
  targets: Target[];
  results: Results;
  /** The file the result types are written in. */
  file: FileInfo;
  conversion?: Ty | null;
  /** What the type parameters in `results` stand for. */
  bind?: Bindings;
  /** The type the call has when it is no function of the repo but an accessor of a library type the pack knows. */
  result?: Ty | null;
  line: number;
}

function lookupLocal(scope: Scope, name: string, pos: number): Local | null {
  let best: Local | null = null;
  for (const l of scope.get(name) ?? []) if (l.pos <= pos && (!best || l.pos > best.pos)) best = l;
  return best;
}

const named = (t: Ty | null): Named | null => (t?.k === "named" ? t : null);

/**
 * Level 2 call resolution (spec section 7), from declared types: the receiver of a call has the type of a parameter, a
 * field, a typed local, a constructor result or a declared result type, found with the node kinds and fields the pack's
 * `typing` names. Per function the declared names are collected with their types (scopes are flattened: the nearest
 * preceding declaration of a name wins, and a function literal counts as the function around it). A call whose
 * receiver type is unknown gives no edge; nothing is guessed. `calls` edges are `high`, unless the number of arguments
 * leaves several overloads: then each is a `low` edge. `extends` runs from a class to each in-repo type it embeds or
 * names as its superclass (`high`); `implements` runs from a type to each in-repo interface whose method names it
 * covers (`low`), or, for a pack that says `nominal`, to each in-repo interface its declaration names (`high`). The index
 * and the scopes of the edges hold plain data and the tree of a file is dropped once its facts are read; only the lookups
 * by place keep the tree of the last file they were asked about, one at a time.
 */
export class TypeCalls implements CallResolver {
  protected readonly typing: TypingRules;
  protected readonly reader: Reader;
  protected readonly imports: ImportIndex;
  private index: TypeIndex | undefined;
  /** Set while a call site is resolved: true once a fact that only the flow resolver reads was used. This resolver never reads one. */
  protected usedFlow = false;
  /** The tree of the last file a lookup by place read, with the expressions and scopes found in it. */
  private readonly last: LastTree<{
    root: SyntaxNode;
    byRange: Map<string, SyntaxNode>;
    scopes: Map<number, Scope>;
  }>;

  /** With `shared`, the index, the reader and the imports of that resolver are used instead of a second set. */
  constructor(
    protected readonly pack: LanguagePack,
    protected readonly ctx: ResolveContext,
    private readonly shared?: TypeCalls,
  ) {
    if (!pack.nodes.typing) throw new Error(`${pack.id}: the pack has no typing rules`);
    this.typing = pack.nodes.typing;
    this.last = new LastTree(pack, ctx.root);
    this.reader = shared ? shared.reader : new Reader(pack);
    this.imports = shared ? shared.imports : new ImportIndex(pack, ctx);
  }

  protected idx(): TypeIndex {
    if (this.shared) return this.shared.idx();
    this.index ??= new TypeIndex(this.pack, this.ctx, this.imports, this.reader);
    return this.index;
  }

  protected ownerOf(file: FileInfo, owner: string | null): Named | null {
    return owner === null ? null : { k: "named", pkg: file.pkg.path, name: owner };
  }

  /**
   * The edges of every call site of a file, in source order, each with whether it rests on a fact that only the flow
   * resolver reads. Empty when the file is not in the index.
   */
  protected sites(fileId: string, pf: ParsedFile): Site[] {
    const idx = this.idx();
    const file = idx.byFileId.get(fileId);
    if (!file) return [];
    const bodies = withTree(this.pack, this.ctx.root, file.rel, (root) => this.reader.bodies(root));
    if (!bodies) return [];
    const idByStart = new Map<number, string>();
    // Code outside a method (an initializer) belongs to the symbol of the type around it, so every symbol is a caller.
    for (const s of pf.symbols) {
      const r = pf.bodies.get(s.id);
      if (r && !idByStart.has(r.start)) idByStart.set(r.start, s.id);
    }
    const out: Site[] = [];
    for (const b of bodies) {
      const src = idByStart.get(b.start);
      if (!src) continue;
      const env: Env = { file, scope: this.scope(b.decls), owner: this.ownerOf(file, b.owner) };
      for (const site of b.calls) {
        this.usedFlow = false;
        const r = this.resolveCall(site.call, env, 0);
        // Overloads the number of arguments does not tell apart are each a guess.
        const confidence = r.targets.length === 1 ? "high" : "low";
        for (const t of r.targets) {
          const dst = idx.symbolAt(t.file.fileId, t.start);
          if (!dst || dst === src) continue;
          out.push({ src, dst, confidence, evidence: `${file.rel}:${r.line}`, flow: this.usedFlow });
        }
      }
    }
    return out;
  }

  /** The `calls`, `extends` and `implements` edges whose source is in this file, sorted by (src, dst, kind). */
  edgesForFile(fileId: string, pf: ParsedFile): EdgeRecord[] {
    const idx = this.idx();
    const file = idx.byFileId.get(fileId);
    if (!file) return [];
    const calls = new EdgeSet(fileId, 2);
    for (const s of this.sites(fileId, pf)) calls.add(s.src, s.dst, "calls", s.confidence, s.evidence);
    const extended = new EdgeSet(fileId);
    for (const t of idx.typesOf(fileId)) {
      const src = idx.symbolAt(fileId, t.start);
      if (!src) continue;
      const to = (type: TypeRef | null): string | null => {
        const ty = named(idx.resolveType(type, file));
        const target = ty ? idx.typeInfo(ty) : undefined;
        return target ? idx.symbolAt(target.file.fileId, target.start) : null;
      };
      if (t.kind === "class")
        for (const e of t.embedded) {
          const dst = to(e.type);
          if (dst && dst !== src) extended.add(src, dst, "extends", "high", `${file.rel}:${e.line}`);
        }
      for (const s of t.supers) {
        const dst = to(s.type);
        if (dst && dst !== src) extended.add(src, dst, s.edge, "high", `${file.rel}:${s.line}`);
      }
    }
    const implemented = this.typing.implements === "structural" ? (idx.implementers().get(fileId) ?? []) : [];
    const out = [...calls.edges(), ...extended.edges(), ...implemented];
    return out.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  }

  // --- lookups by place (the recipe engine) -------------------------------------------------

  /** The expression of a file at an exact source range, read against the scope of the function around it. */
  private at<T>(
    fileId: string,
    start: number,
    end: number,
    use: (node: SyntaxNode, env: Env, reader: Reader) => T,
  ): T | null {
    const file = this.idx().byFileId.get(fileId);
    if (!file) return null;
    const place = this.last.get(file.rel, (root) => {
      const byRange = new Map<string, SyntaxNode>();
      const kinds = this.typing.lookups.map((kind) => ({ kind }));
      for (const n of root.findAll({ rule: { any: kinds } })) {
        const r = n.range();
        const key = `${r.start.index}:${r.end.index}`;
        if (!byRange.has(key)) byRange.set(key, n);
      }
      return { root, byRange, scopes: new Map<number, Scope>() };
    });
    const node = place?.byRange.get(`${start}:${end}`);
    if (!place || !node) return null;
    const fd = this.reader.functionAt(place.root, start, end);
    let scope: Scope = new Map();
    if (fd) {
      const key = fd.node.range().start.index;
      const hit = place.scopes.get(key);
      if (hit) scope = hit;
      else {
        scope = this.scope(this.reader.declsOf(fd));
        place.scopes.set(key, scope);
      }
    }
    this.reader.setFunction(fd);
    try {
      return use(node, { file, scope, owner: this.ownerOf(file, fd?.owner ?? null) }, this.reader);
    } finally {
      this.reader.setFunction(null);
    }
  }

  /**
   * The symbol id of the function or method that the call, or the function named without a call (`rs.login`,
   * `pkg.Handler`, `handler`), at this source range refers to; null when it is not a function of the repository, the
   * type of its receiver is unknown or several overloads fit.
   */
  targetAt(fileId: string, start: number, end: number): string | null {
    const idx = this.idx();
    const r = this.at(fileId, start, end, (node, env, reader) => {
      const c = reader.calleeAt(node);
      return this.resolveCallee(c.callee, c.args, env, 0);
    });
    const t = r?.targets.length === 1 ? r.targets[0] : undefined;
    return t ? idx.symbolAt(t.file.fileId, t.start) : null;
  }

  /** The name of the named type of the expression at this range (a sequence or map reads as its element); null when unknown. */
  typeNameAt(fileId: string, start: number, end: number): string | null {
    const idx = this.idx();
    return this.at(fileId, start, end, (node, env, reader) => {
      let t = idx.shape(this.typeOf(reader.expr(node), env, 0, 0));
      if (t?.k === "seq") t = idx.shape(t.elem);
      else if (t?.k === "map") t = idx.shape(t.elem);
      return t?.k === "named" ? t.name : null;
    });
  }

  // --- scopes -------------------------------------------------------------------------------

  protected scope(decls: readonly Decl[]): Scope {
    const scope: Scope = new Map();
    for (const decl of decls) {
      const list = scope.get(decl.name) ?? [];
      list.push({ pos: decl.pos, decl, busy: false });
      scope.set(decl.name, list);
    }
    return scope;
  }

  /**
   * The declaration a name at `pos` refers to; null when it is no local. A local declared outside a type body the code
   * is in (a parameter of the method a hanging body was created in) is hidden by a field of that name that the body
   * declares or inherits.
   */
  private local(env: Env, name: string, pos: number): Local | null {
    const l = lookupLocal(env.scope, name, pos);
    if (!l || !env.owner) return l;
    const index = this.idx();
    for (const o of index.chain(env.owner)) {
      const ti = index.typeInfo(o);
      // A type that starts before the declaration holds it: the local is the nearer name from here outward.
      if (!ti || ti.file !== env.file || ti.start <= l.pos) return l;
      if (index.fieldType(o, name)) return null;
    }
    return l;
  }

  /** The type a declared name has; a name that depends on itself has none. */
  protected typeOfLocal(l: Local, env: Env): Ty | null {
    if (l.memo !== undefined) {
      if (l.flow) this.usedFlow = true;
      return l.memo;
    }
    if (l.busy) return null;
    l.busy = true;
    const outer = l.decl.outer;
    const before = this.usedFlow;
    this.usedFlow = false;
    l.memo = this.declType(l.decl, outer ? { ...env, owner: this.ownerOf(env.file, outer.owner) } : env);
    l.flow = this.usedFlow;
    this.usedFlow ||= before;
    l.busy = false;
    return l.memo;
  }

  /** What a declared name reads: the source the declared types know. The flow resolver reads more. */
  protected sourceOf(decl: Decl): DeclSource {
    return decl.source;
  }

  /** The type of the value a method is called on; the declared types know nothing of it. */
  protected selfType(_env: Env): Ty | null {
    return null;
  }

  /** The type of a value a call that names a type of the repo creates (`T(x)`). A pack with flow rules gives it to the flow resolver only. */
  protected created(t: Ty): Ty | null {
    return this.typing.flow ? null : t;
  }

  /** The type of a field of a named type. The flow resolver adds the attributes the initializer of a type assigns. */
  protected fieldTypeOf(t: Named, name: string): Ty | null {
    return this.idx().fieldType(t, name);
  }

  /** The type of a variable whose value gives it a type only for the flow resolver. */
  protected flowVar(_v: VarInfo, _depth: number): Ty | null {
    return null;
  }

  private declType(decl: Decl, env: Env): Ty | null {
    const idx = this.idx();
    const s = this.sourceOf(decl);
    switch (s.k) {
      case "self":
        return this.selfType(env);
      case "type": {
        const t = idx.resolveType(s.type, env.file);
        return s.variadic ? { k: "seq", elem: t } : t;
      }
      case "values":
        if (s.typed) return idx.resolveType(s.type, env.file);
        if (s.values.length === s.count) return this.typeOf(s.values[s.index] ?? null, env, 0, 0);
        if (s.values.length === 1) return this.typeOf(s.values[0] ?? null, env, s.index, 0);
        return null;
      case "range": {
        const t = idx.shape(this.typeOf(s.of, env, 0, 0));
        if (t?.k === "seq") return s.index === 1 ? t.elem : null;
        if (t?.k === "map") return s.index === 1 ? t.elem : s.index === 0 ? t.key : null;
        return null;
      }
      case "opaque":
        return null;
    }
  }

  // --- expressions --------------------------------------------------------------------------

  /** The type of a field a bare name can mean inside a type body: of the type itself or of a type around it. */
  private fieldInScope(name: string, env: Env): Ty | null {
    // Only a language whose code sits in type bodies names a member by a bare name.
    if (!env.owner || !this.typing.enclosing) return null;
    const index = this.idx();
    for (const o of index.chain(env.owner)) {
      const t = index.fieldType(o, name);
      if (t) return t;
      // A name the type may inherit from a type outside the repo is not one of the types around it.
      if (index.hasUnknownSupers(o)) return null;
    }
    return null;
  }

  /** The types of the repo a local body extends; null when it extends one that is not (what it inherits is not known). */
  private bodySupers(body: LocalBody, env: Env): Named[] | null {
    const index = this.idx();
    const out: Named[] = [];
    for (const ref of body.supers) {
      const t = named(index.canon(index.resolveType(ref, env.file)));
      if (!t || !index.typeInfo(t)) return null;
      out.push(t);
    }
    return out;
  }

  /** The type `this` has in a local body: the one type it extends; unknown when it extends none or several. */
  private bodySelf(body: LocalBody, env: Env): Ty | null {
    const supers = this.bodySupers(body, env);
    return supers?.length === 1 ? (supers[0] ?? null) : null;
  }

  /** The type a bare name denotes when it is not a variable (`Helper.make()`): a type of the repo, for a pack whose code sits in type bodies. */
  private typeByName(name: string, env: Env): Named | null {
    if (!this.typing.enclosing) return null;
    return this.idx().typeNamed(name, env.file, env.owner?.name ?? null);
  }

  protected typeOf(e: Expr | null, env: Env, idx: number, depth: number): Ty | null {
    if (!e || depth > MAX_DEPTH) return null;
    if (e.k === "call") return this.typeOfCall(e.call, env, idx, depth);
    if (idx !== 0) return null;
    const index = this.idx();
    switch (e.k) {
      case "name": {
        const l = this.local(env, e.name, e.pos);
        if (l) return this.typeOfLocal(l, env);
        if (e.body) {
          // In a local body only what its supertypes declare is known; the type around it is not searched.
          const t = this.bodySelf(e.body, env);
          return t?.k === "named" ? index.fieldType(t, e.name) : null;
        }
        const f = this.fieldInScope(e.name, env);
        if (f) return f;
        const v = env.file.pkg.vars.get(e.name);
        return v ? this.typeOfVar(v, depth) : null;
      }
      case "self":
        return e.body ? this.bodySelf(e.body, env) : env.owner;
      case "parent": {
        if (e.body) return this.bodySelf(e.body, env);
        const ti = env.owner ? index.typeInfo(env.owner) : undefined;
        const sup = ti?.supers.find((s) => s.edge === "extends");
        return ti && sup ? index.resolveType(sup.type, ti.file) : null;
      }
      case "through":
        return this.typeOf(e.of, env, 0, depth + 1);
      case "typed":
        return index.resolveType(e.type, env.file);
      case "elem": {
        const s = index.shape(this.typeOf(e.of, env, 0, depth + 1));
        return s?.k === "seq" || s?.k === "map" ? s.elem : null;
      }
      case "member": {
        const op = e.of;
        const plain = op?.k === "name" && !this.local(env, op.name, op.pos);
        if (op?.k === "name" && plain) {
          const path = env.file.imports.get(op.name);
          if (path) {
            const v = index.pkgs.get(path)?.vars.get(e.name);
            return v ? this.typeOfVar(v, depth) : null;
          }
        }
        let t = named(index.canon(this.typeOf(op, env, 0, depth + 1)));
        if (!t && op?.k === "name" && plain) t = this.typeByName(op.name, env);
        return t ? this.fieldTypeOf(t, e.name) : null;
      }
    }
  }

  protected typeOfVar(v: VarInfo, depth: number): Ty | null {
    if (v.declared) return this.idx().resolveType(v.declared.type, v.file);
    if (v.flow) return this.flowVar(v, depth);
    return v.value
      ? this.typeOf(v.value, { file: v.file, scope: new Map(), owner: null }, 0, depth + 1)
      : null;
  }

  private typeOfCall(call: CallExpr, env: Env, idx: number, depth: number): Ty | null {
    const index = this.idx();
    const c = call.callee;
    const b = this.typing.builtins;
    if (b && call.builtin && c.k === "name" && !this.local(env, c.name, c.pos)) {
      if (b.typed.includes(c.name) && !env.file.pkg.funcs.has(c.name))
        return call.first && idx === 0 ? index.resolveType(call.first.type, env.file) : null;
      if (b.first.includes(c.name) && !env.file.pkg.funcs.has(c.name))
        return idx === 0 ? this.typeOf(call.first?.expr ?? null, env, 0, depth + 1) : null;
    }
    const r = this.resolveCall(call, env, depth + 1);
    if (idx < r.results.length) return index.resolveType(r.results[idx] ?? null, r.file, r.bind);
    if (idx !== 0) return null;
    if (r.result !== undefined) return r.result;
    return r.conversion ? this.created(r.conversion) : null;
  }

  private resolveCall(call: CallExpr, env: Env, depth: number): Resolved {
    return this.resolveCallee(call.callee, call.args, env, depth);
  }

  /** The overloads that fit as a resolution: one when the call is certain; the type of the result is known when every one agrees on it. */
  private fromHits(hits: MethodHit[], line: number, env: Env): Resolved {
    const real = hits.filter((h) => h.kind !== "func-field");
    const first = real[0];
    if (!first || real.length < hits.length) return { targets: [], results: [], file: env.file, line };
    const same = real.every((h) => JSON.stringify(h.results) === JSON.stringify(first.results));
    return {
      targets: real.map((h) => ({ file: h.file, start: h.start })),
      results: same ? first.results : [],
      bind: first.bind,
      file: first.file,
      line,
    };
  }

  /** The methods a bare name can mean inside a type body: of the type itself or one around it, else a static import. */
  private bareHits(name: string, args: number | null, env: Env, body?: LocalBody): MethodHit[] {
    const idx = this.idx();
    if (body) {
      // A method the body declares has no symbol; what its supertypes declare comes next, and only when all are known.
      if (body.members.includes(name)) return [];
      for (const ref of body.supers) {
        const t = named(idx.canon(idx.resolveType(ref, env.file)));
        if (!t || !idx.typeInfo(t)) return [];
        const hits = idx.lookupMethods(t, name, args);
        if (hits.length > 0) return hits;
        if (idx.hasUnknownSupers(t)) return [];
      }
    }
    if (env.owner) {
      for (const o of idx.chain(env.owner)) {
        const hits = idx.lookupMethods(o, name, args);
        if (hits.length > 0) return hits;
        // A name the type may inherit from a type outside the repo is not a member of the types around it.
        if (idx.hasUnknownSupers(o)) return [];
      }
    }
    for (const t of [...(env.file.statics.get(name) ?? []), ...env.file.staticDemand]) {
      const hits = idx.lookupMethods(t, name, args);
      if (hits.length > 0) return hits;
    }
    return [];
  }

  /** What the callee of a call refers to (also used for a function named without a call). `args` is the number of arguments, when known. */
  private resolveCallee(callee: Callee, args: number | null, env: Env, depth: number): Resolved {
    const idx = this.idx();
    const none = (line: number): Resolved => ({ targets: [], results: [], file: env.file, line });
    if (callee.k === "none") return none(callee.line);
    const { pkg } = env.file;
    if (callee.k === "new") {
      const t = named(idx.canon(idx.resolveType(callee.type, env.file)));
      if (!t) return none(callee.line);
      // A constructor is named like its type and is not inherited.
      const hits = idx.lookupMethods(t, t.name.slice(t.name.lastIndexOf(".") + 1), args, false);
      return this.fromHits(hits, callee.line, env);
    }
    if (callee.k === "name") {
      if (this.typing.enclosing) {
        const hits = this.bareHits(callee.name, args, env, callee.body);
        if (hits.length > 0) return this.fromHits(hits, callee.line, env);
      } else if (this.local(env, callee.name, callee.pos)) return none(callee.line);
      const f = pkg.funcs.get(callee.name);
      if (f)
        return {
          targets: [{ file: f.file, start: f.start }],
          results: f.results,
          file: f.file,
          line: callee.line,
        };
      if (pkg.types.has(callee.name))
        return { ...none(callee.line), conversion: { k: "named", pkg: pkg.path, name: callee.name } };
      // A name the file imports by name: a function of the repo, or a type of it.
      const imported = env.file.named.get(callee.name);
      if (imported) {
        const from = idx.pkgs.get(imported.pkg);
        const g = from?.funcs.get(imported.name);
        if (g)
          return {
            targets: [{ file: g.file, start: g.start }],
            results: g.results,
            file: g.file,
            line: callee.line,
          };
        if (from?.types.has(imported.name)) return { ...none(callee.line), conversion: imported };
      }
      return none(callee.line);
    }
    const op = callee.operand;
    // `this.m()` in a local body that declares `m` itself calls a method that has no symbol.
    if (op?.k === "self" && op.body?.members.includes(callee.name)) return none(callee.line);
    const plain = op?.k === "name" && !this.local(env, op.name, op.pos);
    if (op?.k === "name" && plain) {
      const path = env.file.imports.get(op.name);
      if (path) {
        const p = idx.pkgs.get(path);
        if (!p) return none(callee.line);
        if (p.types.has(callee.name))
          return { ...none(callee.line), conversion: { k: "named", pkg: path, name: callee.name } };
        const f = p.funcs.get(callee.name);
        if (f)
          return {
            targets: [{ file: f.file, start: f.start }],
            results: f.results,
            file: f.file,
            line: callee.line,
          };
        return none(callee.line);
      }
    }
    let t = named(idx.canon(this.typeOf(op, env, 0, depth + 1)));
    if (!t && op?.k === "name" && plain) t = this.typeByName(op.name, env);
    if (!t) return none(callee.line);
    const hits = idx.lookupMethods(t, callee.name, args);
    if (hits.length === 0) {
      const result = idx.libraryResult(t, callee.name);
      if (result !== undefined) return { ...none(callee.line), result };
    }
    return this.fromHits(hits, callee.line, env);
  }
}

/** The call resolver of a pack that has typing rules: level 2, declared types. */
export const typeCallResolver =
  (pack: LanguagePack) =>
  (ctx: ResolveContext): CallResolver =>
    new TypeCalls(pack, ctx);

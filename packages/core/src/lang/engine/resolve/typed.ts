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
import { type FileInfo, type Named, type Ty, TypeIndex, type VarInfo } from "./typeindex.js";
import type { CallExpr, Callee, Decl, Expr, Results } from "./typing.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The deepest chain of expressions the types of which are followed. */
const MAX_DEPTH = 12;

interface Local {
  /** Source offset from which the name is visible. */
  pos: number;
  decl: Decl;
  memo?: Ty | null;
  busy: boolean;
}
type Scope = Map<string, Local[]>;

interface Env {
  file: FileInfo;
  scope: Scope;
}

/** What a callee resolves to. `target` is the callee symbol (`file` + `name`) when it is a function or method of the repo. */
interface Resolved {
  target?: { file: string; name: string };
  results: Results;
  /** The file the result types are written in. */
  file: FileInfo;
  conversion?: Ty | null;
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
 * receiver type is unknown gives no edge; nothing is guessed. `calls` edges are `high`; `extends` runs from a class to
 * each in-repo type it embeds (`high`) and `implements` from a type to each in-repo interface whose method names it
 * covers (`low`). The index and the scopes of the edges hold plain data and the tree of a file is dropped once its facts
 * are read; only the lookups by place keep the tree of the last file they were asked about, one at a time.
 */
export class TypeCalls implements CallResolver {
  private readonly typing: TypingRules;
  private readonly reader: Reader;
  private readonly imports: ImportIndex;
  private index: TypeIndex | undefined;
  /** The tree of the last file a lookup by place read, with the expressions and scopes found in it. */
  private readonly last: LastTree<{
    root: SyntaxNode;
    byRange: Map<string, SyntaxNode>;
    scopes: Map<number, Scope>;
  }>;

  constructor(
    private readonly pack: LanguagePack,
    private readonly ctx: ResolveContext,
  ) {
    if (!pack.nodes.typing) throw new Error(`${pack.id}: the pack has no typing rules`);
    this.typing = pack.nodes.typing;
    this.last = new LastTree(pack, ctx.root);
    this.reader = new Reader(pack);
    this.imports = new ImportIndex(pack, ctx);
  }

  private idx(): TypeIndex {
    this.index ??= new TypeIndex(this.pack, this.ctx, this.imports, this.reader);
    return this.index;
  }

  /** The `calls`, `extends` and `implements` edges whose source is in this file, sorted by (src, dst, kind). */
  edgesForFile(fileId: string, pf: ParsedFile): EdgeRecord[] {
    const idx = this.idx();
    const file = idx.byFileId.get(fileId);
    if (!file) return [];
    const bodies = withTree(this.pack, this.ctx.root, file.rel, (root) => this.reader.bodies(root));
    if (!bodies) return [];
    const idByStart = new Map<number, string>();
    for (const s of pf.symbols) {
      const r = pf.bodies.get(s.id);
      if ((s.kind === "function" || s.kind === "method") && r) idByStart.set(r.start, s.id);
    }
    const calls = new EdgeSet(fileId, 2);
    for (const b of bodies) {
      const src = idByStart.get(b.start);
      if (!src) continue;
      const env: Env = { file, scope: this.scope(b.decls) };
      for (const site of b.calls) {
        const r = this.resolveCall(site.call, env, 0);
        if (!r.target) continue;
        const dst = idx.symbolId(r.target.file, r.target.name);
        if (dst === src || !idx.symbolIds.has(dst)) continue;
        calls.add(src, dst, "calls", "high", `${file.rel}:${r.line}`);
      }
    }
    const extended = new EdgeSet(fileId);
    for (const t of idx.typesOf(fileId)) {
      if (t.kind !== "class") continue;
      const src = idx.symbolId(file.rel, t.name);
      for (const e of t.embedded) {
        const ty = named(idx.resolveType(e.type, file));
        const target = ty ? idx.typeInfo(ty) : undefined;
        if (!ty || !target) continue;
        const dst = idx.symbolId(target.file.rel, ty.name);
        if (dst === src || !idx.symbolIds.has(dst)) continue;
        extended.add(src, dst, "extends", "high", `${file.rel}:${e.line}`);
      }
    }
    const out = [...calls.edges(), ...extended.edges(), ...(idx.implementers().get(fileId) ?? [])];
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
      const key = fd.range().start.index;
      const hit = place.scopes.get(key);
      if (hit) scope = hit;
      else {
        scope = this.scope(this.reader.decls(fd));
        place.scopes.set(key, scope);
      }
    }
    return use(node, { file, scope }, this.reader);
  }

  /**
   * The symbol id of the function or method that the call, or the function named without a call (`rs.login`,
   * `pkg.Handler`, `handler`), at this source range refers to; null when it is not a function of the repository or
   * the type of its receiver is unknown.
   */
  targetAt(fileId: string, start: number, end: number): string | null {
    const idx = this.idx();
    const r = this.at(fileId, start, end, (node, env, reader) =>
      this.resolveCallee(reader.calleeAt(node), env, 0),
    );
    if (!r?.target) return null;
    const dst = idx.symbolId(r.target.file, r.target.name);
    return idx.symbolIds.has(dst) ? dst : null;
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

  private scope(decls: readonly Decl[]): Scope {
    const scope: Scope = new Map();
    for (const decl of decls) {
      const list = scope.get(decl.name) ?? [];
      list.push({ pos: decl.pos, decl, busy: false });
      scope.set(decl.name, list);
    }
    return scope;
  }

  /** The type a declared name has; a name that depends on itself has none. */
  private typeOfLocal(l: Local, env: Env): Ty | null {
    if (l.memo !== undefined) return l.memo;
    if (l.busy) return null;
    l.busy = true;
    l.memo = this.declType(l.decl, env);
    l.busy = false;
    return l.memo;
  }

  private declType(decl: Decl, env: Env): Ty | null {
    const idx = this.idx();
    const s = decl.source;
    switch (s.k) {
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

  private typeOf(e: Expr | null, env: Env, idx: number, depth: number): Ty | null {
    if (!e || depth > MAX_DEPTH) return null;
    if (e.k === "call") return this.typeOfCall(e.call, env, idx, depth);
    if (idx !== 0) return null;
    const index = this.idx();
    switch (e.k) {
      case "name": {
        const l = lookupLocal(env.scope, e.name, e.pos);
        if (l) return this.typeOfLocal(l, env);
        const v = env.file.pkg.vars.get(e.name);
        return v ? this.typeOfVar(v, depth) : null;
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
        if (op?.k === "name" && !lookupLocal(env.scope, op.name, op.pos)) {
          const path = env.file.imports.get(op.name);
          if (path) {
            const v = index.pkgs.get(path)?.vars.get(e.name);
            return v ? this.typeOfVar(v, depth) : null;
          }
        }
        const t = named(index.canon(this.typeOf(op, env, 0, depth + 1)));
        return t ? index.fieldType(t, e.name) : null;
      }
    }
  }

  private typeOfVar(v: VarInfo, depth: number): Ty | null {
    if (v.declared) return this.idx().resolveType(v.declared.type, v.file);
    return v.value ? this.typeOf(v.value, { file: v.file, scope: new Map() }, 0, depth + 1) : null;
  }

  private typeOfCall(call: CallExpr, env: Env, idx: number, depth: number): Ty | null {
    const index = this.idx();
    const c = call.callee;
    if (call.builtin && c.k === "name" && !lookupLocal(env.scope, c.name, c.pos)) {
      const b = this.typing.builtins;
      if (b.typed.includes(c.name) && !env.file.pkg.funcs.has(c.name))
        return call.first && idx === 0 ? index.resolveType(call.first.type, env.file) : null;
      if (b.first.includes(c.name) && !env.file.pkg.funcs.has(c.name))
        return idx === 0 ? this.typeOf(call.first?.expr ?? null, env, 0, depth + 1) : null;
    }
    const r = this.resolveCall(call, env, depth + 1);
    if (idx < r.results.length) return index.resolveType(r.results[idx] ?? null, r.file);
    return idx === 0 && r.conversion ? r.conversion : null;
  }

  private resolveCall(call: CallExpr, env: Env, depth: number): Resolved {
    return this.resolveCallee(call.callee, env, depth);
  }

  /** What the callee of a call refers to (also used for a function named without a call). */
  private resolveCallee(callee: Callee, env: Env, depth: number): Resolved {
    const idx = this.idx();
    const none = (line: number): Resolved => ({ results: [], file: env.file, line });
    if (callee.k === "none") return none(callee.line);
    const { pkg } = env.file;
    if (callee.k === "name") {
      if (lookupLocal(env.scope, callee.name, callee.pos)) return none(callee.line);
      const f = pkg.funcs.get(callee.name);
      if (f)
        return {
          target: { file: f.file.rel, name: callee.name },
          results: f.results,
          file: f.file,
          line: callee.line,
        };
      if (pkg.types.has(callee.name))
        return { ...none(callee.line), conversion: { k: "named", pkg: pkg.path, name: callee.name } };
      return none(callee.line);
    }
    const op = callee.operand;
    if (op?.k === "name" && !lookupLocal(env.scope, op.name, op.pos)) {
      const path = env.file.imports.get(op.name);
      if (path) {
        const p = idx.pkgs.get(path);
        if (!p) return none(callee.line);
        if (p.types.has(callee.name))
          return { ...none(callee.line), conversion: { k: "named", pkg: path, name: callee.name } };
        const f = p.funcs.get(callee.name);
        if (f)
          return {
            target: { file: f.file.rel, name: callee.name },
            results: f.results,
            file: f.file,
            line: callee.line,
          };
        return none(callee.line);
      }
    }
    const t = named(idx.canon(this.typeOf(op, env, 0, depth + 1)));
    if (!t) return none(callee.line);
    const hit = idx.lookupMethod(t, callee.name);
    if (!hit || hit.kind === "func-field") return none(callee.line);
    return {
      target: { file: hit.file.rel, name: hit.name },
      results: hit.results,
      file: hit.file,
      line: callee.line,
    };
  }
}

/** The call resolver of a pack that has typing rules: level 2, declared types. */
export const typeCallResolver =
  (pack: LanguagePack) =>
  (ctx: ResolveContext): CallResolver =>
    new TypeCalls(pack, ctx);

import type { ParsedFile } from "../../../parse/index.js";
import type { ResolveContext } from "../../../resolve/index.js";
import type { EdgeRecord } from "../../../types.js";
import type { CallResolver } from "../module.js";
import type { LanguagePack } from "../pack.js";
import { EdgeSet } from "./edges.js";
import { type Env, type Local, type Scope, TypeCalls } from "./typed.js";
import type { Named, Ty, TypeInfo, VarInfo } from "./typeindex.js";
import type { Decl, DeclSource, FlowAttr } from "./typing.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The deepest chain of supertypes searched for an attribute. */
const MAX_SUPERS = 6;

/**
 * Level 3 call resolution (spec section 7): the type resolver's reading plus the values that flow into a name that has
 * no declared type, read with the node kinds, fields and names of the pack's `typing.flow`. A name assigned a call that
 * names a type of the repo (`x = Foo()`) has that type; a variable at the top of a file assigned one has it in every
 * function of the file; the parameter that names the instance in a method is the type around the method, so a call on it
 * resolves in that type and the types it extends; an attribute of the instance that the type's initializer assigns
 * (`self.repo = Repo()`) has the type of the value. Nothing is guessed for a name that gets no such value (a parameter
 * without a type), and an attribute assigned values of different types has no type.
 *
 * This resolver makes an edge only for a call site that rests on one of these facts; every other call site is the type
 * resolver's. Each edge it makes is `low` and has `level: 3`.
 */
export class FlowCalls extends TypeCalls {
  /** The type of an attribute by type and name; null while it is being read (an attribute that depends on itself has none). */
  private readonly attributes = new Map<string, Ty | null>();
  private readonly scopes = new WeakMap<Decl[], Scope>();

  /** `types` is the type resolver whose index, reader and imports this resolver reads. */
  constructor(pack: LanguagePack, ctx: ResolveContext, types: TypeCalls) {
    super(pack, ctx, types);
    if (!pack.nodes.typing?.flow) throw new Error(`${pack.id}: the pack has no flow rules`);
  }

  /**
   * A name whose nearest declaration gets its type from a flow fact has a type only when every declaration of that name
   * in the function (parameters, typed and untyped assignments) gives the same one: values that reach it along
   * different paths leave its type unknown.
   */
  protected override typeOfLocal(l: Local, env: Env): Ty | null {
    if (!l.decl.flow) return super.typeOfLocal(l, env);
    const types = (env.scope.get(l.decl.name) ?? []).map((s) => super.typeOfLocal(s, env));
    this.usedFlow = true;
    const [first] = types;
    const same = first && types.every((t) => t && JSON.stringify(t) === JSON.stringify(first));
    return same ? first : null;
  }

  protected override sourceOf(decl: Decl): DeclSource {
    if (!decl.flow) return decl.source;
    this.usedFlow = true;
    return decl.flow;
  }

  protected override selfType(env: Env): Ty | null {
    this.usedFlow = true;
    return env.owner;
  }

  protected override created(t: Ty): Ty | null {
    this.usedFlow = true;
    return t;
  }

  protected override flowVar(v: VarInfo, depth: number): Ty | null {
    this.usedFlow = true;
    return v.value
      ? this.typeOf(v.value, { file: v.file, scope: new Map(), owner: null }, 0, depth + 1)
      : null;
  }

  protected override fieldTypeOf(t: Named, name: string): Ty | null {
    return super.fieldTypeOf(t, name) ?? this.attribute(t, name, 0);
  }

  /** The type of an attribute the initializer of the type, or of a type it extends, assigns. */
  private attribute(t: Named, name: string, depth: number): Ty | null {
    const idx = this.idx();
    const c = idx.canon(t);
    const ti = c?.k === "named" ? idx.typeInfo(c) : undefined;
    if (c?.k !== "named" || !ti || ti.kind !== "class" || depth > MAX_SUPERS) return null;
    const own = ti.attrs.get(name);
    if (own) return this.attributeOf(c, ti, name, own);
    const bound = idx.bindings(ti, c);
    for (const s of idx.supersOf(ti)) {
      const sup = idx.resolveType(s.type, s.file, bound);
      const found = sup?.k === "named" ? this.attribute(sup, name, depth + 1) : null;
      if (found) return found;
    }
    return null;
  }

  /** The type of the attribute `name` of `c`, from every assignment to it: the type they all agree on. */
  private attributeOf(c: Named, ti: TypeInfo, name: string, assigned: readonly FlowAttr[]): Ty | null {
    this.usedFlow = true;
    const key = `${c.pkg}\0${c.name}\0${name}`;
    if (this.attributes.has(key)) return this.attributes.get(key) ?? null;
    this.attributes.set(key, null);
    const types = assigned.map((a) => this.assignedType(c, ti, a));
    const [first] = types;
    const ty = first && types.every((x) => x && JSON.stringify(x) === JSON.stringify(first)) ? first : null;
    this.attributes.set(key, ty);
    return ty;
  }

  /** The type one assignment gives: the type it declares, or the type of its value read in the initializer. */
  private assignedType(c: Named, ti: TypeInfo, a: FlowAttr): Ty | null {
    const idx = this.idx();
    if (a.typed) return idx.resolveType(a.type, ti.file, idx.bindings(ti, c));
    let scope = this.scopes.get(a.decls);
    if (!scope) {
      scope = this.scope(a.decls);
      this.scopes.set(a.decls, scope);
    }
    return this.typeOf(a.value, { file: ti.file, scope, owner: c }, 0, 0);
  }

  /** The `calls` edges of the call sites in this file that rest on a flow fact, each `low`, level 3. */
  edgesForFile(fileId: string, pf: ParsedFile): EdgeRecord[] {
    const calls = new EdgeSet(fileId, 3);
    for (const s of this.sites(fileId, pf)) if (s.flow) calls.add(s.src, s.dst, "calls", "low", s.evidence);
    return calls.edges().sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  }
}

/**
 * The call resolver of a pack that has typing and flow rules: the type resolver's edges (level 2), and the flow
 * resolver's (level 3) for the call sites the type resolver leaves without an edge. A pair of symbols the type resolver
 * already links keeps its level 2 edge.
 */
export const flowCallResolver =
  (pack: LanguagePack) =>
  (ctx: ResolveContext): CallResolver => {
    const types = new TypeCalls(pack, ctx);
    const flow = new FlowCalls(pack, ctx, types);
    const key = (e: EdgeRecord): string => `${e.src}\0${e.dst}\0${e.kind}`;
    return {
      targetAt: (fileId, start, end) => types.targetAt(fileId, start, end),
      typeNameAt: (fileId, start, end) => types.typeNameAt(fileId, start, end),
      edgesForFile(fileId, pf) {
        const level2 = types.edgesForFile(fileId, pf);
        const linked = new Set(level2.map(key));
        return [...level2, ...flow.edgesForFile(fileId, pf).filter((e) => !linked.has(key(e)))];
      },
    };
  };

import type { ParsedFile } from "../../parse/index.js";
import { EVIDENCE_CAP } from "../../resolve/index.js";
import type { EdgeKind, EdgeRecord } from "../../types.js";
import type { GoNode } from "./grammar.js";
import {
  type FileCtx,
  type GoIndex,
  type Named,
  PREDECLARED_TYPES,
  type Ty,
  type TypeNode,
} from "./resolve.js";

/**
 * Go call, `extends` and `implements` edges from syntax plus local type inference (spec section 7), with no Go
 * toolchain. Per top-level function the declared names are collected with their types (receiver, parameters, named
 * results, `var x T`, `x := T{}`, `&T{}`, `new(T)`, `x := F()`, `x := y.M()`, `x.(T)`, struct field chains through
 * embedding, aliases, range variables and `[]T` / `map[K]T` elements). Scopes are flattened: the nearest preceding
 * declaration of a name wins, and function literals count as the function around them. A call whose receiver type is
 * unknown emits nothing; the code never guesses.
 */

const BUILTINS = new Set(
  "append cap clear close complex copy delete imag len make max min new panic print println real recover".split(
    " ",
  ),
);

const DECL_KINDS = [
  "parameter_declaration",
  "variadic_parameter_declaration",
  "short_var_declaration",
  "var_spec",
  "const_spec",
  "range_clause",
  "receive_statement",
  "type_switch_statement",
];

interface Local {
  /** Source offset from which the name is visible. */
  pos: number;
  thunk: () => Ty | null;
}
type Scope = Map<string, Local[]>;

interface Env {
  ctx: FileCtx;
  scope: Scope;
}

/** What a call resolves to. `target` is the callee symbol (`file` + `name`) when it is a function or method of the repo. */
interface Resolved {
  kind: string;
  target?: { file: string; name: string };
  results: TypeNode[];
  conversion?: Ty | null;
  line: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function lookupLocal(scope: Scope, name: string, pos: number): Local | null {
  let best: Local | null = null;
  for (const l of scope.get(name) ?? []) if (l.pos <= pos && (!best || l.pos > best.pos)) best = l;
  return best;
}

const unparen = (n: GoNode | null): GoNode | null => {
  let cur = n;
  while (cur && cur.kind() === "parenthesized_expression") cur = cur.namedChildren()[0] ?? null;
  return cur;
};

const named = (t: Ty | null): Named | null => (t?.k === "named" ? t : null);

/** Accumulates edges by (src, dst, kind) the way the shared resolver does: counts add up, evidence is capped. */
class EdgeSet {
  private readonly map = new Map<string, EdgeRecord>();
  constructor(private readonly fileId: string) {}

  add(src: string, dst: string, kind: EdgeKind, confidence: "high" | "low", evidence: string): void {
    const key = `${src}\0${dst}\0${kind}`;
    let e = this.map.get(key);
    if (!e) {
      e = { src, dst, kind, confidence, count: 0, evidence: [], fileId: this.fileId };
      this.map.set(key, e);
    }
    e.count++;
    if (confidence === "high") e.confidence = "high";
    if (e.evidence.length < EVIDENCE_CAP && !e.evidence.includes(evidence)) e.evidence.push(evidence);
  }

  edges(): EdgeRecord[] {
    return [...this.map.values()];
  }
}

export class GoCalls {
  private implementsByFile: Map<string, EdgeRecord[]> | null = null;

  constructor(private readonly idx: GoIndex) {}

  /** The `calls`, `extends` and `implements` edges whose source is in this file, sorted by (src, dst, kind). */
  edgesForFile(fileId: string, pf: ParsedFile): EdgeRecord[] {
    const ctx = this.idx.byFileId.get(fileId);
    if (!ctx) return [];
    const set = new EdgeSet(fileId);
    const idByLine = new Map<number, string>();
    for (const s of pf.symbols)
      if (s.kind === "function" || s.kind === "method") idByLine.set(s.startLine, s.id);
    for (const fd of ctx.root.namedChildren()) {
      const k = fd.kind();
      if (k === "function_declaration" || k === "method_declaration") this.callsOf(fd, ctx, idByLine, set);
      else if (k === "type_declaration") this.extendsOf(fd, ctx, set);
    }
    const out = [...set.edges(), ...(this.implementers().get(fileId) ?? [])];
    return out.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  }

  // --- calls --------------------------------------------------------------------------------

  private callsOf(fd: GoNode, ctx: FileCtx, idByLine: Map<number, string>, set: EdgeSet): void {
    const body = fd.field("body");
    const src = idByLine.get(fd.range().start.line + 1);
    if (!body || !src) return;
    const env: Env = { ctx, scope: this.buildScope(fd, ctx) };
    const calls = body.findAll({
      rule: {
        any: [
          { kind: "call_expression" },
          { kind: "type_conversion_expression", has: { field: "type", kind: "generic_type" } },
        ],
      },
    });
    for (const c of calls) {
      const r = this.resolveCall(c, env);
      if (!r.target) continue;
      const dst = this.idx.symbolId(r.target.file, r.target.name);
      if (dst === src || !this.idx.symbolIds.has(dst)) continue;
      set.add(src, dst, "calls", "high", `${ctx.rel}:${r.line}`);
    }
  }

  private buildScope(fd: GoNode, ctx: FileCtx): Scope {
    const scope: Scope = new Map();
    const env: Env = { ctx, scope };
    const add = (name: string, pos: number, thunk: () => Ty | null): void => {
      if (name === "_") return;
      let memo: Ty | null | undefined;
      let busy = false;
      const l: Local = {
        pos,
        thunk: () => {
          if (memo !== undefined) return memo;
          if (busy) return null;
          busy = true;
          memo = thunk();
          busy = false;
          return memo;
        },
      };
      const list = scope.get(name) ?? [];
      list.push(l);
      scope.set(name, list);
    };
    const ids = (n: GoNode | null): GoNode[] =>
      n ? n.namedChildren().filter((c) => c.kind() === "identifier") : [];
    for (const d of fd.findAll({ rule: { any: DECL_KINDS.map((kind) => ({ kind })) } })) {
      const k = d.kind();
      const start = d.range().start.index;
      const end = d.range().end.index;
      if (k === "parameter_declaration") {
        const t = d.field("type");
        for (const n of d.fieldChildren("name"))
          if (n.kind() === "identifier")
            add(n.text(), start, () => (t ? this.idx.resolveType({ node: t, ctx }) : null));
      } else if (k === "variadic_parameter_declaration") {
        const t = d.field("type");
        for (const n of d.fieldChildren("name"))
          add(n.text(), start, () => {
            const e = t ? this.idx.resolveType({ node: t, ctx }) : null;
            return { k: "seq", elem: e };
          });
      } else if (k === "short_var_declaration" || k === "var_spec" || k === "const_spec") {
        const left =
          k === "short_var_declaration"
            ? ids(d.field("left"))
            : d.fieldChildren("name").filter((n) => n.kind() === "identifier");
        const t = k === "short_var_declaration" ? null : d.field("type");
        const right =
          (k === "short_var_declaration" ? d.field("right") : d.field("value"))?.namedChildren() ?? [];
        left.forEach((n, i) => {
          add(n.text(), end, () => {
            if (t) return this.idx.resolveType({ node: t, ctx });
            if (right.length === left.length) return this.typeOf(right[i] ?? null, env, 0);
            if (right.length === 1) return this.typeOf(right[0] ?? null, env, i);
            return null;
          });
        });
      } else if (k === "range_clause") {
        const left = ids(d.field("left"));
        const right = d.field("right");
        const elem = (which: "key" | "value"): Ty | null => {
          const s = this.idx.shape(this.typeOf(right, env, 0));
          if (s?.k === "seq") return which === "value" ? s.elem : null;
          if (s?.k === "map") return which === "value" ? s.elem : s.key;
          return null;
        };
        for (const [i, n] of left.entries())
          add(n.text(), end, () => (i === 0 ? elem("key") : i === 1 ? elem("value") : null));
      } else if (k === "receive_statement") {
        for (const n of ids(d.field("left"))) add(n.text(), end, () => null);
      } else if (k === "type_switch_statement") {
        for (const n of ids(d.field("alias"))) add(n.text(), start, () => null);
      }
    }
    return scope;
  }

  // --- expressions --------------------------------------------------------------------------

  private typeOf(e: GoNode | null, env: Env, idx = 0, depth = 0): Ty | null {
    const x = unparen(e);
    if (!x || depth > 12) return null;
    const kind = x.kind();
    if (kind === "call_expression" || kind === "type_conversion_expression") {
      return this.typeOfCall(x, env, idx, depth);
    }
    if (idx !== 0) return null;
    switch (kind) {
      case "identifier": {
        const l = lookupLocal(env.scope, x.text(), x.range().start.index);
        if (l) return l.thunk();
        const v = env.ctx.pkg.vars.get(x.text());
        return v ? this.typeOfVar(v, depth) : null;
      }
      case "unary_expression": {
        const op = x.field("operator")?.text();
        if (op === "&" || op === "*") return this.typeOf(x.field("operand"), env, 0, depth + 1);
        return null;
      }
      case "composite_literal":
      case "type_assertion_expression": {
        const t = x.field("type");
        return t ? this.idx.resolveType({ node: t, ctx: env.ctx }) : null;
      }
      case "index_expression": {
        const s = this.idx.shape(this.typeOf(x.field("operand"), env, 0, depth + 1));
        return s?.k === "seq" || s?.k === "map" ? s.elem : null;
      }
      case "slice_expression":
        return this.typeOf(x.field("operand"), env, 0, depth + 1);
      case "selector_expression": {
        const op = unparen(x.field("operand"));
        const f = x.field("field")?.text() ?? "";
        if (op?.kind() === "identifier" && !lookupLocal(env.scope, op.text(), op.range().start.index)) {
          const path = env.ctx.imports.get(op.text());
          if (path) {
            const v = this.idx.pkgs.get(path)?.vars.get(f);
            return v ? this.typeOfVar(v, depth) : null;
          }
        }
        const t = named(this.idx.canon(this.typeOf(op, env, 0, depth + 1)));
        return t ? this.idx.fieldType(t, f) : null;
      }
    }
    return null;
  }

  private typeOfVar(
    v: { type: GoNode | null; value: GoNode | null; ctx: FileCtx },
    depth: number,
  ): Ty | null {
    if (v.type) return this.idx.resolveType({ node: v.type, ctx: v.ctx });
    return v.value ? this.typeOf(v.value, { ctx: v.ctx, scope: new Map() }, 0, depth + 1) : null;
  }

  private typeOfCall(x: GoNode, env: Env, idx: number, depth: number): Ty | null {
    if (x.kind() === "call_expression") {
      const fn = unparen(x.field("function"));
      if (fn?.kind() === "identifier" && !lookupLocal(env.scope, fn.text(), fn.range().start.index)) {
        const name = fn.text();
        const first = x.field("arguments")?.namedChildren()[0] ?? null;
        if ((name === "new" || name === "make") && !env.ctx.pkg.funcs.has(name))
          return first && idx === 0 ? this.idx.resolveType({ node: first, ctx: env.ctx }) : null;
        if (name === "append" && !env.ctx.pkg.funcs.has(name))
          return idx === 0 ? this.typeOf(first, env, 0, depth + 1) : null;
      }
    }
    const r = this.resolveCall(x, env, depth + 1);
    const res = r.results[idx];
    if (res) return this.idx.resolveType(res);
    return idx === 0 && r.conversion ? r.conversion : null;
  }

  private resolveCall(call: GoNode, env: Env, depth = 0): Resolved {
    let fn = unparen(
      call.kind() === "type_conversion_expression" ? call.field("type") : call.field("function"),
    );
    while (fn && (fn.kind() === "index_expression" || fn.kind() === "generic_type")) {
      fn = unparen(fn.kind() === "index_expression" ? fn.field("operand") : fn.field("type"));
    }
    const line = (fn ?? call).range().start.line + 1;
    const none = (kind: string, extra: Partial<Resolved> = {}): Resolved => ({
      kind,
      results: [],
      line,
      ...extra,
    });
    if (!fn) return none("other");
    const { pkg } = env.ctx;
    if (fn.kind() === "identifier" || fn.kind() === "type_identifier") {
      const name = fn.text();
      if (lookupLocal(env.scope, name, fn.range().start.index)) return none("local");
      const f = pkg.funcs.get(name);
      if (f) return { kind: "same-package", target: { file: f.file, name }, results: f.results, line };
      if (pkg.types.has(name)) return none("conversion", { conversion: { k: "named", pkg: pkg.path, name } });
      if (BUILTINS.has(name)) return none("builtin");
      return none(PREDECLARED_TYPES.has(name) ? "conversion" : "unresolved");
    }
    if (fn.kind() === "selector_expression" || fn.kind() === "qualified_type") {
      const isQ = fn.kind() === "qualified_type";
      const op = unparen(isQ ? fn.field("package") : fn.field("operand"));
      const nameNode = isQ ? fn.field("name") : fn.field("field");
      const name = nameNode?.text() ?? "";
      const at = (nameNode ?? fn).range().start.line + 1;
      if (
        op &&
        (op.kind() === "identifier" || op.kind() === "package_identifier") &&
        !lookupLocal(env.scope, op.text(), op.range().start.index)
      ) {
        const path = env.ctx.imports.get(op.text());
        if (path) {
          const p = this.idx.pkgs.get(path);
          if (!p) return { ...none("external-func"), line: at };
          if (p.types.has(name))
            return { ...none("conversion", { conversion: { k: "named", pkg: path, name } }), line: at };
          const f = p.funcs.get(name);
          if (f)
            return { kind: "pkg-qualified", target: { file: f.file, name }, results: f.results, line: at };
          return { ...none("unresolved"), line: at };
        }
      }
      const t = named(this.idx.canon(this.typeOf(op, env, 0, depth + 1)));
      if (!t) return { ...none("unresolved-receiver"), line: at };
      const hit = this.idx.lookupMethod(t, name);
      if (!hit) return { ...none("unresolved-method"), line: at };
      if (hit.kind === "func-field") return { ...none("func-field"), line: at };
      return { kind: hit.kind, target: { file: hit.file, name: hit.name }, results: hit.results, line: at };
    }
    return none("other");
  }

  // --- extends and implements ---------------------------------------------------------------

  /** `extends` from a struct to each in-repo type it embeds. */
  private extendsOf(decl: GoNode, ctx: FileCtx, set: EdgeSet): void {
    for (const spec of decl.namedChildren()) {
      if (spec.kind() !== "type_spec") continue;
      const name = spec.field("name")?.text();
      const ti = name ? ctx.pkg.types.get(name) : undefined;
      if (!name || !ti || ti.ctx !== ctx || ti.kind !== "struct") continue;
      const src = this.idx.symbolId(ctx.rel, name);
      for (const e of ti.embedded) {
        const t = named(this.idx.resolveType({ node: e, ctx }));
        const target = t ? this.idx.typeInfo(t) : undefined;
        if (!t || !target) continue;
        const dst = this.idx.symbolId(target.ctx.rel, t.name);
        if (dst === src || !this.idx.symbolIds.has(dst)) continue;
        set.add(src, dst, "extends", "high", `${ctx.rel}:${e.range().start.line + 1}`);
      }
    }
  }

  /**
   * `implements` edges at low confidence, by method names alone: a named in-repo type whose method names (value or
   * pointer receiver, promoted ones included) cover the method set of an in-repo interface. Interfaces that embed one
   * from outside the repo are skipped. Grouped by the file of the implementing type.
   */
  private implementers(): Map<string, EdgeRecord[]> {
    if (this.implementsByFile) return this.implementsByFile;
    const out = new Map<string, EdgeRecord[]>();
    this.implementsByFile = out;
    const pkgs = [...this.idx.pkgs.values()].filter((p) => !p.test).sort((a, b) => cmp(a.path, b.path));
    const types: { name: string; info: NonNullable<ReturnType<GoIndex["typeInfo"]>>; names: Set<string> }[] =
      [];
    const byMethod = new Map<string, number[]>();
    const ifaces: { name: string; info: (typeof types)[number]["info"]; want: string[] }[] = [];
    for (const p of pkgs) {
      for (const name of [...p.types.keys()].sort()) {
        const info = p.types.get(name);
        if (!info || info.generic || info.kind === "alias") continue;
        const ref: Named = { k: "named", pkg: p.path, name };
        if (info.kind === "interface") {
          const want = this.idx.interfaceNames(ref);
          if (want && want.size > 0) ifaces.push({ name, info, want: [...want].sort() });
          continue;
        }
        const i = types.length;
        types.push({ name, info, names: this.idx.methodNames(ref) });
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
        const src = this.idx.symbolId(t.info.ctx.rel, t.name);
        const dst = this.idx.symbolId(iface.info.ctx.rel, iface.name);
        if (src === dst || !this.idx.symbolIds.has(src) || !this.idx.symbolIds.has(dst)) continue;
        const fileId = t.info.ctx.fileId;
        const list = out.get(fileId) ?? [];
        list.push({
          src,
          dst,
          kind: "implements",
          confidence: "low",
          count: 1,
          evidence: [`${t.info.ctx.rel}:${t.info.line}`],
          fileId,
        });
        out.set(fileId, list);
      }
    }
    return out;
  }
}

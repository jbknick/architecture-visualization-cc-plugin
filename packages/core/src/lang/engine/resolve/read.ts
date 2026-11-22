import type { SyntaxNode } from "../grammar.js";
import type { DeclarationRule, LanguagePack, TypingRules } from "../pack.js";
import { baseTypeName, rawImportsOf, specsOf } from "../parse.js";
import { bodiedName, bodiedRule, membersOf, walkDeclarations } from "../walk.js";
import type {
  Arity,
  CallExpr,
  Callee,
  CallSite,
  Decl,
  DeclSource,
  Expr,
  FileDecls,
  FunctionBody,
  Results,
  TypeDecl,
  TypeRef,
} from "./typing.js";

/** Reading deeper than this in one expression or type gives up: the type of such an expression is unknown. */
const MAX_DEPTH = 40;
/** A type nested deeper than this is not read. */
const MAX_TYPE_DEPTH = 8;

const unparen = (typing: TypingRules, n: SyntaxNode | null): SyntaxNode | null => {
  let cur = n;
  while (cur && typing.expressions.wrappers.includes(cur.kind())) cur = cur.namedChildren()[0] ?? null;
  return cur;
};

/** The nodes of `d`'s field `field` that are names, also those inside a list the field holds. */
function namesIn(d: SyntaxNode, field: string, kinds: readonly string[]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const n of d.fieldChildren(field)) {
    if (kinds.includes(n.kind())) out.push(n);
    else for (const c of n.namedChildren()) if (kinds.includes(c.kind())) out.push(c);
  }
  return out;
}

/** A function or method found in a file: its node, its rule and the type body around it. */
export interface FunctionNode {
  node: SyntaxNode;
  rule: DeclarationRule;
  owner: string | null;
}

/**
 * Turns the tree of a file into plain data (`typing.ts`) with the node kinds and fields a pack's `typing` names. Every
 * method returns data; no result holds a node.
 */
export class Reader {
  private readonly typing: TypingRules;
  /** The dotted name of the type whose body the types being read sit in; null at the top of a file. */
  private owner: string | null = null;

  constructor(private readonly pack: LanguagePack) {
    if (!pack.nodes.typing) throw new Error(`${pack.id}: the pack has no typing rules`);
    this.typing = pack.nodes.typing;
  }

  // --- types --------------------------------------------------------------------------------

  /** The type a type expression names; null for a shape that is not read (function types, struct literals and the like). */
  typeRef(node: SyntaxNode | null, depth = 0): TypeRef | null {
    const t = this.typing.type;
    if (!node || depth > MAX_TYPE_DEPTH) return null;
    let b: SyntaxNode | null = node;
    while (b) {
      const k = b.kind();
      if (t.wrappers.includes(k)) b = b.namedChildren()[0] ?? null;
      else if (k === t.generic.kind)
        b = t.generic.field ? b.field(t.generic.field) : (b.namedChildren()[0] ?? null);
      else break;
    }
    if (!b) return null;
    const k = b.kind();
    if (t.names.includes(k)) return { k: "name", name: b.text(), owner: this.owner };
    if (t.qualified && k === t.qualified.kind)
      return {
        k: "qual",
        qualifier: b.field(t.qualified.qualifier)?.text() ?? "",
        name: b.field(t.qualified.name)?.text() ?? "",
      };
    const seq = t.sequences.find((s) => s.kind === k);
    if (seq) return { k: "seq", elem: this.typeRef(b.field(seq.element), depth + 1) };
    if (t.maps && k === t.maps.kind)
      return {
        k: "map",
        key: this.typeRef(b.field(t.maps.key), depth + 1),
        elem: this.typeRef(b.field(t.maps.value), depth + 1),
      };
    return null;
  }

  /** The type expressions inside a node that lists types (`implements A, B` holds a list holding both). */
  private typesIn(n: SyntaxNode, out: SyntaxNode[] = [], depth = 0): SyntaxNode[] {
    const t = this.typing.type;
    const k = n.kind();
    if (t.unread.includes(k)) return out;
    if (
      t.names.includes(k) ||
      k === t.generic.kind ||
      t.wrappers.includes(k) ||
      (t.qualified && k === t.qualified.kind)
    )
      out.push(n);
    else if (depth < MAX_TYPE_DEPTH) for (const c of n.namedChildren()) this.typesIn(c, out, depth + 1);
    return out;
  }

  /** Result types of a declaration: the result field is one type, or a list with one entry per name (at least one). */
  private results(decl: SyntaxNode, field: string): Results {
    const r = decl.field(field);
    if (!r) return [];
    const rule = this.typing.results;
    if (!rule || r.kind() !== rule.list) return [this.typeRef(r)];
    const out: Results = [];
    for (const p of r.namedChildren()) {
      const t = p.field(rule.type);
      if (!t) continue;
      const names = p.fieldChildren(rule.name).filter((n) => rule.nameKinds.includes(n.kind())).length;
      for (let i = 0; i < Math.max(1, names); i++) out.push(this.typeRef(t));
    }
    return out;
  }

  /** The number of arguments a call site passes; null for a language that does not tell overloads apart. */
  private argCount(site: SyntaxNode): number | null {
    const a = this.typing.arity;
    if (!a) return null;
    const comments = this.pack.tokens.comments;
    return (site.field(a.arguments)?.namedChildren() ?? []).filter((c) => !comments.includes(c.kind()))
      .length;
  }

  /** The number of arguments a declaration takes; null when the language does not tell overloads apart or the declaration has no parameter list. */
  private arityOf(d: SyntaxNode, rule: { parameters: string }): Arity | null {
    const a = this.typing.arity;
    const list = a ? d.field(rule.parameters) : null;
    if (!a || !list) return null;
    const params = list.namedChildren().filter((c) => a.parameters.includes(c.kind()));
    const variadic = params.some((c) => a.variadic.includes(c.kind()));
    return variadic
      ? { min: params.length - 1, max: Number.POSITIVE_INFINITY }
      : { min: params.length, max: params.length };
  }

  // --- expressions --------------------------------------------------------------------------

  /** An expression as far as its type is read; null for a form that is not read. */
  expr(node: SyntaxNode | null, depth = 0): Expr | null {
    const x = unparen(this.typing, node);
    if (!x || depth > MAX_DEPTH) return null;
    const e = this.typing.expressions;
    const kind = x.kind();
    if (this.isCall(kind)) return { k: "call", call: this.call(x, depth + 1) };
    if (this.typing.enclosing?.self.includes(kind)) return { k: "self" };
    if (this.typing.enclosing?.parent.includes(kind)) return { k: "parent" };
    if (e.names.includes(kind)) return { k: "name", name: x.text(), pos: x.range().start.index };
    const through = e.through.find((r) => r.kind === kind);
    if (through) {
      if (
        through.operator &&
        !through.operator.values.includes(x.field(through.operator.field)?.text() ?? "")
      )
        return null;
      return { k: "through", of: this.expr(x.field(through.operand), depth + 1) };
    }
    const typed = e.typed.find((r) => r.kind === kind);
    if (typed) {
      const t = x.field(typed.type);
      return { k: "typed", type: t ? this.typeRef(t) : null };
    }
    if (kind === e.index.kind) return { k: "elem", of: this.expr(x.field(e.index.operand), depth + 1) };
    const member = this.typing.callee.members.find((r) => r.kind === kind);
    if (member)
      return {
        k: "member",
        of: this.operand(x.field(member.operand), depth + 1),
        name: x.field(member.name)?.text() ?? "",
      };
    return null;
  }

  /** True for the kind of a call site read as a call: a call, or a conversion written as one. */
  private isCall(kind: string): boolean {
    return this.pack.nodes.call.includes(kind) || kind === this.typing.conversion?.kind;
  }

  /** The operand of a member: a plain name keeps its place, anything else reads as an expression. */
  private operand(node: SyntaxNode | null, depth: number): Expr | null {
    const x = unparen(this.typing, node);
    if (x && this.typing.callee.operands.includes(x.kind()))
      return { k: "name", name: x.text(), pos: x.range().start.index };
    return this.expr(x, depth);
  }

  /** What an expression calls. With `strip`, an instantiation (`f[T]`) stands for what it instantiates. */
  private callee(fnNode: SyntaxNode | null, at: SyntaxNode, strip: boolean, depth: number): Callee {
    const t = this.typing;
    let fn = unparen(t, fnNode);
    if (strip) {
      while (fn && (fn.kind() === t.expressions.index.kind || fn.kind() === t.type.generic.kind)) {
        fn = unparen(
          t,
          fn.kind() === t.expressions.index.kind
            ? fn.field(t.expressions.index.operand)
            : t.type.generic.field
              ? fn.field(t.type.generic.field)
              : (fn.namedChildren()[0] ?? null),
        );
      }
    }
    const line = (fn ?? at).range().start.line + 1;
    if (!fn) return { k: "none", line };
    const kind = fn.kind();
    if (t.callee.names.includes(kind))
      return { k: "name", name: fn.text(), pos: fn.range().start.index, line };
    const member = t.callee.members.find((r) => r.kind === kind);
    if (member) {
      const nameNode = fn.field(member.name);
      const operand = fn.field(member.operand);
      // A member node without an operand names something in scope: a bare name.
      if (!operand && nameNode)
        return { k: "name", name: nameNode.text(), pos: nameNode.range().start.index, line };
      return {
        k: "member",
        operand: this.operand(operand, depth + 1),
        name: nameNode?.text() ?? "",
        line: (nameNode ?? fn).range().start.line + 1,
      };
    }
    return { k: "none", line };
  }

  /** A call site (or a conversion written as one, or a construction). */
  private call(x: SyntaxNode, depth: number): CallExpr {
    const t = this.typing;
    if (t.construct && x.kind() === t.construct.kind)
      return {
        callee: { k: "new", type: this.typeRef(x.field(t.construct.type)), line: x.range().start.line + 1 },
        builtin: false,
        first: null,
        args: this.argCount(x),
      };
    const isConversion = x.kind() === t.conversion?.kind;
    const calleeField = this.pack.nodes.callee.field;
    const fnNode =
      t.conversion && isConversion
        ? x.field(t.conversion.type)
        : calleeField === null
          ? x
          : x.field(calleeField);
    const callee = this.callee(fnNode, x, true, depth);
    const raw = unparen(t, fnNode);
    const builtin = !isConversion && raw !== null && t.expressions.names.includes(raw.kind());
    let first: CallExpr["first"] = null;
    if (
      builtin &&
      t.builtins &&
      (t.builtins.typed.includes(raw.text()) || t.builtins.first.includes(raw.text()))
    ) {
      const arg = x.field(t.builtins.arguments)?.namedChildren()[0] ?? null;
      if (arg) first = { type: this.typeRef(arg), expr: this.expr(arg, depth + 1) };
    }
    return { callee, builtin, first, args: this.argCount(x) };
  }

  /** The callee of the function, or of a function named without a call, at a node (`targetAt`). */
  calleeAt(node: SyntaxNode): { callee: Callee; args: number | null } {
    const kind = node.kind();
    if (this.isCall(kind) || kind === this.typing.construct?.kind) {
      const c = this.call(node, 0);
      return { callee: c.callee, args: c.args };
    }
    return { callee: this.callee(node, node, false, 0), args: null };
  }

  /** Sets the type body the types read next sit in (a lookup by place reads inside a function of a type). */
  setOwner(owner: string | null): void {
    this.owner = owner;
  }

  // --- function bodies ----------------------------------------------------------------------

  /** The names a function declares (parameters, results, locals) with where each gets its type. */
  decls(fd: SyntaxNode): Decl[] {
    const t = this.typing;
    const l = t.locals;
    const kinds = [
      ...l.parameters.map((r) => r.kind),
      ...l.declarations.map((r) => r.kind),
      ...l.ranges.map((r) => r.kind),
      ...l.untyped.map((r) => r.kind),
    ];
    const blank = this.pack.tokens.locals.blank;
    const out: Decl[] = [];
    const add = (name: string, pos: number, source: DeclSource): void => {
      if (name !== blank) out.push({ name, pos, source });
    };
    for (const d of fd.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })) {
      const kind = d.kind();
      const start = d.range().start.index;
      const end = d.range().end.index;
      const at = (from: "start" | "end"): number => (from === "start" ? start : end);
      const param = l.parameters.find((r) => r.kind === kind);
      if (param) {
        const type = d.field(param.type);
        for (const n of namesIn(d, param.name, l.nameKinds))
          add(n.text(), at(param.from), {
            k: "type",
            type: type ? this.typeRef(type) : null,
            variadic: param.variadic,
          });
        continue;
      }
      const decl = l.declarations.find((r) => r.kind === kind);
      if (decl) {
        const names = namesIn(d, decl.names, l.nameKinds);
        let typeNode = decl.type
          ? d.field(decl.type)
          : decl.parentType
            ? (d.parent()?.field(decl.parentType) ?? null)
            : null;
        if (typeNode && l.inferred.includes(typeNode.text())) typeNode = null;
        const list = d.field(decl.values);
        const nodes = list ? (l.valueLists.includes(list.kind()) ? list.namedChildren() : [list]) : [];
        const values = nodes.map((v) => this.expr(v));
        for (const [index, n] of names.entries())
          add(n.text(), at(decl.from), {
            k: "values",
            typed: typeNode !== null,
            type: typeNode ? this.typeRef(typeNode) : null,
            index,
            values,
            count: names.length,
          });
        continue;
      }
      const range = l.ranges.find((r) => r.kind === kind);
      if (range) {
        const of = this.expr(d.field(range.source));
        for (const [index, n] of namesIn(d, range.names, l.nameKinds).entries())
          add(n.text(), at(range.from), { k: "range", of, index });
        continue;
      }
      const untyped = l.untyped.find((r) => r.kind === kind);
      if (untyped)
        for (const n of namesIn(d, untyped.names, l.nameKinds))
          add(n.text(), at(untyped.from), { k: "opaque" });
    }
    return out;
  }

  /** The call sites inside a node, in source order. */
  calls(body: SyntaxNode): CallSite[] {
    const t = this.typing;
    const any: Record<string, unknown>[] = this.pack.nodes.call.map((kind) => ({ kind }));
    if (t.conversion)
      any.push({ kind: t.conversion.kind, has: { field: t.conversion.type, kind: t.type.generic.kind } });
    if (t.construct) any.push({ kind: t.construct.kind });
    return body.findAll({ rule: { any } }).map((site) => ({
      call: this.call(site, 0),
      line: site.range().start.line + 1,
    }));
  }

  /** The rule of a function or method declaration found where `owner` says (a top-level function, a method with a receiver, a member of a type body), or undefined. */
  rule(d: SyntaxNode, owner: string | null): DeclarationRule | undefined {
    const kind = d.kind();
    const n = this.pack.nodes;
    if (owner === null)
      return n.function.find((r) => r.kind === kind) ?? n.method.find((r) => r.kind === kind && r.receiver);
    return n.method.find((r) => r.kind === kind && !r.receiver);
  }

  /** Every function and method declaration of a file, in source order, with the type body around it. */
  functions(root: SyntaxNode): FunctionNode[] {
    const out: FunctionNode[] = [];
    walkDeclarations(this.pack, root, ({ node, owner }) => {
      const rule = this.rule(node, owner);
      if (rule) out.push({ node, rule, owner });
    });
    return out;
  }

  /** The functions and methods of a file with their bodies' declarations and call sites. */
  bodies(root: SyntaxNode): FunctionBody[] {
    const out: FunctionBody[] = [];
    for (const f of this.functions(root)) {
      const body = f.rule.body ? f.node.field(f.rule.body) : null;
      if (!body) continue;
      this.owner = f.owner;
      out.push({
        start: f.node.range().start.index,
        owner: f.owner,
        decls: this.decls(f.node),
        calls: this.calls(body),
      });
    }
    this.owner = null;
    return out;
  }

  /** The innermost function or method declaration that holds the offset range, with the type body around it; null when none does. */
  functionAt(
    root: SyntaxNode,
    start: number,
    end: number,
  ): { node: SyntaxNode; owner: string | null } | null {
    let best: { node: SyntaxNode; owner: string | null; size: number } | null = null;
    for (const f of this.functions(root)) {
      const r = f.node.range();
      const size = r.end.index - r.start.index;
      if (r.start.index <= start && end <= r.end.index && (!best || size < best.size))
        best = { node: f.node, owner: f.owner, size };
    }
    return best ? { node: best.node, owner: best.owner } : null;
  }

  // --- declarations -------------------------------------------------------------------------

  /** The package name, imports, functions, methods, types and variables a file declares. */
  declarations(root: SyntaxNode): FileDecls {
    const n = this.pack.nodes;
    const t = this.typing;
    const clause = root.namedChildren().find((c) => c.kind() === t.package.clause);
    const out: FileDecls = {
      packageName: clause?.namedChildren().at(-1)?.text() ?? "?",
      packaged: clause !== undefined,
      imports: rawImportsOf(this.pack, root).map((i) => ({
        alias: i.alias,
        specifier: i.specifier,
        name: i.name,
        static: i.static,
      })),
      funcs: [],
      methods: [],
      types: [],
      vars: [],
    };
    walkDeclarations(this.pack, root, ({ node: d, owner }) => {
      this.owner = owner;
      const kind = d.kind();
      const start = d.range().start.index;
      const rule = this.rule(d, owner);
      const fn = owner === null ? n.function.find((r) => r.kind === kind) : undefined;
      const bodied = bodiedRule(this.pack, kind);
      if (rule && fn) {
        const name = d.field(fn.name)?.text();
        if (name && !t.unnamed.includes(name))
          out.funcs.push({ name, results: this.results(d, fn.result), start, arity: this.arityOf(d, fn) });
      } else if (rule) {
        const name = d.field(rule.name)?.text();
        let key: string | null = null;
        const r = n.receiver;
        if (rule.receiver && r) {
          const recv = d
            .field(rule.receiver)
            ?.namedChildren()
            .find((c) => c.kind() === r.parameter);
          const base = baseTypeName(r.baseType, recv?.field(r.type) ?? null);
          if (name && recv) key = `${base}.${name}`;
        } else if (name && owner !== null) key = `${owner}.${name}`;
        if (key !== null)
          out.methods.push({
            key,
            owner,
            results: this.results(d, rule.result),
            start,
            arity: this.arityOf(d, rule),
          });
      } else if (bodied) {
        const name = bodiedName(bodied, d, owner);
        if (name) out.types.push(this.bodiedDecl(d, bodied.as, name, owner));
      } else if (owner === null && n.types.declarations.includes(kind)) {
        for (const s of specsOf(d, n.types.specs, n.types.groups)) {
          const name = s.field(n.types.name)?.text();
          const type = s.field(n.types.type);
          if (name && type) out.types.push(this.typeDecl(s, name, type));
        }
      } else if (owner === null && t.vars.declarations.includes(kind)) {
        for (const s of specsOf(d, t.vars.specs, n.values.groups)) {
          const names = s.fieldChildren(n.values.name).filter((x) => n.values.nameKinds.includes(x.kind()));
          const values = s.field(t.vars.value)?.namedChildren() ?? [];
          const type = s.field(t.vars.type);
          names.forEach((nm, i) => {
            const name = nm.text();
            if (name === this.pack.tokens.locals.blank) return;
            out.vars.push({
              name,
              declared: type ? { type: this.typeRef(type) } : null,
              value: values.length === names.length ? this.expr(values[i] ?? null) : null,
            });
          });
        }
      }
    });
    this.owner = null;
    return out;
  }

  private emptyDecl(name: string, line: number, start: number, generic: boolean): TypeDecl {
    return {
      name,
      kind: "other",
      line,
      start,
      generic,
      fields: new Map(),
      embedded: [],
      supers: [],
      methods: new Map(),
      embeds: [],
      open: false,
      target: null,
    };
  }

  /** A type with a body of members: its fields and the supertypes its declaration names. `owner` is the type around it. */
  private bodiedDecl(node: SyntaxNode, as: string, name: string, owner: string | null): TypeDecl {
    const t = this.typing;
    const start = node.range().start;
    const decl = this.emptyDecl(name, start.line + 1, start.index, node.field(t.generics) !== null);
    decl.kind = as === "interface" ? "interface" : "class";
    // The supertypes are written where the declaration is, not inside its body.
    for (const s of t.supertypes) {
      const holders = s.field
        ? node.fieldChildren(s.field)
        : node.namedChildren().filter((c) => c.kind() === s.kind);
      for (const h of holders)
        for (const ty of this.typesIn(h))
          decl.supers.push({ type: this.typeRef(ty), edge: s.edge, line: ty.range().start.line + 1 });
    }
    const rule = bodiedRule(this.pack, node.kind());
    const body = rule ? node.field(rule.body) : null;
    this.owner = name;
    for (const m of body ? membersOf(this.pack, body) : []) {
      if (!t.members.entries.includes(m.kind())) continue;
      const mt = m.field(t.members.type);
      if (!mt) continue;
      for (const nm of this.memberNames(m)) decl.fields.set(nm, this.typeRef(mt));
    }
    this.owner = owner;
    return decl;
  }

  /** The names a member entry declares. */
  private memberNames(m: SyntaxNode): string[] {
    const t = this.typing.members;
    const out: string[] = [];
    for (const x of m.fieldChildren(t.name)) {
      if (!t.nameKinds.includes(x.kind())) continue;
      const id = t.declarator ? x.field(t.declarator) : x;
      if (id) out.push(id.text());
    }
    return out;
  }

  private typeDecl(spec: SyntaxNode, name: string, type: SyntaxNode): TypeDecl {
    const n = this.pack.nodes;
    const t = this.typing;
    const start = spec.range().start;
    const decl = this.emptyDecl(name, start.line + 1, start.index, spec.field(t.generics) !== null);
    decl.kind = n.types.aliases.includes(spec.kind()) ? "alias" : "other";
    decl.target = this.typeRef(type);
    if (decl.kind === "alias") return decl;
    if (n.types.class.includes(type.kind())) {
      decl.kind = "class";
      const list = type.namedChildren().find((c) => c.kind() === t.members.container);
      for (const m of list?.namedChildren() ?? []) {
        if (!t.members.entries.includes(m.kind())) continue;
        const mt = m.field(t.members.type);
        if (!mt) continue;
        const names = this.memberNames(m);
        if (names.length === 0)
          decl.embedded.push({ type: this.typeRef(mt), line: mt.range().start.line + 1 });
        for (const nm of names) decl.fields.set(nm, this.typeRef(mt));
      }
    } else if (n.types.interface.includes(type.kind())) {
      decl.kind = "interface";
      const im = n.types.interfaceMethods;
      for (const c of type.namedChildren()) {
        if (im?.members.includes(c.kind())) {
          const mn = c.field(im.rule.name)?.text();
          if (mn)
            decl.methods.set(mn, { results: this.results(c, im.rule.result), start: c.range().start.index });
        } else if (t.interfaces.embeds.includes(c.kind())) {
          const parts = c.namedChildren();
          const e = parts[0];
          if (parts.length === 1 && e && t.interfaces.embedKinds.includes(e.kind()))
            decl.embeds.push(this.typeRef(e));
          else decl.open = true;
        }
      }
    }
    return decl;
  }
}

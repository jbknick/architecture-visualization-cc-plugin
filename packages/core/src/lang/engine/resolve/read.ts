import type { SyntaxNode } from "../grammar.js";
import type { DeclarationRule, LanguagePack, TypingRules } from "../pack.js";
import { rawImportsOf, specsOf } from "../parse.js";
import {
  baseTypeName,
  bodiedName,
  bodiedRule,
  type HangingBody,
  hangingRanges,
  implRule,
  membersOf,
  parameterNames,
  walkDeclarations,
} from "../walk.js";
import type {
  Arity,
  CallExpr,
  Callee,
  CallSite,
  Decl,
  DeclSource,
  Expr,
  FileDecls,
  FlowAttr,
  FunctionBody,
  LocalBody,
  Results,
  TypeDecl,
  TypeRef,
} from "./typing.js";

/** Reading deeper than this in one expression or type gives up: the type of such an expression is unknown. */
const MAX_DEPTH = 40;
/** A type nested deeper than this is not read. */
const MAX_TYPE_DEPTH = 8;

/** A span of source offsets `[start, end)`. */
interface Range {
  start: number;
  end: number;
}

const inside = (ranges: readonly Range[], at: number): boolean =>
  ranges.some((r) => at >= r.start && at < r.end);

const unparen = (typing: TypingRules, n: SyntaxNode | null): SyntaxNode | null => {
  let cur = n;
  while (cur && typing.expressions.wrappers.includes(cur.kind())) cur = cur.namedChildren()[0] ?? null;
  return cur;
};

/**
 * The nodes of `d`'s field `field` that are names, also those inside a list the field holds (any node, or only the kinds
 * in `lists` when the pack names them). An empty `field` says the names are the children of `d` itself.
 */
function namesIn(
  d: SyntaxNode,
  field: string,
  kinds: readonly string[],
  lists?: readonly string[],
): SyntaxNode[] {
  if (field === "") return d.namedChildren().filter((c) => kinds.includes(c.kind()));
  const out: SyntaxNode[] = [];
  for (const n of d.fieldChildren(field)) {
    if (kinds.includes(n.kind())) out.push(n);
    else if (!lists || lists.includes(n.kind()))
      for (const c of n.namedChildren()) if (kinds.includes(c.kind())) out.push(c);
  }
  return out;
}

/** A function or method found in a file: its node, its rule and the type body around it. */
export interface FunctionNode {
  node: SyntaxNode;
  rule: DeclarationRule;
  owner: string | null;
  /**
   * For a method of a hanging body: the members the bodies around it were created in, outermost first. Their
   * parameters and locals are visible in the method.
   */
  hosts: Host[];
}

/** A member of a type body that a hanging body was created in, with the type whose body holds the member. */
export interface Host {
  node: SyntaxNode;
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
  /** The function or method whose body is being read; null outside one. */
  private fn: SyntaxNode | null = null;
  /**
   * The type parameters of the function being read and of the functions and blocks of members around it: a name among
   * them is no type. A parameter with one bound (`typing.type.parameters.bounds`) reads as the type of that bound, except
   * in a result type.
   */
  private tparams: ReadonlyMap<string, TypeRef | null> = new Map();
  /** False while a result type is read: the parameter of a generic function is then the type the caller gives it, not its bound. */
  private bounded = true;
  /** The names that items and imports declared in the body of the function being read bring (`locals.items`): none is looked up. */
  private shadow: ReadonlySet<string> = new Set();

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
    let args: (TypeRef | null)[] | undefined;
    while (b) {
      const k = b.kind();
      const nullable = this.nullable(b);
      const fielded = t.fielded?.find((f) => f.kind === k);
      if (nullable) b = nullable.inner;
      else if (fielded) b = b.field(fielded.field);
      else if (t.wrappers.includes(k)) b = b.namedChildren()[0] ?? null;
      else if (k === t.generic.kind) {
        const list = t.generic.arguments
          ? b.namedChildren().find((c) => c.kind() === t.generic.arguments)
          : undefined;
        // The arguments of the outermost instantiation; a diamond (`<>`) has none.
        if (!args && list && list.namedChildren().length > 0)
          args = list.namedChildren().map((c) => this.typeRef(c, depth + 1));
        b = t.generic.field ? b.field(t.generic.field) : (b.namedChildren()[0] ?? null);
      } else break;
    }
    if (!b) return null;
    const k = b.kind();
    if (t.names.includes(k)) {
      const name = b.text();
      if (this.shadow.has(name)) return null;
      // The name for the type around the code is that type; with no type around, it is no type.
      if (t.self !== undefined && name === t.self)
        return this.owner === null || this.owner === this.pack.nodes.types.impls?.baseType.unknown
          ? null
          : { k: "name", name: this.owner, owner: this.owner };
      if (!args && this.tparams.has(name)) {
        const bound = this.bounded ? this.tparams.get(name) : null;
        return bound ?? { k: "name", name, param: true };
      }
      return { k: "name", name, owner: this.owner, ...(args ? { args } : {}) };
    }
    if (t.quoted && k === t.quoted.kind) return this.quoted(b, t.quoted);
    if (t.qualified && k === t.qualified.kind) {
      const qualifier = b.field(t.qualified.qualifier)?.text() ?? "";
      if (this.shadow.has(qualifier.split(this.pack.nodes.import.separator)[0] ?? "")) return null;
      return { k: "qual", qualifier, name: b.field(t.qualified.name)?.text() ?? "" };
    }
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

  /**
   * The type a nullable annotation (`typing.type.nullable`) reads as: `inner` is the node of that type, null when the
   * annotation is one of those forms but names no one type (a union of two types, a generic with several arguments).
   * Null when the node is no such form (a generic of another name is an ordinary generic).
   */
  private nullable(b: SyntaxNode): { inner: SyntaxNode | null } | null {
    const n = this.typing.type.nullable;
    if (!n) return null;
    const kind = b.kind();
    if (kind === n.union.kind) {
      if (!n.union.operators.includes(b.field(n.union.operator)?.text() ?? "")) return null;
      const [left, right] = n.union.sides.map((s) => b.field(s));
      const absent = (x: SyntaxNode | null | undefined): boolean => !!x && n.union.none.includes(x.kind());
      if (absent(left) === absent(right)) return { inner: null };
      return { inner: (absent(left) ? right : left) ?? null };
    }
    const form = n.forms.find((f) => f.kind === kind);
    const head = form ? (form.head === "" ? b.namedChildren()[0] : b.field(form.head)) : null;
    if (!form || !head) return null;
    const sep = this.pack.nodes.import.separator;
    if (!n.generics.includes(head.text().split(sep).pop() ?? "")) return null;
    const { kind: holder, field } = form.arguments;
    const comments = this.pack.tokens.comments;
    const list = holder
      ? (b
          .namedChildren()
          .find((c) => c.kind() === holder)
          ?.namedChildren() ?? [])
      : b.fieldChildren(field ?? "");
    const given = list.filter((c) => !comments.includes(c.kind()));
    return { inner: given.length === 1 ? (given[0] ?? null) : null };
  }

  /** A type written as a string: the plain or qualified name inside it; null for any other text. */
  private quoted(s: SyntaxNode, rule: { content: string; name: RegExp }): TypeRef | null {
    const parts = s.namedChildren();
    // An interpolation is a child that has children of its own.
    if (parts.some((c) => c.kind() !== rule.content && c.namedChildren().length > 0)) return null;
    const text = parts.filter((c) => c.kind() === rule.content);
    const written = text.length === 1 ? (text[0]?.text() ?? "") : "";
    if (!rule.name.test(written)) return null;
    const segments = written.split(this.pack.nodes.import.separator);
    const name = segments.pop() ?? "";
    if (segments.length > 0)
      return { k: "qual", qualifier: segments.join(this.pack.nodes.import.separator), name };
    if (this.tparams.has(name)) return { k: "name", name, param: true };
    return { k: "name", name, owner: this.owner };
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

  /** The result types of a function or method: none are read for a declaration whose result is a deferred value. */
  private resultsOf(decl: SyntaxNode, field: string): Results {
    const deferred = this.typing.deferred;
    if (deferred && decl.children().some((c) => c.kind() === deferred)) return [];
    this.bounded = false;
    try {
      return this.results(decl, field);
    } finally {
      this.bounded = true;
    }
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
    const spread = params.filter((c) => a.variadic.includes(c.kind())).length;
    const rest = a.rest !== undefined && list.fieldChildren(a.rest).length > 0;
    // A parameter with a default value may be left out.
    const optional = params.filter((c) => c.children().some((x) => x.kind() === a.optional)).length;
    return spread > 0 || rest
      ? { min: params.length - spread - optional, max: Number.POSITIVE_INFINITY }
      : { min: params.length - optional, max: params.length };
  }

  // --- expressions --------------------------------------------------------------------------

  /** An expression as far as its type is read; null for a form that is not read. */
  expr(node: SyntaxNode | null, depth = 0): Expr | null {
    const x = unparen(this.typing, node);
    if (!x || depth > MAX_DEPTH) return null;
    const e = this.typing.expressions;
    const kind = x.kind();
    if (this.isParentCall(x)) return { k: "base" };
    if (this.isCall(kind)) return { k: "call", call: this.call(x, depth + 1) };
    if (this.typing.enclosing?.self.includes(kind) || this.typing.self?.includes(kind))
      return { k: "self", ...this.bodyOf(x) };
    if (this.typing.enclosing?.parent.includes(kind)) return { k: "parent", ...this.bodyOf(x) };
    if (e.names.includes(kind))
      return { k: "name", name: x.text(), pos: x.range().start.index, ...this.bodyOf(x) };
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
        name: this.nameOf(x.field(member.name)),
      };
    return null;
  }

  /** The name a member node holds: an instantiation (`m<T>`) is the name it instantiates. */
  private nameOf(n: SyntaxNode | null): string {
    const g = this.typing.type.generic;
    const head = n?.kind() === g.kind ? (g.field ? n.field(g.field) : n.namedChildren()[0]) : n;
    return head?.text() ?? "";
  }

  /** True for the call the pack's `parent` rule names, written without arguments: it stands for the one base of the type around. */
  private isParentCall(x: SyntaxNode): boolean {
    const rule = this.typing.parent;
    const field = this.pack.nodes.callee.field;
    if (!rule || field === null || !this.pack.nodes.call.includes(x.kind())) return false;
    const fn = unparen(this.typing, x.field(field));
    if (!fn || !this.typing.callee.names.includes(fn.kind()) || fn.text() !== rule.call) return false;
    const comments = this.pack.tokens.comments;
    return (x.field(rule.arguments)?.namedChildren() ?? []).every((c) => comments.includes(c.kind()));
  }

  /** True for the kind of a call site read as a call: a call, or a conversion written as one. */
  private isCall(kind: string): boolean {
    return this.pack.nodes.call.includes(kind) || kind === this.typing.conversion?.kind;
  }

  /** The operand of a member: a plain name keeps its place, anything else reads as an expression. */
  private operand(node: SyntaxNode | null, depth: number): Expr | null {
    const x = unparen(this.typing, node);
    if (x && this.typing.callee.operands.includes(x.kind()))
      return { k: "name", name: x.text(), pos: x.range().start.index, ...this.bodyOf(x) };
    return this.expr(x, depth);
  }

  /**
   * The body of a construction expression or of a type declared inside the function that holds `x`, when `x` is inside
   * one (the innermost): its code is not in the type around the function. Empty otherwise.
   */
  private bodyOf(x: SyntaxNode): { body?: LocalBody } {
    const t = this.typing;
    const fn = this.fn;
    if (!fn || !t.enclosing) return {};
    const same = (a: SyntaxNode, b: SyntaxNode): boolean =>
      a.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index;
    const names = (body: SyntaxNode): string[] =>
      membersOf(this.pack, body).flatMap((m) => {
        const rule = this.pack.nodes.method.find((r) => r.kind === m.kind());
        const name = rule ? m.field(rule.name)?.text() : undefined;
        return name ? [name] : [];
      });
    let child = x;
    for (let p = x.parent(); p && !same(p, fn); child = p, p = p.parent()) {
      const created = t.construct;
      if (created?.body && p.kind() === created.kind && child.kind() === created.body)
        return { body: { supers: [this.typeRef(p.field(created.type))], members: names(child) } };
      const rule = bodiedRule(this.pack, p.kind());
      const body = rule ? p.field(rule.body) : null;
      if (body && same(body, child)) {
        const supers = t.supertypes.flatMap((s) =>
          (s.field ? p.fieldChildren(s.field) : p.namedChildren().filter((c) => c.kind() === s.kind)).flatMap(
            (h) => this.typesIn(h).map((ty) => this.typeRef(ty)),
          ),
        );
        return { body: { supers, members: names(body) } };
      }
    }
    return {};
  }

  /** The segments of a path of names (`typing.callee.paths`); null when a segment is not a plain name or a word of the pack. */
  private segments(
    n: SyntaxNode,
    rule: { kind: string; path: string; name: string; segments: readonly string[] },
    depth: number,
  ): string[] | null {
    if (depth > MAX_TYPE_DEPTH) return null;
    const name = n.field(rule.name);
    const head = n.field(rule.path);
    if (!name || !head || !rule.segments.includes(name.kind())) return null;
    if (head.kind() === rule.kind) {
      const before = this.segments(head, rule, depth + 1);
      return before && [...before, name.text()];
    }
    return rule.segments.includes(head.kind()) ? [head.text(), name.text()] : null;
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
    if (t.callee.names.includes(kind)) {
      if (this.shadow.has(fn.text())) return { k: "none", line };
      return { k: "name", name: fn.text(), pos: fn.range().start.index, line, ...this.bodyOf(fn) };
    }
    const path = t.callee.paths?.find((r) => r.kind === kind);
    if (path) {
      const segments = this.segments(fn, path, 0);
      // A type parameter in front of the name stands for a type no one knows here.
      if (!segments || this.tparams.has(segments[0] ?? "") || this.shadow.has(segments[0] ?? ""))
        return { k: "none", line };
      return { k: "path", segments, pos: fn.range().start.index, line };
    }
    const member = t.callee.members.find((r) => r.kind === kind);
    if (member) {
      const nameNode = fn.field(member.name);
      const operand = fn.field(member.operand);
      // A member node without an operand names something in scope: a bare name.
      if (!operand && nameNode)
        return {
          k: "name",
          name: nameNode.text(),
          pos: nameNode.range().start.index,
          line,
          ...this.bodyOf(fn),
        };
      return {
        k: "member",
        operand: this.operand(operand, depth + 1),
        name: this.nameOf(nameNode),
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

  /** Sets the function the expressions read next sit in (a lookup by place reads inside a function of a type); null for none. */
  setFunction(f: FunctionNode | null): void {
    this.owner = f?.owner ?? null;
    this.fn = f?.node ?? null;
    this.tparams = f ? this.paramsIn(f.node, f.owner, f.hosts) : new Map();
    this.shadow = f ? this.shadowOf(f.node) : new Set();
  }

  /** The names that the items and imports declared in the body of a function bring (`locals.items`). */
  private shadowOf(fn: SyntaxNode): Set<string> {
    const items = this.typing.locals.items;
    const out = new Set<string>();
    if (!items) return out;
    for (const k of items.kinds)
      for (const d of fn.findAll({ rule: { kind: k.kind } })) {
        const name = d.field(k.name)?.text();
        if (name) out.add(name);
      }
    const trees = this.pack.nodes.import.trees;
    if (items.imports && trees) {
      const held = new Set<number>();
      for (const u of fn.findAll({ rule: { any: trees.declarations.map((kind) => ({ kind })) } })) {
        const holder = u.parent();
        if (!holder || held.has(holder.range().start.index)) continue;
        held.add(holder.range().start.index);
        for (const i of rawImportsOf(this.pack, holder)) {
          const name = i.alias ?? i.name;
          if (name && name !== "*") out.add(name);
        }
      }
    }
    return out;
  }

  /**
   * The type parameters in scope in a member of a type body: those of the block of members it is in, its own and those
   * of the members the bodies around it were created in. An inner one hides an outer one of the same name.
   */
  private paramsIn(
    node: SyntaxNode,
    owner: string | null,
    hosts: readonly Host[],
  ): Map<string, TypeRef | null> {
    const out = new Map<string, TypeRef | null>();
    for (const h of [...hosts, { node, owner }]) {
      for (const [k, v] of this.implParams(h.node)) out.set(k, v);
      for (const [k, v] of this.typeBounds(h.node, this.rule(h.node, h.owner)?.generics)) out.set(k, v);
    }
    return out;
  }

  /** The type parameters of the block of members (`types.impls`) that holds a member; none for a member of any other body. */
  private implParams(member: SyntaxNode): Map<string, TypeRef | null> {
    const block = member.parent()?.parent();
    const impl = block ? implRule(this.pack, block) : undefined;
    return block && impl ? this.typeBounds(block, impl.generics) : new Map();
  }

  /**
   * The names visible in a member of a type body: those it declares and, for a member of a hanging body, those of the
   * members the bodies around it were created in (their parameters and locals), each read in its own type body.
   */
  private scopeOf(node: SyntaxNode, owner: string | null, hosts: readonly Host[]): Decl[] {
    const out: Decl[] = [];
    const chain = [...hosts, { node, owner }];
    chain.forEach((h, i) => {
      this.owner = h.owner;
      this.fn = h.node;
      this.tparams = this.paramsIn(h.node, h.owner, chain.slice(0, i));
      this.shadow = this.shadowOf(h.node);
      const own = i === chain.length - 1;
      for (const d of this.decls(h.node)) out.push(own ? d : { ...d, outer: { owner: h.owner } });
    });
    return out;
  }

  /** The names visible in a function: `scopeOf` for it. */
  declsOf(f: FunctionNode): Decl[] {
    const out = this.scopeOf(f.node, f.owner, f.hosts);
    this.setFunction(null);
    return out;
  }

  // --- function bodies ----------------------------------------------------------------------

  /** The node of a declaration that lists its type parameters: the field `field`, or, where the grammar has no such field, the child of that kind. */
  private genericList(d: SyntaxNode, field: string | undefined): SyntaxNode | null {
    if (!field) return null;
    return d.field(field) ?? d.namedChildren().find((c) => c.kind() === field) ?? null;
  }

  /** The names of the type parameters a declaration holds in the field `field`. */
  private typeParams(d: SyntaxNode, field: string | undefined): string[] {
    return parameterNames(this.pack, this.genericList(d, field));
  }

  /**
   * The type parameters of a declaration with the type of their one bound (`typing.type.parameters.bounds`), read in
   * the parameters and locals of the declaration; null for a parameter with no bound or several. The bounds are those
   * written with the parameter and, in the clause the pack names, apart from it; kinds in `ignore` count for none.
   */
  private typeBounds(d: SyntaxNode, field: string | undefined): Map<string, TypeRef | null> {
    const out = new Map<string, TypeRef | null>();
    for (const name of this.typeParams(d, field)) out.set(name, null);
    const p = this.typing.type.parameters;
    const rule = p?.bounds;
    const list = this.genericList(d, field);
    if (!p || !rule || !list || out.size === 0) return out;
    const found = new Map<string, SyntaxNode[]>();
    const add = (name: string | undefined, bounds: SyntaxNode | null): void => {
      if (!name || !bounds || !out.has(name)) return;
      const nodes = found.get(name) ?? [];
      for (const b of bounds.namedChildren())
        if (!rule.ignore.includes(b.kind()) && !this.pack.tokens.comments.includes(b.kind())) nodes.push(b);
      found.set(name, nodes);
    };
    for (const c of list.namedChildren())
      if (c.kind() === p.entry) add(c.field(rule.name)?.text(), c.field(rule.field));
    const clause = rule.where;
    if (clause)
      for (const w of d.namedChildren().filter((c) => c.kind() === clause.kind))
        for (const pred of w.namedChildren().filter((c) => c.kind() === clause.predicate))
          add(pred.field(clause.name)?.text(), pred.field(clause.bounds));
    // A bound is read as any type is, outside the parameters it may be written with.
    const saved = this.tparams;
    this.tparams = new Map();
    for (const [name, nodes] of found) {
      const only = nodes.length === 1 ? nodes[0] : undefined;
      if (only) out.set(name, this.typeRef(only));
    }
    this.tparams = saved;
    return out;
  }

  /** The names a function declares (parameters, results, locals) with where each gets its type; those inside a range of `skip` belong to the body found there. */
  decls(fd: SyntaxNode, skip: readonly Range[] = hangingRanges(this.pack, fd)): Decl[] {
    const t = this.typing;
    const l = t.locals;
    const kinds = [
      ...l.parameters.map((r) => r.kind),
      ...l.declarations.map((r) => r.kind),
      ...l.ranges.map((r) => r.kind),
      ...l.untyped.map((r) => r.kind),
    ];
    const blank = this.pack.tokens.locals.blank;
    const flow = t.flow;
    const out: Decl[] = [];
    const add = (name: string, pos: number, source: DeclSource, byFlow?: DeclSource, end?: number): void => {
      if (name !== blank)
        out.push({
          name,
          pos,
          ...(end === undefined ? {} : { end }),
          source,
          ...(byFlow ? { flow: byFlow } : {}),
        });
    };
    /** Where the nearest block around a node ends (`locals.blocks`); undefined when none is listed or none holds the node. */
    const blockEnd = (n: SyntaxNode): number | undefined => {
      if (!l.blocks) return undefined;
      for (let up = n.parent(); up; up = up.parent())
        if (l.blocks.includes(up.kind())) return up.range().end.index;
      return undefined;
    };
    const fnStart = fd.range().start.index;
    const fnEnd = fd.range().end.index;
    for (const d of fd.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })) {
      const kind = d.kind();
      const start = d.range().start.index;
      if (inside(skip, start)) continue;
      const end = d.range().end.index;
      // The function the names are collected for is not one of them.
      if (start === fnStart && end === fnEnd) continue;
      const at = (from: "start" | "end"): number => (from === "start" ? start : end);
      const param = l.parameters.find((r) => r.kind === kind);
      if (param) {
        const type = d.field(param.type);
        for (const n of namesIn(d, param.name, l.nameKinds, l.nameLists))
          add(n.text(), at(param.from), {
            k: "type",
            type: type ? this.typeRef(type) : null,
            variadic: param.variadic,
          });
        continue;
      }
      const decl = l.declarations.find((r) => r.kind === kind);
      if (decl) {
        const names = namesIn(d, decl.names, l.nameKinds, l.nameLists);
        let typeNode = decl.type
          ? d.field(decl.type)
          : decl.parentType
            ? (d.parent()?.field(decl.parentType) ?? null)
            : null;
        if (typeNode && l.inferred.includes(typeNode.text())) typeNode = null;
        // Without a field for the value, it is the last child of the declaration that is no name (and no comment).
        const list =
          decl.values === undefined
            ? (d
                .namedChildren()
                .filter(
                  (c) =>
                    !this.pack.tokens.comments.includes(c.kind()) &&
                    !names.some(
                      (n) =>
                        n.range().start.index === c.range().start.index &&
                        n.range().end.index === c.range().end.index,
                    ),
                )
                .at(-1) ?? null)
            : d.field(decl.values);
        const nodes = list ? (l.valueLists.includes(list.kind()) ? list.namedChildren() : [list]) : [];
        const values = nodes.map((v) => this.expr(v));
        // Without a type, the value types the name only for the flow resolver; the declared types know nothing of it.
        const byFlow = typeNode === null && flow?.untyped.includes(kind) === true;
        for (const [index, n] of names.entries()) {
          const source: DeclSource = {
            k: "values",
            typed: typeNode !== null,
            type: typeNode ? this.typeRef(typeNode) : null,
            index,
            values,
            count: names.length,
          };
          if (byFlow) add(n.text(), at(decl.from), { k: "opaque" }, source, blockEnd(d));
          else add(n.text(), at(decl.from), source, undefined, blockEnd(d));
        }
        continue;
      }
      const range = l.ranges.find((r) => r.kind === kind);
      if (range) {
        const of = this.expr(d.field(range.source));
        for (const [index, n] of namesIn(d, range.names, l.nameKinds, l.nameLists).entries())
          add(n.text(), at(range.from), { k: "range", of, index });
        continue;
      }
      const untyped = l.untyped.find((r) => r.kind === kind);
      if (untyped) {
        // The parameter of a method that names the instance is the instance, for the flow resolver.
        const p = d.parent();
        const own =
          flow !== undefined &&
          this.owner !== null &&
          p !== null &&
          p.range().start.index === fnStart &&
          p.range().end.index === fnEnd;
        let anchor = d;
        for (let up = d.parent(); untyped.scope && up; up = up.parent()) {
          if (untyped.scope.includes(up.kind())) {
            anchor = up;
            break;
          }
        }
        const pos = untyped.from === "start" ? anchor.range().start.index : end;
        for (const n of namesIn(d, untyped.names, l.nameKinds, l.nameLists))
          add(n.text(), pos, { k: "opaque" }, own && n.text() === flow?.self ? { k: "self" } : undefined);
      }
    }
    return out;
  }

  /** The call sites inside a node, in source order; those inside a range of `skip` belong to the body found there. */
  calls(body: SyntaxNode, skip: readonly Range[] = []): CallSite[] {
    const t = this.typing;
    const any: Record<string, unknown>[] = this.pack.nodes.call.map((kind) => ({ kind }));
    if (t.conversion)
      any.push({ kind: t.conversion.kind, has: { field: t.conversion.type, kind: t.type.generic.kind } });
    if (t.construct) any.push({ kind: t.construct.kind });
    return body
      .findAll({ rule: { any } })
      .filter((site) => !inside(skip, site.range().start.index))
      .map((site) => ({
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
    const hostsOf = new Map<string, Host[]>();
    walkDeclarations(this.pack, root, ({ node, owner, body: hanging }) => {
      if (hanging) {
        hostsOf.set(hanging.name, [...(hostsOf.get(owner ?? "") ?? []), { node: hanging.host, owner }]);
        return;
      }
      const rule = this.rule(node, owner);
      if (rule) out.push({ node, rule, owner, hosts: hostsOf.get(owner ?? "") ?? [] });
    });
    return out;
  }

  /**
   * The code of a file with its declarations and call sites, each part with the offset of the symbol that holds it: the
   * functions and methods, and, for a language whose code sits in type bodies, what runs outside a method (field
   * initializers, initializer blocks, the arguments of an enumeration element), which belongs to the type around it, or
   * to the method a hanging body was created in when the code is in that body. Code inside a hanging body belongs to the
   * members of that body, not to the member the body hangs from.
   */
  bodies(root: SyntaxNode): FunctionBody[] {
    const out: FunctionBody[] = [];
    /** Offset of the symbol that stands for the code of a type body, by the dotted name of the type. */
    const holder = new Map<string, number>();
    const hostsOf = new Map<string, Host[]>();
    walkDeclarations(this.pack, root, ({ node, owner, body: hanging }) => {
      if (hanging) {
        const host = hanging.host;
        hostsOf.set(hanging.name, [...(hostsOf.get(owner ?? "") ?? []), { node: host, owner }]);
        const start =
          owner !== null && this.rule(host, owner) ? host.range().start.index : holder.get(owner ?? "");
        if (start !== undefined) holder.set(hanging.name, start);
        return;
      }
      const bodied = bodiedRule(this.pack, node.kind());
      if (bodied) {
        const name = bodiedName(bodied, node, owner);
        if (name) holder.set(name, node.range().start.index);
        return;
      }
      const rule = this.rule(node, owner);
      if (!rule && (owner === null || !this.typing.enclosing)) return;
      const body = rule ? (rule.body ? node.field(rule.body) : null) : node;
      if (!body) return;
      const start = rule ? node.range().start.index : holder.get(owner ?? "");
      if (start === undefined) return;
      const hosts = hostsOf.get(owner ?? "") ?? [];
      const decls = this.scopeOf(node, owner, hosts);
      // `scopeOf` leaves the reader in this member, with its type parameters in scope.
      const calls = this.calls(body, hangingRanges(this.pack, node));
      if (calls.length > 0 || rule) out.push({ start, owner, decls, calls });
    });
    this.setFunction(null);
    return out;
  }

  /** The innermost function or method declaration that holds the offset range, with the type body around it; null when none does. */
  functionAt(root: SyntaxNode, start: number, end: number): FunctionNode | null {
    let best: { f: FunctionNode; size: number } | null = null;
    for (const f of this.functions(root)) {
      const r = f.node.range();
      const size = r.end.index - r.start.index;
      if (r.start.index <= start && end <= r.end.index && (!best || size < best.size)) best = { f, size };
    }
    return best?.f ?? null;
  }

  // --- declarations -------------------------------------------------------------------------

  /** True when a decorator the pack lists as an overload mark is written on the declaration `d`. */
  private isOverload(d: SyntaxNode): boolean {
    const rule = this.typing.decorators;
    const wrapper = d.parent();
    if (!rule || wrapper?.kind() !== rule.wrapper) return false;
    const sep = this.pack.nodes.import.separator;
    const callee = this.typing.callee;
    // A decorator that is a call (`@mark(1)`) is not a plain mark.
    const plain = [...callee.names, ...callee.members.map((m) => m.kind)];
    return wrapper
      .namedChildren()
      .filter((c) => c.kind() === rule.entry)
      .some((c) => {
        const e = c.namedChildren()[0];
        return !!e && plain.includes(e.kind()) && rule.overloads.includes(e.text().split(sep).pop() ?? "");
      });
  }

  /** The mark of an extension method: its first parameter is marked, and the type that parameter has. Empty for any other declaration. */
  private extensionOf(d: SyntaxNode, rule: { parameters: string }): { extension?: { type: TypeRef | null } } {
    const x = this.typing.extensions;
    const first = x
      ? d
          .field(rule.parameters)
          ?.namedChildren()
          .find((c) => c.kind() === x.parameter)
      : undefined;
    if (!x || !first || !first.children().some((c) => c.text() === x.marker)) return {};
    const type = first.field(x.type);
    return { extension: { type: type ? this.typeRef(type) : null } };
  }

  /** The package name, imports, functions, methods, types and variables a file declares. */
  declarations(root: SyntaxNode): FileDecls {
    const n = this.pack.nodes;
    const t = this.typing;
    // A file with one declaration of a package has it; with several (or one inside another), none.
    const clauses = t.package.clause
      ? root.findAll({ rule: { any: t.package.clause.map((kind) => ({ kind })) } })
      : [];
    const clause = clauses.length === 1 ? clauses[0] : undefined;
    const named = clause
      ? t.package.name
        ? clause.field(t.package.name)
        : clause.namedChildren().at(-1)
      : null;
    const out: FileDecls = {
      packageName: named?.text().replace(/\s+/g, "") ?? "?",
      packaged: named !== null && named !== undefined,
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
      impls: [],
    };
    /** The type parameters of the functions around a hanging body, by the name of the body. */
    const paramsOf = new Map<string, ReadonlyMap<string, TypeRef | null>>();
    walkDeclarations(this.pack, root, ({ node: d, owner, body: hanging, impl: viaImpl }) => {
      this.owner = owner;
      const around = paramsOf.get(owner ?? "") ?? new Map<string, TypeRef | null>();
      this.tparams = around;
      if (hanging) {
        const host = hanging.host;
        this.tparams = new Map([...around, ...this.typeBounds(host, this.rule(host, owner)?.generics)]);
        paramsOf.set(hanging.name, this.tparams);
        out.types.push(this.hangingDecl(d, hanging, owner));
        return;
      }
      const kind = d.kind();
      const start = d.range().start.index;
      const block = implRule(this.pack, d);
      if (block) {
        // The type and the interface a block of members names are read where the block's own type parameters are not types.
        this.tparams = this.typeBounds(d, block.generics);
        const type = d.field(block.type);
        const interfaceType = d.field(block.interface);
        // A block for a reference to a type, or for any other type that wraps one, is not a block of the wrapped type.
        const wraps = type && (this.typing.type.fielded ?? []).some((f) => f.kind === type.kind());
        out.impls.push({
          type:
            wraps || (type && this.typing.type.wrappers.includes(type.kind())) ? null : this.typeRef(type),
          interface: interfaceType ? this.typeRef(interfaceType) : null,
          line: d.range().start.line + 1,
        });
        this.tparams = new Map();
        return;
      }
      const rule = this.rule(d, owner);
      if (rule)
        this.tparams = new Map([...around, ...this.implParams(d), ...this.typeBounds(d, rule.generics)]);
      const fn = owner === null ? n.function.find((r) => r.kind === kind) : undefined;
      const bodied = bodiedRule(this.pack, kind);
      if (rule && fn) {
        const name = d.field(fn.name)?.text();
        if (name && !t.unnamed.includes(name))
          out.funcs.push({
            name,
            results: this.resultsOf(d, fn.result),
            start,
            arity: this.arityOf(d, fn),
            tparams: this.typeParams(d, fn.generics),
            ...(this.isOverload(d) ? { overload: true as const } : {}),
          });
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
            owner: viaImpl ? null : owner,
            results: this.resultsOf(d, rule.result),
            start,
            arity: this.arityOf(d, rule),
            tparams: this.typeParams(d, rule.generics),
            ...(this.isOverload(d) ? { overload: true as const } : {}),
            ...this.extensionOf(d, rule),
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
        // A declaration that is itself a spec (an assignment statement) is its own spec.
        const specs = t.vars.specs.includes(kind) ? [d] : specsOf(d, t.vars.specs, n.values.groups);
        for (const s of specs) {
          const names = s.fieldChildren(n.values.name).filter((x) => n.values.nameKinds.includes(x.kind()));
          const list = s.field(t.vars.value);
          const values = list
            ? t.locals.valueLists.includes(list.kind())
              ? list.namedChildren()
              : [list]
            : [];
          const type = s.field(t.vars.type);
          const byFlow = !type && t.flow?.untyped.includes(s.kind()) === true;
          names.forEach((nm, i) => {
            const name = nm.text();
            if (name === this.pack.tokens.locals.blank) return;
            out.vars.push({
              name,
              declared: type ? { type: this.typeRef(type) } : null,
              value: values.length === names.length ? this.expr(values[i] ?? null) : null,
              ...(byFlow ? { flow: true as const } : {}),
            });
          });
        }
      }
    });
    this.owner = null;
    this.tparams = new Map();
    this.shadow = new Set();
    if (n.types.impls?.nested && n.import.submodules) this.nestedMethods(root, n.import.submodules, out);
    return out;
  }

  /**
   * The methods of the blocks of members (`types.impls.nested`) that sit in modules written in place, at any depth below
   * `node`: methods with no symbol, of the type the block names, which is the last name of a qualified one. They are the
   * methods of a type that no block outside such a module shows, so a call that one of them could mean is not certain.
   */
  private nestedMethods(
    node: SyntaxNode,
    module: NonNullable<LanguagePack["nodes"]["import"]["submodules"]>,
    out: FileDecls,
    inside = false,
  ): void {
    const n = this.pack.nodes;
    const unknown = n.types.impls?.baseType.unknown ?? "";
    for (const c of node.namedChildren()) {
      if (c.kind() === module.kind) {
        const body = c.field(module.body);
        if (body) this.nestedMethods(body, module, out, true);
        continue;
      }
      const impl = inside ? implRule(this.pack, c) : undefined;
      if (!impl) continue;
      const type = c.field(impl.type);
      const qualified = this.typing.type.qualified;
      let owner = baseTypeName(impl.baseType, type);
      if (owner === unknown && qualified && type?.kind() === qualified.kind)
        owner = type.field(qualified.name)?.text() ?? unknown;
      if (owner === unknown || parameterNames(this.pack, c.field(impl.generics)).includes(owner)) continue;
      for (const m of c.field(impl.body)?.namedChildren() ?? []) {
        const rule = n.method.find((r) => r.kind === m.kind() && !r.receiver);
        const name = rule ? m.field(rule.name)?.text() : undefined;
        if (rule && name)
          out.methods.push({
            key: `${owner}.${name}`,
            owner: null,
            results: [],
            start: m.range().start.index,
            arity: this.arityOf(m, rule),
            tparams: [],
          });
      }
    }
  }

  /** A type declaration with nothing read yet; the type around it is the one being read (`this.owner`). */
  private emptyDecl(name: string, line: number, start: number, generic: boolean, params: string[]): TypeDecl {
    return {
      name,
      kind: "other",
      line,
      start,
      generic,
      outer: this.owner,
      params,
      fields: new Map(),
      embedded: [],
      supers: [],
      bases: 0,
      opaque: false,
      methods: new Map(),
      embeds: [],
      open: false,
      target: null,
      attrs: new Map(),
    };
  }

  /**
   * The assignments to attributes of the instance in the initializer of the type whose body is `body` (flow facts): by
   * attribute name, what each assignment declares or assigns, with the names the initializer declares, in which a value
   * is read.
   */
  private attributes(body: SyntaxNode, name: string): Map<string, FlowAttr[]> {
    const out = new Map<string, FlowAttr[]>();
    const flow = this.typing.flow;
    const initializer = this.typing.construction?.initializer;
    if (!flow || initializer === undefined) return out;
    for (const m of membersOf(this.pack, body)) {
      const rule = this.rule(m, name);
      if (!rule || m.field(rule.name)?.text() !== initializer) continue;
      const code = rule.body ? m.field(rule.body) : null;
      if (!code) continue;
      const decls = this.scopeOf(m, name, []);
      for (const a of code.findAll({ rule: { kind: flow.attribute.kind } })) {
        const target = a.field(flow.attribute.target);
        const access = flow.attribute.access;
        if (target?.kind() !== access.kind || target.field(access.object)?.text() !== flow.self) continue;
        const attr = target.field(access.name)?.text();
        if (!attr) continue;
        const type = a.field(flow.attribute.type);
        const list = out.get(attr) ?? [];
        list.push({
          type: type ? this.typeRef(type) : null,
          typed: type !== null,
          value: type ? null : this.expr(a.field(flow.attribute.value)),
          decls,
        });
        out.set(attr, list);
      }
    }
    this.fn = null;
    this.tparams = new Map();
    return out;
  }

  /** A type with a body of members: its fields and the supertypes its declaration names. `owner` is the type around it. */
  private bodiedDecl(node: SyntaxNode, as: string, name: string, owner: string | null): TypeDecl {
    const t = this.typing;
    const start = node.range().start;
    const decl = this.emptyDecl(
      name,
      start.line + 1,
      start.index,
      this.genericList(node, t.generics) !== null,
      this.typeParams(node, t.generics),
    );
    decl.kind = as === "interface" ? "interface" : "class";
    // The supertypes are written where the declaration is, not inside its body.
    for (const s of t.supertypes) {
      const holders = s.field
        ? node.fieldChildren(s.field)
        : node.namedChildren().filter((c) => c.kind() === s.kind);
      for (const h of holders) {
        for (const ty of this.typesIn(h))
          decl.supers.push({ type: this.typeRef(ty), edge: s.edge, line: ty.range().start.line + 1 });
        for (const e of h.namedChildren()) {
          if (this.pack.tokens.comments.includes(e.kind())) continue;
          if (s.keywords?.includes(e.kind())) decl.opaque = true;
          else decl.bases++;
        }
      }
    }
    if (t.decorators && node.parent()?.kind() === t.decorators.wrapper) decl.opaque = true;
    const part = this.pack.nodes.types.partial;
    if (part && node.children().some((c) => c.kind() === part.node && c.text() === part.keyword))
      decl.partial = true;
    const rule = bodiedRule(this.pack, node.kind());
    const body = rule ? node.field(rule.body) : null;
    this.owner = name;
    for (const m of body ? membersOf(this.pack, body) : []) {
      if (!t.members.entries.includes(m.kind())) continue;
      const { type: mt, names } = this.memberOf(m);
      if (!mt) continue;
      for (const nm of names) decl.fields.set(nm, this.typeRef(mt));
    }
    if (body) decl.attrs = this.attributes(body, name);
    this.owner = owner;
    return decl;
  }

  /**
   * A hanging body (spec section 7): a type of its own with the fields its body declares, extending the type its creating
   * expression names, or, for an element of an enumeration, the enumeration. No symbol stands for it, so the offset
   * `start` of the node that makes it names none and it makes no `extends` edge.
   */
  private hangingDecl(creator: SyntaxNode, h: HangingBody, owner: string | null): TypeDecl {
    const t = this.typing;
    const start = creator.range().start;
    const decl = this.emptyDecl(h.name, start.line + 1, start.index, false, []);
    decl.kind = "class";
    const sup: TypeRef | null = h.type ? this.typeRef(h.type) : owner ? { k: "name", name: owner } : null;
    decl.supers.push({ type: sup, edge: "extends", line: start.line + 1 });
    this.owner = h.name;
    for (const m of membersOf(this.pack, h.node)) {
      if (!t.members.entries.includes(m.kind())) continue;
      const { type: mt, names } = this.memberOf(m);
      if (!mt) continue;
      for (const nm of names) decl.fields.set(nm, this.typeRef(mt));
    }
    this.owner = owner;
    return decl;
  }

  /** The type and the names a member entry declares (see `typing.members`). */
  private memberOf(m: SyntaxNode): { type: SyntaxNode | null; names: string[] } {
    const t = this.typing.members;
    const held = t.holder ? m.namedChildren().find((c) => c.kind() === t.holder) : undefined;
    const declared = held
      ? held.namedChildren().filter((x) => t.nameKinds.includes(x.kind()))
      : m.fieldChildren(t.name).filter((x) => t.nameKinds.includes(x.kind()));
    const names: string[] = [];
    for (const x of declared) {
      // A name that has the declarator's field is a declarator. Outside a holder (whose other children, the type among them, are no names), a plain name (no children) is the name itself.
      const id = t.declarator
        ? (x.field(t.declarator) ?? (held === undefined && x.children().length === 0 ? x : null))
        : x;
      if (id) names.push(id.text());
    }
    return { type: (held ?? m).field(t.type), names };
  }

  private typeDecl(spec: SyntaxNode, name: string, type: SyntaxNode): TypeDecl {
    const n = this.pack.nodes;
    const t = this.typing;
    const start = spec.range().start;
    const decl = this.emptyDecl(
      name,
      start.line + 1,
      start.index,
      this.genericList(spec, t.generics) !== null,
      this.typeParams(spec, t.generics),
    );
    decl.kind = n.types.aliases.includes(spec.kind()) ? "alias" : "other";
    decl.target = this.typeRef(type);
    if (decl.kind === "alias") return decl;
    if (n.types.class.includes(type.kind())) {
      decl.kind = "class";
      const list = type.namedChildren().find((c) => c.kind() === t.members.container);
      for (const m of list?.namedChildren() ?? []) {
        if (!t.members.entries.includes(m.kind())) continue;
        const { type: mt, names } = this.memberOf(m);
        if (!mt) continue;
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

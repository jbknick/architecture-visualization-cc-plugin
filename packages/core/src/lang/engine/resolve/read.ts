import type { SyntaxNode } from "../grammar.js";
import type { DeclarationRule, LanguagePack, TypingRules } from "../pack.js";
import { baseTypeName, rawImportsOf, specsOf } from "../parse.js";
import {
  bodiedName,
  bodiedRule,
  type HangingBody,
  hangingRanges,
  membersOf,
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
  /** The type parameters of the function being read and of the functions around it: a name among them is no type. */
  private tparams: readonly string[] = [];

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
      if (t.wrappers.includes(k)) b = b.namedChildren()[0] ?? null;
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
      if (!args && this.tparams.includes(name)) return { k: "name", name, param: true };
      return { k: "name", name, owner: this.owner, ...(args ? { args } : {}) };
    }
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

  /** The result types of a function or method: none are read for a declaration whose result is a deferred value. */
  private resultsOf(decl: SyntaxNode, field: string): Results {
    const deferred = this.typing.deferred;
    if (deferred && decl.children().some((c) => c.kind() === deferred)) return [];
    return this.results(decl, field);
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
    if (this.typing.enclosing?.self.includes(kind)) return { k: "self", ...this.bodyOf(x) };
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
      return { k: "name", name: fn.text(), pos: fn.range().start.index, line, ...this.bodyOf(fn) };
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

  /** Sets the function the expressions read next sit in (a lookup by place reads inside a function of a type); null for none. */
  setFunction(f: FunctionNode | null): void {
    this.owner = f?.owner ?? null;
    this.fn = f?.node ?? null;
    this.tparams = f ? this.paramsIn(f.node, f.owner, f.hosts) : [];
  }

  /** The type parameters in scope in a member of a type body: its own and those of the members the bodies around it were created in. */
  private paramsIn(node: SyntaxNode, owner: string | null, hosts: readonly Host[]): string[] {
    return [...hosts, { node, owner }].flatMap((h) =>
      this.typeParams(h.node, this.rule(h.node, h.owner)?.generics),
    );
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

  /** The names of the type parameters a declaration holds in the field `field`. */
  private typeParams(d: SyntaxNode, field: string | undefined): string[] {
    const p = this.typing.type.parameters;
    const list = field ? d.field(field) : null;
    if (!p || !list) return [];
    return list
      .namedChildren()
      .filter((c) => c.kind() === p.entry)
      .flatMap((c) => {
        const name = c.namedChildren().find((x) => p.names.includes(x.kind()));
        return name ? [name.text()] : [];
      });
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
    const add = (name: string, pos: number, source: DeclSource, byFlow?: DeclSource): void => {
      if (name !== blank) out.push({ name, pos, source, ...(byFlow ? { flow: byFlow } : {}) });
    };
    const fnStart = fd.range().start.index;
    const fnEnd = fd.range().end.index;
    for (const d of fd.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })) {
      const kind = d.kind();
      const start = d.range().start.index;
      if (inside(skip, start)) continue;
      const end = d.range().end.index;
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
        const list = d.field(decl.values);
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
          if (byFlow) add(n.text(), at(decl.from), { k: "opaque" }, source);
          else add(n.text(), at(decl.from), source);
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

  /** The package name, imports, functions, methods, types and variables a file declares. */
  declarations(root: SyntaxNode): FileDecls {
    const n = this.pack.nodes;
    const t = this.typing;
    const clause = t.package.clause
      ? root.namedChildren().find((c) => c.kind() === t.package.clause)
      : undefined;
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
    /** The type parameters of the functions around a hanging body, by the name of the body. */
    const paramsOf = new Map<string, string[]>();
    walkDeclarations(this.pack, root, ({ node: d, owner, body: hanging }) => {
      this.owner = owner;
      const around = paramsOf.get(owner ?? "") ?? [];
      this.tparams = around;
      if (hanging) {
        const host = hanging.host;
        this.tparams = [...around, ...this.typeParams(host, this.rule(host, owner)?.generics)];
        paramsOf.set(hanging.name, [...this.tparams]);
        out.types.push(this.hangingDecl(d, hanging, owner));
        return;
      }
      const kind = d.kind();
      const start = d.range().start.index;
      const rule = this.rule(d, owner);
      if (rule) this.tparams = [...around, ...this.typeParams(d, rule.generics)];
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
            owner,
            results: this.resultsOf(d, rule.result),
            start,
            arity: this.arityOf(d, rule),
            tparams: this.typeParams(d, rule.generics),
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
    this.tparams = [];
    return out;
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
    if (!flow) return out;
    for (const m of membersOf(this.pack, body)) {
      const rule = this.rule(m, name);
      if (!rule || m.field(rule.name)?.text() !== flow.initializer) continue;
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
    this.tparams = [];
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
      node.field(t.generics) !== null,
      this.typeParams(node, t.generics),
    );
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
    const decl = this.emptyDecl(
      name,
      start.line + 1,
      start.index,
      spec.field(t.generics) !== null,
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

import type { SyntaxNode } from "../grammar.js";
import type { DeclarationRule, LanguagePack, TypingRules } from "../pack.js";
import { baseTypeName, rawImportsOf, specsOf } from "../parse.js";
import type {
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

/**
 * Turns the tree of a file into plain data (`typing.ts`) with the node kinds and fields a pack's `typing` names. Every
 * method returns data; no result holds a node.
 */
export class Reader {
  private readonly typing: TypingRules;

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
      else if (k === t.generic.kind) b = b.field(t.generic.field);
      else break;
    }
    if (!b) return null;
    const k = b.kind();
    if (t.names.includes(k)) return { k: "name", name: b.text() };
    if (k === t.qualified.kind)
      return {
        k: "qual",
        qualifier: b.field(t.qualified.qualifier)?.text() ?? "",
        name: b.field(t.qualified.name)?.text() ?? "",
      };
    const seq = t.sequences.find((s) => s.kind === k);
    if (seq) return { k: "seq", elem: this.typeRef(b.field(seq.element), depth + 1) };
    if (k === t.maps.kind)
      return {
        k: "map",
        key: this.typeRef(b.field(t.maps.key), depth + 1),
        elem: this.typeRef(b.field(t.maps.value), depth + 1),
      };
    return null;
  }

  /** Result types of a declaration: the result field is one type, or a list with one entry per name (at least one). */
  private results(decl: SyntaxNode, field: string): Results {
    const r = decl.field(field);
    if (!r) return [];
    const rule = this.typing.results;
    if (r.kind() !== rule.list) return [this.typeRef(r)];
    const out: Results = [];
    for (const p of r.namedChildren()) {
      const t = p.field(rule.type);
      if (!t) continue;
      const names = p.fieldChildren(rule.name).filter((n) => rule.nameKinds.includes(n.kind())).length;
      for (let i = 0; i < Math.max(1, names); i++) out.push(this.typeRef(t));
    }
    return out;
  }

  // --- expressions --------------------------------------------------------------------------

  /** An expression as far as its type is read; null for a form that is not read. */
  expr(node: SyntaxNode | null, depth = 0): Expr | null {
    const x = unparen(this.typing, node);
    if (!x || depth > MAX_DEPTH) return null;
    const e = this.typing.expressions;
    const kind = x.kind();
    if (this.pack.nodes.call.includes(kind) || kind === this.typing.conversion.kind)
      return { k: "call", call: this.call(x, depth + 1) };
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
            : fn.field(t.type.generic.field),
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
      return {
        k: "member",
        operand: this.operand(fn.field(member.operand), depth + 1),
        name: nameNode?.text() ?? "",
        line: (nameNode ?? fn).range().start.line + 1,
      };
    }
    return { k: "none", line };
  }

  /** A call site (or a conversion written as one). */
  private call(x: SyntaxNode, depth: number): CallExpr {
    const t = this.typing;
    const isConversion = x.kind() === t.conversion.kind;
    const fnNode = isConversion ? x.field(t.conversion.type) : x.field(this.pack.nodes.callee.field);
    const callee = this.callee(fnNode, x, true, depth);
    const raw = unparen(t, fnNode);
    const builtin = !isConversion && raw !== null && t.expressions.names.includes(raw.kind());
    let first: CallExpr["first"] = null;
    if (builtin && (t.builtins.typed.includes(raw.text()) || t.builtins.first.includes(raw.text()))) {
      const arg = x.field(t.builtins.arguments)?.namedChildren()[0] ?? null;
      if (arg) first = { type: this.typeRef(arg), expr: this.expr(arg, depth + 1) };
    }
    return { callee, builtin, first };
  }

  /** The callee of the function, or of a function named without a call, at a node (`targetAt`). */
  calleeAt(node: SyntaxNode): Callee {
    const isCall = this.pack.nodes.call.includes(node.kind()) || node.kind() === this.typing.conversion.kind;
    if (!isCall) return this.callee(node, node, false, 0);
    return this.call(node, 0).callee;
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
        const typeNode = decl.type ? d.field(decl.type) : null;
        const values = (d.field(decl.values)?.namedChildren() ?? []).map((v) => this.expr(v));
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
    const any = [
      ...this.pack.nodes.call.map((kind) => ({ kind })),
      { kind: t.conversion.kind, has: { field: t.conversion.type, kind: t.type.generic.kind } },
    ];
    return body.findAll({ rule: { any } }).map((site) => ({
      call: this.call(site, 0),
      line: site.range().start.line + 1,
    }));
  }

  /** A top-level function or method declaration of the pack (the rule it matches), or undefined. */
  rule(d: SyntaxNode): DeclarationRule | undefined {
    const kind = d.kind();
    return (
      this.pack.nodes.function.find((r) => r.kind === kind) ??
      this.pack.nodes.method.find((r) => r.kind === kind)
    );
  }

  /** The functions and methods of a file with their bodies' declarations and call sites. */
  bodies(root: SyntaxNode): FunctionBody[] {
    const out: FunctionBody[] = [];
    for (const d of root.namedChildren()) {
      const rule = this.rule(d);
      const body = rule?.body ? d.field(rule.body) : null;
      if (!rule || !body) continue;
      out.push({ start: d.range().start.index, decls: this.decls(d), calls: this.calls(body) });
    }
    return out;
  }

  /** The declarations and calls of the top-level function or method that holds the offset range; null when none does. */
  scopeAt(root: SyntaxNode, start: number, end: number): Decl[] | null {
    for (const d of root.namedChildren()) {
      if (!this.rule(d)) continue;
      const r = d.range();
      if (r.start.index <= start && end <= r.end.index) return this.decls(d);
    }
    return null;
  }

  // --- declarations -------------------------------------------------------------------------

  /** The package name, imports, functions, methods, types and variables a file declares. */
  declarations(root: SyntaxNode): FileDecls {
    const n = this.pack.nodes;
    const t = this.typing;
    const out: FileDecls = {
      packageName:
        root
          .namedChildren()
          .find((c) => c.kind() === t.package.clause)
          ?.namedChildren()[0]
          ?.text() ?? "?",
      imports: rawImportsOf(this.pack, root).map((i) => ({ alias: i.alias, specifier: i.specifier })),
      funcs: [],
      methods: [],
      types: [],
      vars: [],
    };
    for (const d of root.namedChildren()) {
      const kind = d.kind();
      const fn = n.function.find((r) => r.kind === kind);
      const method = n.method.find((r) => r.kind === kind);
      if (fn) {
        const name = d.field(fn.name)?.text();
        if (name && !t.unnamed.includes(name)) out.funcs.push({ name, results: this.results(d, fn.result) });
      } else if (method) {
        const name = d.field(method.name)?.text();
        const recv = (method.receiver ? d.field(method.receiver) : null)
          ?.namedChildren()
          .find((c) => c.kind() === n.receiver.parameter);
        const base = baseTypeName(n.receiver.baseType, recv?.field(n.receiver.type) ?? null);
        if (name && recv)
          out.methods.push({ key: `${base}.${name}`, results: this.results(d, method.result) });
      } else if (n.types.declarations.includes(kind)) {
        for (const s of specsOf(d, n.types.specs, n.types.groups)) {
          const name = s.field(n.types.name)?.text();
          const type = s.field(n.types.type);
          if (name && type) out.types.push(this.typeDecl(s, name, type));
        }
      } else if (t.vars.declarations.includes(kind)) {
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
    }
    return out;
  }

  private typeDecl(spec: SyntaxNode, name: string, type: SyntaxNode): TypeDecl {
    const n = this.pack.nodes;
    const t = this.typing;
    const decl: TypeDecl = {
      name,
      kind: n.types.aliases.includes(spec.kind()) ? "alias" : "other",
      line: spec.range().start.line + 1,
      generic: spec.field(t.generics) !== null,
      fields: new Map(),
      embedded: [],
      methods: new Map(),
      embeds: [],
      open: false,
      target: this.typeRef(type),
    };
    if (decl.kind === "alias") return decl;
    if (n.types.class.includes(type.kind())) {
      decl.kind = "class";
      const list = type.namedChildren().find((c) => c.kind() === t.members.container);
      for (const m of list?.namedChildren() ?? []) {
        if (!t.members.entries.includes(m.kind())) continue;
        const mt = m.field(t.members.type);
        if (!mt) continue;
        const names = m.fieldChildren(t.members.name).filter((x) => t.members.nameKinds.includes(x.kind()));
        if (names.length === 0)
          decl.embedded.push({ type: this.typeRef(mt), line: mt.range().start.line + 1 });
        for (const nm of names) decl.fields.set(nm.text(), this.typeRef(mt));
      }
    } else if (n.types.interface.includes(type.kind())) {
      decl.kind = "interface";
      const im = n.types.interfaceMethods;
      for (const c of type.namedChildren()) {
        if (im.members.includes(c.kind())) {
          const mn = c.field(im.rule.name)?.text();
          if (mn) decl.methods.set(mn, this.results(c, im.rule.result));
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

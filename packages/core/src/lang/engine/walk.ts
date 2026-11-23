import type { SyntaxNode } from "./grammar.js";
import type { BaseTypeRule, BodiedTypeRule, LanguagePack } from "./pack.js";

/** Base type name of a receiver or type expression: `*S[T]` -> `S`. The pack's `unknown` when the shape is not recognised. */
export function baseTypeName(rule: BaseTypeRule, n: SyntaxNode | null): string {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (rule.names.includes(k)) return cur.text();
    if (rule.wrappers.includes(k)) cur = cur.namedChildren()[0] ?? null;
    else if (k === rule.generic.kind) cur = cur.field(rule.generic.field);
    else return rule.unknown;
  }
  return rule.unknown;
}

/** The names of the type parameters a list of them holds (`typing.type.parameters`); none for a pack without the rule. */
export function parameterNames(pack: LanguagePack, list: SyntaxNode | null): string[] {
  const p = pack.nodes.typing?.type.parameters;
  if (!p || !list) return [];
  return list.namedChildren().flatMap((c) => {
    if (p.bare?.includes(c.kind())) return [c.text()];
    if (c.kind() !== p.entry) return [];
    const name = c.namedChildren().find((x) => p.names.includes(x.kind()));
    return name ? [name.text()] : [];
  });
}

/** The rule of a block of members of a type declared elsewhere, when the node is one. */
export const implRule = (
  pack: LanguagePack,
  node: SyntaxNode,
): NonNullable<LanguagePack["nodes"]["types"]["impls"]> | undefined => {
  const rule = pack.nodes.types.impls;
  return rule && rule.kind === node.kind() ? rule : undefined;
};

/** The name of the type a block of members belongs to; `unknown` when it is not read or is one of the block's own type parameters. */
export function implOwner(pack: LanguagePack, node: SyntaxNode): string {
  const rule = pack.nodes.types.impls;
  if (!rule) return "";
  const base = baseTypeName(rule.baseType, node.field(rule.type));
  return parameterNames(pack, node.field(rule.generics)).includes(base) ? rule.baseType.unknown : base;
}

/**
 * A body of members that no declaration of a type holds: the body of an expression that creates a value of a type
 * (`new T() { ... }`) or of an element of an enumeration (`RED { ... }`).
 */
export interface HangingBody {
  /** The dotted name of the type the body makes (`Outer.make.$1`, `Color.RED`); the members of the body have it as owner. */
  name: string;
  /** The node that holds the members. */
  node: SyntaxNode;
  /** The member of the enclosing type the body hangs from. */
  host: SyntaxNode;
  /** The node that names the type the body extends; null for an element of an enumeration, which extends the enumeration. */
  type: SyntaxNode | null;
}

/** A node of a declaration walk and where it sits. */
export interface Found {
  node: SyntaxNode;
  /** The dotted name of the type whose body holds the node (`Outer.Inner`); null for a node at the top of the file. */
  owner: string | null;
  /** The kind of the body node that holds it; null at the top of the file. */
  container: string | null;
  /** True for a node inside a hanging body, at any depth. */
  anonymous: boolean;
  /** Set when the node is the expression or element that makes a hanging body; its members follow. */
  body?: HangingBody;
  /** True for a member of a block of members of a type declared elsewhere (`types.impls`): the owner is that type's name, which no body of this file holds. */
  impl?: true;
}

/** The rule of a bodied type declaration of this kind. */
export const bodiedRule = (pack: LanguagePack, kind: string): BodiedTypeRule | undefined =>
  pack.nodes.types.bodied.find((r) => r.kind === kind);

/** The dotted name of a bodied type declaration inside `owner`. */
export function bodiedName(rule: BodiedTypeRule, node: SyntaxNode, owner: string | null): string | null {
  const name = node.field(rule.name)?.text();
  if (!name) return null;
  return owner ? `${owner}.${name}` : name;
}

/** The members of a type body, also those inside a body kind the pack walks through. */
export function membersOf(pack: LanguagePack, body: SyntaxNode, into: SyntaxNode[] = []): SyntaxNode[] {
  const through = pack.nodes.types.bodies;
  for (const c of body.namedChildren()) {
    if (through.includes(c.kind())) membersOf(pack, c, into);
    else into.push(c);
  }
  return into;
}

const same = (a: SyntaxNode, b: SyntaxNode): boolean =>
  a.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index;

const holds = (outer: SyntaxNode, inner: SyntaxNode): boolean =>
  outer.range().start.index <= inner.range().start.index &&
  inner.range().end.index <= outer.range().end.index;

/** A hanging body in a member and the node that makes it. */
export interface HangingFound {
  creator: SyntaxNode;
  body: SyntaxNode;
  constant: boolean;
}

/**
 * The hanging bodies of a member of a type body, in source order, outermost only: the body of the member itself when it
 * is an element of an enumeration that has one, and the body of each creating expression inside it that is not inside
 * another body (a body inside one is found when the members of that body are walked; one inside a type declared in a
 * method is not walked at all).
 */
export function hangingBodies(pack: LanguagePack, member: SyntaxNode): HangingFound[] {
  const { anonymous, constants } = pack.nodes.types;
  if (!anonymous && !constants) return [];
  const out: HangingFound[] = [];
  const constBody = constants && member.kind() === constants.kind ? member.field(constants.body) : null;
  if (constBody) out.push({ creator: member, body: constBody, constant: true });
  if (!anonymous) return out;
  for (const c of member.findAll({ rule: { kind: anonymous.kind } })) {
    const body = c.namedChildren().find((x) => x.kind() === anonymous.body);
    if (!body) continue;
    let inside = false;
    for (let p = c.parent(); p && !same(p, member); p = p.parent()) {
      if (p.kind() === anonymous.body || bodiedRule(pack, p.kind()) || (constBody && same(p, constBody))) {
        inside = true;
        break;
      }
    }
    if (!inside) out.push({ creator: c, body, constant: false });
  }
  return out;
}

/** The source ranges `[start, end)` of the hanging bodies of a member: code in them belongs to their own members. */
export function hangingRanges(pack: LanguagePack, member: SyntaxNode): { start: number; end: number }[] {
  return hangingBodies(pack, member).map((h) => {
    const r = h.body.range();
    return { start: r.start.index, end: r.end.index };
  });
}

/**
 * The name a member of a type body gives to the bodies created in it: the name of a method, of an element of an
 * enumeration, or of the field whose declarator holds the creating expression; null for a member without a name (an
 * initializer block).
 */
function memberName(pack: LanguagePack, member: SyntaxNode, creator: SyntaxNode): string | null {
  const n = pack.nodes;
  const kind = member.kind();
  const method = n.method.find((r) => r.kind === kind && !r.receiver);
  if (method) return member.field(method.name)?.text() ?? null;
  const constant = n.types.constants;
  if (constant && kind === constant.kind) return member.field(constant.name)?.text() ?? null;
  const fields = n.typing?.members;
  if (fields?.entries.includes(kind)) {
    for (const d of member.fieldChildren(fields.name)) {
      if (!fields.nameKinds.includes(d.kind()) || !holds(d, creator)) continue;
      return (fields.declarator ? d.field(fields.declarator) : d)?.text() ?? null;
    }
  }
  return null;
}

/**
 * Visits every child of the file root and, through the pack's bodied types, every member of each type body (a type
 * before its members, in source order), with the dotted name of the type around it. A body kind the pack lists is walked
 * through: its children are members of the same type (or declarations of the top of the file). A hanging body (`types.anonymous`, `types.constants`) is visited
 * right after the member it hangs from: first the node that makes it (with `body` set), then its members, whose owner is
 * the name of the body. The body of an element of an enumeration is named `<type>.<element>`. The body of a creating
 * expression is named after the member that holds the expression, `<type>.<member>.<prefix><n>`, with `n` counting from 1
 * in source order within that member; a method that shares its name with an earlier one of the type is `<member>~2`,
 * `~3`, as its symbol is, and a member without a name gives `<type>.<prefix><n>`, counted over such members of the type.
 */
export function walkDeclarations(pack: LanguagePack, root: SyntaxNode, visit: (f: Found) => void): void {
  const through = new Set(pack.nodes.types.bodies);
  const { anonymous, constants } = pack.nodes.types;
  /** How many bodies each name has given so far. */
  const counts = new Map<string, number>();
  /** How many declarations (methods, types) each dotted name has had so far, as the symbol ids count them. */
  const seen = new Map<string, number>();
  const descend = (node: SyntaxNode, owner: string | null, inBody: boolean): void => {
    const impl = implRule(pack, node);
    if (impl) {
      const block = node.field(impl.body);
      if (block) members(block, implOwner(pack, node), block.kind(), inBody, true);
      return;
    }
    const rule = bodiedRule(pack, node.kind());
    if (!rule) return;
    const name = bodiedName(rule, node, owner);
    const body = node.field(rule.body);
    if (name && body) members(body, name, body.kind(), inBody);
  };
  /** The `~n` a declaration's symbol id carries: empty for the first of its name. */
  const repeat = (node: SyntaxNode, owner: string | null): string => {
    const kind = node.kind();
    const bodied = bodiedRule(pack, kind);
    const method = pack.nodes.method.find((r) => r.kind === kind && !r.receiver);
    const name = bodied ? node.field(bodied.name)?.text() : method ? node.field(method.name)?.text() : null;
    if (!name || (!bodied && owner === null)) return "";
    const key = owner ? `${owner}.${name}` : name;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? "" : `~${n}`;
  };
  const hang = (
    member: SyntaxNode,
    owner: string,
    container: string,
    suffix: string,
    inBody: boolean,
  ): void => {
    for (const h of hangingBodies(pack, member)) {
      let name: string;
      if (h.constant) {
        const n = constants ? h.creator.field(constants.name)?.text() : undefined;
        if (!n) continue;
        name = `${owner}.${n}`;
      } else {
        const label = memberName(pack, member, h.creator);
        const base = label ? `${owner}.${label}${suffix}` : owner;
        const count = (counts.get(base) ?? 0) + 1;
        counts.set(base, count);
        name = `${base}.${anonymous?.prefix ?? ""}${count}`;
      }
      const type = h.constant || !anonymous ? null : h.creator.field(anonymous.type);
      visit({
        node: h.creator,
        owner,
        container,
        anonymous: inBody,
        body: { name, node: h.body, host: member, type },
      });
      members(h.body, name, h.body.kind(), true);
    }
  };
  const members = (
    body: SyntaxNode,
    owner: string,
    container: string,
    inBody: boolean,
    viaImpl = false,
  ): void => {
    for (const c of body.namedChildren()) {
      if (through.has(c.kind())) {
        members(c, owner, c.kind(), inBody, viaImpl);
        continue;
      }
      const suffix = repeat(c, owner);
      visit({ node: c, owner, container, anonymous: inBody, ...(viaImpl ? { impl: true as const } : {}) });
      if (bodiedRule(pack, c.kind()) || implRule(pack, c)) descend(c, owner, inBody);
      else hang(c, owner, container, suffix, inBody);
    }
  };
  // A body kind the pack walks through is walked through at the top of the file too (a decorated declaration).
  const top = (parent: SyntaxNode): void => {
    for (const c of parent.namedChildren()) {
      if (through.has(c.kind())) {
        top(c);
        continue;
      }
      repeat(c, null);
      visit({ node: c, owner: null, container: null, anonymous: false });
      descend(c, null, false);
    }
  };
  top(root);
}

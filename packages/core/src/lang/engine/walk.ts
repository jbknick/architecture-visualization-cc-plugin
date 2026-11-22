import type { SyntaxNode } from "./grammar.js";
import type { BodiedTypeRule, LanguagePack } from "./pack.js";

/**
 * A body of members that no declaration of a type holds: the body of an expression that creates a value of a type
 * (`new T() { ... }`) or of an element of an enumeration (`RED { ... }`).
 */
export interface HangingBody {
  /** The dotted name of the type the body makes (`Outer.$1`, `Color.RED`); the members of the body have it as owner. */
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
  /** Set when the node is the expression or element that makes a hanging body; its members follow. */
  body?: HangingBody;
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
 * Visits every child of the file root and, through the pack's bodied types, every member of each type body (a type
 * before its members, in source order), with the dotted name of the type around it. A body kind the pack lists is walked
 * through: its children are members of the same type. A hanging body (`types.anonymous`, `types.constants`) is visited
 * right after the member it hangs from: first the node that makes it (with `body` set), then its members, whose owner is
 * the name of the body.
 */
export function walkDeclarations(pack: LanguagePack, root: SyntaxNode, visit: (f: Found) => void): void {
  const through = new Set(pack.nodes.types.bodies);
  const { anonymous, constants } = pack.nodes.types;
  const counts = new Map<string, number>();
  const descend = (node: SyntaxNode, owner: string | null): void => {
    const rule = bodiedRule(pack, node.kind());
    if (!rule) return;
    const name = bodiedName(rule, node, owner);
    const body = node.field(rule.body);
    if (name && body) members(body, name, body.kind());
  };
  const hang = (member: SyntaxNode, owner: string, container: string): void => {
    for (const h of hangingBodies(pack, member)) {
      let name: string;
      if (h.constant) {
        const n = constants ? h.creator.field(constants.name)?.text() : undefined;
        if (!n) continue;
        name = `${owner}.${n}`;
      } else {
        const count = (counts.get(owner) ?? 0) + 1;
        counts.set(owner, count);
        name = `${owner}.${anonymous?.prefix ?? ""}${count}`;
      }
      const type = h.constant || !anonymous ? null : h.creator.field(anonymous.type);
      visit({ node: h.creator, owner, container, body: { name, node: h.body, host: member, type } });
      members(h.body, name, h.body.kind());
    }
  };
  const members = (body: SyntaxNode, owner: string, container: string): void => {
    for (const c of body.namedChildren()) {
      if (through.has(c.kind())) {
        members(c, owner, c.kind());
        continue;
      }
      visit({ node: c, owner, container });
      if (bodiedRule(pack, c.kind())) descend(c, owner);
      else hang(c, owner, container);
    }
  };
  for (const c of root.namedChildren()) {
    visit({ node: c, owner: null, container: null });
    descend(c, null);
  }
}

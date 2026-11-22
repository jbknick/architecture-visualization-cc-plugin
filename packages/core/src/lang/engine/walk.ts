import type { SyntaxNode } from "./grammar.js";
import type { BodiedTypeRule, LanguagePack } from "./pack.js";

/** A node of a declaration walk and where it sits. */
export interface Found {
  node: SyntaxNode;
  /** The dotted name of the type whose body holds the node (`Outer.Inner`); null for a node at the top of the file. */
  owner: string | null;
  /** The kind of the body node that holds it; null at the top of the file. */
  container: string | null;
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

/**
 * Visits every child of the file root and, through the pack's bodied types, every member of each type body (a type
 * before its members, in source order), with the dotted name of the type around it. A body kind the pack lists is walked
 * through: its children are members of the same type.
 */
export function walkDeclarations(pack: LanguagePack, root: SyntaxNode, visit: (f: Found) => void): void {
  const through = new Set(pack.nodes.types.bodies);
  const descend = (node: SyntaxNode, owner: string | null): void => {
    const rule = bodiedRule(pack, node.kind());
    if (!rule) return;
    const name = bodiedName(rule, node, owner);
    const body = node.field(rule.body);
    if (name && body) members(body, name, body.kind());
  };
  const members = (body: SyntaxNode, owner: string, container: string): void => {
    for (const c of body.namedChildren()) {
      if (through.has(c.kind())) {
        members(c, owner, c.kind());
        continue;
      }
      visit({ node: c, owner, container });
      descend(c, owner);
    }
  };
  for (const c of root.namedChildren()) {
    visit({ node: c, owner: null, container: null });
    descend(c, null);
  }
}

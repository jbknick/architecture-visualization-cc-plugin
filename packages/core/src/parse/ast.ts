/** Minimal generic helpers over oxc's ESTree-compatible (TS-ESTree flavoured) output. */

export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** Children of a node, in key order (source order for ESTree). */
function* children(node: Node): Generator<unknown> {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "parent" || key === "range") continue;
    const v = node[key];
    if (typeof v === "object" && v !== null) yield v;
  }
}

/**
 * Depth-first walk over a node, an array of nodes, or nested arrays. `cb` is called for every node
 * before its children; returning `false` skips that node's children.
 */
export function visit(root: unknown, cb: (n: Node) => boolean | undefined): void {
  if (Array.isArray(root)) {
    for (const c of root) visit(c, cb);
    return;
  }
  if (!isNode(root)) return;
  if (cb(root) === false) return;
  for (const c of children(root)) visit(c, cb);
}

export function nodeArray(v: unknown): Node[] {
  return Array.isArray(v) ? v.filter(isNode) : [];
}

/** Strip TS-only and grouping wrappers that do not change the runtime value. */
export function unwrap(n: unknown): unknown {
  let cur = n;
  for (let i = 0; i < 32 && isNode(cur); i++) {
    if (
      cur.type === "TSAsExpression" ||
      cur.type === "TSSatisfiesExpression" ||
      cur.type === "TSNonNullExpression" ||
      cur.type === "TSTypeAssertion" ||
      cur.type === "ParenthesizedExpression" ||
      cur.type === "ChainExpression"
    ) {
      cur = cur.expression;
    } else break;
  }
  return cur;
}

/**
 * Dotted name of an identifier / member chain (`a`, `this.x.y`, `c.req.param`), keeping at most the
 * first `max` parts. Returns null for anything else (call results, computed members, literals).
 */
export function chainName(expr: unknown, max = 3): string | null {
  const parts: string[] = [];
  let cur: unknown = expr;
  for (let i = 0; i < 64; i++) {
    cur = unwrap(cur);
    if (!isNode(cur)) return null;
    if (cur.type === "Identifier") {
      parts.push(cur.name as string);
      break;
    }
    if (cur.type === "ThisExpression") {
      parts.push("this");
      break;
    }
    if (cur.type === "Super") {
      parts.push("super");
      break;
    }
    if (cur.type === "MemberExpression" && cur.computed !== true) {
      const p = cur.property;
      if (isNode(p) && (p.type === "Identifier" || p.type === "PrivateIdentifier")) {
        parts.push(p.type === "PrivateIdentifier" ? `#${p.name as string}` : (p.name as string));
        cur = cur.object;
        continue;
      }
      return null;
    }
    return null;
  }
  parts.reverse();
  return parts.slice(0, max).join(".");
}

/** Dotted name of a type name (`Foo`, `ns.Foo`), keeping at most `max` parts. */
export function typeName(n: unknown, max = 3): string | null {
  const parts: string[] = [];
  let cur: unknown = n;
  for (let i = 0; i < 16 && isNode(cur); i++) {
    if (cur.type === "Identifier") {
      parts.push(cur.name as string);
      break;
    }
    if (cur.type === "TSQualifiedName") {
      const r = cur.right;
      if (!isNode(r)) return null;
      parts.push(r.name as string);
      cur = cur.left;
      continue;
    }
    return null;
  }
  if (parts.length === 0) return null;
  parts.reverse();
  return parts.slice(0, max).join(".");
}

/** Dotted name of a JSX element name (`Foo`, `Foo.Bar`); null for namespaced names. */
export function jsxName(n: unknown, max = 3): string | null {
  const parts: string[] = [];
  let cur: unknown = n;
  for (let i = 0; i < 16 && isNode(cur); i++) {
    if (cur.type === "JSXIdentifier") {
      parts.push(cur.name as string);
      break;
    }
    if (cur.type === "JSXMemberExpression") {
      const p = cur.property;
      if (!isNode(p)) return null;
      parts.push(p.name as string);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (parts.length === 0) return null;
  parts.reverse();
  return parts.slice(0, max).join(".");
}

/** Names bound by a binding pattern. */
export function patternNames(p: unknown, into: string[] = []): string[] {
  if (!isNode(p)) return into;
  switch (p.type) {
    case "Identifier":
      into.push(p.name as string);
      break;
    case "ObjectPattern":
      for (const prop of nodeArray(p.properties)) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, into);
      }
      break;
    case "ArrayPattern":
      for (const el of p.elements as unknown[]) patternNames(el, into);
      break;
    case "RestElement":
      patternNames(p.argument, into);
      break;
    case "AssignmentPattern":
      patternNames(p.left, into);
      break;
  }
  return into;
}

/** Line lookup over UTF-16 offsets (the offsets oxc reports for JS strings). */
export class LineTable {
  private readonly starts: number[] = [0];
  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }
  /** 1-based line containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

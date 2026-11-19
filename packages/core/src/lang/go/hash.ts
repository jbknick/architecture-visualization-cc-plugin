import type { TokenStreams } from "../index.js";
import { type GoNode, parseGo } from "./grammar.js";

/**
 * The Go half of the structural fingerprints (spec sections 3 and 7): the walk over the syntax tree of a symbol's
 * source range. Shared code (`hash/`) turns the streams into the five hash values. The exact stream holds node kinds,
 * operators and literal values in source order with locals renamed `$1, $2…` in order of first appearance; the shape
 * stream holds node kinds only, with identifiers, strings and numbers reduced to `ID`, `STR` and `NUM`.
 * Comments never reach either stream.
 */

interface Range {
  start: number;
  end: number;
}

const IDENTIFIER_KINDS = new Set([
  "identifier",
  "field_identifier",
  "type_identifier",
  "package_identifier",
  "label_name",
]);
const STRING_KINDS = new Set(["interpreted_string_literal", "raw_string_literal", "rune_literal"]);
const NUMBER_KINDS = new Set(["int_literal", "float_literal", "imaginary_literal"]);
const PUNCTUATION = new Set(["(", ")", "{", "}", "[", "]", ",", ";"]);

let cache: { source: string; root: GoNode } | null = null;

function rootOf(source: string): GoNode {
  if (cache && cache.source === source) return cache.root;
  const root = parseGo(source);
  cache = { source, root };
  return root;
}

/** The node whose range is exactly `r`: a declaration, or one spec of a grouped declaration. */
function locate(n: GoNode, r: Range): GoNode | null {
  for (const c of n.namedChildren()) {
    const cr = c.range();
    if (cr.start.index === r.start && cr.end.index === r.end) return c;
    if (cr.start.index <= r.start && cr.end.index >= r.end) {
      const found = locate(c, r);
      if (found) return found;
    }
  }
  return null;
}

/** The name the declaration at `node` introduces (a method's own name without its receiver). */
function ownName(node: GoNode): string {
  const n = node.field("name");
  return n ? n.text() : "";
}

/** Names declared inside the node: parameters, results, receivers, `:=`, `var`, `const`, `range` and type-switch bindings. */
function declaredLocals(node: GoNode): Set<string> {
  const names = new Set<string>();
  const add = (n: GoNode | null): void => {
    if (!n) return;
    if (n.kind() === "identifier") {
      if (n.text() !== "_") names.add(n.text());
    } else for (const c of n.namedChildren()) add(c);
  };
  const id = (n: GoNode): string => `${n.range().start.index}:${n.range().end.index}`;
  const self = id(node);
  for (const n of node.findAll({
    rule: { any: [{ kind: "parameter_declaration" }, { kind: "variadic_parameter_declaration" }] },
  }))
    for (const c of n.fieldChildren("name")) add(c);
  for (const n of node.findAll({ rule: { kind: "short_var_declaration" } })) add(n.field("left"));
  for (const n of node.findAll({ rule: { kind: "range_clause" } })) add(n.field("left"));
  for (const n of node.findAll({ rule: { kind: "type_switch_statement" } })) add(n.field("alias"));
  for (const n of node.findAll({ rule: { any: [{ kind: "var_spec" }, { kind: "const_spec" }] } })) {
    if (id(n) === self) continue; // the declaration itself introduces a package-level name, not a local
    for (const c of n.fieldChildren("name")) add(c);
  }
  return names;
}

function analyze(node: GoNode): TokenStreams {
  const exact: string[] = [];
  const shape: string[] = [];
  const selfRefs: number[] = [];
  const locals = declaredLocals(node);
  const numbered = new Map<string, number>();
  const own = ownName(node);
  const walk = (n: GoNode): void => {
    const kind = n.kind();
    if (kind === "comment") return;
    if (!n.isNamed()) {
      if (!PUNCTUATION.has(kind)) exact.push(kind);
      return;
    }
    if (IDENTIFIER_KINDS.has(kind)) {
      const text = n.text();
      if (kind === "identifier" && locals.has(text)) {
        let k = numbered.get(text);
        if (k === undefined) {
          k = numbered.size + 1;
          numbered.set(text, k);
        }
        exact.push(`$${k}`);
      } else {
        if (own !== "" && text === own) selfRefs.push(exact.length);
        exact.push(`I:${text}`);
      }
      shape.push("ID");
      return;
    }
    if (STRING_KINDS.has(kind)) {
      exact.push(`S:${n.text()}`);
      shape.push("STR");
      return;
    }
    if (NUMBER_KINDS.has(kind)) {
      exact.push(`N:${n.text()}`);
      shape.push("NUM");
      return;
    }
    exact.push(kind);
    shape.push(kind);
    for (const c of n.children()) walk(c);
  };
  walk(node);
  return { exact, shape, selfRefs };
}

/** Token streams of the declaration in `range` of Go `source`; empty when no declaration has exactly that range. */
export function goStreams(source: string, range: Range, _path: string): TokenStreams {
  const node = locate(rootOf(source), range);
  return node ? analyze(node) : { exact: [], shape: [], selfRefs: [] };
}

/** Embedding text: the declaration's source with comments dropped and whitespace collapsed. */
export function goEmbeddingText(source: string, range: Range, _path: string): string {
  const node = locate(rootOf(source), range);
  if (!node) return source.slice(range.start, range.end).replace(/\s+/g, " ").trim();
  const comments = node
    .findAll({ rule: { kind: "comment" } })
    .map((c) => ({ start: c.range().start.index, end: c.range().end.index }))
    .sort((a, b) => a.start - b.start);
  let out = "";
  let pos = range.start;
  for (const c of comments) {
    if (c.start < pos) continue;
    out += `${source.slice(pos, c.start)} `;
    pos = c.end;
  }
  out += source.slice(pos, range.end);
  return out.replace(/\s+/g, " ").trim();
}

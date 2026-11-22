import type { TokenStreams } from "../index.js";
import { parseTree, type SyntaxNode } from "./grammar.js";
import type { LanguagePack } from "./pack.js";

/**
 * The structural fingerprints of a pack's language (spec sections 3 and 7): the walk over the syntax tree of a symbol's
 * source range. Shared code (`hash/`) turns the streams into the five hash values. The exact stream holds node kinds,
 * operators and literal values in source order with locals renamed `$1, $2…` in order of first appearance; the shape
 * stream holds node kinds only, with identifiers, strings and numbers reduced to `ID`, `STR` and `NUM`.
 * Comments never reach either stream.
 */

interface Range {
  start: number;
  end: number;
}

/** The tree of the file the last call read: a symbol's streams and its embedding text come from one parse. */
let cache: { pack: string; source: string; root: SyntaxNode } | null = null;

function rootOf(pack: LanguagePack, source: string): SyntaxNode {
  if (cache && cache.pack === pack.id && cache.source === source) return cache.root;
  const root = parseTree(pack, source);
  cache = { pack: pack.id, source, root };
  return root;
}

/** The node whose range is exactly `r`: a declaration, or one spec of a grouped declaration. */
function locate(n: SyntaxNode, r: Range): SyntaxNode | null {
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
function ownName(pack: LanguagePack, node: SyntaxNode): string {
  const n = node.field(pack.tokens.ownName);
  return n ? n.text() : "";
}

/** Names declared inside the node: parameters, results, receivers, bindings, local specs and the like. */
function declaredLocals(pack: LanguagePack, node: SyntaxNode): Set<string> {
  const t = pack.tokens;
  const names = new Set<string>();
  const add = (n: SyntaxNode | null): void => {
    if (!n) return;
    if (n.kind() === t.local) {
      if (n.text() !== t.locals.blank) names.add(n.text());
    } else for (const c of n.namedChildren()) add(c);
  };
  const id = (n: SyntaxNode): string => `${n.range().start.index}:${n.range().end.index}`;
  const self = id(node);
  const p = t.locals.parameters;
  for (const n of node.findAll({ rule: { any: p.kinds.map((kind) => ({ kind })) } }))
    for (const c of n.fieldChildren(p.field)) add(c);
  for (const b of t.locals.bindings)
    for (const n of node.findAll({ rule: { kind: b.kind } })) add(n.field(b.field));
  const s = t.locals.specs;
  for (const n of node.findAll({ rule: { any: s.kinds.map((kind) => ({ kind })) } })) {
    if (id(n) === self) continue; // the declaration itself introduces a package-level name, not a local
    for (const c of n.fieldChildren(s.field)) add(c);
  }
  return names;
}

function analyze(pack: LanguagePack, node: SyntaxNode): TokenStreams {
  const t = pack.tokens;
  const exact: string[] = [];
  const shape: string[] = [];
  const selfRefs: number[] = [];
  const locals = declaredLocals(pack, node);
  const numbered = new Map<string, number>();
  const own = ownName(pack, node);
  const walk = (n: SyntaxNode): void => {
    const kind = n.kind();
    if (t.comments.includes(kind)) return;
    if (!n.isNamed()) {
      if (!t.punctuation.includes(kind)) exact.push(kind);
      return;
    }
    if (t.identifiers.includes(kind)) {
      const text = n.text();
      if (kind === t.local && locals.has(text)) {
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
    if (t.strings.includes(kind)) {
      exact.push(`S:${n.text()}`);
      shape.push("STR");
      return;
    }
    if (t.numbers.includes(kind)) {
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

/** Token streams of the declaration in `range` of `source`; empty when no declaration has exactly that range. */
export function streamsWithPack(pack: LanguagePack, source: string, range: Range): TokenStreams {
  const node = locate(rootOf(pack, source), range);
  return node ? analyze(pack, node) : { exact: [], shape: [], selfRefs: [] };
}

/**
 * Embedding text (spec section 17): the declaration's source with comments dropped, whitespace collapsed, the
 * declaration's own name and the names declared inside it (as for the exact stream) renamed `v1, v2…` in order of
 * first appearance, and string literals replaced by `"s"`. Field, method and package names, and identifiers that are
 * declared outside the declaration, are kept. Without the renaming a copy under a new name embedded far from the original.
 */
export function embeddingTextWithPack(pack: LanguagePack, source: string, range: Range): string {
  const node = locate(rootOf(pack, source), range);
  if (!node) return source.slice(range.start, range.end).replace(/\s+/g, " ").trim();
  const t = pack.tokens;
  const locals = declaredLocals(pack, node);
  const own = ownName(pack, node);
  const numbered = new Map<string, number>();
  const edits: { start: number; end: number; text: string }[] = [];
  const kinds = [...t.comments, t.local, ...t.embedding.strings];
  for (const n of node.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })) {
    const kind = n.kind();
    const r = n.range();
    const edit = { start: r.start.index, end: r.end.index, text: " " };
    if (kind === t.local) {
      const name = n.text();
      if (!locals.has(name) && name !== own) continue;
      let k = numbered.get(name);
      if (k === undefined) {
        k = numbered.size + 1;
        numbered.set(name, k);
      }
      edit.text = `${t.embedding.localPrefix}${k}`;
    } else if (!t.comments.includes(kind)) edit.text = t.embedding.stringText;
    edits.push(edit);
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = range.start;
  for (const e of edits) {
    if (e.start < pos) continue;
    out += `${source.slice(pos, e.start)}${e.text}`;
    pos = e.end;
  }
  out += source.slice(pos, range.end);
  return out.replace(/\s+/g, " ").trim();
}

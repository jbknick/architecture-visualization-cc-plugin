// A language-blind shape normalizer over any tree-sitter tree (ast-grep), driven by a per-language kind table.
// Question it answers: if the shared code also did the normalizing, would TypeScript hashes survive?
import { Lang, parse, type SgNode } from "@ast-grep/napi";

export interface KindTable {
  identifier: Set<string>;
  string: Set<string>;
  number: Set<string>;
  /** Collapsed to one token; children muted (like today's TemplateLiteral). */
  template: Set<string>;
  comment: Set<string>;
}

export const TS_TABLE: KindTable = {
  identifier: new Set([
    "identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    "type_identifier",
    "private_property_identifier",
    "statement_identifier",
    "this",
  ]),
  string: new Set(["string"]),
  number: new Set(["number"]),
  template: new Set(["template_string"]),
  comment: new Set(["comment"]),
};

const OPERATOR_RE = /^[^\w\s(){}[\],;.:'"`]+$/;

/** Outermost named nodes fully inside [start, end) (UTF-16 offsets). */
function roots(n: SgNode, start: number, end: number, out: SgNode[]): void {
  for (const c of n.children()) {
    const r = c.range();
    if (r.end.index <= start || r.start.index >= end) continue;
    if (r.start.index >= start && r.end.index <= end && c.isNamed()) out.push(c);
    else roots(c, start, end, out);
  }
}

function walk(n: SgNode, t: KindTable, out: string[]): void {
  const k = n.kind();
  if (t.comment.has(k)) return;
  if (t.identifier.has(k)) return void out.push("ID");
  if (t.string.has(k)) return void out.push("STR");
  if (t.number.has(k)) return void out.push("NUM");
  if (t.template.has(k)) return void out.push("TPL");
  const kids = n.children();
  let tok = k;
  for (const c of kids) {
    if (!c.isNamed() && OPERATOR_RE.test(c.text())) {
      tok += `:${c.text()}`;
      break;
    }
  }
  out.push(tok);
  for (const c of kids) if (c.isNamed()) walk(c, t, out);
}

let cache: { source: string; lang: Lang; root: SgNode } | null = null;

export function genericShape(
  source: string,
  range: { start: number; end: number },
  lang: "ts" | "tsx",
  table: KindTable = TS_TABLE,
): string[] {
  const l = lang === "tsx" ? Lang.Tsx : Lang.TypeScript;
  if (!cache || cache.source !== source || cache.lang !== l)
    cache = { source, lang: l, root: parse(l, source).root() };
  const found: SgNode[] = [];
  roots(cache.root, range.start, range.end, found);
  const out: string[] = [];
  for (const r of found) {
    // `export function f` hashes like `function f`, as today.
    const inner = r.kind() === "export_statement" ? (r.field("declaration") ?? r) : r;
    walk(inner, table, out);
  }
  return out;
}

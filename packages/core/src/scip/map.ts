import { createHash } from "node:crypto";
import type { EdgeKind, EdgeRecord, SymbolKind } from "../types.js";
import {
  type PositionEncoding,
  readScip,
  type ScipDocument,
  type ScipOccurrence,
  SYMBOL_ROLE_DEFINITION,
  SYMBOL_ROLE_IMPORT,
} from "./read.js";

/** Evidence strings (`path:line`) kept per edge, the same cap as the inferred edges (spec section 7). */
const EVIDENCE_CAP = 20;

/** The edge kinds that precise mode writes for a file the index covers; the inferred edges of these kinds are dropped. */
export const SCIP_EDGE_KINDS: readonly EdgeKind[] = ["calls", "renders", "uses_hook", "references_type"];

/** What the mapping needs to know of a file of the repo. */
export interface ScipSourceFile {
  id: string;
  source: string;
  /** sha256 of the file's bytes (the `files.content_hash` the indexer computed). */
  contentHash: string;
  symbols: { id: string; name: string; kind: SymbolKind; startLine: number; endLine: number }[];
}

export interface ScipStats {
  /** Documents of the index that are files of the repo (covered or stale). */
  documents: number;
  /** Edges written from the index. */
  edges: number;
  /** Occurrences of non-local symbols that map to no Gantry symbol or to no edge. */
  unmapped: number;
  /** Documents that were ignored because their file is not the file that was indexed. */
  stale: number;
}

export interface ScipResult {
  /** For every file the index covers (a document that is not stale), the edges written from it, sorted. */
  edges: Map<string, EdgeRecord[]>;
  stats: ScipStats;
}

/** The edges of a file the index covers: its inferred edges without those of `SCIP_EDGE_KINDS`, plus the edges from the index. */
export function withScipEdges(inferred: EdgeRecord[], scip: EdgeRecord[]): EdgeRecord[] {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...inferred.filter((e) => !SCIP_EDGE_KINDS.includes(e.kind)), ...scip].sort(
    (a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind),
  );
}

/** The symbols whose lines hold code that runs: a reference inside one of them belongs to it. */
const CODE_BEARING: ReadonlySet<SymbolKind> = new Set(["function", "method", "component", "hook", "const"]);

/** The edge kind a reference to a symbol of this kind makes. */
function edgeKindOf(target: SymbolKind): EdgeKind {
  switch (target) {
    case "component":
      return "renders";
    case "hook":
      return "uses_hook";
    case "class":
    case "interface":
    case "type":
    case "enum":
      return "references_type";
    default:
      return "calls";
  }
}

/** `Descriptor.Suffix` of the last descriptor of a symbol: namespace `/`, type `#`, term `.`, method `().`, meta `:`, macro `!`, type parameter `[x]`, parameter `(x)`. */
export type ScipSuffix =
  | "namespace"
  | "type"
  | "term"
  | "method"
  | "meta"
  | "macro"
  | "typeParameter"
  | "parameter";

/**
 * The last descriptor of a SCIP symbol string (`<scheme> <manager> <package> <version> <descriptors>`): its name as the
 * code spells it (`formatRelativeDate` for a function, `increment` for the method `Counter#increment().`) and its
 * suffix. A local symbol (`local 3`) and a malformed string give undefined. Names are plain identifier characters or
 * wrapped in backticks, in which a doubled backtick is one.
 */
export function scipDescriptor(symbol: string): { name: string; suffix: ScipSuffix } | undefined {
  if (symbol.startsWith("local ")) return undefined;
  // Four space-separated fields, a double space inside a field standing for one space.
  let at = 0;
  for (let field = 0; field < 4; field++) {
    for (;;) {
      const i = symbol.indexOf(" ", at);
      if (i < 0) return undefined;
      if (symbol[i + 1] === " ") {
        at = i + 2;
        continue;
      }
      at = i + 1;
      break;
    }
  }
  const s = symbol.slice(at);
  let last: { name: string; suffix: ScipSuffix } | undefined;
  let i = 0;
  while (i < s.length) {
    let name = "";
    const c = s[i];
    if (c === "[" || c === "(") {
      const close = s.indexOf(c === "[" ? "]" : ")", i);
      if (close < 0) return undefined;
      last = { name: s.slice(i + 1, close), suffix: c === "[" ? "typeParameter" : "parameter" };
      i = close + 1;
      continue;
    }
    if (c === "`") {
      i++;
      for (;;) {
        const q = s.indexOf("`", i);
        if (q < 0) return undefined;
        name += s.slice(i, q);
        if (s[q + 1] === "`") {
          name += "`";
          i = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
    } else {
      const m = /^[A-Za-z0-9_+\-$]+/.exec(s.slice(i));
      if (!m) return undefined;
      name = m[0];
      i += name.length;
    }
    const c2 = s[i];
    let suffix: ScipSuffix;
    if (c2 === "(") {
      const close = s.indexOf(")", i);
      if (close < 0 || s[close + 1] !== ".") return undefined;
      i = close + 2;
      suffix = "method";
    } else {
      const known: Record<string, ScipSuffix> = {
        "/": "namespace",
        "#": "type",
        ".": "term",
        ":": "meta",
        "!": "macro",
      };
      suffix = known[c2 ?? ""] as ScipSuffix;
      if (suffix === undefined) return undefined;
      i++;
    }
    last = { name, suffix };
  }
  return last;
}

/** The text of `[start, end)` on one line, characters counted as the document's position encoding says. */
function sliceLine(line: string, start: number, end: number, encoding: PositionEncoding): string | undefined {
  if (start < 0 || end < start) return undefined;
  if (encoding === 1) {
    const bytes = Buffer.from(line, "utf8");
    return end > bytes.length ? undefined : bytes.subarray(start, end).toString("utf8");
  }
  if (encoding === 3) {
    const points = Array.from(line);
    return end > points.length ? undefined : points.slice(start, end).join("");
  }
  return end > line.length ? undefined : line.slice(start, end);
}

const unquote = (s: string): string =>
  s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0] as string) ? s.slice(1, -1) : s;

/**
 * Whether a document is no longer the file that was indexed. When the document carries its text (most indexers do not)
 * the hashes of the two texts are compared. Otherwise the index holds no hash, so the definitions are checked: at the
 * range of each definition of a non-local symbol the file must spell the symbol's name (a quoted name without its
 * quotes), and every range must lie inside the file. A file edited since the index was made moves its declarations.
 */
function isStale(doc: ScipDocument, file: ScipSourceFile, lines: string[]): boolean {
  if (doc.text !== undefined) {
    return createHash("sha256").update(Buffer.from(doc.text, "utf8")).digest("hex") !== file.contentHash;
  }
  const encoding = doc.positionEncoding;
  for (const o of doc.occurrences) {
    if (o.symbol.startsWith("local ")) continue;
    if (o.line < 0 || o.line >= lines.length || o.endLine >= lines.length) return true;
    if (o.endLine !== o.line || o.startCharacter === o.endCharacter) continue;
    const text = sliceLine(lines[o.line] as string, o.startCharacter, o.endCharacter, encoding);
    if (text === undefined) return true;
    if ((o.roles & SYMBOL_ROLE_DEFINITION) === 0) continue;
    // Only a declared name is checked: a meta descriptor (`posts0:`) is made up by the indexer.
    const d = scipDescriptor(o.symbol);
    if (!d || (d.suffix !== "type" && d.suffix !== "term" && d.suffix !== "method")) continue;
    if (d.name.startsWith("<") || d.name === "default") continue;
    if (unquote(text) !== d.name) return true;
  }
  return false;
}

interface Pending {
  from: string;
  fileId: string;
  path: string;
  line: number;
  symbol: string;
}

/** The innermost of the symbols whose lines contain `line` (1-based) and that `accept` allows. */
function innermost(
  symbols: ScipSourceFile["symbols"],
  line: number,
  accept: (s: ScipSourceFile["symbols"][number]) => boolean,
): ScipSourceFile["symbols"][number] | undefined {
  let best: ScipSourceFile["symbols"][number] | undefined;
  for (const s of symbols) {
    if (s.startLine > line || s.endLine < line || !accept(s)) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

const lastSegment = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

/**
 * Reads a SCIP index and maps it onto the files and symbols of the repo (spec section 11, precise mode). One pass over
 * the stream, one document at a time:
 *
 * - A document whose path is not an indexed file is skipped. One that is stale (see `isStale`) is counted and ignored.
 * - A definition occurrence of a non-local symbol maps to the symbol of that file whose lines contain it, the
 *   innermost one, when the name the index gives the symbol is the symbol's name (the part after the last dot).
 * - A reference occurrence inside a function, method, component, hook or const (the innermost one) is kept with that
 *   symbol as its source. After the last document, each reference whose symbol has a definition becomes an edge
 *   from the enclosing symbol to the definition's symbol: `high`, `source: "scip"`, kind by the target (`renders`
 *   for a component, `uses_hook` for a hook, `references_type` for a class, interface, type or enum, `calls` for
 *   the rest). A reference outside all of them (an import, a top-level statement) and a symbol's reference to itself
 *   make no edge and are not counted.
 * - Occurrences of non-local symbols that map to nothing are `unmapped`; references to symbols with no definition in
 *   the index (packages that are not in the repo, the language's built-ins) are among them.
 * - Occurrences with the `Import` role and occurrences of local symbols are not read.
 */
export async function mapScip(
  indexFile: string,
  lookup: (relativePath: string) => ScipSourceFile | undefined,
): Promise<ScipResult> {
  const stats: ScipStats = { documents: 0, edges: 0, unmapped: 0, stale: 0 };
  const definitions = new Map<string, { id: string; kind: SymbolKind }>();
  const pending: Pending[] = [];
  const covered = new Map<string, string>();

  for await (const item of readScip(indexFile)) {
    if (item.kind !== "document") continue;
    const doc = item.document;
    const file = lookup(doc.path);
    if (!file) continue;
    stats.documents++;
    const lines = file.source.split(/\r?\n/);
    if (isStale(doc, file, lines)) {
      stats.stale++;
      continue;
    }
    covered.set(file.id, doc.path);
    for (const o of doc.occurrences) readOccurrence(o, doc.path, file);
  }

  function readOccurrence(o: ScipOccurrence, path: string, file: ScipSourceFile): void {
    if (o.symbol === "" || o.symbol.startsWith("local ")) return;
    if ((o.roles & SYMBOL_ROLE_IMPORT) !== 0) return;
    const line = o.line + 1;
    if ((o.roles & SYMBOL_ROLE_DEFINITION) !== 0) {
      if (o.line === o.endLine && o.startCharacter === o.endCharacter) return; // the file's own module symbol
      const name = scipDescriptor(o.symbol)?.name;
      const sym = name === undefined ? undefined : innermost(file.symbols, line, () => true);
      const spelled = sym === undefined ? undefined : lastSegment(sym.name);
      if (
        sym &&
        name !== undefined &&
        (spelled === name || (name === "<constructor>" && spelled === "constructor"))
      ) {
        if (!definitions.has(o.symbol)) definitions.set(o.symbol, { id: sym.id, kind: sym.kind });
      } else {
        stats.unmapped++;
      }
      return;
    }
    const from = innermost(file.symbols, line, (s) => CODE_BEARING.has(s.kind));
    if (!from) return;
    pending.push({ from: from.id, fileId: file.id, path, line, symbol: o.symbol });
  }

  const byFile = new Map<string, Map<string, EdgeRecord>>();
  for (const id of covered.keys()) byFile.set(id, new Map());
  for (const p of pending) {
    const target = definitions.get(p.symbol);
    if (!target) {
      stats.unmapped++;
      continue;
    }
    if (target.id === p.from) continue;
    const kind = edgeKindOf(target.kind);
    const edges = byFile.get(p.fileId) as Map<string, EdgeRecord>;
    const key = `${p.from}\0${target.id}\0${kind}`;
    let e = edges.get(key);
    if (!e) {
      e = {
        src: p.from,
        dst: target.id,
        kind,
        confidence: "high",
        count: 0,
        evidence: [],
        fileId: p.fileId,
        source: "scip",
      };
      edges.set(key, e);
    }
    e.count++;
    const ev = `${covered.get(p.fileId)}:${p.line}`;
    if (e.evidence.length < EVIDENCE_CAP && !e.evidence.includes(ev)) e.evidence.push(ev);
  }

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const out = new Map<string, EdgeRecord[]>();
  for (const [id, m] of byFile) {
    const list = [...m.values()].sort(
      (a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind),
    );
    out.set(id, list);
    stats.edges += list.length;
  }
  return { edges: out, stats };
}

import { createHash } from "node:crypto";
import fs from "node:fs";
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
  /** Modification time of the working file, in ms (0 when unknown, as for in-memory text). */
  mtimeMs: number;
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
  /** References to a symbol of the repo that are no call, construction, render or type reference (a read of a value, an import): no edge. */
  otherRefs: number;
}

export interface ScipResult {
  /** For every file the index covers (a document that is not stale), the edges written from it, sorted. */
  edges: Map<string, EdgeRecord[]>;
  stats: ScipStats;
}

/**
 * Drops, in place, every edge whose source or target is not in `known` (the ids of the files and symbols of the index
 * being built), and corrects the edge count. A SCIP file made from another state of the tree cannot add a name this way.
 */
export function restrictScipEdges(result: ScipResult, known: ReadonlySet<string>): void {
  let dropped = 0;
  for (const [id, list] of result.edges) {
    const kept = list.filter((e) => known.has(e.src) && known.has(e.dst));
    dropped += list.length - kept.length;
    result.edges.set(id, kept);
  }
  result.stats.edges -= dropped;
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

const TYPE_LIKE: ReadonlySet<SymbolKind> = new Set(["class", "interface", "type", "enum"]);
const FUNCTION_LIKE: ReadonlySet<SymbolKind> = new Set(["function", "method", "component", "hook"]);

/** How the source text uses a name at an occurrence. SCIP has no role for a call, so the text around the range says. */
interface Use {
  /** The range directly follows `<` or `</`. */
  tag: boolean;
  /** The range is followed, past whitespace, `?.` and a `<...>` type-argument list, by `(`. */
  called: boolean;
  /** The range is preceded by `new `. */
  constructed: boolean;
}

const AFTER_CALL = /^\s*(?:\?\.)?\s*(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>)?\s*\(/;

/** Reads the use off the line the occurrence is on (only that line: a range and its neighbours on other lines are not looked at). */
function useAt(line: string, start: number, end: number): Use {
  const before = line.slice(0, start);
  return {
    tag: /<\/?$/.test(before),
    called: AFTER_CALL.test(line.slice(end)),
    constructed: /(?:^|[^\w$])new\s+$/.test(before),
  };
}

/**
 * The edge kind a reference makes, or undefined when it is none of them (a read of a value, a name passed along, an
 * import). `renders` is a reference right after `<` or `</`. A type target is `references_type`, except when it is
 * constructed (`new X`), which calls it. A call or construction (`calls`, `uses_hook` for a hook) needs a target that
 * is a function: the descriptor is a method (`name().`), or a term that maps to a function-like symbol. At a file level
 * (no enclosing symbol) a type reference makes no edge.
 */
function edgeKindOf(
  use: Use,
  suffix: ScipSuffix | undefined,
  target: SymbolKind,
  fileLevel: boolean,
): EdgeKind | undefined {
  if (use.tag) return "renders";
  if (TYPE_LIKE.has(target)) {
    if (use.constructed) return "calls";
    return fileLevel ? undefined : "references_type";
  }
  const isFunction = suffix === "method" || (suffix === "term" && FUNCTION_LIKE.has(target));
  if (isFunction && (use.called || use.constructed)) return target === "hook" ? "uses_hook" : "calls";
  return undefined;
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

/** The UTF-16 offset in `line` of a character offset counted in the document's position encoding. */
function unitOffset(line: string, offset: number, encoding: PositionEncoding): number {
  if (encoding === 1) return Buffer.from(line, "utf8").subarray(0, offset).toString("utf8").length;
  if (encoding === 3) return Array.from(line).slice(0, offset).join("").length;
  return offset;
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
 * the hashes of the two texts are compared. Otherwise the index holds no hash, so the file is stale when it was
 * modified after the index file was written (`indexMtimeMs`), when a range lies outside it, or when at the range of a
 * definition of a non-local symbol it does not spell the symbol's name (a quoted name without its quotes).
 */
function isStale(
  doc: ScipDocument,
  file: ScipSourceFile,
  lines: string[],
  indexMtimeMs: number,
  ignoreMtime = false,
): boolean {
  if (doc.text !== undefined) {
    return createHash("sha256").update(Buffer.from(doc.text, "utf8")).digest("hex") !== file.contentHash;
  }
  if (!ignoreMtime && file.mtimeMs > indexMtimeMs) return true;
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
  /** The enclosing symbol, or the file id when the reference is outside every symbol that holds code. */
  from: string;
  fileLevel: boolean;
  fileId: string;
  path: string;
  line: number;
  symbol: string;
  use: Use;
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
 * - A reference occurrence is kept with the innermost function, method, component, hook or const that contains it as
 *   its source, or the file when there is none. After the last document, each reference whose symbol has a definition
 *   becomes an edge from that source to the definition's symbol when `edgeKindOf` gives it a kind (`high`,
 *   `source: "scip"`); a symbol's reference to itself makes none. A reference that is none of a call, construction,
 *   render or type reference is counted in `otherRefs`.
 * - Occurrences of non-local symbols that map to nothing are `unmapped`; references to symbols with no definition in
 *   the index (packages that are not in the repo, the language's built-ins) are among them.
 * - Occurrences with the `Import` role and occurrences of local symbols are not read.
 */
export async function mapScip(
  indexFile: string,
  lookup: (relativePath: string) => ScipSourceFile | undefined,
  opts: { ignoreMtime?: boolean } = {},
): Promise<ScipResult> {
  const stats: ScipStats = { documents: 0, edges: 0, unmapped: 0, stale: 0, otherRefs: 0 };
  const indexMtimeMs = (await fs.promises.stat(indexFile)).mtimeMs;
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
    if (isStale(doc, file, lines, indexMtimeMs, opts.ignoreMtime === true)) {
      stats.stale++;
      continue;
    }
    covered.set(file.id, doc.path);
    for (const o of doc.occurrences) readOccurrence(o, doc.path, file, lines, doc.positionEncoding);
  }

  function readOccurrence(
    o: ScipOccurrence,
    path: string,
    file: ScipSourceFile,
    lines: string[],
    encoding: PositionEncoding,
  ): void {
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
    // The text before and after the range, as UTF-16 code units: a document in another encoding is read through it.
    const text = lines[o.line] ?? "";
    const start = unitOffset(text, o.startCharacter, encoding);
    const end = o.endLine === o.line ? unitOffset(text, o.endCharacter, encoding) : text.length;
    pending.push({
      from: from?.id ?? file.id,
      fileLevel: from === undefined,
      fileId: file.id,
      path,
      line,
      symbol: o.symbol,
      use: useAt(text, start, end),
    });
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
    const kind = edgeKindOf(p.use, scipDescriptor(p.symbol)?.suffix, target.kind, p.fileLevel);
    if (!kind) {
      stats.otherRefs++;
      continue;
    }
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

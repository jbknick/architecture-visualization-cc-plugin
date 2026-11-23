// Scoring for `scripts/eval-packs.ts` (spec section 13): the graph of an `index --dump` against the truth of a SCIP
// index, for the Java and Python packs. No process, no network; the truth is read from SCIP documents handed in.
//
// Truth. Every definition of a SCIP index that is a class, interface, enum, function or method (of a file the pack
// indexes) is a symbol of the truth; every reference to a function, method or constructor (and, for Python, a class
// called as `Foo(...)`) from such a file is a call, from the innermost symbol that holds the line to the symbol the
// index names. A definition or a target is mapped onto the innermost symbol of the graph that holds its line and is
// spelled like it; where there is none, it stays in the truth and counts as a miss.
//
// The maintainer's scoring rules (stated on the issue before the first run):
// - A reference to a SCIP `local` symbol that is a function or method (a method of an anonymous class) stays in the
//   truth, mapped onto the graph's symbol for that body where there is one; where there is none it is a miss.
// - A self-recursive call stays in the truth. The graph leaves it out, so it counts against recall. Both groups are
//   counted apart in the report.
// - Low-confidence precision is per call site: a site is correct when its true target is among its low edges.
// - Java lambdas and method references are measured as they are.
//
// Choices of this scorer, fixed before the runs that the report holds:
// - Only files that the graph holds and the index has a document for are scored; both counts of the others are reported.
// - A definition that no source text declares (an implicit constructor, which the index defines at the name of its
//   class) is no symbol of the truth, and is counted. A call of it stays in the truth and is a miss.
// - A Java name followed by `=` is an element of an annotation, not a call: it is left out of the truth and counted
//   (a bug of the first version of this scorer, which counted them as calls to symbols that do not exist).
// - A SCIP symbol can be defined several times (the stubs and the implementation of an overloaded Python function; the
//   index gives every definition after the first as a read, so one is a definition when `def` or `class` precedes it).
//   A call matches the symbol at any of its definitions (also a bug of the first version, which kept the first).
// - Python `Foo(...)` is a call of `Foo.__init__` when `Foo` declares it. When it does not, the index names no callee:
//   the site is not in the truth, and an edge of the graph at that site is left out of precision, both counted.
// - A call reference of Python needs `(` after the name (a function passed along is no call). Java needs none.
import type { ScipDocument } from "../packages/core/src/scip/index.js";
import { scipDescriptor } from "../packages/core/src/scip/index.js";

export type PackLang = "java" | "python";

export interface DumpFile {
  id: string;
  path: string;
  lang: string;
}
export interface DumpSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  lang: string;
  startLine: number;
  endLine: number;
  anonymous?: boolean;
}
export interface DumpEdge {
  src: string;
  dst: string;
  kind: string;
  confidence: string;
  count: number;
  evidence: string[];
  level?: number;
  source?: string;
}
export interface Dump {
  files: DumpFile[];
  symbols: DumpSymbol[];
  edges: DumpEdge[];
}

/** n of d: a ratio kept as two integers, so that no rounding decides a bar. */
export interface Frac {
  n: number;
  d: number;
}
export const frac = (n: number, d: number): Frac => ({ n, d });
/** True when `f` is at least `percent` per cent (an empty denominator meets nothing). */
export const atLeast = (f: Frac, percent: number): boolean => f.d > 0 && f.n * 100 >= percent * f.d;
/** The ratio as per cent with two decimals, cut and never rounded up. */
export const pct = (f: Frac): string =>
  f.d === 0 ? "n/a" : `${(Math.floor((f.n * 10000) / f.d) / 100).toFixed(2)}%`;
export const show = (f: Frac): string => `${pct(f)} (${f.n}/${f.d})`;

type DefKind = "function" | "method" | "class" | "interface" | "enum";
const DEF_KINDS: readonly DefKind[] = ["function", "method", "class", "interface", "enum"];

interface TruthDef {
  symbol: string;
  line: number;
  kind: DefKind;
  /** The graph symbol it maps onto, or null. */
  ours: string | null;
  local: boolean;
  /** Declared inside the body of a function or method. */
  inFunction?: boolean;
}

export type TargetReason =
  | "implicit-definition"
  | "target-has-no-symbol"
  | "target-file-not-indexed"
  | "local-without-symbol";
export type Shape = "bare" | "member" | "construct" | "method-reference";

/** One truth call: all references from one caller to one target, merged. */
export interface TruthCall {
  /** The graph symbol holding the call, or null when none does (Python code outside every function). */
  caller: string | null;
  /** The graph symbol of the target, or null with a `reason`. */
  ours: string | null;
  /** Every graph symbol that defines the target (the stubs and the implementation of an overloaded function). */
  alts: string[];
  reason: TargetReason | null;
  local: boolean;
  /** The target is declared inside a function or method. */
  inFunction: boolean;
  lines: number[];
  shape: Shape;
}

/** What the index says at a line that holds a call of the graph's, for the causes of wrong edges. */
export interface SiteRef {
  ours: string | null;
  external: boolean;
}

export interface Truth {
  lang: PackLang;
  /** Paths of the files that are scored: the graph holds them and the index has a document. */
  scoredPaths: string[];
  /** Documents of the index for files the graph does not hold, and files of the graph without a document. */
  documentsNotIndexed: number;
  filesWithoutDocument: number;
  defs: TruthDef[];
  implicitDefs: number;
  /** Java references to an element of an annotation (`name = ...`): no call, left out of the truth. */
  annotationElementRefs: number;
  calls: TruthCall[];
  /** Python class calls whose class declares no initializer: not in the truth. */
  classCallsWithoutInit: number;
  /** `<caller>@<line>` of those, so that an edge of the graph there is not scored. */
  exemptSites: string[];
  /** `<path>:<line>` to the references at that line, for the lines asked for. */
  sites: Record<string, SiteRef[]>;
}

const CALLABLE_LOCAL_KINDS = new Set([9, 17, 26, 66, 80]);
const SCIP_KIND_TYPE: Record<number, DefKind> = { 7: "class", 21: "interface", 11: "enum" };

interface FileSyms {
  path: string;
  syms: DumpSymbol[];
}

/** The innermost of the symbols whose lines hold `line` (1-based). */
function innermost(
  syms: DumpSymbol[],
  line: number,
  accept: (s: DumpSymbol) => boolean,
): DumpSymbol | undefined {
  let best: DumpSymbol | undefined;
  for (const s of syms) {
    if (s.startLine > line || s.endLine < line || !accept(s)) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

const lastSegment = (name: string): string => name.slice(name.lastIndexOf(".") + 1).replace(/~\d+$/, "");

/** Whether a graph symbol is what a definition named `name` defines; a constructor is named like its type. */
function spelledAs(sym: DumpSymbol, name: string): boolean {
  const own = lastSegment(sym.name);
  if (name === "<init>") {
    const parts = sym.name.replace(/~\d+$/, "").split(".");
    return parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2];
  }
  return own === name;
}

/** Whether a symbol is declared inside a function or method: a method descriptor comes before its last descriptor. */
const declaredInFunction = (symbol: string): boolean => /\((?:\+\d+)?\)\.(?=.)/.test(symbol);

/** The character that ends the descriptor before a symbol's last one: `/` module, `#` type, `)` or `.` otherwise. */
function parentSuffix(symbol: string): string {
  const tail = /(?:`(?:[^`]|``)+`|[A-Za-z0-9_+\-$<>]+)(?:\((?:\+\d+)?\)\.|#)$/.exec(symbol);
  if (!tail) return "";
  return symbol[tail.index - 1] ?? "";
}

export interface TruthInput {
  lang: PackLang;
  dump: Dump;
  /** The SCIP documents of the index. */
  documents: AsyncIterable<ScipDocument> | Iterable<ScipDocument>;
  /** The lines of a file of the repo (0-based list), or undefined when it cannot be read. */
  fileLines: (path: string) => string[] | undefined;
  /** `<path>:<line>` of the lines that hold a call edge of the graph. */
  wantedLines: Set<string>;
}

interface Candidate {
  path: string;
  line: number;
  symbol: string;
  local: boolean;
  caller: string | null;
  shape: Shape;
  /** A class called as `Foo(...)` (Python). */
  construct: boolean;
}

export async function buildTruth(input: TruthInput): Promise<Truth> {
  const { lang, dump, fileLines, wantedLines } = input;
  const pathOf = new Map(dump.files.map((f) => [f.id, f.path]));
  const byPath = new Map<string, FileSyms>();
  for (const f of dump.files) if (f.lang === lang) byPath.set(f.path, { path: f.path, syms: [] });
  for (const s of dump.symbols) {
    const p = pathOf.get(s.fileId);
    if (p !== undefined && s.lang === lang) byPath.get(p)?.syms.push(s);
  }
  const callerKinds =
    lang === "java" ? new Set(["method", "class", "interface", "enum"]) : new Set(["function", "method"]);

  const defs: TruthDef[] = [];
  const defMap = new Map<string, string[]>();
  const nestedDefs = new Set<string>();
  /** Symbols defined in the index: true when the file is scored. */
  const definedIn = new Map<string, boolean>();
  const implicit = new Set<string>();
  let implicitDefs = 0;
  let annotationElementRefs = 0;
  let documentsNotIndexed = 0;
  const scored: string[] = [];
  const cands: Candidate[] = [];
  const localTargets = new Map<string, string | null>();

  for await (const doc of input.documents) {
    const file = byPath.get(doc.path);
    const inScope = file !== undefined;
    if (!inScope) documentsNotIndexed++;
    else scored.push(doc.path);
    const lines = inScope ? fileLines(doc.path) : undefined;
    const info = new Map(doc.symbols.map((s) => [s.symbol, s]));
    const typeDefPos = new Set<string>();
    for (const o of doc.occurrences) {
      if ((o.roles & 1) === 0 || o.symbol.startsWith("local ")) continue;
      if (scipDescriptor(o.symbol)?.suffix === "type") typeDefPos.add(`${o.line}:${o.startCharacter}`);
    }
    const localDefs = new Map<string, TruthDef>();
    for (const o of doc.occurrences) {
      if ((o.roles & 2) !== 0 || o.symbol === "") continue;
      const isLocal = o.symbol.startsWith("local ");
      const line = o.line + 1;
      // scip-python gives a redefinition (the overload stubs after the first, a property setter) as a read of the symbol.
      const redefinition =
        lang === "python" &&
        (o.roles & 1) === 0 &&
        !isLocal &&
        /(?:^|\s)(?:def|class)\s+$/.test((lines?.[o.line] ?? "").slice(0, o.startCharacter));
      if ((o.roles & 1) !== 0 || redefinition) {
        if (o.line === o.endLine && o.startCharacter === o.endCharacter) continue;
        let kind: DefKind | undefined;
        let name = "";
        if (isLocal) {
          const k = info.get(o.symbol)?.kind ?? 0;
          const text = lines?.[o.line] ?? "";
          const before = text.slice(0, o.startCharacter);
          if (lang === "java" ? CALLABLE_LOCAL_KINDS.has(k) : /(?:^|\s)(?:def|class)\s+$/.test(before)) {
            kind = "method";
            name = info.get(o.symbol)?.displayName ?? text.slice(o.startCharacter, o.endCharacter);
          }
        } else {
          const d = scipDescriptor(o.symbol);
          if (!d) continue;
          name = d.name;
          if (d.suffix === "type") {
            kind = lang === "java" ? (SCIP_KIND_TYPE[info.get(o.symbol)?.kind ?? 0] ?? "class") : "class";
          } else if (d.suffix === "method") {
            kind = lang === "python" && parentSuffix(o.symbol) !== "#" ? "function" : "method";
          }
          if (kind) definedIn.set(o.symbol, inScope);
        }
        if (!kind || !file) continue;
        if (
          !isLocal &&
          kind !== "class" &&
          kind !== "interface" &&
          kind !== "enum" &&
          typeDefPos.has(`${o.line}:${o.startCharacter}`)
        ) {
          implicit.add(o.symbol);
          implicitDefs++;
          continue;
        }
        const sym = innermost(file.syms, line, () => true);
        const ours = sym && spelledAs(sym, name) ? sym.id : null;
        const def: TruthDef = { symbol: o.symbol, line, kind, ours, local: isLocal };
        // Declared in a body: the symbol says so, or the innermost symbol of the graph that holds the line is a function.
        if (
          declaredInFunction(o.symbol) ||
          (!ours && sym && (sym.kind === "function" || sym.kind === "method"))
        ) {
          def.inFunction = true;
          nestedDefs.add(o.symbol);
        }
        if (isLocal) localDefs.set(o.symbol, def);
        else if (ours) {
          // One SCIP symbol can be defined several times (the stubs and the implementation of an overloaded function).
          const all = defMap.get(o.symbol) ?? [];
          if (!all.includes(ours)) all.push(ours);
          defMap.set(o.symbol, all);
        }
        defs.push(def);
        continue;
      }
      // A reference.
      if (!file) continue;
      const text = lines?.[o.line] ?? "";
      const after = text.slice(o.endCharacter);
      const before = text.slice(0, o.startCharacter);
      const called = /^\s*(?:\?\.)?\s*\(/.test(after);
      let construct = false;
      if (!isLocal) {
        const d = scipDescriptor(o.symbol);
        if (!d) continue;
        if (d.suffix === "type") {
          if (lang !== "python" || !called) continue;
          construct = true;
        } else if (d.suffix !== "method") continue;
        else if (lang === "python" && !called) continue;
        // A Java method name followed by `=` is an element of an annotation (`@Column(name = "x")`), which no call names.
        if (lang === "java" && /^\s*=(?!=)/.test(after)) {
          annotationElementRefs++;
          continue;
        }
      } else if (lang === "python" && !called) continue;
      const shape: Shape = /::\s*$/.test(before)
        ? "method-reference"
        : construct || /(?:^|[^\w$.])new\s+$/.test(before)
          ? "construct"
          : /\.\s*$/.test(before)
            ? "member"
            : "bare";
      const callerSym = innermost(file.syms, line, (s) => callerKinds.has(s.kind));
      cands.push({
        path: doc.path,
        line,
        symbol: o.symbol,
        local: isLocal,
        caller: callerSym?.id ?? null,
        shape,
        construct,
      });
    }
    // A local symbol belongs to its document.
    for (const [sym, def] of localDefs) localTargets.set(`${doc.path}\0${sym}`, def.ours);
  }

  // Calls: resolve each candidate against the definitions of the whole index.
  const calls = new Map<string, TruthCall>();
  const sites: Record<string, SiteRef[]> = {};
  const exemptSites = new Set<string>();
  let classCallsWithoutInit = 0;
  for (const c of cands) {
    let symbol = c.symbol;
    let ours: string | null = null;
    let alts: string[] = [];
    let reason: TargetReason | null = null;
    let external = false;
    let exempt = false;
    if (c.local) {
      const key = `${c.path}\0${symbol}`;
      if (!localTargets.has(key)) continue; // a local that is no function or method
      ours = localTargets.get(key) ?? null;
      alts = ours ? [ours] : [];
      if (!ours) reason = "local-without-symbol";
    } else {
      if (c.construct) {
        const init = symbol.replace(/#$/, "#__init__().");
        if (definedIn.has(init)) symbol = init;
        else if (definedIn.has(symbol)) {
          classCallsWithoutInit++;
          exempt = true;
        } else external = true;
      }
      if (!exempt && !external) {
        if (!definedIn.has(symbol)) external = true;
        else {
          alts = defMap.get(symbol) ?? [];
          ours = alts[0] ?? null;
          if (!ours) {
            reason = implicit.has(symbol)
              ? "implicit-definition"
              : definedIn.get(symbol)
                ? "target-has-no-symbol"
                : "target-file-not-indexed";
          }
        }
      }
    }
    const siteKey = `${c.path}:${c.line}`;
    if (wantedLines.has(siteKey)) {
      const list = sites[siteKey] ?? [];
      list.push({ ours, external });
      sites[siteKey] = list;
    }
    if (exempt) {
      if (c.caller) exemptSites.add(`${c.caller}@${c.line}`);
      continue;
    }
    if (external) continue;
    const key = `${c.caller ?? "-"}\0${ours ?? `?${symbol}`}`;
    let t = calls.get(key);
    if (!t) {
      t = {
        caller: c.caller,
        ours,
        alts,
        reason,
        local: c.local,
        inFunction: nestedDefs.has(symbol),
        lines: [],
        shape: c.shape,
      };
      calls.set(key, t);
    }
    if (!t.lines.includes(c.line)) t.lines.push(c.line);
  }

  const withDoc = new Set(scored);
  let filesWithoutDocument = 0;
  for (const p of byPath.keys()) if (!withDoc.has(p)) filesWithoutDocument++;
  return {
    lang,
    scoredPaths: scored,
    documentsNotIndexed,
    filesWithoutDocument,
    defs,
    implicitDefs,
    annotationElementRefs,
    calls: [...calls.values()],
    classCallsWithoutInit,
    exemptSites: [...exemptSites],
    sites,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Symbols.

export interface KindScore {
  precision: Frac;
  recall: Frac;
}
export interface SymbolScore {
  perKind: Partial<Record<DefKind, KindScore>>;
  /** Recall misses by cause. */
  misses: Record<string, number>;
  implicitDefs: number;
  localDefs: number;
  localDefsMapped: number;
}

export function scoreSymbols(dump: Dump, truth: Truth): SymbolScore {
  const pathOf = new Map(dump.files.map((f) => [f.id, f.path]));
  const scored = new Set(truth.scoredPaths);
  const ours = dump.symbols.filter((s) => s.lang === truth.lang && scored.has(pathOf.get(s.fileId) ?? ""));
  const ourKind = new Map(ours.map((s) => [s.id, s.kind]));
  const matchedKinds = new Map<string, Set<DefKind>>();
  const perKind: Partial<Record<DefKind, KindScore>> = {};
  const misses: Record<string, number> = {};
  const miss = (cause: string): void => {
    misses[cause] = (misses[cause] ?? 0) + 1;
  };
  let localDefs = 0;
  let localDefsMapped = 0;
  const truthByKind = new Map<DefKind, number>();
  for (const d of truth.defs) {
    truthByKind.set(d.kind, (truthByKind.get(d.kind) ?? 0) + 1);
    if (d.local) {
      localDefs++;
      if (d.ours) localDefsMapped++;
    }
    if (d.ours && ourKind.get(d.ours) === d.kind) {
      const set = matchedKinds.get(d.ours) ?? new Set<DefKind>();
      set.add(d.kind);
      matchedKinds.set(d.ours, set);
    } else if (d.ours) miss(`${d.kind}: the graph has the symbol under another kind`);
    else
      miss(
        `${d.kind}${d.local ? " (local)" : ""}: ${d.inFunction ? "declared inside a function" : "no symbol"}`,
      );
  }
  const foundByKind = new Map<DefKind, number>();
  const correctByKind = new Map<DefKind, number>();
  for (const s of ours) {
    const k = s.kind as DefKind;
    if (!DEF_KINDS.includes(k)) continue;
    foundByKind.set(k, (foundByKind.get(k) ?? 0) + 1);
    if (matchedKinds.get(s.id)?.has(k)) correctByKind.set(k, (correctByKind.get(k) ?? 0) + 1);
  }
  for (const k of DEF_KINDS) {
    const t = truthByKind.get(k) ?? 0;
    const f = foundByKind.get(k) ?? 0;
    if (t === 0 && f === 0) continue;
    perKind[k] = {
      precision: frac(correctByKind.get(k) ?? 0, f),
      // Distinct graph symbols: two definitions that map onto one symbol find it once.
      recall: frac(correctByKind.get(k) ?? 0, t),
    };
  }
  return { perKind, misses, implicitDefs: truth.implicitDefs, localDefs, localDefsMapped };
}

// ---------------------------------------------------------------------------------------------------------------
// Calls.

export interface CallScore {
  truthCalls: number;
  /** Counts of the truth that the rules single out. */
  selfRecursive: number;
  local: number;
  localWithoutSymbol: number;
  /** The groups the graph can reach: both ends have a symbol and the call is not recursive. */
  reachable: number;
  recall: Frac;
  /** Matched truth calls by the edge that matched: `L1`, `L2`, `L3`, `high`, `low`. */
  matchedBy: Record<string, number>;
  precision: {
    all: Frac;
    high: Frac;
    /** Per call site. */
    low: Frac;
    lowEdges: Frac;
    byLevel: Record<string, Frac>;
    byLevelConfidence: Record<string, Frac>;
    unverifiable: number;
  };
  recallMisses: Record<string, number>;
  /** Of the misses with no edge at the site: by the shape of the call. */
  noEdgeShapes: Record<string, number>;
  /** Of the misses where the graph has another target at the site: by the level of that edge. */
  wrongTargetLevels: Record<string, number>;
  precisionMisses: Record<string, number>;
  precisionMissesByLevel: Record<string, number>;
}

const evidenceLines = (e: DumpEdge): { path: string; line: number }[] =>
  e.evidence.flatMap((x) => {
    const i = x.lastIndexOf(":");
    const line = Number(x.slice(i + 1));
    return i > 0 && Number.isInteger(line) ? [{ path: x.slice(0, i), line }] : [];
  });

/** The `path:line` of every evidence of the `calls` edges of the dump, to ask the index for the sites. */
export function wantedLinesOf(dump: Dump): Set<string> {
  const out = new Set<string>();
  for (const e of dump.edges) if (e.kind === "calls") for (const x of e.evidence) out.add(x);
  return out;
}

export function scoreCalls(dump: Dump, truth: Truth): CallScore {
  const pathOf = new Map(dump.files.map((f) => [f.id, f.path]));
  const fileOfSym = new Map(dump.symbols.map((s) => [s.id, pathOf.get(s.fileId) ?? ""]));
  const scored = new Set(truth.scoredPaths);
  const exempt = new Set(truth.exemptSites);
  const inc = (m: Record<string, number>, k: string, by = 1): void => {
    m[k] = (m[k] ?? 0) + by;
  };

  const edges = dump.edges.filter(
    (e) => e.kind === "calls" && e.source === undefined && scored.has(fileOfSym.get(e.src) ?? ""),
  );
  const edgeByPair = new Map(edges.map((e) => [`${e.src}\0${e.dst}`, e]));
  // The graph's edges by caller and line, to tell a wrong target from no edge.
  const edgesAt = new Map<string, DumpEdge[]>();
  for (const e of edges)
    for (const { line } of evidenceLines(e)) {
      const k = `${e.src}@${line}`;
      const list = edgesAt.get(k) ?? [];
      list.push(e);
      edgesAt.set(k, list);
    }

  // Truth by pair and by site.
  const truthPairs = new Set<string>();
  const truthAt = new Map<string, Set<string>>();
  for (const t of truth.calls) {
    if (!t.caller) continue;
    for (const alt of t.alts) {
      truthPairs.add(`${t.caller}\0${alt}`);
      for (const l of t.lines) {
        const k = `${t.caller}@${l}`;
        const set = truthAt.get(k) ?? new Set<string>();
        set.add(alt);
        truthAt.set(k, set);
      }
    }
  }

  let selfRecursive = 0;
  let local = 0;
  let localWithoutSymbol = 0;
  let reachable = 0;
  let matched = 0;
  const matchedBy: Record<string, number> = {};
  const recallMisses: Record<string, number> = {};
  const noEdgeShapes: Record<string, number> = {};
  const wrongTargetLevels: Record<string, number> = {};
  for (const t of truth.calls) {
    if (t.local) local++;
    if (t.reason === "local-without-symbol") localWithoutSymbol++;
    const self = t.caller !== null && t.alts.includes(t.caller);
    if (self) selfRecursive++;
    const caller = t.caller;
    const edge =
      caller && !self
        ? t.alts.map((a) => edgeByPair.get(`${caller}\0${a}`)).find((e) => e !== undefined)
        : undefined;
    if (t.caller && t.ours && !self) reachable++;
    if (edge) {
      matched++;
      inc(matchedBy, `level ${edge.level ?? "none"}`);
      inc(matchedBy, edge.confidence);
      continue;
    }
    const where = t.local ? " (local symbol)" : "";
    if (self) inc(recallMisses, "self-recursive call (the graph leaves it out)");
    else if (t.reason === "local-without-symbol")
      inc(recallMisses, "target is a local symbol with no symbol of ours");
    else if (t.reason === "implicit-definition")
      inc(
        recallMisses,
        "target is an implicit definition (a default constructor or an enum's own method): no symbol",
      );
    else if (t.reason === "target-has-no-symbol")
      inc(
        recallMisses,
        `target ${t.inFunction ? "is declared inside a function" : "has no symbol of ours"}${where}`,
      );
    else if (t.reason === "target-file-not-indexed")
      inc(recallMisses, "target is in a file the pack does not index");
    else if (!t.caller) inc(recallMisses, "call outside every function (no caller symbol)");
    else {
      const competing = t.lines
        .flatMap((l) => edgesAt.get(`${t.caller}@${l}`) ?? [])
        .filter((e) => !t.alts.includes(e.dst));
      if (t.shape === "method-reference") inc(recallMisses, "method reference");
      else if (competing.length > 0) {
        inc(recallMisses, "the graph has another target at the site");
        inc(wrongTargetLevels, `level ${competing[0]?.level ?? "none"}, ${competing[0]?.confidence}`);
      } else {
        inc(recallMisses, "the graph has no edge from the caller at the site");
        inc(noEdgeShapes, t.shape);
      }
    }
  }

  // Precision.
  let allOk = 0;
  let allN = 0;
  let highOk = 0;
  let highN = 0;
  let lowEdgeOk = 0;
  let lowEdgeN = 0;
  let unverifiable = 0;
  const byLevel: Record<string, { n: number; d: number }> = {};
  const byLevelConf: Record<string, { n: number; d: number }> = {};
  const bump = (m: Record<string, { n: number; d: number }>, k: string, ok: boolean): void => {
    const x = m[k] ?? { n: 0, d: 0 };
    x.d++;
    if (ok) x.n++;
    m[k] = x;
  };
  const precisionMisses: Record<string, number> = {};
  const precisionMissesByLevel: Record<string, number> = {};
  const causeOf = (e: DumpEdge): string => {
    let other = false;
    let external = false;
    let unmapped = false;
    for (const { path, line } of evidenceLines(e)) {
      const here = truthAt.get(`${e.src}@${line}`);
      if (here && here.size > 0) other = true;
      for (const r of truth.sites[`${path}:${line}`] ?? []) {
        if (r.external) external = true;
        else if (!r.ours) unmapped = true;
        else other = true;
      }
    }
    if (other) return "the index names another symbol of the repo at the site";
    if (unmapped) return "the index names a target that has no symbol of ours";
    if (external) return "the index names a target outside the repo at the site";
    return "the index has no call at the site";
  };
  const lowSites = new Map<string, Set<string>>();
  for (const e of edges) {
    const exemptEdge =
      !truthPairs.has(`${e.src}\0${e.dst}`) &&
      evidenceLines(e).some(({ line }) => exempt.has(`${e.src}@${line}`));
    if (exemptEdge) {
      unverifiable++;
      continue;
    }
    const ok = truthPairs.has(`${e.src}\0${e.dst}`);
    const level = `level ${e.level ?? "none"}`;
    allN++;
    if (ok) allOk++;
    bump(byLevel, level, ok);
    bump(byLevelConf, `${level}, ${e.confidence}`, ok);
    if (!ok) {
      inc(precisionMissesByLevel, `${level}, ${e.confidence}`);
      if (e.confidence === "high") inc(precisionMisses, `high: ${causeOf(e)}`);
    }
    if (e.confidence === "high") {
      highN++;
      if (ok) highOk++;
    } else {
      lowEdgeN++;
      if (ok) lowEdgeOk++;
      for (const { line } of evidenceLines(e)) {
        const k = `${e.src}@${line}`;
        const dsts = lowSites.get(k) ?? new Set<string>();
        dsts.add(e.dst);
        lowSites.set(k, dsts);
      }
    }
  }
  let lowOk = 0;
  for (const [k, dsts] of lowSites) {
    const here = truthAt.get(k);
    const ok = here !== undefined && [...dsts].some((d) => here.has(d));
    if (ok) lowOk++;
    else {
      const lows = edgesAt.get(k)?.filter((e) => e.confidence !== "high") ?? [];
      const first = lows[0];
      if (first) inc(precisionMisses, `low: ${causeOf(first)}`);
    }
  }
  const fr = (m: Record<string, { n: number; d: number }>): Record<string, Frac> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, frac(v.n, v.d)]));
  return {
    truthCalls: truth.calls.length,
    selfRecursive,
    local,
    localWithoutSymbol,
    reachable,
    recall: frac(matched, truth.calls.length),
    matchedBy,
    precision: {
      all: frac(allOk, allN),
      high: frac(highOk, highN),
      low: frac(lowOk, lowSites.size),
      lowEdges: frac(lowEdgeOk, lowEdgeN),
      byLevel: fr(byLevel),
      byLevelConfidence: fr(byLevelConf),
      unverifiable,
    },
    recallMisses,
    noEdgeShapes,
    wrongTargetLevels,
    precisionMisses,
    precisionMissesByLevel,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The bars of the issue, as written there (worst of three runs, per repo).

export interface Metric {
  key: string;
  label: string;
  /** Bar in per cent. */
  bar: number;
  value: Frac;
}

/** The metrics a run is held to, with their bars. */
export function barMetrics(lang: PackLang, symbols: SymbolScore, calls: CallScore): Metric[] {
  const out: Metric[] = [];
  for (const k of ["function", "method", "class"] as const) {
    const s = symbols.perKind[k];
    if (!s) continue;
    out.push({ key: `symbols.${k}.precision`, label: `symbol precision, ${k}`, bar: 97, value: s.precision });
    out.push({ key: `symbols.${k}.recall`, label: `symbol recall, ${k}`, bar: 97, value: s.recall });
  }
  out.push({
    key: "calls.high.precision",
    label: "high-confidence call precision",
    bar: 99,
    value: calls.precision.high,
  });
  if (lang === "python")
    out.push({
      key: "calls.low.precision",
      label: "low-confidence call precision (per site)",
      bar: 90,
      value: calls.precision.low,
    });
  out.push({
    key: "calls.recall",
    label: "call recall",
    bar: lang === "java" ? 85 : 70,
    value: calls.recall,
  });
  return out;
}

/** The worst value of each metric over the runs (the smallest ratio), keeping the bar. */
export function worstOf(runs: Metric[][]): Metric[] {
  const first = runs[0] ?? [];
  return first.map((m) => {
    let worst = m;
    for (const r of runs) {
      const x = r.find((y) => y.key === m.key);
      if (
        x &&
        x.value.d > 0 &&
        (worst.value.d === 0 || x.value.n * worst.value.d < worst.value.n * x.value.d)
      )
        worst = x;
    }
    return worst;
  });
}

export const barMet = (m: Metric): boolean => atLeast(m.value, m.bar);

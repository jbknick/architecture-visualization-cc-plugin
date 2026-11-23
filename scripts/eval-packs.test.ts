import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScipDocument } from "../packages/core/src/scip/index.js";
import { reposSchema } from "./eval-lib.js";
import {
  atLeast,
  barMet,
  barMetrics,
  buildTruth,
  type Dump,
  frac,
  pct,
  scoreCalls,
  scoreSymbols,
  wantedLinesOf,
  worstOf,
} from "./eval-packs-score.js";

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const here = fileURLToPath(new URL(".", import.meta.url));
const packsRepos = join(here, "../evals/packs/repos.json");

function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", tsxLoader, join(here, "eval-packs.ts"), ...args], {
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}

const head = (path: string, lang: string) => ({ files: [{ id: "f1", path, lang }] });
const sym = (id: string, name: string, kind: string, lang: string, startLine: number, endLine: number) => ({
  id,
  fileId: "f1",
  name,
  kind,
  lang,
  startLine,
  endLine,
});
const edge = (src: string, dst: string, confidence: string, evidence: string[], level: number) => ({
  src,
  dst,
  kind: "calls",
  confidence,
  count: evidence.length,
  evidence,
  level,
});
const occ = (line: number, start: number, end: number, symbol: string, roles = 0) => ({
  line,
  startCharacter: start,
  endLine: line,
  endCharacter: end,
  symbol,
  roles,
});
const doc = (path: string, occurrences: ScipDocument["occurrences"], language: string): ScipDocument => ({
  path,
  language,
  positionEncoding: 0,
  occurrences,
  symbols: [],
});
const linesOf = (n: number, at: Record<number, string>) => Array.from({ length: n }, (_, i) => at[i] ?? "");

describe("repos.json", () => {
  it("is a valid corpus of two Java and two Python repos", () => {
    const repos = reposSchema.parse(JSON.parse(readFileSync(packsRepos, "utf8"))).repos;
    expect(repos.map((r) => r.lang[0]).sort()).toEqual(["java", "java", "python", "python"]);
  });
});

describe("bars", () => {
  it("never rounds a ratio up", () => {
    expect(pct(frac(2, 3))).toBe("66.66%");
    expect(pct(frac(9999, 10000))).toBe("99.99%");
    expect(atLeast(frac(969, 1000), 97)).toBe(false);
    expect(atLeast(frac(97, 100), 97)).toBe(true);
    expect(atLeast(frac(0, 0), 97)).toBe(false);
  });
});

describe("java", () => {
  // A.java: class A (1-20) with f (2-4), g (6-10), rec (12-14) and extra (16-18, no definition in the index).
  const dump: Dump = {
    ...head("A.java", "java"),
    symbols: [
      sym("s:A", "A", "class", "java", 1, 20),
      sym("s:f", "A.f", "method", "java", 2, 4),
      sym("s:g", "A.g", "method", "java", 6, 10),
      sym("s:rec", "A.rec", "method", "java", 12, 14),
      sym("s:extra", "A.extra", "method", "java", 16, 18),
    ],
    edges: [edge("s:g", "s:f", "high", ["A.java:7"], 2), edge("s:g", "s:extra", "low", ["A.java:10"], 2)],
  };
  const s = (rest: string) => `semanticdb maven m 1 ${rest}`;
  const documents = [
    doc(
      "A.java",
      [
        occ(0, 6, 7, s("pkg/A#"), 1),
        occ(0, 6, 7, s("pkg/A#`<init>`()."), 1),
        occ(1, 4, 5, s("pkg/A#f()."), 1),
        occ(3, 4, 8, s("pkg/A#name()."), 0),
        // An assigned field is no annotation element: it is not counted.
        occ(4, 4, 9, s("pkg/A#count."), 0),
        occ(5, 4, 5, s("pkg/A#g()."), 1),
        occ(6, 4, 5, s("pkg/A#f()."), 0),
        occ(8, 8, 9, s("pkg/A#`<init>`()."), 0),
        occ(9, 4, 10, s("java/lang/String#length()."), 0),
        occ(11, 4, 7, s("pkg/A#rec()."), 1),
        occ(12, 4, 7, s("pkg/A#rec()."), 0),
      ],
      "java",
    ),
    doc("Other.java", [occ(0, 0, 1, s("pkg/Other#"), 1)], "java"),
  ];
  const lines = linesOf(25, {
    3: "    name = 1",
    4: "    count = 2",
    6: "    f();",
    8: "    new A();",
    12: "    rec();",
  });

  it("scores symbols and calls with the maintainer's rules", async () => {
    const truth = await buildTruth({
      lang: "java",
      dump,
      documents,
      fileLines: () => lines,
      wantedLines: wantedLinesOf(dump),
    });
    expect(truth.scoredPaths).toEqual(["A.java"]);
    expect(truth.documentsNotIndexed).toBe(1);
    expect(truth.implicitDefs).toBe(1);
    expect(truth.annotationElementRefs).toBe(1);
    expect(truth.calls).toHaveLength(3);

    const symbols = scoreSymbols(dump, truth);
    expect(symbols.perKind.method).toEqual({ precision: frac(3, 4), recall: frac(3, 3) });
    expect(symbols.perKind.class).toEqual({ precision: frac(1, 1), recall: frac(1, 1) });

    const calls = scoreCalls(dump, truth);
    expect(calls.selfRecursive).toBe(1);
    expect(calls.recall).toEqual(frac(1, 3));
    expect(calls.recallMisses).toEqual({
      "self-recursive call (the graph leaves it out)": 1,
      "target is an implicit definition (a default constructor or an enum's own method): no symbol": 1,
    });
    expect(calls.precision.high).toEqual(frac(1, 1));
    expect(calls.precision.low).toEqual(frac(0, 1));
    expect(calls.precisionMisses).toEqual({
      "low: the index names a target outside the repo at the site": 1,
    });

    const metrics = barMetrics("java", symbols, calls);
    expect(metrics.find((m) => m.key === "calls.recall")?.bar).toBe(85);
    expect(metrics.every(barMet)).toBe(false);
  });
});

describe("python", () => {
  // m.py: Bar (1-5) with __init__ (2-3), Foo (7-9, no initializer), Base (16-19) with __init__ (17-18),
  // main (11-15) calling Bar() at line 12 and Foo() at line 13.
  const dump: Dump = {
    ...head("m.py", "python"),
    symbols: [
      sym("s:Bar", "Bar", "class", "python", 1, 5),
      sym("s:Bar.init", "Bar.__init__", "method", "python", 2, 3),
      sym("s:Foo", "Foo", "class", "python", 7, 9),
      sym("s:main", "main", "function", "python", 11, 15),
      sym("s:Base.init", "Base.__init__", "method", "python", 17, 18),
    ],
    edges: [
      edge("s:main", "s:Bar.init", "high", ["m.py:12"], 2),
      edge("s:main", "s:Base.init", "low", ["m.py:13"], 3),
    ],
  };
  const s = (rest: string) => `scip-python python p 1 ${rest}`;
  const documents = [
    doc(
      "m.py",
      [
        occ(0, 6, 9, s("m/Bar#"), 1),
        occ(1, 8, 16, s("m/Bar#__init__()."), 1),
        occ(6, 6, 9, s("m/Foo#"), 1),
        occ(10, 4, 8, s("m/main()."), 1),
        occ(11, 4, 7, s("m/Bar#"), 0),
        occ(12, 4, 7, s("m/Foo#"), 0),
        occ(13, 4, 7, s("m/print()."), 0),
      ],
      "python",
    ),
  ];
  const lines = linesOf(25, { 11: "    Bar()", 12: "    Foo()", 13: "    print" });

  it("leaves a class with no initializer out of the truth and out of precision", async () => {
    const truth = await buildTruth({
      lang: "python",
      dump,
      documents,
      fileLines: () => lines,
      wantedLines: wantedLinesOf(dump),
    });
    expect(truth.classCallsWithoutInit).toBe(1);
    expect(truth.calls).toHaveLength(1);
    const symbols = scoreSymbols(dump, truth);
    expect(symbols.perKind.function).toEqual({ precision: frac(1, 1), recall: frac(1, 1) });
    expect(symbols.perKind.method).toEqual({ precision: frac(1, 2), recall: frac(1, 1) });
    const calls = scoreCalls(dump, truth);
    expect(calls.recall).toEqual(frac(1, 1));
    expect(calls.precision.high).toEqual(frac(1, 1));
    expect(calls.precision.low).toEqual(frac(0, 0));
    expect(calls.precision.unverifiable).toBe(1);
  });

  it("accepts any definition of a symbol that is defined more than once", async () => {
    // o.py: f (1-2, an overload stub) and f~2 (4-5, the implementation) are one SCIP symbol; main (7-9) calls f.
    const overloaded: Dump = {
      ...head("o.py", "python"),
      symbols: [
        sym("s:f", "f", "function", "python", 1, 2),
        sym("s:f2", "f~2", "function", "python", 4, 5),
        sym("s:main", "main", "function", "python", 7, 9),
      ],
      edges: [edge("s:main", "s:f2", "high", ["o.py:8"], 2)],
    };
    const truth = await buildTruth({
      lang: "python",
      dump: overloaded,
      documents: [
        doc(
          "o.py",
          [
            occ(0, 4, 5, s("o/f()."), 1),
            occ(3, 4, 5, s("o/f()."), 8),
            occ(6, 4, 8, s("o/main()."), 1),
            occ(7, 4, 5, s("o/f()."), 0),
          ],
          "python",
        ),
      ],
      fileLines: () => linesOf(12, { 0: "def f(): ...", 3: "def f(): ...", 7: "    f()" }),
      wantedLines: wantedLinesOf(overloaded),
    });
    expect(scoreSymbols(overloaded, truth).perKind.function).toEqual({
      precision: frac(3, 3),
      recall: frac(3, 3),
    });
    const calls = scoreCalls(overloaded, truth);
    expect(calls.recall).toEqual(frac(1, 1));
    expect(calls.precision.high).toEqual(frac(1, 1));
  });

  it("counts a graph symbol once when two definitions map onto it", async () => {
    // g (1-3) holds the lines of both definitions of one SCIP symbol; the other symbol, h (5-6), is not defined.
    const twice: Dump = {
      ...head("t.py", "python"),
      symbols: [sym("s:g", "g", "function", "python", 1, 3), sym("s:h", "h", "function", "python", 5, 6)],
      edges: [],
    };
    const truth = await buildTruth({
      lang: "python",
      dump: twice,
      documents: [doc("t.py", [occ(0, 4, 5, s("t/g()."), 1), occ(1, 4, 5, s("t/g()."), 1)], "python")],
      fileLines: () => linesOf(8, {}),
      wantedLines: new Set(),
    });
    expect(scoreSymbols(twice, truth).perKind.function).toEqual({
      precision: frac(1, 2),
      recall: frac(1, 2),
    });
  });

  it("takes the worst value of each metric over the runs", () => {
    const base = barMetrics(
      "python",
      scoreSymbols(dump, { ...emptyTruth() }),
      scoreCalls(dump, emptyTruth()),
    );
    const worse = base.map((m) => (m.key === "calls.recall" ? { ...m, value: frac(1, 4) } : m));
    const best = base.map((m) => (m.key === "calls.recall" ? { ...m, value: frac(3, 4) } : m));
    expect(worstOf([best, worse, best]).find((m) => m.key === "calls.recall")?.value).toEqual(frac(1, 4));
  });
});

function emptyTruth() {
  return {
    lang: "python" as const,
    scoredPaths: [],
    documentsNotIndexed: 0,
    filesWithoutDocument: 0,
    defs: [],
    implicitDefs: 0,
    annotationElementRefs: 0,
    calls: [],
    classCallsWithoutInit: 0,
    exemptSites: [],
    sites: {},
  };
}

describe("command line", () => {
  it("refuses an unknown repo and a bad run count with exit 2", () => {
    expect(run(["--only", "nope"]).code).toBe(2);
    expect(run(["--runs", "0"]).code).toBe(2);
    expect(run(["--runs", "1", "--bogus"]).code).toBe(2);
  });
});

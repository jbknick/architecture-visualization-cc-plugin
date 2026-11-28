import { describe, expect, it } from "vitest";
import { type ClojureDump, type Kondo, scoreClojure } from "./eval-clojure.js";

const sym = (path: string, name: string, kind: string, startLine: number, endLine: number) => ({
  id: `sym:r:${path}#${name}`,
  fileId: `file:r:${path}`,
  name,
  kind,
  startLine,
  endLine,
});

// A synthetic graph and analysis: no clone, no clj-kondo, no network.
const dump: ClojureDump = {
  files: [
    { id: "file:r:src/a.clj", path: "src/a.clj", lang: "clojure" },
    { id: "file:r:src/b.clj", path: "src/b.clj", lang: "clojure" },
  ],
  symbols: [
    sym("src/a.clj", "f", "function", 3, 5),
    sym("src/a.clj", "g", "function", 7, 8),
    sym("src/b.clj", "P", "interface", 1, 2),
    sym("src/b.clj", "P.m", "method", 2, 2),
    sym("src/b.clj", "h", "function", 4, 4),
    sym("src/b.clj", "mm.:x", "method", 6, 6),
  ],
  edges: [
    { src: "sym:r:src/a.clj#f", dst: "sym:r:src/b.clj#h", kind: "calls", confidence: "high", level: 1 },
    { src: "sym:r:src/a.clj#f", dst: "sym:r:src/b.clj#P.m", kind: "calls", confidence: "high", level: 1 },
    { src: "sym:r:src/a.clj#g", dst: "sym:r:src/a.clj#f", kind: "calls", confidence: "low", level: 1 },
  ],
};

const kondo: Kondo = {
  analysis: {
    "namespace-definitions": [
      { filename: "./src/a.clj", name: "a" },
      { filename: "./src/b.clj", name: "b" },
    ],
    "var-definitions": [
      { filename: "./src/a.clj", ns: "a", name: "f" },
      { filename: "./src/a.clj", ns: "a", name: "g" },
      { filename: "./src/b.clj", ns: "b", name: "P" },
      { filename: "./src/b.clj", ns: "b", name: "m" },
      { filename: "./src/b.clj", ns: "b", name: "h" },
      { filename: "./src/b.clj", ns: "b", name: "k", "defined-by": "clojure.core/def" },
    ],
    "var-usages": [
      { filename: "./src/a.clj", from: "a", to: "b", name: "h", row: 4 },
      { filename: "./src/a.clj", from: "a", to: "b", name: "m", row: 5 },
      { filename: "./src/a.clj", from: "a", to: "b", name: "k", row: 5 },
      { filename: "./src/a.clj", from: "a", to: "a", name: "f", row: 4 }, // f's own var
      { filename: "./src/a.clj", from: "a", to: "b", name: "h", row: 1 }, // the ns form
      { filename: "./src/a.clj", from: "a", to: "clojure.core", name: "map", row: 4 },
    ],
  },
};

describe("clojure proof scoring", () => {
  it("scores symbols by file and var, and leaves defmethods out", () => {
    const s = scoreClojure(dump, kondo);
    expect(s.scoredFiles).toBe(2);
    expect(s.symbols.precision).toEqual({ n: 5, d: 5 });
    expect(s.symbols.recall).toEqual({ n: 5, d: 6 });
    expect(s.symbols.defmethods).toBe(1);
    expect(s.symbols.missedBy).toEqual({ "clojure.core/def": 1 });
  });

  it("scores calls from the innermost symbol that holds the usage, leaving out its own var and usages outside", () => {
    const c = scoreClojure(dump, kondo).calls;
    expect(c.truthPairs).toBe(3);
    expect(c.selfReferences).toBe(1);
    expect(c.outsideDefinitions).toBe(1);
    expect(c.recall).toEqual({ n: 2, d: 3 });
    expect(c.missedNoSymbol).toBe(1);
    expect(c.precisionHigh).toEqual({ n: 2, d: 2 });
    expect(c.precisionLow).toEqual({ n: 0, d: 1 });
  });
});

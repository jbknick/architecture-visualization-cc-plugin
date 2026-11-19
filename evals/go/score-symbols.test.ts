import { describe, expect, it } from "vitest";
import { passes, scoreSymbols } from "./score-symbols.js";

const files = [
  { id: "file:r:a.go", path: "a.go", lang: "go" },
  { id: "file:r:a_test.go", path: "a_test.go", lang: "go" },
];
const sym = (fileId: string, name: string, kind: string) => ({ fileId, name, kind, lang: "go" });

describe("score-symbols", () => {
  const truth = {
    module: "example.com/m",
    symbols: [
      { file: "a.go", name: "F", kind: "function" },
      { file: "a.go", name: "Get", receiver: "S", kind: "method" },
      { file: "a.go", name: "S", kind: "struct" },
      { file: "a.go", name: "v", kind: "var" },
      { file: "a.go", name: "c", kind: "const" },
    ],
  };

  it("maps struct to class and var to const, splits method names, ignores test files", () => {
    const dump = {
      files,
      symbols: [
        sym("file:r:a.go", "F", "function"),
        sym("file:r:a.go", "S.Get", "method"),
        sym("file:r:a.go", "S", "class"),
        sym("file:r:a.go", "v", "const"),
        sym("file:r:a.go", "c", "const"),
        sym("file:r:a_test.go", "TestF", "function"),
      ],
    };
    const s = scoreSymbols(dump, truth);
    expect(s.repo).toBe("example.com/m");
    expect(s.perKind.const).toEqual({ truth: 2, found: 2, matched: 2, precision: 1, recall: 1 });
    expect(s.all).toMatchObject({ truth: 5, found: 5, matched: 5 });
    expect(passes(s)).toBe(true);
  });

  it("ignores the methods of an interface body", () => {
    const dump = {
      files,
      symbols: [
        sym("file:r:a.go", "S.Get", "method"),
        sym("file:r:a.go", "Reader", "interface"),
        sym("file:r:a.go", "Reader.Get", "method"),
      ],
    };
    const s = scoreSymbols(dump, {
      module: "example.com/m",
      symbols: [
        { file: "a.go", name: "Get", receiver: "S", kind: "method" },
        { file: "a.go", name: "Reader", kind: "interface" },
      ],
    });
    expect(s.perKind.method).toEqual({ truth: 1, found: 1, matched: 1, precision: 1, recall: 1 });
  });

  it("fails a kind that misses or invents symbols", () => {
    const dump = {
      files,
      symbols: [sym("file:r:a.go", "F", "function"), sym("file:r:a.go", "Extra", "function")],
    };
    const s = scoreSymbols(dump, truth);
    expect(s.perKind.function).toMatchObject({ truth: 1, found: 2, matched: 1, precision: 0.5, recall: 1 });
    expect(s.perKind.method?.recall).toBe(0);
    expect(passes(s)).toBe(false);
  });
});

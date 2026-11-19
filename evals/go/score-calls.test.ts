import { describe, expect, it } from "vitest";
import { passes, scoreCalls } from "./score-calls.js";

const sym = (path: string, name: string, kind: string) => ({
  id: `sym:r:${path}#${name}`,
  fileId: `file:r:${path}`,
  name,
  kind,
  lang: "go",
});
const edge = (kind: string, src: string, dst: string) => ({ kind, src, dst });
const file = (path: string) => ({ id: `file:r:${path}`, path, lang: "go" });

const dump = {
  workspaces: [{ name: "example.com/m", dir: ".", lang: "go" }],
  files: [file("a/a.go"), file("a/b.go"), file("b/b.go")],
  symbols: [
    sym("a/a.go", "Caller", "function"),
    sym("a/a.go", "helper", "function"),
    sym("a/a.go", "T", "class"),
    sym("a/a.go", "T.Run", "method"),
    sym("a/b.go", "Reader", "interface"),
    sym("a/b.go", "Reader.Get", "method"),
    sym("b/b.go", "Fn", "function"),
  ],
  edges: [
    edge("calls", "sym:r:a/a.go#Caller", "sym:r:a/a.go#helper"),
    edge("calls", "sym:r:a/a.go#Caller", "sym:r:b/b.go#Fn"),
    edge("calls", "sym:r:a/a.go#Caller", "sym:r:a/a.go#T.Run"),
    edge("calls", "sym:r:a/a.go#Caller", "sym:r:a/b.go#Reader.Get"),
    edge("implements", "sym:r:a/a.go#T", "sym:r:a/b.go#Reader"),
  ],
};
const call = (kind: string, name: string, callee: string) => ({
  file: "a/a.go",
  name,
  caller: "Caller",
  kind,
  callee,
  inRepo: true,
});
const truth = {
  module: "example.com/m",
  callFiles: ["a/a.go", "a/b.go", "b/b.go"],
  calls: [
    call("same-package", "helper", "example.com/m/a.helper"),
    call("same-package", "helper", "example.com/m/a.helper"),
    call("pkg-qualified", "Fn", "example.com/m/b.Fn"),
    call("method", "Run", "example.com/m/a.T.Run"),
    call("interface-method", "Get", "example.com/m/a.Reader.Get"),
    call("method", "Extra", "example.com/m/a.T.Extra"),
    {
      file: "a/a.go",
      name: "Printf",
      caller: "Caller",
      kind: "pkg-qualified",
      callee: "fmt.Printf",
      inRepo: false,
    },
  ],
  implementers: { "example.com/m/a.Reader": ["example.com/m/a.T", "example.com/m/a.U"] },
};

describe("score-calls", () => {
  const s = scoreCalls(dump, truth);

  it("counts one truth edge per (caller, callee) with the kind of its first site, in-repo only", () => {
    expect(s.perKind.samePackage).toEqual({ truth: 1, matched: 1, recall: 1 });
    expect(s.perKind.qualified).toEqual({ truth: 1, matched: 1, recall: 1 });
    expect(s.perKind.concreteMethod).toEqual({ truth: 2, matched: 1, recall: 0.5 });
    expect(s.perKind.interfaceMethod).toEqual({ truth: 1, matched: 1, recall: 1 });
    expect(s.perKind.promoted.truth).toBe(0);
    expect(s.all).toEqual({ truth: 5, matched: 4, recall: 0.8, found: 4 });
  });

  it("scores precision and implements pairs", () => {
    expect(s.precision).toBe(1);
    expect(s.implements).toEqual({ truth: 2, found: 1, matched: 1, recall: 0.5, precision: 1 });
  });

  it("fails on a wrong edge or a missed concrete method", () => {
    expect(passes(s)).toBe(false);
    const wrong = scoreCalls(
      { ...dump, edges: [...dump.edges, edge("calls", "sym:r:a/a.go#Caller", "sym:r:a/a.go#T")] },
      truth,
    );
    expect(wrong.precision).toBe(0.8);
  });

  it("maps a file of a nested module through its own module path", () => {
    const nested = scoreCalls(
      { ...dump, workspaces: [...dump.workspaces, { name: "example.com/other", dir: "b", lang: "go" }] },
      truth,
    );
    expect(nested.perKind.qualified.matched).toBe(0);
  });
});

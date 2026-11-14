import { describe, expect, it } from "vitest";
import {
  type BenchResults,
  evaluate,
  exitCode,
  formatReport,
  median,
  parseSummary,
  unresolvedPct,
} from "./m1-report.js";

const SHA = "a".repeat(64);

function good(over: Partial<BenchResults> = {}): BenchResults {
  const run = {
    wallMs: 5000,
    indexMs: 4800,
    files: 100,
    symbols: 500,
    functionLike: 300,
    edges: 900,
    unresolved: 3,
    parseErrors: 0,
  };
  return {
    runs: 3,
    init: [run, { ...run, wallMs: 5200 }, { ...run, wallMs: 4900 }],
    specifiers: { file: 990, unresolved: 10, generated: 4, excluded: 0 },
    shaA: SHA,
    shaB: SHA,
    refreshMs: 300,
    noopSearchMs: 250,
    editVisible: true,
    stashHealed: true,
    fullSuite: true,
    healMatrix: true,
    ...over,
  };
}

const status = (r: BenchResults, id: string) => evaluate(r).find((l) => l.id === id)?.met;

describe("m1 report", () => {
  it("takes medians of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("parses the CLI summary", () => {
    const text = [
      "Indexed 1529 files in 1234 ms",
      "  symbols:       9000",
      "  function-like: 5400",
      "  edges:         12000",
      "  unresolved:    7",
      "  parse errors:  0",
      "  data:          /tmp/x",
    ].join("\n");
    expect(parseSummary(text)).toEqual({
      files: 1529,
      indexMs: 1234,
      symbols: 9000,
      functionLike: 5400,
      edges: 12000,
      unresolved: 7,
      parseErrors: 0,
    });
    expect(() => parseSummary("nothing")).toThrow();
  });

  it("computes the unresolved share over internal specifiers", () => {
    expect(unresolvedPct({ file: 95, unresolved: 5, generated: 9, excluded: 9 })).toBe(5);
    expect(unresolvedPct({ file: 0, unresolved: 0, generated: 0, excluded: 0 })).toBe(0);
  });

  it("meets every line on a good run and exits 0", () => {
    const lines = evaluate(good());
    expect(lines.every((l) => l.met === true)).toBe(true);
    expect(exitCode(lines)).toBe(0);
  });

  it("misses perf at 120 s but not just under", () => {
    const slow = good();
    slow.init = slow.init.map((i) => ({ ...i, wallMs: 120_000 }));
    expect(status(slow, "perf")).toBe(false);
    const ok = good();
    ok.init = ok.init.map((i) => ({ ...i, wallMs: 119_999 }));
    expect(status(ok, "perf")).toBe(true);
  });

  it("misses the refresh budget at 1,000 ms but not just under (NaN also misses)", () => {
    expect(status(good({ refreshMs: 1000 }), "refresh")).toBe(false);
    expect(status(good({ refreshMs: 999 }), "refresh")).toBe(true);
    expect(status(good({ refreshMs: Number.NaN }), "refresh")).toBe(false);
  });

  it("misses resolution at 5% but not under", () => {
    const at = { file: 95, unresolved: 5, generated: 0, excluded: 0 };
    const under = { file: 951, unresolved: 49, generated: 0, excluded: 0 };
    expect(status(good({ specifiers: at }), "resolve")).toBe(false);
    expect(status(good({ specifiers: under }), "resolve")).toBe(true);
  });

  it("misses determinism when hashes differ", () => {
    const r = good({ shaB: "b".repeat(64) });
    expect(status(r, "determinism")).toBe(false);
    expect(exitCode(evaluate(r))).toBe(1);
  });

  it("misses git-flow when the edit is invisible, the stash does not heal, or the matrix fails", () => {
    expect(status(good({ editVisible: false }), "gitflow")).toBe(false);
    expect(status(good({ stashHealed: false }), "gitflow")).toBe(false);
    expect(status(good({ healMatrix: false }), "gitflow")).toBe(false);
  });

  it("treats skipped tests as not run, not as a miss", () => {
    const r = good({ fullSuite: null, healMatrix: null });
    expect(status(r, "tests")).toBeNull();
    expect(status(r, "gitflow")).toBeNull();
    expect(exitCode(evaluate(r))).toBe(0);
    expect(status(good({ fullSuite: false }), "tests")).toBe(false);
  });

  it("renders a table with aggregates only and a verdict per line", () => {
    const text = formatReport(good({ calcom: { files: 5000, wallMs: 30_000, packagesResolved: false } }));
    expect(text).toContain("| Metric");
    expect(text).toContain("5000 ms");
    expect(text).toContain("10 of 1000 (1.00%)");
    expect(text).toContain("Cal.com shallow clone");
    expect(text).toContain("packages unresolved");
    expect(text.match(/\[MET\]/g)?.length).toBe(6);
    expect(formatReport(good({ shaB: "b".repeat(64) }))).toContain("[MISSED]");
  });
});

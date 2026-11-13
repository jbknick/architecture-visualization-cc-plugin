import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accuracyAt, cosine, normalizeCode, parsePairs, separation } from "./lib.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("normalizeCode", () => {
  it("renames identifiers in order of appearance and replaces strings", () => {
    const out = normalizeCode(`function add(a, b) { return a + b + "x"; }`);
    expect(out).toBe(`function v1(v2, v3) { return v2 + v3 + "s"; }`);
  });

  it("maps the same logic with different names to the same output", () => {
    const a = normalizeCode(`const total = items.length; // count`);
    const b = normalizeCode(`const n = list.length; /* size */`);
    expect(a).toBe(b);
  });

  it("keeps members and globals only in the semi variant", () => {
    const src = `const x = Math.max(a.length, 1);`;
    expect(normalizeCode(src)).toBe("const v1 = v2.v3(v4.v5, 1);");
    expect(normalizeCode(src, { keepMembersAndGlobals: true })).toBe("const v1 = Math.max(v2.length, 1);");
  });

  it("leaves regex literals intact and treats division as an operator", () => {
    expect(normalizeCode(`s.replace(/[^a-z"]+/g, "-")`)).toBe(`v1.v2(/[^a-z"]+/g, "s")`);
    expect(normalizeCode("a / b / c")).toBe("v1 / v2 / v3");
  });

  it("collapses template literals", () => {
    const template = ["const m = `hi $", "{name}`;"].join("");
    expect(normalizeCode(template)).toBe('const v1 = "s";');
  });
});

describe("scoring helpers", () => {
  it("computes cosine similarity", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("finds a separating threshold", () => {
    const s = separation([0.9, 0.8, 0.85], [0.3, 0.5, 0.6]);
    expect(s.bestAccuracy).toBe(1);
    expect(s.bestThreshold).toBeGreaterThan(0.6);
    expect(s.bestThreshold).toBeLessThanOrEqual(0.8);
    expect(accuracyAt([0.9], [0.1], 0.5)).toBe(1);
  });
});

describe("pairs.jsonl", () => {
  const pairs = parsePairs(readFileSync(join(here, "pairs.jsonl"), "utf8"));

  it("has 15 same and 15 different pairs for each of descriptions and code", () => {
    for (const kind of ["description", "code"] as const) {
      const ps = pairs.filter((p) => p.kind === kind);
      expect(ps.filter((p) => p.same)).toHaveLength(15);
      expect(ps.filter((p) => !p.same)).toHaveLength(15);
    }
  });

  it("normalizes most same-logic code pairs to identical text", () => {
    const same = pairs.filter((p) => p.kind === "code" && p.same);
    const identical = same.filter((p) => normalizeCode(p.a) === normalizeCode(p.b));
    expect(identical.length).toBeGreaterThanOrEqual(12);
  });
});

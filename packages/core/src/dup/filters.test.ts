import { describe, expect, it } from "vitest";
import {
  asyncHint,
  isExcludedPath,
  isFixturePath,
  isGeneratedPath,
  isTestPath,
  kindFamily,
  matchesIgnore,
  pairKey,
  paramCount,
  signatureShape,
  signaturesCompatible,
} from "./filters.js";

describe("kindFamily", () => {
  it("groups function with method, and keeps component and hook apart", () => {
    expect(kindFamily("function")).toBe("function");
    expect(kindFamily("method")).toBe("function");
    expect(kindFamily("component")).toBe("component");
    expect(kindFamily("hook")).toBe("hook");
    for (const k of ["class", "type", "interface", "enum", "const"] as const)
      expect(kindFamily(k)).toBeNull();
  });
});

describe("path filters", () => {
  it("recognises tests, fixtures and generated files", () => {
    for (const p of ["a.test.ts", "src/a.spec.tsx", "src/__tests__/x.ts", "x/y.test.mts"]) {
      expect(isTestPath(p)).toBe(true);
    }
    for (const p of ["src/test.ts", "src/latest.ts", "src/testing/util.ts"])
      expect(isTestPath(p)).toBe(false);
    for (const p of ["fixtures/a.ts", "pkg/fixture/a.ts", "src/__fixtures__/a.ts", "src/__mocks__/a.ts"]) {
      expect(isFixturePath(p)).toBe(true);
    }
    expect(isFixturePath("src/fixturesHelper.ts")).toBe(false);
    for (const p of [
      "a.gen.ts",
      "src/routeTree.gen.ts",
      "x.generated.ts",
      "src/generated/a.ts",
      "__generated__/a.ts",
    ]) {
      expect(isGeneratedPath(p)).toBe(true);
    }
    expect(isGeneratedPath("src/generator.ts")).toBe(false);
    expect(isExcludedPath("src/ok.ts")).toBe(false);
    expect(isExcludedPath("src/ok.test.ts")).toBe(true);
  });

  it("matches duplicates.ignore globs", () => {
    expect(matchesIgnore("legacy/a/b.ts", ["legacy/**"])).toBe(true);
    expect(matchesIgnore("src/x.ts", ["legacy/**", "**/*.stories.tsx"])).toBe(false);
    expect(matchesIgnore("src/x.stories.tsx", ["**/*.stories.tsx"])).toBe(true);
    expect(matchesIgnore(".hidden/x.ts", [".hidden/**"])).toBe(true);
    expect(matchesIgnore("a.ts", [])).toBe(false);
  });
});

describe("signatures", () => {
  it("counts parameters", () => {
    expect(paramCount("(): void")).toBe(0);
    expect(paramCount("(a: string)")).toBe(1);
    expect(paramCount("(a: string, b?: number): string")).toBe(2);
    expect(paramCount("<T>(a: T, b: T[]): T")).toBe(2);
    expect(paramCount("<T extends Record<string, number>>(a: T): T")).toBe(1);
    expect(paramCount("({ a, b }: { a: number; b: number }, c: number)")).toBe(2);
    expect(paramCount("(cb: (x: number, y: number) => void, n = 1)")).toBe(2);
    expect(paramCount("(a: Map<string, number>, ...rest: string[])")).toBe(2);
    expect(paramCount("(a: 1, b: 2,)")).toBe(2);
    expect(paramCount("")).toBeUndefined();
    expect(paramCount("not a signature")).toBeUndefined();
  });

  it("reads async-ness from the return annotation only", () => {
    expect(asyncHint("(a: string): Promise<string>")).toBe(true);
    expect(asyncHint("(a: string): Promise<Map<string, number>>")).toBe(true);
    expect(asyncHint("(a: string): string")).toBe(false);
    expect(asyncHint("(cb: () => Promise<void>): void")).toBe(false);
    expect(asyncHint("(a: string)")).toBeUndefined();
  });

  it("is compatible within one parameter and when async-ness does not contradict", () => {
    const s = signatureShape;
    expect(signaturesCompatible(s("(a: 1): string"), s("(a: 1, b: 2): string"))).toBe(true);
    expect(signaturesCompatible(s("(a: 1): string"), s("(a: 1, b: 2, c: 3): string"))).toBe(false);
    expect(signaturesCompatible(s("(a: 1): string"), s("(a: 1): Promise<string>"))).toBe(false);
    expect(signaturesCompatible(s("(a: 1)"), s("(a: 1): Promise<string>"))).toBe(true);
    expect(signaturesCompatible(s(""), s("(a: 1): string"))).toBe(true);
  });

  it("pair keys ignore order", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
    expect(pairKey("a", "b")).not.toBe(pairKey("a", "c"));
  });
});

import { describe, expect, it } from "vitest";
import { isLang, LANG_IDS, langLabel, languageModule, languageOfPath, languages } from "./index.js";

describe("language registry", () => {
  it("picks TypeScript for .ts .tsx .mts .cts", () => {
    for (const p of ["a.ts", "src/b.tsx", "c.mts", "d/e.cts"]) {
      expect(languageOfPath(p)?.id).toBe("typescript");
    }
  });

  it("claims no other file, Go included until its module exists", () => {
    for (const p of ["main.go", "a.js", "a.d", "README", "a.tsx.map"]) {
      expect(languageOfPath(p)).toBeUndefined();
    }
  });

  it("holds only TypeScript in this build", () => {
    expect(languages().map((m) => m.id)).toEqual(["typescript"]);
    expect(LANG_IDS).toEqual(["typescript", "go"]); // Go can be named (`--lang go`) before its module exists
    expect(isLang("typescript")).toBe(true);
    expect(isLang("go")).toBe(true);
    expect(isLang("rust")).toBe(false);
    expect(langLabel("typescript")).toBe("TypeScript");
    expect(langLabel("go")).toBe("go");
    expect(() => languageModule("go")).toThrow();
  });

  it("labels every symbol kind", () => {
    const m = languageModule("typescript");
    expect(m.kindLabels.component).toBe("component");
    expect(m.kindLabels.hook).toBe("hook");
  });
});

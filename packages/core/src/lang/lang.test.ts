import { describe, expect, it } from "vitest";
import { isLang, LANG_IDS, langLabel, languageModule, languageOfPath, languages } from "./index.js";

describe("language registry", () => {
  it("picks TypeScript for .ts .tsx .mts .cts", () => {
    for (const p of ["a.ts", "src/b.tsx", "c.mts", "d/e.cts"]) {
      expect(languageOfPath(p)?.id).toBe("typescript");
    }
  });

  it("picks Go for .go and claims no other file", () => {
    expect(languageOfPath("cmd/main.go")?.id).toBe("go");
    for (const p of ["a.js", "a.d", "README", "a.tsx.map", "go.mod"]) {
      expect(languageOfPath(p)).toBeUndefined();
    }
  });

  it("holds TypeScript and Go", () => {
    expect(languages().map((m) => m.id)).toEqual(["typescript", "go"]);
    expect(LANG_IDS).toEqual(["typescript", "go"]);
    expect(isLang("typescript")).toBe(true);
    expect(isLang("go")).toBe(true);
    expect(isLang("rust")).toBe(false);
    expect(langLabel("typescript")).toBe("TypeScript");
    expect(langLabel("go")).toBe("Go");
    expect(languageModule("go").label).toBe("Go");
  });

  it("labels every symbol kind", () => {
    const m = languageModule("typescript");
    expect(m.kindLabels.component).toBe("component");
    expect(m.kindLabels.hook).toBe("hook");
  });

  it("labels a Go class as a struct", () => {
    expect(languageModule("go").kindLabels.class).toBe("struct");
  });

  it("skips vendor, testdata and dot folders for Go only", () => {
    const skip = languageModule("go").skipPath;
    expect(skip?.("vendor/x/y.go")).toBe(true);
    expect(skip?.("a/testdata/y.go")).toBe(true);
    expect(skip?.("a/.hidden/y.go")).toBe(true);
    expect(skip?.("a/vendorized/y.go")).toBe(false);
    expect(skip?.("a/y.go")).toBe(false);
  });
});

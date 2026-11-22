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

  it("picks Java for .java", () => {
    expect(languageOfPath("src/main/java/a/App.java")?.id).toBe("java");
  });

  it("holds TypeScript, Go and Java", () => {
    expect(languages().map((m) => m.id)).toEqual(["typescript", "go", "java"]);
    expect(LANG_IDS).toEqual(["typescript", "go", "java"]);
    expect(isLang("typescript")).toBe(true);
    expect(isLang("go")).toBe(true);
    expect(isLang("java")).toBe(true);
    expect(isLang("rust")).toBe(false);
    expect(langLabel("typescript")).toBe("TypeScript");
    expect(langLabel("go")).toBe("Go");
    expect(langLabel("java")).toBe("Java");
    expect(languageModule("go").label).toBe("Go");
  });

  it("skips target, build and .gradle folders for Java", () => {
    const skip = languageModule("java").skipPath;
    expect(skip?.("core/target/classes/A.java")).toBe(true);
    expect(skip?.("build/generated/A.java")).toBe(true);
    expect(skip?.(".gradle/x/A.java")).toBe(true);
    expect(skip?.("core/src/main/java/A.java")).toBe(false);
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

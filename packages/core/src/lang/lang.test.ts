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

  it("picks Python for .py and .pyi", () => {
    expect(languageOfPath("src/acme/cli.py")?.id).toBe("python");
    expect(languageOfPath("src/acme/cli.pyi")?.id).toBe("python");
    expect(languageOfPath("src/acme/cli.pyc")).toBeUndefined();
  });

  it("picks C# for .cs", () => {
    expect(languageOfPath("src/Core/Report.cs")?.id).toBe("csharp");
    expect(languageOfPath("src/Core/Core.csproj")).toBeUndefined();
  });

  it("picks Rust for .rs", () => {
    expect(languageOfPath("crates/core/src/lib.rs")?.id).toBe("rust");
    expect(languageOfPath("crates/core/Cargo.toml")).toBeUndefined();
  });

  it("picks Clojure for .clj, .cljs and .cljc", () => {
    expect(languageOfPath("src/acme/core.clj")?.id).toBe("clojure");
    expect(languageOfPath("src/acme/view.cljs")?.id).toBe("clojure");
    expect(languageOfPath("src/acme/util.cljc")?.id).toBe("clojure");
    expect(languageOfPath("deps.edn")).toBeUndefined();
  });

  it("holds TypeScript, Go, Java, Python, C#, Rust and Clojure", () => {
    const ids = ["typescript", "go", "java", "python", "csharp", "rust", "clojure"];
    expect(languages().map((m) => m.id)).toEqual(ids);
    expect(LANG_IDS).toEqual(ids);
    expect(isLang("typescript")).toBe(true);
    expect(isLang("go")).toBe(true);
    expect(isLang("java")).toBe(true);
    expect(isLang("python")).toBe(true);
    expect(isLang("csharp")).toBe(true);
    expect(isLang("rust")).toBe(true);
    expect(isLang("clojure")).toBe(true);
    expect(isLang("ruby")).toBe(false);
    expect(langLabel("typescript")).toBe("TypeScript");
    expect(langLabel("go")).toBe("Go");
    expect(langLabel("java")).toBe("Java");
    expect(langLabel("python")).toBe("Python");
    expect(langLabel("csharp")).toBe("C#");
    expect(langLabel("rust")).toBe("Rust");
    expect(langLabel("clojure")).toBe("Clojure");
    expect(languageModule("go").label).toBe("Go");
  });

  it("skips target folders for Rust", () => {
    const skip = languageModule("rust").skipPath;
    expect(skip?.("crates/core/target/debug/build/a.rs")).toBe(true);
    expect(skip?.("crates/core/src/lib.rs")).toBe(false);
  });

  it("skips bin and obj folders for C#", () => {
    const skip = languageModule("csharp").skipPath;
    expect(skip?.("src/Core/obj/Debug/A.cs")).toBe(true);
    expect(skip?.("src/Core/bin/Release/A.cs")).toBe(true);
    expect(skip?.("src/Core/Report.cs")).toBe(false);
  });

  it("skips virtual environments, caches, installed packages and build folders for Python", () => {
    const skip = languageModule("python").skipPath;
    expect(skip?.(".venv/lib/site.py")).toBe(true);
    expect(skip?.("venv/lib/site.py")).toBe(true);
    expect(skip?.("src/acme/__pycache__/a.py")).toBe(true);
    expect(skip?.("lib/site-packages/x/a.py")).toBe(true);
    expect(skip?.("build/lib/a.py")).toBe(true);
    expect(skip?.("dist/a.py")).toBe(true);
    expect(skip?.("src/acme/a.py")).toBe(false);
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

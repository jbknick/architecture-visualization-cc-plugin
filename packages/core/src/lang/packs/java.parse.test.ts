import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashStreams } from "../../hash/index.js";
import { isExportedName, parseWithPack } from "../engine/parse.js";
import { embeddingTextWithPack, streamsWithPack } from "../engine/streams.js";
import { packDependsOnEdges } from "../engine/workspace.js";
import { readXml } from "../engine/xml.js";
import { languageModule } from "../index.js";
import { javaPack } from "./index.js";

const parse = (src: string, path = "src/main/java/p/A.java") => parseWithPack(javaPack, "r", path, src);
const byName = (src: string) => new Map(parse(src).symbols.map((s) => [s.name, s]));

describe("java symbols", () => {
  const src = `package p;

import java.util.List;

@Service
public class Outer<T> extends Base implements A, B {
    private int count;
    public Outer(int n) { this.count = n; }
    public String name() { return "x"; }
    void helper() {}
    public static class Nested {
        public void go() {}
    }
    class Inner { void ping() {} }
    interface Local { void m(); }
}

interface Api {
    void run();
    default int size() { return 1; }
}

enum Color {
    RED, GREEN;
    Color next() { return RED; }
}

record Point(int x, int y) {
    Point { }
    int sum() { return x + y; }
}

@interface Marker { String value(); }
`;

  it("names classes, nested types and the methods in their bodies by the types around them", () => {
    const m = byName(src);
    expect([...m.keys()]).toEqual([
      "Outer",
      "Outer.Outer",
      "Outer.name",
      "Outer.helper",
      "Outer.Nested",
      "Outer.Nested.go",
      "Outer.Inner",
      "Outer.Inner.ping",
      "Outer.Local",
      "Outer.Local.m",
      "Api",
      "Api.run",
      "Api.size",
      "Color",
      "Color.next",
      "Point",
      "Point.Point",
      "Point.sum",
      "Marker",
    ]);
  });

  it("maps declarations to symbol kinds", () => {
    const m = byName(src);
    expect(m.get("Outer")?.kind).toBe("class");
    expect(m.get("Api")?.kind).toBe("interface");
    expect(m.get("Color")?.kind).toBe("enum");
    expect(m.get("Point")?.kind).toBe("class");
    expect(m.get("Marker")?.kind).toBe("interface");
    expect(m.get("Outer.name")?.kind).toBe("method");
    expect(m.get("Outer.Outer")?.kind).toBe("method");
  });

  it("is exported by the `public` modifier, and by being a member of an interface", () => {
    const m = byName(src);
    expect(m.get("Outer")?.exported).toBe(true);
    expect(m.get("Outer.name")?.exported).toBe(true);
    expect(m.get("Outer.helper")?.exported).toBe(false);
    expect(m.get("Outer.Inner")?.exported).toBe(false);
    expect(m.get("Api")?.exported).toBe(false);
    expect(m.get("Api.run")?.exported).toBe(true);
    expect(m.get("Api.size")?.exported).toBe(true);
  });

  it("keeps overloads apart by the order of the file, as repeated names always are", () => {
    const p = parse("class A { void f(int a) {} void f(int a, int b) {} }");
    expect(p.symbols.map((s) => s.id)).toEqual([
      "sym:r:src/main/java/p/A.java#A",
      "sym:r:src/main/java/p/A.java#A.f",
      "sym:r:src/main/java/p/A.java#A.f~2",
    ]);
  });

  it("writes the signature as the parameters and the type before the name", () => {
    const m = byName("class A { public static String join(String a, int b) { return a; } A() {} }");
    expect(m.get("A.join")?.signature).toBe("(String a, int b) String");
    expect(m.get("A.A")?.signature).toBe("()");
  });

  it("measures the body of a method", () => {
    const m = byName(
      "class A { int f(int a) { if (a > 0 && a < 9) { return 1; } for (int i = 0; i < a; i++) { a++; } return 0; } }",
    );
    expect(m.get("A.f")?.complexity).toBe(4);
    expect(m.get("A.f")?.stmtCount).toBe(6);
    expect(m.get("A")?.stmtCount).toBe(0);
  });

  it("reports a syntax error and still returns what it read", () => {
    const p = parse("class A { void f() {} ?? }");
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.symbols.map((s) => s.name)).toEqual(["A", "A.f"]);
  });
});

describe("java imports", () => {
  it("keeps single, on-demand and static imports with what they bring in", () => {
    const p = parse(`package p;
import com.acme.core.Greeter;
import com.acme.util.*;
import static com.acme.core.Strings.shout;
import static com.acme.core.Strings.*;
`);
    expect(p.imports.map((i) => [i.local, i.imported, i.specifier, i.line])).toEqual([
      ["Greeter", "Greeter", "com.acme.core", 2],
      ["*", "*", "com.acme.util", 3],
      ["shout", "shout", "com.acme.core.Strings", 4],
      ["*", "*", "com.acme.core.Strings", 5],
    ]);
  });
});

describe("java generated files", () => {
  it("marks a file by the @Generated annotation or by its path", () => {
    expect(parse('@Generated("x")\nclass A {}').directives).toEqual(["generated"]);
    expect(parse('@javax.annotation.processing.Generated("x")\nclass A {}').directives).toEqual([
      "generated",
    ]);
    expect(parse("class A {}", "app/generated/A.java").directives).toEqual(["generated"]);
    expect(parse("class A {}", "app/target/generated-sources/A.java").directives).toEqual(["generated"]);
    expect(parse("class A {}").directives).toBeUndefined();
  });
});

describe("java token streams", () => {
  const range = (src: string, needle: string) => {
    const start = src.indexOf(needle);
    return { start, end: start + needle.length };
  };

  it("gives the same exact hash to two methods that differ only in the names of their locals", () => {
    const a = "int total(int[] xs) { int sum = 0; for (int x : xs) { sum += x; } return sum; }";
    const b = "int total(int[] ys) { int acc = 0; for (int y : ys) { acc += y; } return acc; }";
    const sa = streamsWithPack(javaPack, `class A { ${a} }`, range(`class A { ${a} }`, a));
    const sb = streamsWithPack(javaPack, `class B { ${b} }`, range(`class B { ${b} }`, b));
    expect(sa.exact).toContain("$1");
    expect(sa.shape).toContain("ID");
    expect(hashStreams(sa).exactHash).toBe(hashStreams(sb).exactHash);
  });

  it("separates different literals in the exact stream but not in the shape", () => {
    const a = 'String f() { return "a" + "b"; }';
    const b = 'String f() { return "c" + "d"; }';
    const sa = streamsWithPack(javaPack, `class A { ${a} }`, range(`class A { ${a} }`, a));
    const sb = streamsWithPack(javaPack, `class A { ${b} }`, range(`class A { ${b} }`, b));
    expect(hashStreams(sa).exactHash).not.toBe(hashStreams(sb).exactHash);
    expect(hashStreams(sa).shapeHash).toBe(hashStreams(sb).shapeHash);
  });

  it("renames locals and strings in the embedding text and drops comments", () => {
    const m = 'String greet(String name) { // hi\n return "hello " + name; }';
    const src = `class A { ${m} }`;
    expect(embeddingTextWithPack(javaPack, src, range(src, m))).toBe(
      'String v1(String v2) { return "s" + v2; }',
    );
  });
});

describe("the exported rules", () => {
  const withRule = (exported: typeof javaPack.nodes.exported | { by: "capital" } | { by: "underscore" }) =>
    ({ ...javaPack, nodes: { ...javaPack.nodes, exported } }) as unknown as typeof javaPack;

  it("a capital letter, no leading underscore", () => {
    expect(isExportedName(withRule({ by: "capital" }), "Name")).toBe(true);
    expect(isExportedName(withRule({ by: "capital" }), "name")).toBe(false);
    expect(isExportedName(withRule({ by: "underscore" }), "name")).toBe(true);
    expect(isExportedName(withRule({ by: "underscore" }), "_name")).toBe(false);
  });
});

describe("readXml", () => {
  it("keeps the text of each element by its path from the root", () => {
    const x = readXml(`<?xml version="1.0"?>
<!-- <artifactId>commented</artifactId> -->
<project a="b/c">
  <artifactId>app</artifactId>
  <parent><artifactId>up</artifactId></parent>
  <dependencies>
    <dependency><artifactId>one</artifactId></dependency>
    <dependency><artifactId><![CDATA[two]]></artifactId><optional/></dependency>
  </dependencies>
</project>`);
    expect(x.get("project/artifactId")).toEqual(["app"]);
    expect(x.get("project/parent/artifactId")).toEqual(["up"]);
    expect(x.get("project/dependencies/dependency/artifactId")).toEqual(["one", "two"]);
  });
});

describe("java workspaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = join(mkdtempSync(join(tmpdir(), "gantry-java-")), "proj");
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const detect = (root: string) =>
    languageModule("java").detectWorkspaces(root, { workspaces: { overrides: {} } }, "r");

  it("makes a workspace of each pom.xml, named by its own artifactId", () => {
    const root = repo({
      "pom.xml": `<project><artifactId>parent</artifactId><modules><module>a</module><module>b</module></modules></project>`,
      "a/pom.xml": `<project><parent><artifactId>parent</artifactId></parent><artifactId>a</artifactId>
        <dependencyManagement><dependencies><dependency><artifactId>managed</artifactId></dependency></dependencies></dependencyManagement>
        <dependencies><dependency><artifactId>b</artifactId></dependency><dependency><artifactId>ext</artifactId></dependency></dependencies></project>`,
      "b/pom.xml": `<project><parent><artifactId>parent</artifactId></parent><artifactId>b</artifactId></project>`,
      "b/src/main/java/p/Main.java": "package p; class Main { public static void main(String[] args) {} }",
      "a/target/pom.xml": "<project><artifactId>built</artifactId></project>",
    });
    const ws = detect(root);
    expect(ws.map((w) => [w.name, w.dir, w.kind, w.deps])).toEqual([
      ["parent", ".", "package", []],
      ["a", "a", "package", ["b", "ext"]],
      ["b", "b", "app", []],
    ]);
    expect(packDependsOnEdges(javaPack, "r", root, ws).map((e) => [e.src, e.dst, e.fileId])).toEqual([
      ["ws:r:a", "ws:r:b", "file:r:a/pom.xml"],
    ]);
  });

  it("makes a workspace of each build.gradle and build.gradle.kts, named by its folder or by the settings", () => {
    const root = repo({
      "settings.gradle": "rootProject.name = 'shop'\ninclude 'core', 'web'\n",
      "build.gradle": "plugins { id 'java' }\n",
      "core/build.gradle": "// project(':ignored')\ndependencies { implementation 'x:y:1' }\n",
      "web/build.gradle.kts": `dependencies {\n  implementation(project(":core"))\n  testImplementation(project(":libs:util"))\n}\n`,
      "libs/util/build.gradle": "",
    });
    const ws = detect(root);
    expect(ws.map((w) => [w.name, w.dir, w.deps])).toEqual([
      ["shop", ".", []],
      ["core", "core", []],
      ["util", "libs/util", []],
      ["web", "web", ["core", "util"]],
    ]);
  });

  it("prefers pom.xml where a folder has both manifests", () => {
    const root = repo({
      "pom.xml": "<project><artifactId>m</artifactId></project>",
      "build.gradle": "",
    });
    expect(detect(root).map((w) => w.name)).toEqual(["m"]);
  });
});

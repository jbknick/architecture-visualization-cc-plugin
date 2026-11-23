import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashStreams } from "../../hash/index.js";
import { parseWithPack } from "../engine/parse.js";
import { embeddingTextWithPack, streamsWithPack } from "../engine/streams.js";
import { packDependsOnEdges } from "../engine/workspace.js";
import { readXml } from "../engine/xml.js";
import { languageModule } from "../index.js";
import { csharpPack } from "./index.js";

const parse = (src: string, path = "src/Core/A.cs") => parseWithPack(csharpPack, "r", path, src);
const byName = (src: string) => new Map(parse(src).symbols.map((s) => [s.name, s]));

describe("csharp symbols", () => {
  const src = `using System;

namespace Acme.App
{
    [Serializable]
    public partial class Outer<T> : Base, IA
    {
        private int count;
        public Outer(int n) { count = n; }
        public string Name { get; set; }
        public int Total => Compute();
        public string Label() { return "x"; }
        void Helper() { int Local() => 1; Local(); }
        public class Nested { public void Go() {} }
        class Inner { void Ping() {} }
        public int this[int i] => i;
        public static Outer<T> operator +(Outer<T> a, Outer<T> b) => a;
        ~Outer() { }
    }

    interface IApi
    {
        void Run();
        int Size();
    }

    enum Color { Red, Green }

    public record Point(int X, int Y);

    public record Person(string Name)
    {
        public void Hi() { }
    }

    public struct Pair { public void Swap() { } }
}
`;

  it("names types, nested types and the methods in their bodies by the types around them, not by the namespace", () => {
    expect([...byName(src).keys()]).toEqual([
      "Outer",
      "Outer.Outer",
      "Outer.Label",
      "Outer.Helper",
      "Outer.Nested",
      "Outer.Nested.Go",
      "Outer.Inner",
      "Outer.Inner.Ping",
      "IApi",
      "IApi.Run",
      "IApi.Size",
      "Color",
      "Point",
      "Person",
      "Person.Hi",
      "Pair",
      "Pair.Swap",
    ]);
  });

  it("reads the same symbols from a file-scoped namespace", () => {
    const m = byName("namespace A.B;\npublic class C { public void M() {} }\nclass D { }\n");
    expect([...m.keys()]).toEqual(["C", "C.M", "D"]);
  });

  it("maps declarations to symbol kinds", () => {
    const m = byName(src);
    expect(m.get("Outer")?.kind).toBe("class");
    expect(m.get("IApi")?.kind).toBe("interface");
    expect(m.get("Color")?.kind).toBe("enum");
    expect(m.get("Point")?.kind).toBe("class");
    expect(m.get("Pair")?.kind).toBe("class");
    expect(m.get("Outer.Label")?.kind).toBe("method");
    expect(m.get("Outer.Outer")?.kind).toBe("method");
  });

  it("is exported by the `public` modifier among several, and by being a member of an interface", () => {
    const m = byName(src);
    expect(m.get("Outer")?.exported).toBe(true);
    expect(m.get("Outer.Label")?.exported).toBe(true);
    expect(m.get("Outer.Helper")?.exported).toBe(false);
    expect(m.get("Outer.Inner")?.exported).toBe(false);
    expect(m.get("IApi")?.exported).toBe(false);
    expect(m.get("IApi.Run")?.exported).toBe(true);
    expect(m.get("Color")?.exported).toBe(false);
    expect(m.get("Point")?.exported).toBe(true);
    const two = byName("class A { public static void F() {} internal static void G() {} }");
    expect(two.get("A.F")?.exported).toBe(true);
    expect(two.get("A.G")?.exported).toBe(false);
  });

  it("keeps overloads apart by the order of the file, as repeated names always are", () => {
    const p = parse("class A { void F(int a) {} void F(int a, int b) {} }");
    expect(p.symbols.map((s) => s.id)).toEqual([
      "sym:r:src/Core/A.cs#A",
      "sym:r:src/Core/A.cs#A.F",
      "sym:r:src/Core/A.cs#A.F~2",
    ]);
  });

  it("keeps each part of a partial class as a symbol of its file", () => {
    expect(parse("partial class A { void F() {} }", "src/Core/A.cs").symbols.map((s) => s.id)).toEqual([
      "sym:r:src/Core/A.cs#A",
      "sym:r:src/Core/A.cs#A.F",
    ]);
    expect(parse("partial class A { void G() {} }", "src/Core/A.G.cs").symbols.map((s) => s.id)).toEqual([
      "sym:r:src/Core/A.G.cs#A",
      "sym:r:src/Core/A.G.cs#A.G",
    ]);
  });

  it("writes the signature as the parameters and the type before the name", () => {
    const m = byName(
      "class A { public static string Join(string a, int b = 1, params int[] c) { return a; } A() {} void Pick<T>(T t) {} }",
    );
    expect(m.get("A.Join")?.signature).toBe("(string a, int b = 1, params int[] c) string");
    expect(m.get("A.A")?.signature).toBe("()");
    expect(m.get("A.Pick")?.signature).toBe("(T t) void");
  });

  it("measures the body of a method", () => {
    const m = byName(
      "class A { int F(int a) { if (a > 0 && a < 9) { return 1; } foreach (var x in xs) { a++; } return a > 1 ? 1 : 0; } }",
    );
    expect(m.get("A.F")?.complexity).toBe(5);
    expect(m.get("A.F")?.stmtCount).toBe(5);
    expect(m.get("A")?.stmtCount).toBe(0);
  });

  it("reports a syntax error and still returns what it read", () => {
    const p = parse("class A { void F() {} ?? }");
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.symbols.map((s) => s.name)).toEqual(["A", "A.F"]);
  });
});

describe("csharp imports", () => {
  it("keeps plain, static, aliased and global usings with what they bring in", () => {
    const p = parse(`using System;
using System.Collections.Generic;
using static Acme.Core.Strings;
using L = Acme.Core.Lists;
global using Acme.Util;
namespace A;
`);
    expect(p.imports.map((i) => [i.local, i.imported, i.specifier, i.line])).toEqual([
      ["*", "*", "System", 1],
      ["*", "*", "System.Collections.Generic", 2],
      ["*", "*", "Acme.Core.Strings", 3],
      ["L", "Lists", "Acme.Core", 4],
      ["*", "*", "Acme.Util", 5],
    ]);
  });
});

describe("csharp generated files", () => {
  it("marks a file by its path", () => {
    expect(parse("class A {}", "src/Core/A.g.cs").directives).toEqual(["generated"]);
    expect(parse("class A {}", "src/Core/Schema.Designer.cs").directives).toEqual(["generated"]);
    expect(parse("class A {}", "src/Core/A.cs").directives).toBeUndefined();
  });
});

describe("csharp token streams", () => {
  const range = (src: string, needle: string) => {
    const start = src.indexOf(needle);
    return { start, end: start + needle.length };
  };

  it("gives the same exact hash to two methods that differ only in the names of their locals", () => {
    const a = "int Total(int[] xs) { int sum = 0; foreach (int x in xs) { sum += x; } return sum; }";
    const b = "int Total(int[] ys) { int acc = 0; foreach (int y in ys) { acc += y; } return acc; }";
    const sa = streamsWithPack(csharpPack, `class A { ${a} }`, range(`class A { ${a} }`, a));
    const sb = streamsWithPack(csharpPack, `class B { ${b} }`, range(`class B { ${b} }`, b));
    expect(sa.exact).toContain("$1");
    expect(sa.shape).toContain("ID");
    expect(hashStreams(sa).exactHash).toBe(hashStreams(sb).exactHash);
  });

  it("separates different literals in the exact stream but not in the shape", () => {
    const a = 'string F() { return "a" + "b"; }';
    const b = 'string F() { return "c" + "d"; }';
    const sa = streamsWithPack(csharpPack, `class A { ${a} }`, range(`class A { ${a} }`, a));
    const sb = streamsWithPack(csharpPack, `class A { ${b} }`, range(`class A { ${b} }`, b));
    expect(hashStreams(sa).exactHash).not.toBe(hashStreams(sb).exactHash);
    expect(hashStreams(sa).shapeHash).toBe(hashStreams(sb).shapeHash);
  });

  it("renames locals and strings in the embedding text and drops comments", () => {
    const m = 'string Greet(string name) { // hi\n return "hello " + name; }';
    const src = `class A { ${m} }`;
    expect(embeddingTextWithPack(csharpPack, src, range(src, m))).toBe(
      'string v1(string v2) { return "s" + v2; }',
    );
  });
});

describe("readXml attributes", () => {
  it("keeps the value of each attribute by the path of its element and its name", () => {
    const x = readXml(`<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\\Core\\Core.csproj" />
    <ProjectReference Include='../Util/Util.csproj'></ProjectReference>
    <Compile Remove="a/b.cs" Link="c" />
  </ItemGroup>
  <PropertyGroup><AssemblyName>Acme.App</AssemblyName></PropertyGroup>
</Project>`);
    expect(x.get("Project@Sdk")).toEqual(["Microsoft.NET.Sdk"]);
    expect(x.get("Project/ItemGroup/ProjectReference@Include")).toEqual([
      "..\\Core\\Core.csproj",
      "../Util/Util.csproj",
    ]);
    expect(x.get("Project/ItemGroup/Compile@Remove")).toEqual(["a/b.cs"]);
    expect(x.get("Project/ItemGroup/Compile@Link")).toEqual(["c"]);
    expect(x.get("Project/PropertyGroup/AssemblyName")).toEqual(["Acme.App"]);
  });
});

describe("csharp workspaces", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = join(mkdtempSync(join(tmpdir(), "gantry-csharp-")), "proj");
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const detect = (root: string) =>
    languageModule("csharp").detectWorkspaces(root, { workspaces: { overrides: {} } }, "r");

  it("makes a workspace of each .csproj, named by its assembly name, else by its file name", () => {
    const root = repo({
      "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><AssemblyName>Acme.App</AssemblyName></PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Core\\Core.csproj" />
    <ProjectReference Include="../Util/Acme.Util.csproj" />
    <!-- <ProjectReference Include="..\\Gone\\Gone.csproj" /> -->
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>`,
      "src/App/Program.cs": "class Program { static void Main(string[] args) {} }",
      "src/Core/Core.csproj": "<Project Sdk='Microsoft.NET.Sdk'></Project>",
      "src/Core/Core.cs": "class Core { }",
      "src/Util/Acme.Util.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>',
      "src/Core/obj/Other.csproj": "<Project />",
      "src/Core/bin/Other2.csproj": "<Project />",
    });
    const ws = detect(root);
    expect(ws.map((w) => [w.name, w.dir, w.kind, w.deps])).toEqual([
      ["Acme.App", "src/App", "app", ["Acme.Util", "Core"]],
      ["Core", "src/Core", "package", []],
      ["Acme.Util", "src/Util", "package", []],
    ]);
    expect(packDependsOnEdges(csharpPack, "r", root, ws).map((e) => [e.src, e.dst, e.fileId])).toEqual([
      ["ws:r:Acme.App", "ws:r:Acme.Util", "file:r:src/App/App.csproj"],
      ["ws:r:Acme.App", "ws:r:Core", "file:r:src/App/App.csproj"],
    ]);
  });

  it("is an app when a source file that is not a test declares Main, in any of its forms", () => {
    const root = repo({
      "a/A.csproj": "<Project />",
      "a/P.cs": "class P { public static async Task Main(string[] a) { } }",
      "b/B.csproj": "<Project />",
      "b/P.cs": "class P { static int Main() { return 0; } }",
      "c/C.csproj": "<Project />",
      "c/PTests.cs": "class PTests { static void Main() { } }",
      "d/D.csproj": "<Project />",
      "d/P.cs": "System.Console.WriteLine(1);",
    });
    expect(detect(root).map((w) => [w.name, w.kind])).toEqual([
      ["A", "app"],
      ["B", "app"],
      ["C", "package"],
      ["D", "package"],
    ]);
  });
});

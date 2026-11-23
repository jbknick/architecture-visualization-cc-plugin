import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../../indexer.js";
import { resolvePaths } from "../../paths/index.js";
import { openStore } from "../../store/index.js";
import type { EdgeRecord } from "../../types.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../test/helpers/fixture.js";
const { materializeFixture, materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
  materializeFiles: (files: Record<string, string>) => Promise<MaterializedFixture>;
};

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

interface Edge {
  kind: string;
  src: string;
  dst: string;
  conf: string;
  level: number | undefined;
}

/** Indexes a repo directory and returns the `calls`, `extends` and `implements` edges with the repo prefix cut off. */
async function edgesOf(dir: string): Promise<Edge[]> {
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const s = openStore(paths.dbPath);
  try {
    const short = (id: string): string => id.replace(/^sym:[^:]+:/, "");
    return (dumpGraph(s).edges as EdgeRecord[])
      .filter((e) => e.kind === "calls" || e.kind === "extends" || e.kind === "implements")
      .map((e) => ({
        kind: e.kind,
        src: short(e.src),
        dst: short(e.dst),
        conf: e.confidence,
        level: e.level,
      }));
  } finally {
    s.close();
  }
}

const CORE = "src/Core";
const APP = "src/App";

describe("csharp call edges on fixtures/csharp-basic", () => {
  let edges: Edge[];
  const find = (kind: string, src: string, dst: string): Edge[] =>
    edges.filter((e) => e.kind === kind && e.src === src && e.dst === dst);
  const has = (kind: string, src: string, dst: string, conf?: string): boolean =>
    find(kind, src, dst).some((e) => conf === undefined || e.conf === conf);

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("csharp-basic");
    cleanups.push(() => fx.cleanup());
    edges = await edgesOf(fx.dir);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("every call edge is level 2", () => {
    for (const e of edges.filter((x) => x.kind === "calls")) expect(e.level).toBe(2);
  });

  it("a call through an interface goes to the interface's method, high, and not to its implementers", () => {
    const run = `${APP}/Program.cs#Program.Run`;
    expect(has("calls", run, `${CORE}/IGreeter.cs#IGreeter.Greet`, "high")).toBe(true);
    expect(edges.some((e) => e.dst.endsWith("PoliteGreeter.cs#PoliteGreeter.Greet"))).toBe(false);
  });

  it("an extension method is called as a method of the type it extends", () => {
    expect(
      has(
        "calls",
        `${APP}/Program.cs#Program.Run`,
        `${CORE}/StringExtensions.cs#StringExtensions.Twice`,
        "high",
      ),
    ).toBe(true);
  });

  it("a call from one part of a partial class to a method of another part", () => {
    expect(
      has("calls", `${CORE}/Report.cs#Report.Render`, `${CORE}/Report.Totals.cs#Report.Header`, "high"),
    ).toBe(true);
  });

  it("a static using names the method of the type it imports", () => {
    expect(has("calls", `${APP}/Program.cs#Program.Run`, `${CORE}/Strings.cs#Strings.Shout`, "high")).toBe(
      true,
    );
  });

  it("a constructor call, a method on a local typed by `new`, a field typed by an interface and a bare call", () => {
    const run = `${APP}/Program.cs#Program.Run`;
    expect(has("calls", run, `${CORE}/Report.cs#Report.Report`, "high")).toBe(true);
    expect(has("calls", run, `${CORE}/Report.cs#Report.Render`, "high")).toBe(true);
    expect(
      has("calls", `${CORE}/Report.cs#Report.Render`, `${CORE}/IGreeter.cs#IGreeter.Greet`, "high"),
    ).toBe(true);
    expect(has("calls", `${APP}/Program.cs#Program.Main`, run, "high")).toBe(true);
    // `PoliteGreeter` declares no constructor: nothing to point at.
    expect(edges.some((e) => e.dst.endsWith("#PoliteGreeter.PoliteGreeter"))).toBe(false);
  });

  it("a test file's call reaches the code it tests", () => {
    expect(
      has("calls", `${APP}/ProgramTests.cs#ProgramTests.RunGreets`, `${APP}/Program.cs#Program.Run`, "high"),
    ).toBe(true);
  });

  it("implements comes from the declaration, at high confidence", () => {
    expect(
      has("implements", `${CORE}/PoliteGreeter.cs#PoliteGreeter`, `${CORE}/IGreeter.cs#IGreeter`, "high"),
    ).toBe(true);
    expect(edges.filter((e) => e.kind === "implements" && e.conf === "low")).toEqual([]);
  });
});

describe("csharp calls on small repos", () => {
  const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>M</AssemblyName></PropertyGroup></Project>`;

  async function repo(files: Record<string, string>): Promise<Edge[]> {
    const fx = await materializeFiles({ "M.csproj": CSPROJ, ...files });
    cleanups.push(() => fx.cleanup());
    return edgesOf(fx.dir);
  }
  const show = (edges: Edge[], kind = "calls"): string[] =>
    edges
      .filter((e) => e.kind === kind)
      .map((e) => `${e.src} -> ${e.dst} ${e.conf}`)
      .sort();

  it("takes the namespace from the declaration, block or file-scoped, not from the folder", async () => {
    const edges = await repo({
      "a/Util.cs": "namespace X.Util { public static class Util { public static void Go() {} } }\n",
      "b/Main.cs": "using X.Util;\nnamespace X.App;\npublic class Main { void Run() { Util.Go(); } }\n",
    });
    expect(show(edges)).toEqual(["b/Main.cs#Main.Run -> a/Util.cs#Util.Go high"]);
  });

  it("sees the types of the namespaces around, and not those of a namespace beside", async () => {
    const edges = await repo({
      "A.cs": "namespace X;\npublic class Svc { public void Work() {} }\n",
      "B.cs": "namespace X.App;\npublic class Use { Svc svc; void Go() { svc.Work(); } }\n",
      "C.cs": "namespace Y;\npublic class Other { Svc svc; void Go() { svc.Work(); } }\n",
    });
    expect(show(edges)).toEqual(["B.cs#Use.Go -> A.cs#Svc.Work high"]);
  });

  it("reads a type written with its namespace, and a using alias", async () => {
    const edges = await repo({
      "A.cs": "namespace X.Core;\npublic class Svc { public void Work() {} }\n",
      "B.cs": "namespace Z;\npublic class Full { X.Core.Svc svc; void Go() { svc.Work(); } }\n",
      "C.cs":
        "using S = X.Core.Svc;\nnamespace Z;\npublic class Aliased { S svc; void Go() { svc.Work(); } }\n",
    });
    expect(show(edges)).toEqual([
      "B.cs#Full.Go -> A.cs#Svc.Work high",
      "C.cs#Aliased.Go -> A.cs#Svc.Work high",
    ]);
  });

  it("an extension method needs the namespace in sight and a receiver of the type it extends", async () => {
    const edges = await repo({
      "Ext.cs": `namespace X.Ext;
public static class Exts {
  public static int Twice(this int n) => n * 2;
  public static void Poke(this IThing t) {}
  public static void Prod(this Thing t, int a) {}
}
`,
      "Thing.cs":
        "namespace X;\npublic interface IThing {}\npublic class Thing : IThing {}\npublic class Plain {}\n",
      "Use.cs": `using X.Ext;
namespace X;
public class Use {
  void Int(int n) { n.Twice(); }
  void Iface(Thing t, IThing i) { t.Poke(); i.Poke(); }
  void Args(Thing t) { t.Prod(1); }
  void TooFew(Thing t) { t.Prod(); }
  void WrongType(Plain p) { p.Poke(); }
}
`,
      "Away.cs": "namespace Y;\nusing X;\npublic class Away { void Go(Thing t) { t.Poke(); } }\n",
    });
    expect(show(edges)).toEqual([
      "Use.cs#Use.Args -> Ext.cs#Exts.Prod high",
      "Use.cs#Use.Iface -> Ext.cs#Exts.Poke high",
      "Use.cs#Use.Int -> Ext.cs#Exts.Twice high",
    ]);
  });

  it("an extension method is no answer for a type that may inherit the method from outside the repo", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public static class Exts { public static void Poke(this Mine m) {} }
public class Mine : System.Exception {}
public class Clean {}
public class Use { void Go(Mine m, Clean c) { m.Poke(); c.Poke(); } }
`,
    });
    expect(show(edges)).toEqual([]);
  });

  it("a method of the type wins over an extension method of that name, and a static call names the method", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public static class Exts { public static void Poke(this Mine m) {} }
public class Mine { public void Poke() {} }
public class Use { void Go(Mine m) { m.Poke(); Exts.Poke(m); } }
`,
    });
    expect(show(edges)).toEqual(["A.cs#Use.Go -> A.cs#Exts.Poke high", "A.cs#Use.Go -> A.cs#Mine.Poke high"]);
  });

  it("the parts of a partial class are one type: fields, bases and methods", async () => {
    const edges = await repo({
      "P1.cs":
        "namespace X;\npublic partial class P : Base { Helper helper; public void One() { Two(); helper.Help(); Inherited(); } }\n",
      "P2.cs":
        "namespace X;\npublic partial class P : IThing { public void Two() { One(); helper.Help(); } }\n",
      "Other.cs": `namespace X;
public class Base { public void Inherited() {} }
public interface IThing {}
public class Helper { public void Help() {} }
public class Use { void Go(P p) { p.One(); p.Two(); p.Inherited(); } }
`,
    });
    expect(show(edges)).toEqual(
      [
        "Other.cs#Use.Go -> P1.cs#P.One high",
        "Other.cs#Use.Go -> Other.cs#Base.Inherited high",
        "Other.cs#Use.Go -> P2.cs#P.Two high",
        "P1.cs#P.One -> Other.cs#Base.Inherited high",
        "P1.cs#P.One -> Other.cs#Helper.Help high",
        "P1.cs#P.One -> P2.cs#P.Two high",
        "P2.cs#P.Two -> Other.cs#Helper.Help high",
        "P2.cs#P.Two -> P1.cs#P.One high",
      ].sort(),
    );
    expect(show(edges, "extends")).toEqual(["P1.cs#P -> Other.cs#Base high"]);
    expect(show(edges, "implements")).toEqual(["P2.cs#P -> Other.cs#IThing high"]);
  });

  it("overloads: the number of arguments picks one; any that still fit are no edge", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class A {
  void F(int a) {}
  void F(int a, int b) {}
  void G(int a) {}
  void G(string a) {}
  void H(int a, int b = 1) {}
  void P(params int[] xs) {}
  void Q(int a, params int[] xs) {}
  A() {}
  A(int n) {}
  void ByCount() { F(1); }
  void ByCountTwo() { F(1, 2); }
  void SameCount() { G(1); }
  void OptionalOmitted() { H(1); }
  void OptionalGiven() { H(1, 2); }
  void Missing() { H(); }
  void ParamsNone() { P(); }
  void ParamsMany() { P(1, 2, 3); }
  void ParamsAfterFixed() { Q(1, 2); }
  void ParamsTooFew() { Q(); }
  void NewNone() { new A(); }
  void NewOne() { new A(1); }
}
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#A.ByCount -> A.cs#A.F high",
      "A.cs#A.ByCountTwo -> A.cs#A.F~2 high",
      "A.cs#A.NewNone -> A.cs#A.A high",
      "A.cs#A.NewOne -> A.cs#A.A~2 high",
      "A.cs#A.OptionalGiven -> A.cs#A.H high",
      "A.cs#A.OptionalOmitted -> A.cs#A.H high",
      "A.cs#A.ParamsAfterFixed -> A.cs#A.Q high",
      "A.cs#A.ParamsMany -> A.cs#A.P high",
      "A.cs#A.ParamsNone -> A.cs#A.P high",
    ]);
  });

  it("a local function or a delegate that is called is no method of the type", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class A {
  void Local() {}
  void Helper() {}
  void Go(System.Action Helper) {
    int Local() { Other(); return 1; }
    Local();
    Helper();
  }
  void Other() {}
}
`,
    });
    // The call inside the local function belongs to the method around it; the two names hide the methods.
    expect(show(edges)).toEqual(["A.cs#A.Go -> A.cs#A.Other high"]);
  });

  it("types a local by `new`, a cast, `as`, a declared result and a pattern, and not by an unknown call", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class Foo { public void Go() {} }
public class A {
  Foo Make() => null;
  void New() { var a = new Foo(); a.Go(); }
  void As(object o) { var b = o as Foo; b.Go(); }
  void Cast(object o) { var c = (Foo)o; c.Go(); }
  void CastInPlace(object o) { ((Foo)o).Go(); }
  void Result() { var d = Make(); d.Go(); }
  void Unknown() { var e = Elsewhere(); e.Go(); }
  void Pattern(object o) { if (o is Foo f) f.Go(); }
  void Nullable() { Foo? g = null; g.Go(); }
  void Element(Foo[] h) { h[0].Go(); }
  void Typed(Foo[] h) { foreach (Foo i in h) i.Go(); }
  void Var(Foo[] h) { foreach (var j in h) j.Go(); }
  void Catch() { try { } catch (Foo k) { k.Go(); } }
}
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#A.As -> A.cs#Foo.Go high",
      "A.cs#A.Cast -> A.cs#Foo.Go high",
      "A.cs#A.CastInPlace -> A.cs#Foo.Go high",
      "A.cs#A.Catch -> A.cs#Foo.Go high",
      "A.cs#A.Element -> A.cs#Foo.Go high",
      "A.cs#A.New -> A.cs#Foo.Go high",
      "A.cs#A.Nullable -> A.cs#Foo.Go high",
      "A.cs#A.Pattern -> A.cs#Foo.Go high",
      "A.cs#A.Result -> A.cs#A.Make high",
      "A.cs#A.Result -> A.cs#Foo.Go high",
      "A.cs#A.Typed -> A.cs#Foo.Go high",
    ]);
  });

  it("a name a lambda, a pattern, a deconstruction or an out variable declares hides a field of that name", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class Svc { public void Work() {} }
public class A {
  Svc svc;
  void Field() { svc.Work(); }
  void Lambda() { System.Action<object> f = svc => svc.Work(); }
  void LambdaParens() { System.Action<object> f = (svc) => svc.Work(); }
  void Pattern(object o) { if (o is Other { } svc) svc.Work(); }
  void Deconstruct() { var (svc, b) = Pair(); svc.Work(); }
  void OutVar() { Try(out var svc); svc.Work(); }
  void Local() { var svc = Make(); svc.Work(); }
  void Query() { var q = from svc in items select svc.Work(); }
}
`,
    });
    expect(show(edges)).toEqual(["A.cs#A.Field -> A.cs#Svc.Work high"]);
  });

  it("a generic method and a generic type", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class Order { public int Total() => 1; }
public class Box<T> { public T Get() => default; public T Item { get; } }
public class A {
  T Pick<T>(T a) => a;
  void Bare() { Pick<int>(1); }
  void Member(A a) { a.Pick<Order>(null); }
  void Result(Box<Order> box) { box.Get().Total(); }
  void Property(Box<Order> box) { box.Item.Total(); }
  void Raw(Box box) { box.Item.Total(); }
}
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#A.Bare -> A.cs#A.Pick high",
      "A.cs#A.Member -> A.cs#A.Pick high",
      "A.cs#A.Property -> A.cs#Order.Total high",
      "A.cs#A.Result -> A.cs#Box.Get high",
      "A.cs#A.Result -> A.cs#Order.Total high",
    ]);
  });

  it("fields and properties type their names, and a type parameter hides a type", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class Svc { public void Work() {} }
public class T { public void Work() {} }
public class A<T> {
  private readonly Svc field, other;
  public Svc Prop { get; set; }
  T value;
  void First() { field.Work(); }
  void Second() { other.Work(); }
  void Property() { Prop.Work(); }
  void ThisProperty() { this.Prop.Work(); }
  void Parameter() { value.Work(); }
}
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#A.First -> A.cs#Svc.Work high",
      "A.cs#A.Property -> A.cs#Svc.Work high",
      "A.cs#A.Second -> A.cs#Svc.Work high",
      "A.cs#A.ThisProperty -> A.cs#Svc.Work high",
    ]);
  });

  it("code of a property belongs to the type around it", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class A {
  int Helper() => 1;
  int Other() => 1;
  public int Total { get { return Helper(); } }
  public int Count => Other();
  int field = new B().Make();
}
public class B { public int Make() => 1; }
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#A -> A.cs#A.Helper high",
      "A.cs#A -> A.cs#A.Other high",
      "A.cs#A -> A.cs#B.Make high",
    ]);
  });

  it("inheritance: a base class, a base interface and an override", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public interface IA { void MA(); }
public interface IB : IA { void MB(); }
public class Base { public virtual void Run() {} public void Only() {} }
public class Derived : Base, IB {
  public override void Run() {}
  public void MA() {}
  public void MB() {}
  void ViaBaseInterface(IB b) { b.MA(); }
  void ViaInterface(IB b) { b.MB(); }
  void ViaBase(Base x) { x.Run(); }
  void ViaOverride(Derived d) { d.Run(); }
  void Inherited(Derived d) { d.Only(); }
  void Bare() { Only(); }
}
`,
    });
    expect(show(edges)).toEqual([
      "A.cs#Derived.Bare -> A.cs#Base.Only high",
      "A.cs#Derived.Inherited -> A.cs#Base.Only high",
      "A.cs#Derived.ViaBase -> A.cs#Base.Run high",
      "A.cs#Derived.ViaBaseInterface -> A.cs#IA.MA high",
      "A.cs#Derived.ViaInterface -> A.cs#IB.MB high",
      "A.cs#Derived.ViaOverride -> A.cs#Derived.Run high",
    ]);
    expect(show(edges, "extends")).toEqual(["A.cs#Derived -> A.cs#Base high", "A.cs#IB -> A.cs#IA high"]);
    expect(show(edges, "implements")).toEqual(["A.cs#Derived -> A.cs#IB high"]);
  });

  it("gives no edge where the type or the method is not known", async () => {
    const edges = await repo({
      "A.cs": `namespace X;
public class Base { public void Run() {} }
public class Foo : Base {
  public Foo() : base() {}
  void Go(Unknown u, Foo f) {
    u.Run();
    f?.Run();
    base.Run();
    var r = Task.Run(() => 1);
    r.Result.Run();
    string.Join(",", "a");
    new Unknown().Run();
    System.Console.WriteLine();
  }
}
`,
    });
    expect(show(edges)).toEqual([]);
  });

  it("a file with no namespace, several namespaces or only top-level statements", async () => {
    const edges = await repo({
      "Plain.cs": "public class Plain { public void Go() {} void Run() { Go(); } }\n",
      "Two.cs":
        "namespace A { class P { public void M() {} } }\nnamespace B { class Q { void N(A.P p) { p.M(); } } }\n",
      "Top.cs": "var x = new Plain();\nx.Go();\n",
    });
    expect(show(edges)).toEqual(["Plain.cs#Plain.Run -> Plain.cs#Plain.Go high"]);
  });
});

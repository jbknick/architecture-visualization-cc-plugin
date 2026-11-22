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

const CORE = "core/src/main/java/com/acme/core";
const APP = "app/src/main/java/com/acme/app";

describe("java call edges on fixtures/java-basic", () => {
  let edges: Edge[];
  const find = (kind: string, src: string, dst: string): Edge[] =>
    edges.filter((e) => e.kind === kind && e.src === src && e.dst === dst);
  const has = (kind: string, src: string, dst: string, conf?: string): boolean =>
    find(kind, src, dst).some((e) => conf === undefined || e.conf === conf);

  it("indexes the fixture", async () => {
    const fx = await materializeFixture("java-basic");
    cleanups.push(() => fx.cleanup());
    edges = await edgesOf(fx.dir);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("every call edge is level 2", () => {
    for (const e of edges.filter((x) => x.kind === "calls")) expect(e.level).toBe(2);
  });

  it("a call through an interface goes to the interface's method, high", () => {
    expect(has("calls", `${APP}/App.java#App.run`, `${CORE}/Greeter.java#Greeter.greet`, "high")).toBe(true);
    expect(has("calls", `${APP}/App.java#App.run`, `${CORE}/PoliteGreeter.java#PoliteGreeter.greet`)).toBe(
      false,
    );
  });

  it("overloads: the argument count picks one, several left give a low edge each", () => {
    const f = `${CORE}/Formatter.java`;
    // `format(text, 1)` has two arguments: only the two-parameter overload fits.
    expect(has("calls", `${f}#Formatter.format`, `${f}#Formatter.format~2`, "high")).toBe(true);
    // `formatter.format(hello)` has one: only the first overload fits.
    expect(has("calls", `${APP}/App.java#App.run`, `${f}#Formatter.format`, "high")).toBe(true);
    expect(has("calls", `${APP}/App.java#App.run`, `${f}#Formatter.format~2`)).toBe(false);
    // `pad(text)`: both `pad` overloads take one argument.
    expect(has("calls", `${f}#Formatter.format~2`, `${f}#Formatter.pad`, "low")).toBe(true);
    expect(has("calls", `${f}#Formatter.format~2`, `${f}#Formatter.pad~2`, "low")).toBe(true);
  });

  it("a static import names the method of the type it imports", () => {
    expect(has("calls", `${APP}/App.java#App.run`, `${CORE}/Strings.java#Strings.shout`, "high")).toBe(true);
  });

  it("an inner class reaches the members of the class around it", () => {
    expect(has("calls", `${APP}/App.java#App.Inner.ping`, `${APP}/App.java#App.log`, "high")).toBe(true);
  });

  it("a call through super and one through a type name", () => {
    const l = `${CORE}/LoudGreeter.java`;
    expect(
      has("calls", `${l}#LoudGreeter.greet`, `${CORE}/PoliteGreeter.java#PoliteGreeter.greet`, "high"),
    ).toBe(true);
    expect(has("calls", `${l}#LoudGreeter.greet`, `${CORE}/Strings.java#Strings.shout`, "high")).toBe(true);
  });

  it("a constructor call, and a method on a local typed by a constructor", () => {
    const m = `${APP}/Main.java#Main.main`;
    expect(has("calls", m, `${APP}/App.java#App.App`, "high")).toBe(true);
    expect(has("calls", m, `${APP}/App.java#App.run`, "high")).toBe(true);
    // `LoudGreeter` declares no constructor: nothing to point at.
    expect(edges.some((e) => e.src === m && e.dst.endsWith("#LoudGreeter.LoudGreeter"))).toBe(false);
  });

  it("a test file's call reaches the code it tests", () => {
    expect(
      has(
        "calls",
        "core/src/test/java/com/acme/core/StringsTest.java#StringsTest.shoutsInUpperCase",
        `${CORE}/Strings.java#Strings.shout`,
        "high",
      ),
    ).toBe(true);
  });

  it("extends and implements come from the declaration, at high confidence", () => {
    expect(
      has(
        "extends",
        `${CORE}/LoudGreeter.java#LoudGreeter`,
        `${CORE}/PoliteGreeter.java#PoliteGreeter`,
        "high",
      ),
    ).toBe(true);
    expect(
      has("implements", `${CORE}/PoliteGreeter.java#PoliteGreeter`, `${CORE}/Greeter.java#Greeter`, "high"),
    ).toBe(true);
    // Nothing is guessed from method names.
    expect(edges.filter((e) => e.kind === "implements" && e.conf === "low")).toEqual([]);
  });

  it("a call to an interface is not also an edge to its implementers", () => {
    const toImpl = edges.filter((e) => e.kind === "calls" && e.dst.includes("Greeter.greet"));
    expect(
      toImpl.every((e) => e.dst.endsWith("Greeter.java#Greeter.greet") || e.src.includes("LoudGreeter")),
    ).toBe(true);
  });
});

describe("java calls on small repos", () => {
  const POM = (name: string, deps: string[] = []): string =>
    `<project><artifactId>${name}</artifactId><dependencies>${deps
      .map((d) => `<dependency><artifactId>${d}</artifactId></dependency>`)
      .join("")}</dependencies></project>`;

  async function repo(files: Record<string, string>): Promise<Edge[]> {
    const fx = await materializeFiles({ "pom.xml": POM("m"), ...files });
    cleanups.push(() => fx.cleanup());
    return edgesOf(fx.dir);
  }

  it("takes the package from the package clause, not from the folder", async () => {
    const edges = await repo({
      "src/a/Util.java": "package com.x.util;\npublic class Util { public static void go() {} }\n",
      "src/b/Main.java":
        "package com.x.app;\nimport com.x.util.Util;\npublic class Main { void run() { Util.go(); } }\n",
    });
    expect(edges.map((e) => `${e.src} -> ${e.dst} ${e.conf}`)).toEqual([
      "src/b/Main.java#Main.run -> src/a/Util.java#Util.go high",
    ]);
  });

  it("reads an on-demand import and a field typed by an imported type", async () => {
    const edges = await repo({
      "Svc.java": "package p.svc;\npublic class Svc { public void work() {} }\n",
      "Use.java":
        "package p.use;\nimport p.svc.*;\npublic class Use { Svc svc; void go() { svc.work(); this.go(); } }\n",
    });
    expect(edges.map((e) => `${e.src} -> ${e.dst} ${e.conf}`).sort()).toEqual([
      "Use.java#Use.go -> Svc.java#Svc.work high",
    ]);
  });

  it("finds a method a superclass declares, and does not guess for an unknown receiver", async () => {
    const edges = await repo({
      "A.java":
        "package p;\nclass Base { void ping() {} }\nclass Sub extends Base { void run() { ping(); other.ping(); new Base().ping(); } }\n",
    });
    expect(edges.filter((e) => e.kind === "calls").map((e) => `${e.src} -> ${e.dst} ${e.conf}`)).toEqual([
      "A.java#Sub.run -> A.java#Base.ping high",
    ]);
    expect(edges.filter((e) => e.kind === "extends").length).toBe(1);
  });

  it("matches a varargs method for any argument count above its fixed ones", async () => {
    const edges = await repo({
      "V.java":
        'package p;\nclass V { void all(String... xs) {} void none() { all(); all("a"); all("a", "b"); } }\n',
    });
    expect(edges.map((e) => `${e.src} -> ${e.dst} ${e.conf}`)).toEqual([
      "V.java#V.none -> V.java#V.all high",
    ]);
  });

  const callsOf = (edges: Edge[]): string[] =>
    edges.filter((e) => e.kind === "calls").map((e) => `${e.src} -> ${e.dst} ${e.conf}`);

  it("types an anonymous class body as a subtype of the type created, not as the class around it", async () => {
    const edges = await repo({
      "A.java": `package p;
interface Adapter { void write(String s); void flush(); }
class Outer {
  void flush() {}
  Adapter make() {
    return new Adapter() {
      public void write(String s) { flush(); this.flush(); }
    };
  }
}
`,
    });
    expect(callsOf(edges)).toEqual(["A.java#Outer.make -> A.java#Adapter.flush high"]);
  });

  it("gives no edge for a method an anonymous class declares itself, or for one of a type outside the repo", async () => {
    const edges = await repo({
      "A.java": `package p;
interface Adapter { void flush(); }
class Outer {
  void flush() {}
  void own() {
    new Adapter() { public void flush() {} void go() { flush(); this.flush(); } };
  }
  void external() {
    new Thread() { public void run() { flush(); this.flush(); } };
  }
}
`,
    });
    expect(callsOf(edges)).toEqual([]);
  });

  it("looks outward from an anonymous body only when every type it extends is known", async () => {
    const edges = await repo({
      "A.java": `package p;
interface Adapter { void write(String s); }
class Outer {
  void log() {}
  void make() { new Adapter() { public void write(String s) { log(); } }; }
}
`,
    });
    expect(callsOf(edges)).toEqual(["A.java#Outer.make -> A.java#Outer.log high"]);
  });

  it("gives a bare name no edge when the class extends a type outside the repo and does not declare it", async () => {
    const edges = await repo({
      "A.java": `package p;
class Outer2 {
  void add(String s) {}
  class Bag extends java.util.ArrayList<String> { void put(String s) { add(s); } }
  class Bag2 extends ArrayList<String> { void put(String s) { add(s); own(); } void own() {} }
  class Fine { void put(String s) { add(s); } }
}
`,
    });
    expect(callsOf(edges)).toEqual([
      "A.java#Outer2.Bag2.put -> A.java#Outer2.Bag2.own high",
      "A.java#Outer2.Fine.put -> A.java#Outer2.add high",
    ]);
  });

  it("types the body of a class declared inside a method by its supertypes", async () => {
    const edges = await repo({
      "A.java": `package p;
class Base { void ping() {} }
class Outer {
  void ping() {}
  void helper() {}
  void known() { class L extends Base { void a() { ping(); this.ping(); } } }
  void unknown() { class M extends Thing { void a() { ping(); } } }
  void own() { class N extends Base { void helper() {} void a() { helper(); this.helper(); } } }
}
`,
    });
    expect(callsOf(edges)).toEqual(["A.java#Outer.known -> A.java#Base.ping high"]);
  });

  it("types a `var` local by its constructor and a local by its declared type", async () => {
    const edges = await repo({
      "T.java":
        "package p;\nclass H { void go() {} }\nclass T { void a() { var h = new H(); h.go(); } void b() { H h = null; h.go(); } }\n",
    });
    expect(edges.map((e) => e.src).sort()).toEqual(["T.java#T.a", "T.java#T.b"]);
  });
});

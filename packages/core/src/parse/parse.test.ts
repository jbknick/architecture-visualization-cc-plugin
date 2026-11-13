import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type ParsedFile, parseSource } from "./index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

function fixture(rel: string): ParsedFile {
  return parseSource(rel, readFileSync(join(fixturesRoot, rel), "utf8"));
}

function plain(p: ParsedFile) {
  return { ...p, bodies: [...p.bodies.entries()].map(([id, r]) => ({ id, ...r })) };
}

const sym = (p: ParsedFile, name: string) => {
  const s = p.symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name}: ${p.symbols.map((x) => x.name).join(",")}`);
  return s;
};

describe("fixture snapshots", () => {
  const files: Record<string, string> = {
    component: "pnpm-turbo/packages/ui/src/button.tsx",
    hook: "pnpm-turbo/apps/web/src/hooks/useDebounce.ts",
    class: "single-pkg/src/counter.ts",
    barrel: "pnpm-turbo/packages/ui/src/index.ts",
    "hono app": "pnpm-turbo/apps/api/src/app.ts",
    "drizzle schema": "pnpm-turbo/packages/db/src/schema.ts",
  };
  for (const [label, rel] of Object.entries(files)) {
    test(label, () => {
      const parsed = fixture(rel);
      expect(parsed.errors).toEqual([]);
      expect(plain(parsed)).toMatchSnapshot();
      // deterministic: parsing twice gives the identical result
      expect(plain(fixture(rel))).toEqual(plain(parsed));
    });
  }

  test("kinds on fixtures", () => {
    expect(sym(fixture(files.component as string), "Button").kind).toBe("component");
    expect(sym(fixture(files.hook as string), "useDebounce").kind).toBe("hook");
    const counter = fixture(files.class as string);
    expect(sym(counter, "Counter").kind).toBe("class");
    expect(sym(counter, "Counter.increment").kind).toBe("method");
  });
});

describe("kind detection", () => {
  test("components, hooks, methods", () => {
    const p = parseSource(
      "src/a.tsx",
      `export function Button() { return <button />; }
export const Card = () => <div><Button /></div>;
export const helper = () => <div />;
function Plain() { return 1; }
export function useThing() { return 1; }
export const useOther = () => 2;
class Cart { addItem(x: number) { return x; } }
export enum E { A }
export interface I { a: string }
export type T = string;
export const VALUE = 3;
const notExported = 3;
`,
    );
    const kinds = Object.fromEntries(p.symbols.map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({
      Button: "component",
      Card: "component",
      helper: "function",
      Plain: "function",
      useThing: "hook",
      useOther: "hook",
      Cart: "class",
      "Cart.addItem": "method",
      E: "enum",
      I: "interface",
      T: "type",
      VALUE: "const",
    });
    expect(p.symbols.find((s) => s.name === "notExported")).toBeUndefined();
  });

  test("memo and forwardRef wrappers are components", () => {
    const p = parseSource(
      "src/a.tsx",
      `import { memo, forwardRef } from "react";
export const A = memo(function A() { return <div />; });
export const B = forwardRef<HTMLDivElement, {}>((props, ref) => <div ref={ref} />);
export const c = memo(() => <div />);
`,
    );
    expect(sym(p, "A").kind).toBe("component");
    expect(sym(p, "B").kind).toBe("component");
    expect(sym(p, "c").kind).toBe("function");
    expect(p.sites.filter((s) => s.kind === "calls").map((s) => s.callee)).toEqual([
      "memo",
      "forwardRef",
      "memo",
    ]);
  });
});

describe("symbols, ids and exports", () => {
  test("exported flags: named, default, export { x }, renamed, not exported", () => {
    const p = parseSource(
      "src/e.ts",
      `export function a() {}
function b() {}
function c() {}
function d() {}
const e = () => 1;
export { b, c as cc };
export default d;
export class K { m() {} private p() {} #q() {} }
`,
    );
    const ex = (n: string) => sym(p, n).exported;
    expect([ex("a"), ex("b"), ex("c"), ex("d"), ex("e")]).toEqual([true, true, true, true, false]);
    expect(ex("K")).toBe(true);
    expect([ex("K.m"), ex("K.p"), ex("K.#q")]).toEqual([true, false, false]);
    expect(p.exports).toEqual([
      { exported: "a", local: "a" },
      { exported: "b", local: "b" },
      { exported: "cc", local: "c" },
      { exported: "default", local: "d" },
      { exported: "K", local: "K" },
    ]);
  });

  test("ids: prefix, #default, ~2 collisions, class members", () => {
    const p = parseSource(
      "pkg/src/x.ts",
      `export default function () { return 1; }
export interface Foo { a: 1 }
export const Foo = 1;
type Foo = string;
class Foo2 { get v() { return 1; } set v(x: number) {} static s() {} }
`,
    );
    expect(p.fileId).toBe("file:pkg/src/x.ts");
    expect(p.symbols.map((s) => s.id)).toEqual([
      "sym:pkg/src/x.ts#default",
      "sym:pkg/src/x.ts#Foo",
      "sym:pkg/src/x.ts#Foo~2",
      "sym:pkg/src/x.ts#Foo~3",
      "sym:pkg/src/x.ts#Foo2",
      "sym:pkg/src/x.ts#Foo2.v",
      "sym:pkg/src/x.ts#Foo2.v~2",
      "sym:pkg/src/x.ts#Foo2.s",
    ]);
    expect(p.exports[0]).toEqual({ exported: "default", local: "default" });
    expect(p.symbols[0]?.exported).toBe(true);
  });

  test("named default export keeps its name; anonymous default arrow with JSX is a component", () => {
    const a = parseSource("a.ts", "export default function main() {}");
    expect(a.symbols[0]?.id).toBe("sym:a.ts#main");
    expect(a.exports).toEqual([{ exported: "default", local: "main" }]);
    const b = parseSource("b.tsx", "export default () => <div />;");
    expect(b.symbols[0]).toMatchObject({ id: "sym:b.tsx#default", kind: "component", exported: true });
    const c = parseSource("c.ts", "export default class extends Base {}");
    expect(c.symbols[0]).toMatchObject({ id: "sym:c.ts#default", kind: "class" });
    expect(c.sites).toEqual([{ fromSymbol: "sym:c.ts#default", kind: "extends", callee: "Base", line: 1 }]);
    const d = parseSource("d.ts", "export default defineConfig({ a: helper() });");
    expect(d.symbols[0]).toMatchObject({ id: "sym:d.ts#default", kind: "const" });
    expect(d.sites.map((s) => [s.fromSymbol, s.callee])).toEqual([
      ["sym:d.ts#default", "defineConfig"],
      ["sym:d.ts#default", "helper"],
    ]);
  });

  test("overloads yield one symbol; declare and destructured consts do not", () => {
    const p = parseSource(
      "o.ts",
      `export function f(a: string): string;
export function f(a: number): number;
export function f(a: any): any { return a; }
declare const g: number;
export const { x, y } = obj();
export class C { m(a: string): string; m(a: number): number; m(a: any) { return a; } }
`,
    );
    expect(p.symbols.map((s) => s.id)).toEqual(["sym:o.ts#f", "sym:o.ts#C", "sym:o.ts#C.m"]);
    expect(p.exports.map((e) => e.exported)).toEqual(["f", "x", "y", "C"]);
  });

  test("multiple declarators and exported const non-functions", () => {
    const p = parseSource("m.ts", "export const a = 1, b = () => 2;\nconst c = 3;\n");
    expect(p.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ["a", "const", true],
      ["b", "function", true],
    ]);
    // multiple declarators: the range is the declarator, not the statement
    expect(p.bodies.get("sym:m.ts#a")).toEqual({ start: 13, end: 18 });
  });

  test("class property arrow functions are methods", () => {
    const p = parseSource("k.ts", "export class K { handle = (x: number) => x + 1; count = 0; }");
    expect(p.symbols.map((s) => [s.name, s.kind])).toEqual([
      ["K", "class"],
      ["K.handle", "method"],
    ]);
  });
});

describe("signature", () => {
  test("params and return type, whitespace collapsed", () => {
    const p = parseSource(
      "s.ts",
      `export function f<T extends object>(
  a: T,
  b?: number,
): Promise<Map<string, T>> { return null as never; }
export const g = async (x: string) => x;
export const h = (): void => {};
class C { m(a: string, ...rest: number[]): boolean { return true; } }
`,
    );
    expect(sym(p, "f").signature).toBe("<T extends object>(a: T, b?: number): Promise<Map<string, T>>");
    expect(sym(p, "g").signature).toBe("(x: string)");
    expect(sym(p, "h").signature).toBe("(): void");
    expect(sym(p, "C.m").signature).toBe("(a: string, ...rest: number[]): boolean");
    expect(sym(p, "C").signature).toBe("");
  });

  test("capped at 200 characters", () => {
    const params = Array.from({ length: 40 }, (_, i) => `argument${i}: string`).join(", ");
    const p = parseSource("l.ts", `export function f(${params}) {}`);
    const sig = sym(p, "f").signature;
    expect(sig.length).toBe(200);
    expect(sig.endsWith("…")).toBe(true);
  });
});

describe("metrics", () => {
  test("loc, stmtCount, complexity", () => {
    const p = parseSource(
      "m.ts",
      `export function f(a: number, b: number) {
  if (a && b) {
    return a ?? b;
  } else if (a || b) {
    return a ? 1 : 2;
  }
  for (const x of [1]) { a += x; }
  while (a) { a--; }
  do { a++; } while (a < 3);
  try { a = 1; } catch (e) { a = 2; }
  switch (a) { case 1: break; case 2: break; default: break; }
  return 0;
}
export const arrow = (x: number) => x + 1;
export const one = () => {};
`,
    );
    const f = sym(p, "f");
    expect(f.startLine).toBe(1);
    expect(f.endLine).toBe(13);
    expect(f.loc).toBe(13);
    // 1 + if, else-if, &&, ??, ||, ?:, for, while, do, catch, 2 cases (not default) = 13
    expect(f.complexity).toBe(13);
    // if, return, else-if, return, for, `const x` (loop head), a+=x, while, a--, do, a++,
    // try, a=1, a=2, switch, 3 breaks, return = 19
    expect(f.stmtCount).toBe(19);
    const arrow = sym(p, "arrow");
    expect(arrow).toMatchObject({ loc: 1, stmtCount: 1, complexity: 1 });
    expect(sym(p, "one")).toMatchObject({ stmtCount: 0 });
  });

  test("nested functions are counted into the enclosing symbol", () => {
    const p = parseSource(
      "n.ts",
      "export function f() { const g = () => { if (x) { return 1; } return 2; }; return g(); }",
    );
    expect(sym(p, "f")).toMatchObject({ complexity: 2, stmtCount: 5 });
  });

  test("types and enums have loc but no statements", () => {
    const p = parseSource("t.ts", "export interface I {\n  a: string;\n}\nexport enum E {\n  A,\n  B,\n}\n");
    expect(sym(p, "I")).toMatchObject({ startLine: 1, endLine: 3, loc: 3, stmtCount: 0, complexity: 1 });
    expect(sym(p, "E")).toMatchObject({ startLine: 4, endLine: 7, loc: 4 });
  });
});

describe("sites", () => {
  test("calls, member chains, hooks, JSX, new", () => {
    const p = parseSource(
      "src/s.tsx",
      `import { useState } from "react";
export function Page() {
  const [a, setA] = useState(0);
  React.useEffect(() => { track.event.fire.now(); }, []);
  const r = obj.a.b.c.d(1);
  fn()();
  foo().bar();
  this_is_ignored[key]();
  const x = new Thing();
  return (
    <Layout>
      <Ui.Card />
      <div />
      <>
        <Button onClick={() => doIt()} />
      </>
    </Layout>
  );
}
`,
    );
    const sites = p.sites.map((s) => `${s.line}:${s.kind}:${s.callee}`);
    expect(sites).toEqual([
      "3:uses_hook:useState",
      "4:calls:track.event.fire",
      "4:uses_hook:React.useEffect",
      "5:calls:obj.a.b",
      "6:calls:fn",
      "7:calls:foo",
      "9:calls:Thing",
      "11:renders:Layout",
      "12:renders:Ui.Card",
      "15:calls:doIt",
      "15:renders:Button",
    ]);
    expect(new Set(p.sites.map((s) => s.fromSymbol))).toEqual(new Set(["sym:src/s.tsx#Page"]));
  });

  test("lowercase JSX tags and namespaced names are not renders", () => {
    const p = parseSync_("a.tsx", "export const A = () => <div><svg:path /><a.b /></div>;");
    expect(p.sites).toEqual([]);
  });

  test("module-level code is attributed to the file id (Hono app)", () => {
    const p = fixture("pnpm-turbo/apps/api/src/app.ts");
    const fileSites = p.sites.filter((s) => s.fromSymbol === "file:pnpm-turbo/apps/api/src/app.ts");
    expect(fileSites.map((s) => s.callee)).toEqual([
      "app.get",
      "c.req.param",
      "getPost",
      "c.json",
      "app.post",
      "c.req.json",
      "createPost",
      "c.json",
    ]);
    expect(p.sites.find((s) => s.callee === "Hono")).toMatchObject({
      fromSymbol: "sym:pnpm-turbo/apps/api/src/app.ts#app",
    });
  });

  test("extends / implements / references_type", () => {
    const p = parseSource(
      "src/t.ts",
      `import type { Base, Shape, Opts } from "./types";
export class Circle<T> extends Base<Opts> implements Shape, ns.Other {
  field: Extra = make();
  area(r: T, o: Opts): Result<T> { const local: Hidden = r as never; return null as never; }
}
export interface Wide extends Shape, Narrow<Opts> { f: Inner; }
export type Alias<U> = Record<string, U | Elsewhere>;
export function build<V>(x: V, y: Ctx): Out<V> { return null as never; }
export const typed: Handler = () => 1;
`,
    );
    const by = (from: string) =>
      p.sites.filter((s) => s.fromSymbol === `sym:src/t.ts#${from}`).map((s) => `${s.kind}:${s.callee}`);
    expect(by("Circle")).toEqual([
      "extends:Base",
      "implements:Shape",
      "implements:ns.Other",
      "references_type:Opts",
      "calls:make",
      "references_type:Extra",
    ]);
    expect(by("Circle.area")).toEqual(["references_type:Opts", "references_type:Result"]);
    expect(by("Wide")).toEqual([
      "extends:Narrow",
      "extends:Shape",
      "references_type:Inner",
      "references_type:Opts",
    ]);
    expect(by("Alias")).toEqual(["references_type:Elsewhere", "references_type:Record"]);
    expect(by("build")).toEqual(["references_type:Ctx", "references_type:Out"]);
    expect(by("typed")).toEqual(["references_type:Handler"]);
  });

  test("sites are sorted by line then symbol, kind, callee", () => {
    const p = parseSource("z.ts", "export function b() { z(); a(); }\nexport function a() { y(); }\n");
    expect(p.sites.map((s) => s.callee)).toEqual(["a", "z", "y"]);
  });
});

function parseSync_(path: string, src: string): ParsedFile {
  return parseSource(path, src);
}

describe("imports and exports", () => {
  test("import forms", () => {
    const p = parseSource(
      "i.ts",
      `import def from "a";
import * as ns from "b";
import { x, y as z, type T } from "c";
import type { Only } from "d";
import "side-effect";
import d2, { q } from "e";
import { "string name" as sn } from "f";
const lazy = () => import("./lazy");
const dyn = (n: string) => import(n);
`,
    );
    expect(p.imports).toEqual([
      { local: "def", imported: "default", specifier: "a", typeOnly: false, line: 1 },
      { local: "ns", imported: "*", specifier: "b", typeOnly: false, line: 2 },
      { local: "x", imported: "x", specifier: "c", typeOnly: false, line: 3 },
      { local: "z", imported: "y", specifier: "c", typeOnly: false, line: 3 },
      { local: "T", imported: "T", specifier: "c", typeOnly: true, line: 3 },
      { local: "Only", imported: "Only", specifier: "d", typeOnly: true, line: 4 },
      { local: "", imported: "*", specifier: "side-effect", typeOnly: false, line: 5 },
      { local: "d2", imported: "default", specifier: "e", typeOnly: false, line: 6 },
      { local: "q", imported: "q", specifier: "e", typeOnly: false, line: 6 },
      { local: "sn", imported: "string name", specifier: "f", typeOnly: false, line: 7 },
      { local: "", imported: "*", specifier: "./lazy", typeOnly: false, line: 8 },
    ]);
  });

  test("re-exports and barrels", () => {
    const p = parseSource(
      "b.ts",
      `export { Button } from "./button";
export { default as Card, Foo as Bar } from "./card";
export * from "./all";
export * as utils from "./utils";
export type { T } from "./t";
`,
    );
    expect(p.exports).toEqual([
      { exported: "Button", local: "Button", fromSpecifier: "./button" },
      { exported: "Card", local: "default", fromSpecifier: "./card" },
      { exported: "Bar", local: "Foo", fromSpecifier: "./card" },
      { exported: "*", fromSpecifier: "./all", star: true },
      { exported: "utils", local: "*", fromSpecifier: "./utils" },
      { exported: "T", local: "T", fromSpecifier: "./t" },
    ]);
    expect(p.symbols).toEqual([]);
    expect(p.imports).toEqual([]);
  });

  test("declaration exports", () => {
    const p = parseSource(
      "d.ts",
      "export const a = 1;\nexport type T = 1;\nexport interface I {}\nexport enum E {}\nexport class C {}",
    );
    expect(p.exports.map((e) => e.exported)).toEqual(["a", "T", "I", "E", "C"]);
  });
});

describe("bodies", () => {
  test("ranges slice back to the declaration (UTF-16 offsets, non-ASCII safe)", () => {
    const src = `const s = "日本語🎉";\nexport function f() { return "é"; }\nexport class C {\n  m() { return 1; }\n}\n`;
    const p = parseSource("u.ts", src);
    const f = p.bodies.get("sym:u.ts#f");
    expect(f && src.slice(f.start, f.end)).toBe(`function f() { return "é"; }`);
    const m = p.bodies.get("sym:u.ts#C.m");
    expect(m && src.slice(m.start, m.end)).toBe("m() { return 1; }");
    const c = p.bodies.get("sym:u.ts#C");
    expect(c && src.slice(c.start, c.end)).toMatch(/^class C \{[\s\S]*\}$/);
    expect([...p.bodies.keys()]).toEqual(p.symbols.map((s) => s.id));
    expect(sym(p, "f").startLine).toBe(2);
  });

  test("const range includes the declaration keyword", () => {
    const src = "export const x = () => 1;\n";
    const p = parseSource("c.ts", src);
    const r = p.bodies.get("sym:c.ts#x");
    expect(r && src.slice(r.start, r.end)).toBe("const x = () => 1;");
  });
});

describe("errors", () => {
  test("syntax error still lists symbols before the error", () => {
    const src = `export function ok(a: number) {
  return a + 1;
}

export const fine = () => 2;

export function broken( {
  const z = ;
}

export function after() {}
`;
    const p = parseSource("bad.ts", src);
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.errors[0]).toMatch(/^line \d+: /);
    expect(p.symbols.map((s) => s.name)).toEqual(["ok", "fine"]);
    const ok = p.bodies.get("sym:bad.ts#ok");
    expect(ok && src.slice(ok.start, ok.end)).toBe("function ok(a: number) {\n  return a + 1;\n}");
  });

  test("error on the first statement, empty and whitespace input never throw", () => {
    expect(parseSource("a.ts", "export function (").symbols).toEqual([]);
    expect(parseSource("a.ts", "export function (").errors.length).toBeGreaterThan(0);
    for (const s of ["", "   \n", "// just a comment\n"]) {
      const p = parseSource("a.ts", s);
      expect(p.errors).toEqual([]);
      expect(p.symbols).toEqual([]);
    }
  });

  test("recoverable (semantic) errors keep everything", () => {
    const p = parseSource("a.ts", "export function a() {}\nlet x = 1; let x = 2;\nexport function b() {}");
    expect(p.symbols.map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("garbage binary-ish input does not throw", () => {
    const p = parseSource("g.ts", "\u0000\u0001{{{{ <<<< ))))");
    expect(p.errors.length).toBeGreaterThan(0);
  });
});

describe("language by extension", () => {
  test("tsx parses JSX, ts parses generics arrows, jsx/js parse plain JS", () => {
    expect(parseSource("a.tsx", "export const A = () => <div />;").errors).toEqual([]);
    expect(parseSource("a.ts", "export const f = <T,>(x: T) => x;").errors).toEqual([]);
    expect(parseSource("a.jsx", "export const A = () => <div />;").symbols[0]?.kind).toBe("component");
    expect(parseSource("a.js", "export function f(a) { return a; }").symbols[0]?.kind).toBe("function");
    expect(parseSource("a.mts", "export const x: number = 1;").errors).toEqual([]);
    expect(
      parseSource("a.d.ts", "export declare function f(): void;\nexport interface I {}").symbols.map(
        (s) => s.name,
      ),
    ).toEqual(["I"]);
  });
});

describe("performance", () => {
  test("parsing all of fixtures/pnpm-turbo takes < 200 ms", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|mts|cts)$/.test(name)) files.push(full);
      }
    };
    walk(join(fixturesRoot, "pnpm-turbo"));
    expect(files.length).toBeGreaterThan(10);
    const sources = files.map((f) => [relative(fixturesRoot, f), readFileSync(f, "utf8")] as const);
    // warm the native module once; the budget is for steady-state parsing
    parseSource("warm.ts", "export const a = 1;");
    const t0 = performance.now();
    let symbols = 0;
    for (const [rel, src] of sources) {
      const p = parseSource(rel, src);
      expect(p.errors).toEqual([]);
      symbols += p.symbols.length;
    }
    const elapsed = performance.now() - t0;
    expect(symbols).toBeGreaterThan(10);
    expect(elapsed).toBeLessThan(200);
  });
});

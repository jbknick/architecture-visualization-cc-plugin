import { describe, expect, it } from "vitest";
import { hashSymbol } from "../hash/index.js";
import { parseSource } from "../parse/index.js";
import type { SymbolRecord } from "../types.js";
import { isBarrelFile, reexportTemplate, templateFor, termsFromName } from "./templates.js";

/** Parses `source` and returns the symbol record the indexer would store (hashes included). */
function symbolsOf(
  path: string,
  source: string,
): { syms: Map<string, SymbolRecord>; parsed: ReturnType<typeof parseSource> } {
  const parsed = parseSource(path, source);
  const syms = new Map<string, SymbolRecord>();
  for (const s of parsed.symbols) {
    const body = parsed.bodies.get(s.id);
    const h = body
      ? hashSymbol(source, body, path.endsWith(".tsx") ? "tsx" : "ts")
      : { exactHash: "", shapeHash: "", minhash: new Uint32Array(64) };
    syms.set(s.name, { ...s, ...h });
  }
  return { syms, parsed };
}

function tpl(path: string, source: string, name: string) {
  const { syms, parsed } = symbolsOf(path, source);
  return templateFor(syms.get(name) as SymbolRecord, parsed, source);
}

describe("templateFor", () => {
  it("describes a block body that is a single return", () => {
    const d = tpl(
      "src/a.ts",
      "export function isEven(n: number): boolean {\n  return n % 2 === 0;\n}\n",
      "isEven",
    );
    expect(d).toEqual({
      behavior: "Returns n % 2 === 0.",
      searchTerms: ["is even", "is", "even"],
      nameFits: true,
    });
  });

  it("describes an expression-bodied arrow function", () => {
    const d = tpl("src/a.ts", "export const double = (n: number) => n * 2;\n", "double");
    expect(d?.behavior).toBe("Returns n * 2.");
  });

  it("describes a single-return method", () => {
    const d = tpl(
      "src/a.ts",
      "export class Box {\n  size() {\n    return this.items.length;\n  }\n}\n",
      "Box.size",
    );
    expect(d?.behavior).toBe("Returns this.items.length.");
    expect(d?.searchTerms[0]).toBe("box size");
  });

  it("trims the expression to 80 chars", () => {
    const long = `"${"a".repeat(120)}"`;
    const d = tpl("src/a.ts", `export function big() {\n  return ${long};\n}\n`, "big");
    const expr = (d?.behavior ?? "").slice("Returns ".length, -1);
    expect(expr.length).toBeLessThanOrEqual(80);
    expect(expr.endsWith("…")).toBe(true);
  });

  it("keeps the sentence within 25 words", () => {
    const expr = Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ");
    const d = tpl("src/a.ts", `export function sum() {\n  return ${expr};\n}\n`, "sum");
    expect((d?.behavior ?? "").split(" ").length).toBeLessThanOrEqual(25);
  });

  it("works for components in tsx files", () => {
    const d = tpl("src/C.tsx", "export function Hello() {\n  return <div>hi</div>;\n}\n", "Hello");
    expect(d?.behavior).toBe("Returns <div>hi</div>.");
  });

  it("returns null for anything else", () => {
    expect(
      tpl("src/a.ts", "export function f(a: number) {\n  const b = a + 1;\n  return b;\n}\n", "f"),
    ).toBeNull();
    expect(tpl("src/a.ts", "export function g() {\n  console.log(1);\n}\n", "g")).toBeNull();
    expect(tpl("src/a.ts", "export function h() {\n  return;\n}\n", "h")).toBeNull();
    expect(tpl("src/a.ts", "export function i(x: number) {\n  if (x) return 1;\n}\n", "i")).toBeNull();
    expect(tpl("src/a.ts", "export interface T { a: number }\n", "T")).toBeNull();
  });
});

describe("termsFromName", () => {
  it("builds 1-6 short phrases from the identifier", () => {
    expect(termsFromName("parseHTTPResponse")).toEqual(["parse http response", "parse", "http", "response"]);
    expect(termsFromName("x")).toEqual(["x"]);
    expect(termsFromName("$")).toEqual(["function"]);
    expect(termsFromName("a_b_c_d_e_f_g_h").length).toBeLessThanOrEqual(6);
    for (const t of termsFromName("veryLongIdentifierNameThatKeepsGoingAndGoingAndGoing")) {
      expect(t.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("re-export templates", () => {
  const src = 'export { a, b as c } from "./x";\nexport * as ns from "./y";\nexport * from "./z";\n';
  const parsed = parseSource("src/index.ts", src);

  it("describes a re-export line", () => {
    expect(reexportTemplate(parsed, "c")?.behavior).toBe("Re-exports b from ./x.");
    expect(reexportTemplate(parsed, "a")?.behavior).toBe("Re-exports a from ./x.");
    expect(reexportTemplate(parsed, "ns")?.behavior).toBe("Re-exports the whole module ./y as a namespace.");
    expect(reexportTemplate(parsed, "missing")).toBeNull();
  });

  it("recognises barrel files", () => {
    expect(isBarrelFile(parsed)).toBe(true);
    expect(isBarrelFile(parseSource("src/a.ts", "export function f() { return 1; }\n"))).toBe(false);
  });
});

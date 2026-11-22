import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import type { Node } from "../parse/ast.js";
import { altText, evalUrl, localScope, moduleScope, type UrlPart } from "./urlEval.js";

/** The program of a snippet. */
const program = (code: string): Node[] =>
  (parseSync("x.ts", code, { sourceType: "module", lang: "ts" }).program as unknown as { body: Node[] }).body;

/**
 * The alternatives of the expression of the last statement of `code`, with the top-level declarations before it in
 * scope; `imports` stands for the names another module exports.
 */
function evalLast(code: string, imports: Record<string, string> = {}): UrlPart[][] | null {
  const body = program(code);
  const last = body[body.length - 1] as unknown as { expression: Node };
  const others = moduleScope(program(Object.values(imports).join("\n")));
  const scope = moduleScope(body.slice(0, -1), (name) => (imports[name] ? others.own(name) : null));
  return evalUrl(last.expression, scope)?.map((a) => a.parts) ?? null;
}

const UNKNOWN = { unknown: true };

describe("evalUrl", () => {
  it("reads string literals and templates", () => {
    expect(evalLast('"/api/users";')).toEqual([["/api/users"]]);
    expect(evalLast("`/api/users/${id}`;")).toEqual([["/api/users/", { unknown: true }]]);
    expect(evalLast("`/x/${1 + 1}`;")).toEqual([["/x/", UNKNOWN]]);
    expect(evalLast("`/a/${'b'}/c`;")).toEqual([["/a/b/c"]]);
  });

  it("reads `+` concatenation", () => {
    expect(evalLast('"/a" + "/b" + "/c";')).toEqual([["/a/b/c"]]);
  });

  it("reads a local const, a parameter as a param part and a variable as a param part", () => {
    const body = program(
      'function f(id: string) {\n  const base = "/api";\n  let v = "/z";\n  return base + "/users/" + id + v;\n}',
    );
    const fn = body[0] as Node;
    const ret = (fn.body as { body: Node[] }).body[2] as unknown as { argument: Node };
    const scope = localScope(moduleScope([]), fn);
    expect(evalUrl(ret.argument, scope)?.map((a) => a.parts)).toEqual([
      ["/api/users/", { param: "id" }, { param: "v" }],
    ]);
  });

  it("reads a top-level const and one that another module exports", () => {
    expect(evalLast('const API = "/api";\nAPI + "/users";')).toEqual([["/api/users"]]);
    expect(evalLast('API + "/users";', { API: 'export const API = "/api";' })).toEqual([["/api/users"]]);
    expect(evalLast("const A = B;\nA;", { B: 'export const B = "/b";' })).toEqual([["/b"]]);
  });

  it("reads an enum member", () => {
    expect(evalLast('enum P { Users = "/users", N }\nP.Users;')).toEqual([["/users"]]);
    expect(evalLast('enum P { Users = "/users", N }\nP.N;')).toEqual([[UNKNOWN]]);
    expect(evalLast("P.Users;", { P: 'export enum P { Users = "/users" }' })).toEqual([["/users"]]);
  });

  it("reads a member of an `as const` object, nested and computed keys included", () => {
    expect(evalLast('const R = { me: "/users/me" } as const;\nR.me;')).toEqual([["/users/me"]]);
    expect(evalLast('const R = { a: { b: "/x" } };\nR.a.b;')).toEqual([["/x"]]);
    expect(evalLast('const R = { "a-b": "/x" };\nR["a-b"];')).toEqual([["/x"]]);
    expect(evalLast("R.missing;", { R: 'export const R = { me: "/m" } as const;' })).toEqual([[UNKNOWN]]);
  });

  it("reads process.env.X and import.meta.env.X as env parts", () => {
    expect(evalLast("process.env.API_URL;")).toEqual([[{ env: "API_URL" }]]);
    expect(evalLast("import.meta.env.VITE_API;")).toEqual([[{ env: "VITE_API" }]]);
    expect(evalLast("`${import.meta.env.VITE_API}/users`;")).toEqual([[{ env: "VITE_API" }, "/users"]]);
  });

  it("keeps both sides of `??` and `||`", () => {
    expect(evalLast('import.meta.env.VITE_API ?? "/api";')).toEqual([[{ env: "VITE_API" }], ["/api"]]);
    expect(evalLast('process.env.X || "/b";')).toEqual([[{ env: "X" }], ["/b"]]);
    expect(evalLast('(process.env.X ?? "/api") + "/users";')).toEqual([
      [{ env: "X" }, "/users"],
      ["/api/users"],
    ]);
  });

  it("keeps both branches of a conditional", () => {
    expect(evalLast('import.meta.env.PROD ? "/a" : "/b";')).toEqual([["/a"], ["/b"]]);
  });

  it("reads `new URL(path, base)`: an absolute path replaces the base's path, a relative one joins it", () => {
    expect(evalLast('new URL("/orders/1", "https://h.example/api/");')).toEqual([
      ["https://h.example/orders/1"],
    ]);
    expect(evalLast('new URL("/orders/1", location.origin + "/api/");')).toEqual([["/orders/1"]]);
    expect(evalLast('new URL("orders/1", "/api/v1/");')).toEqual([["/api/v1/orders/1"]]);
    expect(evalLast('new URL("orders/1", "/api/v1");')).toEqual([["/api/orders/1"]]);
    expect(evalLast('new URL("orders", "https://h.example");')).toEqual([["https://h.example/orders"]]);
    expect(evalLast('new URL("https://other.example/x", "/api/");')).toEqual([["https://other.example/x"]]);
    expect(evalLast('new URL("/a");')).toEqual([["/a"]]);
  });

  it("gives an unknown part for anything else, and stops at depth 8", () => {
    expect(evalLast("f();")).toEqual([[UNKNOWN]]);
    expect(evalLast('"/a" + g();')).toEqual([["/a", UNKNOWN]]);
    const chain = [
      'const C0 = "/end";',
      ...Array.from({ length: 9 }, (_, i) => `const C${i + 1} = C${i};`),
      "C9;",
    ];
    expect(evalLast(chain.join("\n"))).toEqual([[UNKNOWN]]);
    expect(evalLast(chain.slice(0, 5).concat("C3;").join("\n"))).toEqual([["/end"]]);
  });

  it("is null for something that is no expression", () => {
    expect(evalUrl(undefined, moduleScope([]))).toBeNull();
  });
});

describe("altText", () => {
  it("writes text, a value known only at run time as :param, and is full unless env or unknown is in it", () => {
    expect(altText({ parts: ["/u/", { param: "id" }] })).toEqual({ text: "/u/:param", full: true });
    expect(altText({ parts: ["/u/", { unknown: true }] })).toEqual({ text: "/u/:param", full: false });
    expect(altText({ parts: ["/u/", { env: "X" }] })).toEqual({ text: "/u/:param", full: false });
    expect(altText({ parts: [] })).toEqual({ text: "", full: true });
  });

  it("is null for an alternative that does not start with text", () => {
    expect(altText({ parts: [{ env: "API" }, "/users"] })).toBeNull();
    expect(altText({ parts: [{ unknown: true }, "/users"] })).toBeNull();
    expect(altText({ parts: [{ param: "p" }] })).toBeNull();
  });
});

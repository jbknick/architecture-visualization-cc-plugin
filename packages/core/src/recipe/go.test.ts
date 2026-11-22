import { parse, type SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { grammarAvailable } from "../lang/engine/grammar.js";
import { goPack } from "../lang/packs/index.js";
import {
  concatOperands,
  declsNamed,
  findGoDecl,
  goParams,
  goStringValue,
  goTypeName,
  returnedExpressions,
  topLevelValues,
  wrapGoSnippet,
} from "./go.js";

grammarAvailable(goPack);
const root = (src: string): SgNode => parse("go" as never, src).root();
const first = (src: string, kind: string): SgNode => {
  const n = root(src).find({ rule: { kind } } as never);
  if (!n) throw new Error(`no ${kind} in ${src}`);
  return n;
};

describe("Go syntax helpers", () => {
  it("reads interpreted and raw string literals", () => {
    const src = 'package p\nvar a = "x\\ty\\"z"\nvar b = `raw\\n`\n';
    const lits = root(src).findAll({
      rule: { any: [{ kind: "interpreted_string_literal" }, { kind: "raw_string_literal" }] },
    } as never);
    expect(lits.map((l) => goStringValue(l))).toEqual(['x\ty"z', "raw\\n"]);
  });

  it("flattens a + chain of operands", () => {
    const e = first('package p\nvar a = "SELECT * FROM " + t + " WHERE x"\n', "binary_expression");
    expect(concatOperands(e).map((n) => n.text())).toEqual(['"SELECT * FROM "', "t", '" WHERE x"']);
  });

  it("names the type a type expression or a literal stands for", () => {
    const names = (src: string, kind: string): string | null => goTypeName(first(src, kind));
    expect(names("package p\nvar a = &User{}\n", "unary_expression")).toBe("User");
    expect(names("package p\nvar a = pkg.User{}\n", "composite_literal")).toBe("User");
    expect(names("package p\nvar a []*User\n", "slice_type")).toBe("User");
    expect(names("package p\nvar a = x\n", "identifier")).toBeNull();
  });

  it("finds the declaration a name refers to: a parameter, a local, or the nearest local before the use", () => {
    const src = `package p
func f(r Router, n int) {
	x := New()
	g(func(r Sub) {
		r.Get("/a", h)
	})
	r.Get("/b", h)
	x = 1
}
`;
    const uses = root(src).findAll({ rule: { pattern: "$R.Get($P, $H)" } } as never);
    const inner = findGoDecl(uses[0]?.getMatch("R") as SgNode, "r");
    expect(inner?.param?.index).toBe(0);
    expect(inner?.ident.range().start.line).toBe(3);
    const outer = findGoDecl(uses[1]?.getMatch("R") as SgNode, "r");
    expect(outer?.param?.fn.kind()).toBe("function_declaration");
    expect(outer?.ident.range().start.line).toBe(1);
    const local = findGoDecl(uses[1]?.getMatch("R") as SgNode, "x");
    expect(local?.value?.text()).toBe("New()");
    expect(findGoDecl(uses[1]?.getMatch("R") as SgNode, "missing")).toBeNull();
  });

  it("lists parameters, returns and the declarations of a name", () => {
    const src = `package p
func (a *A) Routes() Router {
	r := NewRouter()
	f := func() Router { return other() }
	_ = f
	return r
}
func g(a, b int, c string) {}
const prefix = "/api"
`;
    const routes = declsNamed(root(src), "Routes")[0] as SgNode;
    expect(returnedExpressions(routes).map((n) => n.text())).toEqual(["r"]);
    expect(goParams(declsNamed(root(src), "g")[0] as SgNode).map((n) => n.text())).toEqual(["a", "b", "c"]);
    expect(topLevelValues(root(src)).get("prefix")?.text()).toBe('"/api"');
  });

  it("wraps an example snippet so it parses as a file", () => {
    expect(wrapGoSnippet("r.Get(x)")).toBe("package p\nfunc _() {\nr.Get(x)\n}\n");
    expect(wrapGoSnippet("func f() {}")).toBe("package p\nfunc f() {}");
    expect(wrapGoSnippet("package q\nfunc f() {}")).toBe("package q\nfunc f() {}");
  });
});

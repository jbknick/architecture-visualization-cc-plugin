import { describe, expect, it } from "vitest";
import { parseTree } from "../engine/grammar.js";
import { goPack } from "../packs/index.js";
import { goAvailable } from "./index.js";

const parseGo = (source: string) => parseTree(goPack, source);

const SNIPPET = `package a

import al "x/y"

type S struct{ n int }
type I interface{ M() }
type A = int

const a, b = 1, 2

var (
	x = 1
	y = 2
)

func F[T any](v T) T { return v }

type G[T any] struct{ v T }

func (g *G[T]) N() {}

func (s *S) M() {
	// note
	v := 1
	_ = v
}
`;

describe("tree-sitter Go grammar", () => {
  it("loads on this platform", () => {
    expect(goAvailable()).toBe(true);
  });

  it("names the node kinds the parser relies on", () => {
    const root = parseGo(SNIPPET);
    const kinds = new Set<string>();
    const walk = (n: ReturnType<typeof parseGo>): void => {
      kinds.add(n.kind());
      for (const c of n.children()) walk(c);
    };
    walk(root);
    for (const k of [
      "function_declaration",
      "method_declaration",
      "type_declaration",
      "type_spec",
      "type_alias",
      "struct_type",
      "interface_type",
      "const_declaration",
      "const_spec",
      "var_declaration",
      "var_spec",
      "var_spec_list",
      "import_declaration",
      "import_spec",
      "generic_type",
      "pointer_type",
      "parameter_declaration",
      "short_var_declaration",
      "comment",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("exposes the fields the parser reads", () => {
    const root = parseGo(SNIPPET);
    const fn = root.namedChildren().find((n) => n.kind() === "function_declaration");
    expect(fn?.field("name")?.text()).toBe("F");
    expect(fn?.field("parameters")?.kind()).toBe("parameter_list");
    expect(fn?.field("body")?.kind()).toBe("block");
    const method = root.namedChildren().find((n) => n.kind() === "method_declaration");
    expect(method?.field("receiver")?.kind()).toBe("parameter_list");
    const spec = root.find({ rule: { kind: "const_spec" } });
    // The `name` field of `const a, b` also holds the comma: the parser keeps `identifier` nodes only.
    expect(spec?.fieldChildren("name").map((n) => n.kind())).toEqual(["identifier", ",", "identifier"]);
    const imp = root.find({ rule: { kind: "import_spec" } });
    expect(imp?.field("path")?.text()).toBe('"x/y"');
    expect(imp?.field("name")?.text()).toBe("al");
  });
});

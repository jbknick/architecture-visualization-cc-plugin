import { describe, expect, it } from "vitest";
import { grammarAvailable, parseTree } from "../engine/grammar.js";
import { javaPack } from "./index.js";

const parseJava = (source: string) => parseTree(javaPack, source);

const SNIPPET = `package a.b;

import c.D;
import static c.E.f;
import c.g.*;

public class S<T> extends P implements I, J {
    private int n, m = 1;
    private String[] ys;
    S() { this(1); }
    S(int a) {}
    void run(String... xs) {
        var h = new H<>();
        for (Item i : items) { i.go(); }
        try { } catch (IOException e) { }
        Runnable r = () -> h.go();
        this.n = ((Q) h).size();
        arr[0].go();
        super.run();
    }
    enum E { A; void e() {} }
    record R(int x) { R {} }
}
interface I extends K { void m(); }
@interface M {}
`;

describe("tree-sitter Java grammar", () => {
  it("loads on this platform", () => {
    expect(grammarAvailable(javaPack)).toBe(true);
  });

  it("names the node kinds the pack relies on", () => {
    const kinds = new Set<string>();
    const walk = (n: ReturnType<typeof parseJava>): void => {
      kinds.add(n.kind());
      for (const c of n.children()) walk(c);
    };
    walk(parseJava(SNIPPET));
    for (const k of [
      "package_declaration",
      "import_declaration",
      "asterisk",
      "static",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "enum_body_declarations",
      "record_declaration",
      "annotation_type_declaration",
      "method_declaration",
      "constructor_declaration",
      "compact_constructor_declaration",
      "field_declaration",
      "variable_declarator",
      "formal_parameter",
      "spread_parameter",
      "superclass",
      "super_interfaces",
      "extends_interfaces",
      "method_invocation",
      "object_creation_expression",
      "field_access",
      "array_access",
      "cast_expression",
      "enhanced_for_statement",
      "catch_formal_parameter",
      "lambda_expression",
      "generic_type",
      "array_type",
      "this",
      "super",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("exposes the fields the pack reads", () => {
    const root = parseJava(SNIPPET);
    const cls = root.find({ rule: { kind: "class_declaration" } });
    expect(cls?.field("name")?.text()).toBe("S");
    expect(cls?.field("superclass")?.kind()).toBe("superclass");
    expect(cls?.field("interfaces")?.kind()).toBe("super_interfaces");
    expect(cls?.field("body")?.kind()).toBe("class_body");
    expect(cls?.field("type_parameters")?.kind()).toBe("type_parameters");
    const run = root.find({ rule: { kind: "method_declaration" } });
    expect(run?.field("type")?.text()).toBe("void");
    expect(run?.field("parameters")?.kind()).toBe("formal_parameters");
    const field = root.find({ rule: { kind: "field_declaration" } });
    expect(field?.field("type")?.text()).toBe("int");
    expect(field?.fieldChildren("declarator").map((n) => n.field("name")?.text())).toEqual(["n", "m"]);
    const call = root.find({ rule: { kind: "method_invocation" } });
    expect(call?.field("name")?.text()).toBe("go");
    expect(call?.field("arguments")?.kind()).toBe("argument_list");
    const imports = root.findAll({ rule: { kind: "import_declaration" } });
    expect(imports.map((i) => i.children().some((c) => c.kind() === "static"))).toEqual([false, true, false]);
    expect(imports.map((i) => i.namedChildren().some((c) => c.kind() === "asterisk"))).toEqual([
      false,
      false,
      true,
    ]);
    const ext = root.find({ rule: { kind: "extends_interfaces" } });
    expect(ext?.text()).toBe("extends K");
  });
});

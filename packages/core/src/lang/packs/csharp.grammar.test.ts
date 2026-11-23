import { describe, expect, it } from "vitest";
import { grammarAvailable, parseTree } from "../engine/grammar.js";
import { csharpPack } from "./index.js";

const parseCs = (source: string) => parseTree(csharpPack, source);

const SNIPPET = `global using static A.B.T;
using System;
using L = A.B.List<int>;

namespace A.B;

public partial class S<T> : P, I where T : class
{
    private int n, m = 1;
    private string[] ys;
    public Q Prop { get; set; }
    public int Count => Total();
    public S() : base() { }
    public S(int a, string b = "x", params int[] rest) { }
    ~S() { }
    void Run(this string s)
    {
        var h = new H();
        foreach (Item i in items) { i.Go(); }
        foreach (var (k, v) in pairs) { }
        try { } catch (IOException e) { }
        System.Action<int> r = x => h.Go();
        if (o is Foo f) f.Go();
        if (o is Foo { Bar: 1 } g) { }
        int Local() => 1;
        Try(out var z);
        var q = from y in ys select y;
        this.n = ((Q)h).Size();
        (a, b) = Pair();
        arr[0].Go();
        base.Run();
        x?.Go();
        Pick<int>(1);
        Ext.Do<int>();
        var w = o as W;
        var u = (Nullable?)null;
    }
    enum E { A }
    record R(int X);
    struct V { }
}
interface I : K { void M(); }
`;

describe("tree-sitter C# grammar", () => {
  it("loads on this platform", () => {
    expect(grammarAvailable(csharpPack)).toBe(true);
  });

  it("names the node kinds the pack relies on", () => {
    const kinds = new Set<string>();
    const walk = (n: ReturnType<typeof parseCs>): void => {
      kinds.add(n.kind());
      for (const c of n.children()) walk(c);
    };
    walk(parseCs(SNIPPET));
    for (const k of [
      "using_directive",
      "qualified_name",
      "generic_name",
      "type_argument_list",
      "predefined_type",
      "nullable_type",
      "array_type",
      "implicit_type",
      "file_scoped_namespace_declaration",
      "class_declaration",
      "struct_declaration",
      "record_declaration",
      "interface_declaration",
      "enum_declaration",
      "modifier",
      "base_list",
      "declaration_list",
      "type_parameter_list",
      "type_parameter",
      "field_declaration",
      "property_declaration",
      "variable_declaration",
      "variable_declarator",
      "method_declaration",
      "constructor_declaration",
      "parameter_list",
      "parameter",
      "invocation_expression",
      "member_access_expression",
      "conditional_access_expression",
      "object_creation_expression",
      "element_access_expression",
      "cast_expression",
      "as_expression",
      "parenthesized_expression",
      "argument_list",
      "foreach_statement",
      "catch_declaration",
      "declaration_pattern",
      "recursive_pattern",
      "declaration_expression",
      "tuple_pattern",
      "from_clause",
      "lambda_expression",
      "implicit_parameter",
      "local_function_statement",
      "local_declaration_statement",
      "expression_statement",
      "if_statement",
      "this",
      "base",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
    for (const k of [
      "namespace_declaration",
      "for_statement",
      "while_statement",
      "do_statement",
      "switch_section",
      "switch_expression_arm",
      "catch_clause",
      "conditional_expression",
      "binary_expression",
      "return_statement",
      "switch_statement",
      "try_statement",
      "throw_statement",
      "break_statement",
      "continue_statement",
      "lock_statement",
      "using_statement",
      "yield_statement",
      "checked_statement",
      "comment",
      "integer_literal",
      "real_literal",
      "string_literal",
      "character_literal",
      "verbatim_string_literal",
      "raw_string_literal",
    ]) {
      const probe = parseCs(
        `namespace N { class C { void M() { for(;;){} while(true){} do{}while(true); switch(1){case 1: break; default: break;} var s = 1 switch { 1 => 2, _ => 3 }; try{}catch(E){} var c = a ? 1 : 2; var b = a && b; return; throw e; continue; lock(a){} using(var d = e){} yield return 1; checked{} using var f = g; var i = 1; var r = 1.5; var t = "s"; var ch = 'c'; var v = @"v"; var w = """w"""; // c
 } } }`,
      );
      expect(probe.find({ rule: { kind: k } }) !== null, k).toBe(true);
    }
  });

  it("exposes the fields the pack reads", () => {
    const root = parseCs(SNIPPET);
    const cls = root.find({ rule: { kind: "class_declaration" } });
    expect(cls?.field("name")?.text()).toBe("S");
    expect(cls?.field("body")?.kind()).toBe("declaration_list");
    expect(cls?.children().some((c) => c.kind() === "modifier" && c.text() === "partial")).toBe(true);
    expect(
      cls
        ?.namedChildren()
        .find((c) => c.kind() === "base_list")
        ?.text(),
    ).toBe(": P, I");
    expect(cls?.namedChildren().some((c) => c.kind() === "type_parameter_list")).toBe(true);
    const ns = root.find({ rule: { kind: "file_scoped_namespace_declaration" } });
    expect(ns?.field("name")?.text()).toBe("A.B");
    const method = root.find({ rule: { kind: "method_declaration" } });
    expect(method?.field("returns")?.text()).toBe("void");
    expect(method?.field("parameters")?.kind()).toBe("parameter_list");
    expect(method?.field("body")?.kind()).toBe("block");
    const first = method?.field("parameters")?.namedChildren()[0];
    expect(first?.children().some((c) => c.text() === "this")).toBe(true);
    expect(first?.field("type")?.text()).toBe("string");
    const field = root.find({ rule: { kind: "field_declaration" } });
    const held = field?.namedChildren().find((c) => c.kind() === "variable_declaration");
    expect(held?.field("type")?.text()).toBe("int");
    expect(
      held
        ?.namedChildren()
        .filter((c) => c.kind() === "variable_declarator")
        .map((c) => c.field("name")?.text()),
    ).toEqual(["n", "m"]);
    const prop = root.find({ rule: { kind: "property_declaration" } });
    expect(prop?.field("type")?.text()).toBe("Q");
    expect(prop?.field("name")?.text()).toBe("Prop");
    const call = root.find({ rule: { kind: "invocation_expression" } });
    expect(call?.field("function")).not.toBeNull();
    expect(call?.field("arguments")?.kind()).toBe("argument_list");
    const access = root.find({ rule: { kind: "member_access_expression" } });
    expect(access?.field("expression")?.text()).toBe("i");
    expect(access?.field("name")?.text()).toBe("Go");
    const create = root.find({ rule: { kind: "object_creation_expression" } });
    expect(create?.field("type")?.text()).toBe("H");
    expect(create?.field("arguments")?.kind()).toBe("argument_list");
    const generic = root.find({ rule: { kind: "generic_name" } });
    expect(generic?.namedChildren()[0]?.kind()).toBe("identifier");
    const each = root.find({ rule: { kind: "foreach_statement" } });
    expect(each?.field("type")?.text()).toBe("Item");
    expect(each?.field("left")?.text()).toBe("i");
    const lambda = root.find({ rule: { kind: "lambda_expression" } });
    expect(lambda?.field("parameters")?.kind()).toBe("implicit_parameter");
    const pattern = root.find({ rule: { kind: "declaration_pattern" } });
    expect(pattern?.field("type")?.text()).toBe("Foo");
    expect(pattern?.field("name")?.text()).toBe("f");
    const arr = root.find({ rule: { kind: "element_access_expression" } });
    expect(arr?.field("expression")?.text()).toBe("arr");
    const cast = root.find({ rule: { kind: "cast_expression" } });
    expect(cast?.field("type")?.text()).toBe("Q");
    const asOf = root.find({ rule: { kind: "as_expression" } });
    expect(asOf?.field("right")?.text()).toBe("W");
    const usings = root.findAll({ rule: { kind: "using_directive" } });
    expect(usings.map((u) => u.field("name")?.text())).toEqual([undefined, undefined, "L"]);
    expect(usings.map((u) => u.children().some((c) => c.kind() === "static"))).toEqual([true, false, false]);
    const ctor = root.findAll({ rule: { kind: "constructor_declaration" } })[1];
    // A `params` parameter has no node of its own: its type and name sit in the list.
    const params = (ctor?.field("parameters")?.namedChildren() ?? []).filter((p) => p.kind() === "parameter");
    expect(params.map((p) => p.children().some((c) => c.kind() === "="))).toEqual([false, true]);
    const rest = ctor?.field("parameters")?.fieldChildren("name") ?? [];
    expect(rest.map((n) => n.text())).toEqual(["rest"]);
    const iface = root.find({ rule: { kind: "interface_declaration" } });
    const bases = iface?.namedChildren().find((c) => c.kind() === "base_list");
    expect(bases?.text()).toBe(": K");
  });
});

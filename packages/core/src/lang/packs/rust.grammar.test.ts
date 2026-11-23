import { describe, expect, it } from "vitest";
import { grammarAvailable, parseTree } from "../engine/grammar.js";
import { rustPack } from "./index.js";

const parseRs = (source: string) => parseTree(rustPack, source);

const SNIPPET = `// @generated
use std::fmt;
use crate::shapes::{Circle, Square as Sq, self, inner::{A, B}, *};
use super::util::clamp;
pub mod geometry;
mod inline { pub fn f() {} }

pub trait Shape: Named + Send {
    fn area(&self) -> f64;
    fn label(&self) -> String { String::new() }
}

pub struct Circle<T: Shape> { pub r: f64, s: Box<dyn Shape>, t: T }
struct P(f64, f64);
enum E { A(i32), B { x: i32 } }

impl<T: Shape> Circle<T> where T: Send {
    pub fn new(r: f64) -> Self { Self { r } }
    fn go(&self, x: &mut dyn Shape, y: impl Shape, z: &'a Foo) {
        let a: Circle<i32> = Circle::new(1.0);
        let c = Foo { x: 1 };
        x.area();
        self.go2();
        Self::new(1.0);
        crate::a::b::f();
        shout!(1);
        let n = m as u8;
        for i in v {}
        let f = |p, q: u8| p;
        if let Some(y) = z {}
        match q { Foo::A(k) => 1, w => 2 }
        let (d, e) = t;
        let &g = h;
        let r = &c;
    }
}

impl fmt::Display for Circle<i32> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) }
}
`;

describe("tree-sitter Rust grammar", () => {
  it("loads on this platform", () => {
    expect(grammarAvailable(rustPack)).toBe(true);
  });

  it("names the node kinds the pack relies on", () => {
    const kinds = new Set<string>();
    const walk = (n: ReturnType<typeof parseRs>): void => {
      kinds.add(n.kind());
      for (const c of n.children()) walk(c);
    };
    walk(parseRs(SNIPPET));
    for (const k of [
      "use_declaration",
      "scoped_use_list",
      "use_list",
      "use_as_clause",
      "use_wildcard",
      "scoped_identifier",
      "scoped_type_identifier",
      "mod_item",
      "declaration_list",
      "function_item",
      "function_signature_item",
      "trait_item",
      "trait_bounds",
      "struct_item",
      "enum_item",
      "enum_variant_list",
      "field_declaration_list",
      "field_declaration",
      "ordered_field_declaration_list",
      "impl_item",
      "type_parameters",
      "constrained_type_parameter",
      "where_clause",
      "where_predicate",
      "parameters",
      "parameter",
      "self_parameter",
      "reference_type",
      "dynamic_type",
      "abstract_type",
      "generic_type",
      "type_arguments",
      "type_identifier",
      "primitive_type",
      "lifetime",
      "mutable_specifier",
      "let_declaration",
      "let_condition",
      "for_expression",
      "match_pattern",
      "tuple_pattern",
      "tuple_struct_pattern",
      "reference_pattern",
      "closure_expression",
      "closure_parameters",
      "call_expression",
      "field_expression",
      "struct_expression",
      "type_cast_expression",
      "reference_expression",
      "macro_invocation",
      "block",
      "self",
      "crate",
      "super",
      "line_comment",
      "visibility_modifier",
    ]) {
      expect(kinds, `kind ${k}`).toContain(k);
    }
  });

  it("names the fields the pack relies on", () => {
    const root = parseRs(SNIPPET);
    const find = (kind: string, nth = 0) => root.findAll({ rule: { kind } })[nth];
    // A use tree: the argument is a path, a path with a list, an alias or a wildcard.
    const uses = root.findAll({ rule: { kind: "use_declaration" } });
    expect(uses.map((u) => u.field("argument")?.kind())).toEqual([
      "scoped_identifier",
      "scoped_use_list",
      "scoped_identifier",
    ]);
    const group = find("scoped_use_list");
    expect(group?.field("path")?.text()).toBe("crate::shapes");
    expect(group?.field("list")?.kind()).toBe("use_list");
    expect(find("use_as_clause")?.field("path")?.text()).toBe("Square");
    expect(find("use_as_clause")?.field("alias")?.text()).toBe("Sq");
    expect(
      group
        ?.field("list")
        ?.namedChildren()
        .map((c) => c.kind()),
    ).toEqual(["identifier", "use_as_clause", "self", "scoped_use_list", "use_wildcard"]);
    // A module with a body is written in place; one without is a file.
    const mods = root.findAll({ rule: { kind: "mod_item" } });
    expect(mods.map((m) => [m.field("name")?.text(), m.field("body") !== null])).toEqual([
      ["geometry", false],
      ["inline", true],
    ]);
    // Declarations.
    const fn = find("function_item", 1);
    expect(fn?.field("name")?.text()).toBe("label");
    expect(fn?.field("return_type")?.text()).toBe("String");
    expect(find("function_signature_item")?.field("body")).toBeNull();
    expect(find("trait_item")?.field("bounds")?.kind()).toBe("trait_bounds");
    expect(find("trait_item")?.field("body")?.kind()).toBe("declaration_list");
    expect(find("struct_item")?.field("body")?.kind()).toBe("field_declaration_list");
    expect(find("struct_item", 1)?.field("body")?.kind()).toBe("ordered_field_declaration_list");
    expect(find("enum_item")?.field("body")?.kind()).toBe("enum_variant_list");
    const field = find("field_declaration", 1);
    expect(field?.field("name")?.kind()).toBe("field_identifier");
    expect(field?.field("type")?.kind()).toBe("generic_type");
    // An impl block.
    const impls = root.findAll({ rule: { kind: "impl_item" } });
    expect(impls[0]?.field("type")?.kind()).toBe("generic_type");
    expect(impls[0]?.field("type")?.field("type")?.text()).toBe("Circle");
    expect(impls[0]?.field("trait")).toBeNull();
    expect(impls[0]?.field("type_parameters")?.kind()).toBe("type_parameters");
    expect(impls[0]?.field("body")?.kind()).toBe("declaration_list");
    expect(impls[1]?.field("trait")?.kind()).toBe("scoped_type_identifier");
    // Type parameters and their bounds.
    const bounded = find("constrained_type_parameter");
    expect(bounded?.field("left")?.text()).toBe("T");
    expect(bounded?.field("bounds")?.kind()).toBe("trait_bounds");
    const predicate = find("where_predicate");
    expect(predicate?.field("left")?.text()).toBe("T");
    expect(predicate?.field("bounds")?.text()).toBe(": Send");
    // Types that wrap a type.
    expect(find("reference_type")?.field("type")?.kind()).toBe("dynamic_type");
    expect(
      find("reference_type")
        ?.children()
        .some((c) => c.kind() === "mutable_specifier"),
    ).toBe(true);
    expect(find("dynamic_type")?.field("trait")?.text()).toBe("Shape");
    expect(find("abstract_type")?.field("trait")?.text()).toBe("Shape");
    expect(find("generic_type")?.field("type")?.text()).toBe("Box");
    expect(find("generic_type")?.field("type_arguments")?.kind()).toBe("type_arguments");
    expect(find("scoped_type_identifier")?.field("path")?.text()).toBe("fmt");
    expect(find("scoped_type_identifier")?.field("name")?.text()).toBe("Display");
    // Parameters and locals.
    const param = find("parameter");
    expect(param?.field("pattern")?.text()).toBe("r");
    expect(param?.field("type")?.text()).toBe("f64");
    const lets = root.findAll({ rule: { kind: "let_declaration" } });
    expect(lets[0]?.field("pattern")?.text()).toBe("a");
    expect(lets[0]?.field("type")?.kind()).toBe("generic_type");
    expect(lets[0]?.field("value")?.kind()).toBe("call_expression");
    expect(lets[1]?.field("value")?.kind()).toBe("struct_expression");
    expect(find("for_expression")?.field("pattern")?.text()).toBe("i");
    expect(find("let_condition")?.field("pattern")?.kind()).toBe("tuple_struct_pattern");
    // The patterns hold their names as children.
    expect(
      find("tuple_pattern")
        ?.namedChildren()
        .map((c) => c.text()),
    ).toEqual(["d", "e"]);
    expect(find("match_pattern")?.namedChildren()[0]?.kind()).toBe("tuple_struct_pattern");
    expect(
      find("closure_parameters")
        ?.namedChildren()
        .map((c) => c.kind()),
    ).toEqual(["identifier", "parameter"]);
    // Calls.
    const calls = root.findAll({ rule: { kind: "call_expression" } });
    const method = calls.find((c) => c.field("function")?.kind() === "field_expression");
    expect(method?.field("function")?.field("value")?.text()).toBe("x");
    expect(method?.field("function")?.field("field")?.text()).toBe("area");
    expect(method?.field("arguments")?.kind()).toBe("arguments");
    const scoped = calls.find((c) => c.field("function")?.text() === "crate::a::b::f");
    expect(scoped?.field("function")?.field("name")?.text()).toBe("f");
    expect(scoped?.field("function")?.field("path")?.kind()).toBe("scoped_identifier");
    expect(scoped?.field("function")?.field("path")?.field("path")?.field("path")?.kind()).toBe("crate");
    expect(find("struct_expression")?.field("name")?.text()).toBe("Self");
    expect(find("type_cast_expression")?.field("type")?.text()).toBe("u8");
    expect(find("reference_expression")?.field("value")?.text()).toBe("c");
    // A macro's arguments are a token tree, not expressions.
    expect(find("macro_invocation")?.find({ rule: { kind: "call_expression" } })).toBeNull();
    // `binary_expression` has an operator field.
    const bin = parseRs("fn f() { a && b; }").find({ rule: { kind: "binary_expression" } });
    expect(bin?.field("operator")?.text()).toBe("&&");
  });
});

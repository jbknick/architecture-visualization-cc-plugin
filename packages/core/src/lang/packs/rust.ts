import type { LanguagePack } from "../engine/pack.js";

/**
 * The Rust pack (spec section 3, `lang/packs/`): tree-sitter Rust through `@ast-grep/napi` (no Cargo, no compiler), one
 * workspace per `Cargo.toml` that has a `[package]`. The node kinds and field names are those of the tree-sitter Rust
 * grammar.
 */
export const rustPack = {
  id: "rust",
  label: "Rust",
  extensions: [".rs"],
  skipPaths: ["**/target/**"],
  testPatterns: ["**/tests/**", "**/*_test.rs", "**/tests.rs"],
  // A generated file starts with the comment `// @generated`.
  generatedPatterns: [/^\/\/ @generated\b/],
  generatedPaths: [],
  grammar: { package: "@ast-grep/lang-rust", name: "rust" },
  nodes: {
    errorKind: "ERROR",
    function: [
      {
        kind: "function_item",
        name: "name",
        parameters: "parameters",
        result: "return_type",
        body: "body",
        generics: "type_parameters",
      },
    ],
    // A method is a function in a trait or in an `impl` block; a trait also declares methods that have no body.
    method: [
      {
        kind: "function_item",
        name: "name",
        parameters: "parameters",
        result: "return_type",
        body: "body",
        generics: "type_parameters",
      },
      {
        kind: "function_signature_item",
        name: "name",
        parameters: "parameters",
        result: "return_type",
        generics: "type_parameters",
      },
    ],
    types: {
      declarations: [],
      specs: [],
      groups: [],
      aliases: [],
      name: "name",
      type: "type",
      class: [],
      interface: [],
      bodied: [
        { kind: "struct_item", as: "class", name: "name", body: "body" },
        { kind: "enum_item", as: "enum", name: "name", body: "body" },
        { kind: "trait_item", as: "interface", name: "name", body: "body" },
      ],
      // A module written in place (`mod a { ... }`) is not walked: its names are not those of the file.
      bodies: [],
      // `impl T { ... }` and `impl I for T { ... }`: the methods are methods of `T`, wherever the block is. A block whose
      // type is one of its own type parameters (`impl<T: A> B for T`) names no type.
      impls: {
        kind: "impl_item",
        type: "type",
        interface: "trait",
        body: "body",
        baseType: {
          names: ["type_identifier"],
          wrappers: [],
          generic: { kind: "generic_type", field: "type" },
          unknown: "?",
        },
        generics: "type_parameters",
      },
    },
    values: { declarations: [], specs: [], groups: [], name: "name", nameKinds: [] },
    import: {
      declarations: [],
      specs: [],
      groups: [],
      quotes: "",
      separator: "::",
      localName: { skip: /^$/ },
      // `use a::{b, c as d, e::*, self}`.
      trees: {
        declarations: ["use_declaration"],
        argument: "argument",
        scoped: { kind: "scoped_use_list", path: "path", list: "list" },
        list: "use_list",
        aliased: { kind: "use_as_clause", path: "path", alias: "alias" },
        onDemand: "use_wildcard",
        self: "self",
      },
      // `mod a;` imports the module `a` (a file of its own) from the module around it.
      submodules: { kind: "mod_item", name: "name", body: "body", parent: "self" },
    },
    call: ["call_expression"],
    callee: {
      field: "function",
      names: ["identifier"],
      member: { kind: "field_expression", operand: "value", name: "field", operands: ["identifier"] },
    },
    typing: {
      type: {
        names: ["type_identifier"],
        qualified: { kind: "scoped_type_identifier", qualifier: "path", name: "name" },
        wrappers: [],
        // A reference, `dyn T` and `impl T` read as the type they hold; a pointer, a tuple and a function type are not read.
        fielded: [
          { kind: "reference_type", field: "type" },
          { kind: "dynamic_type", field: "trait" },
          { kind: "abstract_type", field: "trait" },
        ],
        self: "Self",
        generic: { kind: "generic_type", field: "type", arguments: "type_arguments" },
        // `T: A` and `where T: A`: a parameter with one bound is read as that trait, one with several is not read.
        parameters: {
          entry: "constrained_type_parameter",
          names: ["type_identifier"],
          bare: ["type_identifier"],
          bounds: {
            name: "left",
            field: "bounds",
            ignore: ["lifetime", "removed_trait_bound"],
            where: { kind: "where_clause", predicate: "where_predicate", name: "left", bounds: "bounds" },
          },
        },
        sequences: [{ kind: "array_type", element: "element" }],
        predeclared: [],
        unread: [],
      },
      // Each file is a module, found by its path below the workspace (or below its `src` folder); `mod.rs` stands for its
      // folder, and `lib.rs` (else `main.rs`) for the crate. A path starts with `crate`, `self`, `super`, the name of a
      // crate or the name of a module of the module around it.
      package: {
        path: "file",
        roots: ["src"],
        index: "mod",
        entries: ["lib", "main"],
        reexports: 3,
        paths: { root: "crate", self: "self", parent: "super" },
      },
      unboundAliases: ["_"],
      members: {
        container: "field_declaration_list",
        entries: ["field_declaration"],
        name: "name",
        nameKinds: ["field_identifier"],
        type: "type",
        callable: false,
      },
      interfaces: { embeds: [], embedKinds: [] },
      // `trait A: B + C` lists the supertraits of A. `impl I for T` is read by `types.impls`.
      supertypes: [{ field: "bounds", edge: "extends" }],
      implements: "nominal",
      // The number of arguments leaves out the receiver; where it does not tell methods of one name apart, there is no edge.
      arity: { arguments: "arguments", parameters: ["parameter"], variadic: [], overloads: "none" },
      self: ["self"],
      generics: "type_parameters",
      vars: { declarations: [], specs: [], type: "type", value: "value" },
      unnamed: [],
      callee: {
        names: ["identifier"],
        members: [{ kind: "field_expression", operand: "value", name: "field" }],
        operands: ["identifier"],
        paths: [
          {
            kind: "scoped_identifier",
            path: "path",
            name: "name",
            segments: ["identifier", "crate", "self", "super"],
          },
        ],
        operandsAreValues: true,
      },
      expressions: {
        // `(x.f)(a)` calls a field, not a method: parentheses are not read through.
        wrappers: [],
        names: ["identifier"],
        // An index expression has no field of its own: its element is not read.
        index: { kind: "index_expression", operand: "value" },
        through: [{ kind: "reference_expression", operand: "value" }],
        typed: [
          { kind: "struct_expression", type: "name" },
          { kind: "type_cast_expression", type: "type" },
        ],
      },
      locals: {
        nameKinds: ["identifier", "shorthand_field_identifier"],
        nameLists: [],
        parameters: [{ kind: "parameter", name: "pattern", type: "type", variadic: false, from: "start" }],
        declarations: [
          { kind: "let_declaration", names: "pattern", type: "type", values: "value", from: "end" },
        ],
        inferred: [],
        valueLists: [],
        ranges: [],
        // Every other name a pattern binds hides a function of that name; its type is not read.
        untyped: [
          { kind: "closure_parameters", names: "", from: "start" },
          { kind: "for_expression", names: "pattern", from: "start" },
          { kind: "let_condition", names: "pattern", from: "start" },
          { kind: "match_pattern", names: "", from: "start" },
          { kind: "tuple_pattern", names: "", from: "start" },
          { kind: "tuple_struct_pattern", names: "", from: "start" },
          { kind: "struct_pattern", names: "", from: "start" },
          { kind: "field_pattern", names: "", from: "start" },
          { kind: "slice_pattern", names: "", from: "start" },
          { kind: "reference_pattern", names: "", from: "start" },
          { kind: "or_pattern", names: "", from: "start" },
          { kind: "mut_pattern", names: "", from: "start" },
          { kind: "ref_pattern", names: "", from: "start" },
          { kind: "captured_pattern", names: "", from: "start" },
          // A function declared in a block is known in the whole block.
          { kind: "function_item", names: "name", from: "start", scope: ["block"] },
        ],
      },
      lookups: [
        "call_expression",
        "field_expression",
        "identifier",
        "scoped_identifier",
        "struct_expression",
      ],
    },
    // A `pub` item is exported (`pub(crate)` too); the methods of a trait are those of the trait.
    exported: {
      by: "modifier",
      node: "visibility_modifier",
      keywords: ["pub"],
      implicit: [],
      owners: ["trait_item"],
    },
    signature: { empty: "()", maxLength: 200 },
    measure: {
      branches: ["if_expression", "for_expression", "while_expression", "loop_expression", "match_arm"],
      binary: { kind: "binary_expression", operator: "operator", operators: ["&&", "||"] },
      statements: ["expression_statement", "let_declaration", "const_item", "static_item"],
    },
  },
  workspace: {
    manifests: [
      {
        files: ["Cargo.toml"],
        format: "toml",
        quotes: "",
        comment: /#.*$/gm,
        // A manifest without `[package]` (the root of a workspace of crates) names no crate.
        name: [{ path: "package.name" }],
        deps: { keys: "dependencies" },
      },
    ],
    skipDirs: ["target", "node_modules"],
    main: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/m,
    // `acme-core` and `acme_core` name one crate.
    sameName: { fold: /-/g, as: "_", lower: false },
  },
  tokens: {
    identifiers: ["identifier", "type_identifier", "field_identifier", "shorthand_field_identifier"],
    local: "identifier",
    strings: ["string_literal", "raw_string_literal", "char_literal"],
    numbers: ["integer_literal", "float_literal"],
    comments: ["line_comment", "block_comment"],
    punctuation: ["(", ")", "{", "}", "[", "]", ",", ";"],
    ownName: "name",
    locals: {
      parameters: { kinds: ["parameter"], field: "pattern" },
      bindings: [
        { kind: "let_declaration", field: "pattern" },
        { kind: "for_expression", field: "pattern" },
        { kind: "let_condition", field: "pattern" },
        { kind: "closure_parameters", field: "" },
        { kind: "match_pattern", field: "" },
      ],
      specs: { kinds: [], field: "name" },
      blank: "_",
    },
    embedding: {
      strings: ["string_literal"],
      stringText: '"s"',
      localPrefix: "v",
    },
  },
  kindLabels: {
    function: "function",
    method: "method",
    component: "component",
    hook: "hook",
    class: "struct",
    type: "type",
    interface: "trait",
    enum: "enum",
    const: "constant",
  },
  factSheetHints: [],
  thresholds: { exactMinStmts: 3, nearMinStmts: 6 },
} as const satisfies LanguagePack;

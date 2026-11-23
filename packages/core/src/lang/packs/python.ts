import type { LanguagePack } from "../engine/pack.js";

/**
 * The Python pack (spec section 3, `lang/packs/`): tree-sitter Python through `@ast-grep/napi` (no interpreter), a
 * `pyproject.toml`, `setup.cfg` or `setup.py` directory as a workspace. The node kinds and field names are those of the
 * tree-sitter Python grammar.
 */
export const pythonPack = {
  id: "python",
  label: "Python",
  extensions: [".py", ".pyi"],
  skipPaths: [
    "**/.venv/**",
    "**/venv/**",
    "**/__pycache__/**",
    "**/site-packages/**",
    "**/build/**",
    "**/dist/**",
  ],
  testPatterns: ["**/tests/**", "**/test_*.py", "**/*_test.py"],
  generatedPatterns: [],
  generatedPaths: ["**/*_pb2.py", "**/*_pb2_grpc.py"],
  grammar: { package: "@ast-grep/lang-python", name: "python" },
  nodes: {
    errorKind: "ERROR",
    // `async def` is the same node kind, with an `async` child.
    function: [
      {
        kind: "function_definition",
        name: "name",
        parameters: "parameters",
        result: "return_type",
        body: "body",
      },
    ],
    method: [
      {
        kind: "function_definition",
        name: "name",
        parameters: "parameters",
        result: "return_type",
        body: "body",
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
      bodied: [{ kind: "class_definition", as: "class", name: "name", body: "body" }],
      // A decorated definition holds the definition; a statement holds an assignment (an annotated attribute of a class).
      bodies: ["decorated_definition", "expression_statement"],
    },
    // Assignments are not symbols; the names of one at the top of a file are read for `typing.vars` only.
    values: { declarations: [], specs: [], groups: [], name: "left", nameKinds: ["identifier"] },
    import: {
      declarations: [],
      specs: [],
      groups: [],
      quotes: "",
      separator: ".",
      localName: { skip: /^$/ },
      modules: {
        plain: {
          kind: "import_statement",
          entries: "name",
          aliased: "aliased_import",
          path: "name",
          alias: "alias",
          // `import a.b.c` brings in `a`.
          binds: "first",
        },
        from: {
          kind: "import_from_statement",
          module: "module_name",
          entries: "name",
          aliased: "aliased_import",
          path: "name",
          alias: "alias",
          onDemand: "wildcard_import",
        },
        relative: ".",
        // An import under a condition or a `try` counts.
        through: [
          "if_statement",
          "elif_clause",
          "else_clause",
          "try_statement",
          "except_clause",
          "finally_clause",
          "block",
        ],
      },
    },
    call: ["call"],
    callee: {
      field: "function",
      names: ["identifier"],
      member: { kind: "attribute", operand: "object", name: "attribute", operands: ["identifier"] },
    },
    typing: {
      type: {
        names: ["identifier"],
        qualified: { kind: "attribute", qualifier: "object", name: "attribute" },
        // An annotation is a `type` node around the expression.
        wrappers: ["type"],
        generic: { kind: "generic_type", arguments: "type_parameter" },
        sequences: [],
        predeclared: (
          "int float complex str bytes bytearray bool list dict set frozenset tuple object type range slice " +
          "memoryview property Exception BaseException"
        ).split(" "),
        // A base written `Base[T]`, a keyword argument of a class (`metaclass=M`), a forward reference written as a string
        // and a union (`A | None`) are not read as types.
        unread: ["subscript", "keyword_argument", "string", "binary_operator"],
      },
      // Each file is a module, found by its path below the workspace (or below its `src` folder); `__init__` stands for its folder.
      package: { path: "file", roots: ["src"], index: "__init__" },
      // The result of `async def` is a coroutine, not the declared type.
      deferred: "async",
      flow: {
        untyped: ["assignment"],
        self: "self",
        initializer: "__init__",
        attribute: {
          kind: "assignment",
          target: "left",
          value: "right",
          type: "type",
          access: { kind: "attribute", object: "object", name: "attribute" },
        },
      },
      unboundAliases: [],
      // An annotated name in a class body is an attribute with that type.
      members: {
        container: "block",
        entries: ["assignment"],
        name: "left",
        nameKinds: ["identifier"],
        type: "type",
        callable: false,
      },
      interfaces: { embeds: [], embedKinds: [] },
      supertypes: [{ field: "superclasses", edge: "extends" }],
      implements: "nominal",
      generics: "type_parameters",
      vars: { declarations: ["assignment"], specs: ["assignment"], type: "type", value: "right" },
      unnamed: [],
      callee: {
        names: ["identifier"],
        members: [{ kind: "attribute", operand: "object", name: "attribute" }],
        operands: ["identifier"],
      },
      expressions: {
        wrappers: ["parenthesized_expression", "await"],
        names: ["identifier"],
        index: { kind: "subscript", operand: "value" },
        through: [],
        typed: [],
      },
      locals: {
        nameKinds: ["identifier"],
        nameLists: ["pattern_list", "tuple_pattern", "list_pattern"],
        parameters: [
          // `def f(x: T)`: the name is the identifier child. A parameter without a type is `untyped` below.
          { kind: "typed_parameter", name: "", type: "type", variadic: false, from: "start" },
          { kind: "typed_default_parameter", name: "name", type: "type", variadic: false, from: "start" },
        ],
        // Only an annotated assignment declares a type; without one the value types the name for the flow resolver.
        declarations: [{ kind: "assignment", names: "left", type: "type", values: "right", from: "end" }],
        inferred: [],
        valueLists: ["expression_list"],
        ranges: [],
        untyped: [
          { kind: "parameters", names: "", from: "start" },
          { kind: "lambda_parameters", names: "", from: "start" },
          { kind: "default_parameter", names: "name", from: "start" },
          { kind: "list_splat_pattern", names: "", from: "start" },
          { kind: "dictionary_splat_pattern", names: "", from: "start" },
          { kind: "for_statement", names: "left", from: "start" },
          {
            kind: "for_in_clause",
            names: "left",
            from: "start",
            scope: [
              "list_comprehension",
              "set_comprehension",
              "dictionary_comprehension",
              "generator_expression",
            ],
          },
          { kind: "as_pattern_target", names: "", from: "start" },
          { kind: "named_expression", names: "name", from: "end" },
          { kind: "function_definition", names: "name", from: "end" },
          { kind: "class_definition", names: "name", from: "end" },
        ],
      },
      lookups: ["call", "attribute", "identifier"],
    },
    // A name without a leading underscore is exported.
    exported: { by: "underscore" },
    signature: { empty: "()", maxLength: 200 },
    measure: {
      branches: [
        "if_statement",
        "elif_clause",
        "for_statement",
        "while_statement",
        "except_clause",
        "case_clause",
        "conditional_expression",
        "for_in_clause",
      ],
      binary: { kind: "boolean_operator", operator: "operator", operators: ["and", "or"] },
      statements: [
        "expression_statement",
        "return_statement",
        "if_statement",
        "for_statement",
        "while_statement",
        "try_statement",
        "with_statement",
        "match_statement",
        "raise_statement",
        "assert_statement",
        "delete_statement",
        "break_statement",
        "continue_statement",
        "pass_statement",
        "import_statement",
        "import_from_statement",
        "global_statement",
        "nonlocal_statement",
      ],
    },
  },
  workspace: {
    manifests: [
      {
        files: ["pyproject.toml"],
        format: "toml",
        quotes: "",
        comment: /#.*$/gm,
        name: [{ path: "project.name" }],
        // `core>=1.0 ; python_version > "3.9"` names `core`.
        deps: { path: "project.dependencies", entry: /^[A-Za-z0-9][A-Za-z0-9._-]*/ },
      },
      {
        files: ["pyproject.toml"],
        format: "toml",
        quotes: "",
        comment: /#.*$/gm,
        name: [{ path: "tool.poetry.name" }],
        deps: { keys: "tool.poetry.dependencies" },
      },
      {
        files: ["setup.cfg"],
        format: "ini",
        quotes: "",
        comment: /^[#;].*$/gm,
        name: [{ path: "metadata.name" }],
        deps: { path: "options.install_requires", entry: /^[A-Za-z0-9][A-Za-z0-9._-]*/ },
      },
      {
        files: ["setup.py"],
        format: "text",
        quotes: "\"'",
        comment: /#.*$/gm,
        name: [{ pattern: /\bname\s*=\s*["']([^"']+)["']/ }],
        deps: {
          within: /install_requires\s*=\s*\[([^\]]*)\]/,
          pattern: /["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g,
        },
      },
    ],
    skipDirs: ["venv", "__pycache__", "site-packages", "build", "dist", "node_modules"],
    main: /^if\s+__name__\s*==\s*["']__main__["']\s*:/m,
    // `my_lib`, `my-lib` and `My.Lib` name one distribution.
    sameName: { fold: /[-_.]+/g, as: "-", lower: true },
  },
  tokens: {
    identifiers: ["identifier"],
    local: "identifier",
    strings: ["string"],
    numbers: ["integer", "float"],
    comments: ["comment"],
    punctuation: ["(", ")", "{", "}", "[", "]", ",", ":"],
    ownName: "name",
    locals: {
      parameters: { kinds: [], field: "name" },
      bindings: [
        { kind: "parameters", field: "" },
        { kind: "lambda_parameters", field: "" },
        { kind: "typed_parameter", field: "" },
        { kind: "default_parameter", field: "name" },
        { kind: "typed_default_parameter", field: "name" },
        { kind: "list_splat_pattern", field: "" },
        { kind: "dictionary_splat_pattern", field: "" },
        { kind: "assignment", field: "left" },
        { kind: "for_statement", field: "left" },
        { kind: "for_in_clause", field: "left" },
        { kind: "as_pattern_target", field: "" },
        { kind: "named_expression", field: "name" },
      ],
      specs: { kinds: [], field: "name" },
      blank: "_",
    },
    embedding: {
      strings: ["string"],
      stringText: '"s"',
      localPrefix: "v",
    },
  },
  kindLabels: {
    function: "function",
    method: "method",
    component: "component",
    hook: "hook",
    class: "class",
    type: "type",
    interface: "interface",
    enum: "enum",
    const: "constant",
  },
  factSheetHints: [],
  thresholds: { exactMinStmts: 3, nearMinStmts: 6 },
} as const satisfies LanguagePack;

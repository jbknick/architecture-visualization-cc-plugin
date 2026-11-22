// First-draft node-kind tables for @ast-grep/napi, one per language. Written from each grammar's node-types.json
// before any sample file was parsed, and not changed afterwards. The `begin`/`end` comments delimit the lines that
// run.ts counts as "lines of table".

export interface Table {
  function: string[];
  method: string[];
  class: string[];
  interface: string[];
  module: string[];
  import: string[];
  call: string[];
  /** Object creation (`new X(...)`). */
  new: string[];
  /** Macro invocation (Rust). */
  macro: string[];
  /** A `function` kind counts as a method when its nearest enclosing scope node has one of these kinds. */
  methodIn: string[];
  /** Call nodes whose method name is one of these also count as imports (Ruby `require`). */
  importCalls: string[];
}

const none: string[] = [];

export const TABLES: Record<string, Table> = {
  // java:begin
  java: {
    function: none,
    method: ["method_declaration", "constructor_declaration", "compact_constructor_declaration"],
    class: ["class_declaration", "record_declaration", "enum_declaration"],
    interface: ["interface_declaration", "annotation_type_declaration"],
    module: none,
    import: ["import_declaration"],
    call: ["method_invocation"],
    new: ["object_creation_expression"],
    macro: none,
    methodIn: none,
    importCalls: none,
  },
  // java:end
  // python:begin
  python: {
    function: ["function_definition"],
    method: none,
    class: ["class_definition"],
    interface: none,
    module: none,
    import: ["import_statement", "import_from_statement", "future_import_statement"],
    call: ["call"],
    new: none,
    macro: none,
    methodIn: ["class_definition"],
    importCalls: none,
  },
  // python:end
  // csharp:begin
  csharp: {
    function: ["local_function_statement"],
    method: [
      "method_declaration",
      "constructor_declaration",
      "destructor_declaration",
      "operator_declaration",
      "conversion_operator_declaration",
    ],
    class: ["class_declaration", "struct_declaration", "record_declaration", "enum_declaration"],
    interface: ["interface_declaration"],
    module: ["namespace_declaration", "file_scoped_namespace_declaration"],
    import: ["using_directive"],
    call: ["invocation_expression"],
    new: ["object_creation_expression", "implicit_object_creation_expression"],
    macro: none,
    methodIn: none,
    importCalls: none,
  },
  // csharp:end
  // rust:begin
  rust: {
    function: ["function_item"],
    method: ["function_signature_item"],
    class: ["struct_item", "enum_item", "union_item"],
    interface: ["trait_item"],
    module: ["mod_item"],
    import: ["use_declaration"],
    call: ["call_expression"],
    new: none,
    macro: ["macro_invocation"],
    methodIn: ["impl_item", "trait_item"],
    importCalls: none,
  },
  // rust:end
  // ruby:begin
  ruby: {
    function: ["method", "singleton_method"],
    method: none,
    class: ["class"],
    interface: none,
    module: ["module"],
    import: none,
    call: ["call"],
    new: none,
    macro: none,
    methodIn: ["class", "module", "singleton_class"],
    importCalls: ["require", "require_relative", "load"],
  },
  // ruby:end
};

import type { SymbolKind } from "../../types.js";
import type { DupThresholds } from "../index.js";

/**
 * A language pack (spec section 3, `lang/engine/` and `lang/packs/`): everything the shared engine needs to know about a
 * language: parsing, workspaces, token streams and both levels of call resolution. A pack is a typed constant; the engine
 * holds no language name and no node kind.
 * Node kinds and field names are those of the tree-sitter grammar the pack names in `grammar`.
 */

/** Where the parts of one declaration sit: a node kind and the grammar fields that hold its pieces. */
export interface DeclarationRule {
  /** Node kind of the declaration. */
  kind: string;
  /** Field holding the declared name. */
  name: string;
  /** Field holding the parameter list. */
  parameters: string;
  /** Field holding the result type. */
  result: string;
  /** Field holding the body, when the declaration has one. */
  body?: string;
  /** Field holding the receiver; a declaration with one is a method named `<receiver type>.<name>`. */
  receiver?: string;
}

/**
 * Where the name of a workspace comes from: `pattern` (the first group of a match in the manifest, or in the first of
 * `files` that exists in the workspace's folder), `path` (the text of an element of an XML manifest, a slash-separated
 * path from the root element) or `directory` (the name of the folder; of the repo for the root).
 */
export type NameSource =
  | { pattern: RegExp; files?: readonly string[] }
  | { path: string }
  | { directory: true };

/** The dependency names a manifest lists: a directive (single and block form) with the tokens its entries have, a global `pattern` (the first group of every match), or an XML element `path`. */
export type DepsSource = { directive: string; tokens: number } | { pattern: RegExp } | { path: string };

/** One kind of manifest: the file names that have it, how it is read and what is read from it. */
export interface ManifestRule {
  /** File names (one workspace per folder that has one of them). */
  files: readonly string[];
  /** `text` is read with the patterns and directives below, `xml` with element paths. */
  format: "text" | "xml";
  /** Quote characters around a value of a text manifest. */
  quotes: string;
  /** Removed from a text manifest before it is read. */
  comment: RegExp;
  /** Sources of the workspace name, tried in order; a manifest that gives no name is skipped. */
  name: readonly NameSource[];
  deps: DepsSource;
}

/** A declaration that is a type with a body of members of its own (a class, an interface, an enum, a record). */
export interface BodiedTypeRule {
  /** Node kind of the declaration. */
  kind: string;
  /** The symbol kind the declaration makes. */
  as: "class" | "interface" | "enum" | "type";
  /** Field holding the declared name. */
  name: string;
  /** Field holding the body that holds its members. */
  body: string;
}

/**
 * The rule for `exported`: `capital` is an upper-case first letter; `modifier` is a keyword among the modifiers of the
 * declaration (`node` is the kind of the child that holds them, `implicit` the kinds of the bodies whose members are
 * exported without one); `underscore` is a name that does not start with `_`.
 */
export type ExportedRule =
  | { by: "capital" }
  | { by: "modifier"; node: string; keywords: readonly string[]; implicit: readonly string[] }
  | { by: "underscore" };

/** How the type a receiver or type expression names is found: `*S[T]` names `S`. */
export interface BaseTypeRule {
  /** Kinds of the node that holds the type's name. */
  names: readonly string[];
  /** Kinds that wrap a type and hold it as their first named child (pointer, parentheses). */
  wrappers: readonly string[];
  /** The kind of a generic instantiation and the field holding the generic type. */
  generic: { kind: string; field: string };
  /** Name used when the shape is not recognised. */
  unknown: string;
}

/**
 * Where the types of a language sit (level 2 of the call resolver, spec section 7). A pack that has this block resolves a
 * call through the declared type of its receiver; a pack without it resolves by names alone (level 1). Every entry names
 * node kinds and grammar fields: no entry is a function.
 */
export interface TypingRules {
  /** How a type expression reads. */
  type: {
    /** Kinds of a plain type name. */
    names: readonly string[];
    /** A type name qualified by an import: its kind and the fields of the qualifier and of the name. A language that has no such form leaves it out. */
    qualified?: { kind: string; qualifier: string; name: string };
    /** Kinds that wrap a type and hold it as their first named child (pointer, parentheses). */
    wrappers: readonly string[];
    /** A generic instantiation: its kind and the field holding the generic type (the first named child when there is no field). */
    generic: { kind: string; field?: string };
    /** Kinds that hold a run of values of one type, and the field holding that type. */
    sequences: readonly { kind: string; element: string }[];
    /** A map type: its kind and the fields of the key and of the value. */
    maps?: { kind: string; key: string; value: string };
    /** Names of types the language provides itself: a type of the repo only where a package declares the name. */
    predeclared: readonly string[];
    /** Kinds of type expressions that hold other types but are not read as one (a qualified name the pack has no rule for). */
    unread: readonly string[];
  };
  /**
   * The declaration that names the package of a file, how the package is identified (`directory`: the workspace name and
   * the folder below it; `clause`: the name the declaration gives, whatever the folder), and the ending of a name that
   * makes a package of its own that no import reaches.
   */
  package: { clause: string; path: "directory" | "clause"; separate?: string };
  /** Aliases of an import that bind no name. */
  unboundAliases: readonly string[];
  /** The shape of a list of result types: the list kind, and in each entry the field of the names, the kinds that are names and the field of the type. A language with one result type leaves it out. */
  results?: { list: string; name: string; nameKinds: readonly string[]; type: string };
  /**
   * The members of a class type: the node that holds them (for a type with a body, its entries are read from the body),
   * its entries, and in each entry the field of the names, the kinds that are names and the field of the type. An entry
   * without a name is an embedded (extended) type. With `declarator`, the field holds declarators and the name is the
   * `declarator` field of each. `callable` says that a member holding a function may be called by its name.
   */
  members: {
    container: string;
    entries: readonly string[];
    name: string;
    nameKinds: readonly string[];
    type: string;
    declarator?: string;
    callable: boolean;
  };
  /** The elements of an interface body that name another interface, and the kinds of such a name. Any other element makes the method set open. */
  interfaces: { embeds: readonly string[]; embedKinds: readonly string[] };
  /**
   * Supertypes written in the declaration of a type: each entry names the field (or, when the grammar has none, the kind
   * of the child) that holds them and the edge they make (`extends` for a class or interface, `implements` for an
   * interface a class declares).
   */
  supertypes: readonly { field?: string; kind?: string; edge: "extends" | "implements" }[];
  /** How a type comes to implement an interface: `structural` when its method names cover the interface's, `nominal` when it declares it. */
  implements: "structural" | "nominal";
  /**
   * A language whose code sits in type bodies: a bare name or call inside a body names a member of the enclosing type,
   * of a type it extends, or of a type around it; a local never hides a method; a name that is a type reaches its static
   * members. `self` and `parent` are the kinds of the expressions that stand for the enclosing type and for its
   * superclass.
   */
  enclosing?: { self: readonly string[]; parent: readonly string[] };
  /**
   * Overloads: methods of one name are told apart by the number of their parameters. `arguments` is the field of a call
   * site that holds the arguments, `parameters` the kinds of the entries of a parameter list and `variadic` those among
   * them that take any number of arguments.
   */
  arity?: { arguments: string; parameters: readonly string[]; variadic: readonly string[] };
  /** An expression that creates a value by calling a constructor: its kind, the field of the type and of the arguments. */
  construct?: { kind: string; type: string; arguments: string };
  /** Field of a type declaration that holds its type parameters. */
  generics: string;
  /** Package-level variables: declarations, specs, and the fields of a spec that hold its type and its values. */
  vars: { declarations: readonly string[]; specs: readonly string[]; type: string; value: string };
  /** Names of functions that are never called by name. */
  unnamed: readonly string[];
  /** What is called at a call site (the level 1 `callee` lists only the forms that need no type). */
  callee: {
    /** Kinds of a bare name. */
    names: readonly string[];
    /** A name reached through an operand: kind, and the fields of the operand and of the name. */
    members: readonly { kind: string; operand: string; name: string }[];
    /** Kinds an operand has when it is a plain name. */
    operands: readonly string[];
  };
  /** A conversion written as a call: its kind and the field of the type it names. One whose type is a generic instantiation counts as a call site. */
  conversion?: { kind: string; type: string };
  /** Functions the language provides that have a result type the call site gives: the field of the arguments, the names whose result has the type named by the first argument, and the names whose result has the type of the first argument. */
  builtins?: {
    arguments: string;
    typed: readonly string[];
    first: readonly string[];
  };
  /** How an expression reads. */
  expressions: {
    /** Kinds that wrap an expression and hold it as their first named child. */
    wrappers: readonly string[];
    /** Kinds of a plain name. */
    names: readonly string[];
    /** An element of a value that has the type of the element: its kind and the field of the value. */
    index: { kind: string; operand: string };
    /** Expressions that have the type of their operand, optionally only for some operators. */
    through: readonly {
      kind: string;
      operand: string;
      operator?: { field: string; values: readonly string[] };
    }[];
    /** Expressions that have the type they name. */
    typed: readonly { kind: string; type: string }[];
  };
  /** Where a name declared inside a function gets its type. `from` is where the name becomes visible: the `start` or the `end` of the declaration. */
  locals: {
    nameKinds: readonly string[];
    /** Parameters: the field of the names and of the type; a `variadic` one holds a sequence of its type. */
    parameters: readonly {
      kind: string;
      name: string;
      type: string;
      variadic: boolean;
      from: "start" | "end";
    }[];
    /**
     * Declarations of names with values and an optional type: the field of the names, of the type (if the declaration has
     * one; `parentType` is the field of the parent node that holds it, for a declarator that shares one type) and of the
     * values.
     */
    declarations: readonly {
      kind: string;
      names: string;
      type?: string;
      parentType?: string;
      values: string;
      from: "start" | "end";
    }[];
    /** Type names that say the type is the one of the value (`var x = ...`). */
    inferred: readonly string[];
    /** Kinds of the node that holds the several values of a declaration; any other node in the values field is one value. */
    valueLists: readonly string[];
    /** Names that take the elements of a value: the field of the names and of the value ranged over. */
    ranges: readonly { kind: string; names: string; source: string; from: "start" | "end" }[];
    /** Names whose type is not read. They still hide a name of an outer scope. */
    untyped: readonly { kind: string; names: string; from: "start" | "end" }[];
  };
  /** Kinds of the expressions a place in a file can name (`targetAt`, `typeNameAt`). */
  lookups: readonly string[];
}

export interface LanguagePack {
  id: string;
  /** Name shown to people. */
  label: string;
  /** Extensions of source files, with the dot. */
  extensions: readonly string[];
  /** Globs (on repo-relative paths, dot files included) of paths that are never indexed. */
  skipPaths: readonly string[];
  /** Globs of test files. */
  testPatterns: readonly string[];
  /** Patterns a generated file's text matches; such a file carries the `generated` directive. */
  generatedPatterns: readonly RegExp[];
  /** Globs (on repo-relative paths) of generated files; such a file carries the `generated` directive too. */
  generatedPaths: readonly string[];
  /** The tree-sitter grammar: the `@ast-grep` language package and the name it is registered under. */
  grammar: { package: string; name: string };
  nodes: {
    /** Kind of a node the parser marks as a syntax error. */
    errorKind: string;
    function: readonly DeclarationRule[];
    method: readonly DeclarationRule[];
    /** The receiver of a method: its parameter node, the field holding the type, and how the base type is found. A language whose methods sit in type bodies leaves it out. */
    receiver?: { parameter: string; type: string; baseType: BaseTypeRule };
    /** Type declarations: `class` and `interface` are kinds of the type node, any other type is `type`. */
    types: {
      declarations: readonly string[];
      specs: readonly string[];
      /** Kinds that group specs inside a declaration. */
      groups: readonly string[];
      /** Specs that are always `type` (aliases). */
      aliases: readonly string[];
      name: string;
      type: string;
      class: readonly string[];
      interface: readonly string[];
      /** Methods declared in the body of an interface type are symbols named `<interface>.<method>`. */
      interfaceMethods?: {
        container: string;
        members: readonly string[];
        rule: Omit<DeclarationRule, "kind">;
      };
      /**
       * Declarations that are types with a body of members. Their symbols are named by the chain of types around them
       * (`Outer.Inner`), and the methods in their bodies `<type>.<method>`.
       */
      bodied: readonly BodiedTypeRule[];
      /** Kinds of body nodes that hold members, or hold nodes that do (they are walked through). */
      bodies: readonly string[];
    };
    /** Constants and variables: every name is a `const` symbol. */
    values: {
      declarations: readonly string[];
      specs: readonly string[];
      groups: readonly string[];
      /** Field holding the names (it may repeat) and the kinds that are names. */
      name: string;
      nameKinds: readonly string[];
    };
    import: {
      declarations: readonly string[];
      specs: readonly string[];
      groups: readonly string[];
      /** Field holding the imported path, or the kinds of the child that holds it when the grammar has no field. */
      path?: string;
      pathKinds?: readonly string[];
      /** Field holding the optional local alias. */
      alias?: string;
      /** Quote characters around the path. */
      quotes: string;
      /** Separates the segments of an imported path. The first segments are a workspace name, the rest a folder in it. */
      separator: string;
      /** The local name of an import without an alias: the last path segment, skipping a segment that matches `skip`. */
      localName: { skip: RegExp };
      /**
       * Imports that name what they bring in: the last segment of the path is a type (or, with `static`, a member of a
       * type) and the rest its package. `onDemand` is the kind of the child that stands for every name of the path,
       * `static` the kind of the child that makes the names members. Without it every import brings in a package.
       */
      named?: { onDemand: string; static: string };
    };
    /** Kinds of a call site. */
    call: readonly string[];
    /** What is called at a call site, read by the name resolver. */
    callee: {
      /** Field of a call site that holds the called expression; null when the call site itself holds the operand and the name (a member node without an operand is a bare name). */
      field: string | null;
      /** Kinds of a bare name (`run`). */
      names: readonly string[];
      /** A name reached through an operand (`<operand>.<name>`): its kind, the fields of both parts, and the kinds an operand that is a plain name has. */
      member: { kind: string; operand: string; name: string; operands: readonly string[] };
    };
    /** Where the types sit; a pack that has it resolves calls at level 2. */
    typing?: TypingRules;
    /** Rule for `exported`. */
    exported: ExportedRule;
    signature: { empty: string; maxLength: number };
    measure: {
      /** Kinds that add one to the complexity. */
      branches: readonly string[];
      /** A binary node whose operator is one of `operators` adds one. */
      binary: { kind: string; operator: string; operators: readonly string[] };
      /** Kinds that count as one statement. */
      statements: readonly string[];
    };
  };
  workspace: {
    /** The manifests that mark a workspace. A directory with files of several rules is a workspace of the first rule. */
    manifests: readonly ManifestRule[];
    /** Directory names a manifest search never enters (dot folders are never entered). */
    skipDirs: readonly string[];
    /** A workspace is an `app` when a source file that is not a test matches `main`, a `package` otherwise. */
    main: RegExp;
    /** Manifest of the repo that lists the workspaces that belong together, and its directive; without one every workspace of the language in the repo belongs together. */
    group?: { file: string; directive: string; tokens: number };
  };
  tokens: {
    /** Kinds that are identifiers; only `local` ones are renamed. */
    identifiers: readonly string[];
    local: string;
    strings: readonly string[];
    numbers: readonly string[];
    comments: readonly string[];
    /** Anonymous tokens left out of the exact stream. */
    punctuation: readonly string[];
    /** The field holding the name a declaration introduces (its own name). */
    ownName: string;
    /** Names declared inside a declaration, found from these nodes. */
    locals: {
      parameters: { kinds: readonly string[]; field: string };
      bindings: readonly { kind: string; field: string }[];
      /** Specs whose names are local unless the spec is the declaration itself. */
      specs: { kinds: readonly string[]; field: string };
      /** A name that is never renamed. */
      blank: string;
    };
    embedding: {
      /** String kinds reduced to `stringText`. */
      strings: readonly string[];
      stringText: string;
      /** Prefix of the renamed names: `v1, v2…`. */
      localPrefix: string;
    };
  };
  kindLabels: Readonly<Record<SymbolKind, string>>;
  factSheetHints: readonly string[];
  thresholds: DupThresholds;
}

import type { SymbolKind } from "../../types.js";
import type { DupThresholds } from "../index.js";

/**
 * A language pack (spec section 3, `lang/engine/` and `lang/packs/`): everything the shared engine needs to know about a
 * language except call resolution. A pack is a typed constant; the engine holds no language name and no node kind.
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
  /** The tree-sitter grammar: the `@ast-grep` language package and the name it is registered under. */
  grammar: { package: string; name: string };
  nodes: {
    /** Kind of a node the parser marks as a syntax error. */
    errorKind: string;
    function: readonly DeclarationRule[];
    method: readonly DeclarationRule[];
    /** The receiver of a method: its parameter node, the field holding the type, and how the base type is found. */
    receiver: { parameter: string; type: string; baseType: BaseTypeRule };
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
      interfaceMethods: {
        container: string;
        members: readonly string[];
        rule: Omit<DeclarationRule, "kind">;
      };
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
      /** Fields holding the imported path and the optional local alias. */
      path: string;
      alias: string;
      /** Quote characters around the path. */
      quotes: string;
      /** The local name of an import without an alias: the last path segment, skipping a segment that matches `skip`. */
      localName: { separator: string; skip: RegExp };
    };
    /** Kinds of a call site. */
    call: readonly string[];
    /** Rule for `exported`: `capitalized` is an upper-case first letter. */
    exported: "capitalized";
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
    /** File name of the manifest that marks a workspace (one per directory). */
    manifest: string;
    /** Quote characters around a manifest value. */
    quotes: string;
    /** Removed from a manifest before it is read. */
    comment: RegExp;
    /** The workspace name: the first group of this pattern. */
    name: RegExp;
    /** Directory names a manifest search never enters (dot folders are never entered). */
    skipDirs: readonly string[];
    /** Directive of the manifest that lists dependencies (single and block form), and the tokens its entries have. */
    deps: { directive: string; tokens: number };
    /** A workspace is an `app` when a source file that is not a test matches `main`, a `package` otherwise. */
    main: RegExp;
    /** Manifest of the repo that lists the workspaces that belong together, and its directive. */
    group: { file: string; directive: string; tokens: number };
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

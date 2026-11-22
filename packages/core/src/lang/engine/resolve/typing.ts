/**
 * What the level 2 resolver keeps of a file once its tree is gone (spec section 7): plain data, no syntax node. A type
 * written in the source is a `TypeRef`, an expression an `Expr`, and both are read against the imports and the package
 * of the file they were written in.
 */

/** A type as written; null (where a type is optional) is a type the resolver does not read. */
export type TypeRef =
  | { k: "name"; name: string }
  | { k: "qual"; qualifier: string; name: string }
  | { k: "seq"; elem: TypeRef | null }
  | { k: "map"; key: TypeRef | null; elem: TypeRef | null };

/** The thing a call site calls. `line` is the 1-based line used as evidence. */
export type Callee =
  | { k: "name"; name: string; pos: number; line: number }
  | { k: "member"; operand: Expr | null; name: string; line: number }
  | { k: "none"; line: number };

export interface CallExpr {
  callee: Callee;
  /** True when the callee is a bare name at a call site, so it may be a function the language provides. */
  builtin: boolean;
  /** The first argument of such a call, read as a type and as an expression. */
  first: { type: TypeRef | null; expr: Expr | null } | null;
}

/** An expression, as far as its type is read. `pos` is the source offset of a name. */
export type Expr =
  | { k: "name"; name: string; pos: number }
  | { k: "through"; of: Expr | null }
  | { k: "typed"; type: TypeRef | null }
  | { k: "elem"; of: Expr | null }
  | { k: "member"; of: Expr | null; name: string }
  | { k: "call"; call: CallExpr };

/** Where a declared name gets its type. */
export type DeclSource =
  | { k: "type"; type: TypeRef | null; variadic: boolean }
  | {
      k: "values";
      typed: boolean;
      type: TypeRef | null;
      index: number;
      values: (Expr | null)[];
      count: number;
    }
  | { k: "range"; of: Expr | null; index: number }
  | { k: "opaque" };

/** A name declared in a function: visible from `pos` on. */
export interface Decl {
  name: string;
  pos: number;
  source: DeclSource;
}

/** A call site of a function body. */
export interface CallSite {
  call: CallExpr;
  line: number;
}

/** A function or method declaration with what its body holds. `start` is the offset of the declaration. */
export interface FunctionBody {
  start: number;
  decls: Decl[];
  calls: CallSite[];
}

/** Result types of a function or method, one per returned value. */
export type Results = (TypeRef | null)[];

export interface TypeDecl {
  name: string;
  kind: "class" | "interface" | "alias" | "other";
  /** 1-based line of the declaration. */
  line: number;
  generic: boolean;
  fields: Map<string, TypeRef | null>;
  /** Embedded (extended) types of a class, with the line each is written on. */
  embedded: { type: TypeRef | null; line: number }[];
  /** Methods declared in the body of an interface. */
  methods: Map<string, Results>;
  /** Interfaces an interface embeds. */
  embeds: (TypeRef | null)[];
  /** True when the interface body has an element that is not a plain name. */
  open: boolean;
  /** The type written after the name. */
  target: TypeRef | null;
}

export interface VarDecl {
  name: string;
  /** The declared type; null when the declaration has none. A declared type that is not read is `{ type: null }`. */
  declared: { type: TypeRef | null } | null;
  value: Expr | null;
}

/** The declarations of a file. */
export interface FileDecls {
  packageName: string;
  imports: { alias: string | null; specifier: string }[];
  funcs: { name: string; results: Results }[];
  methods: { key: string; results: Results }[];
  types: TypeDecl[];
  vars: VarDecl[];
}

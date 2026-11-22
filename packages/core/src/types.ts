import type { PACKS } from "./lang/packs/index.js";

export type Layer = "main" | "working";
/** The language of a file or symbol (spec section 7): TypeScript (which includes TSX) or the id of a registered language pack. */
export type Lang = "typescript" | (typeof PACKS)[number]["id"];
export type SymbolKind =
  | "function"
  | "method"
  | "component"
  | "hook"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const";
export interface SymbolRecord {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  /** Language of the file the symbol is in. */
  lang: Lang;
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  stmtCount: number;
  exactHash: string;
  /** Hash of the exact token stream with the symbol's own name as `$0` (spec section 17, #151); absent on rows from before schema v6. */
  renamedHash?: string;
  shapeHash: string;
  minhash: Uint32Array; // 64 permutations
  /** MinHash (64) of the near tier's literal-aware token stream (spec section 17); empty on rows from before schema v5. */
  nearMinhash?: Uint32Array;
}
export type EdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "renders"
  | "uses_hook"
  | "extends"
  | "implements"
  | "references_type"
  | "depends_on"
  | "serves"
  | "handles"
  | "requests"
  | "reads"
  | "writes"
  | "similar_to";
export interface EdgeRecord {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: "high" | "low";
  count: number;
  evidence: string[];
  fileId: string;
}
/**
 * A node contributed by a framework adapter (routes, endpoints, middleware; tables and procedures later), stored in
 * `adapter_nodes` (spec section 9). `id` follows spec section 6 (`route:<ws>:<path>`, `ep:...`, `mw:...`), `ws` is the workspace id,
 * `fileId` the file the node was found in (it picks the layer in the effective view) and `data` is adapter-specific JSON.
 */
export interface AdapterNodeRecord {
  id: string;
  kind: string;
  ws: string | null;
  label: string;
  fileId: string;
  data: Record<string, unknown>;
}
export interface FactSheet {
  contentKey: string;
  id: string;
  path: string;
  kind: SymbolKind;
  /** Display name of the symbol's language (`LanguageModule.label`: `TypeScript`, `Go`). */
  language: string;
  signature: string;
  doc: string | null;
  callees: string[];
  returnType: string | null;
  /** Host-written, never taken from the code: set only for a Go function named `init` (#372). */
  runsWhen?: string;
  body: string;
} // body trimmed to 1,500 chars
export interface Description {
  behavior: string;
  searchTerms: string[];
  nameFits: boolean;
  suggestedName?: string;
}

export type WorkspaceKind = "app" | "package" | "unknown";
export interface WorkspaceRecord {
  id: string;
  name: string;
  dir: string;
  kind: WorkspaceKind;
  frameworks: string[];
  deps: string[];
  exportsMap: ExportsEntry[] | null;
  main?: string;
  types?: string;
  /** Language module that found the workspace; set while indexing, not stored (absent means TypeScript). */
  lang?: Lang;
}
/** Flattened package.json `exports` entry ("import"/"types"/"default" conditions, first match). */
export interface ExportsEntry {
  subpath: string;
  target: string;
}
export interface FileRecord {
  id: string;
  path: string;
  /** Language of the file. */
  lang: Lang;
  workspaceId: string | null;
  contentHash: string;
  mtimeMs: number;
  deleted: boolean;
  /** Leading directive prologue strings (`"use client"`). Absent or empty means none; rows indexed before migration v3 have none until re-indexed. */
  directives?: string[];
}
/** One row of `fts_symbols` (the symbol id is the key passed to `fts.upsert`). */
export interface FtsRow {
  nameTokens: string;
  suggestedName: string;
  path: string;
  behavior: string;
  searchTerms: string;
}

/** A symbol as produced by the parser: everything except the language and the hashing fields (the indexer fills those in). */
export type ParsedSymbol = Omit<
  SymbolRecord,
  "lang" | "exactHash" | "renamedHash" | "shapeHash" | "minhash" | "nearMinhash"
>;

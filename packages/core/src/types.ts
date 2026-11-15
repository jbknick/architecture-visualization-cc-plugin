export type Layer = "main" | "working";
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
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  stmtCount: number;
  exactHash: string;
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
 * A node contributed by a framework adapter (TanStack Router routes now; endpoints and tables in M6), stored in
 * `adapter_nodes` (spec section 9). `id` follows spec section 6 (`route:<ws>:<path>`), `ws` is the workspace id,
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
  signature: string;
  doc: string | null;
  callees: string[];
  returnType: string | null;
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
}
/** Flattened package.json `exports` entry ("import"/"types"/"default" conditions, first match). */
export interface ExportsEntry {
  subpath: string;
  target: string;
}
export interface FileRecord {
  id: string;
  path: string;
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

/** A symbol as produced by the parser: everything except the hashing fields (issue #14 fills those in). */
export type ParsedSymbol = Omit<SymbolRecord, "exactHash" | "shapeHash" | "minhash" | "nearMinhash">;

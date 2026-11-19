import type { ParsedFile } from "../parse/index.js";
import type { createResolver } from "../resolve/index.js";
import type { Lang, SymbolKind } from "../types.js";
import type { detectWorkspaces } from "../workspace/index.js";
import { typescript } from "./typescript/index.js";

/** The languages the index knows are defined in `types.ts`; every file and symbol record carries one. */
export type { Lang };

/**
 * What a language module hands to shared code for one symbol (spec section 3, `lang/`). Shared code computes the
 * five hashes from it (`hash/`); no shared, language-blind normaliser exists because it changes every TypeScript hash.
 * The statement count of a symbol (`stmtCount`) comes with the parsed symbol, not from the streams.
 */
export interface TokenStreams {
  /** Exact stream: node kinds, operators and literal values; locals renamed `$1, $2…` in order of first appearance. */
  exact: string[];
  /** Shape stream: node kinds only, identifiers, strings, numbers and templates reduced to placeholders. */
  shape: string[];
  /** Positions in `exact` of references to the symbol's own name; the near tier reads them as `$0`. */
  selfRefs: number[];
}

/**
 * Duplicate-tier thresholds that belong to the language (spec section 17): the statement counts come from its parser.
 * The similarity thresholds are configuration (`duplicates.thresholds`) and are looked up per language by
 * `thresholdsFor` in `dup/`; every language starts with the TypeScript values.
 */
export interface DupThresholds {
  /** Minimum `stmtCount` of a function for the exact tier. */
  exactMinStmts: number;
  /** Minimum `stmtCount` of a function for the near tier. */
  nearMinStmts: number;
}

/**
 * The part of the pipeline that depends on the language (V2 plan, M12 "Language interface"). A language supplies
 * file rules, workspace discovery, parsing, import resolution with call and type edges, the token streams per
 * symbol, the text for code embeddings, hints for fact sheets and display labels for symbol kinds.
 */
export interface LanguageModule {
  id: Lang;
  /** Name shown to people (`TypeScript`). */
  label: string;
  /** File rules: the extensions of source files of this language, with the dot. */
  extensions: readonly string[];
  /** Workspace discovery from manifests. */
  detectWorkspaces: typeof detectWorkspaces;
  /** Parsing to symbols, imports and exports. */
  parseSource: (repo: string, repoRelPath: string, source: string) => ParsedFile;
  /** Import resolution, the adapter resolver, and call and type edges with confidence. */
  createResolver: typeof createResolver;
  /** Token streams of the code in `range` of the file at `path`. */
  streams: (source: string, range: { start: number; end: number }, path: string) => TokenStreams;
  /** The text a code embedding is computed from. */
  embeddingText: (source: string, range: { start: number; end: number }, path: string) => string;
  /** Hints added to the description prompt's fact sheet; empty when the language needs none. */
  factSheetHints: readonly string[];
  /** Display label of each symbol kind. */
  kindLabels: Readonly<Record<SymbolKind, string>>;
  /** Duplicate thresholds. */
  thresholds: DupThresholds;
}

const MODULES: readonly LanguageModule[] = [typescript];

/** Every language module, in a fixed order. */
export const languages = (): readonly LanguageModule[] => MODULES;

/** The language of a source file path, or undefined when no module claims its extension. */
export function languageOfPath(repoRelPath: string): LanguageModule | undefined {
  const dot = repoRelPath.lastIndexOf(".");
  const ext = dot < 0 ? "" : repoRelPath.slice(dot);
  return MODULES.find((m) => m.extensions.includes(ext));
}

/** The module for a language id. */
export function languageModule(id: Lang): LanguageModule {
  const m = MODULES.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown language: ${id}`);
  return m;
}

/** The ids of all languages (a language can be named before its module exists), for validating `--lang` and the MCP `lang` input. */
export const LANG_IDS: readonly Lang[] = ["typescript", "go"];

/** True when `v` is a language id. */
export const isLang = (v: unknown): v is Lang =>
  typeof v === "string" && (LANG_IDS as readonly string[]).includes(v);

/** Language of a workspace-less file path; files of an unknown extension count as the first language. */
export const langOfPath = (repoRelPath: string): Lang => languageOfPath(repoRelPath)?.id ?? "typescript";

/** Display name of a language; the id itself when no module exists for it yet. */
export const langLabel = (id: Lang): string => MODULES.find((m) => m.id === id)?.label ?? id;

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathOfFileId } from "../ids.js";
import type { ParsedFile } from "../parse/index.js";
import type { ResolveContext, Resolver } from "../resolve/index.js";
import type { Lang, SymbolKind, WorkspaceRecord } from "../types.js";
import type { detectWorkspaces, WorkspaceDetectionConfig } from "../workspace/index.js";
import { buildLanguage } from "./engine/module.js";
import { PACKS } from "./packs/index.js";
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
  /** File rules: true for a path of this language that is never indexed (Go: `vendor/`, `testdata/`, dot folders). */
  skipPath?: (repoRelPath: string) => boolean;
  /** Workspace discovery from manifests. */
  detectWorkspaces: typeof detectWorkspaces;
  /** File names of the manifests that mark a workspace of this language. */
  manifestFiles: readonly string[];
  /** Names of symbols that are never offered as duplicates of one another (many per package, never reused). */
  unreusable: readonly string[];
  /** Parsing to symbols, imports and exports. */
  parseSource: (repo: string, repoRelPath: string, source: string) => ParsedFile;
  /** Import resolution, the adapter resolver, and call and type edges with confidence. */
  createResolver: (ctx: ResolveContext) => Resolver;
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

/** TypeScript first, then one module per pack in `PACKS` order. */
const MODULES: readonly LanguageModule[] = [typescript, ...PACKS.map((p) => buildLanguage(p))];

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

/** The ids of all languages: TypeScript and every registered pack, for validating `--lang` and the MCP `lang` input. */
export const LANG_IDS: readonly Lang[] = ["typescript", ...PACKS.map((p) => p.id)];

/** True when `v` is a language id. */
export const isLang = (v: unknown): v is Lang =>
  typeof v === "string" && (LANG_IDS as readonly string[]).includes(v);

/** Language of a workspace-less file path; files of an unknown extension count as the first language. */
export const langOfPath = (repoRelPath: string): Lang => languageOfPath(repoRelPath)?.id ?? "typescript";

/** Display name of a language; the id itself when no module exists for it yet. */
export const langLabel = (id: Lang): string => MODULES.find((m) => m.id === id)?.label ?? id;

/** Parses a source file with the module that owns its extension; TypeScript for any other path. */
export function parseFile(repo: string, repoRelPath: string, source: string): ParsedFile {
  return (languageOfPath(repoRelPath) ?? typescript).parseSource(repo, repoRelPath, source);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function hasTypeScriptFiles(root: string): boolean {
  const r = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...typescript.extensions.map((e) => `*${e}`),
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return r.error || r.status !== 0 ? true : r.stdout.length > 0;
}

/**
 * Workspaces of every language module. A repository with Go modules and no TypeScript has no `ws:.` fallback
 * workspace: that record exists to hold the files of a TypeScript repo that declares no packages.
 */
export function detectAllWorkspaces(
  root: string,
  config: WorkspaceDetectionConfig,
  repo: string,
): WorkspaceRecord[] {
  const ts = typescript.detectWorkspaces(root, config, repo);
  const packWs = MODULES.filter((m) => m !== typescript).flatMap((m) =>
    m.detectWorkspaces(root, config, repo),
  );
  if (packWs.length === 0) return ts;
  const tsKept = ts.length > 1 || existsSync(join(root, "package.json")) || hasTypeScriptFiles(root);
  return [...(tsKept ? ts : []), ...packWs].sort((a, b) => cmp(a.dir, b.dir) || cmp(a.id, b.id));
}

/** One resolver over the languages: each file goes to the resolver of its own language; workspace edges are concatenated. */
export function createLangResolver(ctx: ResolveContext): Resolver {
  const per = new Map<Lang, Resolver>();
  const of = (id: Lang): Resolver => {
    let r = per.get(id);
    if (!r) {
      r = languageModule(id).createResolver(ctx);
      per.set(id, r);
    }
    return r;
  };
  const forFile = (fileId: string): Resolver => of(langOfPath(pathOfFileId(fileId)));
  return {
    resolveSpecifier: (fromFileId, specifier) => forFile(fromFileId).resolveSpecifier(fromFileId, specifier),
    resolveSymbol: (fileId, name) => forFile(fileId).resolveSymbol(fileId, name),
    targetAt: (fileId, start, end) => forFile(fileId).targetAt?.(fileId, start, end) ?? null,
    typeNameAt: (fileId, start, end) => forFile(fileId).typeNameAt?.(fileId, start, end) ?? null,
    edgesForFile: (fileId) => forFile(fileId).edgesForFile(fileId),
    workspaceEdges: () => MODULES.flatMap((m) => of(m.id).workspaceEdges()),
    stats() {
      const all = MODULES.map((m) => of(m.id).stats());
      const counts = { ...(all[0] as ReturnType<Resolver["stats"]>).counts };
      for (const s of all.slice(1))
        for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += s.counts[k];
      return { counts, unresolved: all.flatMap((s) => s.unresolved) };
    },
  };
}

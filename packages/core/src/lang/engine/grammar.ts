import { createRequire } from "node:module";
import { type DynamicLangRegistrations, parse, registerDynamicLanguage } from "@ast-grep/napi";
import type { LanguagePack } from "./pack.js";

type LangRegistration = DynamicLangRegistrations[string];

/**
 * The tree-sitter grammars behind `@ast-grep/napi` (spec section 3, `lang/engine/`). This is the only file that casts to
 * the library's untyped dynamic-language types; every other file works on `SyntaxNode`.
 *
 * The library allows one registration call per process, so every registered pack is loaded in that one call
 * (`registerPacks`, called by `lang/packs/`). A pack whose grammar package cannot be loaded or does not parse on this
 * platform is unavailable: its files are skipped (one line on stderr) and indexing of the other languages goes on.
 */

/** A syntax node, as much of the `@ast-grep/napi` node as the engine reads. Offsets are UTF-16 code units. */
export interface SyntaxNode {
  kind(): string;
  text(): string;
  isNamed(): boolean;
  range(): { start: { line: number; index: number }; end: { line: number; index: number } };
  children(): SyntaxNode[];
  namedChildren(): SyntaxNode[];
  /** The first child in the grammar field `name`, or null. */
  field(name: string): SyntaxNode | null;
  /** Every child in the grammar field `name`. */
  fieldChildren(name: string): SyntaxNode[];
  find(rule: { rule: Record<string, unknown> }): SyntaxNode | null;
  findAll(rule: { rule: Record<string, unknown> }): SyntaxNode[];
}

let known: readonly LanguagePack[] = [];
let available: Map<string, boolean> | undefined;

/** Names the packs whose grammars load, once per process. A second call is an error. */
export function registerPacks(packs: readonly LanguagePack[]): void {
  if (known.length > 0) throw new Error("language packs are already registered");
  known = packs;
}

function load(): Map<string, boolean> {
  if (available) return available;
  const require = createRequire(import.meta.url);
  const registrations: Record<string, LangRegistration> = {};
  for (const p of known) {
    try {
      registrations[p.grammar.name] = require(p.grammar.package) as LangRegistration;
    } catch {
      // not installed: the pack is unavailable
    }
  }
  const ok = new Map<string, boolean>();
  try {
    registerDynamicLanguage(registrations);
  } catch {
    available = new Map(known.map((p) => [p.grammar.name, false]));
    return available;
  }
  for (const p of known) {
    try {
      if (!(p.grammar.name in registrations)) throw new Error("not loaded");
      parse(p.grammar.name as never, "");
      ok.set(p.grammar.name, true);
    } catch {
      ok.set(p.grammar.name, false);
    }
  }
  available = ok;
  return ok;
}

/** True when the grammar `pack` names loaded on this platform (a pack that shares a registered grammar shares its answer). */
export const grammarAvailable = (pack: LanguagePack): boolean => load().get(pack.grammar.name) === true;

const warned = new Set<string>();

/** Prints the one skip line (once per process) when the files of `pack` cannot be parsed on this platform. */
export function warnSkipped(pack: LanguagePack): void {
  if (warned.has(pack.id) || grammarAvailable(pack)) return;
  warned.add(pack.id);
  process.stderr.write(
    `${pack.id}: no tree-sitter ${pack.label} prebuild for ${process.platform}-${process.arch}; ${pack.label} files skipped\n`,
  );
}

/** Parses source to its root node. Throws when the grammar did not load (callers check `grammarAvailable`). */
export function parseTree(pack: LanguagePack, source: string): SyntaxNode {
  if (!grammarAvailable(pack)) throw new Error(`${pack.id}: tree-sitter ${pack.label} grammar not available`);
  return parse(pack.grammar.name as never, source).root() as unknown as SyntaxNode;
}

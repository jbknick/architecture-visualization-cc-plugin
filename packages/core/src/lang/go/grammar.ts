import goLang from "@ast-grep/lang-go";
import { type DynamicLangRegistrations, parse, registerDynamicLanguage } from "@ast-grep/napi";

type LangRegistration = DynamicLangRegistrations[string];

/**
 * The tree-sitter Go grammar behind `@ast-grep/napi` (spec section 3, `lang/go/`). This is the only file that
 * casts to the library's untyped dynamic-language types; every other Go file works on `GoNode`.
 *
 * The package ships prebuilt parsers for macOS arm64/x64, Linux arm64/x64 and Windows x64. On any other platform
 * loading fails with "No parser found": Go files are then skipped (one line on stderr) and TypeScript indexing goes on.
 */

/** A syntax node, as much of the `@ast-grep/napi` node as the Go module reads. Offsets are UTF-16 code units. */
export interface GoNode {
  kind(): string;
  text(): string;
  isNamed(): boolean;
  range(): { start: { line: number; index: number }; end: { line: number; index: number } };
  children(): GoNode[];
  namedChildren(): GoNode[];
  /** The first child in the grammar field `name`, or null. */
  field(name: string): GoNode | null;
  /** Every child in the grammar field `name`. */
  fieldChildren(name: string): GoNode[];
  find(rule: { rule: Record<string, unknown> }): GoNode | null;
  findAll(rule: { rule: Record<string, unknown> }): GoNode[];
}

let available: boolean | undefined;

/** Registers Go once per process (the library allows it exactly once) and proves it by parsing a snippet. */
function load(): boolean {
  if (available !== undefined) return available;
  try {
    registerDynamicLanguage({ go: goLang as unknown as LangRegistration });
    parse("go" as never, "package a\n");
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** True when the Go parser loaded on this platform. */
export const goAvailable = (): boolean => load();

let warned = false;

/** Prints the one skip line (once per process) when Go files cannot be parsed on this platform. */
export function warnGoSkipped(): void {
  if (warned || goAvailable()) return;
  warned = true;
  process.stderr.write(
    `go: no tree-sitter Go prebuild for ${process.platform}-${process.arch}; Go files skipped\n`,
  );
}

/** Parses Go source to its root node. Throws when the grammar did not load (callers check `goAvailable`). */
export function parseGo(source: string): GoNode {
  if (!load()) throw new Error("go: tree-sitter Go grammar not available");
  return parse("go" as never, source).root() as unknown as GoNode;
}

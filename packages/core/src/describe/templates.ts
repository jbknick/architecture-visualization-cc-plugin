import { parseSync } from "oxc-parser";
import { isNode, type Node, nodeArray, visit } from "../parse/ast.js";
import type { ParsedFile } from "../parse/index.js";
import { splitIdentifier } from "../store/index.js";
import type { Description, SymbolRecord } from "../types.js";
import { FUNCTION_LIKE_KINDS } from "./factsheet.js";

export const TEMPLATE_EXPR_MAX = 80;
const BEHAVIOR_WORDS_MAX = 25;
const TERMS_MAX = 6;
const TERM_CHARS_MAX = 30;

/** Search terms for a template: the identifier as one phrase, then its words, de-duplicated. */
export function termsFromName(name: string): string[] {
  const words = splitIdentifier(name);
  const out: string[] = [];
  for (const t of [words.join(" "), ...words]) {
    if (t !== "" && t.length <= TERM_CHARS_MAX && !out.includes(t)) out.push(t);
    if (out.length === TERMS_MAX) break;
  }
  if (out.length === 0)
    out.push(
      (
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim() || "function"
      ).slice(0, TERM_CHARS_MAX),
    );
  return out;
}

function clamp(expr: string): string {
  const flat = expr.replace(/\s+/g, " ").trim();
  return flat.length > TEMPLATE_EXPR_MAX ? `${flat.slice(0, TEMPLATE_EXPR_MAX - 1)}…` : flat;
}

/** `Returns <expr>.` kept within the 25-word schema limit (spec section 8). */
function returnsSentence(expr: string): string {
  const words = clamp(expr).split(" ");
  while (words.length > BEHAVIOR_WORDS_MAX - 1) words.pop();
  const text = words.join(" ").replace(/[.\s]+$/, "");
  return `Returns ${text}.`;
}

function isFunctionNode(n: Node): boolean {
  return (
    n.type === "ArrowFunctionExpression" ||
    n.type === "FunctionExpression" ||
    n.type === "FunctionDeclaration"
  );
}

/**
 * The returned expression of a function that consists of exactly one `return <expr>` (or an arrow with an
 * expression body), as source text. Null for anything else, including unparseable slices.
 */
export function singleReturnExpression(declSource: string, isMember: boolean, tsx: boolean): string | null {
  const prefix = isMember ? "class __G { " : "";
  const text = `${prefix}${declSource}${isMember ? "\n}" : ""}`;
  let program: Node[];
  try {
    const r = parseSync(tsx ? "t.tsx" : "t.ts", text, {
      sourceType: "module",
      lang: tsx ? "tsx" : "ts",
      preserveParens: false,
    });
    if (r.errors.length > 0) return null;
    program = nodeArray((r.program as unknown as { body?: unknown }).body);
  } catch {
    return null;
  }
  let fn: Node | null = null;
  visit(program, (n) => {
    if (fn) return false;
    if (isFunctionNode(n)) {
      fn = n;
      return false;
    }
    return undefined;
  });
  const found = fn as Node | null;
  if (!found) return null;
  const body = found.body;
  if (!isNode(body)) return null;
  let expr: Node | null = null;
  if (body.type !== "BlockStatement") expr = body;
  else {
    const stmts = nodeArray(body.body);
    const only = stmts[0];
    if (stmts.length === 1 && only?.type === "ReturnStatement" && isNode(only.argument)) expr = only.argument;
  }
  return expr ? text.slice(expr.start, expr.end) : null;
}

/**
 * Deterministic description for a function-like symbol that needs no model (spec section 8):
 * a function whose whole body is `return <expr>`. Provenance `template` is set by the caller.
 * Returns null when no template applies.
 */
export function templateFor(sym: SymbolRecord, parsed: ParsedFile, source: string): Description | null {
  if (!FUNCTION_LIKE_KINDS.includes(sym.kind)) return null;
  if (sym.stmtCount !== 1) return null;
  const range = parsed.bodies.get(sym.id);
  if (!range) return null;
  const tsx = parsed.fileId.endsWith(".tsx");
  const expr = singleReturnExpression(source.slice(range.start, range.end), sym.kind === "method", tsx);
  if (expr === null || expr.trim() === "") return null;
  return {
    behavior: returnsSentence(expr),
    searchTerms: termsFromName(sym.name),
    nameFits: true,
  };
}

/**
 * Description of a re-export line (`export { a } from "./x"`, `export * as ns from "./y"`) or of the
 * names a barrel file forwards. Null when `exportedName` is not a re-export in this file.
 */
export function reexportTemplate(parsed: ParsedFile, exportedName: string): Description | null {
  const e = parsed.exports.find((x) => x.exported === exportedName && x.fromSpecifier !== undefined);
  if (!e || e.fromSpecifier === undefined) return null;
  const spec = e.fromSpecifier.length > 60 ? `${e.fromSpecifier.slice(0, 59)}…` : e.fromSpecifier;
  const behavior =
    e.local === "*"
      ? `Re-exports the whole module ${spec} as a namespace.`
      : `Re-exports ${e.local ?? e.exported} from ${spec}.`;
  return { behavior, searchTerms: termsFromName(exportedName), nameFits: true };
}

/** A barrel file holds only imports and re-exports, so none of its names need a model description. */
export function isBarrelFile(parsed: ParsedFile): boolean {
  return (
    parsed.symbols.length === 0 &&
    parsed.exports.length > 0 &&
    parsed.exports.every((e) => e.fromSpecifier !== undefined)
  );
}

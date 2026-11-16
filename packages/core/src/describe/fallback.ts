// Deterministic fallback description (spec section 8, #150, final form in #175). When a function used its whole
// bounded retry budget on clean wording mistakes (`shape` or `identifier`), the host writes a plain description from
// trusted index data instead of leaving the function undescribed: its kind, its parameter count (from the parsed
// signature) and how many indexed functions it calls. It repeats no name at all, neither the function's nor a
// callee's (the tools and the UI show the symbol's name anyway), so no identifier text can reach it. No model is
// involved, the sentence says so, and the row is stored with provenance `fallback` and no model; consumers read the
// provenance from `described_by`, never from the text.
import { parseSync } from "oxc-parser";
import { isNode, nodeArray } from "../parse/ast.js";
import type { Description, FactSheet, SymbolRecord } from "../types.js";
import { FUNCTION_LIKE_KINDS } from "./factsheet.js";
import { validateDescription } from "./validate.js";

/**
 * The marker every fallback sentence carries before its full stop. The validator rejects it in model text, so the
 * sentence is validated without it and the host adds it afterwards.
 */
export const FALLBACK_MARK = "(generated without a model)";
/** Signatures longer than this are not parsed (the parameter clause is left out). */
const SIGNATURE_PARSE_MAX = 2000;

/** The number of declared parameters in a stored signature such as `<T>(a: T, b = 1): R`, or null if it does not parse. */
export function parameterCount(signature: string): number | null {
  if (signature === "" || signature.length > SIGNATURE_PARSE_MAX || !/^[<(]/.test(signature)) return null;
  try {
    const r = parseSync("sig.ts", `function f${signature} {}`, { sourceType: "module", lang: "ts" });
    if (r.errors.length > 0) return null;
    const body = nodeArray((r.program as unknown as { body?: unknown }).body);
    const fn = body[0];
    if (body.length !== 1 || !isNode(fn) || fn.type !== "FunctionDeclaration") return null;
    return nodeArray(fn.params).length;
  } catch {
    return null;
  }
}

const count = (n: number, one: string, many: string): string =>
  n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;

/**
 * The fallback sentence without the marker: `Defines a <kind> that takes <n> parameters and calls <m> other
 * functions.`, singular forms for 1, `no` for 0, the parameter clause left out when the signature does not parse.
 */
export function fallbackSentence(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): string {
  const params = parameterCount(sym.signature);
  const callees = new Set(sheet.callees.filter((c) => c !== sym.name)).size;
  const calls = `calls ${count(callees, "other function", "other functions")}`;
  const takes = params === null ? null : `takes ${count(params, "parameter", "parameters")}`;
  return `Defines a ${sym.kind} that ${takes === null ? calls : `${takes} and ${calls}`}.`;
}

/** `sentence.` -> `sentence (generated without a model).` */
export function withMark(sentence: string): string {
  return `${sentence.replace(/\.$/, "")} ${FALLBACK_MARK}.`;
}

/**
 * The fallback description for a function-like symbol, or null when it is not function-like or the sentence does not
 * pass `validateDescription` against `sheet` (checked without the marker, which is added afterwards). The only search
 * term is the kind. Deterministic: the same symbol and sheet always give the same result.
 */
export function fallbackDescription(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): Description | null {
  if (!FUNCTION_LIKE_KINDS.includes(sym.kind)) return null;
  const v = validateDescription(
    { behavior: fallbackSentence(sym, sheet), searchTerms: [sym.kind], nameFits: true },
    sheet,
    {
      repairLength: false,
    },
  );
  if (!v.ok) return null;
  return { ...v.value, behavior: withMark(v.value.behavior) };
}

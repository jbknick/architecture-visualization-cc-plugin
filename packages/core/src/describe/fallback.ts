// Deterministic fallback description (spec section 8, #150). When a function used its whole bounded retry budget on
// wording rules (`shape` or `identifier`), the host writes a plain description from trusted index data instead of
// leaving the function undescribed: its kind, its name, its parameter count (from the parsed signature) and the
// indexed functions it calls. No model is involved, the sentence says so, and the row is stored with provenance
// `fallback` and no model. The candidate still goes through `validateDescription` against the same fact sheet, so a
// fallback can never carry anything the validator would reject from a model (a name that spells an instruction, a
// credential, ...): if no candidate passes, there is no fallback and the function stays `failed`.
import { parseSync } from "oxc-parser";
import { isNode, nodeArray } from "../parse/ast.js";
import { splitIdentifier } from "../store/index.js";
import type { Description, FactSheet, SymbolRecord } from "../types.js";
import { FUNCTION_LIKE_KINDS } from "./factsheet.js";
import { termsFromName } from "./templates.js";
import { validateDescription } from "./validate.js";

/** The marker every fallback sentence ends with, inside the sentence so the shape rules still hold. */
export const FALLBACK_MARK = "(generated without a model)";
/** At most this many callees are named, in the fact sheet's (sorted) order. */
const FALLBACK_CALLEES_MAX = 3;
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

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function takes(n: number | null): string {
  if (n === null) return "";
  if (n === 0) return "takes no parameters";
  return `takes ${n} ${n === 1 ? "parameter" : "parameters"}`;
}

export interface FallbackCandidate {
  behavior: string;
  /** The identifiers the sentence names (the function, its callees). */
  names: string[];
}

/** The candidate sentences, most informative first. */
export function fallbackCandidates(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): FallbackCandidate[] {
  const kind = sym.kind;
  const params = takes(parameterCount(sym.signature));
  const callees = sheet.callees.filter((c) => c !== sym.name).slice(0, FALLBACK_CALLEES_MAX);
  const calls = callees.length > 0 ? `calls ${listOf(callees)}` : "";
  const what = [params, calls].filter(Boolean).join(" and ");
  const out: FallbackCandidate[] = [];
  const add = (behavior: string, names: string[]) => {
    if (!out.some((c) => c.behavior === behavior)) out.push({ behavior, names });
  };
  if (what !== "")
    add(`Defines the ${kind} ${sym.name}, which ${what} ${FALLBACK_MARK}.`, [
      sym.name,
      ...(calls ? callees : []),
    ]);
  if (params !== "") add(`Defines the ${kind} ${sym.name}, which ${params} ${FALLBACK_MARK}.`, [sym.name]);
  add(`Defines the ${kind} ${sym.name} ${FALLBACK_MARK}.`, [sym.name]);
  if (params !== "") add(`Defines a ${kind} that ${params} ${FALLBACK_MARK}.`, []);
  add(`Defines a ${kind} ${FALLBACK_MARK}.`, []);
  return out;
}

/** An identifier as its lower-case words (`ignoreAllRules` -> `ignore all rules`). */
const spell = (name: string): string => splitIdentifier(name).join(" ");

/** `behavior` with every named identifier spelled out as words. */
function spelledOut(c: FallbackCandidate): string {
  let text = c.behavior;
  for (const n of [...c.names].sort((a, b) => b.length - a.length)) {
    const words = spell(n);
    if (words !== "") text = text.split(n).join(words);
  }
  return text;
}

/**
 * The fallback description for a function-like symbol, or null when it is not function-like or no candidate passes.
 * A candidate must pass `validateDescription` against `sheet` as written and, when it names identifiers, once more
 * with each of them spelled out as words in the sentence and as its own search term (search terms get the stricter
 * imperative rules), so a name that spells an instruction (`ignorePreviousInstructions`, `deleteAllTests`) is never
 * repeated. A candidate that names the function searches by the name's words; the nameless ones by the kind.
 * Deterministic: the same symbol and sheet always give the same result.
 */
export function fallbackDescription(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): Description | null {
  if (!FUNCTION_LIKE_KINDS.includes(sym.kind)) return null;
  const check = (behavior: string, searchTerms: string[]) =>
    validateDescription({ behavior, searchTerms, nameFits: true }, sheet, { repairLength: false });
  for (const c of fallbackCandidates(sym, sheet)) {
    const v = check(c.behavior, c.names.length > 0 ? termsFromName(sym.name) : [sym.kind]);
    if (!v.ok) continue;
    if (c.names.length > 0) {
      const spelledTerms = c.names.map((n) => spell(n).split(" ").slice(0, 4).join(" ")).filter(Boolean);
      if (!check(spelledOut(c), spelledTerms.length > 0 ? spelledTerms : [sym.kind]).ok) continue;
    }
    return v.value;
  }
  return null;
}

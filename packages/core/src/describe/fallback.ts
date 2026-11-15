// Deterministic fallback description (spec section 8, #150, hardened in #175). When a function used its whole bounded
// retry budget on wording rules (`shape` or `identifier`), the host writes a plain description from trusted index data
// instead of leaving the function undescribed: its kind, its name, its parameter count (from the parsed signature) and
// the indexed functions it calls. No model is involved, the sentence says so, and the row is stored with provenance
// `fallback` and no model. Every name it repeats must pass `usableName`, and the sentence must pass
// `validateDescription` against the same fact sheet as written and with every name spelled out; if no candidate
// passes, there is no fallback and the function stays `failed`.
import { parseSync } from "oxc-parser";
import { isNode, nodeArray } from "../parse/ast.js";
import { splitIdentifier } from "../store/index.js";
import type { Description, FactSheet, SymbolRecord } from "../types.js";
import { FUNCTION_LIKE_KINDS } from "./factsheet.js";
import { MAX_BEHAVIOR_CHARS, MAX_BEHAVIOR_WORDS } from "./schema.js";
import { termsFromName } from "./templates.js";
import { wordCount } from "./text.js";
import { instructionSignal, validateDescription } from "./validate.js";
import { isStopWord, isWord } from "./wordlist.js";

/**
 * The marker every fallback sentence carries before its full stop. The validator rejects it in model text (#175), so
 * the candidate is validated without it and the host adds it afterwards.
 */
export const FALLBACK_MARK = "(generated without a model)";
/** At most this many callees are named, in the fact sheet's (sorted) order. */
const FALLBACK_CALLEES_MAX = 3;
/** Signatures longer than this are not parsed (the parameter clause is left out). */
const SIGNATURE_PARSE_MAX = 2000;
/** A word of a repeated name longer than this is a run-together phrase, not a word. */
const NAME_WORD_MAX = 15;
/** A word of a repeated name longer than this must be a dictionary word. */
const NAME_WORD_FREE = 12;
/** Words a repeated name may not hold: agent and prompt vocabulary, addressing and review words. */
const NAME_BANNED: ReadonlySet<string> = new Set(
  `prompt prompts instruction instructions instruct system role roles override overrides ignore ignores disregard
  forget bypass jailbreak approve approved approves approval merge merged merges lgtm previous prior assistant
  assistants agent agents ai llm llms claude gpt copilot chatgpt reviewer reviewers review you your yours we our us
  must should shall ought please todo fixme remember`
    .split(/\s+/)
    .filter(Boolean),
);

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

/** An identifier as its lower-case words, after NFKC folding (`ignoreAllRules` -> `ignore all rules`). */
export function spell(name: string): string {
  return splitIdentifier(name.normalize("NFKC")).join(" ");
}

/**
 * Whether the fallback may repeat `name` (#175): a plain ASCII identifier (no full-width or other look-alike forms,
 * which NFKC would fold into a different stored text), whose spelled words cover every letter and digit, none of them
 * a run-together phrase (longer than 15 characters, or longer than 12 and not a dictionary word) or an agent, prompt,
 * addressing or review word, and whose spelling raises no `instructionSignal` as a search term and suggested name.
 */
export function usableName(name: string, sheet: FactSheet): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(name)) return false;
  const words = splitIdentifier(name.normalize("NFKC"));
  if (words.length === 0) return false;
  if (words.join("") !== name.toLowerCase().replace(/[^a-z0-9]/g, "")) return false;
  for (const w of words) {
    if (w.length > NAME_WORD_MAX || (w.length > NAME_WORD_FREE && !isWord(w))) return false;
    if (NAME_BANNED.has(w)) return false;
  }
  return !instructionSignal({ searchTerms: [words.join(" ")], suggestedName: name }, sheet);
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
  /** The sentence without the marker. */
  behavior: string;
  /** The identifiers the sentence names (the function, its callees). */
  names: string[];
}

/** The candidate sentences (without the marker), most informative first. Only `usableName` names are repeated. */
export function fallbackCandidates(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): FallbackCandidate[] {
  const kind = sym.kind;
  const params = takes(parameterCount(sym.signature));
  const named = usableName(sym.name, sheet);
  const callees = sheet.callees
    .filter((c) => c !== sym.name && usableName(c, sheet))
    .slice(0, FALLBACK_CALLEES_MAX);
  const calls = callees.length > 0 ? `calls ${listOf(callees)}` : "";
  const what = [params, calls].filter(Boolean).join(" and ");
  const out: FallbackCandidate[] = [];
  const add = (behavior: string, names: string[]) => {
    if (!out.some((c) => c.behavior === behavior)) out.push({ behavior, names });
  };
  if (named) {
    if (what !== "")
      add(`Defines the ${kind} ${sym.name}, which ${what}.`, [sym.name, ...(calls ? callees : [])]);
    if (params !== "") add(`Defines the ${kind} ${sym.name}, which ${params}.`, [sym.name]);
    add(`Defines the ${kind} ${sym.name}.`, [sym.name]);
  }
  if (params !== "") add(`Defines a ${kind} that ${params}.`, []);
  add(`Defines a ${kind}.`, []);
  return out;
}

/** `behavior` with every named identifier spelled out as words. */
export function spelledOut(c: FallbackCandidate): string {
  let text = c.behavior;
  for (const n of [...c.names].sort((a, b) => b.length - a.length)) {
    const words = spell(n);
    if (words !== "") text = text.split(n).join(words);
  }
  return text;
}

/** `sentence.` -> `sentence (generated without a model).` */
export function withMark(sentence: string): string {
  return `${sentence.replace(/\.$/, "")} ${FALLBACK_MARK}.`;
}

/**
 * The fallback description for a function-like symbol, or null when it is not function-like or no candidate passes.
 * A candidate must pass `validateDescription` against `sheet` as written and, when it names identifiers, once more
 * with each of them spelled out as words in the sentence and as its own search term, so the sentence's clause rules
 * see the words a camelCase name hides (each name already passed `usableName`, which runs the term and name rules
 * on it); the marker is added after that and the result must still fit the length limits. A candidate that names the
 * function searches by the name's words (terms of function words only left out); the nameless ones by the kind.
 * Deterministic: the same symbol and sheet always give the same result.
 */
export function fallbackDescription(
  sym: Pick<SymbolRecord, "name" | "kind" | "signature">,
  sheet: FactSheet,
): Description | null {
  if (!FUNCTION_LIKE_KINDS.includes(sym.kind)) return null;
  const check = (behavior: string, searchTerms: string[]) =>
    validateDescription({ behavior, searchTerms, nameFits: true }, sheet, { repairLength: false });
  const named = termsFromName(sym.name).filter((t) => !t.split(" ").every((w) => isStopWord(w)));
  for (const c of fallbackCandidates(sym, sheet)) {
    const v = check(c.behavior, c.names.length > 0 && named.length > 0 ? named : [sym.kind]);
    if (!v.ok) continue;
    if (c.names.length > 0) {
      const spelled = spelledOut(c);
      const spelledTerms = c.names.map((n) => spell(n).split(" ").slice(0, 4).join(" ")).filter(Boolean);
      if (!check(spelled, spelledTerms.length > 0 ? spelledTerms : [sym.kind]).ok) continue;
    }
    const behavior = withMark(v.value.behavior);
    if (wordCount(behavior) > MAX_BEHAVIOR_WORDS || behavior.length > MAX_BEHAVIOR_CHARS) continue;
    return { ...v.value, behavior };
  }
  return null;
}

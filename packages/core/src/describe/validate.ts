// validateDescription (spec section 8, issue #22): schema, length (with host repair), identifier check, injection
// filter and secret filter, in that order. Pure, no I/O. Failure details name rules only; matched text (which may be
// a secret or an injected instruction) is never put into a detail string.

import type { Description, FactSheet } from "../types.js";
import { scanInjection } from "./filters.js";
import { unknownIdentifiers } from "./identifiers.js";
import {
  DescriptionShapeSchema,
  MAX_BEHAVIOR_CHARS,
  MAX_BEHAVIOR_WORDS,
  MAX_TERM_CHARS,
  MAX_TERMS,
  MIN_TERMS,
} from "./schema.js";
import { scanSecrets } from "./secrets.js";
import { wordCount } from "./text.js";

export type ValidationFailureReason = "schema" | "length" | "identifier" | "injection" | "secret";
export type ValidationRepair = "behavior-truncated" | "search-terms-stripped";
export type ValidationResult =
  | { ok: true; value: Description; repairs?: ValidationRepair[] }
  | { ok: false; reason: ValidationFailureReason; detail: string };

export interface ValidateOptions {
  /**
   * Truncate an over-length `behavior` at a word boundary instead of failing (default true; M0 decision on #22).
   * Pass false to fail with reason `length` so the caller can re-ask the model once.
   */
  repairLength?: boolean;
}

/** Words a truncated sentence must not end on ("... and the"). */
const DANGLING = new Set(
  "a an and or but of to in on at for with by from that which as if when then than into via the is are be its their".split(
    " ",
  ),
);
/** A truncated behavior shorter than this is not worth keeping; the function is flagged for a re-ask. */
const MIN_REPAIRED_WORDS = 4;

/**
 * Truncates `behavior` to at most 25 words and 200 characters at a word boundary, drops dangling conjunctions or
 * articles and trailing punctuation, and ends with a full stop. Returns `null` when nothing useful remains (the
 * caller should re-ask). Text already within limits is returned unchanged with `truncated: false`.
 */
export function truncateBehavior(behavior: string): { text: string; truncated: boolean } | null {
  const text = behavior.trim();
  if (wordCount(text) <= MAX_BEHAVIOR_WORDS && text.length <= MAX_BEHAVIOR_CHARS) {
    return { text, truncated: false };
  }
  const words = text.split(/\s+/).filter(Boolean).slice(0, MAX_BEHAVIOR_WORDS);
  const fits = () => words.join(" ").length <= MAX_BEHAVIOR_CHARS - 1; // room for the closing full stop
  while (words.length > 0 && !fits()) words.pop();
  for (;;) {
    const last = words[words.length - 1];
    if (last === undefined) break;
    const bare = last.replace(/[^\p{L}\p{N}_$]+$/u, "");
    if (bare !== last) words[words.length - 1] = bare;
    if (bare === "" || DANGLING.has(bare.toLowerCase())) words.pop();
    else break;
  }
  if (words.length < MIN_REPAIRED_WORDS) return null;
  return { text: `${words.join(" ")}.`, truncated: true };
}

function fail(reason: ValidationFailureReason, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

export function validateDescription(
  raw: unknown,
  sheet: FactSheet,
  options: ValidateOptions = {},
): ValidationResult {
  const repairLength = options.repairLength ?? true;

  // (1) schema: shape, types, suggestedName rules. Length limits are checked separately so they get their own reason.
  const parsed = DescriptionShapeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail("schema", `${issue?.path.join(".") || "description"}: ${issue?.message ?? "invalid"}`);
  }
  const d = parsed.data;
  if (d.behavior.trim() === "") return fail("schema", "behavior is empty");
  if (d.searchTerms.some((t) => t.trim() === "")) return fail("schema", "searchTerms holds an empty term");
  if (d.nameFits && d.suggestedName !== undefined)
    return fail("schema", "suggestedName present although nameFits is true");
  if (!d.nameFits && d.suggestedName === undefined)
    return fail("schema", "suggestedName missing although nameFits is false");

  // Secret filter, after the model: nothing the model wrote may contain a credential. It runs before every check that
  // echoes text in its detail, so a leaked key can never be copied into a failure message.
  const secretHits = scanSecrets([d.behavior, ...d.searchTerms, d.suggestedName ?? ""].join("\n"));
  if (secretHits.length > 0) return fail("secret", `matched rules: ${secretHits.join(", ")}`);

  // (2) length. Over-length behavior is repaired (truncated) or flagged for a re-ask; terms are never repaired.
  if (d.searchTerms.length < MIN_TERMS || d.searchTerms.length > MAX_TERMS) {
    return fail(
      "length",
      `searchTerms must hold ${MIN_TERMS} to ${MAX_TERMS} terms, got ${d.searchTerms.length}`,
    );
  }
  if (d.searchTerms.some((t) => t.length > MAX_TERM_CHARS)) {
    return fail("length", `a search term is longer than ${MAX_TERM_CHARS} characters`);
  }
  const original = d.behavior.trim();
  let behavior = original;
  const repairs: ValidationRepair[] = [];
  if (wordCount(original) > MAX_BEHAVIOR_WORDS || original.length > MAX_BEHAVIOR_CHARS) {
    const tooLong = `behavior has ${wordCount(original)} words and ${original.length} characters (limit ${MAX_BEHAVIOR_WORDS} words, ${MAX_BEHAVIOR_CHARS} characters)`;
    if (!repairLength) return fail("length", `${tooLong}; re-ask the model`);
    const fixed = truncateBehavior(original);
    if (fixed === null) return fail("length", `${tooLong}; truncation left too little, re-ask the model`);
    behavior = fixed.text;
    repairs.push("behavior-truncated");
  }

  // (3) identifiers, checked on the full text the model wrote.
  const unknown = unknownIdentifiers(original, sheet);
  if (unknown.length > 0) {
    // Unknown identifiers are the model's own tokens, not secrets or fact sheet content, so they are safe to name.
    return fail(
      "identifier",
      `not in the fact sheet: ${unknown
        .slice(0, 5)
        .map((u) => u.slice(0, 40))
        .join(", ")}`,
    );
  }

  // (4) injection filter on behavior and every search term. Weak imperative words (delete, execute, run the) reject a
  // behavior but only strip a search term, which is a noun phrase ("delete user"), not an instruction.
  const b = scanInjection(original);
  if (b.reject.length + b.weak.length > 0)
    return fail("injection", `behavior: ${[...b.reject, ...b.weak].join(", ")}`);
  const terms: string[] = [];
  let stripped = false;
  for (const t of d.searchTerms) {
    const f = scanInjection(t);
    if (f.reject.length > 0) return fail("injection", `searchTerms: ${f.reject.join(", ")}`);
    if (f.weak.length > 0) stripped = true;
    else terms.push(t.trim());
  }
  if (terms.length === 0) return fail("injection", "every search term was stripped by the injection filter");
  if (stripped) repairs.push("search-terms-stripped");
  if (d.suggestedName !== undefined) {
    // An identifier cannot carry a URL, but it can spell a phrase; judge it as separate words.
    const words = d.suggestedName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$]+/g, " ");
    const f = scanInjection(words);
    const hit = f.reject.filter((n) => n !== "assistant");
    if (hit.length > 0) return fail("injection", `suggestedName: ${hit.join(", ")}`);
  }

  // Re-check length after repairs (spec: "then re-check length").
  if (wordCount(behavior) > MAX_BEHAVIOR_WORDS || behavior.length > MAX_BEHAVIOR_CHARS) {
    return fail("length", "behavior is still over the limit after repair");
  }

  const value: Description = {
    behavior: behavior.normalize("NFKC"),
    searchTerms: terms,
    nameFits: d.nameFits,
  };
  if (d.suggestedName !== undefined) value.suggestedName = d.suggestedName;
  return repairs.length > 0 ? { ok: true, value, repairs } : { ok: true, value };
}

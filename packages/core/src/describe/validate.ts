// validateDescription (spec section 8, issue #22). Order: hard caps (O(1)), schema, secret filter, length (with
// truncation repair), shape of `behavior`, grounding of every unusual token in the fact sheet's names, then a small
// injection filter for defence in depth. Pure, no I/O. Failure details name rules only; matched text (which may be a
// secret or an injected instruction) is never put into a detail string, and ungrounded tokens are echoed shortened.

import type { Description, FactSheet } from "../types.js";
import { scanInjection } from "./filters.js";
import {
  describeUngrounded,
  groundingNames,
  isGrounded,
  splitIdentifierWords,
  ungroundedTokens,
} from "./identifiers.js";
import {
  DescriptionShapeSchema,
  HARD_MAX_BEHAVIOR_CHARS,
  HARD_MAX_NAME_CHARS,
  HARD_MAX_TERM_CHARS,
  MAX_BEHAVIOR_CHARS,
  MAX_BEHAVIOR_WORDS,
  MAX_TERM_CHARS,
  MAX_TERMS,
  MIN_TERMS,
} from "./schema.js";
import { scanSecrets } from "./secrets.js";
import {
  addressingHits,
  hasDisallowedCharacters,
  instructsProtectedObject,
  shapeProblem,
  startsWithDirective,
} from "./shape.js";
import { tokenize, wordCount } from "./text.js";

export type ValidationFailureReason =
  | "schema"
  | "length"
  | "shape"
  | "identifier"
  | "injection"
  | "secret";
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
/** Search terms are one to four words. */
const MAX_TERM_WORDS = 4;
/** Addressing words that stay banned inside a `suggestedName` (identifiers such as `shouldRetry` are fine). */
const NAME_ADDRESSING = new Set("you your yours we our must ought shall please remember".split(" "));

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

/** O(1) caps on the raw object, before any parsing, regex or normalisation. Returns a detail or null. */
function hardCapViolation(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.behavior === "string" && o.behavior.length > HARD_MAX_BEHAVIOR_CHARS)
    return `behavior is longer than ${HARD_MAX_BEHAVIOR_CHARS} characters`;
  if (Array.isArray(o.searchTerms)) {
    if (o.searchTerms.length > MAX_TERMS) return `searchTerms holds more than ${MAX_TERMS} terms`;
    for (const t of o.searchTerms) {
      if (typeof t === "string" && t.length > HARD_MAX_TERM_CHARS)
        return `a search term is longer than ${HARD_MAX_TERM_CHARS} characters`;
    }
  }
  if (typeof o.suggestedName === "string" && o.suggestedName.length > HARD_MAX_NAME_CHARS)
    return `suggestedName is longer than ${HARD_MAX_NAME_CHARS} characters`;
  return null;
}

type TermVerdict = { ok: true } | { ok: false; reason: ValidationFailureReason; detail: string };

function judgeTerm(term: string, names: ReadonlySet<string>): TermVerdict {
  if (hasDisallowedCharacters(term)) return { ok: false, reason: "shape", detail: "disallowed characters" };
  const tokens = tokenize(term);
  if (tokens.length === 0 || tokens.length > MAX_TERM_WORDS)
    return { ok: false, reason: "shape", detail: `a term must hold 1 to ${MAX_TERM_WORDS} words` };
  const lower = tokens.map((t) => t.toLowerCase());
  if (addressingHits(term).length > 0)
    return { ok: false, reason: "injection", detail: "addressing words" };
  if (startsWithDirective(lower) || instructsProtectedObject(lower))
    return { ok: false, reason: "injection", detail: "directive term" };
  const f = scanInjection(term);
  if (f.reject.length > 0) return { ok: false, reason: "injection", detail: f.reject.join(", ") };
  const bad = tokens.filter((t) => !isGrounded(t, names));
  if (bad.length > 0) return { ok: false, reason: "identifier", detail: describeUngrounded(bad) };
  return { ok: true };
}

function judgeName(name: string, names: ReadonlySet<string>): TermVerdict {
  const words = splitIdentifierWords(name);
  const lower = words.map((w) => w.toLowerCase());
  if (!names.has(name)) {
    const bad = words.filter((w) => !isGrounded(w, names));
    if (bad.length > 0) return { ok: false, reason: "identifier", detail: describeUngrounded(bad) };
  }
  if (lower.some((w) => NAME_ADDRESSING.has(w)))
    return { ok: false, reason: "injection", detail: "addressing words" };
  if (instructsProtectedObject(lower)) return { ok: false, reason: "injection", detail: "directive name" };
  const f = scanInjection(words.join(" "));
  if (f.reject.length > 0) return { ok: false, reason: "injection", detail: f.reject.join(", ") };
  return { ok: true };
}

export function validateDescription(
  raw: unknown,
  sheet: FactSheet,
  options: ValidateOptions = {},
): ValidationResult {
  const repairLength = options.repairLength ?? true;

  // (1) hard caps, first and O(1): nothing below ever sees more than 400 characters of behavior.
  const capped = hardCapViolation(raw);
  if (capped !== null) return fail("length", capped);

  // (2) schema: shape, types, suggestedName rules. Length limits are checked separately so they get their own reason.
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

  // (3) secret filter: nothing the model wrote may contain a credential. It runs before every check that echoes text
  // in its detail, so a leaked key can never be copied into a failure message. All fields are scanned joined, so a
  // key split across fields is found (the scanner also drops spaces and hyphens between alphanumerics).
  const secretHits = scanSecrets([d.behavior, ...d.searchTerms, d.suggestedName ?? ""].join(" "));
  if (secretHits.length > 0) return fail("secret", `matched rules: ${secretHits.join(", ")}`);

  // (4) length. Over-length behavior is repaired (truncated) or flagged for a re-ask; terms are never repaired.
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

  // (5) shape of behavior, judged on the full text the model wrote (a payload in the truncated-away tail still counts).
  const problem = shapeProblem(original);
  if (problem !== null) return fail("shape", `behavior: ${problem}`);

  // (6) grounding: every unusual token must be a name from the fact sheet or on a committed list.
  const names = groundingNames(sheet);
  const ungrounded = ungroundedTokens(original, names);
  if (ungrounded.length > 0) return fail("identifier", `behavior ${describeUngrounded(ungrounded)}`);

  // (7) injection filter, defence in depth: behavior, and behavior with every term appended (instructions split
  // across fields), then each search term and the suggested name on their own.
  const b = scanInjection(`${original} ${d.searchTerms.join(" ")}`);
  if (b.reject.length > 0) return fail("injection", `behavior and terms: ${b.reject.join(", ")}`);
  // Terms joined with no separator: a run of 12+ hex characters holding a digit is a key split across terms.
  if (/(?=[0-9a-f]{0,11}\d)[0-9a-f]{12}/i.test(d.searchTerms.join("").replace(/[^A-Za-z0-9]/g, "")))
    return fail("identifier", "searchTerms together hold a long hexadecimal run");

  const terms: string[] = [];
  let firstTermFailure: { reason: ValidationFailureReason; detail: string } | null = null;
  for (const t of d.searchTerms) {
    const v = judgeTerm(t, names);
    if (v.ok) terms.push(t.trim());
    else firstTermFailure ??= v;
  }
  if (terms.length === 0 && firstTermFailure !== null)
    return fail(firstTermFailure.reason, `searchTerms: ${firstTermFailure.detail}`);
  if (terms.length < d.searchTerms.length) repairs.push("search-terms-stripped");
  // Terms that each passed may still spell something together ("do" + "not", "skip" + "the tests").
  const kept = terms.join(" ");
  if (addressingHits(kept).length > 0 || instructsProtectedObject(tokenize(kept.toLowerCase())))
    return fail("injection", "searchTerms together: addressing or directive words");

  if (d.suggestedName !== undefined) {
    const v = judgeName(d.suggestedName, names);
    if (!v.ok) return fail(v.reason, `suggestedName: ${v.detail}`);
  }

  // Re-check after repairs (spec: "then re-check length"): a cut inside a parenthetical must not leave it open.
  if (behavior !== original) {
    const again = shapeProblem(behavior);
    if (again !== null) return fail("shape", `behavior after repair: ${again}`);
  }
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

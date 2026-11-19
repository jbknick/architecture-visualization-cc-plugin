// validateDescription (spec section 8, issue #22). Order: hard caps (O(1)), schema, secret filter, length (with
// truncation repair), shape of `behavior`, grounding of every unusual token in the fact sheet's names, then a small
// injection filter for defence in depth. Pure, no I/O. Failure details name rules only; matched text (which may be a
// secret or an injected instruction) is never put into a detail string, and ungrounded tokens are echoed shortened.

import type { Description, FactSheet } from "../types.js";
import { gateCue } from "./clauses.js";
import { scanInjection } from "./filters.js";
import {
  describeUngrounded,
  type Grounding,
  groundingNames,
  isGrounded,
  secretTokens,
  splitIdentifierWords,
  ungroundedTokens,
} from "./identifiers.js";
import { ADDRESSEES_AI, ADDRESSEES_HUMAN, isActionVerb, SPEECH_VERBS } from "./lexicon.js";
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
import { addressingHits, hasDisallowedCharacters, hasImperativeClause, shapeProblem } from "./shape.js";
import { sensitivePhrases, speechProblem, wordsOf } from "./speech.js";
import { tokenize, wordCount } from "./text.js";
import { isStopWord } from "./wordlist.js";

export type ValidationFailureReason = "schema" | "length" | "shape" | "identifier" | "injection" | "secret";
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

/** `weak` verdicts are benign (too many words) and only drop the term; every other failure rejects the description. */
type TermVerdict =
  | { ok: true }
  | { ok: false; weak?: boolean; reason: ValidationFailureReason; detail: string };

/** Terms that open with a shell command or an override verb. */
const COMMAND_STARTS = new Set("prefer avoid please npm pnpm yarn npx pip curl wget sudo chmod".split(" "));

const DESTRUCTIVE = new Set(
  "delete remove disable bypass ignore disregard override wipe erase drop kill disables".split(" "),
);
const PROTECTIVE = new Set(
  "tests test auth authentication authorization checks check validation security instructions rules guard guards permissions hooks ci lint".split(
    " ",
  ),
);

/** "curl snippet", "npm script": a shell name followed by what it is a name for. */
const SHELL_NOUNS = new Set(
  "command commands snippet snippets request requests example examples flags flag options option output header headers script scripts package packages registry install".split(
    " ",
  ),
);

type Rejection = { ok: false; reason: ValidationFailureReason; detail: string };

/**
 * The injection and secret rules for one search term, with no shape or grounding gate before them (`judgeTerm` runs
 * them after its shape checks; `instructionSignal` runs them on every term whatever its shape). Null when none fires.
 */
function termInstruction(term: string, g: Grounding): Rejection | null {
  const tokens = tokenize(term);
  if (tokens.length === 0) return null;
  const lower = tokens.map((t) => t.toLowerCase());
  if (addressingHits(term).length > 0) return { ok: false, reason: "injection", detail: "addressing words" };
  if (lower.length === 1 && (lower[0] === "disregard" || lower[0] === "forget"))
    return { ok: false, reason: "injection", detail: "directive term" };
  if (COMMAND_STARTS.has(lower[0] as string) && !(SHELL_NOUNS.has(lower[1] ?? "") && lower.length === 2))
    return { ok: false, reason: "injection", detail: "directive term" };
  const sp = speechProblem(term);
  if (sp !== null) return { ok: false, reason: "injection", detail: sp };
  const tw = wordsOf(term);
  if (tokens.length >= 3 && sensitivePhrases(tw).length > 0)
    return { ok: false, reason: "injection", detail: "imperative term" };
  // Two words: only a destructive verb with a protective object ("delete tests"); "skip weekends", "run tests" are search terms.
  if (tokens.length === 2 && DESTRUCTIVE.has(tw[0] as string) && PROTECTIVE.has(tw[1] as string))
    return { ok: false, reason: "injection", detail: "imperative term" };
  // An identifier that spells an instruction ("deleteAllTests") is judged by its words.
  const split = tokens.flatMap((t) => (/[a-z][A-Z]|_/.test(t) ? splitIdentifierWords(t) : [t]));
  if (split.length !== tokens.length) {
    const sw = split.map((t) => t.toLowerCase());
    if (sensitivePhrases(sw).length > 0)
      return { ok: false, reason: "injection", detail: "imperative identifier" };
    const fs = scanInjection(sw.join(" "));
    if (fs.reject.length > 0) return { ok: false, reason: "injection", detail: fs.reject.join(", ") };
  }
  const f = scanInjection(term);
  if (f.reject.length > 0) return { ok: false, reason: "injection", detail: f.reject.join(", ") };
  if (secretTokens(term, g).length > 0) return { ok: false, reason: "secret", detail: "a credential value" };
  return null;
}

function judgeTerm(term: string, g: Grounding): TermVerdict {
  if (hasDisallowedCharacters(term)) return { ok: false, reason: "shape", detail: "disallowed characters" };
  const tokens = tokenize(term);
  if (tokens.length === 0) return { ok: false, reason: "shape", detail: "empty term" };
  if (tokens.length > MAX_TERM_WORDS)
    return {
      ok: false,
      weak: true,
      reason: "shape",
      detail: `a term must hold 1 to ${MAX_TERM_WORDS} words`,
    };
  const instruction = termInstruction(term, g);
  if (instruction !== null) return instruction;
  if (tokens.map((t) => t.toLowerCase()).every((t) => isStopWord(t)))
    return { ok: false, reason: "shape", detail: "a term of function words only" };
  const bad = tokens.filter((t) => !isGrounded(t, g));
  if (bad.length > 0) return { ok: false, reason: "identifier", detail: describeUngrounded(bad) };
  return { ok: true };
}

/** Instruction phrases that span search terms, or fill a term of three words or more ("remove auth" + "check"). */
function termsTogetherInstruct(terms: readonly string[]): boolean {
  const words: string[] = [];
  const owner: number[] = [];
  terms.forEach((t, k) => {
    for (const w of wordsOf(t)) {
      words.push(w);
      owner.push(k);
    }
  });
  // A destructive verb standing alone as a term, next to a term that names protective code ("auth", "check", "remove").
  const alone = terms.findIndex((t) => {
    const tw = wordsOf(t);
    return tw.length === 1 && DESTRUCTIVE.has(tw[0] as string);
  });
  if (alone >= 0 && words.some((w, i) => owner[i] !== alone && PROTECTIVE.has(w))) return true;
  for (const { from, to } of sensitivePhrases(words)) {
    if (owner[from] !== owner[to]) return true;
    if (words.filter((_, i) => owner[i] === owner[from]).length >= 3) return true;
  }
  return false;
}

function judgeName(name: string, g: Grounding): TermVerdict {
  const words = splitIdentifierWords(name);
  const whole = g.names.has(name);
  if (!whole) {
    const bad = words.filter((w) => !isGrounded(w, g));
    if (bad.length > 0) return { ok: false, reason: "identifier", detail: describeUngrounded(bad) };
  }
  return nameInstruction(name, g) ?? { ok: true };
}

/** The injection and secret rules for a `suggestedName`, with no grounding gate before them. Null when none fires. */
function nameInstruction(name: string, g: Grounding): Rejection | null {
  const words = splitIdentifierWords(name);
  const lower = words.map((w) => w.toLowerCase());
  if (lower.some((w) => NAME_ADDRESSING.has(w)))
    return { ok: false, reason: "injection", detail: "addressing words" };
  if (sensitivePhrases(lower).some((p) => p.from === 0))
    return { ok: false, reason: "injection", detail: "directive name" };
  const sp = speechProblem(lower.join(" "));
  if (sp !== null) return { ok: false, reason: "injection", detail: sp };
  const f = scanInjection(words.join(" "));
  if (f.reject.length > 0) return { ok: false, reason: "injection", detail: f.reject.join(", ") };
  if (secretTokens(words.join(" "), g).length > 0)
    return { ok: false, reason: "secret", detail: "a credential value" };
  return null;
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
  const speech = speechProblem(original);
  if (speech !== null) return fail("injection", `behavior: ${speech}`);

  // (6) grounding: every token must be an ordinary word, a small number, or come from the fact sheet.
  const g = groundingNames(sheet);
  if (secretTokens(original, g).length > 0)
    return fail("secret", "behavior repeats a credential value from the code");
  const ungrounded = ungroundedTokens(original, g);
  if (ungrounded.length > 0) return fail("identifier", `behavior ${describeUngrounded(ungrounded)}`);

  // (7) injection filter, defence in depth: behavior, and behavior with every term appended (instructions split
  // across fields), then each search term and the suggested name on their own.
  const b = scanInjection(`${original} ${d.searchTerms.join(" ")}`);
  if (b.reject.length > 0) return fail("injection", `behavior and terms: ${b.reject.join(", ")}`);
  // Terms joined with no separator: a run of 12+ hex characters holding a digit is a key split across terms.
  if (/(?=[0-9a-f]{0,11}\d)[0-9a-f]{12}/i.test(d.searchTerms.join("").replace(/[^A-Za-z0-9]/g, "")))
    return fail("identifier", "searchTerms together hold a long hexadecimal run");

  // Search terms: a term rejected for an instruction-like reason (imperative, addressee, modal, ungrounded token,
  // secret) rejects the whole description. Only benign weak cases (more than four words) are dropped.
  const terms: string[] = [];
  const dropped: string[] = [];
  for (const t of d.searchTerms) {
    const v = judgeTerm(t, g);
    if (v.ok) terms.push(t.trim());
    else if (v.weak === true) dropped.push(t);
    else return fail(v.reason, `searchTerms: ${v.detail}`);
  }
  if (terms.length === 0) return fail("shape", "searchTerms: no usable term");
  if (dropped.length > 0) repairs.push("search-terms-stripped");
  // Terms that each passed may still spell something together ("do" + "not", "skip" + "the tests").
  const kept = terms.join(" ");
  if (addressingHits(kept).length > 0 || termsTogetherInstruct(terms))
    return fail("injection", "searchTerms together: addressing or directive words");
  const joinedSpeech = speechProblem(`${original} ${kept}`);
  if (joinedSpeech !== null) return fail("injection", `behavior and terms: ${joinedSpeech}`);

  if (d.suggestedName !== undefined) {
    const v = judgeName(d.suggestedName, g);
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

// ---------------------------------------------------------------------------------------------------------------------
// Extra-attempt gate (#150, hardened in #175). A rejected description earns the bounded extra attempt (and, after it,
// the fallback) only when it was rejected for wording alone. The validator stops at the first rule that fires and the
// shape rules run before the secret-token, injection, term and name rules, so the rejection reason alone says nothing
// about what else the text holds. `instructionSignal` therefore runs the validator's own secret and injection stages on
// every field, with no shape or grounding gate, plus structural instruction cues of `behavior`.

/**
 * A sentence that claims the host's fallback provenance ("generated without a model" and close variants). Gate only
 * since #180: the validator accepts ordinary sentences such as "Returns the config built from the host environment",
 * and a model that imitates the marker still gets a stored description labelled `model`; consumers read provenance
 * from `described_by`, never from the text. A rejected description that imitates it earns no extra attempt.
 */
const PRODUCED = "(?:generated|written|created|produced|made|built|composed|authored|derived)";
const PRODUCERS = "(?:models?|llms?|ai|language models?|gantry|host|names only)";
/**
 * Sentences about how the description itself was produced (#175 round 2): a production verb, then by, with,
 * without, from, using, via or through, then a model, Gantry, the host or "names only"; "no model was used"; and
 * "generated, no model". Only the host may say this, in the fallback marker.
 */
const FALLBACK_MARKERS: readonly RegExp[] = [
  new RegExp(
    `\\b${PRODUCED}(?: [a-z]+){0,3}? (?:by|with|without|from|using|via|through) (?:[a-z]+ ){0,2}?${PRODUCERS}\\b`,
  ),
  /\bno (?:language )?(?:models?|llms?|ai)(?: (?:was|were|is))? (?:used|involved|needed|called)\b/,
  new RegExp(`\\b${PRODUCED} (?:with )?no (?:models?|llms?|ai)\\b`),
];

/** True when `text` imitates the fallback marker; checked on NFKC-folded words, so punctuation and case do not hide it. */
export function claimsFallbackMarker(text: string): boolean {
  const t = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return FALLBACK_MARKERS.some((re) => re.test(t));
}

/** Shape problems that are instruction cues, never wording slips: a rejection for one of them earns no extra attempt. */
export const NON_EXTENDABLE_SHAPE: ReadonlySet<string> = new Set([
  "multiple-sentences",
  "label",
  "spaced-letters",
  "addressing",
  "imperative-clause",
]);

const ADDRESSEES: ReadonlySet<string> = new Set([...ADDRESSEES_AI, ...ADDRESSEES_HUMAN]);

/** Structural instruction cues of a `behavior`, whatever rule rejected it first. */
function behaviorInstructs(behavior: string): boolean {
  const text = behavior.trim();
  const body = text.endsWith(".") ? text.slice(0, -1) : text;
  if (/\.(?:\s|\.|$)/.test(body) || /[!?\n\r]/.test(text)) return true;
  if (/(?:^|[.;:,(]\s*)[A-Za-z]+(?:\s+[A-Za-z]+)?\s*:/.test(body)) return true;
  if (/(?:^|\s)[A-Za-z](?:\s+[A-Za-z]){2}(?:\s|$)/.test(body)) return true;
  if (hasImperativeClause(body)) return true;
  // The broad gate cues (#175 final round): a base-form or unknown word at any clause start, modals, approval,
  // status and provenance words, markup or non-ASCII characters, addressees and claims.
  if (gateCue(body, { behavior: true })) return true;
  // The first clause and each clause after a hard boundary: an addressee or a bare action verb at its start.
  const clauses = body.split(/[;:]\s*|,\s+/);
  for (let i = 0; i < clauses.length; i++) {
    const first = wordsOf(clauses[i] as string)[0] ?? "";
    if (first === "") continue;
    if (ADDRESSEES.has(first) || SPEECH_VERBS.has(first)) return true;
    if (isActionVerb(first)) return true;
  }
  return false;
}

/** Upper bounds for reading a submission of any shape: strings, total characters and nesting depth. */
const SUBMITTED_MAX_STRINGS = 64;
const SUBMITTED_MAX_CHARS = 4000;
const SUBMITTED_MAX_DEPTH = 6;

/**
 * Every string of a submission, NFKC-folded and capped: those under a `behavior` key (at any depth, inside arrays or
 * objects) and all others (search terms, names, unknown keys, array items, object keys). A bare string counts as a
 * behavior. Bounded by count, size and depth.
 */
export function submittedStrings(raw: unknown): { behaviors: string[]; others: string[] } {
  const behaviors: string[] = [];
  const others: string[] = [];
  let chars = 0;
  const add = (s: string, isBehavior: boolean) => {
    if (behaviors.length + others.length >= SUBMITTED_MAX_STRINGS || chars >= SUBMITTED_MAX_CHARS) return;
    const t = s.slice(0, Math.min(HARD_MAX_BEHAVIOR_CHARS, SUBMITTED_MAX_CHARS - chars)).normalize("NFKC");
    chars += t.length;
    if (t.trim() !== "") (isBehavior ? behaviors : others).push(t);
  };
  const walk = (v: unknown, isBehavior: boolean, depth: number) => {
    if (depth > SUBMITTED_MAX_DEPTH) return;
    if (typeof v === "string") add(v, isBehavior);
    else if (typeof v === "number" || typeof v === "boolean") return;
    else if (Array.isArray(v))
      for (const x of v.slice(0, SUBMITTED_MAX_STRINGS)) walk(x, isBehavior, depth + 1);
    else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, SUBMITTED_MAX_STRINGS)) {
        if (k !== "behavior" && k !== "searchTerms" && k !== "suggestedName" && k !== "nameFits")
          add(k, false);
        walk(x, isBehavior || k === "behavior", depth + 1);
      }
  };
  walk(raw, typeof raw === "string", 0);
  return { behaviors, others };
}

/**
 * True when a description holds anything injection-like or secret-like, judged by the validator's own secret and
 * injection rules run on every field alone and on all fields together, without the shape gate: credential formats,
 * credential values copied from the code (whole or as a 6+ character piece), the injection filter, speech acts,
 * addressing words, the fallback marker, imperative clauses and other instruction cues of `behavior`, the term rules
 * (directives, commands, imperative terms and identifiers, terms that instruct together) and the name rules. Reads
 * only strings, each capped like the validator's hard caps.
 */
export function instructionSignal(raw: unknown, sheet: FactSheet): boolean {
  if (raw === null || raw === undefined) return false;
  // Every submitted value counts, whatever its type or position (#175 round 2): a non-string behavior or a seventh
  // search term is rejected for schema or length, but its text must still taint the rejection.
  const { behaviors, others } = submittedStrings(raw);
  const behavior = behaviors.join(" ");
  const terms = others;
  const fields = [behavior, ...terms].filter((s) => s.trim() !== "");
  if (fields.length === 0) return false;
  const joined = fields.join(" ");
  if (scanSecrets(joined).length > 0) return true;
  const g = groundingNames(sheet);
  const secretWords = [...g.secretWords];
  for (const f of fields) {
    if (secretTokens(f, g).length > 0) return true;
    for (const t of tokenize(f)) {
      const low = t.toLowerCase();
      if (low.length >= 6 && secretWords.some((s) => s.includes(low))) return true;
    }
  }
  // All fields together (an instruction split across fields); each field on its own is covered by the behavior, term
  // and name rules below, which include the injection filter, speech acts and addressing words.
  if (scanInjection(joined).reject.length > 0 || speechProblem(joined) !== null) return true;
  if (addressingHits(joined).length > 0 || claimsFallbackMarker(joined)) return true;
  if (behavior.trim() !== "" && (speechProblem(behavior) !== null || behaviorInstructs(behavior)))
    return true;
  // Every behavior string on its own, then every other string by the term rules, the name rules and the gate cues.
  for (const b of behaviors) if (behaviorInstructs(b)) return true;
  for (const t of terms) if (termInstruction(t, g) !== null || nameInstruction(t, g) !== null) return true;
  // Identifiers are judged by their words too ("waiveReview" -> "waive review").
  for (const t of terms)
    if (gateCue(t, { behavior: false }) || gateCue(splitIdentifierWords(t).join(" "), { behavior: false }))
      return true;
  if (terms.length > 0 && termsTogetherInstruct(terms)) return true;
  return false;
}

/**
 * Whether a rejection is tainted (#175): the rejected description carries an `instructionSignal`, its reason is
 * `injection` or `secret`, or it is a shape rejection of one of `NON_EXTENDABLE_SHAPE`. A tainted rejection never earns
 * the extra attempt, and it rules the extra attempt out for the rejection after it.
 */
export function rejectionTainted(
  v: { reason: ValidationFailureReason; detail: string },
  raw: unknown,
  sheet: FactSheet,
): boolean {
  // Injection and secret always; schema and length too, since the validator then never read the rest (#175 round 2).
  if (v.reason !== "shape" && v.reason !== "identifier") return true;
  if (v.reason === "shape" && [...NON_EXTENDABLE_SHAPE].some((code) => v.detail.includes(code))) return true;
  return instructionSignal(raw, sheet);
}

/** Whether a rejection may earn the bounded extra attempt (#150, #175): `shape` or `identifier`, and not tainted. */
export function extendableRejection(
  v: { reason: ValidationFailureReason; detail: string },
  raw: unknown,
  sheet: FactSheet,
): boolean {
  if (v.reason !== "shape" && v.reason !== "identifier") return false;
  return !rejectionTainted(v, raw, sheet);
}

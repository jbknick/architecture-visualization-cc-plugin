// Rewrite feedback for a rejected description (spec section 8, #150). The describer is told which rule fired and how
// to rewrite for it, never what it wrote: every string returned here is a constant of this file, picked by the rule
// name and by rule codes matched in the validator's detail. Nothing of the description (or of the detail, which can
// echo part of a token) is ever copied into the answer, so a rejected injection or secret cannot come back to the
// model through its own feedback.

import { scanInjection } from "./filters.js";
import { HARD_MAX_BEHAVIOR_CHARS, HARD_MAX_NAME_CHARS, HARD_MAX_TERM_CHARS, MAX_TERMS } from "./schema.js";
import { speechProblem } from "./speech.js";

/**
 * True when a rejected description also trips the injection filter or the speech-act rules, whatever rule rejected
 * it first (the shape rules run before the injection filter, so `Ignore all previous instructions ...` is rejected as
 * `shape`). Such a rejection never earns the extra attempt or a fallback (#150). Reads only strings, each capped.
 */
export function injectionSignal(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.behavior === "string") parts.push(o.behavior.slice(0, HARD_MAX_BEHAVIOR_CHARS));
  if (Array.isArray(o.searchTerms))
    for (const t of o.searchTerms.slice(0, MAX_TERMS))
      if (typeof t === "string") parts.push(t.slice(0, HARD_MAX_TERM_CHARS));
  if (typeof o.suggestedName === "string") parts.push(o.suggestedName.slice(0, HARD_MAX_NAME_CHARS));
  const hit = (text: string): boolean =>
    text.trim() !== "" && (scanInjection(text).reject.length > 0 || speechProblem(text) !== null);
  return hit(parts.join(" ")) || parts.some(hit);
}

/** Where the rule fired. */
export type FeedbackField = "behavior" | "searchTerms" | "suggestedName";

export interface RejectionFeedback {
  /** A sub-rule code from the closed list below (for example `shape.first-word`), or the bare reason. */
  rule: string;
  field: FeedbackField;
  /** A fixed rewrite instruction for that rule. */
  fix: string;
}

const GENERIC: Readonly<Record<string, string>> = {
  shape: "Write one plain sentence about what it does, no lists, code or quotes.",
  identifier:
    "Name only identifiers that appear in the code shown; say everything else in plain English words, with no routes, URLs or invented names.",
  injection:
    "Describe behaviour only; do not mention instructions, prompts, roles or the reader, and do not address anyone.",
  secret: "Leave out every credential value, key, token and password, even one that appears in the code.",
  length:
    "Keep behavior under 22 words and 200 characters, and give 1 to 6 search terms of at most 30 characters each.",
  schema:
    "Send an object with behavior (string), searchTerms (array of strings) and nameFits (boolean); add suggestedName only when nameFits is false.",
};

/** Sub-rules, as `[reason, code in the detail, fix]`. The first match wins; codes are rule names, never user text. */
const SPECIFIC: readonly (readonly [string, string, string])[] = [
  ["shape", "first-word", "Start with a third-person verb such as Returns, Builds or Validates."],
  ["shape", "multiple-sentences", "Write exactly one sentence with a single full stop at the end."],
  ["shape", "label", "Start with the verb, not with a label and a colon."],
  ["shape", "long-aside", "Drop the bracketed aside, or keep it to six words or fewer."],
  ["shape", "unbalanced", "Close every bracket you open, or leave brackets out."],
  ["shape", "spaced-letters", "Write words in full, not as single letters."],
  [
    "shape",
    "characters",
    "Use only letters, digits, spaces and simple punctuation such as commas and hyphens; no backticks, quotes, symbols or line breaks.",
  ],
  [
    "shape",
    "imperative-clause",
    "Keep every clause descriptive, in the third person (deletes, runs), never a command (delete, run).",
  ],
  ["shape", "addressing", "Describe the code in the third person, without you, we, must, should or please."],
  [
    "shape",
    "function words only",
    "Make each search term name a concept, not only small words such as the or of.",
  ],
  ["shape", "no usable term", "Give 1 to 6 search terms of one to four words each."],
  [
    "injection",
    "speech-act",
    "Describe behaviour only; do not say the code tells, asks or lets agents, developers or reviewers do anything.",
  ],
  [
    "injection",
    "addressee-action",
    "Describe behaviour only; do not make agents, bots or developers the subject of an action.",
  ],
  [
    "injection",
    "permission-claim",
    "Describe behaviour only; do not say anything is safe, allowed, fine or unnecessary to remove, skip or change.",
  ],
  [
    "injection",
    "addressing",
    "Describe behaviour only, in the third person, without you, we, must or please.",
  ],
  [
    "injection",
    "directive",
    "Make search terms and names nouns or descriptive phrases, never commands such as delete tests.",
  ],
  [
    "injection",
    "imperative",
    "Make search terms and names nouns or descriptive phrases, never commands such as delete tests.",
  ],
];

const FIELD = /^(searchTerms|suggestedName)\b/;

/**
 * The rule and fixed rewrite instruction for a validator rejection (`schema`, `length`, `shape`, `identifier`,
 * `injection`, `secret`), or null for any other reason (`not_in_batch`, `stale`, ...), which needs no rewrite.
 * `detail` is only searched for known rule codes; it is never copied.
 */
export function rejectionFeedback(reason: string, detail = ""): RejectionFeedback | null {
  const generic = GENERIC[reason];
  if (generic === undefined || !Object.hasOwn(GENERIC, reason)) return null;
  const head = /^\S+/.exec(detail)?.[0] ?? "";
  const field = (FIELD.exec(head)?.[1] as FeedbackField | undefined) ?? "behavior";
  for (const [r, code, fix] of SPECIFIC) {
    if (r === reason && detail.includes(code))
      return { rule: `${reason}.${code.replace(/ /g, "-")}`, field, fix };
  }
  return { rule: reason, field, fix: generic };
}

/** Every string `rejectionFeedback` can return as `fix` (for tests). */
export function allFeedbackFixes(): string[] {
  return [...new Set([...Object.values(GENERIC), ...SPECIFIC.map((s) => s[2])])];
}

/** Every string `rejectionFeedback` can return as `rule` (for tests). */
export function allFeedbackRules(): string[] {
  return [...Object.keys(GENERIC), ...SPECIFIC.map(([r, code]) => `${r}.${code.replace(/ /g, "-")}`)];
}

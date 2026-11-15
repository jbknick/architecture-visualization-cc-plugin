// Rewrite feedback for a rejected description (spec section 8, #150). The describer is told which rule fired and how
// to rewrite for it, never what it wrote: every string returned here is a constant of this file, picked by the rule
// name and by rule codes matched in the validator's detail. Nothing of the description (or of the detail, which can
// echo part of a token) is ever copied into the answer, so a rejected injection or secret cannot come back to the
// model through its own feedback.

// Whether a rejection may earn the extra attempt is decided by `extendableRejection` in validate.ts (#175), which runs
// the validator's own secret and injection stages on every field.

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
  ["shape", "unbalanced", "Close every bracket that is opened, or leave brackets out."],
  ["shape", "spaced-letters", "Write words in full, not as single letters."],
  [
    "shape",
    "characters",
    "Use only letters, digits, spaces and simple punctuation such as commas and hyphens; no backticks, quotes, symbols or line breaks.",
  ],
  [
    "shape",
    "imperative-clause",
    "Keep every clause a third-person statement of what the code does; no clause may be a command.",
  ],
  [
    "shape",
    "addressing",
    "Describe the code in the third person, without addressing anyone or saying what has to happen.",
  ],
  [
    "shape",
    "function words only",
    "Make each search term name a concept, not only small words such as the or of.",
  ],
  ["shape", "no usable term", "Give 1 to 6 search terms of one to four words each."],
  [
    "injection",
    "speech-act",
    "Describe behaviour only; do not say the code tells or asks anyone to do anything.",
  ],
  [
    "injection",
    "addressee-action",
    "Describe behaviour only; make the code, not a person or an agent, the subject.",
  ],
  [
    "injection",
    "permission-claim",
    "Describe behaviour only; do not judge whether any code may be changed or removed.",
  ],
  ["injection", "addressing", "Describe behaviour only, in the third person, without addressing anyone."],
  ["injection", "directive", "Make search terms and names nouns or descriptive phrases, never commands."],
  ["injection", "imperative", "Make search terms and names nouns or descriptive phrases, never commands."],
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

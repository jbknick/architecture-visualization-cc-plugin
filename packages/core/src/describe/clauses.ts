// Extra-attempt gate cues (spec section 8, #175). These rules never reject a description: they only decide whether a
// rejected one was a clean wording slip that may earn the bounded extra attempt. A false positive here costs one
// retry, never an honest description, so the rules are deliberately broad and taint whenever they are unsure. The
// validator is not the security boundary either: description text is untrusted everywhere downstream and is contained
// in `untrusted_*` fields with a provenance label. Every function here is linear in its (capped) input.

import { ADDRESSEES_AI, ADDRESSEES_HUMAN } from "./lexicon.js";
import { wordsOf } from "./speech.js";

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/** Words that may open a description clause and are never a verb: determiners, pronouns, prepositions, conjunctions. */
const CLOSED_STARTERS = set(`
the a an this that these those each every all any some no its their his her it they them which who whose whom what
where when whenever while if unless until because since though although as so and or but nor than for with by from
to in on at of into onto via per over under after before during without within between among across through about
around against like near beyond toward towards upon not only both either neither such same other another more most
less least many much few several one two three four five six seven eight nine ten
`);

/** Adverbs and connectives skipped before a clause's first real word ("then delete", "always trust"). */
const LEAD_SKIP = set("always never just now then also simply kindly first finally next immediately quickly");

/**
 * True when a clause may open with `w` as a description clause: a closed-class starter, an -s form (a third-person
 * verb or a plural noun), a participle (-ed, -ing) or a number. Anything else, a base-form verb or a word the rule
 * cannot place, counts as an order.
 */
function descriptiveStart(w: string): boolean {
  if (CLOSED_STARTERS.has(w) || /^\d/.test(w)) return true;
  if (w.length >= 4 && w.endsWith("s") && !/(?:ss|us)$/.test(w)) return true;
  return /^[a-z]{3,}(?:ed|ing)$/.test(w);
}

/**
 * A clause of `text` that opens with a base-form or unknown word (#175 final round). Clauses are split at every
 * punctuation mark and dash, commas and quotes included, after NFKC folding; one leading adverb or connective is
 * skipped. The first clause counts too.
 */
export function clauseStartCue(text: string): boolean {
  const clauses = text
    .normalize("NFKC")
    .split(/[^A-Za-z0-9'\s-]|'(?=[A-Za-z])|(?<=[A-Za-z])'|\s-+|-+\s|-{2,}/);
  for (const c of clauses) {
    const words = wordsOf(c);
    let k = 0;
    while (
      k < words.length - 1 &&
      (LEAD_SKIP.has(words[k] as string) || /^[a-z]{3,}ly$/.test(words[k] as string))
    )
      k++;
    const first = words[k];
    if (first !== undefined && !descriptiveStart(first.split("-").pop() ?? first)) return true;
  }
  return false;
}

/** Modals and "please": a statement of what ought to happen, never a description of what the code does. */
const MODALS = set(
  "can could may might must shall should will would ought need needs needed please pls plz kindly",
);

/**
 * Approval, status and provenance words anywhere ("approved", "merge", "ship", "review", "LGTM", "safe", "trusted",
 * "verified", "ready", "cleared", "pass", "looks good", "model", "fallback", ...). Broad by design.
 */
const STATUS_WORD =
  /\b(?:approv\w*|preapprov\w*|merg\w*|ship\w*|review\w*|lgtm|l g t m|safe\w*|trust\w*|verified|vetted|ready|cleared|pass\w*|looks good|good to|ok to|okay\w*|fine to|thumbs up|plus one|green ?light\w*|sign\w* off|stamp\w*|endors\w*|upvot\w*|exempt|benign|recommend\w*|models?|llms?|fallback|deterministic|indexer|gantry|host|generated)\b/;

/** Modal, "please", or an approval, status or provenance word in `text`. */
export function statusCue(text: string): boolean {
  const t = wordsOf(text.normalize("NFKC")).join(" ");
  return STATUS_WORD.test(t) || t.split(" ").some((w) => MODALS.has(w));
}

/** Angle brackets, or any character outside printable ASCII after NFKC folding (look-alike punctuation, zero-width). */
export function markupCue(text: string): boolean {
  return /[<>]|[^\x20-\x7e]/.test(text.normalize("NFKC"));
}

const ADDRESSEE_SUBJECTS: ReadonlySet<string> = new Set([
  ...ADDRESSEES_AI,
  ...ADDRESSEES_HUMAN,
  "user",
  "users",
  "you",
  "someone",
  "somebody",
  "everyone",
  "owner",
  "owners",
]);

/** An addressee, an AI or an indefinite person named anywhere in `text` ("the bot approves it", "someone merge"). */
export function addresseeCue(text: string): boolean {
  return wordsOf(text.normalize("NFKC")).some((w) => ADDRESSEE_SUBJECTS.has(w));
}

/** Status and permission claims, matched on lower-case words (kept from round 2; now gate only). */
const CLAIMS: readonly RegExp[] = [
  /\blgtm\b/,
  /\bno (?:(?!is |are |was |were )[a-z-]+ ){0,2}(?:needed|required|necessary)\b/,
  /\b(?:review|reviews|approval|approvals|tests?|checks?|validation|sign ?off)\s+(?:is\s+|are\s+)?(?:not|never)\s+(?:needed|required|necessary)\b/,
  /\bsafe to [a-z]+\b/,
];

/** A status or permission claim about the code or its review, anywhere in `text`. */
export function claimProblem(text: string): string | null {
  const t = wordsOf(text.normalize("NFKC")).join(" ");
  return CLAIMS.some((re) => re.test(t)) ? "status-claim" : null;
}

/** All gate cues for one string: clause starts (behavior only), modals, status words, markup, addressees, claims. */
export function gateCue(text: string, opts: { behavior: boolean }): boolean {
  if (opts.behavior && clauseStartCue(text)) return true;
  return statusCue(text) || markupCue(text) || addresseeCue(text) || claimProblem(text) !== null;
}

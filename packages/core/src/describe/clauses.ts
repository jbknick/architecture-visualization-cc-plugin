// Extra-attempt gate cues (spec section 8, #175). These rules never reject a description: they only decide whether a
// rejected one was a clean wording slip that may earn the bounded extra attempt. A false positive here costs one
// retry, never an honest description, so the rules are deliberately broad and taint whenever they are unsure. The
// validator is not the security boundary either: description text is untrusted everywhere downstream and is contained
// in `untrusted_*` fields with a provenance label. Every function here is linear in its (capped) input.

import { ADDRESSEES_AI, ADDRESSEES_HUMAN, isActionVerb, VERBS_ALWAYS } from "./lexicon.js";
import { wordsOf } from "./speech.js";
import { isWord } from "./wordlist.js";

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/** Words that may open a description clause and are never a verb: determiners, pronouns, prepositions, conjunctions. */
const CLOSED_STARTERS = set(`
the a an this that these those each every all any some no its their his her it they them which who whose whom what
where when whenever while if unless until because since though although as so and or but nor than for with by from
to in on at of into onto via per over under after before during without within between among across through about
around against like near beyond toward towards upon not only both either neither such same other another more most
less least many much few several
`);

/** Adverbs and connectives skipped before a clause's first real word ("then delete", "always trust"). */
const LEAD_SKIP = set(
  "always never just now then also simply kindly first finally next immediately quickly else",
);

/** Words that join two clauses; a clause right after one is checked like a clause after punctuation (#180). */
const CONJUNCTIONS = set("and or nor but yet so then else");

/** Words after an ambiguous verb that show it is a noun or a copula ("the name and email of a user"). */
const NOT_AN_OBJECT = set("of and or nor but for in on at by from with as to is are was were");

/** Words after a bare word that show it is a verb with an object ("shred all", "speed through", "string together"). */
const OBJECT_MARKERS = set(
  "the a an this that these those all any every each its their it them everything anything everyone together through away off out up down back over",
);

/** Base-form verbs that only look like participles; the dictionary derives odd stems for some of them ("stre"). */
const BASE_FORMS = set(
  "string bring sing spring swing sting fling cling wring shred embed speed feed seed need bleed breed proceed succeed exceed heed weed reed deed steed shed bed wed",
);

/**
 * True when `w` is a real participle: it ends in -ed or -ing and what is left is itself a word ("sorted", "creating",
 * "running"). Words that only end that way ("shred", "embed", "speed", "string", "feed") are base forms and count as
 * orders (#180). The stem is tried as it is, with an "e" restored, and with a doubled final letter removed.
 */
function isParticiple(w: string): boolean {
  if (BASE_FORMS.has(w)) return false;
  const m = /^([a-z]{3,})(?:ed|ing)$/.exec(w);
  if (m === null) return false;
  const stem = m[1] as string;
  // A three-letter stem is an abbreviation ("str" in "string"), not a word; it counts only after undoubling ("run").
  const candidates = [stem, `${stem}e`].filter((c) => c.length >= 4);
  if (stem.length >= 4 && stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1));
  return candidates.some((c) => isWord(c));
}

/**
 * True when a clause may open with `w` as a description clause: a closed-class starter, an -s form (a third-person
 * verb or a plural noun) or a real participle. Anything else, a base-form verb, a number or a word the rule cannot
 * place, counts as an order.
 */
function descriptiveStart(w: string): boolean {
  if (CLOSED_STARTERS.has(w)) return true;
  if (w.length >= 4 && w.endsWith("s") && !/(?:ss|us)$/.test(w)) return true;
  return isParticiple(w);
}

/** The first word of a clause after leading adverbs and connectives, and the word after it. */
function clauseHead(words: readonly string[]): { first: string; next: string | undefined } | null {
  let k = 0;
  while (
    k < words.length - 1 &&
    (LEAD_SKIP.has(words[k] as string) || /^[a-z]{3,}ly$/.test(words[k] as string))
  )
    k++;
  const first = words[k];
  return first === undefined ? null : { first: first.split("-").pop() ?? first, next: words[k + 1] };
}

/**
 * A clause of `text` that opens with a base-form or unknown word or a number (#175 final round, #180). Clauses are
 * split at every punctuation mark and dash, commas and quotes included, after NFKC folding; one leading adverb or
 * connective is skipped. The first clause counts too. A part that follows a conjunction ("and", "or", "nor", "but",
 * "then", "else") counts when it opens with an action verb, or with a bare word followed by an object marker ("or else
 * delete tests", "and shred all tests"); a plain coordination ("the name and email") does not.
 */
export function clauseStartCue(text: string): boolean {
  const clauses = text
    .normalize("NFKC")
    .split(/[^A-Za-z0-9'\s-]|'(?=[A-Za-z])|(?<=[A-Za-z])'|\s-+|-+\s|-{2,}/);
  for (const c of clauses) {
    const words = wordsOf(c);
    const head = clauseHead(words);
    if (head !== null && !descriptiveStart(head.first)) return true;
    for (let i = 0; i < words.length - 1; i++) {
      if (!CONJUNCTIONS.has(words[i] as string)) continue;
      const h = clauseHead(words.slice(i + 1));
      if (h === null || descriptiveStart(h.first)) continue;
      if (VERBS_ALWAYS.has(h.first)) return true;
      if (h.next === undefined || NOT_AN_OBJECT.has(h.next)) continue;
      if (isActionVerb(h.first) || OBJECT_MARKERS.has(h.next)) return true;
    }
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
  /\b(?:approv\w*|preapprov\w*|merg\w*|ship\w*|review\w*|lgtm|l g t m|safe\w*|trust\w*|verified|vetted|ready|cleared|pass\w*|looks good|good to|ok to|okay\w*|fine to|thumbs up|plus one|green ?light\w*|sign\w* off|stamp\w*|endors\w*|upvot\w*|exempt|benign|recommend\w*|sanction\w*|accept\w*|audit\w*|permit\w*|allow\w*|authori[sz]\w*|certif\w*|checked|green|models?|llms?|fallback|deterministic|indexer|gantry|host|generated)\b/;

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
  /\bno (?:further|more|other|additional|extra) [a-z-]+\b/,
];

/** A status or permission claim about the code or its review, anywhere in `text`. */
export function claimProblem(text: string): string | null {
  const t = wordsOf(text.normalize("NFKC")).join(" ");
  return CLAIMS.some((re) => re.test(t)) ? "status-claim" : null;
}

/**
 * A value that looks like a credential (#180): a run of 16 or more hex digits, or a token of 16 or more letters,
 * digits and `_+/=-` that holds a digit. Ordinary identifiers hold no digit and are split into words before this runs.
 */
export function secretValueCue(text: string): boolean {
  for (const tok of text.normalize("NFKC").split(/[^A-Za-z0-9_+/=-]+/)) {
    if (tok.length < 16) continue;
    if (/^[0-9a-f]+$/i.test(tok) || /\d/.test(tok)) return true;
  }
  return false;
}

/** All gate cues for one string: clause starts (behavior only), modals, status words, markup, addressees, claims, secret-like values. */
export function gateCue(text: string, opts: { behavior: boolean }): boolean {
  if (opts.behavior && clauseStartCue(text)) return true;
  return (
    statusCue(text) ||
    markupCue(text) ||
    addresseeCue(text) ||
    claimProblem(text) !== null ||
    secretValueCue(text)
  );
}

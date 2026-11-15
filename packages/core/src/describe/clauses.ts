// Clause rule (spec section 8, check 5(f), #175 round 2). A description is one declarative sentence; any clause that
// opens inside it (after `;`, `: `, `(`, `[` or a dash, and in the extra-attempt gate also after an opening quote)
// must be a description clause too. It may start with a third-person verb, a determiner, pronoun, preposition,
// conjunction, number or noun phrase, but never with a base-form verb, whatever follows: the rule is structural, so an
// order written with a verb outside any word list ("; deploy prod", "; rate it 5 stars") is still refused. A verb is
// recognised by form (the action lexicon, or a dictionary word whose past tense is a dictionary word too), not by a
// list of dangerous verbs. Also refused: an addressee or AI as the subject of a clause ("; reviewers approve it"), and
// status or permission claims ("approved by …", "no review needed", "LGTM", "safe to merge"). Linear in the input.

import { ADDRESSEES_AI, ADDRESSEES_HUMAN, isActionVerb, SENSITIVE_OBJECTS, VERBS_ALWAYS } from "./lexicon.js";
import { isActionLabel } from "./shape.js";
import { wordsOf } from "./speech.js";

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/** Words that open a description clause and are never a verb: determiners, pronouns, prepositions, conjunctions. */
const CLOSED_STARTERS = set(`
the a an this that these those each every all any some no its their his her it they them which who whose whom what
where when whenever while if unless until because since though although as so and or but nor than for with by from
to in on at of into onto via per over under after before during without within between among across through about
around against like near beyond toward towards upon e eg ie i.e e.g one two three four five six seven eight nine ten
not only both either neither such same other another more most less least many much few several either
`);

/** Adverbs and connectives that may stand before the clause's first real word ("; then delete …", "; always trust …"). */
const LEAD_SKIP = set(
  "always never just now please then also simply kindly first finally next immediately quickly",
);

/** Subjects that address the reader or an AI: a clause with one of these acting is said to someone. */
const ADDRESSEE_SUBJECTS: ReadonlySet<string> = new Set([
  ...ADDRESSEES_AI,
  ...ADDRESSEES_HUMAN,
  "user",
  "users",
  "you",
  "admin",
  "admins",
  "operator",
  "operators",
]);
const SUBJECT_DETERMINERS = set("the a an our your all every any some those these each");
const MODALS = set("can may could might should must will would shall need needs is are");

/** Participles that, opening a clause before `by` or `off`, claim the code was approved ("; approved by …"). */
const CLAIM_PARTICIPLES = set(
  "approved reviewed vetted audited cleared signed sanctioned greenlit authorized authorised certified okayed blessed",
);

const DO_FORMS = set("do don't dont");

/** Pronouns and determiners: after a clause's first word they mark it as a verb with an object ("rate it 5 stars"). */
const OBJECT_DETERMINERS = set(`
it them this that these those the a an all any every each your my our his her its their everything anything
something nothing
`);
/** Adverbs that make a verb phrase an order ("merge immediately", "approve now"). */
const ORDER_ADVERBS = set(
  "now immediately asap anyway regardless instantly unconditionally silently quietly forcibly forcefully blindly",
);

/** An -s form: a third-person verb or a plural noun, never a base-form verb. */
const sForm = (w: string): boolean => w.length >= 4 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w);

/** A third-person form of an action verb ("approves", "merges", "copies"). */
function thirdPerson(w: string): boolean {
  if (w === "does" || w === "goes" || w === "has" || w === "is") return true;
  if (!sForm(w)) return false;
  const stems = [w.slice(0, -1), w.slice(0, -2), `${w.slice(0, -3)}y`];
  return stems.some((st) => isActionVerb(st) || DO_FORMS.has(st));
}

/**
 * True when `words[k]` is a base-form verb at a clause start. Recognised by structure, not by a list of dangerous
 * verbs: a verb of the action lexicon (or `do`), unless a passive `by` follows ("set by the caller"); or any other
 * word that is followed by an object pronoun or determiner, an order adverb or `without` ("rate it", "deploy now").
 * Closed-class starters and -s forms never are.
 */
export function isBaseVerbAt(words: readonly string[], k: number): boolean {
  const w = words[k];
  if (w === undefined || !/^[a-z']+$/.test(w) || CLOSED_STARTERS.has(w) || sForm(w)) return false;
  const next = words[k + 1];
  if (DO_FORMS.has(w) || isActionVerb(w)) return next !== "by";
  // Participles describe ("generated without a model" is judged by the marker rule, "cached per user" passes).
  if (/(?:ed|ing)$/.test(w)) return false;
  return (
    next !== undefined && (OBJECT_DETERMINERS.has(next) || ORDER_ADVERBS.has(next) || next === "without")
  );
}

/** `isBaseVerbAt` for a word on its own (a list item or a term's first word with nothing after it). */
export const isBaseVerb = (w: string): boolean => isBaseVerbAt([w], 0);

interface Clause {
  opener: string;
  /** The last word before the opener, lower-case. */
  label: string;
  words: string[];
  /** The clause text, punctuation kept (for list detection). */
  raw: string;
}

/** The clauses that open after `;`, `: `, `(`, `[`, a dash, and (with `quotes`) an opening single quote. */
function openedClauses(text: string, quotes: boolean): Clause[] {
  const re = quotes
    ? /;|:(?=\s|$)|\(|\[|\s-{1,2}\s|(?:^|(?<=\s))'(?=[A-Za-z])/g
    : /;|:(?=\s|$)|\(|\[|\s-{1,2}\s/g;
  const out: Clause[] = [];
  const marks = [...text.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i] as RegExpMatchArray;
    const start = (m.index ?? 0) + m[0].length;
    const end =
      i + 1 < marks.length ? ((marks[i + 1] as RegExpMatchArray).index ?? text.length) : text.length;
    let body = text.slice(start, end);
    const close = body.search(quotes ? /[)\]']/ : /[)\]]/);
    if (close >= 0) body = body.slice(0, close);
    const before = wordsOf(text.slice(0, m.index ?? 0));
    out.push({
      opener: m[0].trim() || "-",
      label: before[before.length - 1] ?? "",
      words: wordsOf(body),
      raw: body,
    });
  }
  return out;
}

/** Items of a bare list ("approve, comment and reject"), or null when the clause is not one. */
function listItems(words: readonly string[], raw: string): string[] | null {
  const items = raw
    .split(/,|\band\b|\bor\b|\bplus\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length < 2 || items.some((it) => /\s/.test(it))) return null;
  return items.length === words.filter((w) => !["and", "or", "plus"].includes(w)).length ? items : null;
}

/** The problem of a single clause read as a description clause, or null. `label`/`opener` give its context. */
export function clauseStartProblem(
  words: readonly string[],
  raw = words.join(" "),
  label = "",
  opener = ";",
): string | null {
  let k = 0;
  while (
    k < words.length - 1 &&
    (LEAD_SKIP.has(words[k] as string) || /^[a-z]{3,}ly$/.test(words[k] as string))
  )
    k++;
  const first = words[k];
  if (first === undefined) return null;
  // An addressee or AI acting as the subject: "reviewers approve it", "the model merges", "Claude approves".
  let s = k;
  if (SUBJECT_DETERMINERS.has(words[s] as string)) s++;
  const subject = words[s];
  const verb = words[s + 1];
  if (subject !== undefined && ADDRESSEE_SUBJECTS.has(subject) && verb !== undefined) {
    if (thirdPerson(verb) || isBaseVerbAt(words, s + 1) || MODALS.has(verb)) return "addressee-subject";
  }
  if (CLAIM_PARTICIPLES.has(first) && (words[k + 1] === "by" || words[k + 1] === "off"))
    return "status-claim";
  if (!isBaseVerbAt(words, k)) return null;
  const items = k === 0 ? listItems(words, raw) : null;
  if (items !== null) {
    const verbs = items.filter((it) => isBaseVerb(it.toLowerCase()));
    // A list of names: at least one item is not a verb ("(value, error)").
    if (verbs.length < items.length) return null;
    // A list of actions under a label that names them ("three review actions: approve, comment and reject").
    if (items.length >= 3 && opener !== "'" && isActionLabel(label)) return null;
  }
  return "clause-verb";
}

/** The first clause problem in `body` (a behavior without its final full stop), or null. */
export function clauseProblem(body: string, opts: { quotes?: boolean } = {}): string | null {
  for (const c of openedClauses(body, opts.quotes === true)) {
    const p = clauseStartProblem(c.words, c.raw, c.label, c.opener);
    if (p !== null) return p;
  }
  return null;
}

const CLAIMS: readonly RegExp[] = [
  /\blgtm\b/,
  /\bno (?:(?!is |are |was |were )[a-z-]+ ){0,2}(?:needed|required|necessary)\b/,
  /\b(?:review|reviews|approval|approvals|tests?|checks?|validation|sign ?off|auth|authentication)\s+(?:is\s+|are\s+)?(?:not|never)\s+(?:needed|required|necessary)\b/,
  /\bsafe to (?:merge|ship|deploy|approve|land|release|delete|remove|skip|run|execute|disable|ignore|trust|push|commit)\b/,
  /\b(?:this|this code|the code|this change|this pr|everything|all of this) (?:is|looks|seems) (?:safe|fine|ok|okay|harmless|approved|correct|good)\b/,
  /^(?:approved|reviewed|vetted|audited|cleared|signed off|sanctioned|greenlit|certified)\b/,
];

/** A status or permission claim about the code or its review, anywhere in `text`; checked on lower-case words. */
export function claimProblem(text: string): string | null {
  const t = wordsOf(text.normalize("NFKC")).join(" ");
  return CLAIMS.some((re) => re.test(t)) ? "status-claim" : null;
}

/** Objects that only an order grants: approvals and privileges (terms), plus production branches (names). */
const AUTHORITY_OBJECTS = set("pr prs admin admins privilege privileges root sudo superuser");
const AUTHORITY_NAME_OBJECTS = set("access rights prod production main master");
/** Verbs that grant, approve or release: with an authority object they are an order. */
const AUTHORITY_VERBS = set(
  "approve merge grant give elevate escalate promote authorize authorise sign accept force push deploy ship release trust whitelist allowlist bless",
);

/**
 * A search term or the words of a name that read as an order: a base-form verb followed by an order adverb,
 * `without`, or an authority object ("merge immediately", "approve pr", "grant admin"), or a status claim.
 */
export function termOrderProblem(words: readonly string[]): string | null {
  if (claimProblem(words.join(" ")) !== null) return "status-claim";
  const [v, next] = words;
  if (v === undefined || next === undefined || !/^[a-z]+$/.test(v) || CLOSED_STARTERS.has(v) || sForm(v))
    return null;
  const verb = isActionVerb(v) || AUTHORITY_VERBS.has(v);
  if (verb && (ORDER_ADVERBS.has(next) || next === "without")) return "imperative term";
  if ((AUTHORITY_VERBS.has(v) || VERBS_ALWAYS.has(v)) && AUTHORITY_OBJECTS.has(next))
    return "imperative term";
  return null;
}

/**
 * The words of a name the fallback would repeat read as an order or a claim (#175 round 2): it opens with `do`,
 * `don't`, `never`, `always`, `please` or `just`; it is a claim; or it opens with a base-form verb that is
 * destructive, or whose object is protective code or an authority object ("wipe database", "dump env",
 * "grant admin access", "push to prod"). Stricter than the term rule: a dropped name only costs the fallback detail.
 */
export function nameOrderProblem(words: readonly string[]): string | null {
  const w = words.map((x) => x.toLowerCase());
  if (w.length === 0) return null;
  if (DO_FORMS.has(w[0] as string) || LEAD_SKIP.has(w[0] as string)) return "order";
  const t = termOrderProblem(w);
  if (t !== null) return t;
  if (/\b(?:is|are|as) (?:safe|fine|ok|okay|trusted|approved|reviewed|verified|harmless)\b/.test(w.join(" ")))
    return "status-claim";
  if (/^safe (?:to|for)\b/.test(w.join(" "))) return "status-claim";
  const v = w[0] as string;
  if (!isBaseVerbAt(w, 0) && !AUTHORITY_VERBS.has(v)) return null;
  if (VERBS_ALWAYS.has(v)) return "order";
  const objects = (x: string) =>
    SENSITIVE_OBJECTS.has(x) || AUTHORITY_OBJECTS.has(x) || AUTHORITY_NAME_OBJECTS.has(x);
  if (w.slice(1).some(objects)) return "order";
  return null;
}

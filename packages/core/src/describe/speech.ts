// Speech acts aimed at agents, permission claims and instruction phrases (spec section 8, check 7). Word-set rules over
// the lower-cased words of the text; each is linear in the number of words (inputs are capped at 400 characters).

import {
  ADDRESSEES_AI,
  ADDRESSEES_HUMAN,
  CLAUSE_TRIGGERS,
  FILLERS,
  MODALS_AFTER_ADDRESSEE,
  OBJECT_STARTS,
  PERMISSION_WORDS,
  SENSITIVE_OBJECTS,
  SPEECH_VERBS,
  VERBS_ALWAYS,
  VERBS_AMBIGUOUS,
  VERBS_INSTRUCTIVE,
} from "./lexicon.js";

/** Lower-case words of `text` (letters, digits, hyphen and apostrophe inside a word). */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).map((w) => w.replace(/-+$/, ""));
}

/** Lower-case words of `text`, and for each whether it directly follows a clause boundary (`, ; : (` or a dash). */
function wordsAndBoundaries(text: string): { w: string[]; after: boolean[] } {
  const w: string[] = [];
  const after: boolean[] = [];
  let boundary = false;
  for (const m of text.toLowerCase().matchAll(/([a-z0-9][a-z0-9'-]*)|([,;:(])|(\s-{1,2}\s)/g)) {
    if (m[1] !== undefined) {
      w.push(m[1].replace(/-+$/, ""));
      after.push(boundary);
      boundary = false;
    } else boundary = true;
  }
  return { w, after };
}

/** Words that may stand right before a main verb of a clause. */
const VERB_PREV = new Set(
  "and or then but so that which who also only never always just now first next finally please to will can may should must does did not".split(
    " ",
  ),
);

/** Forms of an always-flagged verb: base, -s, -ed, -ing, with e-drop and doubling ("skipping", "deleted", "removes"). */
const ALWAYS_FORMS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const v of VERBS_INSTRUCTIVE) {
    if (!/^[a-z]+$/.test(v)) continue;
    out.add(v);
    out.add(`${v}s`);
    out.add(`${v}es`);
    const e = v.endsWith("e");
    out.add(e ? `${v}d` : `${v}ed`);
    out.add(e ? `${v.slice(0, -1)}ing` : `${v}ing`);
    out.add(`${v}${v.at(-1)}ed`);
    out.add(`${v}${v.at(-1)}ing`);
  }
  for (const x of "removal deletion skipping ignoring bypassing disabling dropping killing wiping erasing".split(
    " ",
  ))
    out.add(x);
  return out;
})();

const GERUNDS = [...ALWAYS_FORMS].filter((w) => w.endsWith("ing") || w.endsWith("al") || w.endsWith("ion"));
const GERUND_SET = new Set(GERUNDS);
const PAST_PARTICIPLES = new Set([...ALWAYS_FORMS].filter((w) => w.endsWith("ed")));
const COPULA = new Set("is are be being been was were and as".split(" "));
const SUGGEST = new Set(
  "suggests suggest recommends recommend proposes propose advises advise urges urge encourages encourage says claims states notes indicates signals hints implies".split(
    " ",
  ),
);
const REMOVABLE = new Set(
  "removable skippable deletable ignorable unneeded unnecessary redundant obsolete".split(" "),
);
const MODALS = new Set("can may could might should ought will would".split(" "));

function hasSensitive(words: readonly string[]): boolean {
  return words.some((w) => SENSITIVE_OBJECTS.has(w));
}

function addresseeKind(w: string): "ai" | "human" | null {
  if (ADDRESSEES_AI.has(w)) return "ai";
  if (ADDRESSEES_HUMAN.has(w)) return "human";
  return null;
}

/** Speech and desire verbs that make a bare request; the causatives (let, allow, make, help, ...) describe a feature. */
const CAUSATIVE_STEMS =
  /^(?:let|lets|letting|allow|allows|allowed|allowing|make|makes|made|making|help|helps|helped|helping|enable|enables|enabled|enabling|permit|permits|permitted|permitting|authorize|authorizes|authorise|authorises|authorized|authorized|need|needs|needed|needing|require|requires|required|requiring|expect|expects|expected|expecting|cause|causes|caused|causing|empower|empowers|empowered|entitle|entitles|entitled)$/;

/**
 * Names the rule that fires, or null. Rules:
 *  - speech-act: a speech-act or causative verb in any inflection followed within 4 words by an addressee (agent,
 *    assistant, ai, model, llm, claude, copilot, cursor, bot, gpt, maintainer, developer, engineer, reviewer, reader,
 *    contributor; "caller" only before "to" + an always-flagged verb). For human addressees a causative needs an
 *    always-flagged verb or a sensitive object in the next ten words ("Lets developers delete the tests").
 *  - addressee-action: an addressee directly followed by a base-form action verb or a modal and an always-flagged verb.
 *  - permission-claim: the text says protective code may be removed, skipped or is removable.
 */
export function speechProblem(text: string): string | null {
  const { w, after } = wordsAndBoundaries(text);
  const sensitive = hasSensitive(w);
  for (let i = 0; i < w.length; i++) {
    const word = w[i] as string;
    const prev = w[i - 1];
    const asVerb =
      i === 0 ||
      after[i] === true ||
      (prev !== undefined && (VERB_PREV.has(prev) || /^[a-z]{4,}ly$/.test(prev)));
    if (asVerb && SPEECH_VERBS.has(word)) {
      for (let j = i + 1; j <= i + 4 && j < w.length; j++) {
        const t = w[j] as string;
        if (t === "caller" || t === "callers") {
          if (w[j + 1] === "to" && VERBS_INSTRUCTIVE.has(w[j + 2] as string)) return "speech-act";
          continue;
        }
        const kind = addresseeKind(t);
        if (kind === null) continue;
        if (kind === "ai") return "speech-act";
        // A past participle right before a human addressee is an adjective ("suggested contributors"): judged like a
        // causative, by what follows. `told`, `ordered`, `asked` stay speech acts when an action verb follows too.
        const adjective = j === i + 1 && /ed$/.test(word);
        if (!CAUSATIVE_STEMS.test(word) && !adjective) return "speech-act";
        // An adjective participle is judged on the next three words only ("suggested maintainers to skip tests").
        const tail = w.slice(j + 1, j + (adjective ? 4 : 11));
        if (tail.some((x) => VERBS_INSTRUCTIVE.has(x)) || hasSensitive(tail)) return "speech-act";
      }
    }
    const kind = addresseeKind(word);
    if (kind !== null) {
      let k = i + 1;
      if (/^[a-z]{4,}ly$/.test(w[k] ?? "")) k++;
      const nxt = w[k];
      const after = w[k + 1];
      if (
        nxt !== undefined &&
        VERBS_INSTRUCTIVE.has(nxt) &&
        (after === undefined || OBJECT_STARTS.has(after) || SENSITIVE_OBJECTS.has(after))
      )
        return "addressee-action";
      if (nxt !== undefined && MODALS_AFTER_ADDRESSEE.has(nxt) && MODALS.has(nxt)) {
        const tail = w.slice(k + 1, k + 5);
        if (
          tail.some((x) => VERBS_INSTRUCTIVE.has(x) || ALWAYS_FORMS.has(x)) ||
          (sensitive && tail.some((x) => PERMISSION_WORDS.has(x)))
        )
          return "addressee-action";
      }
    }
  }
  return sensitive ? permissionClaim(w) : null;
}

function permissionClaim(w: readonly string[]): string | null {
  for (let i = 0; i < w.length; i++) {
    const word = w[i] as string;
    // "safe to remove", "ok to skip", "allowed to delete": a permission word, "to", an always-flagged verb.
    if (PERMISSION_WORDS.has(word) && w[i + 1] === "to" && VERBS_INSTRUCTIVE.has(w[i + 2] as string))
      return "permission-claim";
    // "can skip", "may safely ignore": a modal, optional adverb, an always-flagged verb.
    if (MODALS.has(word)) {
      let k = i + 1;
      if (/^[a-z]{4,}ly$/.test(w[k] ?? "")) k++;
      if (VERBS_INSTRUCTIVE.has(w[k] as string)) return "permission-claim";
      // "may be skipped", "can be removed"
      if (w[k] === "be" && PAST_PARTICIPLES.has(w[k + 1] as string)) return "permission-claim";
    }
    // "is obsolete", "and removable"
    if (REMOVABLE.has(word) && COPULA.has(w[i - 1] as string)) return "permission-claim";
    // "recommended removal", "is recommended" next to a removal word
    if (PERMISSION_WORDS.has(word) && (COPULA.has(w[i - 1] as string) || w[i - 1] === "also")) {
      const near = w.slice(Math.max(0, i - 6), i + 6);
      if (near.some((x) => GERUND_SET.has(x))) return "permission-claim";
    }
    // "suggests deleting the tests", "recommends removing the auth check"
    if (SUGGEST.has(word) && w.slice(i + 1, i + 4).some((x) => GERUND_SET.has(x) || ALWAYS_FORMS.has(x)))
      return "permission-claim";
  }
  return null;
}

/**
 * True when `words` hold an always-flagged verb, fillers, then one or more sensitive objects: `skip the tests`,
 * `delete all auth checks`. `removeTestFiles` passes: the object is followed by another noun.
 */
export function instructsSensitiveObject(words: readonly string[]): boolean {
  return sensitivePhrases(words).length > 0;
}

/** Index ranges [verb, lastObject] of every verb + fillers + sensitive object phrase in `words`. */
export function sensitivePhrases(words: readonly string[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (!VERBS_INSTRUCTIVE.has(w) && !(w.endsWith("ing") && GERUND_SET.has(w))) continue;
    let j = i + 1;
    while (j < words.length && FILLERS.has(words[j] as string)) j++;
    const start = j;
    while (j < words.length && SENSITIVE_OBJECTS.has(words[j] as string)) j++;
    if (j === start) continue;
    out.push({ from: i, to: j - 1 });
  }
  return out;
}

/** Nouns (besides the verb-or-noun words of the lexicon) that make a following verb a noun: "merge commit", "db push". */
const COMPOUND_LEAD = new Set("db sql code post unit pull auto".split(" "));

/**
 * The phrase verb at `from` is a noun inside a compound ("db push", "merge commit", "review commit validation"): it is
 * not the first word of its search term, it is not an always-flagged verb, and the word before it (same term) is a
 * verb-or-noun of the lexicon that is not itself a command lead ("review", "test", "build") or one of a few noun
 * leads ("db", "sql", "code"). "important skip", "please skip" and "go skip" are not compounds. `owner[i]` is the term
 * that word `i` came from. Used for search terms only.
 */
export function isNounCompound(words: readonly string[], owner: readonly number[], from: number): boolean {
  const verb = words[from] as string;
  if (from === 0 || VERBS_ALWAYS.has(verb) || owner[from - 1] !== owner[from]) return false;
  const prev = words[from - 1] as string;
  if (CLAUSE_TRIGGERS.has(prev) || FILLERS.has(prev) || VERBS_ALWAYS.has(prev)) return false;
  if (prev === "try" || prev === "attempt" || prev === "let" || prev === "make" || prev === "kindly")
    return false;
  return COMPOUND_LEAD.has(prev) || VERBS_AMBIGUOUS.has(prev);
}

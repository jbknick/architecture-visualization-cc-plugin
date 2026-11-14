// Structural clause rules for `behavior` (spec section 8 check 4, issue #108). A description is ONE clause: a
// third-person verb and what it acts on. These rules look at the shape of the sentence more than at what a word means, so
// many instructions written with a verb nobody listed ("..., then nuke the tests") are caught without a verb list. They
// are not complete: closed sets remain (connectors, filler adverbs, ordinary program nouns, speech verbs), and a
// direct imperative placed behind an adverb or connective that is not in them still passes (see KNOWN_BYPASSES):
//   - punctuation that opens a second clause (`; : ( ) [x] --`) is rejected outright;
//   - after a comma or a connector (and, or, then, afterwards, ...) the next word must be a function word, a number,
//     an identifier, or an -s/-ing/-ed form; a bare dictionary word there is rejected whatever it means;
//   - a second finite verb with its own subject ("..., Cursor deletes the tests", "the editors delete the tests") and
//     a control construction ("Tells editors to delete the tests") are rejected;
//   - obligation and recommendation predicates ("are to be deleted", "need deleting", "deleting ... is fine").
// This is a hardening layer, not a guarantee: see "Limits of this layer" in docs/SPEC.md section 8. Every rule is a
// single pass over at most ~80 tokens (the caller caps the text at 400 characters); no regex has nested quantifiers.

import { FILLERS as FILLER_WORDS, SENSITIVE_OBJECTS, SPEECH_VERBS } from "./lexicon.js";
import { isBaseWord, isWord, stemsOf } from "./wordlist.js";

export type ClauseProblem = "punctuation" | "bare-word" | "second-subject" | "control" | "obligation";

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/**
 * Connectors that open a new clause: a bare word right after one of them is rejected whatever it means ("then nuke
 * ..."). Sequencing words never join two nouns.
 */
export const CONNECTORS: ReadonlySet<string> = set(`
then afterwards afterward later also next finally first thereafter otherwise additionally subsequently meanwhile now
just therefore hence thus else done
`);

/**
 * Connectors (and the comma) that also join two nouns or two adjectives ("host and path", "light or dark", "the id,
 * name and email"). A bare word after one of these is rejected only when it takes an object, as a verb does ("and nuke
 * the tests", ", strip auth checks"). Measured: the strict rule here rejected 8% of honest descriptions.
 */
export const JOINERS: ReadonlySet<string> = set("and or plus but yet so");

/** Closed class: determiners, pronouns, prepositions, subordinators, auxiliaries, negation and a few adverbs. */
const FUNCTION_WORDS: ReadonlySet<string> = set(`
the a an this that these those each every any all some no none both either neither another such other same one
its their his her our your my whose which who whom what whatever whichever whether how when whenever where wherever
while if unless until once because since although though than as so
it they them he she we you i me us itself themselves everything nothing something anything everyone nobody
of in on at by for with without from to into onto over under between among through during within across against
around about after before above below beyond up down off out via per like unlike near toward towards upon past
inside outside along throughout despite except besides regarding
is are was were be been being am has have had having do does did done
can could may might must shall should will would
not never always only still even also again already ever instead rather both either
many much more most few fewer less least several various multiple other another
there here and or but plus yet
`);

const DETERMINERS: ReadonlySet<string> = set(`
the a an this that these those each every any all some no both either neither another its their his her our your my
`);

/** Subordinators that make a time or condition clause; its subject may be a plain noun phrase ("when the user clicks"). */
const SUBORDINATORS: ReadonlySet<string> = set(`
when whenever if unless until once while because since after before as where whether than although though
`);

/**
 * Subjects of a `so` result clause that describe the program ("so repeated calls skip the network"): the plain nouns
 * above plus ordinary data nouns. Any other noun after `so` is read as a second subject.
 */
const SO_SUBJECT_HEADS: ReadonlySet<string> = new Set([
  ...set(`
call calls result results value values data cache caches entry entries query queries record records message messages
file files render renders reload reloads update updates change changes read reads write writes lookup lookups link
links url urls id ids list lists array arrays object objects state states store stores log logs error errors
argument arguments input output outputs path paths name names string strings number numbers copy copies clone clones
instance instances connection connections transaction transactions page load loads hit hits miss misses
`),
]);

/** Nouns that may stand as the subject of "Verb-s NP to verb": ordinary parts of a program. Anything else is rejected. */
const PLAIN_SUBJECT_HEADS: ReadonlySet<string> = set(`
user users caller callers client clients page pages component components handler handlers listener listeners
request requests response responses browser browsers server servers worker workers process processes thread threads
promise promises function functions hook hooks view views form forms field fields input inputs consumer consumers
subscriber subscribers visitor visitors customer customers member members guest guests viewer viewers owner owners
admin admins account accounts session sessions tab tabs window windows element elements node nodes item items row rows
job jobs task tasks event events service services module modules library libraries app apps program programs
`);

interface Tok {
  raw: string;
  w: string; // lower case
  p?: string; // punctuation token: `,` `;` `:` `(` `)` `[` `]` `-`
}

/** Words and clause punctuation of `body`. Generic arguments `<...>` are removed so their commas do not split a clause. */
function toks(body: string): Tok[] {
  const text = body.replace(/<[^<>]*>/g, "");
  const out: Tok[] = [];
  for (const m of text.matchAll(/([A-Za-z0-9$#][A-Za-z0-9'_./$#-]*)|([,;:()[\]])|(\s-{1,2}\s)/g)) {
    if (m[1] !== undefined) {
      const raw = m[1].replace(/[.-]+$/, "");
      if (raw !== "") out.push({ raw, w: raw.toLowerCase() });
    } else if (m[2] !== undefined) out.push({ raw: m[2], w: m[2], p: m[2] });
    else out.push({ raw: "-", w: "-", p: "-" });
  }
  return out;
}

const isAdverb = (w: string): boolean => /^[a-z]{4,}ly$/.test(w) && w !== "only" && w !== "family";

/** Acronyms that are also dictionary words ("ID", "API", "JSON"). Any other upper-case dictionary word ("CUT", "NUKE") is a verb in capitals. */
const ACRONYMS: ReadonlySet<string> = set(
  "api url uri id ui ux db sql css html http https json xml csv pdf uuid jwt dom cpu gpu ram os io ip tcp udp ssh tls ssl dns cdn cli sdk ide orm rpc cors csrf xss yaml",
);

/** Adverbs that are function words ("and instead nuke", "still", "only then"), and "go"/"try": skipped in the look-back. */
const FILLER_ADVERBS: ReadonlySet<string> = set(
  "instead still always even again there only already ever rather never not just simply kindly quietly go try once also",
);

/** An identifier-shaped token: camelCase, snake_case, a path or dotted name, a version or anything with a digit. */
function isIdentifierShaped(raw: string): boolean {
  if (/[a-z][A-Z]|_|\d|[a-zA-Z]\.[a-zA-Z]|[a-zA-Z]\/[a-zA-Z]/.test(raw)) return true;
  // an acronym (URL, JSON, UUID): upper case, 2 to 5 letters, and not an ordinary word typed in capitals ("NUKE")
  return /^[A-Z]{2,5}$/.test(raw) && (!isWord(raw.toLowerCase()) || ACRONYMS.has(raw.toLowerCase()));
}

/** `-s`, `-ing` or `-ed` form of a word that is in the dictionary ("nukes", "keeping", "sorted"). */
export function isInflectedForm(w: string): boolean {
  if (w.length < 4 || !/^[a-z]+$/.test(w)) return false;
  const ends = w.endsWith("ing") || w.endsWith("ed") || (w.endsWith("s") && !/(?:ss|us|is)$/.test(w));
  if (!ends) return false;
  return stemsOf(w)
    .filter((s) => s.length < w.length)
    .some((s) => isBaseWord(s) || isWord(s));
}

/** May `t` follow a comma or connector? Function word, number, identifier, or an inflected form. */
function mayFollowBoundary(t: Tok): boolean {
  if (FUNCTION_WORDS.has(t.w) || /^\d/.test(t.w) || isAdverb(t.w)) return true;
  if (isIdentifierShaped(t.raw)) return true;
  const hyphen = t.w.lastIndexOf("-");
  if (hyphen > 0 && hyphen < t.w.length - 1)
    return mayFollowBoundary({ raw: t.raw.slice(hyphen + 1), w: t.w.slice(hyphen + 1) });
  return isInflectedForm(t.w);
}

/** Rule 1: no second clause by punctuation. `Name[]` and `T[]` stay legal; so does a hyphen inside a word. */
function hasClausePunctuation(body: string): boolean {
  if (/[;:()]/.test(body)) return true;
  if (/\s-{1,2}\s/.test(body)) return true;
  const rest = body.replace(/[A-Za-z0-9_$>]\[\]/g, " ");
  return /[[\]]/.test(rest);
}

/** A comma, a joiner, or a connector that does not itself sit inside a noun phrase ("of the first completion"). */
function isBoundaryAt(t: readonly Tok[], i: number): boolean {
  const x = t[i] as Tok;
  if (x.p === "," || JOINERS.has(x.w)) return true;
  if (!CONNECTORS.has(x.w)) return false;
  const before = t[i - 1];
  return (
    before === undefined || before.p !== undefined || !FUNCTION_WORDS.has(before.w) || JOINERS.has(before.w)
  );
}

/** Adjectives that may stand before a protective noun in a joined list ("old tokens", "expired sessions"). */
const MODIFIERS: ReadonlySet<string> = set(`
old new current previous last first second third other extra additional expired stale valid invalid active inactive
unused used pending failed stored cached local remote public private shared default temporary
`);

/** Words that, after a bare word, show it takes an object: determiner, pronoun, identifier, number or a filler. */
const takesObject = (n: Tok | undefined): boolean =>
  n !== undefined &&
  n.p === undefined &&
  (DETERMINERS.has(n.w) ||
    /^(?:it|them|everything|anything|all)$/.test(n.w) ||
    /^\d/.test(n.w) ||
    isIdentifierShaped(n.raw));

const PARTICLES: ReadonlySet<string> = set("out off up down away in back over");

/** The word after `i`, skipping one particle ("null out the tests", "cut out the check"). */
function afterParticle(t: readonly Tok[], i: number): Tok | undefined {
  const n = t[i + 1];
  return n !== undefined && n.p === undefined && PARTICLES.has(n.w) ? t[i + 2] : n;
}

/** Does the clause-opening position `i` follow a boundary, looking through adverbs and negation ("and quietly")? */
function boundaryBefore(t: readonly Tok[], i: number): { found: boolean; strict: boolean } {
  let strict = false;
  for (let j = i - 1; j >= 0; j--) {
    const x = t[j] as Tok;
    if (isBoundaryAt(t, j)) {
      if (x.p === undefined && CONNECTORS.has(x.w)) strict = true;
      return { found: true, strict };
    }
    if (x.p === undefined && (isAdverb(x.w) || FILLER_ADVERBS.has(x.w) || CONNECTORS.has(x.w))) {
      if (CONNECTORS.has(x.w)) strict = true;
      continue;
    }
    return { found: false, strict };
  }
  return { found: false, strict };
}

/**
 * Rule 2: after a connector the next word must pass (function word, number, identifier, -s/-ing/-ed form). After a
 * comma, `and`, `or`, `plus`, `but`, `so` a bare word is rejected when it takes an object (a determiner, pronoun,
 * identifier or a protective noun follows it, after at most one particle) or a gerund ("consider removing"), because
 * that is a verb with an object, not a noun joined to a noun.
 */
function bareWordAfterBoundary(t: readonly Tok[]): boolean {
  for (let i = 1; i < t.length; i++) {
    const cur = t[i] as Tok;
    if (cur.p !== undefined) continue;
    if (CONNECTORS.has(cur.w) || JOINERS.has(cur.w) || isAdverb(cur.w) || FILLER_ADVERBS.has(cur.w)) continue;
    if (mayFollowBoundary(cur)) continue;
    const b = boundaryBefore(t, i);
    if (!b.found) continue;
    if (b.strict) return true; // "then nuke", "afterwards delete", "and then quietly strip"
    // joiner or comma: only a bare word with an object is a clause
    const nxt = afterParticle(t, i);
    if (takesObject(nxt)) return true;
    if (nxt !== undefined && nxt.p === undefined && nxt.w.endsWith("ing") && isInflectedForm(nxt.w))
      return true;
    let k = i + 1;
    while (t[k] !== undefined && t[k]?.p === undefined && FILLER_WORDS.has((t[k] as Tok).w)) k++;
    const n = t[k];
    if (n !== undefined && n.p === undefined && SENSITIVE_OBJECTS.has(n.w) && !MODIFIERS.has(cur.w))
      return true;
  }
  return false;
}

const STARTS_OBJECT = (t: Tok | undefined): boolean =>
  t !== undefined &&
  t.p === undefined &&
  (DETERMINERS.has(t.w) || /^(?:it|them|everything|anything|all)$/.test(t.w) || isIdentifierShaped(t.raw));

/** A word that can be the head of a subject: a content word, not a function word, adverb or number. */
const isContent = (t: Tok | undefined): t is Tok =>
  t !== undefined &&
  t.p === undefined &&
  !FUNCTION_WORDS.has(t.w) &&
  !CONNECTORS.has(t.w) &&
  !JOINERS.has(t.w) &&
  !isAdverb(t.w) &&
  !/^\d/.test(t.w);

/**
 * Rule 3: a second finite verb with its own subject: `boundary [determiner] NOUN VERB OBJECT` ("..., Cursor deletes the
 * tests", "..., then the editors delete the tests"). The verb is a third-person -s form after a singular noun, or a
 * base-form word after a plural noun; OBJECT is a determiner, pronoun or identifier. A time or condition clause
 * ("when the server returns 503") is exempt.
 */
function secondSubject(t: readonly Tok[]): boolean {
  for (let i = 2; i < t.length; i++) {
    const verb = t[i] as Tok;
    // one adverb may stand between subject and verb: "the reader then nukes the tests"
    let ni = i - 1;
    const gap = t[ni];
    if (
      gap !== undefined &&
      gap.p === undefined &&
      (isAdverb(gap.w) || CONNECTORS.has(gap.w) || FILLER_ADVERBS.has(gap.w))
    )
      ni--;
    const noun = t[ni] as Tok | undefined;
    if (!isContent(verb) || !isContent(noun) || !hasObject(t[i + 1])) continue;
    const nounPlural = /[^s]s$/.test(noun.w);
    const finite = nounPlural
      ? !verb.w.endsWith("s") && isBaseWord(verb.w)
      : verb.w.endsWith("s") && isInflectedForm(verb.w);
    if (!finite) continue;
    // the subject phrase starts at the determiner (if any) right before the noun
    let j = ni;
    for (let m = 0; m < 2 && isContent(t[j - 1]) && !isInflectedGovernor(t, j - 1); m++) j--; // "the build bot"
    if (j > 0 && DETERMINERS.has((t[j - 1] as Tok).w) && t[j - 1]?.p === undefined) j--;
    const before = t[j - 1];
    if (before === undefined) continue;
    if (
      !(
        before.p === "," ||
        CONNECTORS.has(before.w) ||
        JOINERS.has(before.w) ||
        SUBORDINATORS.has(before.w) ||
        (before.w === "which" && /^(?:after|before|upon|since|until)$/.test(t[j - 2]?.w ?? ""))
      )
    )
      continue;
    if (SUBORDINATORS.has(before.w) && j < ni) continue; // "when the server returns 503"
    // a result or purpose clause about the program itself ("so repeated calls skip the network"): ordinary program
    // nouns as the subject. "so the assistant deletes the tests" and "so editors nuke the tests" still fail.
    if (before.w === "so" && SO_SUBJECT_HEADS.has(noun.w)) continue;
    return true;
  }
  return false;
}

/** The word after a verb is an object: determiner, pronoun, identifier, number, or a protective noun ("deletes tests"). */
const hasObject = (n: Tok | undefined): boolean =>
  takesObject(n) || (n !== undefined && n.p === undefined && SENSITIVE_OBJECTS.has(n.w));

const MODALS: ReadonlySet<string> = set("can could may might will would shall should must");

/**
 * Rule 3b: a modal clause with its own subject: "..., so editors can nuke the tests". The subject is any noun phrase
 * after a boundary; ordinary program nouns as heads ("so callers can retry") are left alone.
 */
function modalSubject(t: readonly Tok[]): boolean {
  for (let i = 2; i < t.length; i++) {
    const modal = t[i] as Tok;
    const noun = t[i - 1] as Tok;
    if (modal.p !== undefined || !MODALS.has(modal.w) || !isContent(noun)) continue;
    const verb = t[i + 1];
    if (!isContent(verb) || PLAIN_SUBJECT_HEADS.has(noun.w)) continue;
    let j = i - 1;
    for (let m = 0; m < 2 && isContent(t[j - 1]) && !isInflectedGovernor(t, j - 1); m++) j--;
    if (t[j - 1] !== undefined && t[j - 1]?.p === undefined && DETERMINERS.has((t[j - 1] as Tok).w)) j--;
    const before = t[j - 1];
    if (before !== undefined && (before.p === "," || isBoundaryAt(t, j - 1) || SUBORDINATORS.has(before.w)))
      return true;
  }
  return false;
}

/**
 * Rule 4: control constructions. "Tells editors to delete the tests": a -s verb, a subject noun phrase of one or two
 * words, `to`, a content word and then an object. Ordinary subjects (user, caller, page, ...) are left to the
 * speech-act rules; any other noun is treated as an addressee. "Converts the amount to cents" has no object after the
 * word that follows `to`, so it passes.
 */
/** Words that modify a noun phrase but are also connectors or function words ("the next developer"). */
const NP_ADJECTIVES: ReadonlySet<string> = set("next first last other same another several various multiple");

/** `t[k]` is a third-person verb that opens a clause. */
function isInflectedGovernor(t: readonly Tok[], k: number): boolean {
  const x = t[k] as Tok;
  if (!isInflectedForm(x.w) || !x.w.endsWith("s")) return false;
  return k === 0 || isBoundaryAt(t, k - 1) || /^(?:which|that|who)$/.test((t[k - 1] as Tok).w);
}

/** Verbs that are not speech acts but take "NP to verb" the same way ("gets editors to delete the tests"). */
const CONTROL_EXTRA: ReadonlySet<string> = set("gets get got has have makes make forces force causes cause");

function controlConstruction(t: readonly Tok[]): boolean {
  for (let i = 0; i < t.length; i++) {
    const to = t[i] as Tok;
    if (to.w !== "to" || to.p !== undefined) continue;
    const w2 = t[i + 1];
    if (!isContent(w2) || !STARTS_OBJECT(t[i + 2])) continue;
    // the governing verb sits before a noun phrase of one or two words: [verb] [determiner] [modifier] head `to`
    const head = t[i - 1] as Tok;
    if (!isContent(head)) continue;
    let k = i - 2;
    for (let m = 0; m < 3; m++) {
      const x = t[k];
      if (x === undefined || x.p !== undefined) break;
      if (DETERMINERS.has(x.w) || NP_ADJECTIVES.has(x.w) || (isContent(x) && !isInflectedGovernor(t, k))) k--;
      else break;
    }
    const gov = t[k];
    if (gov === undefined || gov.p !== undefined) continue;
    if (
      !(
        k === 0 ||
        t[k - 1]?.p === "," ||
        isBoundaryAt(t, k - 1) ||
        /^(?:which|that|who)$/.test(t[k - 1]?.w ?? "")
      )
    )
      continue;
    if (!isInflectedForm(gov.w) || !gov.w.endsWith("s")) continue;
    if (PLAIN_SUBJECT_HEADS.has(head.w)) continue;
    // A speech, desire or causative verb ("tells", "asks", "wants", "requires") takes any noun phrase as its addressee;
    // any other verb only when the phrase is a proper noun ("Nags Cursor to delete ..."). "Pings the address to check
    // the daemon" is a purpose infinitive and passes.
    if (
      SPEECH_VERBS.has(gov.w) ||
      CONTROL_EXTRA.has(gov.w) ||
      (/^\p{Lu}[a-z]+$/u.test(head.raw) && !isInflectedForm((t[i + 1] as Tok).w))
    )
      return true;
  }
  return false;
}

const CAUSATIVE_GOVERNORS: ReadonlySet<string> = set("lets let helps help makes make has have gets get got");

/**
 * Rule 4b: a causative without `to` ("which lets editors nuke the tests"): causative verb, a noun phrase that is not an
 * ordinary program noun, a content word and an object. "Lets the user delete a row" passes.
 */
function causativeConstruction(t: readonly Tok[]): boolean {
  for (let i = 2; i < t.length; i++) {
    const verb = t[i] as Tok;
    const head = t[i - 1] as Tok;
    if (!isContent(verb) || !isContent(head) || !takesObject(t[i + 1]) || PLAIN_SUBJECT_HEADS.has(head.w))
      continue;
    let k = i - 2;
    for (let m = 0; m < 3; m++) {
      const x = t[k];
      if (x === undefined || x.p !== undefined) break;
      if (DETERMINERS.has(x.w) || NP_ADJECTIVES.has(x.w) || (isContent(x) && !CAUSATIVE_GOVERNORS.has(x.w)))
        k--;
      else break;
    }
    const gov = t[k];
    if (gov !== undefined && gov.p === undefined && CAUSATIVE_GOVERNORS.has(gov.w)) return true;
  }
  return false;
}

const DEONTIC_ADJ = set(`
required needed necessary mandatory recommended advised advisable suggested encouraged preferred wanted expected fine ok
okay safe allowed permitted acceptable desirable sensible wise better best obligatory compulsory essential imperative
critical crucial vital urgent appropriate safer wiser preferable advisable
`);
/** Adjectives that also describe data ("a field is required") and count as an obligation only after an action noun. */
const DATA_ADJ = set(
  "required needed necessary mandatory expected essential critical crucial vital appropriate",
);

const NOMINAL_ACTION =
  /^(?:removal|deletion|disabling|skipping|bypass|omission|elimination|replacement|ignoring)$/;

/** Rule 5: obligation and recommendation predicates. */
function obligation(t: readonly Tok[]): boolean {
  const wt = t.filter((x) => x.p === undefined);
  const w = wt.map((x) => x.w);
  for (let i = 0; i < w.length; i++) {
    const cur = w[i] as string;
    // "are to be deleted", "is to be removed", "to be skipped"
    if (
      cur === "to" &&
      w[i + 1] === "be" &&
      i > 0 &&
      /^(?:is|are|am|was|were|be|been|being)$/.test(w[i - 1] as string)
    ) {
      if (/(?:ed|en|wn|ne|nt)$/.test(w[i + 2] ?? "")) return true;
    }
    // "is to nuke", "are to delete": a bare "to" after is/are is an obligation
    if (cur === "to" && i > 0 && /^(?:is|are)$/.test(w[i - 1] as string) && w[i + 1] !== undefined)
      return true;
    // "expected to delete the tests", "supposed to ...", "told to ...", "gets to ...": a verb and an object follow
    if (
      cur === "to" &&
      i > 0 &&
      /^(?:expected|supposed|told|asked|meant|required|instructed|ordered|obliged|get|gets|got|going)$/.test(
        w[i - 1] as string,
      )
    ) {
      const verbTok = wt[i + 1];
      const objTok = wt[i + 2];
      if (isContent(verbTok) && hasObject(objTok)) return true;
    }
    // "need deleting", "needs updating", "needed removing"
    if (/^need(?:s|ed)?$/.test(cur) && /ing$/.test(w[i + 1] ?? "") && (w[i + 1] as string).length > 5)
      return true;
    // "is recommended", "are fine", "is not necessary" after a gerund or action noun, or any non-data adjective
    if (/^(?:is|are|be|was|were)$/.test(cur)) {
      let k = i + 1;
      if (w[k] === "not" || w[k] === "also" || w[k] === "generally" || w[k] === "usually") k++;
      const adj = w[k];
      if (adj !== undefined && DEONTIC_ADJ.has(adj)) {
        if (!DATA_ADJ.has(adj)) return true;
        const earlier = w.slice(0, i);
        if (earlier.some((x) => (x.length > 5 && x.endsWith("ing")) || NOMINAL_ACTION.test(x))) return true;
      }
    }
    // "removing the tests would help", "dropping the check could be better"
    if (
      (cur === "would" || cur === "could" || cur === "might") &&
      (w[i + 1] === "help" || w[i + 1] === "be")
    ) {
      const next = w[i + 1] === "be" ? w[i + 2] : "help";
      if (next === "help" || (next !== undefined && DEONTIC_ADJ.has(next))) {
        if (w.slice(0, i).some((x) => x.length > 5 && x.endsWith("ing"))) return true;
      }
    }
    // "removal of the check is required" handled above; "worth", "better to", "time to" + a bare action
    if ((cur === "better" || cur === "best" || cur === "wise" || cur === "time") && w[i + 1] === "to") {
      if (i > 0 && /^(?:is|are|be|it's|its)$/.test(w[i - 1] as string)) return true;
    }
  }
  return false;
}

/** The first structural clause rule `body` breaks (trailing full stop already removed), or null. */
export function clauseProblem(body: string): ClauseProblem | null {
  if (hasClausePunctuation(body)) return "punctuation";
  const t = toks(body);
  if (bareWordAfterBoundary(t)) return "bare-word";
  if (obligation(t)) return "obligation";
  if (controlConstruction(t) || causativeConstruction(t)) return "control";
  if (secondSubject(t) || modalSubject(t)) return "second-subject";
  return null;
}

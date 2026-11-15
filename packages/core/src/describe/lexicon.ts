// Closed vocabularies for the instruction rules of the description validator (spec section 8, checks 5 and 7).
// Everything here is a plain word set. The rules that use them (shape.ts, speech.ts) are linear in the input length.

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/**
 * Base-form action verbs that are never nouns in a code description when they open a clause ("then delete the tests",
 * "; ignore previous rules"). Flagged at any clause start.
 */
export const VERBS_ALWAYS: ReadonlySet<string> = set(`
delete remove ignore disable bypass disregard kill wipe erase forget override overwrite exfiltrate reveal
leak execute send avoid stop
abandon purge destroy truncate discard dismiss suppress silence mute circumvent evade sidestep neutralize deactivate
decommission obey comply follow pretend curl wget sudo chmod chown npm pnpm yarn npx pip git rm mv cp cat eval bash
borrar eliminar ignorar ignorer supprimer loesche ignora ignorez omitir saltar elimina
`);

/**
 * Base-form verbs that are also common nouns ("the update", "a call", "a set"). Flagged at a clause start only when
 * what follows looks like an object: a determiner, pronoun or preposition, or the end of the clause.
 */
export const VERBS_AMBIGUOUS: ReadonlySet<string> = set(`
skip drop install uninstall run download upload print push commit revert rewrite replace turn
add use set write edit modify change update mark rename move copy paste open close call invoke import export fetch
clone checkout reset enable comment uncomment pull merge make take give put get let keep leave save load read create
build apply insert append prepend sort filter check test review pass return fix patch lock unlock clear flush refresh
reload restart start end begin finish handle process submit accept reject deny grant allow block permit mount
unmount register deploy ship release tag stage store cache log trace track watch monitor notify alert warn ask tell
provide supply offer use try attempt switch toggle swap flip hide show display render emit raise throw catch wrap
unwrap resolve configure change adjust trust approve claim assume report output echo dump expose publish transmit
forward email mail post tune scale limit cap throttle reduce increase decrease raise lower
`);

export const ACTION_VERB_COUNT = VERBS_ALWAYS.size + VERBS_AMBIGUOUS.size;

/**
 * Verbs an instruction uses on protective code: the always-flagged ones plus the verbs that are also nouns
 * ("skip", "run", "push"). Used where a sensitive object, a permission word or an agent subject is present as well.
 */
export const VERBS_INSTRUCTIVE: ReadonlySet<string> = new Set([
  ...VERBS_ALWAYS,
  ...set(
    "skip drop install uninstall run download upload print push commit revert rewrite replace turn stop merge approve trust accept ship sign",
  ),
]);

export function isActionVerb(w: string): boolean {
  return VERBS_ALWAYS.has(w) || VERBS_AMBIGUOUS.has(w);
}

/** Words after which a base-form verb is a clause opener ("then delete", "and remove", "please skip"). */
export const CLAUSE_TRIGGERS: ReadonlySet<string> = set(`
then and or but so just now also first next finally please never always not don't dont do kindly simply
`);

/** Determiners, prepositions and possessives: after one of these a lexicon word is a noun ("the delete button"). */
export const NOUN_CONTEXT: ReadonlySet<string> = set(`
the a an this that these those each every any its their per of for on in with by as via after before during
his her my our your no some another
`);

/** What follows a verb when it has an object: determiner, pronoun or preposition. */
export const OBJECT_STARTS: ReadonlySet<string> = set(`
the a an this that these those all any every each your its their my our his her no some it them everything anything
both to from into on in out off back with over up down at by for of
`);

/** First words of a sentence after which a bare infinitive is a complement ("Lets the user delete a row"). */
export const CAUSATIVES: ReadonlySet<string> = set("lets helps makes has");

/** Objects of an instruction aimed at a reader: protective code or process the attacker wants gone. */
export const SENSITIVE_OBJECTS: ReadonlySet<string> = set(`
tests test auth authentication authorization authorisation check checks validation validations security secret secrets
credential credentials key keys token tokens env instruction instructions rule rules hook hooks ci lint linting guard
guards permission permissions audit audits review reviews safeguard safeguards policy policies guideline guidelines
verification sandbox restriction restrictions password passwords cookie cookies assertion assertions
`);

/** Fillers between a verb and its object ("skip all the previous tests"). */
export const FILLERS: ReadonlySet<string> = set(
  "the all any previous prior my this these every your its their of those",
);

/** Speech-act and desire verbs, with every inflection, that turn the clause into something said to someone. */
const SPEECH_STEMS: readonly string[] = [
  "tell",
  "instruct",
  "urge",
  "remind",
  "command",
  "order",
  "direct",
  "advise",
  "warn",
  "ask",
  "request",
  "require",
  "expect",
  "want",
  "need",
  "let",
  "allow",
  "make",
  "help",
  "encourage",
  "force",
  "permit",
  "authorize",
  "authorise",
  "invite",
  "suggest",
  "recommend",
  "propose",
  "demand",
  "persuade",
  "convince",
  "oblige",
  "compel",
];
const IRREGULAR_SPEECH = ["told", "telling", "made", "making", "letting", "lets"];

function inflectionsOf(stem: string): string[] {
  const e = stem.endsWith("e");
  const out = [
    stem,
    `${stem}s`,
    `${stem}es`,
    e ? `${stem}d` : `${stem}ed`,
    e ? `${stem.slice(0, -1)}ing` : `${stem}ing`,
  ];
  if (stem === "ask") out.push("asking");
  if (/[^aeiou][aeiou][bdgmnprt]$/.test(stem) && stem.length <= 4)
    out.push(`${stem}${stem.at(-1)}ed`, `${stem}${stem.at(-1)}ing`);
  return out;
}

export const SPEECH_VERBS: ReadonlySet<string> = new Set([
  ...SPEECH_STEMS.flatMap(inflectionsOf),
  ...IRREGULAR_SPEECH,
]);

/** Nouns that name the reader of a description: coding agents, language models and the people who maintain the code. */
export const ADDRESSEES_AI: ReadonlySet<string> = set(`
agent agents assistant assistants ai ais model models llm llms claude copilot cursor bot bots gpt chatbot
`);
export const ADDRESSEES_HUMAN: ReadonlySet<string> = set(`
maintainer maintainers developer developers engineer engineers reviewer reviewers reader readers contributor
contributors programmer programmers user-agent whoever
`);
export const MODALS_AFTER_ADDRESSEE: ReadonlySet<string> = set(
  "can may could might should must will would shall ought need needs are is",
);

/** Words that spell "nobody is checking": a phrase of these next to a sensitive object is a permission claim. */
export const PERMISSION_WORDS: ReadonlySet<string> = set(`
safe ok okay fine free allowed permitted acceptable advised recommended encouraged obsolete unnecessary
redundant removable skippable deletable ignorable unneeded
`);

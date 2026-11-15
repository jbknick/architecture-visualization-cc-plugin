// Shape of a `behavior` sentence (spec section 8 check 5). Instead of banning phrases, the validator accepts only text
// that looks like a code description: one declarative sentence that starts with a third-person present-tense verb,
// in a restricted character set, with no second person, no deontic words and no labels or asides. Everything here is
// linear in the input length (the caller has already capped it at 400 characters).

import {
  CAUSATIVES,
  CLAUSE_TRIGGERS,
  isActionVerb,
  NOUN_CONTEXT,
  OBJECT_STARTS,
  SENSITIVE_OBJECTS,
  VERBS_ALWAYS,
  VERBS_INSTRUCTIVE,
} from "./lexicon.js";
import { tokenize } from "./text.js";
import { isBaseWord, isWord, stemsOf } from "./wordlist.js";

export type ShapeProblem =
  | "characters"
  | "multiple-sentences"
  | "label"
  | "long-aside"
  | "unbalanced"
  | "spaced-letters"
  | "first-word"
  | "addressing"
  | "imperative-clause";

/** Allowed in `behavior`: ASCII letters, digits, space and `, . ; ' - _ / ( ) < > [ ] $ : #` (the symbols serve grounded identifiers). */
const ALLOWED_CHARS = /^[A-Za-z0-9 ,.;'\-_/()<>[\]$:#]*$/;

/**
 * Verbs a code description starts with, in the third-person singular present ("Returns ...", "Fetches ..."). A positive
 * list: base forms ("Remove", "Use", "Install"), vocatives ("Claude,"), modal and pronoun starts and "Safe to ..." are
 * rejected because they are not in it. Add a verb here when honest descriptions are rejected for the first word.
 */
const VERB_TEXT = `
accepts adapts adds adjusts aggregates aligns allocates allows analyzes announces answers appends applies approves
archives asks assembles asserts assigns attaches attempts authenticates authorizes batches binds blocks boots
broadcasts buffers builds bundles calculates calls cancels captures chains checks chooses cleans clears clones closes
collapses collects colors combines commits compares compiles completes composes compresses computes concatenates
configures confirms connects consumes contains converts copies counts covers creates crops decodes decompresses
decorates decrypts defaults defers defines delays deletes denies derives describes deserializes destroys detects
determines disables discards dispatches displays disposes downloads drops dumps duplicates echoes edits emits enables
encodes encrypts ends enforces enqueues ensures enters escapes estimates evaluates exchanges excludes executes exits
expands expires exports exposes extends extracts fails falls fetches fills filters finalizes finds finishes fires fixes
flags flattens flushes focuses folds follows forces formats forwards frees gathers generates gets grants groups guards
handles hashes hides highlights holds hooks hydrates identifies ignores imports includes increments indents indexes
infers initializes injects inserts inspects installs instantiates intercepts invalidates inverts invokes isolates
iterates joins keeps kills labels launches lets limits links lists listens loads locates locks logs looks loops
lowercases maintains makes manages maps marks masks matches measures memoizes merges migrates mirrors mocks monitors
mounts moves multiplies navigates normalizes notifies observes opens orders orchestrates organizes overrides
overwrites packs pads paginates parses passes patches pauses performs persists picks pings places plays polls
populates posts prepares prefetches prepends presents prevents prints prioritizes probes processes produces projects
prompts propagates protects provides prunes publishes pulls purges pushes puts queries queues raises ranks reads
rebuilds recalculates receives reconciles reconnects records recovers redacts redirects reduces refreshes registers
rejects releases reloads removes renames renders reorders repeats replaces replays replies reports represents
requests requires rescales reserves resets resizes resolves responds restarts restores restricts resumes retains
retries retrieves returns reuses reveals reverses reverts reviews revokes rewrites rolls rotates rounds routes runs
samples sanitizes saves scales schedules scopes scrolls searches seeds selects sends serializes serves sets shapes
shares shifts shows shuts signals signs simulates skips slices sorts spawns splits spreads starts stops stores
streams stringifies strips submits subscribes substitutes sums supplies suppresses swaps switches synchronizes syncs
tags takes terminates tests throttles throws times toggles tokenizes tracks transforms translates traverses triggers
trims truncates tries turns unlocks unmounts unpacks unregisters unsubscribes unwraps updates upgrades uploads uses
validates verifies waits wakes walks warns watches wipes wraps writes yields zips
aborts narrows pages caches chunks clamps debounces deduplicates embeds forgets summarizes tells unlinks upserts
abbreviates accumulates acknowledges acquires activates adopts advances aliases amends annotates anonymizes
approximates arranges associates assumes attributes audits augments awaits balances bans bills blends boosts
borrows branches brings bumps bypasses calibrates canonicalizes categorizes centers certifies changes charges
classifies clips coalesces collates commands compacts conditions conflates constrains constructs contacts
correlates crawls curates customizes cuts declares decides declines decrements dedupes delegates delivers demotes
deploys depends deregisters designates detaches diffs digests disambiguates disconnects discovers dismisses
distributes divides documents dodges doubles drains draws drives ejects elides emails empties enacts
encapsulates enriches enumerates evicts exceeds exempts exists expects explains explores fabricates fans fences
fingerprints fits flips floors forks formulates freezes fulfills funnels fuses gates gives grabs guarantees halts
hands has hosts idles imposes improves indicates ingests inherits initiates inlines instructs integrates
interleaves interprets introduces invites is issues jumps kicks leaves lends levels leverages lifts lints lowers
mails mangles marshals materializes mediates mints modifies mutates names negotiates nests nudges obtains omits
onboards outputs overlays owns packages pairs paints parameterizes parks partitions pastes peeks pins pivots
plans plugs polishes pools pops precomputes predicts prefers prefixes previews primes proceeds profiles promotes
proposes proxies qualifies quotes rates reacts reassigns rebases recomputes reconstructs redeems redraws
reevaluates refetches refers reflects refuses regenerates rehydrates reindexes relays relies remembers reminds
renews reopens repairs replenishes reproduces rereads reschedules resends restructures rethrows retracts
revalidates rewinds rewraps salvages scans scrapes scrubs seals separates sequences settles shadows sheds shields
ships shortens shrinks silences simplifies sits snapshots solves spaces specifies spills spins stabilizes stacks
stages stamps standardizes stashes steps stitches stubs subtracts succeeds suggests supports surfaces suspends
sweeps tabulates tallies targets tears templates tethers threads thaws ticks tightens tolerates traces trails
transfers transitions transmits trashes treats tunnels unbinds undoes unifies unmarshals unwinds uppercases urges
utilizes versions vets visits voids votes warms weaves weighs widens wires withdraws yanks zeroes
needs becomes remains stays belongs differs acts accesses addresses asserts assesses authenticates backs bases
bounds buffers bills caches clamps commits compiles compresses copies decodes defers
`;

export const DESCRIPTION_VERBS: ReadonlySet<string> = new Set(VERB_TEXT.split(/\s+/).filter(Boolean));

/** Third-person forms that open a sentence but are never a description of code. */
const FIRST_WORD_BAN: ReadonlySet<string> = new Set(["pretends", "pretend"]);

/** Pronouns that are addressing only in this exact spelling, so "US dollars" and "I/O" stay legal. */
const CASE_SENSITIVE_PRONOUNS: ReadonlySet<string> = new Set([
  "us",
  "we",
  "i",
  "me",
  "our",
  "ours",
  "ourselves",
  "I",
]);

/** Second-person pronouns and deontic words. None has a place in a one-sentence behaviour description. */
const ADDRESSING_TEXT = `
you your yours yourself yourselves must should ought shall please todo fixme remember don't dont
`;
export const ADDRESSING_WORDS: ReadonlySet<string> = new Set(ADDRESSING_TEXT.split(/\s+/).filter(Boolean));

/** Multi-word addressing phrases (word-bounded, lower-case). */
const ADDRESSING_PHRASES = /\b(?:need to|needs to be|has to|have to|be sure|make sure)\b/;

/**
 * Words from the issue's list that were measured and dropped (spec section 8): "note", "warning" and "important" are
 * ordinary nouns and adjectives in honest descriptions ("a short memory note", "a warning toast"); each alone cost
 * about 0.4% of the honest corpus. "never" and "always" turned out common in real model output ("never blocking
 * rendering"): 5 of 200 real descriptions. "do not" is ordinary in honest text ("so reloads do not repeat the
 * message"). "my" is first-person only in prose, and appears in real search terms ("export my data"). "instead" is
 * ordinary ("... instead of removing the row"). The attacks they stood for ("Note: ...", "IMPORTANT: ...") are labels,
 * rejected by the label rule, or start with a non-verb, rejected by the first-word rule.
 */
export const ADDRESSING_DROPPED: readonly string[] = [
  "note",
  "warning",
  "important",
  "never",
  "always",
  "my",
  "do not",
  "instead",
];

/** A `should` right after one of these opens a new clause, so it is not part of a reported condition. */
const NEW_CLAUSE = new Set("and or but then so also just now".split(" "));

/** Addressing words and phrases in `text` (deduplicated). Second person and deontic words in any case; `us`, `we`, `i`, `me`, `our` only as written here. */
export function addressingHits(text: string): string[] {
  const hits: string[] = [];
  const tokens = tokenize(text);
  let lastWhether = -100;
  tokens.forEach((t, i) => {
    const low = t.toLowerCase();
    if (low === "whether") lastWhether = i;
    // "whether the sidebar should show": a reported condition, not an order. Only `should`, and only within eight
    // words of `whether`; `must`, `please`, `ought` and the second person stay addressing everywhere.
    if (low === "should" && i - lastWhether <= 8 && !NEW_CLAUSE.has((tokens[i - 1] ?? "").toLowerCase()))
      return;
    if ((ADDRESSING_WORDS.has(low) || CASE_SENSITIVE_PRONOUNS.has(t)) && !hits.includes(low)) hits.push(low);
  });
  const m = ADDRESSING_PHRASES.exec(text.toLowerCase().replace(/\s+/g, " "));
  if (m !== null && !hits.includes(m[0])) hits.push(m[0]);
  return hits;
}

export function hasDisallowedCharacters(s: string): boolean {
  return !ALLOWED_CHARS.test(s.normalize("NFKC"));
}

const MAX_ASIDE_WORDS = 6;

/**
 * First word of a description: a listed verb (fast path), or any third-person form (-s, -es, -ies) whose base form is
 * an English or programming word. Optionally after one adverb in -ly ("Strictly parses") or as `prefix-verb`
 * ("Deep-copies").
 */
function startsWithVerb(pieces: readonly string[]): boolean {
  let first = (pieces[0] ?? "").toLowerCase();
  if ((/^[a-z]{3,12}ly$/.test(first) || first === "always" || first === "never") && pieces.length > 1)
    first = (pieces[1] as string).toLowerCase();
  const hyphen = /^[a-z]{2,8}-([a-z]+)$/.exec(first);
  if (hyphen !== null) first = hyphen[1] as string;
  if (!/^[a-z]+$/.test(first) || FIRST_WORD_BAN.has(first)) return false;
  if (DESCRIPTION_VERBS.has(first)) return true;
  if (first === "does" || first === "goes") return true;
  if (first.length < 4 || !first.endsWith("s") || /(?:ss|us|is)$/.test(first)) return false;
  return stemsOf(first)
    .filter((s) => s.length < first.length)
    .some((s) => isBaseWord(s) || isWord(s));
}

// ---------------------------------------------------------------------------------------------------------------------
// Imperative clauses (check 5). A base-form action verb that starts a clause is an instruction: after `, ; : (` or a
// dash, or after then/and/or/but/so/just/now/also/first/next/finally/please/never/always/not/do ("then quietly
// delete"). Not an instruction: an infinitive ("to fetch and cache results"), a noun ("the delete button", "on update"),
// a complement of a causative first verb ("Lets the user delete a row"), or an item in a list of bare verbs
// ("(create, read, update, delete)").

type Item = { w: string; raw: string } | { p: string };

function itemsOf(text: string): Item[] {
  const out: Item[] = [];
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9'_./-]*)|(\s-{1,2}\s)|([,;:([])|([)\]])/g)) {
    if (m[1] !== undefined) out.push({ w: m[1].toLowerCase(), raw: m[1] });
    else if (m[2] !== undefined) out.push({ p: "-" });
    else if (m[3] !== undefined) out.push({ p: m[3] === "[" ? "(" : m[3] });
    else out.push({ p: ")" });
  }
  return out;
}

const isBoundary = (it: Item | undefined): boolean =>
  it !== undefined &&
  "p" in it &&
  (it.p === "," || it.p === ";" || it.p === ":" || it.p === "(" || it.p === "-");
const wordOf = (it: Item | undefined): string | undefined =>
  it !== undefined && "w" in it ? it.w : undefined;

const AUXILIARIES = new Set(
  "does did will would can could may might should is are was were has have had been be".split(" "),
);
const DO_FORMS = new Set(["do", "don't", "dont"]);

function isAdverb(w: string): boolean {
  return (/^[a-z]{4,}ly$/.test(w) && w !== "only" && w !== "family") || w === "simply" || w === "kindly";
}

/** Does the clause-opening position `i` hold a trigger (boundary, or a trigger word with at most one adverb between)? */
function isTriggerPosition(items: readonly Item[], i: number): boolean {
  let k = i - 1;
  if (isBoundary(items[k])) return true;
  let pw = wordOf(items[k]);
  if (pw !== undefined && isAdverb(pw)) {
    k--;
    if (isBoundary(items[k])) return true;
    pw = wordOf(items[k]);
  }
  if (pw === undefined || !CLAUSE_TRIGGERS.has(pw)) return false;
  // "do" and "not" after a subject are descriptive ("reloads do not repeat", "does not delete"); at a clause start they are not.
  if (pw === "not" || pw === "never" || pw === "always") {
    const before = wordOf(items[k - 1]);
    if (before !== undefined && AUXILIARIES.has(before)) return false;
    if (before !== undefined && DO_FORMS.has(before)) return isClauseStart(items, k - 1);
    return true;
  }
  if (DO_FORMS.has(pw)) return isClauseStart(items, k);
  return true;
}

/** Position `k` opens a clause: first item, or right after a boundary or a trigger word. */
function isClauseStart(items: readonly Item[], k: number): boolean {
  if (k <= 0) return true;
  if (isBoundary(items[k - 1])) return true;
  const w = wordOf(items[k - 1]);
  return w !== undefined && CLAUSE_TRIGGERS.has(w);
}

/** An earlier "to" in the same clause (no punctuation since) governs this verb: "to fetch and cache results". */
function governedByInfinitive(items: readonly Item[], i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const it = items[k] as Item;
    if ("p" in it) return false;
    if (it.w === "to") {
      const nxt = wordOf(items[k + 1]);
      return nxt !== undefined && !OBJECT_STARTS.has(nxt);
    }
  }
  return false;
}

/** The verb at `i` sits in a list of bare verbs: "(create, read, update, delete)", "edit, delete and cancel buttons". */
function inVerbList(items: readonly Item[], i: number): boolean {
  const next = items[i + 1];
  const nw = wordOf(next);
  const sepAfter =
    next === undefined ||
    (next !== undefined && "p" in next && (next.p === "," || next.p === ")")) ||
    nw === "and" ||
    nw === "or";
  if (!sepAfter) return false;
  let before = items[i - 1];
  if (before !== undefined && "p" in before && before.p === ",") before = items[i - 2];
  else if (wordOf(before) === "and" || wordOf(before) === "or") before = items[i - 2];
  else before = undefined;
  if (before !== undefined) {
    const bw = wordOf(before);
    if (bw !== undefined && isActionVerb(bw)) return true;
  }
  let after = items[i + 1];
  if (after !== undefined && "p" in after && after.p === ",") after = items[i + 2];
  else if (wordOf(after) === "and" || wordOf(after) === "or") after = items[i + 2];
  else after = undefined;
  const aw = wordOf(after);
  return aw !== undefined && isActionVerb(aw);
}

/** Finite verbs after which a lexicon word is a subject noun: "a confirmation or override was stored". */
const FINITE_AFTER_NOUN = new Set(
  "was were is are has have had will would can could may might does did".split(" "),
);
/** Nouns that form a compound with an ambiguous verb: "return policy", "retry guidelines". */
const PERMISSION_COMPLEMENT = new Set(
  "safe fine allowed ok okay approved permitted required advised recommended acceptable optional unnecessary redundant encouraged valid appropriate needed".split(
    " ",
  ),
);
/** Things `execute` may not take as its object after a bare list: it runs code ("execute scripts"). */
const EXECUTABLE_OBJECTS = new Set(
  "script scripts payload payloads shell code binary binaries program programs".split(" "),
);
const COMPOUND_HEADS = new Set("policy policies guideline guidelines".split(" "));

/** The word before `i` is a determiner, possessive or preposition, or `i` is the second item of a "noun and noun" list. */
function startsNounPhrase(items: readonly Item[], i: number, strict = false): boolean {
  const pv = wordOf(items[i - 1]);
  if (pv === undefined) return false;
  if (NOUN_CONTEXT.has(pv)) return true;
  if ((pv !== "and" && pv !== "or") || wordOf(items[i - 2]) === undefined) return false;
  // Strict (a subject noun): the first item of the list must itself follow a determiner or preposition.
  return !strict || NOUN_CONTEXT.has(wordOf(items[i - 3]) ?? "");
}

/** A protective object (tests, auth, checks, passwords, ...) appears before the next clause boundary. */
function protectiveAhead(items: readonly Item[], from: number): boolean {
  for (let k = from; k < items.length; k++) {
    const it = items[k] as Item;
    if ("p" in it) {
      if (it.p === ")") continue;
      return false;
    }
    if (SENSITIVE_OBJECTS.has(it.w)) return true;
  }
  return false;
}

/**
 * The verb at `i` is the subject of a finite verb ("a confirmation or override was stored"), or the last item of a
 * comma list of nouns that heads a plural noun ("audit, confirmation and override records"). Both are nouns. An object
 * start, a protective object or another action verb after it keeps it an instruction.
 */
function isNounUse(items: readonly Item[], i: number): boolean {
  const nw = wordOf(items[i + 1]);
  if (nw === undefined) return false;
  if (FINITE_AFTER_NOUN.has(nw)) {
    // A subject noun stands after a determiner, a possessive or a preposition, or in a noun list ("a confirmation or
    // override was stored"); after a clause opener ("then ignore is safe") it is a command. Protective code later in
    // the clause ("... is required for auth checks") keeps it a command too.
    // "ignore is safe", "bypass was approved": a verb said to be fine is a permission claim whatever stands before it.
    if (PERMISSION_COMPLEMENT.has(wordOf(items[i + 2]) ?? "")) return false;
    return startsNounPhrase(items, i, true) && !protectiveAhead(items, i + 1);
  }
  const sep = wordOf(items[i - 1]);
  const prevItem = items[i - 2];
  const listPunct = items[i - 3];
  if ((sep !== "and" && sep !== "or") || wordOf(prevItem) === undefined || !isCommaItem(listPunct))
    return false;
  if (isActionVerb(wordOf(prevItem) as string)) return false;
  if (OBJECT_STARTS.has(nw) || SENSITIVE_OBJECTS.has(nw) || isActionVerb(nw) || !nw.endsWith("s"))
    return false;
  const after = items[i + 2];
  return (
    after === undefined ||
    "p" in after ||
    OBJECT_STARTS.has(wordOf(after) as string) ||
    FINITE_AFTER_NOUN.has(wordOf(after) as string)
  );
}
const isCommaItem = (it: Item | undefined): boolean => it !== undefined && "p" in it && it.p === ",";

/** A word that reads as a verb right after `to`: "respond", "offer", "load" (a listed verb or the base of a listed -s form). */
function verbish(w: string): boolean {
  return (
    isActionVerb(w) ||
    DESCRIPTION_VERBS.has(`${w}s`) ||
    DESCRIPTION_VERBS.has(`${w}es`) ||
    (w.endsWith("y") && DESCRIPTION_VERBS.has(`${w.slice(0, -1)}ies`))
  );
}

/**
 * The verb at `i` ends a list of bare verbs that an earlier `to` governs: "helpers to offer, respond, load and
 * execute commands". Only comma, `and` and `or` stand between single words, the first of them reads as a verb, and
 * the verb is not followed by protective code ("to read, parse and delete the tests" stays an instruction).
 */
function governedByVerbList(items: readonly Item[], i: number): boolean {
  // Destructive and exfiltration verbs never hide in the last slot of a list ("to read, load and leak passwords");
  // `execute` is the one exception ("helpers to offer, load and execute commands").
  const last = wordOf(items[i]) as string;
  if (VERBS_ALWAYS.has(last) && last !== "execute") return false;
  if (last === "execute") {
    // Only with no object, or a bare plural noun that is not something runnable ("execute commands").
    const obj = wordOf(items[i + 1]);
    const after = wordOf(items[i + 2]);
    const noObject = items[i + 1] === undefined || "p" in (items[i + 1] as Item);
    if (!noObject) {
      if (obj === undefined || !obj.endsWith("s") || EXECUTABLE_OBJECTS.has(obj)) return false;
      if (after === "from" || after === "with" || after === "on") return false;
    }
  }
  let k = i - 1;
  let words = 0;
  let wantSeparator = true;
  while (k >= 0) {
    const it = items[k] as Item;
    if (wantSeparator) {
      const w = wordOf(it);
      if (!(("p" in it && it.p === ",") || w === "and" || w === "or")) return false;
      // ", and" counts as one separator
      if (isCommaItem(items[k - 1]) && (w === "and" || w === "or")) k--;
      wantSeparator = false;
      k--;
      continue;
    }
    const w = wordOf(it);
    if (w === undefined) return false;
    words++;
    const before = items[k - 1];
    if (wordOf(before) === "to") {
      if (!verbish(w)) return false;
      // A determiner or pronoun after the verb ("delete the rows") makes it a command with an object; a bare noun
      // ("execute commands") does not. Protective code after it ("delete tests") is always a command.
      const nxt = wordOf(items[i + 1]) ?? "";
      if (OBJECT_STARTS.has(nxt)) return false;
      return !SENSITIVE_OBJECTS.has(nxt);
    }
    if (words > 6) return false;
    wantSeparator = true;
    k--;
  }
  return false;
}

/** True when `text` holds an imperative clause. Linear in the length of `text`. */
export function hasImperativeClause(text: string): boolean {
  const items = itemsOf(text);
  const first = wordOf(items[0]);
  const causative = first !== undefined && CAUSATIVES.has(first);
  let punctSinceFirst = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    if ("p" in it) {
      if (i > 0) punctSinceFirst = true;
      continue;
    }
    // "Do not touch the auth check": a clause that opens with "do" is an instruction whatever its verb.
    if (i > 0 && DO_FORMS.has(it.w) && isClauseStart(items, i)) return true;
    if (i === 0 || !isActionVerb(it.w)) continue;
    if (!isTriggerPosition(items, i)) continue;
    const prev = wordOf(items[i - 1]);
    if (prev === "to" || (prev !== undefined && NOUN_CONTEXT.has(prev))) continue;
    if (causative && !punctSinceFirst) continue;
    if (governedByInfinitive(items, i) || governedByVerbList(items, i)) continue;
    if (inVerbList(items, i)) continue;
    if (VERBS_ALWAYS.has(it.w)) {
      if (isNounUse(items, i)) continue;
      return true;
    }
    const next = items[i + 1];
    const nw = wordOf(next);
    if (
      next === undefined ||
      (nw !== undefined &&
        (OBJECT_STARTS.has(nw) ||
          (SENSITIVE_OBJECTS.has(nw) &&
            !(COMPOUND_HEADS.has(nw) && !VERBS_INSTRUCTIVE.has(it.w) && startsNounPhrase(items, i))) ||
          VERBS_ALWAYS.has(nw)))
    )
      return true;
    // "then call fetchUser2": an identifier, path or number right after the verb is its object.
    if (next !== undefined && "raw" in next && /[a-z][A-Z]|_|\d|[./]/.test(next.raw)) return true;
  }
  return false;
}

/**
 * The first shape rule a `behavior` breaks, or null when it has the shape of a description. `text` is trimmed and
 * NFKC-folded here. Rules, in order: characters, one sentence (no second sentence, label, or long aside), no runs of
 * single letters, first word is a verb form, no addressing words, no imperative clause.
 */
export function shapeProblem(behavior: string): ShapeProblem | null {
  const text = behavior.normalize("NFKC").trim();
  if (hasDisallowedCharacters(text)) return "characters";

  const body = text.endsWith(".") ? text.slice(0, -1) : text;
  if (/\.(?:\s|\.|$)/.test(body)) return "multiple-sentences";
  // A comma with no space after it ("evil,com") spells a host without a dot; generics such as Map<K,V> are exempt.
  if (/,\S/.test(body.replace(/<[^<>]*>/g, ""))) return "characters";
  if (/^[A-Za-z]+\s*:/.test(body)) return "label";

  for (const open of ["(", "["] as const) {
    const close = open === "(" ? ")" : "]";
    const re = open === "(" ? /\(([^()]*)\)/g : /\[([^[\]]*)\]/g;
    let rest = body;
    for (const m of body.matchAll(re)) {
      if ((m[1] ?? "").trim().split(/\s+/).filter(Boolean).length > MAX_ASIDE_WORDS) return "long-aside";
      rest = rest.replace(m[0], " ");
    }
    if (rest.includes(open) || rest.includes(close)) return "unbalanced";
  }

  const pieces = body.split(/\s+/).filter(Boolean);
  let run = 0;
  for (const p of pieces) {
    run = /^[A-Za-z]$/.test(p) ? run + 1 : 0;
    if (run >= 3) return "spaced-letters";
  }

  if (!startsWithVerb(pieces)) return "first-word";
  if (addressingHits(text).length > 0) return "addressing";
  if (hasImperativeClause(body)) return "imperative-clause";
  return null;
}

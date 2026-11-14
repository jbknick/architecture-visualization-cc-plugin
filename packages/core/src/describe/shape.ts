// Shape of a `behavior` sentence (spec section 8 check 5). Instead of banning phrases, the validator accepts only text
// that looks like a code description: one declarative sentence that starts with a third-person present-tense verb,
// in a restricted character set, with no second person, no deontic words and no labels or asides. Everything here is
// linear in the input length (the caller has already capped it at 400 characters).

import { tokenize } from "./text.js";

export type ShapeProblem =
  | "characters"
  | "multiple-sentences"
  | "label"
  | "long-aside"
  | "unbalanced"
  | "spaced-letters"
  | "first-word"
  | "addressing";

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
aborts narrows pages caches chunks clamps debounces deduplicates embeds forgets pretends summarizes tells unlinks upserts
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

/** First- and second-person pronouns and deontic or addressing words. None has a place in a one-sentence behaviour description. */
const ADDRESSING_TEXT = `
you your yours yourself yourselves we our ours ourselves i me us
must should ought shall please todo fixme remember instead
don't dont
`;
export const ADDRESSING_WORDS: ReadonlySet<string> = new Set(ADDRESSING_TEXT.split(/\s+/).filter(Boolean));

/** Multi-word addressing phrases (word-bounded, lower-case). */
const ADDRESSING_PHRASES = /\b(?:need to|needs to be|has to|have to|be sure|make sure)\b/;

/**
 * Words from the issue's list that were measured and dropped (spec section 8): "note", "warning" and "important" are
 * ordinary nouns and adjectives in honest descriptions ("a short memory note", "a warning toast"); each alone cost
 * about 0.4% of the honest corpus. "never" and "always" turned out common in real model output ("never blocking
 * rendering"): 5 of 200 real descriptions. "do not" is ordinary in honest text ("so reloads do not repeat the message"). "my" is first-person only in prose, and appears in real search terms ("export my
 * data"). The attacks they stood for ("Note: ...", "IMPORTANT: ...") are labels, rejected by
 * the label rule, or start with a non-verb, rejected by the first-word rule.
 */
export const ADDRESSING_DROPPED: readonly string[] = ["note", "warning", "important", "never", "always", "my", "do not"];

/** Addressing words and phrases in `text` (lower-case, deduplicated). */
export function addressingHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const t of tokenize(lower)) if (ADDRESSING_WORDS.has(t) && !hits.includes(t)) hits.push(t);
  const m = ADDRESSING_PHRASES.exec(lower.replace(/\s+/g, " "));
  if (m !== null && !hits.includes(m[0])) hits.push(m[0]);
  return hits;
}

export function hasDisallowedCharacters(s: string): boolean {
  return !ALLOWED_CHARS.test(s.normalize("NFKC"));
}

const MAX_ASIDE_WORDS = 6;

/** Base-form verbs that must not open a clause after `;`, `:` or `,` ("... : delete the tests"). */
const CLAUSE_IMPERATIVES = new Set(
  "skip delete remove ignore disable bypass disregard drop wipe erase forget override replace install run execute use prefer avoid push commit call curl wget sudo npm pnpm yarn pip".split(
    " ",
  ),
);

/** First word is a listed verb, optionally after one adverb in -ly ("Strictly parses") or as `prefix-verb` ("Deep-copies"). */
function startsWithVerb(pieces: readonly string[]): boolean {
  let first = (pieces[0] ?? "").toLowerCase();
  if ((/^[a-z]{3,12}ly$/.test(first) || first === "always" || first === "never") && pieces.length > 1) first = (pieces[1] as string).toLowerCase();
  const hyphen = /^[a-z]{2,8}-([a-z]+)$/.exec(first);
  if (hyphen !== null) first = hyphen[1] as string;
  return /^[a-z]+$/.test(first) && DESCRIPTION_VERBS.has(first);
}

/**
 * The first shape rule a `behavior` breaks, or null when it has the shape of a description. `text` is trimmed and
 * NFKC-folded here. Rules, in order: characters, one sentence (no second sentence, label, or long aside), no runs of
 * single letters, first word is a listed verb, no addressing words.
 */
export function shapeProblem(behavior: string): ShapeProblem | null {
  const text = behavior.normalize("NFKC").trim();
  if (hasDisallowedCharacters(text)) return "characters";

  const body = text.endsWith(".") ? text.slice(0, -1) : text;
  if (/\.(?:\s|\.|$)/.test(body)) return "multiple-sentences";
  // A comma with no space after it ("evil,com") spells a host without a dot; generics such as Map<K,V> are exempt.
  if (/,\S/.test(body.replace(/<[^<>]*>/g, ""))) return "characters";
  if (/^[A-Za-z]+\s*:/.test(body)) return "label";
  // A colon, semicolon or comma may introduce a list or a second clause, but never an imperative one.
  for (const m of body.matchAll(/[;:,]\s*([A-Za-z]+)/g)) {
    if (CLAUSE_IMPERATIVES.has((m[1] as string).toLowerCase())) return "label";
  }

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
  return null;
}

/** Instruction verbs that, followed by a protective object, make a search term or name an instruction ("skip the tests"). */
const INSTRUCTION_VERBS = new Set(
  "skip delete remove ignore disable bypass disregard drop wipe erase forget override".split(" "),
);
const FILLER = new Set("the all any previous prior my this these every".split(" "));
const PROTECTED_OBJECTS = new Set("tests test auth checks check instructions rules".split(" "));

/**
 * True when `words` (lower-case) holds an instruction verb, optional filler, then one or more protected objects that
 * end the phrase or are followed by "and"/"or": `skip the tests`, `deleteAllTests`, `ignorePreviousInstructions`.
 * `removeTestFiles` passes: the object is followed by another noun.
 */
export function instructsProtectedObject(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (!INSTRUCTION_VERBS.has(words[i] as string)) continue;
    let j = i + 1;
    while (j < words.length && FILLER.has(words[j] as string)) j++;
    const start = j;
    while (j < words.length && PROTECTED_OBJECTS.has(words[j] as string)) j++;
    if (j === start) continue;
    if (j === words.length || words[j] === "and" || words[j] === "or") return true;
  }
  return false;
}

/** Terms that start with an install or shell command, or with an unconditional override verb. */
const COMMAND_STARTS = new Set(
  "ignore disregard forget bypass skip prefer use avoid install npm pnpm yarn npx pip curl wget sudo chmod please always never".split(" "),
);
export function startsWithDirective(words: readonly string[]): boolean {
  return words.length > 0 && COMMAND_STARTS.has(words[0] as string);
}

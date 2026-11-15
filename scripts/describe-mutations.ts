// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the patterns are source text with template literals
// Mutation check for the description validators (issue #22): disables one rule at a time by editing its source line,
// runs the describe tests, and reports whether a test failed ("killed") or not ("SURVIVED"). The edited file is
// restored after every run, also on SIGINT, SIGTERM and SIGHUP. A baseline run must be green first, and a compile error, crash or timeout is reported as ERROR, never as a kill. Part of `pnpm check` since issue #108: a surviving mutation (a rule that no
// test notices) fails the check. Usage: pnpm exec tsx scripts/describe-mutations.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The three overrides exist for the interrupt test (packages/core/test/describe-mutations.test.ts): a scratch directory,
// a stub test command and a cap on the number of mutations. Normal runs use none of them.
const dir =
  process.env.GANTRY_MUTATION_DIR ?? join(import.meta.dirname, "..", "packages", "core", "src", "describe");

interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "hard length cap removed",
    file: "validate.ts",
    find: "o.behavior.length > HARD_MAX_BEHAVIOR_CHARS",
    replace: "false",
  },
  {
    name: "dictionary grounding off",
    file: "identifiers.ts",
    find: "return wordGrounded(token.toLowerCase(), g);",
    replace: "return true;",
  },
  {
    name: "word list says yes to everything",
    file: "wordlist.ts",
    find: "return w.length >= 4 && inBloom(w);",
    replace: "return w.length >= 4;",
  },
  {
    name: "two dictionary words make a compound",
    file: "identifiers.ts",
    find: "g.words.has(p.toLowerCase()) || isStopWord(p.toLowerCase())",
    replace: "isWord(p.toLowerCase())",
  },
  {
    name: "default values and literals ground dotted names",
    file: "identifiers.ts",
    find: "addIdents(stripLiteralsAndComments(sheet.signature.slice(0, GROUNDING_CAPS.signature)), true);",
    replace: "addIdents(sheet.signature.slice(0, GROUNDING_CAPS.signature), true);",
  },
  {
    name: "imperative-clause rule off",
    file: "shape.ts",
    find: 'if (hasImperativeClause(body)) return "imperative-clause";',
    replace: "",
  },
  {
    name: "first-word rule off",
    file: "shape.ts",
    find: 'if (!startsWithVerb(pieces)) return "first-word";',
    replace: "",
  },
  {
    name: "modal ban loses 'must'",
    file: "shape.ts",
    find: "yourselves must should",
    replace: "yourselves should",
  },
  {
    name: "speech-act and agent-subject rules off",
    file: "speech.ts",
    find: "export function speechProblem(text: string): string | null {",
    replace:
      "export function speechProblem(text: string): string | null {\n  if (text.length >= 0) return null;",
  },
  {
    name: "permission claims allowed",
    file: "speech.ts",
    find: "return sensitive ? permissionClaim(w) : null;",
    replace: "return null;",
  },
  {
    name: "credential words no longer redacted by name",
    file: "secrets.ts",
    find: 'if (v === MARKER || !isCredentialName(g.name ?? "")) return false;',
    replace: "if (v === MARKER || true) return false;",
  },
  {
    name: "credential value words may be copied",
    file: "validate.ts",
    find: "secretTokens(original, g).length > 0",
    replace: "false",
  },
  {
    name: "instruction-like search term stripped instead of rejected",
    file: "validate.ts",
    find: "else return fail(v.reason, `searchTerms: ${v.detail}`);",
    replace: "else dropped.push(t);",
  },
  {
    name: "redactor: env assignments no longer found",
    file: "secrets.ts",
    find: "[A-Z][A-Z0-9_]{2,60})=(?<v>",
    replace: "[A-Z][A-Z0-9_]{2,60})\\u0001(?<v>",
  },
  {
    name: "redactor: joined literals no longer found",
    file: "secrets.ts",
    find: "join\\(\\s{0,5}(?:\"\"|''|",
    replace: "jxin\\(\\s{0,5}(?:\"\"|''|",
  },
  {
    name: "redactor: positional credential arguments no longer found",
    file: "secrets.ts",
    find: "(?<v>[^\"'\\r\\n]{4,200})[\"']\\s{0,3}[,)]/g,",
    replace: "(?<v>[^\"'\\r\\n]{4,200})[\"']\\s{0,3}[,)]\\u0001/g,",
  },
  {
    name: "redactor: credential flags no longer found",
    file: "secrets.ts",
    find: "(?<![\\w-])(?:--?(?:password|",
    replace: "(?<![\\w-])(?:--?\\u0001(?:password|",
  },
  {
    name: "redactor: curl -u pair no longer found",
    file: "secrets.ts",
    find: "-u\\s{1,3}[\"']?(?<u>",
    replace: "-\\u0001u\\s{1,3}[\"']?(?<u>",
  },
  {
    name: "redactor: commit ids redacted again",
    file: "secrets.ts",
    find: 'accept: (g, redact) => !(redact && isCommitId(g.h ?? "", g.ctx ?? "")),',
    replace: "accept: () => true,",
  },
  {
    name: "redactor: i18n labels redacted again",
    file: "secrets.ts",
    find: "(isLabelName(name) && looksLikeLabel(v)) ||",
    replace: "",
  },
  {
    name: "redactor: sentence-like values behind strong credential names left alone",
    file: "secrets.ts",
    find: "(!hasStrongWord(name) || isPlaceholderPrompt(v))",
    replace: "true",
  },
  {
    name: "redactor: SRI hashes and routes redacted again",
    file: "secrets.ts",
    find: "if (isIntegrityHash(tok) || isRoute(tok)) return false;",
    replace: "",
  },
  {
    name: "entropy rule off",
    file: "secrets.ts",
    find: "export const ENTROPY_THRESHOLD = 4.0;",
    replace: "export const ENTROPY_THRESHOLD = 99;",
  },
  // Issue #150: each exemption that loosened a rule is widened here, and a "stays rejected" row must fail.
  {
    name: "route literal: any slash-wrapped token grounds",
    file: "identifiers.ts",
    find: "const ROUTE_SEGMENT = /^\\/([a-z]{2,20})\\/$/;",
    replace: "const ROUTE_SEGMENT = /^\\/?([a-z]{2,20}(?:\\/[a-z]{2,20}){0,3})\\/?$/;",
  },
  {
    name: "re- compounds: install bait allowed",
    file: "identifiers.ts",
    find: "![again[1] as string, ...stemsOf(again[1] as string)].some((w) => VERBS_INSTRUCTIVE.has(w))",
    replace: "true",
  },
  {
    name: "`should` allowed everywhere after whether",
    file: "shape.ts",
    find: "i - lastWhether <= 8 && !NEW_CLAUSE.has",
    replace: "i - lastWhether <= 800 && !NEW_CLAUSE.has",
  },
  {
    name: "`should` allowed in a new clause",
    file: "shape.ts",
    find: '!NEW_CLAUSE.has((tokens[i - 1] ?? "").toLowerCase())',
    replace: "true",
  },
  {
    name: "noun-use exemption: every always-flagged verb is a noun",
    file: "shape.ts",
    find: "if (isNounUse(items, i)) continue;",
    replace: "continue;",
  },
  {
    name: "verb list after to: an object no longer matters",
    file: "shape.ts",
    find: "if (OBJECT_STARTS.has(nxt)) return false;",
    replace: "",
  },
  {
    name: "verb list after to: protective code allowed",
    file: "shape.ts",
    find: "return !SENSITIVE_OBJECTS.has(nxt);",
    replace: "return true;",
  },
  {
    name: "compound heads: skip policy is a noun",
    file: "shape.ts",
    find: "!(COMPOUND_HEADS.has(nw) && !VERBS_INSTRUCTIVE.has(it.w) && startsNounPhrase(items, i))",
    replace: "!COMPOUND_HEADS.has(nw)",
  },
  {
    name: "participle exemption: any inflection before a person",
    file: "speech.ts",
    find: 'const adjective = j === i + 1 && ADJECTIVE_PARTICIPLES.has(word) && w[j + 1] !== "to";',
    replace: "const adjective = true;",
  },
  {
    name: "participle exemption: tail ignored",
    file: "speech.ts",
    find: "j + (adjective ? 4 : 11)",
    replace: "j + 1",
  },
  {
    name: "search-term noun compound: any previous word",
    file: "speech.ts",
    find: "if (!(COMPOUND_LEAD.has(prev) || VERBS_AMBIGUOUS.has(prev))) return false;",
    replace: "",
  },
  {
    name: "search-term noun compound: any verb, not only commit/push/review/merge",
    file: "speech.ts",
    find: "if (!COMPOUND_VERBS.has(verb) || from === 0",
    replace: "if (from === 0",
  },
  // Fix round of #155 (adversarial review): the branches of the exemptions.
  {
    name: "noun subject: no determiner needed",
    file: "shape.ts",
    find: "return startsNounPhrase(items, i) && !protectiveAhead(items, i + 1);",
    replace: "return !protectiveAhead(items, i + 1);",
  },
  {
    name: "noun subject: protective code in the clause ignored",
    file: "shape.ts",
    find: "return startsNounPhrase(items, i) && !protectiveAhead(items, i + 1);",
    replace: "return startsNounPhrase(items, i);",
  },
  {
    name: "noun subject: finite verb branch always a noun",
    file: "shape.ts",
    find: "if (FINITE_AFTER_NOUN.has(nw)) {",
    replace: "if (FINITE_AFTER_NOUN.has(nw)) return true;\n  if (false) {",
  },
  {
    name: "verb list: destructive verbs allowed in the last slot",
    file: "shape.ts",
    find: 'if (VERBS_ALWAYS.has(last) && last !== "execute") return false;',
    replace: "",
  },
  {
    name: "verb list: first word need not read as a verb",
    file: "shape.ts",
    find: "if (!verbish(w)) return false;",
    replace: "",
  },
  {
    name: "noun compound: try/let/make lead-ins allowed",
    file: "speech.ts",
    find: 'if (prev === "try" || prev === "attempt" || prev === "let" || prev === "make" || prev === "kindly")',
    replace: "if (false)",
  },
  {
    name: "noun compound: protective objects allowed",
    file: "speech.ts",
    find: "if (!FILLERS.has(w) && !COMPOUND_OBJECTS.has(w)) return false;",
    replace: "",
  },
  {
    name: "noun compound: fillers between verb and object not skipped",
    file: "speech.ts",
    find: "if (!FILLERS.has(w) && !COMPOUND_OBJECTS.has(w)) return false;",
    replace: "if (!COMPOUND_OBJECTS.has(w)) return false;",
  },
  {
    name: "noun compound: word before the verb may sit in another term",
    file: "speech.ts",
    find: "|| owner[from - 1] !== owner[from]) return false;",
    replace: ") return false;",
  },
  {
    name: "route literals: two in a row allowed",
    file: "identifiers.ts",
    find: 'if (ROUTE_SEGMENT.test(t.toLowerCase()) && ROUTE_SEGMENT.test((tokens[i - 1] ?? "").toLowerCase())) {',
    replace: "if (false) {",
  },
  {
    name: "require/expect: waving review away allowed",
    file: "speech.ts",
    find: "|| withoutReview(tail)",
    replace: "",
  },
  {
    name: "participle before a person followed by to is an adjective",
    file: "speech.ts",
    find: ' && w[j + 1] !== "to";',
    replace: ";",
  },
];

const TEST_CMD =
  process.env.GANTRY_MUTATION_CMD ?? "pnpm vitest run packages/core/src/describe --reporter=dot --bail=1";
type Outcome = "green" | "killed" | "error";
let lastOutput = "";
let child: ReturnType<typeof spawn> | null = null;

/**
 * Runs the describe tests asynchronously, so the signal handlers below can run while a test is going. "killed" means a
 * test failed; a compile error, crash or timeout is "error", not a kill. GANTRY_MUTATION_RUN tells tests to skip their
 * timing assertions, which a slow machine could turn into a false kill.
 */
function runTests(): Promise<Outcome> {
  return new Promise((resolve) => {
    let out = "";
    // detached: the child leads its own process group, so one kill reaches vitest and its workers
    const c = spawn(TEST_CMD, {
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GANTRY_MUTATION_RUN: "1" },
    });
    child = c;
    const timer = setTimeout(() => killChild(), 300_000);
    c.stdout?.on("data", (d) => {
      out += d;
    });
    c.stderr?.on("data", (d) => {
      out += d;
    });
    c.on("error", () => {
      clearTimeout(timer);
      child = null;
      resolve("error");
    });
    c.on("close", (status, signal) => {
      clearTimeout(timer);
      child = null;
      if (status === 0) return resolve("green");
      lastOutput = `status=${status} signal=${signal} ${out}`;
      if (signal != null || status == null) return resolve("error"); // timeout or killed
      // With --bail the run stops at the first failure, so there may be no summary. A file that did not load or
      // compile is not a kill; anything else that exits non-zero is a failed test.
      if (
        /Transform failed|SyntaxError|ReferenceError|Failed to (?:load|resolve|parse)|error TS\d+/.test(out)
      )
        return resolve("error");
      resolve("killed");
    });
  });
}

function killChild(): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const lockFile = join(
  tmpdir(),
  `gantry-describe-mutation-${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.json`,
);
interface Lock {
  pid: number;
  path: string;
  original: string;
  mutatedHash: string;
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const NO_MUTATION: Lock = { pid: process.pid, path: "", original: "", mutatedHash: "" };
let held = false;
let current: { path: string; original: string } | null = null;

/** Replaces the lock's contents atomically (temp file, then rename over it); the lock is never deleted and re-created. */
function writeLock(lock: Lock): void {
  const tmp = `${lockFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  renameSync(tmp, lockFile);
}

/** Puts the mutated file back; the lock stays held. */
const restore = (): void => {
  if (current === null) return;
  writeFileSync(current.path, current.original);
  current = null;
  if (held) writeLock(NO_MUTATION);
};
/** Final step of every exit path: restore, then release the lock (only if this run holds it). */
const cleanup = (): void => {
  killChild();
  restore();
  if (held) {
    held = false;
    try {
      unlinkSync(lockFile);
    } catch {
      // already gone
    }
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

const LOCKED_EXIT = 3;
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return pid !== process.pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reads a lock another run created; it may be empty for an instant between its create and its first write. */
async function readLock(file: string): Promise<Lock | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const l = JSON.parse(readFileSync(file, "utf8")) as Lock;
      if (typeof l.pid === "number") return l;
    } catch {
      // not written yet, or gone
    }
    await sleep(100);
  }
  return null;
}

/**
 * Takes the lock before anything else, with an exclusive create, and holds it for the whole run. A lock whose process is
 * alive means another run is in progress (exit 3, nothing touched). A dead process's lock is first renamed away (only
 * one contender wins the rename), then its file is restored only if it still holds exactly the mutated text; a file
 * with newer edits is left alone with a warning. SIGKILL cannot be caught, which is why the lock carries the original.
 */
async function acquireLock(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeSync(fd, JSON.stringify(NO_MUTATION));
      closeSync(fd);
      held = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const lock = await readLock(lockFile);
    if (lock !== null && isAlive(lock.pid)) {
      console.log(
        `another mutation run (pid ${lock.pid}) is in progress; wait for it to finish and run again`,
      );
      process.exit(LOCKED_EXIT);
    }
    const stale = `${lockFile}.stale.${process.pid}`;
    try {
      renameSync(lockFile, stale);
    } catch {
      continue; // someone else took it over first; look again
    }
    if (lock !== null && lock.path !== "") {
      if (existsSync(lock.path) && sha256(readFileSync(lock.path, "utf8")) === lock.mutatedHash) {
        writeFileSync(lock.path, lock.original);
        console.log(`restored ${lock.path} from an interrupted run`);
      } else {
        console.log(
          `warning: left ${lock.path} alone (an interrupted run's lock, but the file has changed since)`,
        );
      }
    }
    unlinkSync(stale);
  }
  console.log("could not take the mutation lock; run again");
  process.exit(LOCKED_EXIT);
}

await acquireLock();

if ((await runTests()) !== "green") {
  console.log("baseline: the describe tests are not green without any mutation; fix them first");
  process.exit(1);
}

const limit = Number(process.env.GANTRY_MUTATION_LIMIT ?? MUTATIONS.length);
const run = MUTATIONS.slice(0, limit);
let bad = 0;
for (const m of run) {
  const path = join(dir, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    console.log(`${m.name}: PATTERN NOT FOUND in ${m.file}`);
    bad++;
    continue;
  }
  current = { path, original };
  const mutated = original.replace(m.find, m.replace);
  const lock: Lock = { pid: process.pid, path, original, mutatedHash: sha256(mutated) };
  writeLock(lock);
  writeFileSync(path, mutated);
  let outcome: Outcome;
  try {
    outcome = await runTests();
  } finally {
    restore();
  }
  if (outcome === "error") console.log(lastOutput.slice(-800));
  if (outcome !== "killed") bad++;
  console.log(
    `${m.name}: ${outcome === "killed" ? "killed" : outcome === "green" ? "SURVIVED" : "ERROR (not a kill)"}`,
  );
}
console.log(`${run.length - bad} of ${run.length} mutations killed`);
process.exit(bad === 0 ? 0 : 1);

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the patterns are source text with template literals
// Mutation check for the description validators (issue #22): disables one rule at a time by editing its source line,
// runs the describe tests, and reports whether a test failed ("killed") or not ("SURVIVED"). The edited file is
// restored after every run, also on SIGINT, SIGTERM and SIGHUP. A baseline run must be green first, and a compile error, crash or timeout is reported as ERROR, never as a kill. Part of `pnpm check` since issue #108: a surviving mutation (a rule that no
// test notices) fails the check. Usage: pnpm exec tsx scripts/describe-mutations.ts
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
let current: { path: string; original: string } | null = null;
const restore = (): void => {
  if (current !== null) writeFileSync(current.path, current.original);
  current = null;
  if (existsSync(lockFile)) unlinkSync(lockFile);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    killChild();
    restore();
    process.exit(130);
  });
}
process.on("exit", () => {
  killChild();
  restore();
});

// A SIGKILLed run cannot restore its file, so every mutation first saves the original to a lock file outside the tree;
// the next run puts it back before doing anything else (the tree may hold uncommitted edits, so no dirty-tree check).
if (existsSync(lockFile)) {
  const stale = JSON.parse(readFileSync(lockFile, "utf8")) as { path: string; original: string };
  writeFileSync(stale.path, stale.original);
  unlinkSync(lockFile);
  console.log(`restored ${stale.path} from an interrupted run`);
}

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
  writeFileSync(lockFile, JSON.stringify(current));
  writeFileSync(path, original.replace(m.find, m.replace));
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

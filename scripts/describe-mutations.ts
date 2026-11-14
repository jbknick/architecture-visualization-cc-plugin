// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the patterns are source text with template literals
// Mutation check for the description validators (issue #22): disables one rule at a time by editing its source line,
// runs the describe tests, and reports whether a test failed ("killed") or not ("SURVIVED"). The edited file is
// restored after every run, also on SIGINT, SIGTERM and SIGHUP. A baseline run must be green first, and a compile error, crash or timeout is reported as ERROR, never as a kill. Part of `pnpm check` since issue #108: a surviving mutation (a rule that no
// test notices) fails the check. Usage: pnpm exec tsx scripts/describe-mutations.ts
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "packages", "core", "src", "describe");

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
    find: "join\\(\\s{0,5}(?:\"\"|'')",
    replace: "jxin\\(\\s{0,5}(?:\"\"|'')",
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
    find: "|-u\\s{1,3}(?<u>",
    replace: "|-\\u0001u\\s{1,3}(?<u>",
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
    find: 'if (redact && ((isLabelName(g.name ?? "") && looksLikeLabel(v)) || readsAsSentence(v))) return false;',
    replace: "",
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

const TEST_CMD = "pnpm vitest run packages/core/src/describe --reporter=dot --bail=1";
type Outcome = "green" | "killed" | "error";
let lastOutput = "";

/** Runs the describe tests. "killed" means a test failed; a compile error, crash or timeout is "error", not a kill. */
function runTests(): Outcome {
  try {
    execSync(TEST_CMD, { stdio: "pipe", timeout: 300_000 });
    return "green";
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer; stderr?: Buffer };
    const out = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`;
    lastOutput = `status=${err.status} signal=${err.signal} ${out}`;
    if (err.signal != null || err.status == null) return "error"; // timeout or killed
    // With --bail the run stops at the first failure, so there may be no summary. A file that did not load or
    // compile is not a kill; anything else that exits non-zero is a failed test.
    if (/Transform failed|SyntaxError|ReferenceError|Failed to (?:load|resolve|parse)|error TS\d+/.test(out))
      return "error";
    return "killed";
  }
}

let current: { path: string; original: string } | null = null;
const restore = (): void => {
  if (current !== null) writeFileSync(current.path, current.original);
  current = null;
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}
process.on("exit", restore);

if (runTests() !== "green") {
  console.log("baseline: the describe tests are not green without any mutation; fix them first");
  process.exit(1);
}

let bad = 0;
for (const m of MUTATIONS) {
  const path = join(dir, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    console.log(`${m.name}: PATTERN NOT FOUND in ${m.file}`);
    bad++;
    continue;
  }
  current = { path, original };
  writeFileSync(path, original.replace(m.find, m.replace));
  let outcome: Outcome;
  try {
    outcome = runTests();
  } finally {
    restore();
  }
  if (outcome === "error") console.log(lastOutput.slice(-800));
  if (outcome !== "killed") bad++;
  console.log(
    `${m.name}: ${outcome === "killed" ? "killed" : outcome === "green" ? "SURVIVED" : "ERROR (not a kill)"}`,
  );
}
console.log(`${MUTATIONS.length - bad} of ${MUTATIONS.length} mutations killed`);
process.exit(bad === 0 ? 0 : 1);

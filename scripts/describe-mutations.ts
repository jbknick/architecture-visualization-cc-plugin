// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the patterns are source text with template literals
// Mutation check for the description validators (issue #22): disables one rule at a time by editing its source line,
// runs the describe tests, and reports whether a test failed ("killed") or not ("SURVIVED"). A baseline run must be
// green first, and a compile error, crash or timeout is reported as ERROR, never as a kill. Part of `pnpm check` since
// issue #108: a surviving mutation (a rule that no test notices) fails the check.
// The mutations are applied to a temporary copy of the files the describe tests need, never to the checkout, so
// nothing tracked is edited and several checkouts or worktrees can run the check at the same time. The copy is
// removed on every exit path, also on SIGINT, SIGTERM and SIGHUP. Usage: pnpm exec tsx scripts/describe-mutations.ts
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** What the describe tests read from the repository; copied as is (symlinks stay symlinks). */
const COPY_PATHS = [
  "package.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "fixtures",
  "scripts/build-wordlist.ts",
  "packages/core",
  // the redactor-precision test scans every package's src
  "packages/cli/src",
  "packages/explorer/src",
  "packages/mcp/src",
];
/** Build output stays out of the copy. */
const SKIP_DIRS = new Set([join(repoRoot, "packages", "core", "dist")]);

// The three overrides exist for the interrupt test (packages/core/test/describe-mutations.test.ts): a source
// directory, a stub test command and a cap on the number of mutations. Normal runs use none of them.
// GANTRY_MUTATION_DIR names the directory of the files to mutate; the files changed are their copies under copyRoot.
const dir = resolve(process.env.GANTRY_MUTATION_DIR ?? join(repoRoot, "packages", "core", "src", "describe"));

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
  // Feedback, extra attempt and fallback (#150).
  {
    name: "feedback echoes the validator detail",
    file: "feedback.ts",
    find: "return { rule: reason, field, fix: generic };",
    replace: "return { rule: reason, field, fix: `${generic} ${detail}` };",
  },
  {
    name: "extra attempt after any rejection reason",
    file: "store.ts",
    find: "    EXTRA_ATTEMPT_REASONS.has(reason) &&",
    replace: "    true &&",
  },
  {
    name: "fallback for any final rejection",
    file: "submit.ts",
    find: "now.failed && now.attempts >= MAX_DESCRIBE_ATTEMPTS_EXTENDED && extendable",
    replace: "now.failed",
  },
  {
    name: "fallback sentence not validated",
    file: "fallback.ts",
    find: "  if (!v.ok) return null;",
    replace: "",
  },
  // Extra-attempt gate and fallback hardening (#175).
  {
    name: "signal: copied credential pieces off",
    file: "validate.ts",
    find: "if (low.length >= 6 && secretWords.some((s) => s.includes(low))) return true;",
    replace: "",
  },
  {
    name: "signal: term rules off",
    file: "validate.ts",
    find: "for (const t of terms) if (termInstruction(t, g) !== null || nameInstruction(t, g) !== null) return true;",
    replace: "for (const t of terms) if (nameInstruction(t, g) !== null) return true;",
  },
  {
    name: "non-extendable shape codes ignored",
    file: "validate.ts",
    find: 'if (v.reason === "shape" && [...NON_EXTENDABLE_SHAPE].some((code) => v.detail.includes(code))) return true;',
    replace: "",
  },
  {
    name: "tainted rejection leaves no mark",
    file: "store.ts",
    find: "const error = tainted ? `${errorText}${NO_EXTRA_MARK}` : errorText;",
    replace: "const error = errorText;",
  },
  {
    name: "gate: fallback marker no longer a cue",
    file: "validate.ts",
    find: "if (addressingHits(joined).length > 0 || claimsFallbackMarker(joined)) return true;",
    replace: "if (addressingHits(joined).length > 0) return true;",
  },
  {
    name: "fallback replaces an existing description",
    file: "submit.ts",
    find: "if (storeDescriptions(store, [f.description], { replace: false }) === 0) continue;",
    replace: "if (storeDescriptions(store, [f.description], { replace: true }) === 0) continue;",
  },
  // Clause rule, full-submission gate and fallback names (#175 round 2).
  {
    name: "signal reads at most six array items",
    file: "validate.ts",
    find: "for (const x of v.slice(0, SUBMITTED_MAX_STRINGS)) walk(x, isBehavior, depth + 1);",
    replace: "for (const x of v.slice(0, 6)) walk(x, isBehavior, depth + 1);",
  },
  {
    name: "signal skips a non-string behavior",
    file: "validate.ts",
    find: 'walk(x, isBehavior || k === "behavior", depth + 1);',
    replace:
      'if (typeof x === "string" || k !== "behavior") walk(x, isBehavior || k === "behavior", depth + 1);',
  },
  {
    name: "extra attempt granted by default",
    file: "store.ts",
    find: "const extendable = opts.extendable ?? false;",
    replace: "const extendable = opts.extendable ?? true;",
  },
  {
    name: "failures clean by default",
    file: "store.ts",
    find: "const tainted = opts.tainted ?? true;",
    replace: "const tainted = opts.tainted ?? false;",
  },
  {
    name: "schema, length, injection and secret rejections not tainted",
    file: "validate.ts",
    find: 'if (v.reason !== "shape" && v.reason !== "identifier") return true;',
    replace: "",
  },
  {
    name: "marked failure may still be extended",
    file: "store.ts",
    find: 'if ((previousError ?? "").endsWith(NO_EXTRA_MARK)) return MAX_DESCRIBE_ATTEMPTS;',
    replace: "",
  },
  {
    name: "describer failure counted on an unclaimed row",
    file: "store.ts",
    find: "opts.keepClaim ? \"status = 'claimed'\" : \"status <> 'failed'\"",
    replace: "\"status <> 'failed'\"",
  },
  {
    name: "production claims: only the without-a-model form",
    file: "validate.ts",
    find: "/\\bno (?:language )?(?:models?|llms?|ai)(?: (?:was|were|is))? (?:used|involved|needed|called)\\b/,",
    replace: "",
  },
  // Gate cues of the untrusted-text model (#175 final round).
  {
    name: "gate: clause starts not read",
    file: "clauses.ts",
    find: "if (head !== null && !descriptiveStart(head.first)) return true;",
    replace: "",
  },
  {
    name: "gate: status, approval and modal words not read",
    file: "clauses.ts",
    find: 'return STATUS_WORD.test(t) || t.split(" ").some((w) => MODALS.has(w));',
    replace: "return false;",
  },
  {
    name: "gate: markup and non-ASCII not read",
    file: "clauses.ts",
    find: 'return /[<>]|[^\\x20-\\x7e]/.test(text.normalize("NFKC"));',
    replace: "return false;",
  },
  {
    name: "gate: addressees not read",
    file: "clauses.ts",
    find: 'return wordsOf(text.normalize("NFKC")).some((w) => ADDRESSEE_SUBJECTS.has(w));',
    replace: "return false;",
  },
  {
    name: "gate: identifiers not split into words",
    file: "validate.ts",
    find: '|| gateCue(splitIdentifierWords(t).join(" "), { behavior: false })',
    replace: "",
  },
  // Gate gaps closed in #180.
  {
    name: "gate: base-form verbs ending in -ed or -ing count as participles",
    file: "clauses.ts",
    find: "return candidates.some((c) => isWord(c));",
    replace: "return true;",
  },
  {
    name: "gate: clauses after a conjunction not read",
    file: "clauses.ts",
    find: "if (!CONJUNCTIONS.has(words[i] as string)) continue;",
    replace: "continue;",
  },
  {
    name: "gate: a clause that opens with a number is descriptive",
    file: "clauses.ts",
    find: "if (CLOSED_STARTERS.has(w)) return true;",
    replace: "if (CLOSED_STARTERS.has(w) || /^\\d/.test(w)) return true;",
  },
  {
    name: "gate: sanction, acceptance and permission words not read",
    file: "clauses.ts",
    find: "sanction\\w*|accept\\w*|audit\\w*|permit\\w*|allow\\w*|authori[sz]\\w*|certif\\w*|checked|green|",
    replace: "",
  },
  {
    name: "gate: secret-like values not read",
    file: "clauses.ts",
    find: "if (/^[0-9a-f]+$/i.test(tok) || /\\d/.test(tok)) return true;",
    replace: "",
  },
  // Containment layer: catalog quoting and the fallback sentence (#180).
  {
    name: "catalog: signature outside quotes",
    file: "../catalog/index.ts",
    find: 'lines.push(`- ${sym.name} signature "${sig}" — ${text} [${p}:${sym.startLine}]`);',
    replace: "lines.push(`- ${sym.name}${oneLine(args, SIGNATURE_MAX)} — ${text} [${p}:${sym.startLine}]`);",
  },
  {
    name: "catalog: double quotes inside a signature kept",
    file: "../catalog/index.ts",
    find: 'const sig = oneLine(args, SIGNATURE_MAX).replace(/"/g, "\'");',
    replace: "const sig = oneLine(args, SIGNATURE_MAX);",
  },
  {
    name: "catalog: double quotes inside a description kept",
    file: "../catalog/index.ts",
    find: '${oneLine(desc, DESCRIPTION_MAX).replace(/"/g, "\'")}',
    replace: "${oneLine(desc, DESCRIPTION_MAX)}",
  },
  {
    name: "catalog: provenance label not read from the column",
    file: "../catalog/index.ts",
    find: 'desc && sym.exactHash !== "" ? (snap.describedBy.get(contentKey(sym.exactHash)) ?? "model") : "model";',
    replace: '"model";',
  },
  {
    name: "catalog: untrusted label dropped",
    file: "../catalog/index.ts",
    find: "`untrusted ${by} description: ",
    replace: "`",
  },
  {
    name: "fallback sentence repeats the function name",
    file: "fallback.ts",
    find: "return `Defines a ${sym.kind} that ${takes === null",
    replace: "return `Defines a ${sym.kind} ${sym.name} that ${takes === null",
  },
  // Failure write and fallback return (#180).
  {
    name: "failure write ignores the batch",
    file: "store.ts",
    find: 'if (opts.batchId !== undefined && !(row.claimed_by ?? "").endsWith(`:${opts.batchId}`))',
    replace: "if (false)",
  },
  {
    name: "fallback rows never go back to the model",
    file: "backlog.ts",
    find: 'd.provenance === "fallback" && requeues(key) < MAX_FALLBACK_REQUEUES',
    replace: "false",
  },
  {
    name: "the last fallback return is dropped by the next sync",
    file: "backlog.ts",
    find: "if (!lastReturn.has(key)) dropUnclaimed.run(key);",
    replace: "dropUnclaimed.run(key);",
  },
  {
    name: "fallback returns to the model without a limit",
    file: "backlog.ts",
    find: "export const MAX_FALLBACK_REQUEUES = 3;",
    replace: "export const MAX_FALLBACK_REQUEUES = 99;",
  },
];

const TEST_CMD =
  process.env.GANTRY_MUTATION_CMD ??
  "pnpm vitest run packages/core/src/describe packages/core/src/catalog --reporter=dot --bail=1";
type Outcome = "green" | "killed" | "error";
let lastOutput = "";
let child: ReturnType<typeof spawn> | null = null;

const copyRoot = mkdtempSync(join(tmpdir(), "gantry-mut-"));
/** The directory of the files to mutate, inside the copy. */
let mutDir = dir;

function makeCopy(): void {
  for (const p of COPY_PATHS) {
    cpSync(join(repoRoot, p), join(copyRoot, p), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !SKIP_DIRS.has(src),
    });
  }
  symlinkSync(join(repoRoot, "node_modules"), join(copyRoot, "node_modules"), "dir");
  const rel = relative(repoRoot, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    // a source directory outside the checkout (the interrupt test): copy it in as well
    mutDir = join(copyRoot, "mutation-src");
    cpSync(dir, mutDir, { recursive: true, verbatimSymlinks: true });
  } else {
    mutDir = join(copyRoot, rel);
  }
}

/**
 * Runs the describe tests asynchronously, so the signal handlers below can run while a test is going. "killed" means a
 * test failed; a compile error, crash or timeout is "error", not a kill. GANTRY_MUTATION_RUN tells tests to skip their
 * timing assertions, which a slow machine could turn into a false kill.
 */
function runTests(): Promise<Outcome> {
  return new Promise((done) => {
    let out = "";
    // detached: the child leads its own process group, so one kill reaches vitest and its workers
    const c = spawn(TEST_CMD, {
      shell: true,
      detached: true,
      cwd: copyRoot,
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
      done("error");
    });
    c.on("close", (status, signal) => {
      clearTimeout(timer);
      child = null;
      if (status === 0) return done("green");
      lastOutput = `status=${status} signal=${signal} ${out}`;
      if (signal != null || status == null) return done("error"); // timeout or killed
      // With --bail the run stops at the first failure, so there may be no summary. A file that did not load or
      // compile is not a kill; anything else that exits non-zero is a failed test.
      if (
        /Transform failed|SyntaxError|ReferenceError|Failed to (?:load|resolve|parse)|error TS\d+/.test(out)
      )
        return done("error");
      done("killed");
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

/** Final step of every exit path: stop the test process group, then remove the temporary copy. */
const cleanup = (): void => {
  killChild();
  rmSync(copyRoot, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

makeCopy();

// One retry: a busy machine can stall a test that is green on its own. A real failure fails twice.
if ((await runTests()) !== "green") {
  console.log("baseline: not green; retrying once in case the machine was busy");
  if ((await runTests()) !== "green") {
    console.log("baseline: the describe tests are not green without any mutation; fix them first");
    process.exit(1);
  }
}

const limit = Number(process.env.GANTRY_MUTATION_LIMIT ?? MUTATIONS.length);
const run = MUTATIONS.slice(0, limit);
let bad = 0;
for (const m of run) {
  const path = join(mutDir, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    console.log(`${m.name}: PATTERN NOT FOUND in ${m.file}`);
    bad++;
    continue;
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  let outcome: Outcome;
  try {
    outcome = await runTests();
  } finally {
    writeFileSync(path, original); // the next mutation starts from the unmutated copy
  }
  if (outcome === "error") console.log(lastOutput.slice(-800));
  if (outcome !== "killed") bad++;
  console.log(
    `${m.name}: ${outcome === "killed" ? "killed" : outcome === "green" ? "SURVIVED" : "ERROR (not a kill)"}`,
  );
}
console.log(`${run.length - bad} of ${run.length} mutations killed`);
process.exit(bad === 0 ? 0 : 1);

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the patterns are source text with template literals
// Mutation check for the description validators (issue #22): disables one rule at a time by editing its source line,
// runs the describe tests, and reports whether a test failed ("killed") or not ("SURVIVED"). The edited file is
// restored after every run. Usage: pnpm exec tsx scripts/describe-mutations.ts
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
    name: "entropy rule off",
    file: "secrets.ts",
    find: "export const ENTROPY_THRESHOLD = 4.0;",
    replace: "export const ENTROPY_THRESHOLD = 99;",
  },
];

let survived = 0;
for (const m of MUTATIONS) {
  const path = join(dir, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    console.log(`${m.name}: PATTERN NOT FOUND in ${m.file}`);
    survived++;
    continue;
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  let failed = false;
  try {
    execSync("pnpm vitest run packages/core/src/describe --reporter=dot", {
      stdio: "pipe",
      timeout: 300_000,
    });
  } catch {
    failed = true;
  } finally {
    writeFileSync(path, original);
  }
  if (!failed) survived++;
  console.log(`${m.name}: ${failed ? "killed" : "SURVIVED"}`);
}
console.log(`${MUTATIONS.length - survived} of ${MUTATIONS.length} mutations killed`);
process.exit(survived === 0 ? 0 : 1);

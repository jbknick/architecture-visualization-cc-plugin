import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recipeAdapter } from "../adapters/recipe.js";
import { checkRecipeText, recipeCheckOk } from "./check.js";
import { listTextFiles } from "./data-access.js";
import { parseRecipe } from "./load.js";
import { MAX_PATTERN_LENGTH, MAX_TEXT_FILES, MAX_TEXT_RULES, RuleSchema } from "./schema.js";
import { indexGraph, makeRepo, pathsFor } from "./testkit.js";

// A recipe is repo-controlled, untrusted input. Its regular expressions run under a time budget, its patterns and
// rule counts are capped, and text files are read only from inside the repository (spec section 5).

afterEach(() => vi.restoreAllMocks());

const longLine = `${"a".repeat(100_000)}!`;

const textRule = (id: string, regex: string, extra: Record<string, unknown> = {}) => ({
  id,
  language: "text",
  files: ["**/*.schema"],
  rule: { regex, flags: "gm" },
  emit: { kind: "table", name: "$1" },
  examples: { match: [], noMatch: [] },
  ...extra,
});
const good = textRule("good", "^table\\s+(\\w+)");
const recipe = (rules: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  dependencies: [],
  helpers: ["text-rules"],
  rules,
  ...extra,
});
const pkg = JSON.stringify({ name: "app", private: true });
const stderrLines = () => {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as never);
  return lines;
};

describe("a recipe regex that backtracks catastrophically", () => {
  it.each([
    ["nested quantifier", "(a+)+$"],
    ["alternation", "(a|a)+$"],
  ])("%s is skipped with one note, and the index completes", async (_n, regex) => {
    const repo = await makeRepo({
      "package.json": pkg,
      "src/a.ts": "export const a = 1;\n",
      "db/big.schema": `table real\n${longLine}\n`,
      ".gantry/recipe.json": JSON.stringify(recipe([textRule("bad", regex), good])),
    });
    const lines = stderrLines();
    const t0 = performance.now();
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(lines.filter((l) => l.includes("recipe rule bad skipped"))).toEqual([
      "Gantry: recipe rule bad skipped: regex exceeded 100 ms\n",
    ]);
    // The rest of the recipe ran.
    expect(g.nodes.filter((n) => n.kind === "table").map((n) => n.label)).toEqual(["real"]);
  });

  it("is skipped in a receiverDecl too", async () => {
    const decl = `${"a".repeat(100_000)}!`;
    const repo = await makeRepo({
      "package.json": pkg,
      ".gantry/recipe.json": JSON.stringify(
        recipe(
          [
            {
              id: "t",
              language: "typescript",
              rule: { kind: "decorator", pattern: "@Entity()" },
              emit: { kind: "table", name: "@class", model: "@class" },
              examples: { match: ["@Entity()\nclass A {}"], noMatch: [] },
            },
            {
              id: "r",
              language: "typescript",
              rule: { pattern: "$R.find($$$A)" },
              constraints: { R: { kind: "member_expression" } },
              emit: { kind: "read", receiver: "$R", receiverDecl: ["(a+)+$"] },
              examples: { match: ["this.x.find();"], noMatch: [] },
            },
          ],
          { helpers: ["model-naming"] },
        ),
      ),
      "src/a.ts": `@Entity()\nexport class A {\n  // ${decl}\n  m() { return this.repo.find(); }\n}\n`,
    });
    const lines = stderrLines();
    const t0 = performance.now();
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(lines).toContain("Gantry: recipe rule r skipped: regex exceeded 100 ms\n");
    expect(g.nodes.filter((n) => n.kind === "table").map((n) => n.label)).toEqual(["A"]);
  });

  it("makes `recipe check` fail for the rule", async () => {
    const repo = await makeRepo({ "package.json": pkg, "db/big.schema": `table real\n${longLine}\n` });
    const text = JSON.stringify(recipe([textRule("bad", "(a+)+$"), good]));
    const c = checkRecipeText(pathsFor(repo.dir), text);
    expect(recipeCheckOk(c)).toBe(false);
    expect(c.rules.find((r) => r.id === "bad")?.valid).toBe(false);
    expect(c.rules.find((r) => r.id === "good")?.valid).toBe(true);
    expect(c.errors).toContain("recipe rule bad skipped: regex exceeded 100 ms");
  });
});

describe("caps", () => {
  const rule = (regex: string) => textRule("r", regex);

  it("rejects a pattern longer than the cap, in a text rule and in a receiverDecl", () => {
    expect(RuleSchema.safeParse(rule("a".repeat(MAX_PATTERN_LENGTH))).success).toBe(true);
    expect(RuleSchema.safeParse(rule("a".repeat(MAX_PATTERN_LENGTH + 1))).success).toBe(false);
    const read = (tpl: string) => ({
      id: "r",
      language: "typescript",
      rule: { pattern: "$R.f()" },
      emit: { kind: "read", receiver: "$R", receiverDecl: [tpl] },
      examples: { match: [], noMatch: [] },
    });
    expect(RuleSchema.safeParse(read("a".repeat(MAX_PATTERN_LENGTH))).success).toBe(true);
    expect(RuleSchema.safeParse(read("a".repeat(MAX_PATTERN_LENGTH + 1))).success).toBe(false);
  });

  it("skips the text rules past the limit with an error, and keeps the rest", () => {
    const rules = Array.from({ length: MAX_TEXT_RULES + 1 }, (_, i) => textRule(`t${i}`, "x"));
    const r = parseRecipe(
      JSON.stringify(recipe([...rules, { ...good, id: "ok" }].slice(0, MAX_TEXT_RULES + 1))),
    );
    expect(r.recipe?.rules).toHaveLength(MAX_TEXT_RULES);
    expect(r.errors).toEqual([
      `recipe rule t${MAX_TEXT_RULES} skipped: more than ${MAX_TEXT_RULES} text rules`,
    ]);
  });

  it("reads at most the capped number of text files", async () => {
    const files: Record<string, string> = { "package.json": pkg };
    for (let i = 0; i < MAX_TEXT_FILES + 5; i++)
      files[`db/f${String(i).padStart(3, "0")}.schema`] = "table t\n";
    const repo = await makeRepo(files);
    expect(listTextFiles(repo.dir, ["**/*.schema"])).toHaveLength(MAX_TEXT_FILES);
  });
});

describe("text files stay inside the repository", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("skips a symbolic link to a file outside, a link to a file inside, and a path through a linked directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gantry-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.schema"), "table stolen\n");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "x.schema"), "table viadir\n");
    const repo = await makeRepo({ "package.json": pkg, "db/real.schema": "table real\n" });
    symlinkSync(join(outside, "secret.schema"), join(repo.dir, "db", "link.schema"));
    symlinkSync(join(repo.dir, "db", "real.schema"), join(repo.dir, "db", "inside.schema"));
    symlinkSync(join(outside, "dir"), join(repo.dir, "linked"));
    const read = listTextFiles(repo.dir, ["**/*.schema"]);
    expect(read.map((f) => f.path)).toEqual(["db/real.schema"]);
  });
});

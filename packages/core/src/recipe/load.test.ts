import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecipe, parseRecipe, recipeNotes } from "./load.js";
import { makeRepo } from "./testkit.js";

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  language: "typescript",
  rule: { pattern: "new Hono($$$A)" },
  emit: { kind: "router" },
  examples: { match: ["new Hono()"], noMatch: [] },
  ...over,
});
const text = (rules: unknown[], marker = "a") =>
  JSON.stringify({
    version: 1,
    dependencies: [{ name: "hono", role: "framework", note: marker }],
    helpers: [],
    rules,
  });

describe("parseRecipe", () => {
  it("bad JSON gives no recipe and one error", () => {
    const r = parseRecipe("{ not json");
    expect(r.recipe).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("not JSON");
  });

  it("a file that fails the top-level schema gives no recipe and one error", () => {
    const r = parseRecipe(JSON.stringify({ version: 2, dependencies: [], helpers: [], rules: [] }));
    expect(r.recipe).toBeNull();
    expect(r.errors).toHaveLength(1);
  });

  it("a bad rule is kept out with its id and the zod message, and the rest stay", () => {
    const r = parseRecipe(text([rule("good"), rule("bad", { rule: { pattern: 42 } }), rule("also-good")]));
    expect(r.recipe?.rules.map((x) => x.id)).toEqual(["good", "also-good"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^recipe rule bad skipped: /);
    expect(r.errors[0]).toContain("rule.pattern");
    expect(r.skipped).toEqual(["bad"]);
  });

  it("drops a second rule with the same id", () => {
    const r = parseRecipe(text([rule("a"), rule("a")]));
    expect(r.recipe?.rules).toHaveLength(1);
    expect(r.errors[0]).toContain("duplicate rule id");
  });

  it("a rule without a readable id is named by its position", () => {
    const r = parseRecipe(text([rule("a"), { nothing: true }]));
    expect(r.errors[0]).toMatch(/^recipe rule #2 skipped: /);
  });
});

describe("recipeNotes", () => {
  it("says nothing when there is no recipe file, and prints each load error of a recipe that is present", () => {
    expect(recipeNotes({ recipe: null, errors: [] })).toEqual([]);
    expect(recipeNotes(parseRecipe("{ not json"))).toEqual([
      expect.stringMatching(/^Gantry: recipe .*not JSON/),
    ]);
    expect(recipeNotes(parseRecipe(text([rule("bad", { rule: {} })])))).toEqual([
      expect.stringMatching(/^Gantry: recipe rule bad skipped: /),
    ]);
    expect(recipeNotes(parseRecipe(text([rule("ok")])))).toEqual([]);
  });
});

describe("loadRecipe reads the copy it is asked for", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("main reads HEAD, working reads the disk, a ref reads that commit", async () => {
    const repo = await makeRepo({
      "package.json": "{}",
      ".gantry/recipe.json": text([rule("committed")], "head"),
    });
    const base = repo.git(["rev-parse", "HEAD"]).trim();
    // The disk now differs from HEAD (uncommitted edit).
    writeFileSync(join(repo.dir, ".gantry/recipe.json"), text([rule("on-disk")], "disk"));
    expect(loadRecipe(repo.dir, { layer: "main" }).recipe?.rules.map((r) => r.id)).toEqual(["committed"]);
    expect(loadRecipe(repo.dir, { layer: "working" }).recipe?.rules.map((r) => r.id)).toEqual(["on-disk"]);
    // A new commit changes HEAD; the old ref still reads the old recipe.
    repo.git(["add", "-A", "-f"]);
    repo.git(["commit", "-q", "-m", "second"]);
    expect(loadRecipe(repo.dir, { layer: "main" }).recipe?.rules.map((r) => r.id)).toEqual(["on-disk"]);
    expect(loadRecipe(repo.dir, { ref: base }).recipe?.rules.map((r) => r.id)).toEqual(["committed"]);
  });

  it("a missing file is no recipe and no error; working reads nothing from a bare directory", async () => {
    const repo = await makeRepo({ "package.json": "{}" });
    expect(loadRecipe(repo.dir, { layer: "main" })).toEqual({ recipe: null, errors: [] });
    expect(loadRecipe(repo.dir, { layer: "working" })).toEqual({ recipe: null, errors: [] });
    expect(loadRecipe(repo.dir, { ref: "no-such-ref" })).toEqual({ recipe: null, errors: [] });
    const bare = mkdtempSync(join(tmpdir(), "gantry-bare-"));
    dirs.push(bare);
    mkdirSync(join(bare, ".gantry"));
    writeFileSync(join(bare, ".gantry/recipe.json"), text([rule("x")]));
    expect(loadRecipe(bare, { layer: "working" }).recipe?.rules).toHaveLength(1);
    expect(loadRecipe(bare, { layer: "main" })).toEqual({ recipe: null, errors: [] });
  });
});

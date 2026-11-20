import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../adapters/recipe.js";
import { adaptersRecipeText, indexGraph, makeRepo, pathsFor } from "../recipe/testkit.js";
import { reviewDiff } from "./diff.js";
import { loadSideRecipes } from "./recipe.js";

const app = `import { Hono } from "hono";
export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.post("/items", (c) => c.json({}, 201));
`;

// Review reads each side's recipe from its ref: the base commit has no recipe, the head commit adds one.
describe("review reads each side's recipe from its ref", () => {
  it("the head side has the Hono endpoints and the base side has none", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", version: "0.0.0", dependencies: { hono: "^4.0.0" } }),
      "src/app.ts": app,
    });
    const base = repo.git(["rev-parse", "HEAD"]).trim();
    repo.git(["checkout", "-q", "-b", "feature"]);
    mkdirSync(join(repo.dir, ".gantry"), { recursive: true });
    writeFileSync(join(repo.dir, ".gantry/recipe.json"), adaptersRecipeText());
    repo.git(["add", "-A", "-f"]);
    repo.git(["commit", "-q", "-m", "add the recipe"]);
    const head = repo.git(["rev-parse", "HEAD"]).trim();

    const diff = await reviewDiff(pathsFor(repo.dir), base, head);
    const sides = loadSideRecipes(repo.dir, diff);
    expect(sides.base).toEqual({ recipe: null, errors: [] });
    expect(sides.head.recipe?.rules.map((r) => r.id)).toContain("hono-route");

    // What each side's index holds: check out the ref, index it, read the recipe's endpoints.
    // The built-in Hono adapter would find them on both sides, so only the recipe adapter runs.
    const endpointsAt = async (ref: string): Promise<string[]> => {
      repo.git(["checkout", "-q", ref]);
      const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
      return g.nodes
        .filter((n) => n.kind === "endpoint")
        .map((n) => n.label)
        .sort();
    };
    expect(await endpointsAt(base)).toEqual([]);
    expect(await endpointsAt(head)).toEqual(["GET /health", "POST /items"]);
  });
});

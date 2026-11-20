import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../adapters/recipe.js";
import type { WorkspaceRecord } from "../types.js";
import { checkRecipeText, recipeCheckOk } from "./check.js";
import { rulesFor, runExamples } from "./engine.js";
import { parseRecipe } from "./load.js";
import type { RecipeRule } from "./schema.js";
import { adaptersRecipeText, indexGraph, makeRepo, pathsFor } from "./testkit.js";

const rule = (over: Partial<RecipeRule> = {}): RecipeRule => ({
  id: "get-route",
  language: "typescript",
  rule: { pattern: "$APP.get($P, $$$H)" },
  emit: { kind: "endpoint", receiver: "$APP", method: "=GET", path: "$P", handler: "$$$H" },
  examples: { match: ["app.get('/a', h)"], noMatch: ["app.post('/a', h)"] },
  ...over,
});

describe("rule examples", () => {
  it("pass when every match snippet matches and no noMatch snippet does", () => {
    expect(runExamples(rule())).toEqual({ passed: 2, failed: [] });
  });

  it("fail with the snippet named: a match snippet that gives no match, a noMatch snippet that does", () => {
    const r = runExamples(
      rule({ examples: { match: ["app.post('/a', h)"], noMatch: ["app.get('/a', h)"] } }),
    );
    expect(r.passed).toBe(0);
    expect(r.failed).toHaveLength(2);
    expect(r.failed[0]).toContain("match: no match in");
    expect(r.failed[1]).toContain("noMatch: matched");
  });

  it("read JSX with the TSX grammar", () => {
    const jsx = rule({
      rule: { pattern: "<Route path={$P} />" },
      examples: { match: ["<Route path={base} />"], noMatch: ["<Other />"] },
    });
    expect(runExamples(jsx).failed).toEqual([]);
  });

  it("report an ast-grep rule the grammar rejects", () => {
    const r = runExamples(rule({ rule: { kind: "no_such_node_kind" } }));
    expect(r.error).toBeDefined();
  });
});

describe("which rules apply to a file", () => {
  const ws = (deps: string[]): WorkspaceRecord => ({
    id: "ws:a",
    name: "a",
    dir: ".",
    kind: "app",
    frameworks: [],
    deps,
    exportsMap: null,
  });
  const recipe = parseRecipe(
    JSON.stringify({
      version: 1,
      dependencies: [],
      helpers: [],
      rules: [
        rule({ id: "any" }),
        rule({ id: "hono-only", when: { dependency: ["hono"] } }),
        rule({ id: "routes-dir", files: ["**/routes/**"] }),
      ],
    }),
  ).recipe;

  it("filters by the workspace's dependencies and by the files globs", () => {
    if (!recipe) throw new Error("recipe did not load");
    const ids = (deps: string[], path: string) => rulesFor(recipe, ws(deps), path).map((r) => r.id);
    expect(ids([], "src/a.ts")).toEqual(["any"]);
    expect(ids(["hono"], "src/a.ts")).toEqual(["any", "hono-only"]);
    expect(ids([], "src/routes/a.ts")).toEqual(["any", "routes-dir"]);
  });
});

describe("recipe check on a repository", () => {
  it("counts matches per rule, warns on zero and never fails on it", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", version: "0.0.0", dependencies: { hono: "^4.0.0" } }),
      "src/app.ts": `import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/a", () => 1);\n`,
    });
    const text = adaptersRecipeText();
    const c = checkRecipeText(pathsFor(repo.dir), text);
    expect(recipeCheckOk(c)).toBe(true);
    const by = (id: string) => c.rules.find((r) => r.id === id);
    expect(by("hono-app")?.matches).toBe(1);
    expect(by("hono-app")?.warning).toBeUndefined();
    expect(by("hono-mount")?.matches).toBe(0);
    expect(by("hono-mount")?.warning).toMatch(/matches nothing/);
    // The TanStack rules need the dependency in a workspace; this one has none, so they match nothing too.
    expect(by("tanstack-file-route")?.warning).toBeDefined();
  });

  it("is not ok when a rule is invalid, an example fails, or there is nothing to read", async () => {
    const repo = await makeRepo({ "package.json": JSON.stringify({ name: "app", version: "0.0.0" }) });
    const paths = pathsFor(repo.dir);
    expect(recipeCheckOk(checkRecipeText(paths, "not json"))).toBe(false);
    const bad = JSON.parse(adaptersRecipeText());
    bad.rules[0].examples.match.push("nothing here");
    const c = checkRecipeText(paths, JSON.stringify(bad));
    expect(recipeCheckOk(c)).toBe(false);
    expect(c.rules.find((r) => r.id === "hono-app")?.examples.failed).toHaveLength(1);
  });
});

describe("file routes from the routes directory the project configures", () => {
  it("reads routesDirectory from tsr.config.json and maps files by the TanStack convention", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "web",
        version: "0.0.0",
        dependencies: { "@tanstack/react-router": "^1.0.0" },
      }),
      ".gantry/recipe.json": adaptersRecipeText(),
      "tsr.config.json": JSON.stringify({ routesDirectory: "./app/pages" }),
      "app/pages/__root.tsx": `export const Route = createRootRoute({ component: Root });\nfunction Root() { return null; }\n`,
      "app/pages/posts.$id.tsx": `export const Route = createFileRoute("/posts/$id")({ component: Post });\nfunction Post() { return null; }\n`,
      // Outside the configured directory: a file that calls createFileRoute is not a route.
      "src/routes/ignored.tsx": `export const Route = createFileRoute("/ignored")({});\n`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    const routes = g.nodes.filter((n) => n.kind === "route");
    expect(routes.map((n) => n.data.routeId).sort()).toEqual(["/posts/$id", "__root__"]);
    expect(routes.find((n) => n.data.routeId === "/posts/$id")?.data.urlPath).toBe("/posts/$id");
    expect(g.edges.filter((e) => e.kind === "contains" && e.src.startsWith("route:"))).toHaveLength(1);
  });
});

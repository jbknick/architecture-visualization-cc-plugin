import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../../adapters/recipe.js";
import { adaptersRecipeText, endpointLabels, indexGraph, makeRepo } from "../testkit.js";
import { mergePaths, patternMatches } from "./mount-graph.js";

describe("mergePaths and patternMatches", () => {
  it("merges base paths, prefixes and route paths", () => {
    expect(mergePaths(["/api", "/posts/:id"])).toBe("/api/posts/:id");
    expect(mergePaths(["/api/users", "/v1", "/"])).toBe("/api/users/v1");
    expect(mergePaths(["", "/"])).toBe("/");
    expect(mergePaths(["/api/", "posts"])).toBe("/api/posts");
  });
  it("matches middleware patterns", () => {
    expect(patternMatches("/*", "/health")).toBe(true);
    expect(patternMatches("/api/*", "/api/posts/:id")).toBe(true);
    expect(patternMatches("/api/*", "/apix")).toBe(false);
  });
});

const pkg = (name: string, deps: Record<string, string>) =>
  JSON.stringify({ name, version: "0.0.0", dependencies: deps });

describe("the spike's Hono cases, from the committed recipe", () => {
  it("mounts a sub-app of another package at /api and /api/users, applies .basePath and reads an imported constant", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      ".gantry/recipe.json": adaptersRecipeText(),
      "apps/server/package.json": pkg("@demo/server", { "@demo/posts": "workspace:*", hono: "^4.0.0" }),
      "apps/server/src/paths.ts": `export const HEALTH_PATH = "/health";\n`,
      "apps/server/src/users.ts": `import { Hono } from "hono";
export const users = new Hono().basePath("/v1").get("/", listUsers).post(createUser);
function listUsers() {}
function createUser() {}
`,
      "apps/server/src/app.ts": `import { Hono } from "hono";
import { posts } from "@demo/posts";
import { HEALTH_PATH } from "./paths";
import { users } from "./users";
export const app = new Hono();
app.get(HEALTH_PATH, (c) => c.text("ok"));
app.route("/api", posts);
app.route("/api/users", users);
`,
      "packages/posts/package.json": JSON.stringify({
        name: "@demo/posts",
        version: "0.0.0",
        main: "./src/index.ts",
        dependencies: { hono: "^4.0.0" },
      }),
      "packages/posts/src/index.ts": `export { posts } from "./routes";\n`,
      "packages/posts/src/routes.ts": `import { Hono } from "hono";
export const posts = new Hono();
posts.get("/posts/:id", (c) => c.json({}));
posts.on(["PUT", "PATCH"], "/posts/:id", (c) => c.json({}));
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual([
      "GET /api/posts/:id",
      "GET /api/users/v1",
      "GET /health",
      "PATCH /api/posts/:id",
      "POST /api/users/v1",
      "PUT /api/posts/:id",
    ]);
    // Every endpoint belongs to the package of the app at the top of the mount chain.
    expect(new Set(g.nodes.filter((n) => n.kind === "endpoint").map((n) => n.ws))).toEqual(
      new Set(["ws:repo:@demo/server"]),
    );
  });
});

describe("a path the helpers cannot read stays visible", () => {
  it("keeps the unreadable piece as {name}, gives the node a reason and its edges low confidence", async () => {
    const repo = await makeRepo({
      "package.json": pkg("app", { hono: "^4.0.0" }),
      ".gantry/recipe.json": adaptersRecipeText(),
      "src/app.ts": `import { Hono } from "hono";
import { PREFIX } from "some-config";
export const app = new Hono();
function handler() {}
export function add(path: string) {
  app.get(path, handler);
}
app.get(\`\${PREFIX}/items\`, handler);
app.get("/ok", handler);
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual(["GET /ok", "GET /{PREFIX}/items", "GET /{path}"].sort());
    const byLabel = (l: string) => g.nodes.find((n) => n.label === l);
    expect(byLabel("GET /{path}")?.data.reason).toBe("path is a function parameter");
    expect(byLabel("GET /{PREFIX}/items")?.data.reason).toBe("path is not a literal or const string");
    expect(byLabel("GET /ok")?.data.reason).toBeUndefined();
    const handles = (label: string) =>
      g.edges.filter((e) => e.kind === "handles" && e.src === byLabel(label)?.id).map((e) => e.confidence);
    expect(handles("GET /{path}")).toEqual(["low"]);
    expect(handles("GET /{PREFIX}/items")).toEqual(["low"]);
    expect(handles("GET /ok")).toEqual(["high"]);
  });

  it("a receiver that is not a declared router is never an endpoint", async () => {
    const repo = await makeRepo({
      "package.json": pkg("app", { hono: "^4.0.0" }),
      ".gantry/recipe.json": adaptersRecipeText(),
      "src/app.ts": `import { Hono } from "hono";
export const app = new Hono();
const cache = new Map<string, string>();
cache.get("/not-a-route");
db.select().all("/nope", handler);
app.get("/yes", () => cache.get("x"));
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual(["GET /yes"]);
  });
});

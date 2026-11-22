import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../../adapters/recipe.js";
import { endpointLabels, indexGraph, makeRepo } from "../testkit.js";

const expressRecipe = (): string =>
  readFileSync(
    join(import.meta.dirname, "../testdata/express-mongodb-rest-api-boilerplate.recipe.json"),
    "utf8",
  );

describe("call-return: a mounted factory call is the router the function returns", () => {
  it("follows createX() through an import and through a router that mounts several factories", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "api", version: "0.0.0", dependencies: { express: "^5.0.0" } }),
      ".gantry/recipe.json": expressRecipe(),
      "src/app.ts": `import express from "express";
import { createRouter } from "./router";
export const createApp = () => {
  const app = express();
  app.use("/api", createRouter());
  app.get("/health", (_req, res) => res.send("ok"));
  return app;
};
`,
      "src/router.ts": `import { Router } from "express";
import { createUsers } from "./users";
import { createPosts } from "./posts";
export const createRouter = () => {
  const router = Router();
  router.use(createUsers(), createPosts());
  return router;
};
`,
      "src/users.ts": `import { Router } from "express";
export function createUsers() {
  const router = Router();
  router.get("/users/:id", (req, res) => res.send("u"));
  router.route("/users").post((req, res) => res.send("c")).get((req, res) => res.send("l"));
  return router;
}
`,
      "src/posts.ts": `import { Router } from "express";
export const createPosts = () => {
  const r = Router();
  r.delete("/posts/:id", (req, res) => res.send("d"));
  return r;
};
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual([
      "DELETE /api/posts/:id",
      "GET /api/users",
      "GET /api/users/:id",
      "GET /health",
      "POST /api/users",
    ]);
    // The workspace and the handler: all belong to the app at the top, and an inline handler is attributed to its file.
    const health = g.nodes.find((n) => n.label === "GET /health");
    expect(health?.data).toMatchObject({ adapter: "express", handler: "inline", file: "src/app.ts" });
  });
});

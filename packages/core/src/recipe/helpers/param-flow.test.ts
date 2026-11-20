import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../../adapters/recipe.js";
import { endpointLabels, indexGraph, makeRepo } from "../testkit.js";

const recipe = (name: string): string =>
  readFileSync(join(import.meta.dirname, "../../../../../evals/oss/recipes", `${name}.recipe.json`), "utf8");

describe("param-flow: a router passed as an argument is the callee's parameter", () => {
  it("follows Fastify plugin functions registered with a prefix, also through an import", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "api", version: "0.0.0", dependencies: { fastify: "^5.0.0" } }),
      ".gantry/recipe.json": recipe("fastify-typescript"),
      "src/main.ts": `import fastify from "fastify";
import userRouter from "./routes/user.router";
import { postRouter } from "./routes/post.router";
const server = fastify({});
server.register(userRouter, { prefix: "/api/user" });
server.register(postRouter, { prefix: "/api/post" });
server.get("/health", async () => ({ ok: true }));
`,
      "src/routes/user.router.ts": `import type { FastifyInstance } from "fastify";
async function userRouter(fastify: FastifyInstance) {
  fastify.post("/login", async () => ({}));
}
export default userRouter;
`,
      "src/routes/post.router.ts": `import type { FastifyInstance } from "fastify";
export async function postRouter(fastify: FastifyInstance) {
  fastify.post("/create", { schema: {} }, async () => ({}));
}
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual(["GET /health", "POST /api/post/create", "POST /api/user/login"]);
  });

  it("links a router to the parameter of a function it is passed to (Express)", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "api", version: "0.0.0", dependencies: { express: "^5.0.0" } }),
      ".gantry/recipe.json": recipe("express-mongodb-rest-api-boilerplate").replace(
        '"helpers": ["resolve-names", "const-strings", "mount-graph", "call-return"]',
        '"helpers": ["resolve-names", "const-strings", "mount-graph", "call-return", "param-flow"]',
      ),
      "src/app.ts": `import express, { Router } from "express";
import { addUserRoutes } from "./users";
const app = express();
const v1 = Router();
app.use("/v1", v1);
addUserRoutes(v1);
`,
      "src/users.ts": `export function addUserRoutes(r) {
  r.get("/users", (req, res) => res.send("l"));
}
// A function nobody passes a router to is not a router.
export function lookup(client) {
  client.get("/not-a-route", () => 1);
}
`,
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    expect(endpointLabels(g)).toEqual(["GET /v1/users"]);
  });
});

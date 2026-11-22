import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recipeAdapter } from "../adapters/recipe.js";
import { checkRecipeText } from "./check.js";
import { listRecipeNodes, type RecipeNodeEntry } from "./nodes.js";
import { indexGraph, makeRepo, pathsFor } from "./testkit.js";

const recipeOf = (name: string): string =>
  readFileSync(join(import.meta.dirname, "testdata", `${name}.recipe.json`), "utf8");

const pkg = (deps: string[]): string =>
  JSON.stringify({
    name: "app",
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, "^1"])),
  });

const key = (e: Pick<RecipeNodeEntry, "kind" | "label">): string => `${e.kind} ${e.label}`;

/** What the index stored, as `kind label` for nodes and `read|write label file:line` for each read and write. */
async function indexed(dir: string): Promise<string[]> {
  const g = await indexGraph(dir, { adapters: [recipeAdapter] });
  const label = new Map(g.nodes.map((n) => [n.id, n.label]));
  const out = g.nodes.map((n) => `${n.kind} ${n.label}`);
  for (const e of g.edges) {
    if (e.kind !== "reads" && e.kind !== "writes") continue;
    for (const ev of e.evidence)
      out.push(`${e.kind === "reads" ? "read" : "write"} ${label.get(e.dst)} ${ev}`);
  }
  return out.sort();
}

/** What the check lists, in the same form. */
async function listed(dir: string, recipe: string): Promise<{ keys: string[]; entries: RecipeNodeEntry[] }> {
  const r = await listRecipeNodes(pathsFor(dir), recipe, { limit: 1000 });
  const keys = r.entries
    .map((e) => (e.kind === "read" || e.kind === "write" ? `${key(e)} ${e.file}:${e.line}` : key(e)))
    .sort();
  return { keys, entries: r.entries };
}

const FASTIFY_FILES: Record<string, string> = {
  "package.json": pkg(["fastify", "@prisma/client"]),
  "prisma/schema.prisma": 'model User {\n  id Int\n  @@map("users")\n}\n\nmodel Post {\n  id Int\n}\n',
  "src/server.ts": [
    'import fastify from "fastify";',
    'import { userRouter } from "./user";',
    "const server = fastify({});",
    'server.get("/health", async () => ({ ok: true }));',
    'server.register(userRouter, { prefix: "/api/user" });',
  ].join("\n"),
  "src/user.ts": [
    'import type { FastifyInstance } from "fastify";',
    "declare const prisma: any;",
    "export async function userRouter(f: FastifyInstance) {",
    '  f.get("/:id", async () => prisma.user.findUnique({ where: {} }));',
    '  f.post("/", async () => prisma.post.create({ data: {} }));',
    "}",
  ].join("\n"),
};

const CASES: {
  name: string;
  recipe: string;
  files: Record<string, string>;
  expected: Record<string, number>;
}[] = [
  {
    // Fastify and Prisma: text rules for the tables, and no `text-rules` in `helpers` (the case that scored 0). The
    // endpoint rule emits `handler: "$H"` for a `$$$H` capture, so the index makes no endpoint: the list shows that.
    name: "fastify-typescript, text rules for tables",
    recipe: recipeOf("fastify-typescript-text-tables"),
    files: FASTIFY_FILES,
    expected: { table: 2, read: 1, write: 1 },
  },
  {
    // The same repository with a run that wrote the handler capture correctly: the endpoint of the server file is there.
    name: "fastify-typescript, endpoint rule",
    recipe: recipeOf("fastify-typescript-endpoint"),
    files: FASTIFY_FILES,
    expected: { endpoint: 1, table: 2, read: 1, write: 1 },
  },
  {
    // Kysely: tables from a type in a text file, reads and writes by table name.
    name: "saasfly",
    recipe: recipeOf("saasfly"),
    files: {
      "package.json": pkg(["next", "kysely"]),
      "packages/db/prisma/types.ts": "export type DB = {\n  User: User;\n  Account: Account;\n};\n",
      "src/queries.ts": [
        "declare const db: any;",
        'export const users = () => db.selectFrom("User").selectAll();',
        'export const addUser = () => db.insertInto("User").values({});',
        'export const dropAccount = () => db.deleteFrom("Account");',
      ].join("\n"),
    },
    expected: { table: 2, read: 1, write: 2 },
  },
  {
    // A route rule on the router file of a Vite app.
    name: "bulletproof-react",
    recipe: recipeOf("bulletproof-react"),
    files: {
      "package.json": pkg(["react-router"]),
      "src/router.tsx": [
        "declare function createBrowserRouter(r: unknown[]): unknown;",
        'export const r = createBrowserRouter([{ path: "/x", lazy: () => 1 }, { path: "/y", lazy: () => 2 }]);',
      ].join("\n"),
    },
    expected: { route: 1 },
  },
  {
    // The recipe lists `text-rules`; the tables are the same as without it.
    name: "nestjs-boilerplate",
    recipe: recipeOf("nestjs-boilerplate"),
    files: {
      "package.json": pkg(["@nestjs/common", "typeorm"]),
      "src/roles/role.entity.ts": "@Entity({\n  name: 'role',\n})\nexport class RoleEntity {}\n",
      "src/status/status.entity.ts": "@Entity({ name: 'status' })\nexport class StatusEntity {}\n",
    },
    expected: { table: 2 },
  },
];

describe("recipe check lists the nodes the index makes", () => {
  it.each(CASES)("$name: the listed nodes equal the indexed nodes", async ({ recipe, files, expected }) => {
    const repo = await makeRepo({ ...files, ".gantry/recipe.json": recipe });
    const fromIndex = await indexed(repo.dir);
    const fromCheck = await listed(repo.dir, recipe);
    expect(fromCheck.keys).toEqual(fromIndex);
    const counts: Record<string, number> = {};
    for (const e of fromCheck.entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    expect(counts).toEqual(expected);
    // Every listed node says where it is.
    for (const e of fromCheck.entries) expect(e.file).toMatch(/\.\w+$/);
  });

  it("lists nodes for a recipe file that is not the committed one", async () => {
    const c = CASES.find((x) => x.name === "fastify-typescript, endpoint rule");
    if (!c) throw new Error("no case");
    const repo = await makeRepo(c.files);
    const r = await listRecipeNodes(pathsFor(repo.dir), c.recipe, { limit: 1000 });
    expect(r.totals).toEqual({ route: 0, endpoint: 1, middleware: 0, table: 2, read: 1, write: 1 });
  });

  it("bounds the entries per kind and keeps the totals", async () => {
    const c = CASES.find((x) => x.name.startsWith("nestjs"));
    if (!c) throw new Error("no case");
    const repo = await makeRepo({ ...c.files, ".gantry/recipe.json": c.recipe });
    const r = await listRecipeNodes(pathsFor(repo.dir), c.recipe, { limit: 1 });
    expect(r.totals.table).toBe(2);
    expect(r.entries.filter((e) => e.kind === "table")).toHaveLength(1);
    expect(r.limit).toBe(1);
  });

  it("lists nothing for a recipe that is not valid", async () => {
    const repo = await makeRepo({ "package.json": pkg([]) });
    const r = await listRecipeNodes(pathsFor(repo.dir), "{", { limit: 5 });
    expect(r.entries).toEqual([]);
  });
});

describe("a text rule works without the text-rules helper listed (#367)", () => {
  const withoutHelper = (recipe: string): string => {
    const j = JSON.parse(recipe) as { helpers: string[] };
    j.helpers = j.helpers.filter((h) => h !== "text-rules" && h !== "method-classes");
    return JSON.stringify(j);
  };

  it.each([
    ["nestjs-boilerplate", { "src/a.entity.ts": "@Entity({ name: 'a' })\nexport class A {}\n" }],
    ["saasfly", { "packages/db/prisma/types.ts": "export type DB = {\n  User: User;\n};\n" }],
  ] as const)("%s: the index makes the tables with no text-rules helper", async (name, files) => {
    const recipe = withoutHelper(recipeOf(name));
    expect(JSON.parse(recipe).helpers).not.toContain("text-rules");
    const repo = await makeRepo({ "package.json": pkg(["next"]), ...files, ".gantry/recipe.json": recipe });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    const tables = g.nodes.filter((n) => n.kind === "table");
    expect(tables).toHaveLength(1);
    const check = checkRecipeText(pathsFor(repo.dir), recipe);
    expect(check.errors).toEqual([]);
    expect(check.rules.find((r) => r.id.includes("tables") || r.id.includes("entity"))?.matches).toBe(1);
  });
});

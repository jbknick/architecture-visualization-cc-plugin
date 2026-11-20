import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { drizzleAdapter } from "../adapters/drizzle.js";
import { recipeAdapter } from "../adapters/recipe.js";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../types.js";
import { indexGraph, makeRepo } from "./testkit.js";

const helperPath = "../../test/helpers/fixture.js";
interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** The tables of an index, and the edges that read or write them, as JSON text. */
async function tablesOf(
  name: string,
  adapters: Parameters<typeof indexRepo>[1]["adapters"],
): Promise<{ text: string; tables: number; reads: number; writes: number; low: number }> {
  const fx = await materializeFixture(name);
  const data = mkdtempSync(join(tmpdir(), "gantry-data-access-"));
  cleanups.push(() => fx.cleanup());
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main", adapters });
  const store = openStore(paths.dbPath);
  try {
    const g = dumpGraph(store);
    const nodes = ((g.adapterNodes ?? []) as AdapterNodeRecord[]).filter((n) => n.kind === "table");
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (g.edges as EdgeRecord[]).filter((e) => ids.has(e.dst));
    return {
      text: JSON.stringify({ nodes, edges }, null, 2),
      tables: nodes.length,
      reads: edges.filter((e) => e.kind === "reads").length,
      writes: edges.filter((e) => e.kind === "writes").length,
      low: edges.filter((e) => e.confidence === "low").length,
    };
  } finally {
    store.close();
  }
}

// The recipe adapter, run alone on a fixture's committed recipe, must write what the built-in Drizzle adapter writes:
// the same table nodes (data and key order too) and the same reads and writes edges (count, evidence, confidence).
// While the built-in adapter stays registered, this is the check that the recipe is complete: the stored index would
// hide a gap, because it keeps either copy.
describe("recipe adapter equals the built-in Drizzle adapter on the fixtures", () => {
  it.each([
    ["pnpm-turbo", { tables: 2, reads: 2, writes: 1 }],
    ["adapters", { tables: 2, reads: 5, writes: 3 }],
  ] as const)("%s", async (name, counts) => {
    const fromRecipe = await tablesOf(name, [recipeAdapter]);
    const fromBuiltIn = await tablesOf(name, [drizzleAdapter]);
    expect({ tables: fromRecipe.tables, reads: fromRecipe.reads, writes: fromRecipe.writes }).toEqual(counts);
    expect(fromRecipe.text).toBe(fromBuiltIn.text);
  });

  it("keeps the low-confidence read of a name that only matches, as the adapter does", async () => {
    const fromRecipe = await tablesOf("adapters", [recipeAdapter]);
    expect(fromRecipe.low).toBeGreaterThan(0);
  });
});

const baseRecipe = {
  version: 1,
  dependencies: [{ name: "pg", role: "data-access", note: "driver" }],
  helpers: ["resolve-names", "const-strings", "sql-text", "call-return"],
  rules: [],
};

async function sqlGraph(files: Record<string, string>, recipe: Record<string, unknown>) {
  const repo = await makeRepo({
    "package.json": JSON.stringify({ name: "app", private: true, dependencies: { pg: "^8" } }),
    ".gantry/recipe.json": JSON.stringify({ ...baseRecipe, ...recipe }),
    ...files,
  });
  return indexGraph(repo.dir, { adapters: [recipeAdapter] });
}

describe("tables named at run time", () => {
  it("is a node named {<expression>} with data.reason, and low edges, never a guess", async () => {
    const g = await sqlGraph(
      {
        "src/db.ts": [
          'export const setup = (db: Db) => db.query("CREATE TABLE users (id int)");',
          "export const readUsers = (db: Db) => db.query(`SELECT * FROM users`);",
          "export function readAny(db: Db, table: string) {",
          "  return db.query(`SELECT * FROM ${table}`);",
          "}",
          "export function readBuilt(db: Db, a: string) {",
          "  return db.query(`DELETE FROM ${a + 'x'}`);",
          "}",
          "interface Db { query(sql: string): unknown }",
        ].join("\n"),
      },
      { sql: { files: ["src/**"] } },
    );
    const tables = g.nodes.filter((n) => n.kind === "table");
    const byName = new Map(tables.map((n) => [(n.data as { name: string }).name, n]));
    expect([...byName.keys()].sort()).toEqual(["users", "{a + 'x'}", "{table}"]);
    expect(byName.get("users")?.data).toMatchObject({ name: "users", file: "src/db.ts", line: 1 });
    expect(byName.get("users")?.data).not.toHaveProperty("reason");
    expect(byName.get("{table}")?.data).toMatchObject({
      name: "{table}",
      reason: "table name is a function parameter",
    });
    expect(byName.get("{a + 'x'}")?.data).toMatchObject({ reason: "table name is built at runtime" });
    const edge = (name: string) => g.edges.find((e) => e.dst === byName.get(name)?.id);
    expect(edge("{table}")).toMatchObject({ kind: "reads", confidence: "low" });
    expect(edge("{a + 'x'}")).toMatchObject({ kind: "writes", confidence: "low" });
    expect(edge("users")).toMatchObject({ kind: "reads", confidence: "high" });
  });

  it("declares tables from .sql files and reads them in code, with the node on a TypeScript file", async () => {
    const g = await sqlGraph(
      {
        "db/001.sql":
          "-- init\nCREATE TABLE accounts (id int);\nCREATE TABLE IF NOT EXISTS audit (id int);\n",
        "src/db.ts": "export const q = (db: unknown) => `SELECT * FROM accounts`;\n",
      },
      { sql: { files: ["src/**"], sqlFiles: ["db/**/*.sql"] } },
    );
    const tables = g.nodes.filter((n) => n.kind === "table");
    expect(tables.map((n) => (n.data as { name: string }).name).sort()).toEqual(["accounts", "audit"]);
    expect(tables.find((n) => n.label === "accounts")?.data).toMatchObject({ file: "db/001.sql", line: 2 });
    expect(g.edges.filter((e) => e.kind === "reads")).toHaveLength(1);
  });

  it("leaves a name that is no declared table out", async () => {
    const g = await sqlGraph(
      { "src/db.ts": "export const q = (db: unknown) => `SELECT * FROM pg_catalog_things`;\n" },
      { sql: {} },
    );
    expect(g.nodes.filter((n) => n.kind === "table")).toEqual([]);
  });
});

describe("a table emit that cannot read its name", () => {
  it("makes a runtime table with a reason", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", private: true, dependencies: { mongoose: "^8" } }),
      ".gantry/recipe.json": JSON.stringify({
        version: 1,
        dependencies: [{ name: "mongoose", role: "data-access", note: "odm" }],
        helpers: ["resolve-names", "const-strings"],
        rules: [
          {
            id: "model",
            language: "typescript",
            rule: { pattern: "model($N, $$$A)" },
            emit: { kind: "table", name: "$N" },
            examples: { match: ['model("User", s);'], noMatch: ["other(1);"] },
          },
        ],
      }),
      "src/models.ts": [
        "declare function model(name: string, s: unknown): unknown;",
        'export const User = model("User", {});',
        "export function make(name: string) { return model(name, {}); }",
      ].join("\n"),
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    const names = g.nodes
      .filter((n) => n.kind === "table")
      .map((n) => n.data as { name: string; reason?: string });
    expect(names.map((n) => n.name).sort()).toEqual(["User", "{name}"]);
    expect(names.find((n) => n.name === "{name}")?.reason).toBe("table name is a function parameter");
  });
});

describe("text rules and model naming", () => {
  it("reads tables from a schema file and resolves a model through its @@map-style name", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "orm-client": "^1" } }),
      ".gantry/recipe.json": JSON.stringify({
        version: 1,
        dependencies: [{ name: "orm-client", role: "data-access", note: "client" }],
        helpers: ["resolve-names", "const-strings", "text-rules", "model-naming", "method-classes"],
        methods: { read: ["findMany"], write: ["create"] },
        rules: [
          {
            id: "schema-model-mapped",
            language: "text",
            files: ["**/*.schema"],
            rule: {
              regex: '^model\\s+(\\w+)\\s*\\{(?:(?!^\\})[\\s\\S])*?^\\s*@@map\\("([^"]+)"\\)',
              flags: "gm",
            },
            emit: { kind: "table", name: "$2", model: "$1" },
            examples: { match: ['model User {\n  @@map("users")\n}'], noMatch: ["model Post {\n}"] },
          },
          {
            id: "schema-model-plain",
            language: "text",
            files: ["**/*.schema"],
            rule: {
              regex: "^model\\s+(\\w+)\\s*\\{(?:(?!@@map)(?!^\\})[\\s\\S])*^\\}",
              flags: "gm",
            },
            emit: { kind: "table", name: "$1", model: "$1" },
            examples: {
              match: ["model Post {\n  id Int\n}"],
              noMatch: ['model User {\n  @@map("users")\n}'],
            },
          },
          {
            id: "client-read",
            language: "typescript",
            rule: { pattern: "$C.$MODEL.$M($$$A)" },
            constraints: { C: { regex: "^db$" } },
            emit: { kind: "read", model: "$MODEL", method: "$M" },
            examples: { match: ["db.user.findMany();"], noMatch: ["other.user.findMany();"] },
          },
          {
            id: "client-write",
            language: "typescript",
            rule: { pattern: "$C.$MODEL.$M($$$A)" },
            constraints: { C: { regex: "^db$" } },
            emit: { kind: "write", model: "$MODEL", method: "$M" },
            examples: { match: ["db.user.create({});"], noMatch: ["other.user.create({});"] },
          },
        ],
      }),
      "db/app.schema": 'model User {\n  id Int\n  @@map("users")\n}\n\nmodel Post {\n  id Int\n}\n',
      "src/use.ts": [
        "declare const db: any;",
        "export const list = () => db.user.findMany();",
        "export const add = () => db.post.create({});",
      ].join("\n"),
    });
    const g = await indexGraph(repo.dir, { adapters: [recipeAdapter] });
    const names = g.nodes.filter((n) => n.kind === "table").map((n) => (n.data as { name: string }).name);
    expect(names.sort()).toEqual(["Post", "users"]);
    const dst = (name: string) => g.nodes.find((n) => (n.data as { name: string }).name === name)?.id;
    const access = g.edges.filter((e) => e.kind === "reads" || e.kind === "writes");
    expect(access.map((e) => `${e.kind}:${e.dst === dst("users") ? "users" : "Post"}`).sort()).toEqual([
      "reads:users",
      "writes:Post",
    ]);
  });
});

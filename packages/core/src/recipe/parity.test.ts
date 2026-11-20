import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { honoAdapter } from "../adapters/hono.js";
import { recipeAdapter } from "../adapters/recipe.js";
import { tanstackRoutesAdapter } from "../adapters/tanstack-routes.js";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";

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

const KINDS = new Set(["route", "endpoint", "middleware"]);

/** The routes, endpoints and middleware of an index, with the edges between them and their code, as JSON text. */
async function routesOf(
  name: string,
  adapters: Parameters<typeof indexRepo>[1]["adapters"],
): Promise<string> {
  const fx = await materializeFixture(name);
  const data = mkdtempSync(join(tmpdir(), "gantry-parity-"));
  cleanups.push(() => fx.cleanup());
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main", adapters });
  const store = openStore(paths.dbPath);
  try {
    const g = dumpGraph(store);
    const nodes = ((g.adapterNodes ?? []) as { id: string; kind: string }[]).filter((n) => KINDS.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (g.edges as { src: string }[]).filter((e) => ids.has(e.src));
    return JSON.stringify({ nodes, edges }, null, 2);
  } finally {
    store.close();
  }
}

// The recipe adapter, run alone on a fixture's committed recipe, must write what the built-in TanStack Router and
// Hono adapters write: the same nodes, data (key order too) and edges. While the built-in adapters stay registered,
// this is the check that the recipe is complete: the stored index would hide a gap, because it keeps either copy.
describe("recipe adapter equals the built-in adapters on the fixtures", () => {
  it.each([
    ["pnpm-turbo", { route: 4, endpoint: 2, middleware: 0 }],
    ["adapters", { route: 4, endpoint: 7, middleware: 3 }],
  ] as const)("%s", async (name, counts) => {
    const fromRecipe = await routesOf(name, [recipeAdapter]);
    const fromBuiltIn = await routesOf(name, [tanstackRoutesAdapter, honoAdapter]);
    const kinds = (JSON.parse(fromRecipe) as { nodes: { kind: string }[] }).nodes.map((n) => n.kind);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect({ route: count("route"), endpoint: count("endpoint"), middleware: count("middleware") }).toEqual(
      counts,
    );
    expect(fromRecipe).toBe(fromBuiltIn);
  });
});

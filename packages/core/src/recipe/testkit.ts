import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../types.js";

// Shared by the recipe tests: a small committed repo, indexed on its own with the recipe in it.
const helperPath = "../../test/helpers/fixture.js";
export interface TestRepo {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helper = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFiles: (files: Record<string, string>, repo?: string) => Promise<TestRepo>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export async function makeRepo(files: Record<string, string>, repo = "repo"): Promise<TestRepo> {
  const r = await helper.materializeFiles(files, repo);
  cleanups.push(() => r.cleanup());
  return r;
}

export function pathsFor(dir: string): GantryPaths {
  const data = mkdtempSync(join(tmpdir(), "gantry-recipe-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  return resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
}

export interface Graph {
  nodes: AdapterNodeRecord[];
  edges: EdgeRecord[];
}

/** Indexes a repo (main layer, HEAD recipe) and returns its adapter nodes and edges. */
export async function indexGraph(
  dir: string,
  opts: { layer?: "main" | "working"; adapters?: Parameters<typeof indexRepo>[1]["adapters"] } = {},
): Promise<Graph & { recipeNotes: string[] }> {
  const paths = pathsFor(dir);
  const r = await indexRepo(paths, { layer: opts.layer ?? "main", adapters: opts.adapters });
  const store = openStore(paths.dbPath);
  try {
    const g = dumpGraph(store);
    return {
      nodes: (g.adapterNodes ?? []) as AdapterNodeRecord[],
      edges: g.edges as EdgeRecord[],
      recipeNotes: r.recipeNotes,
    };
  } finally {
    store.close();
  }
}

/** The reference recipe committed with `fixtures/adapters` (Hono and TanStack Router rules), as text. */
export const adaptersRecipeText = (): string =>
  readFileSync(join(import.meta.dirname, "../../../../fixtures/adapters/.gantry/recipe.json"), "utf8");

export const endpointLabels = (g: Graph): string[] =>
  g.nodes
    .filter((n) => n.kind === "endpoint")
    .map((n) => n.label)
    .sort();

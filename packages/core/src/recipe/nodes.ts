import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeAdapter } from "../adapters/recipe.js";
import { indexRepo } from "../indexer.js";
import type { GantryPaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { parseRecipe } from "./load.js";

/** What the check can list: the kinds of node a recipe makes, and the reads and writes between code and tables. */
export const RECIPE_NODE_KINDS = ["route", "endpoint", "middleware", "table", "read", "write"] as const;
export type RecipeNodeKind = (typeof RECIPE_NODE_KINDS)[number];

export interface RecipeNodeEntry {
  kind: RecipeNodeKind;
  /** The label of the node (`GET /users/:id`, a table name, a route id); for a read or write the table's label. */
  label: string;
  /** Repo-relative path of the file the node (or the read or write) is in. */
  file: string;
  /** 1-based line, or null when the node does not record one. */
  line: number | null;
  /** For a read or write: the symbol or file that holds the code. */
  in?: string;
}

export interface RecipeNodes {
  /** Entries per kind in full, before the limit. */
  totals: Record<RecipeNodeKind, number>;
  /** At most `limit` entries per kind, in index order (sorted by file, line, label). */
  entries: RecipeNodeEntry[];
  /** The limit that was applied. */
  limit: number;
}

export const DEFAULT_NODE_LIMIT = 20;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** `path:line` evidence of a read or write edge. */
function splitEvidence(ev: string): { file: string; line: number | null } {
  const i = ev.lastIndexOf(":");
  const line = i > 0 ? Number(ev.slice(i + 1)) : Number.NaN;
  return Number.isInteger(line) ? { file: ev.slice(0, i), line } : { file: ev, line: null };
}

const byPlace = (a: RecipeNodeEntry, b: RecipeNodeEntry): number =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : (a.line ?? 0) - (b.line ?? 0) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/**
 * The nodes a recipe text produces in this repository, from the index itself: the recipe adapter runs over the
 * working tree through `indexRepo` into a store in memory, with the recipe given here in place of the one on disk, so
 * what is listed is what an index run with this recipe stores (spec section 10). Nothing is written to the repo or to
 * the index; the parse cache goes to a temporary directory that is removed after.
 */
export async function listRecipeNodes(
  paths: GantryPaths,
  text: string,
  opts: { limit?: number } = {},
): Promise<RecipeNodes> {
  const limit = opts.limit ?? DEFAULT_NODE_LIMIT;
  const totals = Object.fromEntries(RECIPE_NODE_KINDS.map((k) => [k, 0])) as Record<RecipeNodeKind, number>;
  const loaded = parseRecipe(text);
  if (!loaded.recipe) return { totals, entries: [], limit };

  const tmp = mkdtempSync(join(tmpdir(), "gantry-recipe-check-"));
  const store = openStore(":memory:");
  const all: RecipeNodeEntry[] = [];
  try {
    await indexRepo(
      { ...paths, dataDir: tmp },
      { layer: "working", adapters: [recipeAdapter], recipe: loaded, store },
    );
    const pathOf = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
    const nodes = store.effectiveAdapterNodes();
    const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
    const symbolName = new Map(store.effectiveSymbols().map((s) => [s.id, s.name]));
    for (const n of nodes) {
      if (n.kind !== "route" && n.kind !== "endpoint" && n.kind !== "middleware" && n.kind !== "table")
        continue;
      const file =
        (typeof n.data.file === "string" ? n.data.file : undefined) ??
        (typeof n.data.path === "string" && n.kind === "route" ? n.data.path : undefined) ??
        pathOf.get(n.fileId) ??
        n.fileId;
      all.push({ kind: n.kind, label: n.label, file, line: num(n.data.line) });
    }
    for (const e of store.effectiveEdges()) {
      if (e.kind !== "reads" && e.kind !== "writes") continue;
      const label = labelOf.get(e.dst);
      if (label === undefined) continue;
      const holder = symbolName.get(e.src) ?? pathOf.get(e.src) ?? e.src;
      for (const ev of e.evidence.length > 0 ? e.evidence : [pathOf.get(e.fileId) ?? e.fileId]) {
        const at = splitEvidence(ev);
        all.push({
          kind: e.kind === "reads" ? "read" : "write",
          label,
          file: at.file,
          line: at.line,
          in: holder,
        });
      }
    }
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  all.sort((a, b) => byPlace(a, b));
  const entries: RecipeNodeEntry[] = [];
  const shown = Object.fromEntries(RECIPE_NODE_KINDS.map((k) => [k, 0])) as Record<RecipeNodeKind, number>;
  for (const e of all) {
    totals[e.kind]++;
    if (shown[e.kind] < limit) {
      shown[e.kind]++;
      entries.push(e);
    }
  }
  entries.sort((a, b) => RECIPE_NODE_KINDS.indexOf(a.kind) - RECIPE_NODE_KINDS.indexOf(b.kind));
  return { totals, entries, limit };
}

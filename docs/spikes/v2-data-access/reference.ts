// Reference output: indexes a fixture with today's indexer and returns its table nodes and reads and writes edges
// (the Drizzle adapter's output), for comparison with the Drizzle recipe.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpGraph, indexRepo } from "../../../packages/core/src/indexer.js";
import { resolvePaths } from "../../../packages/core/src/paths/index.js";
import { openStore } from "../../../packages/core/src/store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../../../packages/core/src/types.js";

export interface RefGraph {
  nodes: AdapterNodeRecord[];
  edges: EdgeRecord[];
  files: { id: string; path: string }[];
}

/** Copies `fixtureDir` to a temp git repo, indexes it (main layer), returns table nodes and reads and writes edges. */
export async function referenceGraph(fixtureDir: string): Promise<RefGraph> {
  const dir = mkdtempSync(join(tmpdir(), "spike-data-fx-"));
  const data = mkdtempSync(join(tmpdir(), "spike-data-store-"));
  try {
    cpSync(fixtureDir, dir, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git(["init", "-b", "main"]);
    git(["-c", "user.name=f", "-c", "user.email=f@example.invalid", "add", "-A", "-f"]);
    git([
      "-c",
      "user.name=f",
      "-c",
      "user.email=f@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fx",
    ]);
    const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const store = openStore(paths.dbPath);
    try {
      const g = dumpGraph(store);
      return {
        nodes: ((g.adapterNodes ?? []) as AdapterNodeRecord[]).filter((n) => n.kind === "table"),
        edges: (g.edges as EdgeRecord[]).filter((e) => e.kind === "reads" || e.kind === "writes"),
        files: (g.files as { id: string; path: string }[]).map((f) => ({ id: f.id, path: f.path })),
      };
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}

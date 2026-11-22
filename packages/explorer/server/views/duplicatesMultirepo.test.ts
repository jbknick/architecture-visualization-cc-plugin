import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GantryConfig,
  indexRepo,
  loadConfigForDb,
  openStore,
  rebuildSimilarEdges,
  resolvePaths,
  type Store,
} from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import type { DuplicatesResult } from "./duplicates.js";

// The helper lives in core's test folder, outside any tsconfig rootDir, so load it dynamically by path.
interface MaterializedMultirepo {
  repos: { web: string; api: string };
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeMultirepo } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<MaterializedMultirepo>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function view(): Promise<DuplicatesResult> {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-view-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(mr.repos.web, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store: Store = openStore(paths.dbPath, { repo: paths.repo });
  cleanups.push(() => store.close());
  const config: GantryConfig = loadConfigForDb(paths.dbPath, { HOME: data });
  await rebuildSimilarEdges(store, { config, tiers: ["exact", "near"] });
  const ctx = { store, paths, config };
  return handleApi(ctx, "/api/view/duplicates", new URLSearchParams()) as DuplicatesResult;
}

describe("duplicates view of a workspace of two repos", () => {
  it("groups the copies across repos, names each member's repo and counts the group in crossRepo", async () => {
    const r = await view();
    expect(r.summary).toMatchObject({ clusters: 1, functions: 2, crossRepo: 1 });
    const [c] = r.clusters;
    expect(c?.repos).toEqual(["acme/api", "web"]);
    expect(c?.members.map((m) => [m.repo, m.path])).toEqual(
      expect.arrayContaining([
        ["acme/api", "apps/server/src/slug.ts"],
        ["web", "src/lib/slug.ts"],
      ]),
    );
    const other = c?.members.find((m) => !m.keep);
    expect(other?.advice?.situation).toBe(7);
  });
});

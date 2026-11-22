import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, loadConfigForDb, openStore, resolvePaths, type Store } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import type { ViewResult } from "../types.js";

interface Materialized {
  dir?: string;
  repos?: { web: string };
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeLinkingRepos, materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeLinkingRepos: () => Promise<Materialized>;
  materializeFixture: (name: string) => Promise<Materialized>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function view(m: Materialized, root: string, id: string, query: Record<string, string>) {
  cleanups.push(() => m.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-featurepath-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(root, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store: Store = openStore(paths.dbPath, { repo: paths.repo });
  cleanups.push(() => store.close());
  const config = loadConfigForDb(paths.dbPath, { HOME: data });
  return handleApi({ store, paths, config }, `/api/view/${id}`, new URLSearchParams(query)) as ViewResult & {
    nodes: { id: string; kind: string; repo?: string }[];
  };
}

describe("feature path across repos", () => {
  it("draws a page, its endpoint, handler and table from two repos, each node naming its repo", async () => {
    const m = await materializeLinkingRepos();
    const out = await view(m, m.repos?.web as string, "feature-path", { focus: "/invoices/$id" });
    const kinds = new Map(out.nodes.map((n) => [n.id, n.kind]));
    expect(kinds.get("route:web:.:/invoices/$id")).toBe("route");
    expect(kinds.get("ep:billing:.:GET /invoices/:id")).toBe("endpoint");
    expect(kinds.get("table:billing:invoices")).toBe("table");
    for (const n of out.nodes) expect(n.repo, n.id).toBe(n.id.split(":")[1]);
    expect(new Set(out.nodes.map((n) => n.repo))).toEqual(new Set(["web", "billing"]));
  });

  it("links a page of one repo to the endpoint of another in the page and table views", async () => {
    const m = await materializeLinkingRepos();
    const pages = (await view(m, m.repos?.web as string, "page-api", {})) as unknown as {
      edges: { src: string; dst: string }[];
    };
    expect(pages.edges.map((e) => `${e.src} -> ${e.dst}`)).toEqual([
      "route:web:.:/invoices/$id -> ep:billing:.:GET /invoices/:id",
      "route:web:.:/orders/$id -> ep:users-api:.:GET /api/orders/:id",
      "route:web:.:/users/$id -> ep:users-api:.:GET /api/users/:id",
    ]);
  });

  it("adds no repo with one repo", async () => {
    const m = await materializeFixture("adapters");
    const out = await view(m, m.dir as string, "feature-path", { focus: "/posts/$postId" });
    expect(out.nodes.length).toBeGreaterThan(1);
    for (const n of out.nodes) expect(n, n.id).not.toHaveProperty("repo");
  });
});

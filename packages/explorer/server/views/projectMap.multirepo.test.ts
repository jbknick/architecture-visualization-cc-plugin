import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, loadConfigForDb, openStore, resolvePaths, type Store } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";

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

async function setup() {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-map-mr-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(mr.repos.web, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store: Store = openStore(paths.dbPath, { repo: paths.repo });
  cleanups.push(() => store.close());
  const config = loadConfigForDb(paths.dbPath, { HOME: data });
  return { store, paths, config };
}

const get = (ctx: Awaited<ReturnType<typeof setup>>, query: string) =>
  handleApi(ctx, "/api/view/project-map", new URLSearchParams(query)) as {
    nodes: { id: string; kind: string; label: string; parent?: string }[];
    edges: { id: string; src: string; dst: string; kind: string; weight: number; crossRepo?: boolean }[];
  };

describe("project map of a workspace of two repos", () => {
  it("puts every workspace under its repo, with one repo node per repo", async () => {
    const ctx = await setup();
    const r = get(ctx, "level=workspaces");
    expect(r.nodes.filter((n) => n.kind === "repo").map((n) => n.id)).toEqual(["repo:acme/api", "repo:web"]);
    const parentOf = Object.fromEntries(r.nodes.map((n) => [n.label, n.parent]));
    expect(parentOf["mr-web"]).toBe("repo:web");
    expect(parentOf["@mr/contracts"]).toBe("repo:acme/api");
    expect(parentOf["mr-server"]).toBe("repo:acme/api");
    expect(parentOf["repo:web"]).toBeUndefined();
  });

  it("draws the @mr/contracts dependency between the workspaces, flagged crossRepo", async () => {
    const ctx = await setup();
    const cross = get(ctx, "level=workspaces").edges.filter((e) => e.crossRepo);
    expect(cross.map((e) => `${e.src}>${e.dst}`)).toEqual(["ws:web:.>ws:acme/api:@mr/contracts"]);
    expect(get(ctx, "level=files").edges.filter((e) => e.crossRepo).length).toBe(1);
  });

  it("has a repos level of the two repos and one repo-to-repo edge", async () => {
    const ctx = await setup();
    const r = get(ctx, "level=repos");
    expect(r.nodes.map((n) => n.id)).toEqual(["repo:acme/api", "repo:web"]);
    expect(r.edges).toMatchObject([
      { src: "repo:web", dst: "repo:acme/api", kind: "imports", weight: 1, crossRepo: true },
    ]);
  });

  it("filters by repos", async () => {
    const ctx = await setup();
    const r = get(ctx, "level=workspaces&filters=repos=web");
    expect(r.nodes.map((n) => n.id)).toEqual(["repo:web", "ws:web:."]);
    expect(r.edges).toEqual([]);
    const both = get(ctx, "level=repos&filters=repos=web|acme/api");
    expect(both.nodes).toHaveLength(2);
  });

  it("reports the repos in /api/meta", async () => {
    const ctx = await setup();
    expect((handleApi(ctx, "/api/meta", new URLSearchParams()) as { repos: string[] }).repos).toEqual([
      "acme/api",
      "web",
    ]);
  });
});

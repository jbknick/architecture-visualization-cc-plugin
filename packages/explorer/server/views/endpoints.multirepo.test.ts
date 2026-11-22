import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, loadConfigForDb, openStore, resolvePaths, type Store } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";

interface Materialized {
  dir?: string;
  repos?: { web: string; api: string };
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeMultirepo, materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<Materialized>;
  materializeFixture: (name: string) => Promise<Materialized>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function endpoints(m: Materialized, root: string) {
  cleanups.push(() => m.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-endpoints-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(root, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store: Store = openStore(paths.dbPath, { repo: paths.repo });
  cleanups.push(() => store.close());
  const config = loadConfigForDb(paths.dbPath, { HOME: data });
  return handleApi({ store, paths, config }, "/api/view/endpoints", new URLSearchParams()) as {
    nodes: { id: string; kind: string; repo?: string }[];
  };
}

describe("endpoints view labels", () => {
  it("names the repo of every endpoint and handler when the store holds several repos", async () => {
    const m = await materializeMultirepo();
    const out = await endpoints(m, m.repos?.web as string);
    const ep = out.nodes.find((n) => n.kind === "endpoint");
    expect(ep?.id).toBe("ep:acme/api:mr-server:GET /api/posts");
    expect(ep?.repo).toBe("acme/api");
    expect(out.nodes.length).toBeGreaterThan(1);
    for (const n of out.nodes) expect(n.repo, n.id).toBe(n.id.split(":")[1]);
  });

  it("adds no repo with one repo", async () => {
    const m = await materializeFixture("adapters");
    const out = await endpoints(m, m.dir as string);
    expect(out.nodes.some((n) => n.kind === "endpoint")).toBe(true);
    for (const n of out.nodes) expect(n, n.id).not.toHaveProperty("repo");
  });
});

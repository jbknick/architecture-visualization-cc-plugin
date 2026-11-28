import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowseTargetError, browse, catalogFileFor, catalogKey, writeCatalog } from "../catalog/index.js";
import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import { type Embedder, ensureVecTables, putVectors, vecAvailable } from "../embed/index.js";
import { indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import { ftsSearch } from "./fts.js";
import { hybridSearch } from "./hybrid.js";
import { nodeInfo } from "./node.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedMultirepo {
  root: string;
  repos: { web: string; api: string };
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeMultirepo } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<MaterializedMultirepo>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Indexes the two-repo fixture and opens the store as seen from `from`. */
async function open(from: "web" | "api") {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-mr-search-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const env = { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const paths = resolvePaths(mr.repos[from], env);
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath, { repo: paths.repo });
  cleanups.push(() => store.close());
  return { store, paths };
}

describe("search across the repos of a workspace", () => {
  it("from web, finds a function that exists only in acme/api, labeled with its repo", async () => {
    const { store } = await open("web");
    const hits = ftsSearch(store, "computeRetryDelay");
    expect(hits[0]).toMatchObject({ name: "computeRetryDelay", repo: "acme/api" });
    expect(ftsSearch(store, "computeRetryDelay", { repo: "web" })).toEqual([]);
    expect(ftsSearch(store, "computeRetryDelay", { repo: "acme/api" })[0]?.repo).toBe("acme/api");
    expect(ftsSearch(store, "computeRetryDelay", { repo: "nope" })).toEqual([]);
  });

  it("from api, finds a function that exists only in web", async () => {
    const { store } = await open("api");
    expect(ftsSearch(store, "debounceInput")[0]).toMatchObject({ name: "debounceInput", repo: "web" });
  });

  it("hybrid search labels and filters by repo too", async () => {
    const { store } = await open("web");
    const hits = await hybridSearch(store, "computeRetryDelay");
    expect(hits[0]).toMatchObject({ name: "computeRetryDelay", repo: "acme/api" });
    expect(await hybridSearch(store, "computeRetryDelay", { repo: "web" })).toEqual([]);
    expect((await hybridSearch(store, "debounceInput", { repo: "web" }))[0]?.repo).toBe("web");
  });

  it("a meaning-only search limited to one repo still fills up when other vectors are nearer", async () => {
    const { store } = await open("web");
    if (!vecAvailable(store)) return;
    const dim = 32;
    const embedder: Embedder = {
      dim,
      modelId: "fake/test-model",
      available: true,
      async embed(texts) {
        return texts.map(() => Float32Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)));
      },
    };
    ensureVecTables(store, dim, embedder.modelId);
    const at = (cosine: number, axis: number) =>
      Float32Array.from({ length: dim }, (_, i) =>
        i === 0 ? cosine : i === axis ? Math.sqrt(1 - cosine * cosine) : 0,
      );
    // 60 vectors nearer than any function of acme/api (they stand for functions of other repos), then the real ones.
    const nearer = Array.from({ length: 60 }, (_, n) => ({
      contentKey: `other-${n}`,
      vector: at(0.99, 1 + (n % 30)),
    }));
    const real = store
      .effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })
      .filter((s) => s.exactHash !== "")
      .map((s, n) => ({ contentKey: contentKey(s.exactHash), vector: at(0.8, 1 + (n % 30)) }));
    putVectors(store, "vec_descriptions", [...nearer, ...real]);
    const hits = await hybridSearch(store, "zzzz qqqq", { embedder, repo: "acme/api" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.repo === "acme/api")).toBe(true);
  });

  it("nodeInfo names the repo, and a path means the file of the repo the command runs in", async () => {
    const { store } = await open("web");
    expect(nodeInfo(store, "apps/server/src/retry.ts")?.repo).toBe("acme/api");
    expect(nodeInfo(store, "src/lib/only-in-web.ts")?.repo).toBe("web");
    expect(nodeInfo(store, "sym:acme/api:apps/server/src/retry.ts#computeRetryDelay")?.repo).toBe("acme/api");
  });
});

describe("browse and the catalog across the repos of a workspace", () => {
  it("lists the repos at the top, then a repo's workspaces, then paths of the repo the command runs in", async () => {
    const { store } = await open("web");
    const top = browse(store, ".");
    expect(top.items.map((i) => [i.id, i.kind])).toEqual([
      ["repo:acme/api", "repo"],
      ["repo:web", "repo"],
    ]);
    expect(top.items.every((i) => (i.count ?? 0) > 0)).toBe(true);
    expect(browse(store, "repo:acme/api").items.map((i) => [i.id, i.kind])).toEqual([
      ["ws:acme/api:.", "workspace"],
      ["ws:acme/api:@mr/contracts", "workspace"],
      ["ws:acme/api:mr-server", "workspace"],
    ]);
    expect(() => browse(store, "repo:nope")).toThrow(BrowseTargetError);
    expect(browse(store, "src").items.map((i) => i.name)).toEqual(["lib", "pages"]);
    expect(browse(store, "ws:acme/api:mr-server").items.map((i) => i.name)).toContain("src");
  });

  it("keeps the catalog files of repos whose names are prefixes of each other apart", () => {
    const a = catalogFileFor(catalogKey("acme", "api/src"));
    const b = catalogFileFor(catalogKey("acme/api", "src"));
    expect(a).toBe("acme/api/src.md");
    expect(b).toBe("acme%2Fapi/src.md");
    expect(catalogFileFor(catalogKey("acme/api", ""))).toBe("acme%2Fapi/_root.md");
    expect(catalogFileFor(catalogKey("a%2Fb", "x"))).not.toBe(catalogFileFor(catalogKey("a/b", "x")));
  });

  it("writes catalog files per repo", async () => {
    const { store, paths } = await open("web");
    writeCatalog(store, paths);
    const retry = join(paths.catalogDir, "acme%2Fapi/apps/server/src.md");
    expect(readFileSync(retry, "utf8")).toContain("- computeRetryDelay signature");
    expect(existsSync(join(paths.catalogDir, "web/src/lib.md"))).toBe(true);
    expect(existsSync(join(paths.catalogDir, "apps"))).toBe(false);
    expect(readFileSync(join(paths.catalogDir, "INDEX.md"), "utf8")).toContain(
      "catalog acme%2Fapi/apps/server.md",
    );
  });
});

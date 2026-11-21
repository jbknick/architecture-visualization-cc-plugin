import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "./indexer.js";
import { type GantryPaths, resolvePaths } from "./paths/index.js";
import { openStore } from "./store/index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
interface MaterializedMultirepo {
  root: string;
  repos: { web: string; api: string };
  git: (repo: "web" | "api", args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../test/helpers/fixture.js";
const { materializeMultirepo, materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeMultirepo: () => Promise<MaterializedMultirepo>;
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const mr = await materializeMultirepo();
  cleanups.push(() => mr.cleanup());
  const data = mkdtempSync(join(tmpdir(), "gantry-mr-data-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const env = { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const web = resolvePaths(mr.repos.web, env);
  const api = resolvePaths(mr.repos.api, env);
  return { mr, data, env, web, api };
}

type Dump = ReturnType<typeof dumpGraph>;
function dump(paths: GantryPaths): Dump {
  const s = openStore(paths.dbPath, { repo: paths.repo });
  try {
    return dumpGraph(s);
  } finally {
    s.close();
  }
}
const text = (d: Dump): string => `${JSON.stringify(d, null, 2)}\n`;
const sha = (d: Dump): string => createHash("sha256").update(text(d)).digest("hex");
type Row = { id: string; repo: string };

describe("a workspace of two repos", () => {
  it("resolves both repos to one data dir under workspaces/", async () => {
    const { web, api, data } = await setup();
    expect(web.dataDir).toBe(api.dataDir);
    expect(web.dataDir.startsWith(join(data, "workspaces"))).toBe(true);
    expect([web.repo, api.repo]).toEqual(["web", "acme/api"]);
    expect(web.workspace.repos.map((r) => r.name)).toEqual(["acme/api", "web"]);
  });

  it("indexes both repos into one store; every workspace and file row names its repo", async () => {
    const { web } = await setup();
    const r = await indexRepo(web, { layer: "main" });
    expect(r.parseErrors).toEqual([]);
    const d = dump(web);
    expect(d.repos).toEqual([{ name: "acme/api" }, { name: "web" }]);
    const files = d.files as Row[];
    const workspaces = d.workspaces as Row[];
    expect([...new Set(files.map((f) => f.repo))]).toEqual(["acme/api", "web"]);
    expect([...new Set(workspaces.map((w) => w.repo))]).toEqual(["acme/api", "web"]);
    for (const f of files) expect(f.id.startsWith(`file:${f.repo}:`)).toBe(true);
    for (const w of workspaces) expect(w.id.startsWith(`ws:${w.repo}:`)).toBe(true);
    // The api repo is a pnpm workspace, the web repo a single package.
    expect(workspaces.map((w) => w.id)).toEqual([
      "ws:acme/api:.",
      "ws:acme/api:@mr/contracts",
      "ws:acme/api:mr-server",
      "ws:web:.",
    ]);
    const paths = files.map((f) => f.id);
    expect(paths).toContain("file:web:src/pages/posts.tsx");
    expect(paths).toContain("file:acme/api:apps/server/src/index.ts");
    expect(paths).toContain("file:acme/api:packages/contracts/src/index.ts");
    // The dump has no local path of the machine.
    expect(text(d)).not.toContain(web.workspace.repos[0]?.root as string);
  });

  it("gives no two rows the same id, even where both repos hold the same path", async () => {
    const { mr, web } = await setup();
    // The same path in both repos (untracked files are indexed too).
    for (const dir of [mr.repos.web, mr.repos.api]) {
      mkdirSync(join(dir, "shared"), { recursive: true });
      writeFileSync(
        join(dir, "shared", "util.ts"),
        "export function same(a: number): number {\n  return a + 1;\n}\n",
      );
    }
    await indexRepo(web, { layer: "main" });
    const d = dump(web);
    for (const key of ["workspaces", "files", "symbols"] as const) {
      const ids = (d[key] as Row[]).map((x) => x.id);
      expect(new Set(ids).size, key).toBe(ids.length);
    }
    const ids = (d.symbols as { id: string }[]).map((x) => x.id);
    expect(ids).toContain("sym:web:shared/util.ts#same");
    expect(ids).toContain("sym:acme/api:shared/util.ts#same");
    const files = (d.files as (Row & { path: string })[]).filter((f) => f.path === "shared/util.ts");
    expect(files.map((f) => f.id).sort()).toEqual([
      "file:acme/api:shared/util.ts",
      "file:web:shared/util.ts",
    ]);
  });

  it("finds the Hono endpoint of the api repo and keeps the stored symbols of each repo apart", async () => {
    const { web } = await setup();
    await indexRepo(web, { layer: "main" });
    const d = dump(web);
    const nodes = (d.adapterNodes ?? []) as { id: string; kind: string }[];
    expect(nodes.filter((n) => n.kind === "endpoint").map((n) => n.id)).toEqual([
      "ep:acme/api:mr-server:GET /api/posts",
    ]);
    const syms = (d.symbols as { id: string }[]).map((s) => s.id);
    expect(syms).toContain("sym:web:src/lib/slug.ts#makeSlug");
    expect(syms).toContain("sym:acme/api:apps/server/src/slug.ts#toSlug");
  });

  it("gives the same dump whichever repo the index runs from", async () => {
    const { web, api } = await setup();
    await indexRepo(web, { layer: "main" });
    const fromWeb = sha(dump(web));
    await indexRepo(api, { layer: "main" });
    expect(sha(dump(api))).toBe(fromWeb);
    // A second run changes nothing, byte for byte.
    await indexRepo(web, { layer: "main" });
    expect(sha(dump(web))).toBe(fromWeb);
  });

  it("matches the committed snapshot and is the same in a second fresh data dir", async () => {
    const { web } = await setup();
    await indexRepo(web, { layer: "main" });
    const first = text(dump(web));
    await expect(first).toMatchFileSnapshot("__snapshots__/dump-multirepo.json");
    const other = mkdtempSync(join(tmpdir(), "gantry-mr-data2-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const again = resolvePaths(web.root, { HOME: join(other, "home"), CLAUDE_PLUGIN_DATA: other });
    expect(again.dataDir).not.toBe(web.dataDir);
    await indexRepo(again, { layer: "main" });
    expect(text(dump(again))).toBe(first);
  });

  it("records each repo's root and head commit, and leaves the repos clean", async () => {
    const { mr, web } = await setup();
    await indexRepo(web, { layer: "main" });
    const s = openStore(web.dbPath, { repo: web.repo });
    try {
      const repos = s.listRepos();
      expect(repos.map((x) => x.name)).toEqual(["acme/api", "web"]);
      expect(repos.find((x) => x.name === "web")?.headSha).toBe(mr.git("web", ["rev-parse", "HEAD"]).trim());
      expect(repos.find((x) => x.name === "acme/api")?.headSha).toBe(
        mr.git("api", ["rev-parse", "HEAD"]).trim(),
      );
      expect(repos.every((x) => x.root !== null && existsSync(x.root))).toBe(true);
      expect(s.repo()).toBe("web");
    } finally {
      s.close();
    }
    expect(mr.git("web", ["status", "--porcelain"])).toBe("");
    expect(mr.git("api", ["status", "--porcelain"])).toBe("");
  });

  it("removes the rows of a repo that leaves the workspace file on the next index", async () => {
    const { mr, env, web } = await setup();
    await indexRepo(web, { layer: "main" });
    expect((dump(web).files as Row[]).some((f) => f.repo === "acme/api")).toBe(true);
    writeFileSync(join(mr.root, "gantry-workspace.json"), JSON.stringify({ repos: [{ path: "./web" }] }));
    const alone = resolvePaths(mr.repos.web, env);
    expect(alone.workspace.repos.map((r) => r.name)).toEqual(["web"]);
    expect(alone.dataDir).toBe(web.dataDir);
    await indexRepo(alone, { layer: "main" });
    const d = dump(alone);
    expect(d.repos).toEqual([{ name: "web" }]);
    expect((d.files as Row[]).filter((f) => f.repo === "acme/api")).toEqual([]);
    expect((d.workspaces as Row[]).filter((w) => w.repo === "acme/api")).toEqual([]);
    expect((d.symbols as { id: string }[]).filter((x) => x.id.includes("acme/api"))).toEqual([]);
    expect((d.edges as { src: string; dst: string }[]).filter((e) => e.src.includes("acme/api"))).toEqual([]);
    expect(d.adapterNodes).toBeUndefined();
    const s = openStore(alone.dbPath, { repo: alone.repo });
    try {
      const fts = s.db.prepare("SELECT symbol_id FROM fts_symbols").all() as { symbol_id: string }[];
      expect(fts.length).toBeGreaterThan(0);
      expect(fts.every((r) => r.symbol_id.startsWith("sym:web:"))).toBe(true);
    } finally {
      s.close();
    }
  });

  it("a targeted run for one repo leaves the other repo's rows alone", async () => {
    const { web, api } = await setup();
    await indexRepo(web, { layer: "main" });
    const before = dump(web);
    const r = await indexRepo(api, { layer: "working", files: ["apps/server/src/slug.ts"] });
    expect(r.files).toBeLessThanOrEqual(1);
    expect(dump(web)).toEqual(before);
    const s = openStore(web.dbPath, { repo: web.repo });
    try {
      s.clearWorking();
    } finally {
      s.close();
    }
  });
});

describe("a repo with no workspace file", () => {
  it("is a workspace of one in repos/<worktreeHash>, and its dump only gains repo fields and repos", async () => {
    const fx = await materializeFixture("single-pkg");
    cleanups.push(() => fx.cleanup());
    const data = mkdtempSync(join(tmpdir(), "gantry-mr-one-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    expect(paths.workspace.file).toBeNull();
    expect(paths.dataDir).toBe(join(data, "repos", paths.worktreeHash));
    await indexRepo(paths, { layer: "main" });
    const d = dump(paths);
    expect(d.repos).toEqual([{ name: "single-pkg" }]);
    expect((d.files as Row[]).every((f) => f.repo === "single-pkg")).toBe(true);
    expect((d.workspaces as Row[]).map((w) => w.id)).toEqual(["ws:single-pkg:."]);
  });
});

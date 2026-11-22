import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveProjectConfig } from "../config/index.js";
import { dumpGraph, indexRepo } from "../indexer.js";
import { ensureDataDir, type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { EdgeRecord } from "../types.js";
import { SCIP_EDGE_KINDS } from "./index.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const scipFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/scip/pnpm-turbo.scip",
);

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function setup(): Promise<{ fx: MaterializedFixture; paths: GantryPaths; fresh: () => GantryPaths }> {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const fresh = (): GantryPaths => {
    const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
    dataDirs.push(data);
    return resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  };
  return { fx, paths: fresh(), fresh };
}

function dump(paths: GantryPaths): ReturnType<typeof dumpGraph> {
  const s = openStore(paths.dbPath);
  try {
    return dumpGraph(s);
  } finally {
    s.close();
  }
}

const edgesOf = (d: ReturnType<typeof dumpGraph>): EdgeRecord[] => d.edges as EdgeRecord[];
const inferredKinds = (e: EdgeRecord): boolean => SCIP_EDGE_KINDS.includes(e.kind);

describe("precise mode on the pnpm-turbo fixture", () => {
  it("reports what it read and writes its edges with source scip", async () => {
    const { paths } = await setup();
    const r = await indexRepo(paths, { layer: "main", scip: scipFixture });
    // 23 documents in the index, one of them (routeTree.gen.ts) a file Gantry does not index.
    expect(r.scip).toEqual({ documents: 22, edges: 18, unmapped: 212, stale: 0 });
    const edges = edgesOf(dump(paths));
    expect(edges.filter((e) => e.source === "scip")).toHaveLength(18);
    expect(
      edges.filter((e) => e.source === "scip").every((e) => e.confidence === "high" && e.level === undefined),
    ).toBe(true);
    // A reference to a symbol of another package resolves through the barrel to the definition.
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: "sym:pnpm-turbo:apps/web/src/routes/posts.$postId.tsx#PostPage",
        dst: "sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate",
        kind: "calls",
        source: "scip",
        evidence: ["apps/web/src/routes/posts.$postId.tsx:11"],
      }),
    );
  });

  it("leaves only source scip on the call and type edges of the files the index covers", async () => {
    const { paths } = await setup();
    await indexRepo(paths, { layer: "main", scip: scipFixture });
    const code = edgesOf(dump(paths)).filter((e) => inferredKinds(e) && /\.tsx?$/.test(pathOf(e.fileId)));
    expect(code.length).toBeGreaterThan(0);
    expect(code.every((e) => e.source === "scip")).toBe(true);
  });

  it("is the same dump without the index as before: no edge has a source", async () => {
    const { paths } = await setup();
    const r = await indexRepo(paths, { layer: "main" });
    expect(r.scip).toBeUndefined();
    expect(JSON.stringify(dump(paths))).not.toContain('"source"');
  });

  it("gives byte-identical dumps into two fresh data dirs", async () => {
    const { fresh } = await setup();
    const a = fresh();
    const b = fresh();
    await indexRepo(a, { layer: "main", scip: scipFixture });
    await indexRepo(b, { layer: "main", scip: scipFixture });
    expect(JSON.stringify(dump(a), null, 2)).toBe(JSON.stringify(dump(b), null, 2));
  });

  it("ignores and counts a document whose file changed, and keeps that file's inferred edges", async () => {
    const { fx, paths } = await setup();
    const file = join(fx.dir, "apps/web/src/components/PostList.tsx");
    writeFileSync(file, `// moved down\n${readFileSync(file, "utf8")}`);
    const r = await indexRepo(paths, { layer: "main", scip: scipFixture });
    expect(r.scip).toMatchObject({ documents: 22, stale: 1 });
    const edges = edgesOf(dump(paths));
    const own = edges.filter((e) => inferredKinds(e) && e.fileId.endsWith("PostList.tsx"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.source === undefined)).toBe(true);
    // The other files are still covered.
    expect(edges.some((e) => e.source === "scip" && e.fileId.endsWith("index.tsx"))).toBe(true);
  });

  it("reads precise.scip of the config, relative to the repo root, and a targeted run keeps the edges", async () => {
    const { fx, paths } = await setup();
    copyFileSync(scipFixture, join(fx.dir, "index.scip"));
    ensureDataDir(paths);
    saveProjectConfig(paths, { precise: { scip: "index.scip" } });
    expect(loadConfig(paths).precise).toEqual({ scip: "index.scip" });
    const full = await indexRepo(paths, { layer: "main" });
    expect(full.scip?.edges).toBe(18);
    const before = JSON.stringify(dump(paths));
    // The targeted run writes this file and re-resolves its importers, which must come out with the same edges.
    const targeted = await indexRepo(paths, { layer: "main", files: ["apps/web/src/lib/slug.ts"] });
    expect(targeted.scip).toBeDefined();
    expect(JSON.stringify(dump(paths))).toBe(before);
  });

  it("warns once and keeps the inferred edges when the file the config names is missing", async () => {
    const { paths } = await setup();
    ensureDataDir(paths);
    saveProjectConfig(paths, { precise: { scip: "no-such-dir/missing.scip" } });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await indexRepo(paths, { layer: "main" });
    await indexRepo(paths, { layer: "main", files: ["apps/web/src/lib/slug.ts"] });
    const lines = write.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("SCIP index"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("missing.scip not found; keeping inferred edges");
    expect(r.scip).toBeUndefined();
    expect(JSON.stringify(dump(paths))).not.toContain('"source"');
  });

  it("rejects a file that is not a SCIP index", async () => {
    const { fx, paths } = await setup();
    const bad = join(fx.dir, "bad.scip");
    writeFileSync(bad, Buffer.from([0x12, 0xff, 0x01]));
    await expect(indexRepo(paths, { layer: "main", scip: bad })).rejects.toThrow(/not a readable SCIP index/);
  });
});

const pathOf = (fileId: string): string => fileId.split(":").slice(2).join(":");

import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

const HOUR = 3600 * 1000;
/** Gives a file a modification time `ms` from now. */
const touch = (file: string, ms: number): void => {
  const t = new Date(Date.now() + ms);
  utimesSync(file, t, t);
};

/**
 * The fixture is copied to a temp dir, so its files are newer than the committed index. A copy of the index dated an
 * hour ahead stands for an index made after the checkout, as a user's own indexer makes it.
 */
async function setup(): Promise<{
  fx: MaterializedFixture;
  paths: GantryPaths;
  scip: string;
  fresh: () => GantryPaths;
}> {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-scip-index-"));
  dataDirs.push(data);
  const scip = join(data, "pnpm-turbo.scip");
  copyFileSync(scipFixture, scip);
  touch(scip, HOUR);
  const fresh = (): GantryPaths => {
    const d = mkdtempSync(join(tmpdir(), "gantry-data-"));
    dataDirs.push(d);
    return resolvePaths(fx.dir, { HOME: join(d, "home"), CLAUDE_PLUGIN_DATA: d });
  };
  return { fx, paths: fresh(), scip, fresh };
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
const short = (id: string): string => id.replace("sym:pnpm-turbo:", "").replace("file:pnpm-turbo:", "file ");
const triple = (e: EdgeRecord): string => `${e.kind} ${short(e.src)} -> ${short(e.dst)}`;
const scipTriples = (paths: GantryPaths): string[] =>
  edgesOf(dump(paths))
    .filter((e) => e.source === "scip")
    .map(triple)
    .sort();

describe("precise mode on the pnpm-turbo fixture", () => {
  it("reports what it read and writes exactly these edges, with source scip", async () => {
    const { paths, scip } = await setup();
    const r = await indexRepo(paths, { layer: "main", scip });
    // 23 documents in the index, one of them (routeTree.gen.ts) a file Gantry does not index.
    expect(r.scip).toEqual({ documents: 22, edges: 12, unmapped: 262, otherRefs: 29, stale: 0 });
    // Every edge of the index: a call needs a `(` after the name, a render a `<` before it; a read of a value
    // (the table `posts`, the `Route` const) and an import make none, and a call at the top of a file comes from the file.
    expect(scipTriples(paths)).toEqual(
      [
        "calls apps/api/src/router.ts#router -> packages/db/src/queries.ts#createPost",
        "calls apps/api/src/router.ts#router -> packages/db/src/queries.ts#listPosts",
        "calls apps/web/src/components/PostList.tsx#PostList -> apps/web/src/lib/slug.ts#slugify",
        "calls apps/web/src/routes/posts.$postId.tsx#PostPage -> packages/utils/src/date.ts#formatRelativeDate",
        "calls file apps/api/src/app.ts -> packages/db/src/queries.ts#createPost",
        "calls file apps/api/src/app.ts -> packages/db/src/queries.ts#getPost",
        "calls packages/utils/src/slug.ts#SLUG_VERSION -> packages/utils/src/slug.ts#slugify",
        "renders apps/web/src/routes/index.tsx#HomePage -> apps/web/src/components/PostList.tsx#PostList",
        "renders apps/web/src/routes/index.tsx#HomePage -> packages/ui/src/button.tsx#Button",
        "renders apps/web/src/routes/settings/profile.tsx#ProfilePage -> packages/ui/src/button.tsx#Button",
        "renders apps/web/src/routes/settings/profile.tsx#ProfilePage -> packages/ui/src/card.tsx#Card",
        "uses_hook apps/web/src/components/PostList.tsx#PostList -> apps/web/src/hooks/useDebounce.ts#useDebounce",
      ].sort(),
    );
    const call = edgesOf(dump(paths)).find(
      (e) => e.dst === "sym:pnpm-turbo:packages/utils/src/date.ts#formatRelativeDate",
    );
    expect(call).toMatchObject({
      src: "sym:pnpm-turbo:apps/web/src/routes/posts.$postId.tsx#PostPage",
      kind: "calls",
      source: "scip",
      evidence: ["apps/web/src/routes/posts.$postId.tsx:11"],
    });
    const edges = edgesOf(dump(paths));
    expect(
      edges.filter((e) => e.source === "scip").every((e) => e.confidence === "high" && e.level === undefined),
    ).toBe(true);
  });

  it("leaves only source scip on the call and type edges of the files the index covers", async () => {
    const { paths, scip } = await setup();
    await indexRepo(paths, { layer: "main", scip });
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
    const { fresh, scip } = await setup();
    const a = fresh();
    const b = fresh();
    await indexRepo(a, { layer: "main", scip });
    await indexRepo(b, { layer: "main", scip });
    expect(JSON.stringify(dump(a), null, 2)).toBe(JSON.stringify(dump(b), null, 2));
  });

  it("ignores and counts a document whose definitions moved, and keeps that file's inferred edges", async () => {
    const { fx, paths, scip } = await setup();
    const file = join(fx.dir, "apps/web/src/components/PostList.tsx");
    writeFileSync(file, `// moved down\n${readFileSync(file, "utf8")}`);
    const r = await indexRepo(paths, { layer: "main", scip });
    expect(r.scip).toMatchObject({ documents: 22, stale: 1 });
    const edges = edgesOf(dump(paths));
    const own = edges.filter((e) => inferredKinds(e) && e.fileId.endsWith("PostList.tsx"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.source === undefined)).toBe(true);
    // The other files are still covered.
    expect(edges.some((e) => e.source === "scip" && e.fileId.endsWith("index.tsx"))).toBe(true);
  });

  it("ignores a document whose file was edited after the index, though no definition moved", async () => {
    const { fx, paths, scip } = await setup();
    const file = join(fx.dir, "apps/web/src/components/PostList.tsx");
    const before = readFileSync(file, "utf8");
    // A second call in the body of PostList, on a line that already exists: nothing moves.
    const after = before.replace("{slugify(debounced)}", "{slugify(debounced)}{slugify(query)}");
    expect(after).not.toBe(before);
    writeFileSync(file, after);
    touch(file, 2 * HOUR);
    expect(statSync(file).mtimeMs).toBeGreaterThan(statSync(scip).mtimeMs);
    const r = await indexRepo(paths, { layer: "main", scip });
    expect(r.scip).toMatchObject({ documents: 22, stale: 1 });
    const own = edgesOf(dump(paths)).filter((e) => inferredKinds(e) && e.fileId.endsWith("PostList.tsx"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.source === undefined)).toBe(true);
  });

  it("reads precise.scip of the config, relative to the repo root, and a targeted run keeps the edges", async () => {
    const { fx, paths, scip } = await setup();
    copyFileSync(scip, join(fx.dir, "index.scip"));
    touch(join(fx.dir, "index.scip"), HOUR);
    ensureDataDir(paths);
    saveProjectConfig(paths, { precise: { scip: "index.scip" } });
    expect(loadConfig(paths).precise).toEqual({ scip: "index.scip" });
    const full = await indexRepo(paths, { layer: "main" });
    expect(full.scip?.edges).toBeGreaterThan(0);
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

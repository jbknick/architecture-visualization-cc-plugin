import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const helperPath = "../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

type Name = "single-pkg" | "pnpm-turbo" | "nx";
const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function setup(name: Name) {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
  dataDirs.push(data);
  const env = { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const paths: GantryPaths = resolvePaths(fx.dir, env);
  return { fx, paths };
}

function dump(paths: GantryPaths) {
  const s = openStore(paths.dbPath);
  try {
    return dumpGraph(s);
  } finally {
    s.close();
  }
}

describe("indexRepo + dumpGraph snapshots", () => {
  it.each(["single-pkg", "pnpm-turbo", "nx"] as const)(
    "%s dump matches the committed snapshot",
    async (name) => {
      const { paths } = await setup(name);
      const r = await indexRepo(paths, { layer: "main" });
      expect(r.files).toBeGreaterThan(0);
      expect(r.parseErrors).toEqual([]);
      const json = JSON.stringify(dump(paths), null, 2);
      await expect(`${json}\n`).toMatchFileSnapshot(`__snapshots__/dump-${name}.json`);
      // Re-running changes nothing, byte for byte.
      await indexRepo(paths, { layer: "main" });
      expect(`${JSON.stringify(dump(paths), null, 2)}\n`).toBe(`${json}\n`);
    },
  );

  it("dump has no timestamps and is sorted", async () => {
    const { paths } = await setup("pnpm-turbo");
    await indexRepo(paths, { layer: "main" });
    const g = dump(paths);
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/mtime|indexed_at|ms"/);
    const ids = (xs: unknown[]) => xs.map((x) => (x as { id: string }).id);
    for (const xs of [g.workspaces, g.files, g.symbols]) expect(ids(xs)).toEqual([...ids(xs)].sort());
  });
});

describe("main layer", () => {
  it("sets head_sha and indexed_at, stores depends_on edges, and writes nothing into the repo", async () => {
    const { fx, paths } = await setup("pnpm-turbo");
    const r = await indexRepo(paths, { layer: "main" });
    expect(r.files).toBeGreaterThan(10);
    expect(r.functionLike).toBeGreaterThan(0);
    expect(r.symbols).toBeGreaterThanOrEqual(r.functionLike);
    expect(fx.git(["status", "--porcelain"])).toBe("");
    const s = openStore(paths.dbPath);
    expect(s.getMeta("head_sha")).toBe(fx.git(["rev-parse", "HEAD"]).trim());
    expect(s.getMeta("indexed_at")).toMatch(/^\d{4}-\d\d-\d\dT/);
    const dep = s.effectiveEdges({ kind: ["depends_on"] });
    expect(dep.length).toBeGreaterThan(0);
    for (const e of dep) {
      expect(e.fileId).toMatch(/^file:.*package\.json$/);
      expect(s.effectiveFiles().some((f) => f.id === e.fileId)).toBe(true);
    }
    expect(dep.some((e) => e.src === "ws:@acme/web" && e.dst === "ws:@acme/ui")).toBe(true);
    // FTS has name tokens for symbols.
    const hit = s.db.prepare("SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH 'debounce'").all();
    expect(hit.length).toBeGreaterThan(0);
    s.close();
  });

  it("drops files that disappeared and reindexes after edits", async () => {
    const { fx, paths } = await setup("single-pkg");
    await indexRepo(paths, { layer: "main" });
    fx.git(["rm", "-q", "src/math.ts"]);
    await indexRepo(paths, { layer: "main" });
    const g = dump(paths);
    expect(g.files.some((f) => (f as { path: string }).path === "src/math.ts")).toBe(false);
    expect(g.symbols.some((x) => (x as { fileId: string }).fileId === "file:src/math.ts")).toBe(false);
  });

  it("indexes the same graph from in-memory sources as from disk", async () => {
    const { fx, paths } = await setup("single-pkg");
    const sources = new Map([["src/util/format.ts", "export const formatName = (a: string) => a;\n"]]);
    await indexRepo(paths, { layer: "main", sources });
    const a = dump(paths);
    writeFileSync(join(fx.dir, "src/util/format.ts"), sources.get("src/util/format.ts") as string);
    await indexRepo(paths, { layer: "main" });
    expect(JSON.stringify(dump(paths))).toBe(JSON.stringify(a));
  });
});

describe("fts", () => {
  it("full re-index keeps description-derived fts columns and drops removed symbols", async () => {
    const { fx, paths } = await setup("single-pkg");
    await indexRepo(paths, { layer: "main" });
    const s = openStore(paths.dbPath);
    const id = "sym:src/util/format.ts#formatName";
    s.fts.upsert(id, {
      nameTokens: "format name",
      suggestedName: "",
      path: "src/util/format.ts",
      behavior: "joins names",
      searchTerms: "",
    });
    s.close();
    fx.git(["rm", "-q", "src/math.ts"]);
    await indexRepo(paths, { layer: "main" });
    const s2 = openStore(paths.dbPath);
    const rows = s2.db.prepare("SELECT symbol_id, behavior FROM fts_symbols").all() as {
      symbol_id: string;
      behavior: string;
    }[];
    s2.close();
    expect(rows.find((r) => r.symbol_id === id)?.behavior).toBe("joins names");
    expect(rows.some((r) => r.symbol_id.startsWith("sym:src/math.ts#"))).toBe(false);
    expect(new Set(rows.map((r) => r.symbol_id)).size).toBe(rows.length);
  });
});

describe("working layer", () => {
  it("re-indexing one changed file changes only its rows and edges pointing into it", async () => {
    const { fx, paths } = await setup("single-pkg");
    await indexRepo(paths, { layer: "main" });
    const before = dump(paths);

    const rel = "src/util/format.ts";
    writeFileSync(
      join(fx.dir, rel),
      'export function formatFullName(first: string, last: string): string {\n  return first + " " + last;\n}\n',
    );
    const r = await indexRepo(paths, { layer: "working", files: [rel] });
    expect(r.files).toBeGreaterThanOrEqual(1);
    const after = dump(paths);

    const key = (x: unknown) => JSON.stringify(x);
    const diff = (a: unknown[], b: unknown[]) => {
      const sa = new Set(a.map(key));
      const sb = new Set(b.map(key));
      return { removed: a.filter((x) => !sb.has(key(x))), added: b.filter((x) => !sa.has(key(x))) };
    };

    const files = diff(before.files, after.files);
    expect([...files.removed, ...files.added].map((f) => (f as { path: string }).path)).toEqual([rel, rel]);

    const syms = diff(before.symbols, after.symbols);
    expect(
      [...syms.removed, ...syms.added].every((s) => (s as { fileId: string }).fileId === `file:${rel}`),
    ).toBe(true);
    expect(syms.added.map((s) => (s as { name: string }).name)).toEqual(["formatFullName"]);

    const edges = diff(before.edges, after.edges);
    const touches = (e: unknown) => {
      const x = e as { src: string; dst: string; fileId: string };
      return x.fileId === `file:${rel}` || x.src.includes(rel) || x.dst.includes(rel);
    };
    expect(edges.removed.length).toBeGreaterThan(0);
    expect(edges.removed.every(touches)).toBe(true);
    // Added edges either live in the changed file or are re-resolved edges of its importers.
    for (const e of edges.added as { fileId: string; kind: string }[]) {
      expect(["file:src/util/format.ts", "file:src/greet.ts", "file:src/index.ts"]).toContain(e.fileId);
    }

    // Only the changed file and files importing it got working rows; unrelated files did not.
    const s = openStore(paths.dbPath);
    const working = (s.db.prepare("SELECT id FROM files WHERE layer = 'working'").all() as { id: string }[])
      .map((r) => r.id)
      .sort();
    s.close();
    expect(working).toContain(`file:${rel}`);
    expect(working).not.toContain("file:src/math.ts");
    expect(working).not.toContain("file:src/counter.ts");
    expect(working.length).toBeLessThanOrEqual(3);
  });

  it("writes working rows only for files whose content differs from main", async () => {
    const { fx, paths } = await setup("single-pkg");
    await indexRepo(paths, { layer: "main" });
    await indexRepo(paths, { layer: "working" });
    const s0 = openStore(paths.dbPath);
    expect(s0.db.prepare("SELECT count(*) AS n FROM files WHERE layer = 'working'").get()).toEqual({ n: 0 });
    s0.close();

    writeFileSync(join(fx.dir, "src/math.ts"), "export const sum = (a: number, b: number) => a + b + 0;\n");
    await indexRepo(paths, { layer: "working" });
    const s1 = openStore(paths.dbPath);
    const ids = (s1.db.prepare("SELECT id FROM files WHERE layer = 'working'").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toContain("file:src/math.ts");
    expect(ids).not.toContain("file:src/counter.ts");
    s1.close();

    // Reverting the file clears its working rows.
    fx.git(["checkout", "--", "src/math.ts"]);
    await indexRepo(paths, { layer: "working" });
    const s2 = openStore(paths.dbPath);
    expect(s2.db.prepare("SELECT count(*) AS n FROM files WHERE layer = 'working'").get()).toEqual({ n: 0 });
    s2.close();
  });

  it("marks a deleted file as deleted in the working layer", async () => {
    const { fx, paths } = await setup("single-pkg");
    await indexRepo(paths, { layer: "main" });
    fx.git(["rm", "-q", "src/math.ts"]);
    await indexRepo(paths, { layer: "working", files: ["src/math.ts"] });
    const g = dump(paths);
    expect(g.files.some((f) => (f as { path: string }).path === "src/math.ts")).toBe(false);
  });
});

describe("IndexResult.specifierCounts", () => {
  it("counts each distinct (file, specifier) pair once under its resolution class", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-spec-"));
    const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
    dataDirs.push(dir, data);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "spec", dependencies: { zod: "1.0.0" } }),
    );
    writeFileSync(join(dir, "src/data.json"), "{}\n");
    writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
    writeFileSync(
      join(dir, "src/a.ts"),
      [
        'import { b } from "./b";', // file
        'import zod from "zod";', // external: declared, not installed
        'import fs from "node:fs";', // builtin
        'import v from "virtual:thing";', // virtual
        'import gen from "./dist/out";', // generated: missing, under a built-in exclude
        'import data from "./data.json";', // excluded: exists in the repo but is not indexed
        'import nope from "./missing";', // unresolved
        'import { b as again } from "./b";', // same pair as the first line: counted once
        "export const all = [b, zod, fs, v, gen, data, nope, again];",
        "",
      ].join("\n"),
    );
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    const r = await indexRepo(paths, { layer: "main" });
    expect(r.specifierCounts).toEqual({
      file: 1,
      external: 1,
      builtin: 1,
      virtual: 1,
      generated: 1,
      excluded: 1,
      unresolved: 1,
    });
    expect(r.unresolved.map((u) => u.specifier).sort()).toEqual(["./data.json", "./dist/out", "./missing"]);
  });
});

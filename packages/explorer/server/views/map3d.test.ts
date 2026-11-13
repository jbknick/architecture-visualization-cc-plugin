import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createResolver,
  detectWorkspaces,
  type EdgeRecord,
  hashSymbol,
  isIndexable,
  loadConfig,
  openStore,
  type ParsedFile,
  parseSource,
  resolvePaths,
  type Store,
  type SymbolRecord,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import type { ApiContext, ViewResult } from "../types.js";
import { buildMap3d, isGeneratedPath } from "./map3d.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".claude") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

let tmp: string;
let store: Store;
let ctx: ApiContext;

/** Indexes a fixture repo into the store with core's parser, hasher and resolver (indexRepo is not merged yet). */
function indexFixture(root: string, extra: Record<string, string> = {}): void {
  const config = loadConfig(ctx.paths);
  const workspaces = detectWorkspaces(root, { workspaces: { overrides: {} } });
  store.upsertWorkspaces(workspaces);
  const sources = new Map<string, string>();
  for (const rel of walk(root)) {
    if (isIndexable(rel, config)) sources.set(rel, readFileSync(join(root, rel), "utf8"));
  }
  for (const [rel, src] of Object.entries(extra)) sources.set(rel, src);
  const parsed = new Map<string, ParsedFile>();
  for (const [rel, src] of sources) parsed.set(`file:${rel}`, parseSource(rel, src));
  const resolver = createResolver({ root, workspaces, parsed });
  const wsEdges = resolver.workspaceEdges();
  const seenWs = new Set<string>();
  for (const rel of [...sources.keys()].sort()) {
    const ws = workspaces
      .filter((w) => w.dir === "." || rel.startsWith(`${w.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const pf = parsed.get(`file:${rel}`) as ParsedFile;
    const src = sources.get(rel) as string;
    const symbols: SymbolRecord[] = pf.symbols.map((s) => ({
      id: s.id,
      fileId: pf.fileId,
      name: s.name,
      kind: s.kind,
      exported: s.exported,
      signature: s.signature,
      startLine: s.startLine,
      endLine: s.endLine,
      loc: s.loc,
      complexity: s.complexity,
      stmtCount: s.stmtCount,
      ...hashSymbol(
        src,
        pf.bodies.get(s.id) ?? { start: 0, end: src.length },
        rel.endsWith("x") ? "tsx" : "ts",
      ),
    }));
    const edges: EdgeRecord[] = resolver.edgesForFile(pf.fileId);
    if (ws && !seenWs.has(ws.id)) {
      seenWs.add(ws.id);
      for (const e of wsEdges) if (e.src === ws.id) edges.push({ ...e, fileId: pf.fileId });
    }
    store.replaceFile(
      "main",
      {
        id: pf.fileId,
        path: rel,
        workspaceId: ws?.id ?? null,
        contentHash: `h-${rel}`,
        mtimeMs: 1,
        deleted: false,
      },
      symbols,
      edges,
    );
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gantry-map3d-"));
  execFileSync("git", ["init", "-q", tmp]);
  const paths = resolvePaths(tmp, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
  store = openStore(paths.dbPath);
  ctx = { store, paths, config: loadConfig(paths) };
  indexFixture(join(fixtures, "pnpm-turbo"), {
    "apps/web/src/components/Header.test.tsx": "export function testHeader() { return 1; }\n",
  });
});

afterAll(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const view = (query: string): ViewResult =>
  handleApi(ctx, "/api/view/map-3d", new URLSearchParams(query)) as ViewResult;

describe("map-3d view", () => {
  for (const level of ["workspaces", "dirs", "files"]) {
    it(`snapshot at level=${level}`, () => {
      const r = view(`level=${level}`);
      expect(r.layoutHint).toBe("force-3d");
      expect(JSON.stringify(r, null, 2)).toMatchSnapshot();
    });
  }

  it("defaults to dirs and treats the symbols level as dirs", () => {
    expect(view("")).toEqual(view("level=dirs"));
    expect(view("level=symbols")).toEqual(view("level=dirs"));
  });

  it("is deterministic", () => {
    expect(JSON.stringify(view("level=files"))).toBe(JSON.stringify(view("level=files")));
  });

  it("hides tests and generated files by default; hideTests=false shows tests", () => {
    const ids = (q: string) => view(q).nodes.map((n) => n.id);
    const testFile = "file:apps/web/src/components/Header.test.tsx";
    expect(ids("level=files")).not.toContain(testFile);
    expect(ids("level=files")).not.toContain("file:apps/web/src/routeTree.gen.ts");
    const json = (o: object) => encodeURIComponent(JSON.stringify(o));
    expect(ids(`level=files&filters=${json({ hideTests: false })}`)).toContain(testFile);
    expect(ids("level=files&filters=hideTests=false")).toContain(testFile);
  });

  it("lifts imports to workspace nodes and keeps depends_on", () => {
    const r = view("level=workspaces");
    expect(
      r.edges.some((e) => e.src === "ws:@acme/web" && e.dst === "ws:@acme/ui" && e.kind === "imports"),
    ).toBe(true);
    expect(r.edges.some((e) => e.kind === "depends_on")).toBe(true);
    expect(r.nodes.every((n) => n.kind === "workspace")).toBe(true);
  });

  it("parents dirs and files to their workspace", () => {
    for (const level of ["dirs", "files"]) {
      const r = view(`level=${level}`);
      const wsIds = new Set(r.nodes.filter((n) => n.kind === "workspace").map((n) => n.id));
      for (const n of r.nodes.filter((x) => x.kind !== "workspace"))
        expect(wsIds.has(n.parent ?? "")).toBe(true);
    }
  });

  it("folds the smallest files per directory beyond the cap without losing function counts", () => {
    const r = buildMap3d(ctx, { filters: [], level: "files" }, 3);
    expect(r.nodes.filter((n) => n.kind === "file")).toHaveLength(3);
    const folded = r.nodes.filter((n) => n.kind === "folded");
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.every((n) => /^\+\d+ files$/.test(n.label))).toBe(true);
    const total = (xs: typeof r.nodes) =>
      xs.filter((n) => n.kind !== "workspace").reduce((a, n) => a + n.size, 0);
    expect(total(r.nodes)).toBe(total(buildMap3d(ctx, { filters: [], level: "files" }).nodes));
  });

  it("rejects a malformed level with 400", () => {
    expect(() => view("level=..%2Fx")).toThrow(/level/);
  });
});

describe("path classes", () => {
  it("recognises generated files", () => {
    expect(isGeneratedPath("a/routeTree.gen.ts")).toBe(true);
    expect(isGeneratedPath("a/types.d.ts")).toBe(true);
    expect(isGeneratedPath("a/b.ts")).toBe(false);
  });
});

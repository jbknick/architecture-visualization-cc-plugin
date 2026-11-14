import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EdgeRecord, type FileRecord, openStore, type Store, type SymbolRecord } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../api.js";
import type { ApiContext, ViewResult } from "../types.js";
import { EGO_MAX_NODES } from "./ego.js";

interface Caller {
  ws: string;
  path: string;
  name: string;
  count?: number;
  low?: boolean;
}

const WS = [
  { id: "ws:@acme/ui", name: "@acme/ui", dir: "packages/ui" },
  { id: "ws:@acme/web", name: "@acme/web", dir: "apps/web" },
  { id: "ws:@acme/admin", name: "@acme/admin", dir: "apps/admin" },
  { id: "ws:@acme/docs", name: "@acme/docs", dir: "apps/docs" },
];
const FOCUS_PATH = "packages/ui/src/card.tsx";
const FOCUS = `sym:${FOCUS_PATH}#Card`;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const sym = (path: string, name: string, fileId: string): SymbolRecord => ({
  id: `sym:${path}#${name}`,
  fileId,
  name,
  kind: "function",
  exported: true,
  signature: "",
  startLine: 3,
  endLine: 9,
  loc: 6,
  complexity: 1,
  stmtCount: 1,
  exactHash: "e",
  shapeHash: "s",
  minhash: new Uint32Array(64),
});

/** A store where every caller calls `Card` (and, if given, `Card` calls the callees). */
function hub(callers: Caller[], callees: Caller[] = []): { ctx: ApiContext; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "gantry-ego-"));
  const store = openStore(join(dir, "gantry.db"));
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.upsertWorkspaces(
    WS.map((w) => ({ ...w, kind: "package" as const, frameworks: [], deps: [], exportsMap: null })),
  );
  const file = (path: string, ws: string): FileRecord => ({
    id: `file:${path}`,
    path,
    workspaceId: ws,
    contentHash: path,
    mtimeMs: 1,
    deleted: false,
  });
  const edge = (src: string, dst: string, fileId: string, c: Caller): EdgeRecord => ({
    src,
    dst,
    kind: "calls",
    confidence: c.low ? "low" : "high",
    count: c.count ?? 1,
    evidence: [],
    fileId,
  });
  const byFile = new Map<string, { ws: string; syms: SymbolRecord[]; edges: EdgeRecord[] }>();
  const slot = (path: string, ws: string) => {
    let s = byFile.get(path);
    if (!s) {
      s = { ws, syms: [], edges: [] };
      byFile.set(path, s);
    }
    return s;
  };
  const focusSlot = slot(FOCUS_PATH, "ws:@acme/ui");
  focusSlot.syms.push(sym(FOCUS_PATH, "Card", `file:${FOCUS_PATH}`));
  for (const c of callers) {
    const s = slot(c.path, c.ws);
    const sy = sym(c.path, c.name, `file:${c.path}`);
    s.syms.push(sy);
    s.edges.push(edge(sy.id, FOCUS, `file:${c.path}`, c));
  }
  for (const c of callees) {
    const s = slot(c.path, c.ws);
    const sy = sym(c.path, c.name, `file:${c.path}`);
    s.syms.push(sy);
    focusSlot.edges.push(edge(FOCUS, sy.id, `file:${FOCUS_PATH}`, c));
  }
  for (const [path, s] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    store.replaceFile("main", file(path, s.ws), s.syms, s.edges);
  return { ctx: { store, paths: { root: dir } as never, config: {} as never }, store };
}

const run = (ctx: ApiContext, qs = "", filters?: Record<string, string>): ViewResult => {
  const q = new URLSearchParams(`focus=${encodeURIComponent(FOCUS)}&${qs}`);
  if (filters) q.set("filters", JSON.stringify(filters));
  return handleApi(ctx, "/api/view/ego", q) as ViewResult;
};

/** n callers in one workspace, spread over `files` files of one folder. */
const spread = (ws: string, dir: string, n: number, files: number, tag = "c"): Caller[] =>
  Array.from({ length: n }, (_, i) => ({
    ws: `ws:@acme/${ws}`,
    path: `apps/${ws}/${dir}/file${i % files}.tsx`,
    name: `${tag}${i}`,
  }));

describe("ego grouping", () => {
  it("does not group a side with 24 nodes or fewer", () => {
    const { ctx } = hub(spread("web", "src", 24, 4));
    const r = run(ctx);
    expect(r.layoutHint).toBe("bowtie");
    expect(r.nodes.filter((n) => n.side === "in")).toHaveLength(24);
    expect(r.nodes.some((n) => n.kind === "group")).toBe(false);
  });

  it("groups a side with 25 nodes by workspace; groups of 3 or fewer stay individual", () => {
    const callers = [
      ...spread("web", "src", 12, 4),
      ...spread("admin", "src", 3, 1, "a"),
      ...spread("docs", "src", 10, 2, "d"),
    ];
    const { ctx } = hub(callers);
    const r = run(ctx);
    const groups = r.nodes.filter((n) => n.kind === "group");
    expect(groups.map((g) => g.id)).toEqual(["group:in:1:ws:@acme/docs", "group:in:1:ws:@acme/web"]);
    expect(groups[1]).toMatchObject({
      label: "web",
      size: 12,
      side: "in",
      hop: 1,
      stats: { members: 12, files: 4 },
      badges: ["12 callers"],
      workspace: "ws:@acme/web",
    });
    expect(groups[1]?.members).toHaveLength(12);
    expect(groups[1]?.members?.[0]).toMatchObject({ path: "apps/web/src/file0.tsx", line: 3 });
    // The focus, two groups and the 3 admin callers.
    expect(r.nodes).toHaveLength(1 + 2 + 3);
  });

  it("nests: a workspace over 12 splits by folder, a folder over 12 by file", () => {
    const callers = [
      ...spread("web", "src/routes", 14, 14, "r"), // folder src/routes: 14 members in 14 files -> split by file? 1 each -> singles
      ...spread("web", "src/hooks", 6, 2, "h"), // folder group of 6
      ...spread("web", "src/lib", 14, 2, "l"), // 14 in 2 files -> file groups of 7
      ...spread("admin", "src", 8, 2, "a"), // workspace group of 8
    ];
    const { ctx } = hub(callers);
    const r = run(ctx);
    const ids = r.nodes.filter((n) => n.kind === "group").map((n) => n.id);
    expect(ids).toContain("group:in:1:ws:@acme/admin");
    expect(ids).toContain("group:in:1:dir:apps/web/src/hooks");
    expect(ids).toContain("group:in:1:file:apps/web/src/lib/file0.tsx");
    expect(ids).toContain("group:in:1:file:apps/web/src/lib/file1.tsx");
    // src/routes holds 14 files with one caller each: file groups of one stay individual.
    expect(r.nodes.filter((n) => n.path?.includes("/routes/")).every((n) => n.kind !== "group")).toBe(true);
    const hooks = r.nodes.find((n) => n.id === "group:in:1:dir:apps/web/src/hooks");
    expect(hooks?.label).toBe("web · src/hooks");
    const lib = r.nodes.find((n) => n.id === "group:in:1:file:apps/web/src/lib/file0.tsx");
    expect(lib?.label).toBe("web · src/lib/file0.tsx");
    expect(lib?.stats).toEqual({ members: 7, files: 1 });
  });

  it("aggregates edges: weight is the member edge count, low confidence wins", () => {
    const callers = [
      ...spread("web", "src", 12, 3).map((c, i) => ({ ...c, count: i % 2 === 0 ? 2 : 1, low: i === 4 })),
      ...spread("admin", "src", 12, 3, "a"),
      ...spread("docs", "src", 2, 1, "d"),
    ];
    const { ctx } = hub(callers);
    const r = run(ctx);
    const edge = (src: string) => r.edges.find((e) => e.src === src && e.dst === FOCUS);
    expect(edge("group:in:1:ws:@acme/web")).toMatchObject({ kind: "calls", weight: 18, confidence: "low" });
    expect(edge("group:in:1:ws:@acme/admin")).toMatchObject({ weight: 12, confidence: "high" });
    expect(r.edges).toHaveLength(4);
  });

  it("a synthetic hub (300 callers, 3 workspaces, 40 files) returns at most 30 nodes", () => {
    // Per workspace: 9 folders; four hold two files (5 callers each), five hold one file (12 callers).
    // The first workspace gets a tenth folder with one file and one caller (and one caller fewer elsewhere).
    const callers: Caller[] = [];
    const filesSeen = new Set<string>();
    const add = (ws: string, f: number, k: number, n: number) => {
      const path = `apps/${ws}/src/f${f}/file${k}.tsx`;
      filesSeen.add(path);
      for (let i = 0; i < n; i++) callers.push({ ws: `ws:@acme/${ws}`, path, name: `c${i}` });
    };
    for (const ws of ["web", "admin", "docs"]) {
      for (let f = 0; f < 9; f++) {
        if (f < 4) {
          add(ws, f, 0, 5);
          add(ws, f, 1, 5);
        } else add(ws, f, 0, ws === "web" && f === 8 ? 11 : 12);
      }
    }
    add("web", 9, 0, 1);
    expect(filesSeen.size).toBe(40);
    expect(callers).toHaveLength(300);
    const { ctx } = hub(callers);
    const r = run(ctx);
    expect(r.nodes.length).toBeLessThanOrEqual(30);
    expect(
      r.nodes.filter((n) => n.side === "in").reduce((n, g) => n + (g.kind === "group" ? g.size : 1), 0),
    ).toBe(300);
  });

  it("is deterministic and orders groups by member count, then id", () => {
    const callers = [
      ...spread("web", "src", 12, 3),
      ...spread("admin", "src", 9, 3, "a"),
      ...spread("docs", "src", 9, 3, "d"),
    ];
    const { ctx } = hub(callers);
    const a = run(ctx);
    const b = run(ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const groups = a.nodes
      .filter((n) => n.kind === "group")
      .sort((x, y) => y.size - x.size || (x.id < y.id ? -1 : 1));
    expect(groups.map((g) => g.id)).toEqual([
      "group:in:1:ws:@acme/web",
      "group:in:1:ws:@acme/admin",
      "group:in:1:ws:@acme/docs",
    ]);
  });
});

describe("ego expand", () => {
  const callers = [
    ...spread("web", "src", 12, 3),
    ...spread("admin", "src", 9, 3, "a"),
    ...spread("docs", "src", 5, 2, "d"),
  ];

  it("returns the members of an expanded group as individual nodes", () => {
    const { ctx } = hub(callers);
    const gid = "group:in:1:ws:@acme/web";
    const r = run(ctx, "", { expand: gid });
    expect(r.nodes.find((n) => n.id === gid)).toMatchObject({ kind: "group", expanded: true, size: 12 });
    expect(
      r.nodes.filter((n) => n.kind === "function" && n.side === "in" && n.workspace === "ws:@acme/web"),
    ).toHaveLength(12);
    expect(r.nodes.filter((n) => n.group === gid)).toHaveLength(12);
    expect(r.nodes.some((n) => n.id === "group:in:1:ws:@acme/admin")).toBe(true);
    expect(r.edges.filter((e) => e.dst === FOCUS && e.src.startsWith("sym:apps/web"))).toHaveLength(12);
    // list form and unknown ids are accepted
    const both = run(ctx, "", {
      expand: `${gid}|group:in:1:ws:@acme/admin|group:in:1:ws:@acme/docs|group:in:9:nope`,
    });
    expect(both.nodes.some((n) => n.kind === "group" && !n.expanded)).toBe(false);
    expect(both.nodes).toHaveLength(1 + 3 + 26);
  });

  it("expands as far as the 400-node cap allows and keeps a +K more node in the group", () => {
    const many = spread("web", "src", 600, 6);
    const { ctx } = hub(many);
    const gid = "group:in:1:ws:@acme/web";
    const r = run(ctx);
    // 600 callers in 6 files: six file groups of 100 (the folder has 600 members).
    expect(r.nodes.filter((n) => n.kind === "group")).toHaveLength(6);
    const target = r.nodes.filter((n) => n.kind === "group")[0]?.id as string;
    expect(target.startsWith("group:in:1:file:")).toBe(true);
    const e = run(ctx, "", { expand: `${target}|${gid}` });
    expect(e.nodes.length).toBeLessThanOrEqual(EGO_MAX_NODES);
    const e2 = run(ctx, "", {
      expand: r.nodes
        .filter((n) => n.kind === "group")
        .map((n) => n.id)
        .join("|"),
    });
    expect(e2.nodes.length).toBeLessThanOrEqual(EGO_MAX_NODES);
    const more = e2.nodes.filter((n) => n.kind === "more");
    expect(more).toHaveLength(1);
    expect(more[0]?.id.startsWith("more:in:1:group:in:1:file:")).toBe(true);
    expect(more[0]?.label).toMatch(/^\+\d+ more$/);
    const known = new Set(e2.nodes.map((n) => n.id));
    for (const ed of e2.edges) expect(known.has(ed.src) && known.has(ed.dst)).toBe(true);
    // every caller is still accounted for: shown individually, behind a "+K more" or inside a group
    const total = e2.nodes
      .filter((n) => n.side === "in" && !n.expanded)
      .reduce((n, x) => n + (x.kind === "group" || x.kind === "more" ? x.size : 1), 0);
    expect(total).toBe(600);
  });

  it("groups callees too", () => {
    const callees = [
      ...spread("web", "src", 12, 3, "u").map((c) => ({
        ...c,
        path: c.path.replace("apps/web", "packages/ui"),
        ws: "ws:@acme/ui",
      })),
      ...spread("admin", "src", 9, 3, "v"),
      ...spread("docs", "src", 4, 1, "w"),
    ];
    const { ctx } = hub(spread("web", "src", 3, 1), callees);
    const r = run(ctx);
    const groups = r.nodes.filter((n) => n.kind === "group").map((n) => n.id);
    expect(groups).toEqual([
      "group:out:1:ws:@acme/admin",
      "group:out:1:ws:@acme/docs",
      "group:out:1:ws:@acme/ui",
    ]);
    expect(r.nodes.find((n) => n.id === "group:out:1:ws:@acme/ui")).toMatchObject({
      side: "out",
      badges: ["12 callees"],
    });
    expect(r.nodes.filter((n) => n.side === "in" && n.kind === "group")).toHaveLength(0);
  });
});

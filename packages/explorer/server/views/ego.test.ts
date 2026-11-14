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

const inRows = (r: ViewResult) => r.nodes.filter((n) => n.side === "in" && !n.group);
const members = (n: { kind: string; size: number }): number => (n.kind === "group" ? n.size : 1);

describe("ego grouping", () => {
  it("shows a side with maxRows nodes or fewer node by node", () => {
    const { ctx } = hub(spread("web", "src", 18, 4));
    const r = run(ctx);
    expect(r.layoutHint).toBe("bowtie");
    expect(r.nodes.filter((n) => n.side === "in")).toHaveLength(18);
    expect(r.nodes.some((n) => n.kind === "group")).toBe(false);
    const g = run(ctx, "", { maxRows: "8" });
    expect(g.nodes.some((n) => n.kind === "group")).toBe(true);
    expect(inRows(g).length).toBeLessThanOrEqual(8);
  });

  it("clamps maxRows to 8-40", () => {
    const { ctx } = hub(spread("web", "src", 120, 60));
    expect(inRows(run(ctx, "", { maxRows: "2" })).length).toBeLessThanOrEqual(8);
    expect(inRows(run(ctx, "", { maxRows: "500" })).length).toBeLessThanOrEqual(40);
    expect(inRows(run(ctx)).length).toBeLessThanOrEqual(18);
  });

  it("never returns more than maxRows rows per side, however the callers are spread", () => {
    // 150 callers in 100 files of 40 folders, plus two small workspaces.
    const callers: Caller[] = [];
    for (let i = 0; i < 150; i++)
      callers.push({
        ws: "ws:@acme/web",
        path: `apps/web/src/area${i % 40}/file${i % 100}.tsx`,
        name: `c${i}`,
      });
    callers.push(...spread("admin", "src", 20, 16, "a"), ...spread("docs", "src", 2, 1, "d"));
    const { ctx } = hub(callers);
    const r = run(ctx);
    const rows = inRows(r);
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(rows.every((n) => n.kind === "group")).toBe(true);
    expect(rows.reduce((n, g) => n + members(g), 0)).toBe(172);
  });

  it("labels groups in plain words", () => {
    const callers = [...spread("web", "src", 30, 6), ...spread("admin", "src", 12, 2, "a")];
    const { ctx } = hub(callers);
    const labels = inRows(run(ctx)).map((n) => n.label);
    expect(labels).toContain("file0.tsx — 5 callers");
    expect(
      labels.some((l) => /^admin — 12 callers in 2 files$/.test(l) || /^file\d\.tsx — 6 callers$/.test(l)),
    ).toBe(true);
  });

  it("aggregates edges: weight is the member edge count, low confidence wins", () => {
    const callers = [
      ...spread("web", "src", 12, 3).map((c, i) => ({ ...c, count: i % 2 === 0 ? 2 : 1, low: i === 4 })),
      ...spread("admin", "src", 12, 3, "a"),
      ...spread("docs", "src", 2, 1, "d"),
    ];
    const { ctx } = hub(callers);
    const r = run(ctx);
    const into = r.edges.filter((e) => e.dst === FOCUS);
    const weightOf = (ws: string) =>
      into
        .filter((e) => (r.nodes.find((n) => n.id === e.src)?.workspace ?? "") === `ws:@acme/${ws}`)
        .reduce((n, e) => n + e.weight, 0);
    expect(weightOf("web")).toBe(18);
    expect(weightOf("admin")).toBe(12);
    expect(into.some((e) => e.confidence === "low")).toBe(true);
    expect(into.filter((e) => e.confidence === "low").every((e) => e.src.includes("apps/web"))).toBe(true);
  });

  it("is deterministic", () => {
    const callers = [
      ...spread("web", "src", 40, 9),
      ...spread("admin", "src", 25, 5, "a"),
      ...spread("docs", "src", 9, 3, "d"),
    ];
    const { ctx } = hub(callers);
    expect(JSON.stringify(run(ctx))).toBe(JSON.stringify(run(ctx)));
  });
});

describe("ego expand", () => {
  const callers = [
    ...spread("web", "src", 60, 6),
    ...spread("admin", "src", 20, 4, "a"),
    ...spread("docs", "src", 5, 2, "d"),
  ];

  it("replaces a group by its children", () => {
    const { ctx } = hub(callers);
    const base = run(ctx);
    const target = inRows(base)
      .filter((n) => n.kind === "group")
      .sort((a, b) => b.size - a.size)[0];
    expect(target).toBeTruthy();
    const gid = (target as { id: string }).id;
    const r = run(ctx, "", { expand: `${gid}|group:in:9:nope` });
    expect(r.nodes.find((n) => n.id === gid)).toMatchObject({ kind: "group", expanded: true });
    const kids = r.nodes.filter((n) => n.group === gid);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.length).toBeLessThanOrEqual(14);
    expect(kids.reduce((n, k) => n + members(k), 0)).toBe((target as { size: number }).size);
    // The header has no edges; the rows under it do.
    expect(r.edges.some((e) => e.src === gid)).toBe(false);
    expect(r.edges.filter((e) => kids.some((k) => k.id === e.src))).toHaveLength(kids.length);
    expect(inRows(r).length).toBeLessThanOrEqual(18);
  });

  it("pages a big group: at most pageRows rows and a '+N more' row that opens the next page", () => {
    const { ctx } = hub(spread("web", "src", 100, 100));
    const base = run(ctx, "", { pageRows: "6", maxRows: "8" });
    const top = inRows(base).find((n) => n.kind === "group" && n.size > 6) as { id: string };
    expect(top).toBeTruthy();
    const r = run(ctx, "", { pageRows: "6", maxRows: "8", expand: top.id });
    const page = r.nodes.filter((n) => n.group === top.id);
    expect(page).toHaveLength(6);
    const more = page.find((n) => n.id.includes(":more:"));
    expect(more?.label).toMatch(/^\+\d+ more callers in \d+ files$/);
    const r2 = run(ctx, "", { pageRows: "6", maxRows: "8", expand: `${top.id}|${more?.id}` });
    expect(r2.nodes.find((n) => n.id === more?.id)?.expanded).toBe(true);
    expect(r2.nodes.filter((n) => n.group === more?.id).length).toBeGreaterThan(0);
  });

  it("skips expansions that would pass the 400-node cap", () => {
    const many = spread("web", "src", 1500, 15); // fifteen file groups of 100
    const { ctx } = hub(many);
    const r = run(ctx, "", { pageRows: "40" });
    const ids = inRows(r).map((n) => n.id);
    expect(ids.length).toBeLessThanOrEqual(18);
    const e = run(ctx, "", { pageRows: "40", expand: ids.join("|") });
    expect(e.nodes.length).toBeLessThanOrEqual(EGO_MAX_NODES);
    expect(e.nodes.filter((n) => n.expanded).length).toBeLessThan(ids.length);
    const known = new Set(e.nodes.map((n) => n.id));
    for (const ed of e.edges) expect(known.has(ed.src) && known.has(ed.dst)).toBe(true);
  });

  it("groups callees too", () => {
    const callees = [
      ...spread("web", "src", 30, 3, "u").map((c) => ({
        ...c,
        path: c.path.replace("apps/web", "packages/ui"),
        ws: "ws:@acme/ui",
      })),
      ...spread("admin", "src", 9, 3, "v"),
      ...spread("docs", "src", 4, 1, "w"),
    ];
    const { ctx } = hub(spread("web", "src", 3, 1), callees);
    const r = run(ctx);
    const out = r.nodes.filter((n) => n.side === "out" && n.kind === "group");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.every((n) => n.badges?.[0]?.endsWith("callees"))).toBe(true);
    expect(r.nodes.filter((n) => n.side === "in" && n.kind === "group")).toHaveLength(0);
  });
});

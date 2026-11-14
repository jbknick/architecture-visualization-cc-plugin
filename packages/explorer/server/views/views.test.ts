import { rmSync } from "node:fs";
import {
  type EdgeRecord,
  type FileRecord,
  type GantryConfig,
  type GantryPaths,
  openStore,
  type Store,
  type SymbolRecord,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError, handleApi } from "../api.js";
import { fixtureStore } from "../testkit.js";
import type { ApiContext, ViewResult } from "../types.js";
import { EGO_MAX_NODES } from "./ego.js";

let ctx: ApiContext;
let store: Store;
let dir: string;

beforeAll(() => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  // The views only read the store; paths and config are placeholders.
  ctx = { store, paths: { root: dir } as GantryPaths, config: {} as GantryConfig };
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const view = (id: string, qs = ""): ViewResult =>
  handleApi(ctx, `/api/view/${id}`, new URLSearchParams(qs)) as ViewResult;
const ids = (r: ViewResult) => r.nodes.map((n) => n.id);

describe("project-map", () => {
  it("snapshot: default level (files)", () => {
    expect(view("project-map")).toMatchSnapshot();
  });
  it("snapshot: workspaces level", () => {
    expect(view("project-map", "level=workspaces")).toMatchSnapshot();
  });
  it("snapshot: symbols level with external packages", () => {
    expect(view("project-map", "level=symbols&filters=showExternal=true")).toMatchSnapshot();
  });

  it("builds workspace > dir > file > symbol and collapses single-child directory chains", () => {
    const r = view("project-map", "level=symbols");
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    const btn = byId.get("sym:packages/ui/src/button.tsx#Button");
    expect(btn?.parent).toBe("file:packages/ui/src/button.tsx");
    expect(byId.get("file:packages/ui/src/button.tsx")?.parent).toBe("dir:packages/ui/src");
    // packages/ui has only `src` underneath: the workspace holds `src` directly, not nested twice.
    const dirNode = byId.get("dir:packages/ui/src");
    expect(dirNode?.label).toBe("src");
    expect(dirNode?.parent).toBe("ws:@acme/ui");
    // apps/web/src has `components`, `hooks`, ... so it is not collapsed; hooks has one file but sits beside others.
    expect(byId.get("dir:apps/web/src/routes/settings")?.parent).toBe("dir:apps/web/src/routes");
    for (const n of r.nodes) if (n.parent) expect(byId.has(n.parent)).toBe(true);
    for (const e of r.edges) {
      expect(byId.has(e.src) && byId.has(e.dst)).toBe(true);
      expect(e.src).not.toBe(e.dst);
    }
  });

  it("level limits depth", () => {
    const kinds = (qs: string) => new Set(view("project-map", qs).nodes.map((n) => n.kind));
    expect(kinds("level=workspaces")).toEqual(new Set(["workspace"]));
    expect(kinds("level=dirs")).toEqual(new Set(["workspace", "dir"]));
    expect(kinds("level=files").has("file")).toBe(true);
    expect(kinds("level=files").has("function")).toBe(false);
    expect(kinds("level=symbols").has("component")).toBe(true);
  });

  it("aggregates file imports between workspaces and keeps depends_on", () => {
    const r = view("project-map", "level=workspaces");
    const e = r.edges.find(
      (x) => x.src === "ws:@acme/web" && x.dst === "ws:@acme/ui" && x.kind === "imports",
    );
    expect(e?.weight).toBeGreaterThan(0);
    expect(
      r.edges.some((x) => x.kind === "depends_on" && x.src === "ws:@acme/web" && x.dst === "ws:@acme/ui"),
    ).toBe(true);
    expect(r.nodes.find((n) => n.id === "ws:@acme/web")?.badges).toContain("app");
  });

  it("focus returns the subtree one level deeper plus ancestors", () => {
    const r = view("project-map", `focus=${encodeURIComponent("dir:packages/ui/src")}`);
    expect(ids(r)).toEqual([
      "dir:packages/ui/src",
      "file:packages/ui/src/button.tsx",
      "file:packages/ui/src/card.tsx",
      "file:packages/ui/src/index.ts",
      "file:packages/ui/src/internal.ts",
      "ws:@acme/ui",
    ]);
    const deeper = view("project-map", `focus=${encodeURIComponent("file:packages/ui/src/button.tsx")}`);
    expect(ids(deeper)).toContain("sym:packages/ui/src/button.tsx#Button");
    for (const e of r.edges) expect(ids(r)).toEqual(expect.arrayContaining([e.src, e.dst]));
    expect(() => view("project-map", "focus=nope")).toThrow(HttpError);
  });

  it("filters: workspaces, kinds, exportedOnly, hideTests, showExternal", () => {
    const only = view("project-map", "filters=workspaces=ws:@acme/ui");
    expect(only.nodes.every((n) => n.id.startsWith("ws:@acme/ui") || n.path?.startsWith("packages/ui"))).toBe(
      true,
    );
    const json = JSON.stringify({ workspaces: ["ws:@acme/ui"], exportedOnly: true });
    expect(
      view("project-map", `level=symbols&filters=${encodeURIComponent(json)}`).nodes.some(
        (n) => n.kind === "workspace",
      ),
    ).toBe(true);
    const ext = view("project-map", "filters=showExternal=true");
    expect(ext.nodes.some((n) => n.kind === "external")).toBe(true);
    expect(view("project-map").nodes.some((n) => n.kind === "external")).toBe(false);
    for (const e of ext.edges) expect(ids(ext)).toEqual(expect.arrayContaining([e.src, e.dst]));
    expect(() => view("project-map", "level=bogus")).toThrow(HttpError);
  });

  it("is deterministic and carries no timestamps", () => {
    const a = JSON.stringify(view("project-map", "level=symbols"));
    expect(JSON.stringify(view("project-map", "level=symbols"))).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("hides test files by default and shows them with hideTests=false", () => {
    const { store: s2, dir: d2 } = fixtureStore("single-pkg");
    try {
      const file = (p: string): FileRecord => ({
        id: `file:${p}`,
        path: p,
        workspaceId: null,
        contentHash: p,
        mtimeMs: 1,
        deleted: false,
      });
      s2.replaceFile("main", file("src/a.test.ts"), [], []);
      const c = { ...ctx, store: s2 };
      const get = (qs: string) =>
        (handleApi(c, "/api/view/project-map", new URLSearchParams(qs)) as ViewResult).nodes;
      expect(get("").some((n) => n.id === "file:src/a.test.ts")).toBe(false);
      expect(get("filters=hideTests=false").some((n) => n.id === "file:src/a.test.ts")).toBe(true);
    } finally {
      s2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe("ego", () => {
  const BUTTON = "sym:packages/ui/src/button.tsx#Button";
  it("Button's callers are the pages and components that render it", () => {
    const r = view("ego", `focus=${encodeURIComponent(BUTTON)}`);
    const callers = r.nodes.filter((n) => n.side === "in" && n.hop === 1).map((n) => n.id);
    expect(callers).toContain("sym:apps/web/src/routes/index.tsx#HomePage");
    expect(
      r.edges.some(
        (e) =>
          e.kind === "renders" && e.dst === BUTTON && e.src === "sym:apps/web/src/routes/index.tsx#HomePage",
      ),
    ).toBe(true);
    expect(r.nodes.find((n) => n.id === BUTTON)).toMatchObject({ side: "focus", hop: 0 });
    expect(r.layoutHint).toBe("bowtie");
  });
  it("snapshot: Button ego graph", () => {
    expect(view("ego", `focus=${encodeURIComponent(BUTTON)}`)).toMatchSnapshot();
  });
  it("snapshot: file ego graph (imports)", () => {
    expect(
      view("ego", `focus=${encodeURIComponent("file:apps/web/src/routes/index.tsx")}`),
    ).toMatchSnapshot();
  });
  it("hops and edgeKinds and highConfidence filters", () => {
    const f = encodeURIComponent(BUTTON);
    const one = view("ego", `focus=${f}&hops=1`);
    const three = view("ego", `focus=${f}&hops=3`);
    expect(Math.max(...one.nodes.map((n) => n.hop ?? 0))).toBeLessThanOrEqual(1);
    expect(three.nodes.length).toBeGreaterThanOrEqual(one.nodes.length);
    expect(view("ego", `focus=${f}&filters=edgeKinds=calls`).nodes.length).toBe(1);
    expect(
      view("ego", `focus=${f}&filters=highConfidence=true`).edges.every((e) => e.confidence === "high"),
    ).toBe(true);
    expect(() => view("ego", `focus=${f}&hops=9`)).toThrow(HttpError);
    expect(() => view("ego")).toThrow(HttpError);
    expect(() => view("ego", "focus=sym:nope")).toThrow(HttpError);
  });
  it("is deterministic", () => {
    const q = `focus=${encodeURIComponent(BUTTON)}&hops=3`;
    expect(JSON.stringify(view("ego", q))).toBe(JSON.stringify(view("ego", q)));
  });
  it("/api/meta lists both views", () => {
    const m = handleApi(ctx, "/api/meta", new URLSearchParams()) as { views: { id: string }[] };
    expect(m.views.map((v) => v.id)).toEqual(expect.arrayContaining(["project-map", "ego"]));
  });
});

describe("scale", () => {
  const N_FILES = 1500;
  const PER = 6;
  let big: Store;
  let bigDir: string;
  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    bigDir = mkdtempSync(join(tmpdir(), "gantry-big-"));
    big = openStore(join(bigDir, "gantry.db"));
    const wss = Array.from({ length: 20 }, (_, i) => ({
      id: `ws:w${i}`,
      name: `w${i}`,
      dir: `pkgs/w${i}`,
      kind: "package" as const,
      frameworks: [],
      deps: [],
      exportsMap: null,
    }));
    big.upsertWorkspaces(wss);
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const sym = (fi: number, k: number) => `sym:pkgs/w${fi % 20}/src/d${fi % 7}/f${fi}.ts#fn${k}`;
    const total = 42000;
    const perFile = Math.ceil(total / N_FILES);
    for (let fi = 0; fi < N_FILES; fi++) {
      const p = `pkgs/w${fi % 20}/src/d${fi % 7}/f${fi}.ts`;
      const file: FileRecord = {
        id: `file:${p}`,
        path: p,
        workspaceId: `ws:w${fi % 20}`,
        contentHash: p,
        mtimeMs: 1,
        deleted: false,
      };
      const syms: SymbolRecord[] = Array.from({ length: PER }, (_, k) => ({
        id: sym(fi, k),
        fileId: file.id,
        name: `fn${k}`,
        kind: "function",
        exported: true,
        signature: "",
        startLine: 1,
        endLine: 3,
        loc: 3,
        complexity: 1,
        stmtCount: 1,
        exactHash: "e",
        shapeHash: "s",
        minhash: new Uint32Array(64),
      }));
      const edges: EdgeRecord[] = [];
      const seen = new Set<string>();
      while (edges.length < perFile) {
        const tf = rnd(N_FILES);
        const isImp = rnd(3) === 0;
        const src = isImp ? file.id : sym(fi, rnd(PER));
        const dst = isImp ? `file:pkgs/w${tf % 20}/src/d${tf % 7}/f${tf}.ts` : sym(tf, rnd(PER));
        const kind = isImp ? "imports" : "calls";
        const key = `${src}|${dst}|${kind}`;
        if (src === dst || seen.has(key)) continue;
        seen.add(key);
        edges.push({
          src,
          dst,
          kind,
          confidence: rnd(10) === 0 ? "low" : "high",
          count: 1,
          evidence: [],
          fileId: file.id,
        });
      }
      big.replaceFile("main", file, syms, edges);
    }
  });
  afterAll(() => {
    big.close();
    rmSync(bigDir, { recursive: true, force: true });
  });

  const timed = (id: string, qs: string): { ms: number; r: ViewResult } => {
    const bc = { ...ctx, store: big };
    // CPU time of this thread's process, not wall time: the budget is about the code, and wall time balloons
    // whenever other test files or builds are competing for cores.
    const t = process.cpuUsage();
    const r = handleApi(bc, `/api/view/${id}`, new URLSearchParams(qs)) as ViewResult;
    JSON.stringify(r);
    const d = process.cpuUsage(t);
    return { ms: (d.user + d.system) / 1000, r };
  };

  /**
   * One warm-up run, then the best of three. A single run is at the mercy of the other test files running in
   * parallel (a GC pause or a busy core doubles it); the best of three measures the code, not the machine's load.
   */
  const bestOfThree = (id: string, qs: string): { ms: number; r: ViewResult } => {
    timed(id, qs);
    let best = timed(id, qs);
    for (let i = 0; i < 2; i++) {
      const next = timed(id, qs);
      if (next.ms < best.ms) best = next;
    }
    return best;
  };

  it("project map answers a 42k-edge store in under 300 ms", () => {
    expect(big.effectiveEdges().length).toBeGreaterThanOrEqual(41000);
    for (const qs of ["", "level=symbols", "level=workspaces"]) {
      const { ms, r } = bestOfThree("project-map", qs);
      expect(ms, qs).toBeLessThan(300);
      const known = new Set(r.nodes.map((n) => n.id));
      for (const e of r.edges) expect(known.has(e.src) && known.has(e.dst) && e.src !== e.dst).toBe(true);
    }
  });

  it("ego caps at 400 nodes with +K more collapse nodes and answers in under 300 ms", () => {
    const qs = `focus=${encodeURIComponent("sym:pkgs/w0/src/d0/f0.ts#fn0")}&hops=4`;
    const { ms, r } = bestOfThree("ego", qs);
    expect(ms).toBeLessThan(300);
    expect(r.nodes.length).toBeLessThanOrEqual(EGO_MAX_NODES);
    // Past the cap the ring is grouped (and, if still too big, collapsed into "+K more" nodes).
    expect(r.nodes.some((n) => n.kind === "more" || n.kind === "group")).toBe(true);
    const known = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) expect(known.has(e.src) && known.has(e.dst)).toBe(true);
  });
});

describe("import counts agree between project-map and map-3d", () => {
  const importWeights = (r: ViewResult, project: (id: string) => string | undefined) => {
    const out = new Map<string, number>();
    for (const e of r.edges) {
      if (e.kind !== "imports") continue;
      const a = project(e.src);
      const b = project(e.dst);
      if (!a || !b || a === b) continue;
      out.set(`${a} -> ${b}`, (out.get(`${a} -> ${b}`) ?? 0) + e.weight);
    }
    return out;
  };
  const asObj = (m: Map<string, number>) => Object.fromEntries([...m].sort());
  const wsOf = (r: ViewResult) => {
    const parent = new Map(r.nodes.map((n) => [n.id, n.parent]));
    return (id: string): string | undefined => {
      let cur: string | undefined = id;
      while (cur && !cur.startsWith("ws:")) cur = parent.get(cur);
      return cur;
    };
  };
  // Both views drop test files by default; map-3d also drops generated files, so switch that off.
  const m3 = (level: string) => view("map-3d", `level=${level}&filters=hideGenerated=false`);
  const wsPairs = () => asObj(importWeights(view("project-map", "level=workspaces"), (id) => id));

  it("workspace pairs have identical weights", () => {
    const pm = view("project-map", "level=workspaces");
    const td = m3("workspaces");
    expect(Object.keys(wsPairs()).length).toBeGreaterThan(0);
    expect(asObj(importWeights(td, (id) => id))).toEqual(wsPairs());
    const byId = (r: ViewResult) =>
      Object.fromEntries(r.edges.filter((e) => e.kind === "imports").map((e) => [e.id, e.weight]));
    expect(byId(td)).toEqual(byId(pm));
  });

  it("folder-level edges add up to the same workspace-pair weights in both views", () => {
    for (const r of [view("project-map", "level=dirs"), m3("dirs")]) {
      // The project map also carries workspace-to-workspace roll-up edges at this level; they would count twice.
      const folders = {
        ...r,
        edges: r.edges.filter((e) => !e.src.startsWith("ws:") && !e.dst.startsWith("ws:")),
      };
      expect(asObj(importWeights(folders, wsOf(r)))).toEqual(wsPairs());
    }
  });

  it("file-level cross-workspace edges add up too, and each file pair weighs 1", () => {
    const td = m3("files");
    expect(asObj(importWeights(td, wsOf(td)))).toEqual(wsPairs());
    for (const e of td.edges.filter((x) => x.kind === "imports")) expect(e.weight).toBe(1);
  });

  it("depends_on stays a separate edge from imports", () => {
    const td = m3("workspaces");
    const dep = td.edges.find((e) => e.kind === "depends_on");
    expect(dep?.id).toContain("|depends_on|");
    expect(new Set(td.edges.map((e) => e.id)).size).toBe(td.edges.length);
  });
});

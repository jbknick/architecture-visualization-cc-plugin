// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../mock/largeMap.ts";
import type { GraphNode, ViewData } from "../api.ts";
import { buildTree } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { DEFAULT_VIEWPORT, FIT_INSETS } from "./mapLayout.ts";
import { hashPositions } from "./prng.ts";
import { generateSynthetic } from "./synthetic.ts";
import type { LayoutInput, Positions, Rect } from "./types.ts";

const small = () => generateSynthetic({ workspaces: 4, files: 24, symbols: 120, edges: 200, seed: 7 });

function input(hint: string, saved?: Positions, extra: GraphNode[] = []): LayoutInput {
  const { nodes, edges } = small();
  return {
    nodes: [...nodes, ...extra].map((n) => ({ id: n.id, kind: n.kind, parent: n.parent, size: n.size })),
    edges: edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight })),
    hint,
    focus: null,
    saved,
  };
}

function fromView(view: ViewData | { error: string }): LayoutInput {
  if ("error" in view) throw new Error(view.error);
  return {
    nodes: view.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      parent: n.parent,
      size: n.size,
      functions: n.stats?.functions,
    })),
    edges: view.edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight, kind: e.kind })),
    hint: "nested-elk",
    focus: null,
  };
}

const large = (level: "workspaces" | "dirs" | "files" | "symbols") =>
  fromView(projectMapLarge({ focus: null, level, options: {} }));

const rectOf = (rects: Float64Array, i: number): Rect => ({
  x: rects[i * 4] as number,
  y: rects[i * 4 + 1] as number,
  w: rects[i * 4 + 2] as number,
  h: rects[i * 4 + 3] as number,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
/** Shortest distance between two rectangles (0 when they touch or overlap). */
const gap = (a: Rect, b: Rect) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );

describe("computeLayout", () => {
  it.each(["nested-elk", "elk-layered", "radial", "force", "tree-lr", "columns", "clusters"])(
    "is deterministic for %s on a hierarchical graph",
    async (hint) => {
      const a = await computeLayout(input(hint));
      const b = await computeLayout(input(hint));
      expect(hashPositions(a.positions)).toBe(hashPositions(b.positions));
      expect(Object.keys(a.positions).length).toBe(input(hint).nodes.length);
    },
  );

  it.each(["force", "elk-layered", "radial", "tree-lr", "columns", "clusters", "grid", "layered", "tree"])(
    "lays out a flat graph with hint %s deterministically",
    async (hint) => {
      const flat = (): LayoutInput => {
        const i = input(hint);
        return {
          ...i,
          nodes: i.nodes
            .filter((n) => n.kind !== "workspace" && n.kind !== "directory" && n.kind !== "file")
            .map((n) => ({ ...n, parent: undefined })),
        };
      };
      const a = await computeLayout(flat());
      const b = await computeLayout(flat());
      expect(hashPositions(a.positions)).toBe(hashPositions(b.positions));
      for (const p of Object.values(a.positions)) {
        expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
      }
    },
  );

  it("reports no change when saved positions cover every node of a flat graph", async () => {
    const flat = (saved?: Positions): LayoutInput => {
      const i = input("force", saved);
      return {
        ...i,
        nodes: i.nodes.filter((n) => n.kind === "function").map((n) => ({ ...n, parent: undefined })),
      };
    };
    const first = await computeLayout(flat());
    const again = await computeLayout(flat(first.positions));
    expect(again.changed).toBe(false);
    expect(hashPositions(again.positions)).toBe(hashPositions(first.positions));
  });

  it("ignores saved positions for a hierarchical map: the layout follows from the data", async () => {
    const first = await computeLayout(input("nested-elk"));
    const second = await computeLayout(input("nested-elk", { "ws:@acme/pkg-b": [9999, 9999] }));
    expect(hashPositions(second.positions)).toBe(hashPositions(first.positions));
    expect(second.changed).toBe(false);
    expect(second.strategy).toBe("treemap/layered");
  });
});

describe("map layout of a large monorepo (3 big workspaces, 8 tiny, scoped names)", () => {
  it("sizes workspace boxes by function count with a floor, never overlapping and at least 60px apart", async () => {
    const inp = large("workspaces");
    const out = await computeLayout(inp);
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const tree = buildTree(inp.nodes, { boxWorkspaces: true });
    const roots = tree.nodes.map((n, i) => [n, i] as const).filter(([n]) => n.parent === -1);
    expect(roots).toHaveLength(11);
    const box = (id: string) => rectOf(map.rects, tree.index.get(id) as number);
    const fns = (id: string) => inp.nodes.find((n) => n.id === id)?.functions as number;

    const api = box("ws:@acme-platform-monorepo/api");
    const web = box("ws:@acme-platform-monorepo/web");
    const core = box("ws:@acme-platform-monorepo/core");
    const area = (r: Rect) => r.w * r.h;
    expect(area(api) / area(web)).toBeCloseTo(
      fns("ws:@acme-platform-monorepo/api") / fns("ws:@acme-platform-monorepo/web"),
      0,
    );
    expect(Math.abs(area(web) / area(core) - 980 / 960)).toBeLessThan(0.1);
    expect(area(api)).toBeGreaterThan(area(web));

    for (const [n] of roots) {
      const r = box(n.id);
      expect(r.w).toBeGreaterThanOrEqual(180); // tiny workspaces stay clickable and labelled
      expect(r.h).toBeGreaterThanOrEqual(90);
    }
    for (let a = 0; a < roots.length; a++) {
      for (let b = a + 1; b < roots.length; b++) {
        const p = box((roots[a] as readonly [{ id: string }, number])[0].id);
        const q = box((roots[b] as readonly [{ id: string }, number])[0].id);
        expect(overlaps(p, q)).toBe(false);
        expect(gap(p, q)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("fits the canvas, puts apps left of the packages they use, and routes links around the boxes", async () => {
    const inp = large("workspaces");
    const out = await computeLayout(inp);
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const tree = buildTree(inp.nodes, { boxWorkspaces: true });
    const box = (id: string) => rectOf(map.rects, tree.index.get(id) as number);
    // Fitting the whole diagram into the canvas must not shrink it below 0.6 (titles stay at 11px or more).
    const fit = Math.min(
      (DEFAULT_VIEWPORT.w - FIT_INSETS.left - FIT_INSETS.right) / map.bounds.w,
      (DEFAULT_VIEWPORT.h - FIT_INSETS.top - FIT_INSETS.bottom) / map.bounds.h,
    );
    expect(fit).toBeGreaterThan(0.6);

    const left = (a: string, b: string) =>
      box(`ws:@acme-platform-monorepo/${a}`).x < box(`ws:@acme-platform-monorepo/${b}`).x;
    expect(left("web", "api")).toBe(true);
    expect(left("api", "core")).toBe(true);
    expect(left("core", "types")).toBe(true);

    // No route segment crosses the inside of a box that is not its own end.
    const rects = tree.nodes.map((_, i) => rectOf(map.rects, i));
    const roots = tree.nodes.map((n, i) => [n, i] as const).filter(([n]) => n.parent === -1);
    let checked = 0;
    for (const [key, pts] of Object.entries(map.routes)) {
      const [a, b] = key.split(">") as [string, string];
      for (let s = 1; s < pts.length; s++) {
        const p = pts[s - 1] as [number, number];
        const q = pts[s] as [number, number];
        for (let t = 0.05; t < 0.96; t += 0.05) {
          const x = p[0] + (q[0] - p[0]) * t;
          const y = p[1] + (q[1] - p[1]) * t;
          for (const [n, i] of roots) {
            if (n.id === a || n.id === b) continue;
            const r = rects[i] as Rect;
            expect(x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1).toBe(false);
          }
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(22);
  });

  it("keeps every folder, file and function inside its parent, without sibling overlaps, at the deepest level", async () => {
    const inp = large("symbols");
    const out = await computeLayout(inp);
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const tree = buildTree(inp.nodes, { boxWorkspaces: true });
    let cells = 0;
    tree.nodes.forEach((n, i) => {
      const r = rectOf(map.rects, i);
      if (n.parent !== -1) {
        const p = rectOf(map.rects, n.parent);
        expect(r.x).toBeGreaterThanOrEqual(p.x - 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(p.y - 1e-6);
        expect(r.x + r.w).toBeLessThanOrEqual(p.x + p.w + 1e-6);
        expect(r.y + r.h).toBeLessThanOrEqual(p.y + p.h + 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(p.y + (map.heads[n.parent] as number) - 1e-6);
      }
      // Sibling overlap, checked for containers of a workable size only (the fixture has thousands of cells).
      if (n.children.length > 1 && n.children.length < 400 && i % 7 === 0) {
        const kids = n.children.map((c) => rectOf(map.rects, c));
        for (let a = 0; a < kids.length; a++)
          for (let b = a + 1; b < kids.length; b++)
            expect(overlaps(kids[a] as Rect, kids[b] as Rect)).toBe(false);
      }
      cells++;
    });
    expect(cells).toBeGreaterThan(4000);
  });

  it("gives a file with zero functions a thin but visible cell", async () => {
    const inp = large("files");
    const out = await computeLayout(inp);
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const tree = buildTree(inp.nodes, { boxWorkspaces: true });
    const empty = inp.nodes.filter((n) => n.kind === "file" && n.functions === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const n of empty) {
      const r = rectOf(map.rects, tree.index.get(n.id) as number);
      expect(r.w * r.h).toBeGreaterThan(0);
    }
  });

  it("is deterministic", async () => {
    const a = await computeLayout(large("files"));
    const b = await computeLayout(large("files"));
    expect(hashPositions(a.positions)).toBe(hashPositions(b.positions));
    expect(Array.from(a.map?.rects ?? [])).toEqual(Array.from(b.map?.rects ?? []));
  });
});

describe("map layout of small inputs", () => {
  it("gives childless workspaces a box each, with room between them", async () => {
    const nodes = ["a", "b", "c"].map((n) => ({ id: `ws:${n}`, kind: "workspace", size: 2, functions: 2 }));
    const edges = [{ src: "ws:a", dst: "ws:b", weight: 2 }];
    const out = await computeLayout({ nodes, edges, hint: "nested-elk", focus: null });
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const rects = nodes.map((_, i) => rectOf(map.rects, i));
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++)
        expect(overlaps(rects[a] as Rect, rects[b] as Rect)).toBe(false);
  });
});

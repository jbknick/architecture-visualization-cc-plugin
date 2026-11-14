// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../mock/largeMap.ts";
import { buildTree } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { distanceToPolyline } from "./mapDraw.ts";
import { GRID, routeLinks } from "./mapRoute.ts";
import { type Pt, segmentHitsBox } from "./route.ts";
import type { LayoutInput, Rect } from "./types.ts";

const rectOf = (rects: Float64Array, i: number): Rect => ({
  x: rects[i * 4] as number,
  y: rects[i * 4 + 1] as number,
  w: rects[i * 4 + 2] as number,
  h: rects[i * 4 + 3] as number,
});

function largeInput(level: "workspaces" | "dirs"): LayoutInput {
  const view = projectMapLarge({ focus: null, level, options: {} });
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

/** Segments of a polyline that enter the interior of `r` (shrunk by `eps`). */
function crossings(pts: Pt[], r: Rect, eps = 0.5): number {
  const box = { x0: r.x + eps, y0: r.y + eps, x1: r.x + r.w - eps, y1: r.y + r.h - eps };
  let n = 0;
  for (let s = 1; s < pts.length; s++) if (segmentHitsBox(pts[s - 1] as Pt, pts[s] as Pt, box)) n++;
  return n;
}

describe("routeLinks", () => {
  const boxes = new Map<number, Rect>([
    [0, { x: 0, y: 40, w: 120, h: 100 }],
    [1, { x: 300, y: 40, w: 120, h: 100 }],
    [2, { x: 150, y: 20, w: 100, h: 140 }], // sits between 0 and 1
  ]);

  it("routes around a box in the way, with orthogonal segments only", () => {
    const routes = routeLinks(boxes, [{ key: "0>1", a: 0, b: 1, weight: 5, declared: false }]);
    const pts = routes.get("0>1") as Pt[];
    expect(crossings(pts, boxes.get(2) as Rect)).toBe(0);
    for (let s = 1; s < pts.length; s++) {
      const p = pts[s - 1] as Pt;
      const q = pts[s] as Pt;
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
    // Starts on the right edge of the source and ends on the left edge of the target.
    expect(pts[0]?.[0]).toBe(120);
    expect(pts[pts.length - 1]?.[0]).toBe(300);
  });

  it("gives the two directions of a pair separate lanes, each with its own port", () => {
    const two = new Map<number, Rect>([
      [0, { x: 0, y: 0, w: 120, h: 100 }],
      [1, { x: 260, y: 0, w: 120, h: 100 }],
    ]);
    const routes = routeLinks(two, [
      { key: "0>1", a: 0, b: 1, weight: 30, declared: false },
      { key: "1>0", a: 1, b: 0, weight: 3, declared: false },
    ]);
    const forward = routes.get("0>1") as Pt[];
    const back = routes.get("1>0") as Pt[];
    // Ports on the same side are at least one grid step apart, and so are the lanes between them.
    expect(Math.abs((forward[0] as Pt)[1] - (back[back.length - 1] as Pt)[1])).toBeGreaterThanOrEqual(GRID);
    for (const [x, y] of forward) expect(distanceToPolyline(x, y, back)).toBeGreaterThanOrEqual(GRID - 0.01);
    for (const [x, y] of back) expect(distanceToPolyline(x, y, forward)).toBeGreaterThanOrEqual(GRID - 0.01);
  });
});

describe("routes on the large mock", () => {
  it("never pass through a box, are orthogonal, and use ports at least 8px apart", async () => {
    const inp = largeInput("workspaces");
    const out = await computeLayout(inp);
    const map = out.map;
    if (!map) throw new Error("no map geometry");
    const tree = buildTree(inp.nodes, { boxWorkspaces: true });
    const roots = tree.nodes
      .map((n, i) => [n.id, i] as const)
      .filter(([, i]) => tree.nodes[i]?.parent === -1);
    const rect = (id: string) => rectOf(map.rects, tree.index.get(id) as number);
    const ports = new Map<string, Pt[]>();
    const keys = Object.keys(map.routes);
    expect(keys.length).toBeGreaterThanOrEqual(22);
    for (const key of keys) {
      const pts = map.routes[key] as Pt[];
      const [a, b] = key.split(">") as [string, string];
      for (let s = 1; s < pts.length; s++) {
        const p = pts[s - 1] as Pt;
        const q = pts[s] as Pt;
        expect(p[0] === q[0] || p[1] === q[1], `${key} is orthogonal`).toBe(true);
      }
      for (const [id] of roots) {
        const r = rect(id);
        // The route may touch its own boxes at the two ports only: shrink them so the port itself is allowed.
        expect(crossings(pts, r, id === a || id === b ? 2 : 0.5), `${key} through ${id}`).toBe(0);
      }
      for (const [end, id] of [
        [pts[0] as Pt, a],
        [pts[pts.length - 1] as Pt, b],
      ] as const) {
        const list = ports.get(id) ?? [];
        list.push(end);
        ports.set(id, list);
      }
    }
    for (const [id, list] of ports) {
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i] as Pt;
          const q = list[j] as Pt;
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          // Two ports are either apart by a grid step or are one port shared (a declared link on a full side).
          expect(d === 0 || d >= 8, `${id}: ports ${p} and ${q}`).toBe(true);
        }
    }
  });
});

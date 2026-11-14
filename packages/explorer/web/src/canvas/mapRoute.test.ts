// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../mock/largeMap.ts";
import { buildTree } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { distanceToPolyline } from "./mapDraw.ts";
import { GRID, routeCrossings, routeLinks } from "./mapRoute.ts";
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

async function largeMap() {
  const inp = largeInput("workspaces");
  const out = await computeLayout(inp);
  if (!out.map) throw new Error("no map geometry");
  const real = new Set(inp.edges.filter((e) => e.kind !== "depends_on").map((e) => `${e.src}>${e.dst}`));
  return { map: out.map, tree: buildTree(inp.nodes, { boxWorkspaces: true }), real };
}

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

  it("keeps the ports of the import links at least 12px apart (one lane step)", async () => {
    const { map, real } = await largeMap();
    const ports = new Map<string, Pt[]>();
    for (const key of Object.keys(map.routes).filter((k) => real.has(k))) {
      const pts = map.routes[key] as Pt[];
      const [a, b] = key.split(">") as [string, string];
      ports.set(a, [...(ports.get(a) ?? []), pts[0] as Pt]);
      ports.set(b, [...(ports.get(b) ?? []), pts[pts.length - 1] as Pt]);
    }
    for (const [id, list] of ports)
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i] as Pt;
          const q = list[j] as Pt;
          expect(Math.hypot(p[0] - q[0], p[1] - q[1]), `${id}: ports ${p} and ${q}`).toBeGreaterThanOrEqual(
            12,
          );
        }
  });

  it("has no crossings between routes that share a channel and keep the same order at both ends", async () => {
    const { map, real } = await largeMap();
    // The links drawn by default: imports (declared-only links are an opt-in extra).
    const keys = Object.keys(map.routes).filter((k) => real.has(k));
    const route = (k: string) => map.routes[k] as Pt[];
    let sharing = 0;
    let ordered = 0;
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = route(keys[i] as string);
        const b = route(keys[j] as string);
        for (let s = 1; s < a.length; s++)
          for (let t = 1; t < b.length; t++) {
            const [p0, p1] = [a[s - 1] as Pt, a[s] as Pt];
            const [q0, q1] = [b[t - 1] as Pt, b[t] as Pt];
            const h = p0[1] === p1[1];
            if (h !== (q0[1] === q1[1])) continue;
            const lat = h ? 1 : 0;
            const ax = h ? 0 : 1;
            if (Math.abs((q0[lat] as number) - (p0[lat] as number)) > 2 * GRID) continue;
            const lo = Math.max(
              Math.min(p0[ax] as number, p1[ax] as number),
              Math.min(q0[ax] as number, q1[ax] as number),
            );
            const hi = Math.min(
              Math.max(p0[ax] as number, p1[ax] as number),
              Math.max(q0[ax] as number, q1[ax] as number),
            );
            if (hi - lo < 2 * GRID) continue; // a shared channel: parallel, close, overlapping for a stretch
            sharing++;
            // Where each route comes from at the two ends of the stretch: the lateral position of the leg that
            // joins its segment there (or of the segment itself, at the start or end of the route).
            const side = (pts: Pt[], idx: number, high: boolean): number => {
              const sp = pts[idx - 1] as Pt;
              const sq = pts[idx] as Pt;
              const lowFirst = (sp[ax] as number) <= (sq[ax] as number);
              const atStart = high ? !lowFirst : lowFirst; // is that end of the segment its first point?
              const end = (atStart ? sp : sq)[ax] as number;
              if (high ? end > hi : end < lo) return sp[lat] as number; // the route runs on past the stretch
              const neighbour = atStart ? pts[idx - 2] : pts[idx + 1];
              return (neighbour ?? sp)[lat] as number;
            };
            const order = (high: boolean) => Math.sign(side(b, t, high) - side(a, s, high));
            if (order(false) === 0 || order(true) === 0 || order(false) !== order(true)) continue;
            ordered++;
            // Same order at both ends: no segment of either route may cross the other inside the channel.
            const cross = (u0: Pt, u1: Pt, route2: Pt[]): number => {
              let n = 0;
              const uh = u0[1] === u1[1];
              for (let k = 1; k < route2.length; k++) {
                const [v0, v1] = [route2[k - 1] as Pt, route2[k] as Pt];
                if (uh === (v0[1] === v1[1])) continue;
                const [h0, h1, w0, w1] = uh ? [u0, u1, v0, v1] : [v0, v1, u0, u1];
                if (
                  Math.min(h0[0], h1[0]) < w0[0] &&
                  w0[0] < Math.max(h0[0], h1[0]) &&
                  Math.min(w0[1], w1[1]) < h0[1] &&
                  h0[1] < Math.max(w0[1], w1[1])
                )
                  n++;
              }
              return n;
            };
            expect(
              cross(p0, p1, b) + cross(q0, q1, a),
              `${keys[i]} and ${keys[j]} cross inside the channel they share`,
            ).toBe(0);
          }
      }
    expect(sharing).toBeGreaterThan(0);
    expect(ordered).toBeGreaterThan(0);
  });

  it("crosses little overall", async () => {
    const { map, real } = await largeMap();
    const n = routeCrossings(
      new Map((Object.entries(map.routes) as [string, Pt[]][]).filter(([k]) => real.has(k))),
    );
    console.log("route crossings on the large mock:", n);
    expect(n).toBeLessThanOrEqual(20); // 32 before the ports were ordered by the direction their routes leave
  });
});

// Orthogonal routing of the workspace links, on a 10px grid, around the placed boxes. Pure; runs in the layout
// worker. Every link leaves its source box through a port on one side and enters its target through a port on one
// side (distinct ports, one grid step apart), and no segment ever enters another box: a route is a shortest path
// on the grid that avoids every box (inflated by `CLEAR`), prefers few bends and avoids tracks that earlier
// (heavier) links already use, so parallel links, and the two directions of a pair, run in separate lanes.
import { type Pt, routeAround } from "./route.ts";
import type { Rect } from "./types.ts";

/** Distance between neighbouring tracks and between neighbouring ports, in layout units (px at the fit zoom). */
export const GRID = 12;
/** Routes keep at least this far from every box, except on the straight leg into a port. */
export const CLEAR = 8;
/** The first and last leg of a route (port to first bend) is at least this long, so an arrowhead fits on it. */
export const APPROACH = 12;
/** Ports keep this far from the corners of their side. */
const PORT_INSET = 8;
const TURN = 8;
const SHARE = 30;
const CROSS = 14;
const RESERVED = 40;
const MARGIN_CELLS = 4;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** 0: the right side (east), 1: bottom, 2: left, 3: top. A side's outward direction has the same number. */
export type Side = 0 | 1 | 2 | 3;

export interface RouteLink {
  key: string;
  a: number;
  b: number;
  weight: number;
  declared: boolean;
}

/** The side of `A` and the side of `B` a link from `A` to `B` uses. */
export function sidesFor(A: Rect, B: Rect): [Side, Side] {
  const gap = 2 * CLEAR + 4;
  if (B.x >= A.x + A.w + gap) return [0, 2];
  if (B.x + B.w <= A.x - gap) return [2, 0];
  return B.y >= A.y + A.h ? [1, 3] : [3, 1];
}

/** Grid positions along a side where a port may sit (multiples of `GRID` away from the corners). */
export function portSlots(r: Rect, side: Side): number[] {
  const vertical = side === 0 || side === 2; // the side runs up and down
  const lo = (vertical ? r.y : r.x) + PORT_INSET;
  const hi = (vertical ? r.y + r.h : r.x + r.w) - PORT_INSET;
  const out: number[] = [];
  for (let c = Math.ceil(lo / GRID) * GRID; c <= hi; c += GRID) out.push(c);
  if (out.length === 0) out.push(Math.round((lo + hi) / 2 / GRID) * GRID);
  return out;
}

function portPoint(r: Rect, side: Side, c: number): Pt {
  return side === 0 ? [r.x + r.w, c] : side === 2 ? [r.x, c] : side === 1 ? [c, r.y + r.h] : [c, r.y];
}

function stubPoint(r: Rect, side: Side, c: number): Pt {
  if (side === 0) return [Math.ceil((r.x + r.w + APPROACH) / GRID) * GRID, c];
  if (side === 2) return [Math.floor((r.x - APPROACH) / GRID) * GRID, c];
  if (side === 1) return [c, Math.ceil((r.y + r.h + APPROACH) / GRID) * GRID];
  return [c, Math.floor((r.y - APPROACH) / GRID) * GRID];
}

interface End {
  link: number;
  out: boolean;
  box: number;
  /** The box at the other end of the link. */
  other: number;
  side: Side;
  /** Where the other end of the link is, along the axis the side runs on (sorts ports so links do not cross). */
  along: number;
  slot: number;
}

class Heap {
  private f: number[] = [];
  private s: number[] = [];
  get size(): number {
    return this.s.length;
  }
  push(f: number, s: number): void {
    let i = this.s.length;
    this.f.push(f);
    this.s.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.f[p] as number) <= f) break;
      this.f[i] = this.f[p] as number;
      this.s[i] = this.s[p] as number;
      i = p;
    }
    this.f[i] = f;
    this.s[i] = s;
  }
  pop(): number {
    const top = this.s[0] as number;
    const f = this.f.pop() as number;
    const s = this.s.pop() as number;
    const n = this.s.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (this.f[c + 1] as number) < (this.f[c] as number)) c++;
        if ((this.f[c] as number) >= f) break;
        this.f[i] = this.f[c] as number;
        this.s[i] = this.s[c] as number;
        i = c;
      }
      this.f[i] = f;
      this.s[i] = s;
    }
    return top;
  }
}

/** Removes repeated points and the middle point of every straight run. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1] as Pt;
    const b = out[i] as Pt;
    const c = out[i + 1] as Pt;
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

/**
 * Routes every link. `boxes` are the placed workspace boxes by tree index; the result maps `link.key` to a
 * polyline from the source box's port to the target box's port (so the last segment ends on the target's edge).
 * Heavier links are routed first and get the straightest paths.
 */
export function routeLinks(boxes: Map<number, Rect>, links: readonly RouteLink[]): Map<string, Pt[]> {
  const result = new Map<string, Pt[]>();
  if (links.length === 0) return result;
  // Grid over all boxes plus a margin.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of boxes.values()) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const ox = Math.floor(minX / GRID) * GRID - MARGIN_CELLS * GRID;
  const oy = Math.floor(minY / GRID) * GRID - MARGIN_CELLS * GRID;
  const W = Math.ceil((maxX - ox) / GRID) + MARGIN_CELLS + 1;
  const H = Math.ceil((maxY - oy) / GRID) + MARGIN_CELLS + 1;
  const at = (x: number, y: number): number => Math.round((y - oy) / GRID) * W + Math.round((x - ox) / GRID);

  const blocked = new Uint8Array(W * H);
  for (const r of boxes.values()) {
    const gx0 = Math.max(0, Math.floor((r.x - CLEAR - ox) / GRID));
    const gx1 = Math.min(W - 1, Math.ceil((r.x + r.w + CLEAR - ox) / GRID));
    const gy0 = Math.max(0, Math.floor((r.y - CLEAR - oy) / GRID));
    const gy1 = Math.min(H - 1, Math.ceil((r.y + r.h + CLEAR - oy) / GRID));
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = ox + gx * GRID;
        const py = oy + gy * GRID;
        if (px > r.x - CLEAR && px < r.x + r.w + CLEAR && py > r.y - CLEAR && py < r.y + r.h + CLEAR)
          blocked[gy * W + gx] = 1;
      }
  }

  // Ports: group the link ends by (box, side), order them by where the other end is, spread them over the side.
  const order = links.map((_, i) => i);
  order.sort((p, q) => {
    const a = links[p] as RouteLink;
    const b = links[q] as RouteLink;
    return (
      Number(a.declared) - Number(b.declared) ||
      b.weight - a.weight ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
  });
  const ends: End[] = [];
  const linkEnds: [End, End][] = [];
  const centre = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2];
  links.forEach((l, k) => {
    const A = boxes.get(l.a) as Rect;
    const B = boxes.get(l.b) as Rect;
    const [sa, sb] = sidesFor(A, B);
    const alongA = sa === 0 || sa === 2 ? centre(B)[1] : centre(B)[0];
    const alongB = sb === 0 || sb === 2 ? centre(A)[1] : centre(A)[0];
    const e1: End = { link: k, out: true, box: l.a, other: l.b, side: sa, along: alongA, slot: 0 };
    const e2: End = { link: k, out: false, box: l.b, other: l.a, side: sb, along: alongB, slot: 0 };
    ends.push(e1, e2);
    linkEnds.push([e1, e2]);
  });
  const groupsOf = (): Map<string, End[]> => {
    const groups = new Map<string, End[]>();
    for (const e of ends) {
      const key = `${e.box}:${e.side}`;
      const list = groups.get(key);
      if (list) list.push(e);
      else groups.set(key, [e]);
    }
    return groups;
  };
  /** One complete routing pass; `alongOf` is the key that orders the ports on a box side. */
  const attempt = (alongOf: (e: End) => number): Map<string, Pt[]> => {
    const routes = new Map<string, Pt[]>();
    for (const list of groupsOf().values()) {
      const first = list[0] as End;
      const slots = portSlots(boxes.get(first.box) as Rect, first.side);
      list.sort(
        (p, q) =>
          alongOf(p) - alongOf(q) ||
          // The two directions of a pair mirror each other (out first on the lower box, in first on the other), so
          // their lanes run side by side instead of crossing.
          (p.box < p.other ? Number(q.out) - Number(p.out) : Number(p.out) - Number(q.out)) ||
          ((links[p.link] as RouteLink).key < (links[q.link] as RouteLink).key ? -1 : 1),
      );
      // Import links get their own ports first; declared-only links take the ports that are left, and share one
      // (the nearest) only when the side is full.
      const real = list.filter((e) => !(links[e.link] as RouteLink).declared);
      const declared = list.filter((e) => (links[e.link] as RouteLink).declared);
      const n = real.length;
      const step = Math.max(1, Math.min(3, Math.floor((slots.length - 1) / Math.max(1, n - 1))));
      const span = (n - 1) * step + 1;
      const start = Math.max(0, Math.floor((slots.length - span) / 2));
      const used = new Set<number>();
      real.forEach((e, i) => {
        const at = Math.min(slots.length - 1, start + i * step);
        e.slot = slots[at] as number;
        used.add(at);
      });
      declared.forEach((e, i) => {
        const want = Math.min(
          slots.length - 1,
          Math.round(((i + 0.5) / declared.length) * slots.length - 0.5),
        );
        let best = -1;
        for (let k = 0; k < slots.length; k++)
          if (!used.has(k) && (best === -1 || Math.abs(k - want) < Math.abs(best - want))) best = k;
        if (best === -1) best = want;
        used.add(best);
        e.slot = slots[best] as number;
      });
    }

    const hUse = new Uint8Array(W * H);
    const vUse = new Uint8Array(W * H);
    const reserved = new Uint8Array(W * H);
    const stubs = linkEnds.map(([e1, e2]): [Pt, Pt] => {
      const l = links[e1.link] as RouteLink;
      return [
        stubPoint(boxes.get(l.a) as Rect, e1.side, e1.slot),
        stubPoint(boxes.get(l.b) as Rect, e2.side, e2.slot),
      ];
    });
    for (const [s1, s2] of stubs)
      for (const s of [s1, s2]) {
        const i = at(s[0], s[1]);
        if (i >= 0 && i < reserved.length) reserved[i] = Math.min(255, (reserved[i] as number) + RESERVED);
      }

    const states = W * H * 4;
    const cost = new Float32Array(states);
    const prev = new Int32Array(states);
    const mark = (pts: Pt[], delta = 1): void => {
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1] as Pt;
        const b = pts[k] as Pt;
        const horizontal = a[1] === b[1];
        const n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / GRID);
        for (let j = 0; j <= n; j++) {
          const x = a[0] + ((b[0] - a[0]) * j) / Math.max(1, n);
          const y = a[1] + ((b[1] - a[1]) * j) / Math.max(1, n);
          const i = at(x, y);
          if (i < 0 || i >= hUse.length) continue;
          if (horizontal) hUse[i] = Math.max(0, Math.min(255, (hUse[i] as number) + delta));
          else vUse[i] = Math.max(0, Math.min(255, (vUse[i] as number) + delta));
        }
      }
    };

    interface Lim {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
    const tight: Lim = {
      x0: Math.floor((minX - ox) / GRID) - 1,
      y0: Math.floor((minY - oy) / GRID) - 1,
      x1: Math.ceil((maxX - ox) / GRID) + 1,
      y1: Math.ceil((maxY - oy) / GRID) + 1,
    };
    /** Shortest path of grid points from `s1` (leaving in direction `out`) to `s2` (entered in direction `into`). */
    const search = (s1: Pt, out: number, s2: Pt, into: number, within: Lim | null): Pt[] | null => {
      cost.fill(Number.POSITIVE_INFINITY);
      const goal = at(s2[0], s2[1]);
      const gx = Math.round((s2[0] - ox) / GRID);
      const gy = Math.round((s2[1] - oy) / GRID);
      const startPoint = at(s1[0], s1[1]);
      const start = startPoint * 4 + out;
      cost[start] = 0;
      prev[start] = -1;
      const heap = new Heap();
      const h = (p: number): number => Math.abs((p % W) - gx) + Math.abs(Math.floor(p / W) - gy);
      heap.push(h(startPoint), start);
      while (heap.size > 0) {
        const s = heap.pop();
        const p = s >> 2;
        const d = s & 3;
        if (p === goal) {
          const pts: Pt[] = [];
          for (let cur = s; cur !== -1; cur = prev[cur] as number) {
            const q = cur >> 2;
            pts.push([ox + (q % W) * GRID, oy + Math.floor(q / W) * GRID]);
          }
          return pts.reverse();
        }
        const base = cost[s] as number;
        const px = p % W;
        const py = Math.floor(p / W);
        for (const turn of [0, 1, 3]) {
          const nd = (d + turn) & 3;
          const nx = px + (DX[nd] as number);
          const ny = py + (DY[nd] as number);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (within && (nx < within.x0 || nx > within.x1 || ny < within.y0 || ny > within.y1)) continue;
          const np = ny * W + nx;
          if (blocked[np]) continue;
          // Never enter the target's stub moving away from the box: the last leg would double back over itself.
          if (np === goal && nd === ((into + 2) & 3)) continue;
          let c = 1 + (turn === 0 ? 0 : TURN);
          if (nd & 1) c += (vUse[np] as number) * SHARE + (hUse[np] && !vUse[np] ? CROSS : 0);
          else c += (hUse[np] as number) * SHARE + (vUse[np] && !hUse[np] ? CROSS : 0);
          if (np !== goal) c += reserved[np] as number;
          else if (nd !== into) c += TURN;
          const ns = np * 4 + nd;
          const total = base + c;
          if (total < (cost[ns] as number)) {
            cost[ns] = total;
            prev[ns] = s;
            heap.push(total + h(np), ns);
          }
        }
      }
      return null;
    };

    const obstacles = [...boxes].map(([i, r]) => ({
      i,
      box: { x0: r.x - 18, y0: r.y - 18, x1: r.x + r.w + 18, y1: r.y + r.h + 18 },
    }));
    /** Reroutes the rip-up and port-swap passes may spend: they are a polish, and a big diagram must not wait on them. */
    let budget = Number.POSITIVE_INFINITY;
    const routeOne = (k: number): Pt[] => {
      budget--;
      const l = links[k] as RouteLink;
      const [e1, e2] = linkEnds[k] as [End, End];
      const A = boxes.get(l.a) as Rect;
      const B = boxes.get(l.b) as Rect;
      const p1 = portPoint(A, e1.side, e1.slot);
      const p2 = portPoint(B, e2.side, e2.slot);
      const [s1, s2] = stubs[k] as [Pt, Pt];
      // The target's port faces outward in direction `e2.side`; the route enters it in the opposite direction.
      // Declared-only links stay near the boxes (they must not stretch the diagram); they get the whole grid only when
      // there is no other way.
      const into = (e2.side + 2) & 3;
      const found =
        (l.declared ? search(s1, e1.side, s2, into, tight) : null) ?? search(s1, e1.side, s2, into, null);
      if (found) return simplify([p1, ...found, p2]);
      // No grid path (a very crowded or very small diagram): shortest path around the inflated boxes.
      const others = obstacles.filter((o) => o.i !== l.a && o.i !== l.b).map((o) => o.box);
      return simplify([p1, ...routeAround(s1, s2, others), p2]);
    };
    for (const k of order) {
      const pts = routeOne(k);
      mark(pts);
      routes.set((links[k] as RouteLink).key, pts);
    }
    budget = links.length <= 60 ? 160 : 0;
    // Rip up and reroute: a link routed early never saw the lighter links routed after it. Each import link that
    // crosses another is routed again with all the others in place; failing that, it and the link it crosses are
    // routed in the opposite order. A change stays only when it removes crossings from the whole set.
    const indexOf = new Map(links.map((l, i) => [l.key, i]));
    const crossingsOfRoute = (pts: Pt[], key: string): number => {
      let n = 0;
      for (const [other, q] of routes) if (other !== key) n += pairCrossings(pts, q);
      return n;
    };
    // A rerouted link must not push the diagram's outline outwards (the camera fits it to the canvas).
    const inside = (pts: Pt[]): boolean =>
      pts.every(
        (p) => p[0] >= minX - GRID && p[0] <= maxX + GRID && p[1] >= minY - GRID && p[1] <= maxY + GRID,
      );
    const realOnly = (): Map<string, Pt[]> =>
      new Map([...routes].filter(([key]) => !(links[indexOf.get(key) as number] as RouteLink).declared));
    const total = (): number => routeCrossings(realOnly());
    let score = total();
    for (let round = 0; round < 3 && score > 0 && budget > 0; round++) {
      let improved = false;
      for (const k of order) {
        const l = links[k] as RouteLink;
        if (l.declared || score === 0 || budget <= 0) continue;
        const old = routes.get(l.key) as Pt[];
        const crossers = [...routes]
          .filter(([key, q]) => key !== l.key && pairCrossings(old, q) > 0)
          .map(([key]) => key);
        if (crossers.length === 0) continue;
        mark(old, -1);
        const cand = routeOne(k);
        routes.set(l.key, cand);
        let s = total();
        if (s < score && inside(cand)) {
          score = s;
          mark(cand);
          improved = true;
          continue;
        }
        routes.set(l.key, old);
        let done = false;
        for (const other of crossers) {
          const ok = indexOf.get(other) as number;
          if ((links[ok] as RouteLink).declared) continue;
          const oldOther = routes.get(other) as Pt[];
          mark(oldOther, -1);
          const candOther = routeOne(ok);
          mark(candOther);
          routes.set(other, candOther);
          const candThis = routeOne(k);
          mark(candThis);
          routes.set(l.key, candThis);
          s = total();
          if (s < score && inside(candOther) && inside(candThis)) {
            score = s;
            improved = true;
            done = true;
            break;
          }
          mark(candThis, -1);
          mark(candOther, -1);
          routes.set(other, oldOther);
          routes.set(l.key, old);
          mark(oldOther);
        }
        if (!done) mark(old);
      }
      if (!improved) break;
    }
    // Swap neighbouring ports: two links whose routes cross near their ports often just have their ports the wrong
    // way round (the nested corner is the other way). Both are routed again, and the swap stays when it helps.
    const stubFor = (e: End): Pt => stubPoint(boxes.get(e.box) as Rect, e.side, e.slot);
    for (let round = 0; round < 2 && score > 0 && budget > 0; round++) {
      let improved = false;
      for (const list of groupsOf().values()) {
        const real = list
          .filter((e) => !(links[e.link] as RouteLink).declared)
          .sort((p, q) => p.slot - q.slot);
        for (let i = 0; i + 1 < real.length && score > 0 && budget > 0; i++) {
          const e = real[i] as End;
          const f = real[i + 1] as End;
          if (e.slot === f.slot || e.link === f.link) continue;
          const ke = (links[e.link] as RouteLink).key;
          const kf = (links[f.link] as RouteLink).key;
          const oldE = routes.get(ke) as Pt[];
          const oldF = routes.get(kf) as Pt[];
          if (crossingsOfRoute(oldE, ke) + crossingsOfRoute(oldF, kf) === 0) continue;
          const swap = (): void => {
            [e.slot, f.slot] = [f.slot, e.slot];
            for (const g of [e, f]) (stubs[g.link] as [Pt, Pt])[g.out ? 0 : 1] = stubFor(g);
          };
          swap();
          mark(oldE, -1);
          mark(oldF, -1);
          const first = (links[e.link] as RouteLink).weight >= (links[f.link] as RouteLink).weight ? e : f;
          const second = first === e ? f : e;
          const cFirst = routeOne(first.link);
          mark(cFirst);
          routes.set((links[first.link] as RouteLink).key, cFirst);
          const cSecond = routeOne(second.link);
          mark(cSecond);
          routes.set((links[second.link] as RouteLink).key, cSecond);
          const s = total();
          if (s < score && inside(cFirst) && inside(cSecond)) {
            score = s;
            improved = true;
          } else {
            mark(cFirst, -1);
            mark(cSecond, -1);
            swap();
            routes.set(ke, oldE);
            routes.set(kf, oldF);
            mark(oldE);
            mark(oldF);
          }
        }
      }
      if (!improved) break;
    }
    return routes;
  };
  // Pass 1 orders the ports by where the other end of each link is. Pass 2 orders them by the direction the pass-1
  // routes really leave (or arrive): the first sideways leg after the box. Whichever has fewer crossings wins.
  const first = attempt((e) => e.along);
  const lateral = new Map<End, number>();
  for (const e of ends) {
    const l = links[e.link] as RouteLink;
    const pts = first.get(l.key) as Pt[];
    const walk = e.out ? pts : [...pts].reverse();
    const horizontal = e.side === 0 || e.side === 2;
    const port = walk[0] as Pt;
    let key = e.along;
    for (let k = 1; k < walk.length; k++) {
      const p = walk[k] as Pt;
      const sideways = horizontal ? p[1] !== port[1] : p[0] !== port[0];
      if (sideways) {
        key = horizontal ? p[1] : p[0];
        break;
      }
    }
    lateral.set(e, key + (e.along - key) * 0.001);
  }
  const second = attempt((e) => lateral.get(e) ?? e.along);
  const better = routeCrossings(second) < routeCrossings(first) ? second : first;
  for (const [k, v] of better) result.set(k, v);
  return result;
}

function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  // Orthogonal segments only: a horizontal one against a vertical one, crossing strictly inside both.
  const ah = a[1] === b[1];
  const ch = c[1] === d[1];
  if (ah === ch) return false;
  const [h0, h1, v0, v1] = ah ? [a, b, c, d] : [c, d, a, b];
  return (
    Math.min(h0[0], h1[0]) < v0[0] &&
    v0[0] < Math.max(h0[0], h1[0]) &&
    Math.min(v0[1], v1[1]) < h0[1] &&
    h0[1] < Math.max(v0[1], v1[1])
  );
}

/** Number of places where two routes cross (segments meeting at right angles in their interiors). */
export function pairCrossings(p: Pt[], q: Pt[]): number {
  let n = 0;
  for (let s = 1; s < p.length; s++)
    for (let t = 1; t < q.length; t++)
      if (properCross(p[s - 1] as Pt, p[s] as Pt, q[t - 1] as Pt, q[t] as Pt)) n++;
  return n;
}

/** Number of places where two routes of the set cross. */
export function routeCrossings(routes: Map<string, Pt[]>): number {
  const list = [...routes.values()];
  let n = 0;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) n += pairCrossings(list[i] as Pt[], list[j] as Pt[]);
  return n;
}

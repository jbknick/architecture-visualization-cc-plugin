// Pure, deterministic layout for the 3D map. No WebGL, no Math.random: positions come from hashes of ids and a
// fixed number of simulation ticks, so the same data always yields the same picture.
import type { GraphEdge, GraphNode } from "../api.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Island {
  /** Group id: the workspace id (`parent` of its nodes), or the node's own id when it has no parent. */
  id: string;
  /** Display name: the workspace's short label (npm scope stripped when shared), else its label. */
  label: string;
  /** The full workspace name, for tooltips. */
  fullLabel: string;
  /** app / package / unknown, from the workspace node's first badge. */
  wsKind: string;
  /** Index in the sorted island list; selects the colour. */
  index: number;
  center: Vec3;
  radius: number;
  /** Ids of the drawn nodes inside the island. */
  nodeIds: string[];
  functions: number;
  files: number;
}

export interface Arc {
  id: string;
  src: string;
  dst: string;
  /** Imports (or dependency count) aggregated over every node-level edge between the two islands. */
  weight: number;
  /** True when the arc only comes from package.json `depends_on`, not from imports. */
  dependsOnly: boolean;
  /** Quadratic Bezier: from, control, to. */
  p0: Vec3;
  p1: Vec3;
  p2: Vec3;
}

export interface Layout {
  positions: Map<string, Vec3>;
  nodeRadius: Map<string, number>;
  islands: Island[];
  arcs: Arc[];
  /** Radius of the sphere around the origin that contains every island. */
  extent: number;
  /** Unit direction from the origin to the default camera: the angle that overlaps islands least on screen. */
  viewDir: Vec3;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sphere radius for a node: sqrt scale of the function count, clamped. */
export function nodeRadius(size: number, kind: string): number {
  const s = Math.sqrt(Math.max(0, size));
  return kind === "workspace" ? clamp(3 + s * 0.6, 3, 26) : clamp(1 + s * 0.5, 1, 6);
}

/** On-screen height (px) of an island's name label: grows with sqrt of its function count, clamped. */
export function islandLabelPx(functions: number): number {
  return clamp(10 + 0.55 * Math.sqrt(Math.max(0, functions)), 12, 32);
}

/** Tube diameter (px) of an inter-island arc: sqrt of its import count, clamped. */
export function arcWidthPx(weight: number): number {
  return clamp(1.2 + Math.sqrt(Math.max(0, weight)) * 0.45, 1.5, 6);
}

/** Smallest island radius for a workspace with `functions` function-like symbols: sqrt scale with a floor. */
export function islandFloorRadius(functions: number): number {
  return 8 + 0.9 * Math.sqrt(Math.max(0, functions));
}

/** Required empty space between two island spheres: proportional to the larger radius, never below 6. */
export function islandGap(ra: number, rb: number): number {
  return Math.max(10, 0.45 * Math.max(ra, rb));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Evenly spread directions on a sphere. */
function fibonacci(i: number, n: number): Vec3 {
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * 2.399963229728653;
  return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r };
}

interface Body {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
}

function body(id: string, p: Vec3, r: number): Body {
  return { id, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, r };
}

/** Pairwise separation until nothing overlaps (or the iteration budget is spent). */
function separate(bodies: Body[], gap: (a: Body, b: Body) => number, iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i] as Body;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j] as Body;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dy, dz);
        const need = a.r + b.r + gap(a, b);
        if (d >= need) continue;
        if (d < 1e-6) {
          const h = seeded(fnv1a(a.id + b.id))();
          dx = Math.cos(h * 6.283);
          dy = Math.sin(h * 6.283);
          dz = 0.3;
          d = Math.hypot(dx, dy, dz);
        }
        const push = (need - d) / 2 / d;
        a.x -= dx * push;
        a.y -= dy * push;
        a.z -= dz * push;
        b.x += dx * push;
        b.y += dy * push;
        b.z += dz * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/** Lays one island's nodes out inside a sphere. Returns local positions and the island radius. */
function layoutIsland(
  nodes: GraphNode[],
  edges: { a: string; b: string; w: number }[],
  functions: number,
): { pos: Map<string, Vec3>; radius: number } {
  const floor = islandFloorRadius(functions);
  const sorted = [...nodes].sort((a, b) => b.size - a.size || cmp(a.id, b.id));
  const pos = new Map<string, Vec3>();
  if (sorted.length === 1) {
    const only = sorted[0] as GraphNode;
    pos.set(only.id, { x: 0, y: 0, z: 0 });
    return { pos, radius: Math.max(floor, nodeRadius(only.size, only.kind) * 1.5 + 3) };
  }
  const radii = sorted.map((n) => nodeRadius(n.size, n.kind));
  const volume = radii.reduce((a, r) => a + r * r * r, 0);
  const target = Math.max(8, 2.1 * Math.cbrt(volume));
  const bodies = sorted.map((n, i) => {
    const rand = seeded(fnv1a(n.id));
    const dir = fibonacci(i, sorted.length);
    const k = target * (0.3 + 0.7 * Math.cbrt(rand()));
    return body(n.id, { x: dir.x * k, y: dir.y * k, z: dir.z * k }, radii[i] as number);
  });
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const n = bodies.length;
  const ticks = clamp(Math.round(6e7 / (n * n)), 20, 140);
  for (let t = 0; t < ticks; t++) {
    const cool = 1 - t / ticks;
    for (let i = 0; i < n; i++) {
      const a = bodies[i] as Body;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j] as Body;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const d = Math.sqrt(d2);
        const f = (14 * (a.r + b.r)) / d2; // repulsion, stronger for big nodes
        const ux = dx / d;
        const uy = dy / d;
        const uz = dz / d;
        a.vx -= ux * f;
        a.vy -= uy * f;
        a.vz -= uz * f;
        b.vx += ux * f;
        b.vy += uy * f;
        b.vz += uz * f;
      }
    }
    for (const e of edges) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dy, dz) + 0.01;
      const rest = a.r + b.r + 3;
      const f = (d - rest) * 0.012 * Math.min(3, 1 + Math.log2(1 + e.w) * 0.3);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      a.vz += (dz / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
      b.vz -= (dz / d) * f;
    }
    for (const a of bodies) {
      a.vx -= a.x * 0.03;
      a.vy -= a.y * 0.03;
      a.vz -= a.z * 0.03;
      a.vx *= 0.82;
      a.vy *= 0.82;
      a.vz *= 0.82;
      const speed = Math.hypot(a.vx, a.vy, a.vz);
      const cap = 3 + 6 * cool;
      const k = speed > cap ? cap / speed : 1;
      a.x += a.vx * k;
      a.y += a.vy * k;
      a.z += a.vz * k;
    }
  }
  separate(bodies, () => 0.8, n > 400 ? 20 : 60);
  let radius = 0;
  for (const b of bodies) radius = Math.max(radius, Math.hypot(b.x, b.y, b.z) + b.r);
  for (const b of bodies) pos.set(b.id, { x: b.x, y: b.y, z: b.z });
  return { pos, radius: Math.max(floor, radius * 1.12 + 3) };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 1, z: 0 } : mul(a, 1 / l);
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * Places island centres, deterministically and without overlap.
 * 1. The big islands ("hubs", radius >= 55% of the largest) sit on a ring/sphere around the origin, far enough
 *    apart that every pair keeps `islandGap`.
 * 2. Each remaining island ("satellite"), largest first, goes next to the placed island it imports from or to
 *    most, on the free spot closest to its linked neighbours.
 * 3. A last pairwise relaxation guarantees that no two spheres are closer than `r1 + r2 + islandGap`.
 */
function placeIslands(
  islands: { id: string; radius: number }[],
  links: { a: string; b: string; w: number }[],
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const n = islands.length;
  if (n === 1) {
    out.set((islands[0] as { id: string }).id, { x: 0, y: 0, z: 0 });
    return out;
  }
  const order = [...islands].sort((a, b) => b.radius - a.radius || cmp(a.id, b.id));
  const maxR = (order[0] as { radius: number }).radius;
  let hubCount = order.filter((i) => i.radius >= maxR * 0.55).length;
  hubCount = Math.max(2, hubCount);
  const weight = new Map<string, Map<string, number>>();
  const addW = (a: string, b: string, w: number): void => {
    const m = weight.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + w);
    weight.set(a, m);
  };
  for (const l of links) {
    addW(l.a, l.b, l.w);
    addW(l.b, l.a, l.w);
  }

  const placed: Body[] = [];
  const hubs = order.slice(0, hubCount);
  if (hubs.length === 2) {
    const [a, b] = hubs as [(typeof hubs)[number], (typeof hubs)[number]];
    const d = a.radius + b.radius + islandGap(a.radius, b.radius) * 1.6;
    placed.push(
      body(a.id, { x: -d / 2, y: 0, z: 0 }, a.radius),
      body(b.id, { x: d / 2, y: 0, z: 0 }, b.radius),
    );
  } else {
    const dirs = hubs.map((_, i) => fibonacci(i, hubs.length));
    let R = 0;
    for (let i = 0; i < hubs.length; i++) {
      for (let j = i + 1; j < hubs.length; j++) {
        const a = hubs[i] as (typeof hubs)[number];
        const b = hubs[j] as (typeof hubs)[number];
        const chord = len(sub(dirs[i] as Vec3, dirs[j] as Vec3));
        R = Math.max(R, (a.radius + b.radius + islandGap(a.radius, b.radius) * 1.6) / Math.max(chord, 1e-6));
      }
    }
    for (const [i, h] of hubs.entries()) placed.push(body(h.id, mul(dirs[i] as Vec3, R), h.radius));
  }

  const candidates = Array.from({ length: 64 }, (_, i) => fibonacci(i, 64));
  const free = (p: Vec3, r: number): boolean =>
    placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) >= q.r + r + islandGap(q.r, r) - 1e-6);
  for (const sat of order.slice(hubCount)) {
    const w = weight.get(sat.id);
    const linked = placed.filter((q) => (w?.get(q.id) ?? 0) > 0);
    const anchors = linked.length > 0 ? linked : placed;
    const total = linked.reduce((a, q) => a + (w?.get(q.id) ?? 0), 0);
    let best: { p: Vec3; score: number } | null = null;
    for (let slack = 1; best === null; slack *= 1.12) {
      for (const anchor of anchors) {
        const dist = (anchor.r + sat.radius + islandGap(anchor.r, sat.radius)) * slack;
        for (const dir of candidates) {
          const p = { x: anchor.x + dir.x * dist, y: anchor.y + dir.y * dist, z: anchor.z + dir.z * dist };
          if (!free(p, sat.radius)) continue;
          let score = 0;
          if (total > 0) {
            for (const q of linked) {
              score += ((w?.get(q.id) ?? 0) / total) * Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            }
          } else score = Math.hypot(p.x, p.y, p.z);
          score += 0.001 * Math.hypot(p.x, p.y, p.z);
          if (best === null || score < best.score - 1e-9) best = { p, score };
        }
      }
    }
    placed.push(body(sat.id, best.p, sat.radius));
  }
  separate(placed, (a, b) => islandGap(a.r, b.r), 3000);
  // A little breathing room: scaling about the origin only ever increases distances.
  for (const b of placed) {
    b.x *= 1.12;
    b.y *= 1.12;
    b.z *= 1.12;
  }
  // Centre on the mass-weighted middle so the orbit target is the middle of the picture.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let m = 0;
  for (const b of placed) {
    const w = b.r * b.r;
    cx += b.x * w;
    cy += b.y * w;
    cz += b.z * w;
    m += w;
  }
  for (const b of placed) out.set(b.id, { x: b.x - cx / m, y: b.y - cy / m, z: b.z - cz / m });
  return out;
}

/** The bundled arc between two islands, bowed away from the scene centre and shifted sideways per direction. */
function arcPoints(a: Island, b: Island): { p0: Vec3; p1: Vec3; p2: Vec3 } {
  const dir = norm(sub(b.center, a.center));
  const forward = a.id < b.id;
  const p0 = add(a.center, mul(dir, a.radius));
  const p2 = sub(b.center, mul(dir, b.radius));
  const mid = mul(add(p0, p2), 0.5);
  const span = len(sub(p2, p0));
  let out = sub(mid, mul(dir, dot(mid, dir)));
  if (len(out) < 1e-6) out = cross(dir, { x: 0, y: 1, z: 0 });
  out = norm(out);
  const side = norm(cross(dir, out));
  const lateral = mul(side, (forward ? 1 : -1) * span * 0.07);
  const p1 = add(add(mid, mul(out, span * 0.22 + 6)), lateral);
  return { p0, p1, p2 };
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Label, kind and counts for an island, from its workspace node (when the view sends one) and its members. */
function islandInfo(
  meta: GraphNode | undefined,
  list: GraphNode[],
): { label: string; wsKind: string; functions: number; files: number } {
  const count = (re: RegExp): number | null => {
    const text = meta?.badges?.find((b) => re.test(b));
    return text ? Number.parseInt(text, 10) : null;
  };
  const first = meta?.badges?.[0];
  return {
    label: meta?.label ?? "",
    wsKind: first && !/\d/.test(first) ? first : "package",
    functions: count(/functions$/) ?? list.reduce((a, n) => a + n.size, 0),
    files: count(/files$/) ?? list.length,
  };
}

export interface IslandSummary {
  id: string;
  label: string;
  fullLabel: string;
  wsKind: string;
  index: number;
  functions: number;
  files: number;
}

/** Islands in colour order, without running the layout. The legend uses this. */
export function summarizeIslands(nodes: GraphNode[]): IslandSummary[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasChildren = new Set(nodes.flatMap((n) => (n.parent ? [n.parent] : [])));
  const members = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.parent && hasChildren.has(n.id)) continue;
    const g = n.parent ?? n.id;
    members.set(g, [...(members.get(g) ?? []), n]);
  }
  return [...members.keys()].sort(cmp).map((id, index) => ({
    id,
    index,
    ...islandInfo(byId.get(id), members.get(id) ?? []),
    label: byId.get(id)?.shortLabel ?? byId.get(id)?.label ?? id,
    fullLabel: byId.get(id)?.label ?? id,
  }));
}

/** Picks the camera direction (from a fixed candidate set) where the projected island discs overlap least. */
function bestViewDir(islands: Island[]): Vec3 {
  const candidates: Vec3[] = [];
  for (let i = 0; i < 240; i++) {
    const d = fibonacci(i, 240);
    if (d.y > 0 && d.y < 0.9) candidates.push(d);
  }
  let best = { x: 0.35, y: 0.4, z: 0.85 };
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const d of candidates) {
    const right = norm(cross({ x: 0, y: 1, z: 0 }, d));
    const up = cross(d, right);
    let score = Number.POSITIVE_INFINITY;
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const a = islands[i] as Island;
        const b = islands[j] as Island;
        const diff = sub(a.center, b.center);
        const d2 = Math.hypot(dot(diff, right), dot(diff, up));
        score = Math.min(score, (d2 - (a.radius + b.radius) * 1.2) / (a.radius + b.radius));
      }
    }
    if (islands.length < 2) score = 0;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = d;
    }
  }
  return norm(best);
}

export interface LayoutInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function computeLayout({ nodes, edges }: LayoutInput): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groupOf = (id: string): string | null => {
    const n = byId.get(id);
    return n ? (n.parent ?? n.id) : null;
  };

  // Groups: a workspace node is metadata when other nodes name it as parent; otherwise it is itself drawn.
  const children = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.parent) {
      const list = children.get(n.parent) ?? [];
      list.push(n);
      children.set(n.parent, list);
    }
  }
  const drawn: GraphNode[] = nodes.filter((n) => n.parent || !children.has(n.id));
  const groupIds = [...new Set(drawn.map((n) => n.parent ?? n.id))].sort(cmp);

  const members = new Map<string, GraphNode[]>();
  for (const n of drawn) {
    const g = n.parent ?? n.id;
    const list = members.get(g) ?? [];
    list.push(n);
    members.set(g, list);
  }

  // Node-level edges split into inside-island springs and cross-island totals.
  const inside = new Map<string, { a: string; b: string; w: number }[]>();
  const cross_ = new Map<string, { src: string; dst: string; w: number; imports: number }>();
  for (const e of edges) {
    const ga = groupOf(e.src);
    const gb = groupOf(e.dst);
    if (!ga || !gb) continue;
    if (ga === gb) {
      if (e.src === e.dst) continue;
      const list = inside.get(ga) ?? [];
      list.push({ a: e.src, b: e.dst, w: e.weight });
      inside.set(ga, list);
    } else {
      const key = `${ga}\u0000${gb}`;
      const c = cross_.get(key) ?? { src: ga, dst: gb, w: 0, imports: 0 };
      c.w += e.weight;
      if (e.kind !== "depends_on") c.imports += e.weight;
      cross_.set(key, c);
    }
  }

  const local = new Map<string, Map<string, Vec3>>();
  const radii = new Map<string, number>();
  for (const g of groupIds) {
    const list = members.get(g) ?? [];
    const r = layoutIsland(list, inside.get(g) ?? [], islandInfo(byId.get(g), list).functions);
    local.set(g, r.pos);
    radii.set(g, r.radius);
  }

  const links = [...cross_.values()].map((c) => ({ a: c.src, b: c.dst, w: c.w }));
  const centers = placeIslands(
    groupIds.map((id) => ({ id, radius: radii.get(id) as number })),
    links,
  );

  const positions = new Map<string, Vec3>();
  const nodeR = new Map<string, number>();
  const islands: Island[] = groupIds.map((id, index) => {
    const meta = byId.get(id);
    const center = centers.get(id) as Vec3;
    const list = members.get(id) ?? [];
    for (const n of list) {
      const p = (local.get(id) as Map<string, Vec3>).get(n.id) as Vec3;
      positions.set(n.id, add(center, p));
      nodeR.set(n.id, nodeRadius(n.size, n.kind));
    }
    const info = islandInfo(meta, list);
    return {
      id,
      label: meta?.shortLabel ?? meta?.label ?? id,
      fullLabel: meta?.label ?? id,
      wsKind: info.wsKind,
      index,
      center,
      radius: radii.get(id) as number,
      nodeIds: list.map((n) => n.id).sort(cmp),
      functions: info.functions,
      files: info.files,
    };
  });
  const islandById = new Map(islands.map((i) => [i.id, i]));

  const arcs: Arc[] = [...cross_.values()]
    .sort((a, b) => cmp(a.src + a.dst, b.src + b.dst))
    .map((c) => {
      const a = islandById.get(c.src) as Island;
      const b = islandById.get(c.dst) as Island;
      return {
        id: `${c.src}>${c.dst}`,
        src: c.src,
        dst: c.dst,
        weight: c.imports > 0 ? c.imports : c.w,
        dependsOnly: c.imports === 0,
        ...arcPoints(a, b),
      };
    });

  let extent = 0;
  for (const i of islands) extent = Math.max(extent, len(i.center) + i.radius);
  return { positions, nodeRadius: nodeR, islands, arcs, extent, viewDir: bestViewDir(islands) };
}

/** Stable digest of the rounded positions; used to check that two loads draw the same picture. */
export function positionHash(layout: Layout): string {
  const ids = [...layout.positions.keys()].sort(cmp);
  let s = "";
  for (const id of ids) {
    const p = layout.positions.get(id) as Vec3;
    s += `${id}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)};`;
  }
  return fnv1a(s).toString(16).padStart(8, "0");
}

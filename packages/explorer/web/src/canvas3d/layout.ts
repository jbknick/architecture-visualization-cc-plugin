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

/** A group of file nodes sharing a folder inside an island (Files level only). */
export interface Cluster {
  id: string;
  island: string;
  /** Folder key inside the workspace: up to two segments ("src/components"), "." for the workspace root. */
  key: string;
  center: Vec3;
  radius: number;
  functions: number;
  files: number;
  /** Rank by functions inside the island (0 = biggest folder). */
  rank: number;
  nodeIds: string[];
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
  /** Folder clusters of file nodes (empty at the Workspaces and Folders levels). */
  clusters: Cluster[];
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

/** Sphere radius for a node: sqrt scale of the function count (area follows functions), clamped. */
export function nodeRadius(size: number, kind: string): number {
  const s = Math.sqrt(Math.max(0, size));
  if (kind === "workspace") return clamp(3 + s * 0.6, 3, 26);
  if (kind === "dir") return clamp(1.2 + s * 0.8, 1.2, 22);
  return clamp(1.2 + s * 0.9, 1.2, 12);
}

/** On-screen height (px) of an island's name label: grows with sqrt of its function count, clamped. */
export function islandLabelPx(functions: number): number {
  return clamp(12 + 0.5 * Math.sqrt(Math.max(0, functions)), 12, 30);
}

/** Tube diameter (px) of an inter-island arc: sqrt of its import count, clamped. */
export function arcWidthPx(weight: number): number {
  return clamp(1.2 + Math.sqrt(Math.max(0, weight)) * 0.45, 1.5, 6);
}

/**
 * Island radius, a function of the workspace's function count alone (never of what is drawn inside), so the
 * Workspaces, Folders and Files levels share one picture.
 */
export function islandRadius(functions: number): number {
  return 9 + 1.3 * Math.sqrt(Math.max(0, functions));
}

/** Required empty space between two island spheres: generous for small islands, so arrows and names fit. */
export function islandGap(ra: number, rb: number): number {
  return 22 + 0.3 * Math.max(ra, rb) + 0.6 * Math.min(ra, rb);
}

/** Drops a leading `src/` when every label has it ("src/lib" -> "lib"); otherwise returns the labels unchanged. */
export function stripSharedSrc(labels: string[]): string[] {
  if (labels.length === 0 || !labels.every((l) => l.startsWith("src/") && l.length > 4)) return labels;
  return labels.map((l) => l.slice(4));
}

/** "components · 855 fn" */
export function folderCaption(name: string, functions: number): string {
  return `${name} · ${functions.toLocaleString("en-US")} fn`;
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

interface CloudResult {
  pos: Map<string, Vec3>;
  /** Largest distance from the origin to a sphere's far side. */
  extent: number;
}

/** Force layout of a set of spheres: repulsion by size, springs along edges, then hard separation. */
function layoutCloud(
  nodes: GraphNode[],
  edges: { a: string; b: string; w: number }[],
  radiusOf: (n: GraphNode) => number,
  repel = 1,
): CloudResult {
  const sorted = [...nodes].sort((a, b) => b.size - a.size || cmp(a.id, b.id));
  const pos = new Map<string, Vec3>();
  if (sorted.length === 1) {
    const only = sorted[0] as GraphNode;
    pos.set(only.id, { x: 0, y: 0, z: 0 });
    return { pos, extent: radiusOf(only) };
  }
  const radii = sorted.map(radiusOf);
  const volume = radii.reduce((a, r) => a + r * r * r, 0);
  const target = Math.max(8, 2.1 * Math.cbrt(volume * repel));
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
        const f = (14 * repel * (a.r + b.r)) / d2; // repulsion, stronger for big nodes
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
  let extent = 0;
  for (const b of bodies) extent = Math.max(extent, Math.hypot(b.x, b.y, b.z) + b.r);
  for (const b of bodies) pos.set(b.id, { x: b.x, y: b.y, z: b.z });
  return { pos, extent };
}

/** Folder key of a file or folded node inside its workspace: up to two directory segments, "." for the root. */
export function folderKey(n: GraphNode, wsDir: string): string {
  const path = n.path ?? n.id.replace(/^(file|more):/, "");
  let rel = path;
  if (wsDir !== "." && wsDir !== "") {
    if (path === wsDir) rel = ".";
    else if (path.startsWith(`${wsDir}/`)) rel = path.slice(wsDir.length + 1);
  }
  if (rel === ".") return ".";
  const segs = rel.split("/");
  if (n.kind !== "folded") segs.pop();
  const key = segs.slice(0, 2).join("/");
  return key || ".";
}

/** Longest directory prefix shared by all paths ("." when none). */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return ".";
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] as string[];
  let n = first.length;
  for (const d of dirs) {
    let k = 0;
    while (k < n && k < d.length && d[k] === first[k]) k++;
    n = k;
  }
  return n === 0 ? "." : first.slice(0, n).join("/");
}

interface IslandInner {
  pos: Map<string, Vec3>;
  radii: Map<string, number>;
  clusters: {
    key: string;
    center: Vec3;
    radius: number;
    functions: number;
    files: number;
    nodeIds: string[];
  }[];
}

/**
 * Lays one island's nodes out inside a sphere of the given radius (which was fixed by the function count alone).
 * A lone node is one sphere in the middle; file nodes are grouped in one cluster per folder; folders form a cloud.
 * Everything is scaled uniformly to fill about 90% of the sphere.
 */
function layoutInside(
  nodes: GraphNode[],
  edges: { a: string; b: string; w: number }[],
  R: number,
  wsDir: string,
): IslandInner {
  const radii = new Map<string, number>();
  const pos = new Map<string, Vec3>();
  const clusters: IslandInner["clusters"] = [];
  const sorted = [...nodes].sort((a, b) => b.size - a.size || cmp(a.id, b.id));
  if (sorted.length === 1) {
    const only = sorted[0] as GraphNode;
    pos.set(only.id, { x: 0, y: 0, z: 0 });
    radii.set(only.id, R * 0.5);
    return { pos, radii, clusters };
  }
  const rOf = (n: GraphNode): number => nodeRadius(n.size, n.kind);
  const isFile = sorted.some((n) => n.kind === "file" || n.kind === "folded");
  let extent = 0;
  if (!isFile) {
    const c = layoutCloud(sorted, edges, rOf);
    for (const [id, p] of c.pos) pos.set(id, p);
    extent = c.extent;
  } else {
    const groups = new Map<string, GraphNode[]>();
    for (const n of sorted) {
      const k = folderKey(n, wsDir);
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const fa = (groups.get(a) ?? []).reduce((s, n) => s + n.size, 0);
      const fb = (groups.get(b) ?? []).reduce((s, n) => s + n.size, 0);
      return fb - fa || cmp(a, b);
    });
    const clouds = keys.map((k) => {
      const list = groups.get(k) as GraphNode[];
      const ids = new Set(list.map((n) => n.id));
      const inner = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
      return { key: k, list, cloud: layoutCloud(list, inner, rOf, 2.6) };
    });
    // Pack the folder clouds: biggest first, near the middle, never overlapping.
    const bodies = clouds.map((c, i) => {
      const dir = fibonacci(i, clouds.length);
      const k = i === 0 ? 0 : c.cloud.extent * 2 + i * 1.5;
      return body(c.key, { x: dir.x * k, y: dir.y * k, z: dir.z * k }, c.cloud.extent * 1.04);
    });
    for (let it = 0; it < 90; it++) {
      for (const b of bodies) {
        b.x *= 0.94;
        b.y *= 0.94;
        b.z *= 0.94;
      }
      separate(bodies, (a, b) => 3 + 0.3 * (a.r + b.r), 1);
    }
    separate(bodies, (a, b) => 3 + 0.3 * (a.r + b.r), 200);
    const byKey = new Map(bodies.map((b) => [b.id, b]));
    for (const c of clouds) {
      const b = byKey.get(c.key) as Body;
      for (const [id, p] of c.cloud.pos) pos.set(id, { x: p.x + b.x, y: p.y + b.y, z: p.z + b.z });
      extent = Math.max(extent, Math.hypot(b.x, b.y, b.z) + b.r);
      clusters.push({
        key: c.key,
        center: { x: b.x, y: b.y, z: b.z },
        radius: b.r,
        functions: c.list.reduce((s, n) => s + n.size, 0),
        files: c.list.length,
        nodeIds: c.list.map((n) => n.id),
      });
    }
  }
  // Fill the sphere (about 90% of it), shrinking big clouds and growing small ones, so spheres do not pile up.
  const s = clamp((R * 0.9) / Math.max(extent, 1e-6), 0.15, 8);
  for (const n of sorted) {
    const p = pos.get(n.id) as Vec3;
    pos.set(n.id, mul(p, s));
    radii.set(n.id, rOf(n) * s);
  }
  for (const c of clusters) {
    c.center = mul(c.center, s);
    c.radius *= s;
  }
  return { pos, radii, clusters };
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
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Places island centres, deterministically and without overlap, mostly in one plane (z = 0) so that the default
 * camera, which faces that plane, sees a map. The input is only (id, radius, links): function counts and the
 * workspace-to-workspace import weights, never what is drawn inside an island.
 * 1. Islands go in order of size. The biggest sits at the origin; each next one takes the free spot (on a ring
 *    around an island it links to, or around any island) closest to its linked neighbours, with the required gap.
 * 2. The plane is rotated so that its long axis is horizontal.
 * 3. A shallow dome lifts the middle towards the camera, a secondary depth cue; it only ever increases distances.
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
  const first = order[0] as (typeof order)[number];
  placed.push(body(first.id, { x: 0, y: 0, z: 0 }, first.radius));
  const ANGLES = 48;
  const free = (x: number, y: number, r: number): boolean =>
    placed.every((q) => Math.hypot(x - q.x, y - q.y) >= q.r + r + islandGap(q.r, r) - 1e-6);
  for (const isl of order.slice(1)) {
    const w = weight.get(isl.id);
    const linked = placed.filter((q) => (w?.get(q.id) ?? 0) > 0);
    const anchors = linked.length > 0 ? linked : placed;
    const total = linked.reduce((a, q) => a + (w?.get(q.id) ?? 0), 0);
    let mx = 0;
    let my = 0;
    let mm = 0;
    for (const q of placed) {
      mx += q.x * q.r * q.r;
      my += q.y * q.r * q.r;
      mm += q.r * q.r;
    }
    mx /= mm;
    my /= mm;
    let best: { x: number; y: number; score: number } | null = null;
    for (let slack = 1; best === null; slack *= 1.1) {
      for (const anchor of anchors) {
        const dist = (anchor.r + isl.radius + islandGap(anchor.r, isl.radius)) * slack;
        for (let k = 0; k < ANGLES; k++) {
          const ang = (k / ANGLES) * Math.PI * 2;
          const x = anchor.x + Math.cos(ang) * dist;
          const y = anchor.y + Math.sin(ang) * dist;
          if (!free(x, y, isl.radius)) continue;
          let score = 0;
          if (total > 0) {
            for (const q of linked) score += ((w?.get(q.id) ?? 0) / total) * Math.hypot(x - q.x, y - q.y);
          }
          score += 0.35 * Math.hypot(x - mx, y - my);
          if (best === null || score < best.score - 1e-9) best = { x, y, score };
        }
      }
    }
    placed.push(body(isl.id, { x: best.x, y: best.y, z: 0 }, isl.radius));
  }
  separate(placed, (a, b) => islandGap(a.r, b.r), 3000);

  // Centre on the mass-weighted middle, then rotate the principal axis onto x.
  let cx = 0;
  let cy = 0;
  let m = 0;
  for (const b of placed) {
    const wt = b.r * b.r;
    cx += b.x * wt;
    cy += b.y * wt;
    m += wt;
  }
  cx /= m;
  cy /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const b of placed) {
    const wt = b.r * b.r;
    sxx += (b.x - cx) ** 2 * wt;
    syy += (b.y - cy) ** 2 * wt;
    sxy += (b.x - cx) * (b.y - cy) * wt;
  }
  const theta = Math.abs(sxy) < 1e-6 * (sxx + syy) ? 0 : 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cs = Math.cos(-theta);
  const sn = Math.sin(-theta);
  let reach = 0;
  const flat = placed.map((b) => {
    const x = b.x - cx;
    const y = b.y - cy;
    const p = { id: b.id, x: x * cs - y * sn, y: x * sn + y * cs, r: b.r };
    reach = Math.max(reach, Math.hypot(p.x, p.y) + b.r);
    return p;
  });
  for (const p of flat) {
    const d = Math.hypot(p.x, p.y) / Math.max(reach, 1);
    out.set(p.id, { x: p.x, y: p.y, z: reach * 0.16 * (1 - Math.min(1, d * d)) });
  }
  return out;
}

/** The bundled arc between two islands, bowed away from the scene centre and shifted sideways per direction. */
function arcPoints(a: Island, b: Island): { p0: Vec3; p1: Vec3; p2: Vec3 } {
  const dir = norm(sub(b.center, a.center));
  const forward = a.id < b.id;
  const p0 = add(a.center, mul(dir, a.radius + 1));
  // Ends just outside the target island's surface, where the arrowhead's tip sits.
  const p2 = sub(b.center, mul(dir, b.radius + 2));
  const mid = mul(add(p0, p2), 0.5);
  const span = len(sub(p2, p0));
  let out = sub(mid, mul(dir, dot(mid, dir)));
  if (len(out) < 1e-6) out = cross(dir, { x: 0, y: 1, z: 0 });
  out = norm(out);
  const side = norm(cross(dir, out));
  const lateral = mul(side, (forward ? 1 : -1) * span * 0.07);
  const p1 = add(add(mid, mul(out, span * 0.2 + 5)), lateral);
  return { p0, p1, p2 };
}

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
    functions: count(/functions$/) ?? meta?.stats?.functions ?? list.reduce((a, n) => a + n.size, 0),
    files: count(/files$/) ?? meta?.stats?.files ?? list.length,
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

/**
 * Picks the default camera direction. The islands lie roughly in the z = 0 plane, so the candidates are a fixed
 * set of directions in a cone around +z (with some tilt for depth). The winner has the least projected overlap
 * between island discs; ties go to the widest smallest gap, then to the gentler tilt.
 */
export function bestViewDir(islands: { center: Vec3; radius: number }[]): Vec3 {
  let best: { d: Vec3; overlap: number; gap: number; tilt: number } | null = null;
  for (const tiltDeg of [12, 18, 24, 30, 36, 42]) {
    for (let az = 0; az < 360; az += 30) {
      const t = (tiltDeg * Math.PI) / 180;
      const p = (az * Math.PI) / 180;
      const d = { x: Math.sin(t) * Math.cos(p), y: Math.sin(t) * Math.sin(p), z: Math.cos(t) };
      const right = norm(cross({ x: 0, y: 1, z: 0 }, d));
      const up = cross(d, right);
      let overlap = 0;
      let gap = Number.POSITIVE_INFINITY;
      for (let i = 0; i < islands.length; i++) {
        for (let j = i + 1; j < islands.length; j++) {
          const a = islands[i] as { center: Vec3; radius: number };
          const b = islands[j] as { center: Vec3; radius: number };
          const diff = sub(a.center, b.center);
          const dist = Math.hypot(dot(diff, right), dot(diff, up));
          const need = (a.radius + b.radius) * 1.08;
          overlap += Math.max(0, need - dist);
          gap = Math.min(gap, (dist - (a.radius + b.radius)) / (a.radius + b.radius));
        }
      }
      if (islands.length < 2) gap = 0;
      // Favour a view from above (az 90) very slightly, so the same data always tilts the same way.
      const tilt = tiltDeg + Math.abs(((az - 90 + 540) % 360) - 180) / 90;
      const better =
        best === null ||
        overlap < best.overlap - 1e-6 ||
        (Math.abs(overlap - best.overlap) <= 1e-6 &&
          (gap > best.gap + 0.02 || (Math.abs(gap - best.gap) <= 0.02 && tilt < best.tilt)));
      if (better) best = { d, overlap, gap, tilt };
    }
  }
  return norm(best?.d ?? { x: 0, y: 0.3, z: 0.95 });
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
  const hasChildren = new Set<string>();
  for (const n of nodes) if (n.parent) hasChildren.add(n.parent);
  const drawn: GraphNode[] = nodes.filter((n) => n.parent || !hasChildren.has(n.id));
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

  // Island size and placement come from workspace-level facts only (function counts, imports between workspaces).
  const info = new Map(groupIds.map((g) => [g, islandInfo(byId.get(g), members.get(g) ?? [])]));
  const radii = new Map(
    groupIds.map((g) => [g, islandRadius((info.get(g) as { functions: number }).functions)]),
  );
  const links = [...cross_.values()].map((c) => ({ a: c.src, b: c.dst, w: c.w }));
  const centers = placeIslands(
    groupIds.map((id) => ({ id, radius: radii.get(id) as number })),
    links,
  );

  const positions = new Map<string, Vec3>();
  const nodeR = new Map<string, number>();
  const clusters: Cluster[] = [];
  const islands: Island[] = groupIds.map((id, index) => {
    const meta = byId.get(id);
    const center = centers.get(id) as Vec3;
    const list = members.get(id) ?? [];
    const radius = radii.get(id) as number;
    const wsDir = meta?.path ?? commonDir(list.map((n) => n.path ?? "").filter(Boolean));
    const inner = layoutInside(list, inside.get(id) ?? [], radius, wsDir);
    for (const n of list) {
      positions.set(n.id, add(center, inner.pos.get(n.id) as Vec3));
      nodeR.set(n.id, inner.radii.get(n.id) as number);
    }
    for (const [rankInIsland, c] of inner.clusters.entries()) {
      clusters.push({
        id: `dir:${id}:${c.key}`,
        island: id,
        key: c.key,
        center: add(center, c.center),
        radius: c.radius,
        functions: c.functions,
        files: c.files,
        rank: rankInIsland,
        nodeIds: c.nodeIds,
      });
    }
    const inf = info.get(id) as ReturnType<typeof islandInfo>;
    return {
      id,
      label: meta?.shortLabel ?? meta?.label ?? id,
      fullLabel: meta?.label ?? id,
      wsKind: inf.wsKind,
      index,
      center,
      radius,
      nodeIds: list.map((n) => n.id).sort(cmp),
      functions: inf.functions,
      files: inf.files,
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
  return { positions, nodeRadius: nodeR, islands, arcs, clusters, extent, viewDir: bestViewDir(islands) };
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

/** Digest of island centres, radii and the default camera only: equal at every level for the same workspaces. */
export function islandHash(layout: Layout): string {
  let s = `${layout.viewDir.x.toFixed(4)},${layout.viewDir.y.toFixed(4)},${layout.viewDir.z.toFixed(4)};`;
  for (const i of layout.islands) {
    s += `${i.id}:${i.center.x.toFixed(3)},${i.center.y.toFixed(3)},${i.center.z.toFixed(3)},${i.radius.toFixed(3)};`;
  }
  return fnv1a(s).toString(16).padStart(8, "0");
}

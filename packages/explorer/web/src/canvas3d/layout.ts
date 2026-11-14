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
  /** app / package / "(repo root)", from the workspace node's first badge ("unknown" is shown as "(repo root)"). */
  wsKind: string;
  /** Index in the sorted island list; selects the colour. */
  index: number;
  center: Vec3;
  radius: number;
  /** Ids of the drawn nodes inside the island. */
  nodeIds: string[];
  functions: number;
  files: number;
  /** Folders without any function: not drawn, only counted in the tooltip ("+N empty"). */
  emptyFolders: number;
}

/** A folder inside an island: one disc of the circle packing (Folders level: the sphere; Files level: the ring). */
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
  /** Imported names behind the imports, when that differs from `weight`. */
  bindings?: number;
  /** True when the arc only comes from package.json `depends_on`, not from imports. */
  dependsOnly: boolean;
  /** True when the opposite direction between the same two islands exists too (the two arcs bow to opposite sides). */
  reciprocal: boolean;
  /** Which side of its chord the arc bows to (+1 or -1, relative to the camera-facing normal of the chord). */
  side: 1 | -1;
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
  /** Folder discs (empty at the Workspaces level; one per folder with functions, in packing order). */
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
  if (n.kind !== "folded" && n.kind !== "dir") segs.pop();
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

export interface PackedCircle {
  id: string;
  x: number;
  y: number;
  r: number;
}

/**
 * Deterministic circle packing on a flat disc. Circles go biggest first; each takes the spot (tangent to two
 * placed circles, or to one) closest to the centroid of what is already placed that overlaps nothing, with `pad`
 * of clear space between neighbours. The result is re-centred on the (approximately) smallest enclosing circle,
 * whose radius is returned. No randomness: the same input always gives the same picture.
 */
export function packCircles(
  items: { id: string; r: number }[],
  pad: number,
): { circles: PackedCircle[]; radius: number } {
  const sorted = [...items].sort((a, b) => b.r - a.r || cmp(a.id, b.id));
  const placed: PackedCircle[] = [];
  const fits = (x: number, y: number, r: number): boolean =>
    placed.every((q) => Math.hypot(x - q.x, y - q.y) >= q.r + r + pad - 1e-9);
  for (const it of sorted) {
    if (placed.length === 0) {
      placed.push({ id: it.id, x: 0, y: 0, r: it.r });
      continue;
    }
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
    const consider = (x: number, y: number): void => {
      if (!fits(x, y, it.r)) return;
      const score = Math.hypot(x - mx, y - my);
      if (
        best === null ||
        score < best.score - 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 && (x < best.x || (x === best.x && y < best.y)))
      )
        best = { x, y, score };
    };
    for (const a of placed) {
      const da = a.r + it.r + pad;
      for (let k = 0; k < 16; k++) {
        const t = (k / 16) * Math.PI * 2;
        consider(a.x + Math.cos(t) * da, a.y + Math.sin(t) * da);
      }
    }
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i] as PackedCircle;
      for (let j = i + 1; j < placed.length; j++) {
        const b = placed[j] as PackedCircle;
        const da = a.r + it.r + pad;
        const db = b.r + it.r + pad;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-9 || d > da + db || d < Math.abs(da - db)) continue;
        const k = (da * da - db * db + d * d) / (2 * d);
        const h = Math.sqrt(Math.max(0, da * da - k * k));
        const px = a.x + (dx * k) / d;
        const py = a.y + (dy * k) / d;
        consider(px + (-dy * h) / d, py + (dx * h) / d);
        consider(px - (-dy * h) / d, py - (dx * h) / d);
      }
    }
    const spot = best as { x: number; y: number } | null;
    // Unreachable in practice (a tangent spot to one circle always exists), but never lose a circle.
    placed.push(spot ? { id: it.id, x: spot.x, y: spot.y, r: it.r } : { id: it.id, x: 1e3, y: 0, r: it.r });
  }
  // Re-centre on the minimax centre: walk towards the farthest circle with shrinking steps.
  let cx = 0;
  let cy = 0;
  for (const q of placed) {
    cx += q.x;
    cy += q.y;
  }
  cx /= placed.length;
  cy /= placed.length;
  const reach = (): { r: number; q: PackedCircle } => {
    let far = placed[0] as PackedCircle;
    let r = -1;
    for (const q of placed) {
      const d = Math.hypot(q.x - cx, q.y - cy) + q.r;
      if (d > r) {
        r = d;
        far = q;
      }
    }
    return { r, q: far };
  };
  for (let it = 0; it < 80; it++) {
    const { r, q } = reach();
    const d = Math.hypot(q.x - cx, q.y - cy);
    if (d < 1e-9) break;
    const step = ((r - q.r) * 0.5) / (1 + it * 0.35);
    cx += ((q.x - cx) / d) * Math.min(step, d);
    cy += ((q.y - cy) / d) * Math.min(step, d);
  }
  const radius = reach().r;
  return { circles: placed.map((q) => ({ ...q, x: q.x - cx, y: q.y - cy })), radius };
}

/** Smallest folder radius, as a fraction of the biggest folder's. */
const FOLDER_FLOOR = 0.14;

/**
 * Folder discs of one island: radius proportional to sqrt(functions) (floored so tiny folders stay visible),
 * packed without overlap and scaled to fit a disc of radius `fit`. Both the Folders and the Files level call this
 * with the same (key, functions) list, so the folders sit in the same places at both levels.
 */
export function packFolders(
  folders: { key: string; functions: number }[],
  fit: number,
): { circles: PackedCircle[]; scale: number } {
  const fmax = Math.max(1, ...folders.map((f) => f.functions));
  const floor = FOLDER_FLOOR * Math.sqrt(fmax);
  const items = folders.map((f) => ({ id: f.key, r: Math.max(floor, Math.sqrt(Math.max(0, f.functions))) }));
  const pad = 0.07 * Math.max(...items.map((i) => i.r));
  const { circles, radius } = packCircles(items, pad);
  const scale = fit / Math.max(radius, 1e-9);
  return {
    circles: circles.map((c) => ({ id: c.id, x: c.x * scale, y: c.y * scale, r: c.r * scale })),
    scale,
  };
}

/**
 * Files of one folder as a sunflower (Vogel spiral) inside a ring of radius `rho`: biggest file in the middle,
 * dot radius proportional to sqrt(functions), never larger than what keeps it clear of its nearest neighbour.
 */
export function sunflower(files: { id: string; functions: number }[], rho: number): PackedCircle[] {
  const sorted = [...files].sort((a, b) => b.functions - a.functions || cmp(a.id, b.id));
  const n = sorted.length;
  if (n === 0) return [];
  if (n === 1) return [{ id: (sorted[0] as { id: string }).id, x: 0, y: 0, r: 0.5 * rho }];
  const inner = 0.82 * rho;
  const c = inner / (Math.sqrt(n - 1) + 0.5);
  const pts = sorted.map((f, i) => ({
    id: f.id,
    f: f.functions,
    x: c * Math.sqrt(i) * Math.cos(i * 2.399963229728653),
    y: c * Math.sqrt(i) * Math.sin(i * 2.399963229728653),
  }));
  const fmax = Math.max(1, (sorted[0] as { functions: number }).functions);
  const k = (0.75 * c) / Math.sqrt(fmax);
  return pts.map((p, i) => {
    let nn = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      const q = pts[j] as typeof p;
      if (j !== i) nn = Math.min(nn, Math.hypot(p.x - q.x, p.y - q.y));
    }
    const bound = 0.48 * nn;
    const want = Math.max(0.18 * c, k * Math.sqrt(Math.max(0, p.f)));
    return { id: p.id, x: p.x, y: p.y, r: Math.min(bound, want) };
  });
}

/** Screen axes of a camera looking along `-d` (same convention as `bestViewDir`). */
export function viewBasis(d: Vec3): { right: Vec3; up: Vec3 } {
  const right = norm(cross({ x: 0, y: 1, z: 0 }, d));
  return { right, up: cross(d, right) };
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
 * Everything lies on one flat disc through the island centre that faces the default camera.
 * - a lone node is one sphere in the middle;
 * - folders (Folders level) are discs packed without overlap, radius ~ sqrt(functions);
 * - files (Files level) sit in the same folder discs, as sunflower dots, the biggest file in the middle.
 */
function layoutInside(
  nodes: GraphNode[],
  R: number,
  wsDir: string,
  basis: { right: Vec3; up: Vec3 },
): IslandInner {
  const radii = new Map<string, number>();
  const pos = new Map<string, Vec3>();
  const clusters: IslandInner["clusters"] = [];
  const at = (x: number, y: number): Vec3 => add(mul(basis.right, x), mul(basis.up, y));
  const sorted = [...nodes].sort((a, b) => b.size - a.size || cmp(a.id, b.id));
  if (sorted.length === 0) return { pos, radii, clusters };
  if (sorted.length === 1) {
    const only = sorted[0] as GraphNode;
    pos.set(only.id, { x: 0, y: 0, z: 0 });
    radii.set(only.id, R * 0.5);
    return { pos, radii, clusters };
  }
  const groups = new Map<string, GraphNode[]>();
  for (const n of sorted) {
    const k = folderKey(n, wsDir);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const folders = [...groups].map(([key, list]) => ({
    key,
    list,
    functions: list.reduce((s, n) => s + n.size, 0),
  }));
  const isFiles = sorted.some((n) => n.kind === "file" || n.kind === "folded");
  const discs =
    folders.length === 1
      ? [{ id: (folders[0] as (typeof folders)[number]).key, x: 0, y: 0, r: R * 0.8 }]
      : packFolders(
          folders.map((f) => ({ key: f.key, functions: f.functions })),
          R * 0.9,
        ).circles;
  const byKey = new Map(discs.map((d) => [d.id, d]));
  const order = [...folders].sort((a, b) => b.functions - a.functions || cmp(a.key, b.key));
  for (const f of order) {
    const d = byKey.get(f.key) as PackedCircle;
    if (!isFiles) {
      for (const n of f.list) {
        pos.set(n.id, at(d.x, d.y));
        radii.set(n.id, d.r);
      }
    } else {
      const dots = sunflower(
        f.list.map((n) => ({ id: n.id, functions: n.size })),
        d.r,
      );
      for (const p of dots) {
        pos.set(p.id, at(d.x + p.x, d.y + p.y));
        radii.set(p.id, p.r);
      }
    }
    clusters.push({
      key: f.key,
      center: at(d.x, d.y),
      radius: d.r,
      functions: f.functions,
      files: f.list.length,
      nodeIds: f.list.map((n) => n.id),
    });
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

/** Up to this many visible arcs every arc gets a count pill; above it only the heaviest TOP_PILLS do. */
export const ALL_PILLS = 40;
export const TOP_PILLS = 8;

/** Ids of the arcs that get a count pill: all of them when there are at most ALL_PILLS, else the heaviest few. */
export function pillArcIds(arcs: { id: string; weight: number; dependsOnly: boolean }[]): Set<string> {
  if (arcs.length <= ALL_PILLS) return new Set(arcs.map((a) => a.id));
  return new Set(
    arcs
      .filter((a) => !a.dependsOnly)
      .sort((a, b) => b.weight - a.weight || cmp(a.id, b.id))
      .slice(0, TOP_PILLS)
      .map((a) => a.id),
  );
}

/** On-screen distance (px) kept between two arrowheads that end on the same island (and between arc starts). */
export const ARROW_SPREAD_PX = 14;
/** Rough pixels per world unit at the default camera, used to turn pixel gaps into angles at layout time. */
export function pxPerUnit(extent: number): number {
  return 330 / Math.max(extent, 1);
}

/** Minimum angle (radians) between two arc ends on a rim of world radius `radius`. */
export function arrowSpreadAngle(radius: number, extent: number): number {
  return clamp(ARROW_SPREAD_PX / (Math.max(radius, 1) * pxPerUnit(extent)), 0.12, 1.1);
}

/**
 * Spreads angles around a circle so that neighbours are at least `sep` apart, moving each as little as it can.
 * Returns the new angle per key (same order of keys; ties broken by key so it is deterministic).
 */
export function spreadAngles(items: { key: string; angle: number }[], sep: number): Map<string, number> {
  const n = items.length;
  const out = new Map<string, number>();
  if (n === 0) return out;
  const gap = Math.min(sep, (Math.PI * 2) / n);
  const wrap = (a: number): number => {
    let x = a % (Math.PI * 2);
    if (x < 0) x += Math.PI * 2;
    return x;
  };
  const sorted = items
    .map((i) => ({ key: i.key, a: wrap(i.angle) }))
    .sort((p, q) => p.a - q.a || cmp(p.key, q.key));
  for (let it = 0; it < 400; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = sorted[i] as (typeof sorted)[number];
      const b = sorted[j] as (typeof sorted)[number];
      let diff = b.a - a.a;
      if (j === 0) diff += Math.PI * 2;
      if (n > 1 && diff < gap - 1e-9) {
        const push = (gap - diff) / 2;
        a.a -= push;
        b.a += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const s of sorted) out.set(s.key, s.a);
  return out;
}

interface RawArc {
  id: string;
  src: string;
  dst: string;
  dependsOnly: boolean;
}

/**
 * Routes every arc as a quadratic Bezier, seen from the default camera:
 * 1. a bow side and height per arc: the two arcs of a reciprocal pair bow to opposite sides of their chord; any
 *    other arc takes the lowest bow that clears the islands in between, on the side facing away from the middle;
 * 2. arc starts and arrowhead tips on one island's rim are spread so that no two are closer than
 *    ARROW_SPREAD_PX on screen;
 * 3. the control point is recomputed for the final chord.
 */
function routeArcs(
  raw: RawArc[],
  islands: Island[],
  viewDir: Vec3,
  extent: number,
): Map<string, { p0: Vec3; p1: Vec3; p2: Vec3; side: 1 | -1; reciprocal: boolean }> {
  const byId = new Map(islands.map((i) => [i.id, i]));
  const { right, up } = viewBasis(viewDir);
  const to2 = (p: Vec3): { x: number; y: number } => ({ x: dot(p, right), y: dot(p, up) });
  const pairs = new Set(raw.map((a) => `${a.src}\u0000${a.dst}`));
  const quad = (p0: Vec3, p1: Vec3, p2: Vec3, t: number): Vec3 => {
    const u = 1 - t;
    return add(add(mul(p0, u * u), mul(p1, 2 * u * t)), mul(p2, t * t));
  };
  interface Plan {
    arc: RawArc;
    a: Island;
    b: Island;
    reciprocal: boolean;
    side: 1 | -1;
    h: number;
  }
  const plans: Plan[] = [];
  const sorted = [...raw].sort((x, y) =>
    x.dependsOnly === y.dependsOnly ? cmp(x.id, y.id) : x.dependsOnly ? 1 : -1,
  );
  for (const arc of sorted) {
    const a = byId.get(arc.src) as Island;
    const b = byId.get(arc.dst) as Island;
    const reciprocal = pairs.has(`${arc.dst}\u0000${arc.src}`);
    const dir = norm(sub(b.center, a.center));
    const p0 = add(a.center, mul(dir, a.radius + 1));
    const p2 = sub(b.center, mul(dir, b.radius + 2));
    const span = len(sub(p2, p0));
    const mid = mul(add(p0, p2), 0.5);
    const n3 = norm(cross(viewDir, dir)); // screen-plane normal of the chord ("left of travel" or its mirror)
    const mid2 = to2(mid);
    const n2 = { x: dot(n3, right), y: dot(n3, up) };
    const away = mid2.x * n2.x + mid2.y * n2.y >= 0 ? 1 : -1;
    const sides: (1 | -1)[] = reciprocal ? [1] : away === 1 ? [1, -1] : [-1, 1];
    const heights = reciprocal ? [0.16, 0.22, 0.3, 0.4] : [0.12, 0.18, 0.26, 0.36, 0.46, 0.58, 0.7];
    let best: { side: 1 | -1; h: number; cost: number } | null = null;
    for (const [si, side] of sides.entries()) {
      for (const [hi, hh] of heights.entries()) {
        const p1 = add(mid, mul(n3, side * hh * span * 2));
        let pen = 0;
        for (let k = 1; k < 30; k++) {
          const q = to2(quad(p0, p1, p2, k / 30));
          for (const o of islands) {
            if (o.id === a.id || o.id === b.id) continue;
            const c = to2(o.center);
            pen += Math.max(0, o.radius * 1.08 + 4 - Math.hypot(q.x - c.x, q.y - c.y));
          }
        }
        const cost = pen * 100 + hi * 6 + si * 14;
        if (best === null || cost < best.cost - 1e-9) best = { side, h: hh, cost };
      }
    }
    const pick = best as { side: 1 | -1; h: number };
    plans.push({ arc, a, b, reciprocal, side: pick.side, h: pick.h });
  }

  // Spread starts and tips around each island's rim (declared-only arcs, hidden by default, keep their chord ends).
  type End = { key: string; angle: number; off: number; isStart: boolean; plan: Plan };
  const ends = new Map<string, End[]>();
  const push = (island: string, e: End): void => {
    const l = ends.get(island) ?? [];
    l.push(e);
    ends.set(island, l);
  };
  for (const pl of plans) {
    if (pl.arc.dependsOnly) continue;
    const ca = to2(pl.a.center);
    const cb = to2(pl.b.center);
    const chord = { x: cb.x - ca.x, y: cb.y - ca.y };
    const cl = Math.hypot(chord.x, chord.y) || 1;
    const u = { x: chord.x / cl, y: chord.y / cl };
    // Screen direction of the bow side (n3 projected).
    const n3 = norm(cross(viewDir, norm(sub(pl.b.center, pl.a.center))));
    const bow = { x: dot(n3, right) * pl.side, y: dot(n3, up) * pl.side };
    const bl = Math.hypot(bow.x, bow.y) || 1;
    const lean = 0.5 + pl.h; // the higher the bow, the more the arc leaves and arrives sideways
    const at = (dx: number, dy: number): number =>
      Math.atan2(dy + (bow.y / bl) * lean, dx + (bow.x / bl) * lean);
    push(pl.a.id, { key: `${pl.arc.id}#s`, angle: at(u.x, u.y), off: 1, isStart: true, plan: pl });
    push(pl.b.id, { key: `${pl.arc.id}#e`, angle: at(-u.x, -u.y), off: 2, isStart: false, plan: pl });
  }
  const startOf = new Map<string, Vec3>();
  const endOf = new Map<string, Vec3>();
  for (const [iid, list] of ends) {
    const isl = byId.get(iid) as Island;
    const spread = spreadAngles(
      list.map((e) => ({ key: e.key, angle: e.angle })),
      arrowSpreadAngle(isl.radius, extent),
    );
    for (const e of list) {
      const ang = spread.get(e.key) as number;
      const dir = add(mul(right, Math.cos(ang)), mul(up, Math.sin(ang)));
      const p = add(isl.center, mul(dir, isl.radius + e.off));
      (e.isStart ? startOf : endOf).set(e.plan.arc.id, p);
    }
  }

  const out = new Map<string, { p0: Vec3; p1: Vec3; p2: Vec3; side: 1 | -1; reciprocal: boolean }>();
  for (const pl of plans) {
    const dir = norm(sub(pl.b.center, pl.a.center));
    const p0 = startOf.get(pl.arc.id) ?? add(pl.a.center, mul(dir, pl.a.radius + 1));
    const p2 = endOf.get(pl.arc.id) ?? sub(pl.b.center, mul(dir, pl.b.radius + 2));
    const chord = sub(p2, p0);
    const span = len(chord);
    const n3 = norm(cross(viewDir, norm(chord)));
    const mid = mul(add(p0, p2), 0.5);
    const p1 = add(mid, mul(n3, pl.side * pl.h * span * 2));
    out.set(pl.arc.id, { p0, p1, p2, side: pl.side, reciprocal: pl.reciprocal });
  }
  return out;
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
    wsKind: first && !/\d/.test(first) ? (first === "unknown" ? "(repo root)" : first) : "package",
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

  // Node-level edges: only the totals between islands matter for the layout (arcs).
  const cross_ = new Map<
    string,
    { src: string; dst: string; w: number; imports: number; bindings: number }
  >();
  for (const e of edges) {
    const ga = groupOf(e.src);
    const gb = groupOf(e.dst);
    if (!ga || !gb) continue;
    if (ga === gb) continue;
    const key = `${ga}\u0000${gb}`;
    const c = cross_.get(key) ?? { src: ga, dst: gb, w: 0, imports: 0, bindings: 0 };
    c.w += e.weight;
    if (e.kind !== "depends_on") {
      c.imports += e.weight;
      c.bindings += e.bindings ?? e.weight;
    }
    cross_.set(key, c);
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

  // The default camera depends on the islands alone; folders and files are laid out on a disc facing it.
  const viewDir = bestViewDir(
    groupIds.map((id) => ({ center: centers.get(id) as Vec3, radius: radii.get(id) as number })),
  );
  const basis = viewBasis(viewDir);

  const positions = new Map<string, Vec3>();
  const nodeR = new Map<string, number>();
  const clusters: Cluster[] = [];
  const islands: Island[] = groupIds.map((id, index) => {
    const meta = byId.get(id);
    const center = centers.get(id) as Vec3;
    const all = members.get(id) ?? [];
    const radius = radii.get(id) as number;
    const wsDir = meta?.path ?? commonDir(all.map((n) => n.path ?? "").filter(Boolean));
    // Folders and files without a single function are not drawn (they only count towards "+N empty").
    const hasFns = (n: GraphNode): boolean => n.kind === "workspace" || n.size > 0;
    const list = all.filter(hasFns);
    const keptKeys = new Set(list.map((n) => folderKey(n, wsDir)));
    const emptyKeys = new Set(all.filter((n) => !list.includes(n)).map((n) => folderKey(n, wsDir)));
    for (const k of keptKeys) emptyKeys.delete(k);
    const inner = layoutInside(list, radius, wsDir, basis);
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
      emptyFolders: emptyKeys.size,
    };
  });

  let extent = 0;
  for (const i of islands) extent = Math.max(extent, len(i.center) + i.radius);
  const ordered = [...cross_.values()].sort((a, b) => cmp(a.src + a.dst, b.src + b.dst));
  const routes = routeArcs(
    ordered.map((c) => ({ id: `${c.src}>${c.dst}`, src: c.src, dst: c.dst, dependsOnly: c.imports === 0 })),
    islands,
    viewDir,
    extent,
  );
  const arcs: Arc[] = ordered.map((c) => {
    const route = routes.get(`${c.src}>${c.dst}`) as NonNullable<ReturnType<typeof routes.get>>;
    return {
      id: `${c.src}>${c.dst}`,
      src: c.src,
      dst: c.dst,
      weight: c.imports > 0 ? c.imports : c.w,
      dependsOnly: c.imports === 0,
      ...(c.imports > 0 && c.bindings !== c.imports ? { bindings: c.bindings } : {}),
      ...route,
    };
  });

  return { positions, nodeRadius: nodeR, islands, arcs, clusters, extent, viewDir };
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

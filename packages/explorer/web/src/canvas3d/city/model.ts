// The "code city": the 2D project map's ground plan stood up in three dimensions. Pure and deterministic (no DOM, no
// three.js, no Math.random): it takes the same `Scene` and `MapGeometry` the 2D map draws and returns boxes in world
// units. World space: X = 2D x, Z = 2D y (both relative to the centre of the 2D diagram), Y is up.
import {
  GROUP_KIND,
  kindTier,
  TIER_DIR,
  TIER_FILE,
  TIER_WORKSPACE,
  type TreeNode,
} from "../../canvas/hierarchy.ts";
import { folderTitle, nodeTitle, type Scene, subtitleParts } from "../../canvas/scene.ts";
import { isTinyWorkspace, TINY_STRIP } from "../../canvas/tiny.ts";
import type { MapGeometry, Rect } from "../../canvas/types.ts";

export type CityLevel = "workspaces" | "dirs" | "files";

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned box: centre and full size. */
export interface Box3 {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
}

/** Tiles inside a folder are inset by this share per side, so the gaps between buildings read as streets. */
export const FOOTPRINT_INSET = 0.07;

/** A 2D layout rectangle as a box standing on `base` with the given height; `inset` is a share of w/h per side. */
export function rectToBox(
  r: Rect,
  base: number,
  height: number,
  origin: { x: number; y: number },
  inset = 0,
) {
  const ix = r.w * inset;
  const iz = r.h * inset;
  const box: Box3 = {
    cx: r.x + r.w / 2 - origin.x,
    cy: base + height / 2,
    cz: r.y + r.h / 2 - origin.y,
    sx: Math.max(0, r.w - 2 * ix),
    sy: height,
    sz: Math.max(0, r.h - 2 * iz),
  };
  return box;
}

export interface HeightScale {
  floor: number;
  max: number;
  /** Function count at which the height stops growing. */
  cap: number;
  at(fn: number): number;
}

/**
 * Linear height scale with a floor (0 functions is a flat tile) and a cap: values above `cap` all reach `max`, so one
 * giant file cannot dwarf the scene. The cap is the largest value unless that is more than 2.5x the 95th percentile.
 */
export function makeHeightScale(
  values: readonly number[],
  floor: number,
  max: number,
  minCap = 8,
): HeightScale {
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  const top = pos.length ? (pos[pos.length - 1] as number) : 0;
  const p95 = pos.length ? (pos[Math.floor(0.95 * (pos.length - 1))] as number) : 0;
  const cap = Math.max(minCap, Math.min(top, 2.5 * p95));
  return {
    floor,
    max,
    cap,
    at: (fn) => floor + (Math.min(Math.max(fn, 0), cap) / cap) * (max - floor),
  };
}

/** Highest solid per ground cell: lets an arch find the tallest building under its route. */
export class HeightGrid {
  private readonly cells: Float32Array;
  private readonly nx: number;
  private readonly nz: number;
  constructor(
    private readonly x0: number,
    private readonly z0: number,
    w: number,
    h: number,
    readonly cell: number,
  ) {
    this.nx = Math.max(1, Math.ceil(w / cell));
    this.nz = Math.max(1, Math.ceil(h / cell));
    this.cells = new Float32Array(this.nx * this.nz);
  }
  private range(lo: number, hi: number, origin: number, n: number): [number, number] {
    return [
      Math.max(0, Math.floor((lo - origin) / this.cell)),
      Math.min(n - 1, Math.floor((hi - origin) / this.cell)),
    ];
  }
  add(b: Box3): void {
    const top = b.cy + b.sy / 2;
    const [i0, i1] = this.range(b.cx - b.sx / 2, b.cx + b.sx / 2, this.x0, this.nx);
    const [k0, k1] = this.range(b.cz - b.sz / 2, b.cz + b.sz / 2, this.z0, this.nz);
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const at = k * this.nx + i;
        if ((this.cells[at] as number) < top) this.cells[at] = top;
      }
  }
  /** Highest top within `r` of (x, z). */
  at(x: number, z: number, r = 0): number {
    const [i0, i1] = this.range(x - r, x + r, this.x0, this.nx);
    const [k0, k1] = this.range(z - r, z + r, this.z0, this.nz);
    let best = 0;
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) best = Math.max(best, this.cells[k * this.nx + i] as number);
    return best;
  }
}

export interface CityDistrict {
  id: string;
  idx: number;
  /** Position among the workspaces sorted by id: the palette index, the same as the 2D map's. */
  colorIndex: number;
  /** The 2D layout rectangle (layout units). */
  rect: Rect;
  box: Box3;
  /** Raised slab (the district's floor) and, at the Workspaces level, the block on it. */
  slabTop: number;
  block: Box3 | null;
  top: number;
  /** Highest point of anything standing in the district (buildings, blocks). */
  reach: number;
  path: string;
  fns: number;
  files: number;
  title: string;
  /** "package · 1,715 functions · 261 files" */
  detail: string;
  kind: string;
  /** A workspace with very few functions next to the biggest: the layout gave it a larger slab and a title strip. */
  tiny: boolean;
}

export interface CityFolder {
  id: string;
  idx: number;
  district: number;
  depth: number;
  rect: Rect;
  box: Box3;
  top: number;
  fns: number;
  files: number;
  title: string;
  path: string;
  leaf: boolean;
  /** Extruded to a block (Folders level, leaf folders). */
  extruded: boolean;
}

export interface CityBuilding {
  id: string;
  idx: number;
  district: number;
  folder: number;
  /** The treemap tile. */
  rect: Rect;
  box: Box3;
  top: number;
  fns: number;
  label: string;
  path: string;
  loc: number | null;
  /** 0 or 1: neighbouring siblings alternate a little in shade. */
  alt: number;
}

export interface CityArch {
  key: string;
  src: string;
  dst: string;
  srcIdx: number;
  dstIdx: number;
  weight: number;
  declaredOnly: boolean;
  /** Smooth lifted polyline from the source port to the target port. */
  pts: V3[];
  /** The route on the ground (same points, flat), for the faint shadow line. */
  ground: V3[];
  length: number;
  radius: number;
  /** Indices into `pts` where the count pill may sit, best first. */
  pillAt: number[];
  maxY: number;
}

export interface City {
  level: CityLevel;
  origin: { x: number; y: number };
  /** Longest side of the 2D diagram (layout units): the scale heights and sizes are relative to. */
  extent: number;
  districts: CityDistrict[];
  folders: CityFolder[];
  buildings: CityBuilding[];
  arches: CityArch[];
  /** Everything that is drawn, as a world-space bounding box. */
  min: V3;
  max: V3;
  grid: HeightGrid;
  files: HeightScale;
  byId: Map<string, { type: "district" | "folder" | "building"; i: number }>;
}

const rectOf = (geo: MapGeometry, i: number): Rect => ({
  x: geo.rects[i * 4] as number,
  y: geo.rects[i * 4 + 1] as number,
  w: geo.rects[i * 4 + 2] as number,
  h: geo.rects[i * 4 + 3] as number,
});

export interface CityOptions {
  level: CityLevel;
  /** Draw links that only come from package.json (no imports). */
  showDeclared?: boolean;
}

/**
 * Samples a route as a smooth arch: it follows the 2D route on the ground, rises to a height that grows with the
 * route's length, and never sinks below the tallest solid under it (plus a margin). The ends sit on `startTop` and
 * `endTop` (the districts' floors).
 */
export function archPath(
  route: readonly (readonly [number, number])[],
  origin: { x: number; y: number },
  grid: HeightGrid,
  startTop: number,
  endTop: number,
  extent: number,
): { pts: V3[]; ground: V3[]; length: number; need: number[] } {
  const poly = route.map(([x, y]) => ({ x: x - origin.x, z: y - origin.y }));
  const cum = [0];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1] as { x: number; z: number };
    const b = poly[i] as { x: number; z: number };
    cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const length = Math.max(1e-6, cum[cum.length - 1] as number);
  const n = Math.max(10, Math.ceil(length / Math.min(10, Math.max(3, length / 48))));
  const at = (d: number): { x: number; z: number } => {
    let s = 1;
    while (s < cum.length - 1 && (cum[s] as number) < d) s++;
    const a = poly[s - 1] as { x: number; z: number };
    const b = poly[s] as { x: number; z: number };
    const span = (cum[s] as number) - (cum[s - 1] as number);
    const t = span > 0 ? (d - (cum[s - 1] as number)) / span : 0;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };
  const lift = Math.min(0.15 * extent, Math.max(0.07 * extent, 0.13 * length));
  const margin = 0.012 * extent + 2;
  const xs: { x: number; z: number }[] = [];
  const base: number[] = [];
  const need: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = at(t * length);
    xs.push(p);
    const ground = startTop + (endTop - startTop) * t;
    base.push(ground + lift * Math.sin(Math.PI * t) ** 0.75);
    need.push(i === 0 || i === n ? ground : Math.max(ground, grid.at(p.x, p.z, 4.5)) + margin);
  }
  const y = base.map((b, i) => Math.max(b, need[i] as number));
  for (let pass = 0; pass < 8; pass++)
    for (let i = 1; i < n; i++)
      y[i] = Math.max(
        need[i] as number,
        ((y[i - 1] as number) + 2 * (y[i] as number) + (y[i + 1] as number)) / 4,
      );
  return {
    pts: xs.map((p, i) => ({ x: p.x, y: y[i] as number, z: p.z })),
    ground: xs.map((p) => ({ x: p.x, y: 0.3, z: p.z })),
    length,
    need,
  };
}

/** Tube radius of an arch: grows with the square root of the import count, clamped. */
export function archRadius(weight: number, extent: number): number {
  const u = extent / 1100;
  return u * Math.min(5, Math.max(1.3, 0.9 + 0.26 * Math.sqrt(Math.max(1, weight))));
}

type Pt2d = readonly [number, number];

/** Least distance (layout units, about 14px on screen at the default camera) between two ends on a tiny slab. */
const END_GAP_DEPTH = 34;
const END_GAP_WIDTH = 26;
/** How far a second or third lane of arch ends stands inside the slab. */
const END_LANE_INSET = 30;

/** Which edge of `r` the point `p` is nearest to. */
function nearestSide(p: Pt2d, r: Rect): "left" | "right" | "top" | "bottom" {
  const d = [
    ["left", Math.abs(p[0] - r.x)],
    ["right", Math.abs(p[0] - (r.x + r.w))],
    ["top", Math.abs(p[1] - r.y)],
    ["bottom", Math.abs(p[1] - (r.y + r.h))],
  ] as const;
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/**
 * The layout puts every link end of a district on a coarse port grid. On a tiny district several ends share a few
 * pixels, so their arrowheads sit on top of each other. This re-spreads the ends that touch a tiny district evenly
 * along the edge they arrive on (ordered by where the other end lies, so the arches do not cross each other), and
 * pulls them onto the slab (the layout's route ends at the box, whose lower part is the free title strip).
 * Returns the changed routes by key; the other routes are the layout's.
 */
export function spreadTinyEnds(
  scene: Scene,
  geo: MapGeometry,
  districts: readonly CityDistrict[],
  districtOf: ReadonlyMap<number, number>,
  showDeclared = false,
): Map<string, Pt2d[]> {
  const out = new Map<string, Pt2d[]>();
  const tree = scene.tree;
  const groups = new Map<
    string,
    { d: CityDistrict; side: string; ends: { key: string; at: 0 | 1; other: Pt2d }[] }
  >();
  const keys = new Set<string>();
  for (const e of scene.wsEdges) {
    if (e.declaredOnly && !showDeclared) continue;
    const src = (tree.nodes[e.src] as TreeNode).id;
    const dst = (tree.nodes[e.dst] as TreeNode).id;
    keys.add(`${src}>${dst}`);
  }
  for (const key of [...keys].sort()) {
    const route = geo.routes[key];
    if (!route || route.length < 2) continue;
    const [a, b] = key.split(">") as [string, string];
    const ia = districts.find((d) => d.id === a);
    const ib = districts.find((d) => d.id === b);
    if (!ia || !ib || !districtOf.has(ia.idx) || !districtOf.has(ib.idx)) continue;
    for (const at of [0, 1] as const) {
      const d = at === 0 ? ia : ib;
      const o = at === 0 ? ib : ia;
      if (!d.tiny) continue;
      const p = (at === 0 ? route[0] : route[route.length - 1]) as Pt2d;
      const full: Rect = { ...d.rect, h: d.rect.h + TINY_STRIP };
      const side = nearestSide(p, full);
      const g = groups.get(`${d.id}|${side}`) ?? { d, side, ends: [] };
      g.ends.push({ key, at, other: [o.rect.x + o.rect.w / 2, o.rect.y + o.rect.h / 2] });
      groups.set(`${d.id}|${side}`, g);
    }
  }
  for (const g of groups.values()) {
    const r = g.d.rect;
    const vertical = g.side === "left" || g.side === "right";
    g.ends.sort(
      (p, q) => (vertical ? p.other[1] - q.other[1] : p.other[0] - q.other[0]) || (p.key < q.key ? -1 : 1),
    );
    const n = g.ends.length;
    // Ends one `gap` apart along the edge; more than fit stagger inwards in lanes (every `lanes`-th end in a lane).
    const along = vertical ? r.h : r.w;
    const cap = Math.max(1, Math.floor(along / (vertical ? END_GAP_DEPTH : END_GAP_WIDTH)));
    const lanes = Math.min(3, Math.ceil(n / cap));
    g.ends.forEach((end, k) => {
      const base = out.get(end.key) ?? [...(geo.routes[end.key] as Pt2d[])];
      const lane = k % lanes;
      const inLane = Math.floor(k / lanes);
      const laneN = Math.ceil((n - lane) / lanes);
      // Lanes are offset by a share of the spacing so neighbours zigzag.
      const frac = 0.12 + 0.76 * ((inLane + 0.5 + (lanes > 1 ? 0.5 * (lane / lanes - 0.33) : 0)) / laneN);
      const pos = vertical ? r.y + r.h * frac : r.x + r.w * frac;
      const inset = lane * END_LANE_INSET;
      const i0 = end.at === 0 ? 0 : base.length - 1;
      const i1 = end.at === 0 ? 1 : base.length - 2;
      const move = (i: number, slabEdge: boolean): void => {
        const q = base[i] as Pt2d;
        const dx = g.side === "left" ? inset : g.side === "right" ? -inset : 0;
        const dy = g.side === "top" ? inset : g.side === "bottom" ? -inset : 0;
        if (vertical) base[i] = [q[0] + (slabEdge ? dx : 0), pos];
        else base[i] = [pos, (g.side === "bottom" && slabEdge ? r.y + r.h : q[1]) + (slabEdge ? dy : 0)];
      };
      move(i0, true);
      if (base.length >= 3) move(i1, false);
      out.set(end.key, base);
    });
  }
  return out;
}

/** Builds the city for one level from the 2D scene and its layout. */
export function buildCity(scene: Scene, geo: MapGeometry, opts: CityOptions): City {
  const { tree } = scene;
  const level = opts.level;
  const origin = { x: geo.bounds.x + geo.bounds.w / 2, y: geo.bounds.y + geo.bounds.h / 2 };
  const extent = Math.max(1, geo.bounds.w, geo.bounds.h);
  const slabH = Math.max(2.5, extent * 0.005);
  const step = Math.max(2, extent * 0.004);
  const fileScale = makeHeightScale(
    scene.nodes.flatMap((n, i) => (kindTier(n.kind) === TIER_FILE ? [scene.functions[i] ?? 0] : [])),
    extent * 0.0025,
    extent * 0.08,
  );
  const leafFolders = new Set<number>();
  tree.nodes.forEach((n, i) => {
    if (kindTier(n.kind) !== TIER_DIR || scene.skipped[i] === 1) return;
    if (
      !n.children.some(
        (c) => kindTier((tree.nodes[c] as TreeNode).kind) === TIER_DIR && scene.skipped[c] !== 1,
      )
    )
      leafFolders.add(i);
  });
  const folderScale = makeHeightScale(
    [...leafFolders].map((i) => scene.functions[i] ?? 0),
    0,
    extent * 0.09,
    12,
  );
  const wsScale = makeHeightScale(
    scene.roots.map((i) => scene.functions[i] ?? 0),
    extent * 0.01,
    extent * 0.12,
    12,
  );

  const districts: CityDistrict[] = [];
  const folders: CityFolder[] = [];
  const buildings: CityBuilding[] = [];
  const byId = new Map<string, { type: "district" | "folder" | "building"; i: number }>();
  const districtOf = new Map<number, number>();
  const containerTop = new Map<number, number>(); // tree idx of workspace / folder -> y of its top face
  const containerDepth = new Map<number, number>();
  const containerFolder = new Map<number, number>();
  const grid = new HeightGrid(
    -extent * 0.7,
    -extent * 0.7,
    extent * 1.4,
    extent * 1.4,
    Math.max(2, extent / 220),
  );

  const maxFns = Math.max(0, ...scene.roots.map((i) => scene.functions[i] ?? 0));
  for (const r of scene.roots) {
    const node = scene.nodes[r];
    const rect = rectOf(geo, r);
    if (!node || rect.w <= 0 || rect.h <= 0) continue;
    const parts = subtitleParts(scene, r).filter((p) => !p.endsWith("/"));
    const box = rectToBox(rect, 0, slabH, origin);
    const fns = scene.functions[r] ?? 0;
    const block = level === "workspaces" ? rectToBox(rect, slabH, wsScale.at(fns), origin, 0.1) : null;
    const d: CityDistrict = {
      id: node.id,
      idx: r,
      colorIndex: scene.rootRank.get(r) ?? 0,
      rect,
      box,
      slabTop: slabH,
      block,
      top: block ? block.cy + block.sy / 2 : slabH,
      reach: block ? block.cy + block.sy / 2 : slabH,
      path: node.path ?? "",
      fns,
      files: scene.files[r] ?? 0,
      title: nodeTitle(scene, r),
      detail: parts.join(" · "),
      kind: node.id === "ws:." ? "(repo root)" : (node.badges?.[0] ?? "package"),
      tiny: scene.roots.length > 1 && isTinyWorkspace(fns, maxFns),
    };
    byId.set(d.id, { type: "district", i: districts.length });
    districtOf.set(r, districts.length);
    containerTop.set(r, slabH);
    containerDepth.set(r, 0);
    grid.add(box);
    if (block) grid.add(block);
    districts.push(d);
  }

  /** Nearest ancestor that is a workspace or a folder drawn as its own plinth. */
  const containerOf = (i: number): number => {
    let p = (tree.nodes[i] as TreeNode).parent;
    while (p !== -1 && scene.skipped[p] === 1) p = (tree.nodes[p] as TreeNode).parent;
    return p;
  };

  // Folders (parents first: tree order is by id, so sort by depth through the walk below).
  const order: number[] = [];
  const walk = (i: number): void => {
    order.push(i);
    for (const c of (tree.nodes[i] as TreeNode).children) walk(c);
  };
  for (const r of scene.roots) if (districtOf.has(r)) walk(r);

  for (const i of order) {
    const n = tree.nodes[i] as TreeNode;
    const tier = kindTier(n.kind);
    const rect = rectOf(geo, i);
    if (tier === TIER_WORKSPACE || rect.w <= 0 || rect.h <= 0) continue;
    const dIdx = districtOf.get(n.root);
    if (dIdx === undefined) continue;
    const parent = containerOf(i);
    const parentTop = containerTop.get(parent);
    if (parentTop === undefined) continue;
    if (tier === TIER_DIR) {
      if (scene.skipped[i] === 1 && n.kind !== GROUP_KIND) continue;
      const depth = (containerDepth.get(parent) ?? 0) + 1;
      const raise = depth <= 3 ? step : step * 0.25;
      const leaf = leafFolders.has(i) || n.kind === GROUP_KIND;
      const fns = scene.functions[i] ?? 0;
      const extruded = level === "dirs" && leaf;
      const height = raise + (extruded ? folderScale.at(fns) : 0);
      const box = rectToBox(rect, parentTop, height, origin, 0.0015);
      const top = parentTop + height;
      containerTop.set(i, top);
      containerDepth.set(i, depth);
      containerFolder.set(i, folders.length);
      byId.set(n.id, { type: "folder", i: folders.length });
      grid.add(box);
      folders.push({
        id: n.id,
        idx: i,
        district: dIdx,
        depth,
        rect,
        box,
        top,
        fns,
        files: scene.files[i] ?? 0,
        title: n.kind === GROUP_KIND ? (scene.nodes[i]?.label ?? "") : folderTitle(scene, i),
        path: scene.nodes[i]?.path ?? scene.nodes[i]?.label ?? "",
        leaf,
        extruded,
      });
    } else if (tier === TIER_FILE && level === "files") {
      const fns = scene.functions[i] ?? 0;
      const h = fileScale.at(fns);
      const box = rectToBox(rect, parentTop, h, origin, FOOTPRINT_INSET);
      const node = scene.nodes[i];
      byId.set(n.id, { type: "building", i: buildings.length });
      grid.add(box);
      buildings.push({
        id: n.id,
        idx: i,
        district: dIdx,
        folder: containerFolder.get(parent) ?? -1,
        rect,
        box,
        top: parentTop + h,
        fns,
        label: node?.label ?? n.id,
        path: node?.path ?? n.id.replace(/^file:/, ""),
        loc: node?.stats?.loc ?? null,
        alt: (buildings.length + Math.floor(rect.x / 3)) % 2,
      });
    }
  }

  for (const f of folders) {
    const d = districts[f.district] as CityDistrict;
    d.reach = Math.max(d.reach, f.top);
  }
  for (const b of buildings) {
    const d = districts[b.district] as CityDistrict;
    d.reach = Math.max(d.reach, b.top);
  }

  // Arches: one per import link (declared-only ones on request), along the 2D route.
  const arches: CityArch[] = [];
  const topOf = (idx: number): number => districts[districtOf.get(idx) as number]?.slabTop ?? slabH;
  const spread = spreadTinyEnds(scene, geo, districts, districtOf, opts.showDeclared);
  for (const e of scene.wsEdges) {
    if (e.declaredOnly && !opts.showDeclared) continue;
    const src = (tree.nodes[e.src] as TreeNode).id;
    const dst = (tree.nodes[e.dst] as TreeNode).id;
    const route = spread.get(`${src}>${dst}`) ?? geo.routes[`${src}>${dst}`];
    if (!route || route.length < 2 || !districtOf.has(e.src) || !districtOf.has(e.dst)) continue;
    const p = archPath(route, origin, grid, topOf(e.src), topOf(e.dst), extent);
    const last = p.pts.length - 1;
    // Pill spots: around a third of the way from the source, then further out.
    const pillAt = [0.3, 0.22, 0.38, 0.15, 0.46, 0.55, 0.62, 0.7, 0.78, 0.85, 0.08, 0.92].map((t) =>
      Math.round(t * last),
    );
    arches.push({
      key: `${src}>${dst}`,
      src,
      dst,
      srcIdx: e.src,
      dstIdx: e.dst,
      weight: e.weight,
      declaredOnly: e.declaredOnly,
      pts: p.pts,
      ground: p.ground,
      length: p.length,
      radius: archRadius(e.weight, extent),
      pillAt,
      maxY: Math.max(...p.pts.map((q) => q.y)),
    });
  }
  arches.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));

  const min: V3 = { x: Number.POSITIVE_INFINITY, y: 0, z: Number.POSITIVE_INFINITY };
  const max: V3 = { x: Number.NEGATIVE_INFINITY, y: 0, z: Number.NEGATIVE_INFINITY };
  const grow = (b: Box3): void => {
    min.x = Math.min(min.x, b.cx - b.sx / 2);
    max.x = Math.max(max.x, b.cx + b.sx / 2);
    min.z = Math.min(min.z, b.cz - b.sz / 2);
    max.z = Math.max(max.z, b.cz + b.sz / 2);
    max.y = Math.max(max.y, b.cy + b.sy / 2);
  };
  for (const d of districts) {
    grow(d.box);
    if (d.block) grow(d.block);
  }
  for (const f of folders) grow(f.box);
  for (const b of buildings) grow(b.box);
  for (const a of arches)
    for (const q of a.pts) {
      min.x = Math.min(min.x, q.x);
      max.x = Math.max(max.x, q.x);
      min.z = Math.min(min.z, q.z);
      max.z = Math.max(max.z, q.z);
      max.y = Math.max(max.y, q.y);
    }
  if (!Number.isFinite(min.x)) {
    min.x = min.z = -1;
    max.x = max.z = 1;
  }
  return {
    level,
    origin,
    extent,
    districts,
    folders,
    buildings,
    arches,
    min,
    max,
    grid,
    files: fileScale,
    byId,
  };
}

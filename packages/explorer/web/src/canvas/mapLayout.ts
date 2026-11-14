// Layout of the project map: workspace boxes in a layered left-to-right dependency diagram (elk), and a nested
// squarified treemap inside every box. Pure and deterministic; runs in the layout worker.
//
// Units are "pixels at the fit zoom of a canvas of `viewport` size": the box sizes, gaps and header strips are
// chosen so that, when the camera fits the whole diagram, titles are at least 11px and gaps at least 60px.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import { collapseChains, kindTier, type Tree, type TreeNode } from "./hierarchy.ts";
import { WS_HEAD_MAX } from "./mapGeom.ts";
import { GRID, type RouteLink, routeLinks } from "./mapRoute.ts";
import { type Pt, routeAround } from "./route.ts";
import { layoutTreemap, type TmNode } from "./treemap.ts";
import type { LayoutInput, MapGeometry, Positions, Rect } from "./types.ts";

export const DEFAULT_VIEWPORT = { w: 1200, h: 720 };
/** Screen space the camera keeps free around the diagram (controls on top, status chip at the bottom). */
export const FIT_INSETS = { top: 48, right: 24, bottom: 52, left: 24 };

/** Room kept free around the boxes for routes that run outside their bounding box, in px at the fit zoom. */
const ROUTE_ROOM = 14;
export const AREA_MIN = 8; // px² of box area per function, lower search bound
export const AREA_MAX = 20000; // upper bound: a tiny repo does not need huge boxes
/** Smallest box (px at the fit zoom): tiny workspaces stay clickable and keep their name and counts. */
export const MIN_BOX_W = 120;
export const MIN_LEAF_H = 64;
/** A box with contents keeps at least this much room under its title block. */
const MIN_BODY_H = 22;
/** A file with no functions still gets this much weight, so it shows up as a thin cell. */
export const MIN_WEIGHT = 0.6;

/** One deterministic set of elk options; the layout tries a few and keeps the one with the biggest boxes. */
interface Variant {
  direction: "RIGHT" | "DOWN";
  /** Space between boxes in the same layer, and between layers. */
  gap: number;
  layerGap: number;
  layering: "NETWORK_SIMPLEX" | "LONGEST_PATH" | "COFFMAN_GRAHAM";
  /** Most boxes per layer for COFFMAN_GRAHAM (fewer, denser layers). */
  bound?: number;
  /** Width over height of a box. */
  box: number;
  /** Most layers (columns) the heaviest links may form; the lighter ones are routed around the placed boxes. */
  depth?: number;
}

/**
 * The links given to the layered placement: heaviest first, each kept only while the longest chain stays within
 * `maxDepth` layers and no cycle forms. A long dependency chain would otherwise cost a column per package; the
 * links left out are routed around the placed boxes afterwards, like the declared-only ones.
 */
export function layerPairs(
  pairs: [number, number][],
  weight: (p: [number, number]) => number,
  maxDepth: number,
): { kept: [number, number][]; rest: [number, number][] } {
  const kept: [number, number][] = [];
  const rest: [number, number][] = [];
  const order = [...pairs].sort((p, q) => weight(q) - weight(p) || p[0] - q[0] || p[1] - q[1]);
  const out = new Map<number, number[]>();
  /** Longest path (in edges) starting at `n`, or -1 when `n` reaches `target` (a cycle). */
  const longest = (n: number, target: number, memo: Map<number, number>): number => {
    if (n === target) return -1;
    const known = memo.get(n);
    if (known !== undefined) return known;
    let best = 0;
    for (const m of out.get(n) ?? []) {
      const l = longest(m, target, memo);
      if (l < 0) {
        memo.set(n, -1);
        return -1;
      }
      best = Math.max(best, l + 1);
    }
    memo.set(n, best);
    return best;
  };
  const depthTo = (n: number, memo: Map<number, number>): number => {
    const known = memo.get(n);
    if (known !== undefined) return known;
    let best = 0;
    for (const [from, tos] of out) if (tos.includes(n)) best = Math.max(best, depthTo(from, memo) + 1);
    memo.set(n, best);
    return best;
  };
  for (const p of order) {
    const [a, b] = p;
    const below = longest(b, a, new Map());
    if (below < 0) {
      rest.push(p);
      continue;
    }
    const above = depthTo(a, new Map());
    if (above + 1 + below + 1 > maxDepth) {
      rest.push(p);
      continue;
    }
    kept.push(p);
    out.set(a, [...(out.get(a) ?? []), b]);
  }
  kept.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { kept, rest };
}
const VARIANTS: Variant[] = [
  { direction: "RIGHT", gap: 40, layerGap: 60, layering: "LONGEST_PATH", box: 0.8 },
  { direction: "RIGHT", gap: 40, layerGap: 60, layering: "NETWORK_SIMPLEX", box: 0.9, depth: 4 },
  { direction: "RIGHT", gap: 40, layerGap: 60, layering: "NETWORK_SIMPLEX", box: 1.0, depth: 3 },
  { direction: "DOWN", gap: 40, layerGap: 60, layering: "NETWORK_SIMPLEX", box: 1.6, depth: 4 },
];

/** Lines `text` needs when wrapped at `maxW` px, at about `em` px per character. */
function linesFor(text: string, em: number, maxW: number): number {
  return Math.max(1, Math.ceil((text.length * em) / Math.max(40, maxW)));
}

/**
 * Height (px at the fit zoom) of the title block of a box of width `w`: the name (at most 18px) and the detail
 * line (at most 12px), never more than `WS_HEAD_MAX`. The renderer keeps the block at most that tall on screen
 * whatever the zoom; text widths are estimated here (no canvas in the worker).
 */
export function headFor(w: number, title: string, parts: readonly string[]): number {
  const f = Math.min(18, Math.max(12, Math.round(w * 0.085)));
  const sub = Math.min(12, Math.max(10, Math.round(f * 0.74)));
  const width = w - 20;
  const nameLines = linesFor(title, f * 0.62, width);
  let lines = 1;
  let cur = 0;
  for (const part of parts) {
    const pw = (part.length + 3) * sub * 0.56;
    if (cur > 0 && cur + pw > width) {
      lines++;
      cur = pw;
    } else cur += pw;
  }
  return Math.round(Math.min(WS_HEAD_MAX, nameLines * f * 1.2 + 3 + lines * sub * 1.25 + 8));
}

interface IdxEdge {
  src: number;
  dst: number;
  weight: number;
  kind: string;
}

interface BoxPlan {
  index: number;
  w: number;
  h: number;
  head: number;
}

interface Placed {
  boxes: Map<number, Rect>;
  routes: Map<string, [number, number][]>;
  width: number;
  height: number;
}

function rootsOf(tree: Tree): number[] {
  const roots: number[] = [];
  tree.nodes.forEach((n, i) => {
    if (n.parent === -1) roots.push(i);
  });
  return roots;
}

/** Routes for links the layered placement did not see, around the placed boxes. */
function addExtraRoutes(placed: Placed, pairs: [number, number][]): void {
  const boxes = placed.boxes;
  const sorted = [...pairs].sort((p, q) => {
    const a = boxes.get(p[1]) as Rect;
    const b = boxes.get(q[1]) as Rect;
    return a.y - b.y || p[0] - q[0] || p[1] - q[1];
  });
  const outCount = new Map<number, number>();
  const inCount = new Map<number, number>();
  for (const [a, b] of sorted) {
    outCount.set(a, (outCount.get(a) ?? 0) + 1);
    inCount.set(b, (inCount.get(b) ?? 0) + 1);
  }
  const outSeen = new Map<number, number>();
  const inSeen = new Map<number, number>();
  for (const [a, b] of sorted) {
    const A = boxes.get(a) as Rect;
    const B = boxes.get(b) as Rect;
    const k = outSeen.get(a) ?? 0;
    const m = inSeen.get(b) ?? 0;
    outSeen.set(a, k + 1);
    inSeen.set(b, m + 1);
    const ay = A.y + (A.h * (k + 1)) / ((outCount.get(a) ?? 1) + 1);
    const by = B.y + (B.h * (m + 1)) / ((inCount.get(b) ?? 1) + 1);
    const forward = B.x >= A.x + A.w;
    const backward = B.x + B.w <= A.x;
    const stub = 16;
    let start: Pt;
    let end: Pt;
    let s1: Pt;
    let e1: Pt;
    if (forward || backward) {
      const dir = forward ? 1 : -1;
      start = [forward ? A.x + A.w : A.x, ay];
      end = [forward ? B.x : B.x + B.w, by];
      s1 = [start[0] + dir * stub, start[1]];
      e1 = [end[0] - dir * stub, end[1]];
    } else {
      const below = B.y > A.y;
      start = [A.x + A.w / 2 + (k - (outCount.get(a) ?? 1) / 2) * 10, below ? A.y + A.h : A.y];
      end = [B.x + B.w / 2 + (m - (inCount.get(b) ?? 1) / 2) * 10, below ? B.y : B.y + B.h];
      s1 = [start[0], start[1] + (below ? stub : -stub)];
      e1 = [end[0], end[1] + (below ? -stub : stub)];
    }
    const obstacles = [...boxes]
      .filter(([i]) => i !== a && i !== b)
      .map(([, r]) => ({ x0: r.x - 18, y0: r.y - 18, x1: r.x + r.w + 18, y1: r.y + r.h + 18 }));
    const mid = routeAround(s1, e1, obstacles);
    const pts = [start, ...mid, end];
    placed.routes.set(`${a}>${b}`, pts);
    for (const [px, py] of pts) {
      placed.width = Math.max(placed.width, px);
      placed.height = Math.max(placed.height, py);
    }
  }
}

export function boxSize(
  fn: number,
  area: number,
  aspect: number,
  hasChildren: boolean,
  title = "",
  parts: readonly string[] = [],
  minSide = 0,
): { w: number; h: number; head: number } {
  const a = Math.max(0, fn) * area;
  const w = Math.max(MIN_BOX_W, Math.sqrt(a * aspect));
  const head = headFor(w, title, parts);
  const minH = hasChildren ? head + MIN_BODY_H : head + 8;
  const h = Math.max(a / w, minH, MIN_LEAF_H, minSide);
  return { w: Math.round(w), h: Math.round(h), head };
}

const elk = new ELK();

async function placeBoxes(
  plans: BoxPlan[],
  pairs: [number, number][],
  v: Variant,
  aspect: number,
): Promise<Placed> {
  const children: ElkNode[] = plans.map((p) => ({ id: `n${p.index}`, width: p.w, height: p.h }));
  const elkEdges: ElkExtendedEdge[] = pairs.map(([a, b], k) => ({
    id: `e${k}`,
    sources: [`n${a}`],
    targets: [`n${b}`],
  }));
  const out = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": v.direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(v.gap),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(v.layerGap),
      "elk.layered.spacing.edgeNodeBetweenLayers": "20",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
      "elk.spacing.edgeEdge": "10",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.componentComponent": String(v.gap),
      "elk.layered.layering.strategy": v.layering,
      ...(v.bound ? { "elk.layered.layering.coffmanGraham.layerBound": String(v.bound) } : {}),
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.aspectRatio": aspect.toFixed(3),
    },
    children,
    edges: elkEdges,
  });
  const boxes = new Map<number, Rect>();
  let x1 = 0;
  let y1 = 0;
  for (const c of out.children ?? []) {
    const index = Number(c.id.slice(1));
    const r = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
    boxes.set(index, r);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  const routes = new Map<string, [number, number][]>();
  (out.edges ?? []).forEach((e, k) => {
    const pair = pairs[Number(e.id.slice(1))] ?? pairs[k];
    const section = e.sections?.[0];
    if (!pair || !section) return;
    const pts: [number, number][] = [
      [section.startPoint.x, section.startPoint.y],
      ...(section.bendPoints ?? []).map((b): [number, number] => [b.x, b.y]),
      [section.endPoint.x, section.endPoint.y],
    ];
    for (const [px, py] of pts) {
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    routes.set(`${pair[0]}>${pair[1]}`, pts);
  });
  return { boxes, routes, width: x1, height: y1 };
}

/** Lays the whole map out. Tree indices are the sorted-id order shared with the renderer. */
export async function layoutMap(
  tree: Tree,
  edges: IdxEdge[],
  input: LayoutInput,
): Promise<{ positions: Positions; map: MapGeometry }> {
  const viewport = input.viewport ?? DEFAULT_VIEWPORT;
  const usableW = Math.max(300, viewport.w - FIT_INSETS.left - FIT_INSETS.right);
  const usableH = Math.max(240, viewport.h - FIT_INSETS.top - FIT_INSETS.bottom);
  const roots = rootsOf(tree);

  const given = new Map(input.nodes.map((n) => [n.id, n.functions]));
  const titles = new Map(input.nodes.map((n) => [n.id, n]));
  const fnOf = (i: number): number => {
    const n = tree.nodes[i] as TreeNode;
    const own = given.get(n.id);
    if (own !== undefined) return own;
    // No server-side counts (synthetic data): count the leaves.
    let sum = 0;
    const walk = (k: number): void => {
      const c = tree.nodes[k] as TreeNode;
      if (c.children.length === 0) sum += c.tier >= 3 ? 1 : 0;
      else for (const ch of c.children) walk(ch);
    };
    walk(i);
    return sum;
  };

  // Directed workspace pairs. The layered placement uses the import links only: package.json dependencies can
  // chain every workspace behind the next and would stretch the diagram into a long strip. Declared-only
  // dependencies are routed around the placed boxes afterwards (they are drawn only on request).
  const rootOf = (i: number) => (tree.nodes[i] as TreeNode).root;
  const importPairs: [number, number][] = [];
  const declaredPairs: [number, number][] = [];
  const seen = new Set<string>();
  const pairWeight = new Map<string, number>();
  // Like the renderer: links between the workspace nodes themselves when there are any, else everything lifted.
  const direct = edges.filter((e) => rootOf(e.src) === e.src && rootOf(e.dst) === e.dst);
  const linkSource = direct.length > 0 ? direct : edges;
  const collect = (declared: boolean) => {
    for (const e of linkSource) {
      if ((e.kind === "depends_on") !== declared) continue;
      const a = rootOf(e.src);
      const b = rootOf(e.dst);
      const key = `${a}>${b}`;
      if (a === b) continue;
      if (!declared) pairWeight.set(key, (pairWeight.get(key) ?? 0) + e.weight);
      if (seen.has(key)) continue;
      seen.add(key);
      (declared ? declaredPairs : importPairs).push([a, b]);
    }
  };
  collect(false);
  collect(true);
  const byIndex = (p: [number, number], q: [number, number]) => p[0] - q[0] || p[1] - q[1];
  importPairs.sort(byIndex);
  declaredPairs.sort(byIndex);
  const pairs = importPairs.length > 0 ? importPairs : declaredPairs;
  const extraBase = importPairs.length > 0 ? declaredPairs : [];
  const weightOf = (p: [number, number]) => pairWeight.get(`${p[0]}>${p[1]}`) ?? 0;
  // Pairs with links both ways (30 one way, 3 the other): only the heavier direction orders the layers, the other
  // is routed back along its own lane afterwards.
  const layerable = pairs.filter((p) => {
    const w = weightOf(p);
    const r = weightOf([p[1], p[0]]);
    return !(r > w || (r === w && r > 0 && p[0] > p[1]));
  });

  // A box needs room for a port per link on a side (one grid step apart), whatever its size.
  const degIn = new Map<number, number>();
  const degOut = new Map<number, number>();
  for (const [a, b] of pairs) {
    degOut.set(a, (degOut.get(a) ?? 0) + 1);
    degIn.set(b, (degIn.get(b) ?? 0) + 1);
  }
  const portSide = (r: number): number => 16 + GRID * Math.max(degIn.get(r) ?? 0, degOut.get(r) ?? 0, 1);
  const fns = new Map(roots.map((r) => [r, fnOf(r)]));
  const filesGiven = new Map(input.nodes.map((n) => [n.id, n.files]));
  const files = Float64Array.from(tree.nodes, (n) => filesGiven.get(n.id) ?? 0);
  const plansFor = (area: number, aspect: number): BoxPlan[] =>
    roots.map((r) => {
      const node = titles.get((tree.nodes[r] as TreeNode).id);
      return {
        index: r,
        ...boxSize(
          fns.get(r) as number,
          area,
          aspect,
          (tree.nodes[r] as TreeNode).children.length > 0,
          node?.title ?? "",
          node?.subtitle ?? [],
          portSide(r),
        ),
      };
    });

  // For every option set: the biggest box area per function at which the whole diagram still fits the canvas.
  // The set whose biggest box ends up largest on screen wins (ties: the earlier set).
  const aspect = usableW / usableH;
  // The routes run up to a grid step outside the boxes' bounding box: keep that much room.
  const fits = (p: Placed) => p.width <= usableW - ROUTE_ROOM && p.height <= usableH - ROUTE_ROOM;
  const solve = async (v: Variant) => {
    // Links the layered placement does not see (too many layers) are routed afterwards, with the declared ones.
    const split =
      v.depth && roots.length <= 40
        ? layerPairs(layerable, weightOf, v.depth)
        : { kept: layerable, rest: [] };
    const layered = split.kept;
    let lo = AREA_MIN;
    let hi = AREA_MAX;
    let plans = plansFor(lo, v.box);
    let placed = await placeBoxes(plans, layered, v, aspect);
    if (fits(placed)) {
      const rounds = roots.length > 60 ? 4 : 6;
      for (let k = 0; k < rounds; k++) {
        const mid = Math.sqrt(lo * hi);
        const tryPlans = plansFor(mid, v.box);
        const tryPlaced = await placeBoxes(tryPlans, layered, v, aspect);
        if (fits(tryPlaced)) {
          lo = mid;
          placed = tryPlaced;
          plans = tryPlans;
        } else hi = mid;
      }
    }
    // Scale that fits the diagram to the canvas, and the on-screen area of its biggest box.
    const scale = Math.min(usableW / Math.max(1, placed.width), usableH / Math.max(1, placed.height));
    const biggest = Math.max(...plans.map((p) => p.w * p.h));
    const widest = Math.max(...plans.map((p) => p.w)) * scale;
    // The biggest box should be at least about a quarter of the canvas wide; sets that manage it come first.
    const score = biggest * scale * scale * (widest >= 0.23 * viewport.w ? 1 : 0.85);
    return { placed, plans, score, rest: split.rest };
  };
  let best = await solve(VARIANTS[0] as Variant);
  if (roots.length <= 40 && pairs.length > 0) {
    for (const v of VARIANTS.slice(1)) {
      const cand = await solve(v);
      if (cand.score > best.score * 1.02) best = cand;
    }
  }
  const bestPlans = best.plans;
  const placedBest = best.placed;
  // Every link gets its own orthogonal route around the boxes (see `mapRoute.ts`); very large maps keep the elk
  // routes and the visibility-graph fallback for the rest.
  const allPairs = importPairs.length > 0 ? [...importPairs, ...declaredPairs] : declaredPairs;
  if (roots.length <= 60 && allPairs.length <= 240) {
    const links: RouteLink[] = allPairs.map(([a, b]) => ({
      key: `${a}>${b}`,
      a,
      b,
      weight: weightOf([a, b]),
      declared: !pairWeight.has(`${a}>${b}`),
    }));
    placedBest.routes = routeLinks(placedBest.boxes, links);
  } else addExtraRoutes(placedBest, [...best.rest, ...extraBase]);
  let bx0 = 0;
  let by0 = 0;
  let bx1 = 0;
  let by1 = 0;
  for (const r of placedBest.boxes.values()) {
    bx0 = Math.min(bx0, r.x);
    by0 = Math.min(by0, r.y);
    bx1 = Math.max(bx1, r.x + r.w);
    by1 = Math.max(by1, r.y + r.h);
  }
  // The fit follows the boxes and the import routes. Declared-only routes (hidden by default) may run a little
  // beyond it when they must detour; they must not shrink the picture.
  for (const [key, pts] of placedBest.routes)
    for (const [px, py] of pts) {
      if (
        !pairWeight.has(key) &&
        (px < bx0 - ROUTE_ROOM || py < by0 - ROUTE_ROOM || px > bx1 + ROUTE_ROOM || py > by1 + ROUTE_ROOM)
      )
        continue;
      bx0 = Math.min(bx0, px);
      by0 = Math.min(by0, py);
      bx1 = Math.max(bx1, px);
      by1 = Math.max(by1, py);
    }

  // Treemap inside every box, laid out in its normalized content rectangle (headers are added on screen).
  const skipped = collapseChains(
    tree,
    files,
    Float64Array.from(tree.nodes, (_, i) => fnOf(i)),
  ).skipped;
  const rects = new Float64Array(tree.nodes.length * 4);
  const heads = new Float32Array(tree.nodes.length);
  const positions: Positions = {};
  const tm = (i: number): TmNode => {
    const n = tree.nodes[i] as TreeNode;
    const cls = kindTier(n.kind);
    return {
      id: n.id,
      weight: cls >= 3 ? 1 : Math.max(fnOf(i), MIN_WEIGHT),
      children: n.children.map(tm),
      head: 0,
      transparent: skipped[i] === 1,
    };
  };
  for (const plan of bestPlans) {
    const box = placedBest.boxes.get(plan.index) as Rect;
    const out = layoutTreemap(tm(plan.index), box);
    for (const [id, r] of out.rects) {
      const idx = tree.index.get(id) as number;
      rects.set([r.x, r.y, r.w, r.h], idx * 4);
      positions[id] = [Math.round((r.x + r.w / 2) * 10) / 10, Math.round((r.y + r.h / 2) * 10) / 10];
    }
    heads[plan.index] = plan.head;
  }

  const routes: MapGeometry["routes"] = {};
  for (const [key, pts] of placedBest.routes) {
    const [a, b] = key.split(">").map(Number) as [number, number];
    routes[`${(tree.nodes[a] as TreeNode).id}>${(tree.nodes[b] as TreeNode).id}`] = pts;
  }
  return {
    positions,
    map: {
      rects,
      heads,
      routes,
      bounds: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    },
  };
}

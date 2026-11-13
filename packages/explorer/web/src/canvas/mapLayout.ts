// Layout of the project map: workspace boxes in a layered left-to-right dependency diagram (elk), and a nested
// squarified treemap inside every box. Pure and deterministic; runs in the layout worker.
//
// Units are "pixels at the fit zoom of a canvas of `viewport` size": the box sizes, gaps and header strips are
// chosen so that, when the camera fits the whole diagram, titles are at least 11px and gaps at least 60px.
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import { kindTier, type Tree, type TreeNode } from "./hierarchy.ts";
import { type Pt, routeAround } from "./route.ts";
import { layoutTreemap, type TmNode } from "./treemap.ts";
import type { LayoutInput, MapGeometry, Positions, Rect } from "./types.ts";

export const DEFAULT_VIEWPORT = { w: 1200, h: 720 };
/** Screen space the camera keeps free around the diagram (controls on top, status chip at the bottom). */
export const FIT_INSETS = { top: 56, right: 28, bottom: 40, left: 28 };

export const AREA_MIN = 40; // px² of box area per function, lower search bound
export const AREA_MAX = 30000; // upper bound: a tiny repo does not need huge boxes
const BOX_ASPECT = 1.3;
const MIN_BOX_W = 200;
const MIN_LEAF_H = 96;
const BOX_GAP = 64;
const LAYER_GAP = 84;
/** Folder title bar and file header strip, in px at the fit zoom (units are divided by the fit scale). */
export const DIR_HEAD_PX = 17;
export const FILE_HEAD_PX = 13;
/** A file with no functions still gets this much weight, so it shows up as a thin cell. */
export const MIN_WEIGHT = 0.6;

/** Title font (px at fit) of a workspace box of width `w`. */
export function titleFont(w: number): number {
  return Math.min(22, Math.max(13, w * 0.085));
}
/** Header strip of a workspace box: room for the name line and the "app · N functions · N files" line. */
export function titleHead(w: number): number {
  return Math.round(titleFont(w) * 3.4);
}

/** Lines `text` needs when wrapped at `maxW` px, at about `em` px per character. */
function linesFor(text: string, em: number, maxW: number): number {
  return Math.max(1, Math.ceil((text.length * em) / Math.max(40, maxW)));
}

/**
 * Header strip that holds the whole title block of a box of width `w`: the design size at scale 1, and the 11px
 * name / 10px detail minimum at a fit scale of 0.8 (the camera may fit the diagram a little smaller than 1).
 * Text widths are estimated (no canvas in the worker).
 */
export function headFor(w: number, title: string, parts: readonly string[]): number {
  const need = (nameFont: number, subFont: number, width: number): number => {
    const nameLines = linesFor(title, nameFont * 0.62, width);
    // Detail parts wrap as whole " · " pieces.
    let lines = 1;
    let cur = 0;
    for (const part of parts) {
      const pw = (part.length + 3) * subFont * 0.56;
      if (cur > 0 && cur + pw > width) {
        lines++;
        cur = pw;
      } else cur += pw;
    }
    return nameLines * nameFont * 1.2 + 4 + lines * subFont * 1.3 + 14;
  };
  const f = titleFont(w);
  const design = need(f, Math.max(10, Math.round(f * 0.74)), w - 20);
  const s0 = 0.75;
  const minimum = need(11, 10, w * s0 - 20) / s0;
  return Math.round(Math.max(design, minimum, titleHead(w)));
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
  hasChildren: boolean,
  title = "",
  parts: readonly string[] = [],
): { w: number; h: number; head: number } {
  const a = Math.max(0, fn) * area;
  const w = Math.max(MIN_BOX_W, Math.sqrt(a * BOX_ASPECT));
  const head = headFor(w, title, parts);
  const h = Math.max(a / w, hasChildren ? Math.max(head + 70, head * 1.9) : Math.max(MIN_LEAF_H, head + 12));
  return { w: Math.round(w), h: Math.round(h), head };
}

async function placeBoxes(plans: BoxPlan[], pairs: [number, number][]): Promise<Placed> {
  const children: ElkNode[] = plans.map((p) => ({ id: `n${p.index}`, width: p.w, height: p.h }));
  const elkEdges: ElkExtendedEdge[] = pairs.map(([a, b], k) => ({
    id: `e${k}`,
    sources: [`n${a}`],
    targets: [`n${b}`],
  }));
  const out = await new ELK().layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(BOX_GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
      "elk.layered.spacing.edgeNodeBetweenLayers": "26",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeNode": "32",
      "elk.spacing.componentComponent": String(BOX_GAP),
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.aspectRatio": "1.8",
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
  // Like the renderer: links between the workspace nodes themselves when there are any, else everything lifted.
  const direct = edges.filter((e) => rootOf(e.src) === e.src && rootOf(e.dst) === e.dst);
  const linkSource = direct.length > 0 ? direct : edges;
  const collect = (declared: boolean) => {
    for (const e of linkSource) {
      if ((e.kind === "depends_on") !== declared) continue;
      const a = rootOf(e.src);
      const b = rootOf(e.dst);
      const key = `${a}>${b}`;
      if (a === b || seen.has(key)) continue;
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
  const extraPairs = importPairs.length > 0 ? declaredPairs : [];

  const fns = new Map(roots.map((r) => [r, fnOf(r)]));
  const plansFor = (area: number): BoxPlan[] =>
    roots.map((r) => {
      const node = titles.get((tree.nodes[r] as TreeNode).id);
      return {
        index: r,
        ...boxSize(
          fns.get(r) as number,
          area,
          (tree.nodes[r] as TreeNode).children.length > 0,
          node?.title ?? "",
          node?.subtitle ?? [],
        ),
      };
    });

  // The biggest box area per function at which the whole diagram still fits the canvas.
  let lo = AREA_MIN;
  let hi = AREA_MAX;
  let best = await placeBoxes(plansFor(lo), pairs);
  let bestPlans = plansFor(lo);
  const fits = (p: Placed) => p.width <= usableW && p.height <= usableH;
  if (fits(best)) {
    const rounds = roots.length > 60 ? 4 : 9;
    for (let k = 0; k < rounds; k++) {
      const mid = Math.sqrt(lo * hi);
      const plans = plansFor(mid);
      const placed = await placeBoxes(plans, pairs);
      if (fits(placed)) {
        lo = mid;
        best = placed;
        bestPlans = plans;
      } else hi = mid;
    }
  }

  addExtraRoutes(best, extraPairs);

  // The camera will fit this diagram at about this scale; header strips are sized so they read at that scale.
  const fitScale = Math.min(1.4, Math.max(0.4, Math.min(usableW / best.width, usableH / best.height)));
  const dirHead = Math.ceil(DIR_HEAD_PX / fitScale);
  const fileHead = Math.ceil(FILE_HEAD_PX / fitScale);

  // Treemap inside every box.
  const rects = new Float64Array(tree.nodes.length * 4);
  const heads = new Float32Array(tree.nodes.length);
  const positions: Positions = {};
  const tm = (i: number): TmNode => {
    const n = tree.nodes[i] as TreeNode;
    const kids = n.children.map(tm);
    const cls = kindTier(n.kind);
    const leafWeight = cls >= 3 ? 1 : Math.max(fnOf(i), MIN_WEIGHT);
    return {
      id: n.id,
      weight: leafWeight,
      children: kids,
      head: cls === 1 ? dirHead : cls === 2 ? fileHead : 0,
    };
  };
  for (const plan of bestPlans) {
    const box = best.boxes.get(plan.index) as Rect;
    const root = tm(plan.index);
    root.head = plan.head;
    root.keepHead = true;
    const out = layoutTreemap(root, box);
    for (const [id, r] of out.rects) {
      const idx = tree.index.get(id) as number;
      rects.set([r.x, r.y, r.w, r.h], idx * 4);
      heads[idx] = out.heads.get(id) ?? 0;
      positions[id] = [Math.round((r.x + r.w / 2) * 10) / 10, Math.round((r.y + r.h / 2) * 10) / 10];
    }
  }

  const routes: MapGeometry["routes"] = {};
  for (const [key, pts] of best.routes) {
    const [a, b] = key.split(">").map(Number) as [number, number];
    routes[`${(tree.nodes[a] as TreeNode).id}>${(tree.nodes[b] as TreeNode).id}`] = pts;
  }
  return {
    positions,
    map: {
      rects,
      heads,
      routes,
      bounds: { x: 0, y: 0, w: best.width, h: best.height },
      dirHead,
      fileHead,
    },
  };
}

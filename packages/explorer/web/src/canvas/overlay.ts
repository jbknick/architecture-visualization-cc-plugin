// The 2D layer under the sigma canvas: labelled containment regions and aggregated arrows.
// It is redrawn on every sigma render so it pans and zooms with the camera.
import { headFor, isRegion, type Tree, type TreeNode } from "./hierarchy.ts";
import { edgeNoun, type Scene } from "./scene.ts";
import { type CanvasTheme, hexToRgba, labelInk, mix } from "./style.ts";
import type { Positions, Rect } from "./types.ts";
import { type Level, MIN_LABEL_PX, regionTier } from "./zoom.ts";

export interface OverlayEnv {
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size of the canvas. */
  w: number;
  h: number;
  scene: Scene;
  regions: Map<number, Rect>;
  positions: Positions;
  level: Level;
  theme: CanvasTheme;
  project: (x: number, y: number) => { x: number; y: number };
  /** Screen pixels per graph unit. */
  scale: number;
  wsColor: (root: number) => string;
  /** Nodes kept at full opacity while something is selected; null when nothing is. */
  bright: Set<number> | null;
  related: Set<number> | null;
  hoverEdge: string | null;
}

export interface EdgeHit {
  key: string;
  src: number;
  dst: number;
  weight: number;
  noun: string;
  /** Sampled polyline in screen pixels. */
  pts: [number, number][];
  width: number;
}

export interface RegionHit {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayResult {
  edgeHits: EdgeHit[];
  regionHits: RegionHit[];
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Largest font size in [min, max] at which `text` fits in `maxW`, or null if even `min` does not fit. */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  maxW: number,
  max: number,
  min: number,
): number | null {
  ctx.font = `${weight} ${max}px ${FONT}`;
  const w = ctx.measureText(text).width;
  const px = Math.min(max, (max * maxW) / Math.max(w, 1));
  return px >= min ? px : null;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  halo: string,
): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function exitPoint(
  rect: { x: number; y: number; w: number; h: number },
  tx: number,
  ty: number,
): [number, number] {
  // Ray from the rect centre toward (tx, ty), clipped at the rect border.
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : rect.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle - 0.42) * size, y - Math.sin(angle - 0.42) * size);
  ctx.lineTo(x - Math.cos(angle + 0.42) * size, y - Math.sin(angle + 0.42) * size);
  ctx.closePath();
  ctx.fill();
}

interface Screen {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function drawOverlay(env: OverlayEnv): OverlayResult {
  const { ctx, w, h, scene, level, theme } = env;
  const tree = scene.tree;
  const result: OverlayResult = { edgeHits: [], regionHits: [] };
  ctx.clearRect(0, 0, w, h);
  if (!scene.hierarchical) return result;

  const maxRegionTier = regionTier(level);
  const screens = new Map<number, Screen>();
  const order: number[] = [];
  for (const [i, rect] of env.regions) {
    const node = tree.nodes[i] as TreeNode;
    if (node.tier > maxRegionTier) continue;
    const a = env.project(rect.x, rect.y);
    const b = env.project(rect.x + rect.w, rect.y + rect.h);
    const s = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
    if (s.x > w || s.y > h || s.x + s.w < 0 || s.y + s.h < 0) continue; // off screen
    if (s.w < 6 || s.h < 6) continue;
    screens.set(i, s);
    order.push(i);
  }
  order.sort((p, q) => (tree.nodes[p] as TreeNode).tier - (tree.nodes[q] as TreeNode).tier || p - q);

  const dimmed = (i: number): boolean => env.bright !== null && !env.bright.has(i);
  const light = theme.scheme === "light";

  // 1. Region fills and borders, parents first.
  for (const i of order) {
    const node = tree.nodes[i] as TreeNode;
    const s = screens.get(i) as Screen;
    const colour = env.wsColor(node.root);
    const tier = node.tier;
    // Tint fades with depth so nested regions read as cards on top of their parent.
    const deep = level !== "far";
    const fillAmount =
      tier === 0
        ? light
          ? deep
            ? 0.07
            : 0.11
          : deep
            ? 0.12
            : 0.17
        : tier === 1
          ? light
            ? 0.035
            : 0.07
          : light
            ? 0.012
            : 0.035;
    const base = theme.surface;
    ctx.globalAlpha = dimmed(i) ? 0.15 : 1;
    roundRect(
      ctx,
      s.x,
      s.y,
      s.w,
      s.h,
      (tier === 0 ? 16 : tier === 1 ? 10 : 7) * Math.min(1, Math.max(0.5, env.scale * 3)),
    );
    ctx.fillStyle = mix(colour, base, fillAmount);
    ctx.fill();
    ctx.lineWidth = tier === 0 ? 2.5 : tier === 1 ? 1.5 : 1;
    ctx.strokeStyle = hexToRgba(colour, tier === 0 ? 0.9 : tier === 1 ? 0.6 : 0.45);
    ctx.stroke();
    ctx.globalAlpha = 1;
    result.regionHits.push({ index: i, ...s });
  }

  // 2. Aggregated arrows between regions.
  drawEdges(env, screens, result);

  // 3. Labels on top of the arrows.
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const i of order) drawRegionLabel(env, tree, i, screens.get(i) as Screen);
  ctx.globalAlpha = 1;
  return result;
}

function drawRegionLabel(env: OverlayEnv, tree: Tree, i: number, s: Screen): void {
  const { ctx, theme, level, scene } = env;
  const node = tree.nodes[i] as TreeNode;
  const label = scene.nodes[i]?.label ?? node.id;
  const colour = env.wsColor(node.root);
  const ink = labelInk(colour, theme.scheme);
  const halo = hexToRgba(theme.scheme === "light" ? "#ffffff" : theme.surface, 0.85);
  ctx.globalAlpha = env.bright !== null && !env.bright.has(i) ? 0.35 : 1;

  if (node.tier === 0 && level === "far") {
    const pad = 14;
    const maxFont = Math.max(15, Math.min(34, s.w * 0.1));
    const fit = fitFont(ctx, label, 700, s.w - 2 * pad, maxFont, MIN_LABEL_PX + 2);
    const inside = fit !== null;
    const font = fit ?? Math.max(MIN_LABEL_PX + 2, Math.min(maxFont, 18));
    ctx.font = `700 ${font}px ${FONT}`;
    const detail = detailLine(scene, i);
    const needH = font * (detail ? 2.7 : 1.5) + pad;
    const fitsVertically = s.h >= needH;
    if (inside && fitsVertically) {
      ctx.fillStyle = ink;
      ctx.fillText(label, s.x + pad, s.y + pad);
      drawBadgeLine(
        env,
        i,
        s.x + pad,
        s.y + pad + font * 1.35,
        Math.max(MIN_LABEL_PX, font * 0.58),
        s.w - 2 * pad,
      );
    } else {
      // Too small to hold the name: put it above the box, like a map label.
      const text = label;
      ctx.textBaseline = "alphabetic";
      haloText(ctx, text, s.x, s.y - 8, ink, halo);
      ctx.textBaseline = "top";
    }
    return;
  }

  const head = headFor(node.tier) * env.scale;
  const maxFont = node.tier === 0 ? 26 : node.tier === 1 ? 15 : 13;
  const font = Math.min(maxFont, head * 0.62);
  if (font < MIN_LABEL_PX) return;
  const pad = Math.min(12, s.w * 0.08);
  ctx.font = `${node.tier === 2 ? 600 : 700} ${font}px ${FONT}`;
  const detailW = node.tier === 0 ? 0 : 0;
  const text = truncate(ctx, label, s.w - 2 * pad - detailW);
  if (!text) return;
  ctx.fillStyle = ink;
  ctx.fillText(text, s.x + pad, s.y + Math.max(4, (head - font) / 2.2));
  if (node.tier === 0) {
    const used = ctx.measureText(text).width;
    const fn = Math.max(MIN_LABEL_PX, font * 0.6);
    const line = detailLine(scene, i);
    if (line && s.w - 2 * pad - used > 120) {
      ctx.font = `500 ${fn}px ${FONT}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(line, s.x + pad + used + 12, s.y + Math.max(4, (head - font) / 2.2) + (font - fn) * 0.7);
    }
  }
}

function detailLine(scene: Scene, i: number): string {
  const n = scene.symbolCount[i] || scene.nodes[i]?.stats?.functions || scene.nodes[i]?.size || 0;
  return n > 0 ? `${n.toLocaleString("en-US")} function${n === 1 ? "" : "s"}` : "";
}

/** Kind badge ("app" / "package") followed by the function count. */
function drawBadgeLine(env: OverlayEnv, i: number, x: number, y: number, font: number, maxW: number): void {
  const { ctx, scene, theme } = env;
  const badge = scene.nodes[i]?.badges?.[0];
  const colour = env.wsColor((scene.tree.nodes[i] as TreeNode).root);
  let cx = x;
  ctx.font = `600 ${font}px ${FONT}`;
  if (badge) {
    const tw = ctx.measureText(badge).width;
    const bw = tw + 14;
    const bh = font + 7;
    roundRect(ctx, cx, y - 2, bw, bh, bh / 2);
    ctx.fillStyle = mix(colour, theme.surface, theme.scheme === "light" ? 0.16 : 0.3);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.fillStyle = labelInk(colour, theme.scheme);
    ctx.fillText(badge, cx + 7, y + 1);
    cx += bw + 8;
  }
  const line = detailLine(scene, i);
  if (line) {
    ctx.font = `500 ${font}px ${FONT}`;
    ctx.fillStyle = theme.muted;
    if (ctx.measureText(line).width <= maxW - (cx - x)) ctx.fillText(line, cx, y + 1);
  }
}

type Pt = [number, number];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** True when the segment p-q passes through the interior of the box (Liang-Barsky). */
function segmentHitsBox(p: Pt, q: Pt, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const checks: [number, number][] = [
    [-dx, p[0] - b.x0],
    [dx, b.x1 - p[0]],
    [-dy, p[1] - b.y0],
    [dy, b.y1 - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (pk === 0) {
      if (qk <= 0) return false;
    } else {
      const r = qk / pk;
      if (pk < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 - t0 > 1e-6 && t0 < 1 && t1 > 0;
}

/**
 * Shortest path from `start` to `end` that stays out of `boxes`: a visibility graph over the boxes' corners.
 * Returns the straight segment when nothing is in the way.
 */
export function routeAround(start: Pt, end: Pt, boxes: Box[]): Pt[] {
  const blocked = (p: Pt, q: Pt) => boxes.some((b) => segmentHitsBox(p, q, b));
  if (!blocked(start, end)) return [start, end];
  const nodes: Pt[] = [start, end];
  for (const b of boxes) {
    for (const c of [
      [b.x0, b.y0],
      [b.x1, b.y0],
      [b.x1, b.y1],
      [b.x0, b.y1],
    ] as Pt[]) {
      const inside = boxes.some(
        (o) => c[0] > o.x0 + 0.5 && c[0] < o.x1 - 0.5 && c[1] > o.y0 + 0.5 && c[1] < o.y1 - 0.5,
      );
      if (!inside) nodes.push(c);
    }
  }
  const n = nodes.length;
  const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (let step = 0; step < n; step++) {
    let u = -1;
    for (let i = 0; i < n; i++)
      if (!done[i] && (u === -1 || (dist[i] as number) < (dist[u] as number))) u = i;
    if (u === -1 || dist[u] === Number.POSITIVE_INFINITY) break;
    done[u] = true;
    if (u === 1) break;
    const pu = nodes[u] as Pt;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue;
      const pv = nodes[v] as Pt;
      if (blocked(pu, pv)) continue;
      // A small per-bend penalty prefers fewer turns over marginally shorter paths.
      const d = (dist[u] as number) + Math.hypot(pv[0] - pu[0], pv[1] - pu[1]) + 12;
      if (d < (dist[v] as number)) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  if (prev[1] === -1) return [start, end];
  const path: Pt[] = [];
  for (let cur = 1; cur !== -1; cur = prev[cur] as number) path.push(nodes[cur] as Pt);
  return path.reverse();
}

function strokeRounded(ctx: CanvasRenderingContext2D, pts: Pt[], radius: number): void {
  const first = pts[0] as Pt;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const r = Math.min(
      radius,
      Math.hypot(b[0] - a[0], b[1] - a[1]) / 2,
      Math.hypot(c[0] - b[0], c[1] - b[1]) / 2,
    );
    ctx.arcTo(b[0], b[1], c[0], c[1], r);
  }
  const last = pts[pts.length - 1] as Pt;
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

function polylineLength(pts: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    sum += Math.hypot((pts[i] as Pt)[0] - (pts[i - 1] as Pt)[0], (pts[i] as Pt)[1] - (pts[i - 1] as Pt)[1]);
  }
  return sum;
}

function pointAlong(pts: Pt[], fraction: number): Pt {
  let remaining = polylineLength(pts) * fraction;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= seg || i === pts.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= seg;
  }
  return pts[0] as Pt;
}

function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0] as Pt];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function drawEdges(env: OverlayEnv, screens: Map<number, Screen>, out: OverlayResult): void {
  const { ctx, scene, level, theme } = env;
  const list = scene.overlayEdges[level];
  if (list.length === 0) return;
  const maxWeight = Math.max(...list.map((e) => e.weight), 1);
  const ink = theme.scheme === "light" ? "#1f2937" : "#d7dde8";
  const geom = (i: number): Screen | null => {
    const s = screens.get(i);
    if (s) return s;
    if (isRegion(scene.tree, i)) return null; // its region is off screen or not drawn at this level
    const p = env.positions[(scene.tree.nodes[i] as TreeNode).id];
    if (!p) return null;
    const c = env.project(p[0], p[1]);
    if (c.x < -20 || c.x > env.w + 20 || c.y < -20 || c.y > env.h + 20) return null;
    return { x: c.x - 4, y: c.y - 4, w: 8, h: 8 };
  };
  const reverse = new Set(list.map((e) => `${e.src}>${e.dst}`));
  const labels: { x: number; y: number; text: string; strong: boolean }[] = [];
  // Far level: route around the other workspace boxes so arrows never cross a region they do not connect.
  const rootBoxes = (skipA: number, skipB: number): Box[] => {
    if (level !== "far") return [];
    const boxes: Box[] = [];
    for (const [i, s] of screens) {
      if (i === skipA || i === skipB) continue;
      boxes.push({ x0: s.x - 14, y0: s.y - 14, x1: s.x + s.w + 14, y1: s.y + s.h + 14 });
    }
    return boxes;
  };

  for (const e of list) {
    const a = geom(e.src);
    const b = geom(e.dst);
    if (!a || !b) continue;
    const related = env.related !== null && (env.related.has(e.src) || env.related.has(e.dst));
    const key = `${e.src}>${e.dst}`;
    const hovered = env.hoverEdge === key;
    const ratio = Math.sqrt(e.weight / maxWeight);
    const base = level === "far" ? 2.5 + 8 * ratio : level === "mid" ? 1.2 + 4 * ratio : 1.4 + 2.6 * ratio;
    const width = hovered ? base + 2 : base;
    const centreA: Pt = [a.x + a.w / 2, a.y + a.h / 2];
    const centreB: Pt = [b.x + b.w / 2, b.y + b.h / 2];

    let route = routeAround(centreA, centreB, rootBoxes(e.src, e.dst));
    if (route.length === 2) {
      // Direct: a gentle bow so the two directions of a pair do not overlap.
      const dx = centreB[0] - centreA[0];
      const dy = centreB[1] - centreA[1];
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(46, len * 0.1) * (reverse.has(`${e.dst}>${e.src}`) ? 1.6 : 1);
      const cx = (centreA[0] + centreB[0]) / 2 - (dy / len) * bow;
      const cy = (centreA[1] + centreB[1]) / 2 + (dx / len) * bow;
      route = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        route.push([
          u * u * centreA[0] + 2 * u * t * cx + t * t * centreB[0],
          u * u * centreA[1] + 2 * u * t * cy + t * t * centreB[1],
        ]);
      }
    } else if (reverse.has(`${e.dst}>${e.src}`)) {
      // Shift one direction sideways so the pair stays distinguishable.
      const dx = centreB[0] - centreA[0];
      const dy = centreB[1] - centreA[1];
      const len = Math.hypot(dx, dy) || 1;
      const off = width / 2 + 3;
      route = route.map((p, k) =>
        k === 0 || k === route.length - 1 ? p : [p[0] - (dy / len) * off, p[1] + (dx / len) * off],
      );
    }
    // Clip to the box borders: drop the part of the route that lies inside either box.
    const inside = (r: Screen, p: Pt) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h;
    let i0 = 0;
    while (i0 < route.length - 1 && inside(a, route[i0] as Pt)) i0++;
    let i1 = route.length - 1;
    while (i1 > i0 && inside(b, route[i1] as Pt)) i1--;
    const outer = route.slice(i0, i1 + 1);
    if (outer.length === 0) continue;
    const firstOuter = outer[0] as Pt;
    const lastOuter = outer[outer.length - 1] as Pt;
    const pts: Pt[] = [
      exitPoint(a, firstOuter[0], firstOuter[1]),
      ...outer,
      exitPoint(b, lastOuter[0], lastOuter[1]),
    ];
    if (polylineLength(pts) < 8) continue;

    const head = Math.max(13, width * 2.2 + 6);
    const last = pts[pts.length - 1] as Pt;
    const before = pts[pts.length - 2] as Pt;
    const tAng = Math.atan2(last[1] - before[1], last[0] - before[0]);
    const tipGap = 3;
    const tip: Pt = [last[0] - Math.cos(tAng) * tipGap, last[1] - Math.sin(tAng) * tipGap];
    // Stop the stroke short of the tip so a fat line end does not blunt the arrowhead.
    const shaft = pts.slice(0, -1);
    const back = Math.min(head * 0.85, Math.hypot(last[0] - before[0], last[1] - before[1]) * 0.9);
    shaft.push([last[0] - Math.cos(tAng) * (tipGap + back), last[1] - Math.sin(tAng) * (tipGap + back)]);

    const dim = env.bright !== null && !related;
    ctx.globalAlpha = dim ? 0.08 : level === "far" ? 0.75 : level === "mid" ? 0.55 : 0.6;
    const colour = related || hovered ? theme.accent : ink;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    strokeRounded(ctx, shaft, 26);
    ctx.globalAlpha = dim ? 0.1 : 0.95;
    arrowHead(ctx, tip[0], tip[1], tAng, head);
    ctx.globalAlpha = 1;

    const noun = edgeNoun(e.kind, e.mixed);
    out.edgeHits.push({ key, src: e.src, dst: e.dst, weight: e.weight, noun, pts: densify(pts, 12), width });

    if ((level === "far" || related || hovered) && !dim) {
      const mid = pointAlong(pts, 0.5);
      labels.push({ x: mid[0], y: mid[1], text: String(e.weight), strong: related || hovered });
    }
  }

  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const l of labels) {
    ctx.font = `700 ${MIN_LABEL_PX + 1}px ${FONT}`;
    const tw = ctx.measureText(l.text).width;
    const bw = tw + 12;
    const bh = MIN_LABEL_PX + 8;
    roundRect(ctx, l.x - bw / 2, l.y - bh / 2, bw, bh, bh / 2);
    ctx.fillStyle = theme.surface;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = l.strong ? theme.accent : ink;
    ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.fillText(l.text, l.x, l.y + 0.5);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(px: number, py: number, pts: [number, number][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k] as [number, number];
    const [x1, y1] = pts[k + 1] as [number, number];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
  }
  return best;
}

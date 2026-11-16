// Pure geometry and styling of the lane canvas (#48): node boxes, edge curves, hit tests, lane and band extents.
// No DOM, so it is unit-tested directly.
import type { GraphEdge, GraphNode, LaneInfo } from "../api.ts";
import { edgeKindColor, type Scheme } from "../theme.ts";
import type { Positions } from "./types.ts";

/** The size of a node box in the lane layouts (layout.ts spaces the lanes for it). */
export const FLOW_BOX_W = 210;
export const FLOW_BOX_H = 28;

export interface Pt {
  x: number;
  y: number;
}

/** A cubic Bézier from p0 to p3. */
export interface Curve {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}

export interface EdgeStyle {
  color: string;
  /** Dash pattern in screen pixels, or null for a solid line. */
  dash: number[] | null;
  width: number;
}

/** Reads blue, writes orange, everything else the neutral ink; a low-confidence edge is dashed. */
export function edgeStyle(e: Pick<GraphEdge, "kind" | "confidence" | "weight">, scheme: Scheme): EdgeStyle {
  const ink = scheme === "light" ? "#5b6575" : "#9aa4b4";
  const color = edgeKindColor(e.kind, scheme) ?? ink;
  return {
    color,
    dash: e.confidence === "low" ? [6, 4] : null,
    width: Math.min(4, 1.2 + Math.log2(Math.max(1, e.weight)) * 0.6),
  };
}

/**
 * The curve of an edge between two boxes centred on `a` and `b`: from the right side of the source to the left side
 * of the target when the target is to the right, the other way round when it is to the left, and a loop out of the
 * right sides when both are in one column.
 */
export function edgeCurve(a: Pt, b: Pt, offset = 0): Curve {
  const hw = FLOW_BOX_W / 2;
  const dy = offset * 4;
  if (Math.abs(b.x - a.x) < hw) {
    const x = Math.max(a.x, b.x) + hw;
    const bulge = 40 + Math.min(120, Math.abs(b.y - a.y) * 0.25);
    return {
      p0: { x, y: a.y + dy },
      p1: { x: x + bulge, y: a.y + dy },
      p2: { x: x + bulge, y: b.y + dy },
      p3: { x, y: b.y + dy },
    };
  }
  const dir = b.x > a.x ? 1 : -1;
  const p0 = { x: a.x + dir * hw, y: a.y + dy };
  const p3 = { x: b.x - dir * hw, y: b.y + dy };
  const k = Math.max(30, Math.abs(p3.x - p0.x) * 0.45);
  return { p0, p1: { x: p0.x + dir * k, y: p0.y }, p2: { x: p3.x - dir * k, y: p3.y }, p3 };
}

export function pointAt(c: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
  };
}

/** Smallest distance from `p` to the curve, sampled at 32 points (good enough for hover). */
export function distanceToCurve(c: Curve, p: Pt): number {
  let best = Number.POSITIVE_INFINITY;
  let prev = c.p0;
  for (let i = 1; i <= 32; i++) {
    const cur = pointAt(c, i / 32);
    best = Math.min(best, segDist(prev, cur, p));
    prev = cur;
  }
  return best;
}

function segDist(a: Pt, b: Pt, p: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The box of every positioned node, in world units (top-left corner). */
export function boxesOf(nodes: GraphNode[], positions: Positions): Box[] {
  const out: Box[] = [];
  for (const n of nodes) {
    const p = positions[n.id];
    if (p)
      out.push({
        id: n.id,
        x: p[0] - FLOW_BOX_W / 2,
        y: p[1] - FLOW_BOX_H / 2,
        w: FLOW_BOX_W,
        h: FLOW_BOX_H,
      });
  }
  return out;
}

export function hitBox(boxes: Box[], p: Pt): Box | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i] as Box;
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
  }
  return null;
}

export interface Extent {
  key: string;
  label: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The world rectangle of each lane that has nodes, titled from the view's lanes, left to right. */
export function laneExtents(nodes: GraphNode[], positions: Positions, lanes: LaneInfo[]): Extent[] {
  const by = new Map<number, Extent>();
  for (const n of nodes) {
    const p = positions[n.id];
    if (!p || n.lane === undefined) continue;
    const cur = by.get(n.lane) ?? {
      key: String(n.lane),
      label: lanes.find((l) => l.lane === n.lane)?.label ?? "",
      x0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    };
    cur.x0 = Math.min(cur.x0, p[0] - FLOW_BOX_W / 2);
    cur.x1 = Math.max(cur.x1, p[0] + FLOW_BOX_W / 2);
    cur.y0 = Math.min(cur.y0, p[1] - FLOW_BOX_H / 2);
    cur.y1 = Math.max(cur.y1, p[1] + FLOW_BOX_H / 2);
    by.set(n.lane, cur);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

/** The world rectangle of each band (endpoints view), in the order the bands first appear. */
export function bandExtents(nodes: GraphNode[], positions: Positions): Extent[] {
  const by = new Map<string, Extent>();
  for (const n of nodes) {
    const p = positions[n.id];
    if (!p || n.band === undefined) continue;
    const cur = by.get(n.band) ?? {
      key: n.band,
      label: n.band,
      x0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    };
    cur.x0 = Math.min(cur.x0, p[0] - FLOW_BOX_W / 2);
    cur.x1 = Math.max(cur.x1, p[0] + FLOW_BOX_W / 2);
    cur.y0 = Math.min(cur.y0, p[1] - FLOW_BOX_H / 2);
    cur.y1 = Math.max(cur.y1, p[1] + FLOW_BOX_H / 2);
    by.set(n.band, cur);
  }
  return [...by.values()].sort((a, b) => a.y0 - b.y0);
}

/** Words for the edge tooltip: what the edge is, how many places it stands for, and whether it is a guess. */
export function edgeTipLines(
  e: GraphEdge,
  labelOf: (id: string) => string,
): { title: string; lines: string[] } {
  const verb: Record<string, string> = {
    requests: "requests",
    reads: "reads",
    writes: "writes",
    handles: "handled by",
    calls: "calls",
    renders: "renders",
    uses_hook: "uses hook",
    serves: "serves",
    middleware: "passes through",
    uses: "reaches the database call",
  };
  const title = `${labelOf(e.src)} ${verb[e.kind] ?? e.kind.replace(/_/g, " ")} ${labelOf(e.dst)}`;
  const lines: string[] = [];
  if (e.kind === "requests" && e.via !== undefined) {
    lines.push(`via ${e.via} ${e.via === 1 ? "place" : "places"} in the page`);
    if (e.viaSample && e.viaSample.length > 0)
      lines.push(e.viaSample.join(", ") + (e.via > e.viaSample.length ? ", …" : ""));
  } else if (e.kind === "uses" && e.via !== undefined) {
    lines.push(
      e.via === 0
        ? "the handler makes the call itself"
        : `through ${e.via} ${e.via === 1 ? "function" : "functions"}`,
    );
  } else if (e.weight > 1) lines.push(`${e.weight} calls`);
  if (e.confidence === "low") lines.push("uncertain match (dashed)");
  return { title, lines };
}

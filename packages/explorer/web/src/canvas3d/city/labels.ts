// Screen-space helpers for the city's DOM labels: rectangle tests and flag placement. Pure.
import { decollideMarkers } from "../../rankedFiles/markers.ts";

export interface ScreenRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export type Pt2 = readonly [number, number];

export const FLAG_R = 10;
export const POLE_PX = 30;

export function rectsOverlap(a: ScreenRect, b: ScreenRect, pad = 0): boolean {
  return a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;
}

/** True when the convex polygon `quad` (screen px) shares area with the rectangle (separating-axis test). */
export function quadHitsRect(quad: readonly Pt2[], r: ScreenRect, pad = 0): boolean {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  if (Math.max(...xs) < r.l - pad || Math.min(...xs) > r.r + pad) return false;
  if (Math.max(...ys) < r.t - pad || Math.min(...ys) > r.b + pad) return false;
  const rc: Pt2[] = [
    [r.l - pad, r.t - pad],
    [r.r + pad, r.t - pad],
    [r.r + pad, r.b + pad],
    [r.l - pad, r.b + pad],
  ];
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i] as Pt2;
    const b = quad[(i + 1) % quad.length] as Pt2;
    const nx = a[1] - b[1];
    const ny = b[0] - a[0];
    let qMin = Number.POSITIVE_INFINITY;
    let qMax = Number.NEGATIVE_INFINITY;
    for (const p of quad) {
      const v = p[0] * nx + p[1] * ny;
      qMin = Math.min(qMin, v);
      qMax = Math.max(qMax, v);
    }
    let rMin = Number.POSITIVE_INFINITY;
    let rMax = Number.NEGATIVE_INFINITY;
    for (const p of rc) {
      const v = p[0] * nx + p[1] * ny;
      rMin = Math.min(rMin, v);
      rMax = Math.max(rMax, v);
    }
    if (qMax < rMin || rMax < qMin) return false;
  }
  return true;
}

export interface FlagAnchor {
  id: string;
  /** Where the pole stands (the building's roof), screen px. */
  x: number;
  y: number;
}

export interface PlacedFlag {
  id: string;
  /** Disc centre. */
  x: number;
  y: number;
  /** Pole foot. */
  ax: number;
  ay: number;
}

/**
 * Numbered flag discs above their buildings: each disc wants to sit `POLE_PX` straight above its roof; discs never
 * overlap (they are nudged apart in rank order, none is dropped) and stay inside the canvas.
 */
export function placeFlags(
  anchors: readonly FlagAnchor[],
  size: { w: number; h: number },
  avoid: readonly ScreenRect[] = [],
): PlacedFlag[] {
  const blocked = (x: number, y: number): boolean =>
    x < FLAG_R + 2 ||
    y < FLAG_R + 2 ||
    x > size.w - FLAG_R - 2 ||
    y > size.h - FLAG_R - 2 ||
    avoid.some((a) => rectsOverlap(a, { l: x - FLAG_R, t: y - FLAG_R, r: x + FLAG_R, b: y + FLAG_R }));
  const placed = decollideMarkers(
    anchors.map((a) => ({ id: a.id, x: a.x, y: a.y - POLE_PX })),
    FLAG_R,
    3,
    blocked,
  );
  return placed.map((p, i) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    ax: (anchors[i] as FlagAnchor).x,
    ay: (anchors[i] as FlagAnchor).y,
  }));
}

/** Convex hull (monotone chain) of screen points. */
export function convexHull(points: readonly Pt2[]): Pt2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt2, a: Pt2, b: Pt2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt2, lower[lower.length - 1] as Pt2, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt2[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt2, upper[upper.length - 1] as Pt2, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** True when all four corners of `r` lie inside the convex polygon (either winding). */
export function rectInsideHull(hull: readonly Pt2[], r: ScreenRect): boolean {
  if (hull.length < 3) return false;
  const corners: Pt2[] = [
    [r.l, r.t],
    [r.r, r.t],
    [r.r, r.b],
    [r.l, r.b],
  ];
  return corners.every((p) => {
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i] as Pt2;
      const b = hull[(i + 1) % hull.length] as Pt2;
      const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (c > 0) pos++;
      else if (c < 0) neg++;
    }
    return pos === 0 || neg === 0;
  });
}

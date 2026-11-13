// Shortest paths around boxes (a visibility graph over the boxes' corners). Used for the links the layered
// placement does not route itself: declared-only workspace dependencies.
export type Pt = [number, number];

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** True when the segment p-q passes through the interior of the box (Liang-Barsky). */
export function segmentHitsBox(p: Pt, q: Pt, b: Box): boolean {
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
 * Shortest path from `start` to `end` that stays out of `boxes`. Returns the straight segment when nothing is in
 * the way. A small per-bend penalty prefers fewer turns over marginally shorter paths.
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

// Polylines on the ground: arc-length sampling, offsets to one side, smoothing. Pure.
export type Pt = [number, number];

export interface Path {
  pts: Pt[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
  closed: boolean;
}

export function makePath(pts: readonly Pt[], closed = false): Path {
  const p = pts.map((q) => [q[0], q[1]] as Pt);
  const cum = [0];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1] as Pt;
    const b = p[i] as Pt;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts: p, cum, length: cum[cum.length - 1] ?? 0, closed };
}

export interface Sample {
  x: number;
  z: number;
  /** Unit direction of travel. */
  dx: number;
  dz: number;
}

/** Point at arc length `s` (wrapped into [0, length)), moved `offset` to the right of the direction of travel. */
export function sampleAt(path: Path, s: number, offset = 0): Sample {
  const L = path.length;
  const n = path.pts.length;
  if (n === 0) return { x: 0, z: 0, dx: 1, dz: 0 };
  if (n === 1 || L <= 0) {
    const p = path.pts[0] as Pt;
    return { x: p[0], z: p[1], dx: 1, dz: 0 };
  }
  // Wraps: a vehicle that reaches the end starts again at the beginning.
  const d = s === L ? L : ((s % L) + L) % L;
  // Binary search for the segment.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((path.cum[mid] as number) <= d) lo = mid;
    else hi = mid;
  }
  const a = path.pts[lo] as Pt;
  const b = path.pts[hi] as Pt;
  const span = (path.cum[hi] as number) - (path.cum[lo] as number);
  const t = span > 0 ? (d - (path.cum[lo] as number)) / span : 0;
  let dx = b[0] - a[0];
  let dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  // Right of travel in a Y-up world seen from above with +X right, +Z towards the viewer: (-dz, dx).
  const x = a[0] + (b[0] - a[0]) * t - dz * offset;
  const z = a[1] + (b[1] - a[1]) * t + dx * offset;
  return { x, z, dx, dz };
}

/** Chaikin corner cutting, keeping the end points. */
export function smooth(pts: readonly Pt[], rounds = 2): Pt[] {
  let p = pts.map((q) => [q[0], q[1]] as Pt);
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out: Pt[] = [p[0] as Pt];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i] as Pt;
      const b = p[i + 1] as Pt;
      const first = i === 0;
      const last = i === p.length - 2;
      if (!first) out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      if (!last) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(p[p.length - 1] as Pt);
    p = out;
  }
  return p;
}

/** Evenly spaced points along a polyline (spacing about `step`), ends included. */
export function resample(pts: readonly Pt[], step: number): Pt[] {
  const path = makePath(pts);
  const n = Math.max(1, Math.ceil(path.length / step));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const s = sampleAt(path, (path.length * i) / n);
    out.push([s.x, s.z]);
  }
  // The end point itself (sampling at the full length could round past it and wrap to the start).
  const last = pts[pts.length - 1];
  if (last) out.push([last[0], last[1]]);
  return out;
}

/** Distance from point p to segment ab, and the closest point. */
export function segPoint(p: Pt, a: Pt, b: Pt): { d: number; q: Pt; t: number } {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  const q: Pt = [a[0] + dx * t, a[1] + dz * t];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q, t };
}

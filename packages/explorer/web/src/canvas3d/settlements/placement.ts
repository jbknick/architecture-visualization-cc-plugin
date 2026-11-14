// Where the settlements stand on the land. Pure and deterministic: start on a golden-angle spiral (biggest in the
// middle, the angle offset seeded by the ids), then relax: settlements that import from each other pull together,
// all of them keep a clear margin for the roads between them, and a weak pull keeps the land compact.
import { hash01 } from "./rng.ts";

export interface PlaceInput {
  id: string;
  radius: number;
}

export interface PlaceLink {
  a: string;
  b: string;
  weight: number;
}

export interface Placed {
  id: string;
  x: number;
  z: number;
  radius: number;
}

/** Clear land kept between two settlement plates (room for a highway and its verges). */
export function marginFor(ra: number, rb: number): number {
  return 9 + 0.3 * Math.min(ra, rb) + 0.12 * Math.max(ra, rb);
}

export function placeSettlements(items: readonly PlaceInput[], links: readonly PlaceLink[]): Placed[] {
  const order = [...items].sort((a, b) => b.radius - a.radius || (a.id < b.id ? -1 : 1));
  const n = order.length;
  if (n === 0) return [];
  const idx = new Map(order.map((s, i) => [s.id, i]));
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const rs = order.map((s) => s.radius);
  const seed = hash01(order.map((s) => s.id).join("|")) * Math.PI * 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  // Spiral start: each ring of the spiral far enough out for the plates already placed.
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) continue;
    acc += rs[i] as number;
    const d = (rs[0] as number) + marginFor(rs[0] as number, rs[i] as number) + Math.sqrt(i) * acc * 0.5;
    const ang = seed + i * golden;
    xs[i] = Math.cos(ang) * d;
    zs[i] = Math.sin(ang) * d;
  }
  const maxW = Math.max(1, ...links.map((l) => l.weight));
  const ls = links
    .map((l) => ({ i: idx.get(l.a), j: idx.get(l.b), w: Math.log1p(l.weight) / Math.log1p(maxW) }))
    .filter(
      (l): l is { i: number; j: number; w: number } => l.i !== undefined && l.j !== undefined && l.i !== l.j,
    );
  const iters = 600;
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    const fx = new Float64Array(n);
    const fz = new Float64Array(n);
    // Imports pull the two plates towards touching distance (plus the margin).
    for (const l of ls) {
      const dx = (xs[l.j] as number) - (xs[l.i] as number);
      const dz = (zs[l.j] as number) - (zs[l.i] as number);
      const d = Math.hypot(dx, dz) || 1e-6;
      const ri = rs[l.i] as number;
      const rj = rs[l.j] as number;
      const want = ri + rj + marginFor(ri, rj) * 1.25;
      const f = (d - want) * 0.02 * (0.3 + l.w);
      fx[l.i] = (fx[l.i] as number) + (dx / d) * f;
      fz[l.i] = (fz[l.i] as number) + (dz / d) * f;
      fx[l.j] = (fx[l.j] as number) - (dx / d) * f;
      fz[l.j] = (fz[l.j] as number) - (dz / d) * f;
    }
    // Gravity to the centre, stronger for big plates: the big settlements gather in the middle and the villages sit
    // round the edge of the land rather than in the gaps between the cities (where their labels would crowd).
    for (let i = 0; i < n; i++) {
      const g = 0.0015 + 0.006 * ((rs[i] as number) / (rs[0] as number));
      fx[i] = (fx[i] as number) - (xs[i] as number) * g;
      fz[i] = (fz[i] as number) - (zs[i] as number) * g;
    }
    for (let i = 0; i < n; i++) {
      // Lighter (smaller) plates move more.
      const m = 1 / Math.sqrt(Math.max(1, rs[i] as number));
      xs[i] = (xs[i] as number) + (fx[i] as number) * m * (0.4 + cool);
      zs[i] = (zs[i] as number) + (fz[i] as number) * m * (0.4 + cool);
    }
    // Hard separation, a few passes.
    for (let pass = 0; pass < 3; pass++)
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const dx = (xs[j] as number) - (xs[i] as number);
          const dz = (zs[j] as number) - (zs[i] as number);
          let d = Math.hypot(dx, dz);
          const ri = rs[i] as number;
          const rj = rs[j] as number;
          const min = ri + rj + marginFor(ri, rj);
          if (d >= min) continue;
          let ux = dx;
          let uz = dz;
          if (d < 1e-6) {
            const ang = seed + (i * 7 + j * 13) * golden;
            ux = Math.cos(ang);
            uz = Math.sin(ang);
            d = 1;
          } else {
            ux /= d;
            uz /= d;
            d = Math.hypot(dx, dz);
          }
          const push = min - d;
          // Split the push by size: the bigger plate moves less.
          const si = rj / (ri + rj);
          xs[i] = (xs[i] as number) - ux * push * si;
          zs[i] = (zs[i] as number) - uz * push * si;
          xs[j] = (xs[j] as number) + ux * push * (1 - si);
          zs[j] = (zs[j] as number) + uz * push * (1 - si);
        }
  }
  // Centre the land on the origin.
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i] as number;
    cz += zs[i] as number;
  }
  cx /= n;
  cz /= n;
  return order.map((s, i) => ({
    id: s.id,
    x: (xs[i] as number) - cx,
    z: (zs[i] as number) - cz,
    radius: s.radius,
  }));
}

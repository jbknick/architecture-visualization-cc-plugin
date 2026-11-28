// The ground plan inside one settlement. Pure and deterministic (seeded by the settlement's id).
//
// A settlement is round: a plaza in the middle, then rings of lots. Each district (folder) owns a wedge, so its files
// stay together, and radial streets run along the wedge borders. The biggest files take the inner rings, so a
// metropolis gets its skyscraper core and its suburbs on the outside. Rows alternate facing the ring road inside and
// outside them; a ring road runs between every second row and around the whole settlement. A village is the same
// plan loosened: wide gaps, jittered lots, one lane round it and fields outside.
import { rngFor } from "./rng.ts";
import type { Tier } from "./tiers.ts";

export interface LotInput {
  id: string;
  district: string;
  /** Footprint side (world units). */
  side: number;
}

export interface Lot {
  id: string;
  district: string;
  x: number;
  z: number;
  /** Rotation about Y: the building's local +Z points away from the plaza. */
  rot: number;
  side: number;
  ring: number;
}

export type Pt = [number, number];

export interface Street {
  kind: "ring" | "radial" | "lane";
  /** Polyline in settlement coordinates; a ring is closed (last point equals the first). */
  pts: Pt[];
  width: number;
}

export interface DistrictArea {
  id: string;
  a0: number;
  a1: number;
  r0: number;
  r1: number;
  lots: number;
}

export interface Field {
  a0: number;
  a1: number;
  r0: number;
  r1: number;
  hue: number;
}

export interface Plan {
  tier: Tier;
  plaza: number;
  /** Outer radius of the built area (the outer ring road runs just outside it). */
  built: number;
  /** Radius of the whole settlement plate (fields and trees included). */
  radius: number;
  lots: Lot[];
  streets: Street[];
  districts: DistrictArea[];
  fields: Field[];
  /** Spots for trees (settlement coordinates). */
  trees: Pt[];
}

interface TierParams {
  street: number;
  gap: number;
  plaza: number;
  jitter: number;
  /** Extra radial streets in a settlement with a single district. */
  spokes: number;
}

export const PLAN_PARAMS: Record<Tier, TierParams> = {
  village: { street: 0.55, gap: 1.1, plaza: 1.8, jitter: 0.45, spokes: 2 },
  town: { street: 0.75, gap: 0.22, plaza: 2.6, jitter: 0.06, spokes: 3 },
  city: { street: 1.0, gap: 0.35, plaza: 3.0, jitter: 0, spokes: 4 },
  metropolis: { street: 1.2, gap: 0.4, plaza: 3.2, jitter: 0, spokes: 6 },
};

const TAU = Math.PI * 2;

function circle(r: number, a0 = 0, a1 = TAU): Pt[] {
  const n = Math.max(12, Math.ceil(((a1 - a0) * Math.max(r, 1)) / 1.2));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/** Plans one settlement. `seed` is its id; the result depends only on the inputs. */
export function planSettlement(input: readonly LotInput[], tier: Tier, seed: string): Plan {
  const P = PLAN_PARAMS[tier];
  const rnd = rngFor(`plan:${seed}`);
  const byDistrict = new Map<string, LotInput[]>();
  for (const l of input) byDistrict.set(l.district, [...(byDistrict.get(l.district) ?? []), l]);
  for (const list of byDistrict.values())
    list.sort((a, b) => b.side - a.side || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const area = (list: LotInput[]) => list.reduce((s, l) => s + (l.side + P.gap) ** 2, 0);
  const dists = [...byDistrict.entries()]
    .map(([id, list]) => ({ id, list, area: area(list), max: list[0]?.side ?? 1 }))
    .sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1));

  // Wedges: share of the circle by area, at least wide enough for the district's biggest lot on the first ring.
  const D = dists.length;
  const total = dists.reduce((s, d) => s + d.area, 0) || 1;
  const streetW = D > 1 ? P.street : 0;
  let plaza = P.plaza;
  const minArc = (d: (typeof dists)[number]) => d.max + P.gap + streetW + 0.2;
  const sumMin = dists.reduce((s, d) => s + minArc(d), 0);
  const maxSide = Math.max(1, ...dists.map((d) => d.max));
  // The first row's center must leave every wedge its minimum arc.
  plaza = Math.max(plaza, sumMin / TAU - P.street - maxSide / 2);
  const r1 = plaza + P.street + maxSide / 2;
  let angles = dists.map((d) => Math.max(minArc(d) / r1, (TAU * d.area) / total));
  const over = angles.reduce((s, a) => s + a, 0) / TAU;
  angles = angles.map((a) => a / over);
  const start = rnd() * TAU;
  const wedges: { a0: number; a1: number }[] = [];
  let a = start;
  for (const w of angles) {
    wedges.push({ a0: a, a1: a + w });
    a += w;
  }

  const lots: Lot[] = [];
  const queues = dists.map((d) => [...d.list]);
  const rings: number[] = []; // inner radius of each ring road (between rows)
  const reach = dists.map(() => ({ r0: Number.POSITIVE_INFINITY, r1: 0 }));
  let r = plaza + P.street; // inner edge of the current row
  let row = 0;
  rings.push(plaza + P.street / 2);
  let guard = 0;
  while (queues.some((q) => q.length > 0) && guard++ < 400) {
    // Row depth: the biggest lot that will stand in it.
    const depth = Math.max(...queues.map((q) => q[0]?.side ?? 0));
    const facesIn = row % 2 === 0;
    for (let k = 0; k < D; k++) {
      const q = queues[k] as LotInput[];
      const w = wedges[k] as { a0: number; a1: number };
      if (q.length === 0) continue;
      const rc = r + depth / 2;
      const pad = (streetW / 2 + 0.15) / rc;
      let cur = w.a0 + pad;
      const end = w.a1 - pad;
      while (q.length > 0) {
        const l = q[0] as LotInput;
        const span = (l.side + P.gap) / rc;
        if (cur + span > end + 1e-9) break;
        q.shift();
        const ang = cur + span / 2 + (P.jitter > 0 ? (rnd() - 0.5) * P.jitter * (P.gap / rc) : 0);
        const radial = facesIn ? r + l.side / 2 : r + depth - l.side / 2;
        const jr = P.jitter > 0 ? (rnd() - 0.5) * P.jitter * Math.max(0, depth - l.side + P.gap) : 0;
        const rr = radial + jr;
        lots.push({
          id: l.id,
          district: l.district,
          x: Math.cos(ang) * rr,
          z: Math.sin(ang) * rr,
          rot: Math.PI / 2 - ang + (facesIn ? Math.PI : 0) + (P.jitter > 0 ? (rnd() - 0.5) * P.jitter : 0),
          side: l.side,
          ring: row,
        });
        const rk = reach[k] as { r0: number; r1: number };
        rk.r0 = Math.min(rk.r0, r);
        rk.r1 = Math.max(rk.r1, r + depth);
        cur += span;
      }
    }
    r += depth;
    // A ring road after every row in a village, every second row in a town, every fourth in a city (two pairs of
    // back-to-back rows with a narrow yard between the pairs).
    const every = tier === "village" ? 1 : tier === "town" ? 2 : 4;
    const more = queues.some((q) => q.length > 0);
    if (row % every === every - 1 && more) {
      rings.push(r + P.street / 2);
      r += P.street;
    } else r += facesIn ? P.gap * 0.6 : P.gap * 1.6;
    row++;
  }
  const built = r;

  const streets: Street[] = [];
  if (tier === "village") {
    streets.push({ kind: "lane", pts: circle(plaza + P.street / 2), width: P.street });
    streets.push({ kind: "lane", pts: circle(built + P.street * 0.2), width: P.street });
  } else {
    for (const rr of rings) streets.push({ kind: "ring", pts: circle(rr), width: P.street });
    // The ring road around the whole settlement (roads from other settlements join it).
    if (Math.abs((rings[rings.length - 1] ?? 0) - (built - P.street / 2)) > 0.01)
      streets.push({ kind: "ring", pts: circle(built + P.street / 2), width: P.street });
  }
  const radialAt: number[] = D > 1 ? wedges.map((w) => w.a0) : [];
  if (D <= 1) for (let s = 0; s < P.spokes; s++) radialAt.push(start + (TAU * s) / P.spokes);
  for (const ang of radialAt) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const r0 = plaza;
    const rEnd = built + P.street / 2;
    streets.push({
      kind: tier === "village" ? "lane" : "radial",
      pts: [
        [c * r0, s * r0],
        [c * rEnd, s * rEnd],
      ],
      width: P.street,
    });
  }

  // Fields round a village; a walled town (the wall is drawn on the rim); trees on the plate's rim.
  const fields: Field[] = [];
  const trees: Pt[] = [];
  let radius = built + P.street;
  if (tier === "town") radius += 1.6;
  if (tier === "village") {
    const depth = Math.max(2.4, built * 0.55);
    const n = 7;
    let fa = start + 0.3;
    for (let i = 0; i < n; i++) {
      const w = (TAU / n) * (0.55 + rnd() * 0.35);
      fields.push({
        a0: fa,
        a1: fa + w,
        r0: radius + 0.3,
        r1: radius + 0.3 + depth * (0.7 + rnd() * 0.3),
        hue: rnd(),
      });
      fa += TAU / n;
    }
    radius += depth + 0.6;
  }
  const treeCount = Math.round(
    tier === "village"
      ? 26 + built * 3
      : tier === "town"
        ? 18 + built * 2
        : tier === "city"
          ? built * 1.2
          : built * 0.8,
  );
  for (let i = 0; i < treeCount; i++) {
    const ang = rnd() * TAU;
    const rr =
      tier === "town"
        ? radius - 1.25 - rnd() * 0.35
        : radius - 0.4 - rnd() * (tier === "village" ? 0.8 : 1.2);
    trees.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
  }
  if (tier !== "metropolis") {
    // A few trees on the plaza.
    const n = tier === "village" ? 3 : 5;
    for (let i = 0; i < n; i++) {
      const ang = start + (TAU * i) / n + 0.4;
      const rr = plaza * 0.62;
      trees.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
    }
  }

  const districts: DistrictArea[] = dists.map((d, k) => {
    const w = wedges[k] as { a0: number; a1: number };
    const rk = reach[k] as { r0: number; r1: number };
    return {
      id: d.id,
      a0: w.a0,
      a1: w.a1,
      r0: Number.isFinite(rk.r0) ? rk.r0 : plaza,
      r1: rk.r1 || plaza,
      lots: d.list.length,
    };
  });
  return {
    tier,
    plaza,
    built,
    radius: Math.max(radius, built + P.street),
    lots,
    streets,
    districts,
    fields,
    trees,
  };
}

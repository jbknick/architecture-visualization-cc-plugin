// Roads between settlements: one road per pair of workspaces with imports, on the ground, routed round the other
// settlements. Its class follows the pair's import count (lane, road, highway); each direction of traffic is a
// "flow" from the importer to the imported workspace with that direction's own count. Pure and deterministic.
import { type Pt, resample, segPoint, smooth } from "./path.ts";

export type RoadClass = "lane" | "road" | "highway";

export interface RoadSite {
  id: string;
  x: number;
  z: number;
  /** Where roads join the settlement (its outer ring road). */
  gate: number;
  /** The plate: other roads keep out of this radius. */
  clear: number;
}

export interface RoadLink {
  /** Importer. */
  src: string;
  /** Imported. */
  dst: string;
  weight: number;
  declaredOnly?: boolean;
}

export interface Flow {
  from: string;
  to: string;
  weight: number;
  /** True when the flow runs along `pts` as given (from `a` to `b`). */
  forward: boolean;
}

export interface Road {
  key: string;
  a: string;
  b: string;
  cls: RoadClass;
  /** Sum of both directions. */
  weight: number;
  flows: Flow[];
  declaredOnly: boolean;
  /** Center line from a's gate to b's gate. */
  pts: Pt[];
  length: number;
  width: number;
}

export const ROAD_WIDTH: Record<RoadClass, number> = { lane: 0.8, road: 1.5, highway: 4.2 };
/** Distance from the center line to the middle of each travel lane, per direction (right-hand traffic). */
export const LANE_OFFSETS: Record<RoadClass, number[]> = { lane: [0.2], road: [0.38], highway: [1.15, 1.75] };

/** Class by the pair's import count: a highway for the heavy links, a lane for a handful of imports. */
export function classify(weight: number, maxWeight: number): RoadClass {
  if (weight >= Math.max(40, 0.3 * maxWeight)) return "highway";
  if (weight >= Math.max(8, 0.03 * maxWeight)) return "road";
  return "lane";
}

const KEEP_OUT = 1.6;

/** Moves a polyline round every site disc it cuts (except the ones it starts and ends at). */
export function routeAround(pts: Pt[], sites: readonly RoadSite[], skip: ReadonlySet<string>): Pt[] {
  let path = [...pts];
  for (let iter = 0; iter < 120; iter++) {
    let worst: { seg: number; site: RoadSite; d: number; q: Pt } | null = null;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i] as Pt;
      const b = path[i + 1] as Pt;
      for (const s of sites) {
        if (skip.has(s.id)) continue;
        const { d, q } = segPoint([s.x, s.z], a, b);
        const need = s.clear + KEEP_OUT;
        if (d < need - 1e-6 && (!worst || need - d > worst.site.clear + KEEP_OUT - worst.d))
          worst = { seg: i, site: s, d, q };
      }
    }
    if (!worst) break;
    const { site, q, seg } = worst;
    let ux = q[0] - site.x;
    let uz = q[1] - site.z;
    let l = Math.hypot(ux, uz);
    if (l < 1e-6) {
      const a = path[seg] as Pt;
      const b = path[seg + 1] as Pt;
      ux = -(b[1] - a[1]);
      uz = b[0] - a[0];
      l = Math.hypot(ux, uz) || 1;
    }
    const r = site.clear + KEEP_OUT * 1.6;
    path.splice(seg + 1, 0, [site.x + (ux / l) * r, site.z + (uz / l) * r]);
    // Two waypoints either side as well, so the detour hugs the disc instead of cutting a corner through it.
    const a = path[seg] as Pt;
    const c = path[seg + 2] as Pt;
    const mid = path[seg + 1] as Pt;
    const side = (p: Pt): Pt => {
      const vx = p[0] - site.x;
      const vz = p[1] - site.z;
      const vl = Math.hypot(vx, vz) || 1;
      return vl < r ? [site.x + (vx / vl) * r, site.z + (vz / vl) * r] : p;
    };
    const m1 = side([(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2]);
    const m2 = side([(mid[0] + c[0]) / 2, (mid[1] + c[1]) / 2]);
    path.splice(seg + 2, 0, m2);
    path.splice(seg + 1, 0, m1);
    path = path.filter(
      (p, i) => i === 0 || Math.hypot(p[0] - (path[i - 1] as Pt)[0], p[1] - (path[i - 1] as Pt)[1]) > 1e-6,
    );
  }
  return path;
}

/** Gate angles per settlement: each road leaves towards its partner, spread so neighbors do not overlap. */
function gateAngles(
  site: RoadSite,
  wants: { key: string; ang: number; width: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const list = [...wants].sort((p, q) => p.ang - q.ang || (p.key < q.key ? -1 : 1));
  const n = list.length;
  if (n === 0) return out;
  const angs = list.map((w) => w.ang);
  const sep = list.map((w) => (w.width + 1.2) / Math.max(site.gate, 1));
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (n === 1) break;
      let gap = (angs[j] as number) - (angs[i] as number);
      if (j === 0) gap += Math.PI * 2;
      const need = ((sep[i] as number) + (sep[j] as number)) / 2;
      if (gap < need) {
        const push = (need - gap) / 2;
        angs[i] = (angs[i] as number) - push;
        angs[j] = (angs[j] as number) + push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  list.forEach((w, i) => {
    out.set(w.key, angs[i] as number);
  });
  return out;
}

export function buildRoads(
  sites: readonly RoadSite[],
  links: readonly RoadLink[],
  opts: { showDeclared?: boolean } = {},
): Road[] {
  const byId = new Map(sites.map((s) => [s.id, s]));
  type Pair = { a: string; b: string; flows: Flow[]; declaredOnly: boolean };
  const pairs = new Map<string, Pair>();
  for (const l of links) {
    if (l.src === l.dst || !byId.has(l.src) || !byId.has(l.dst)) continue;
    if (l.declaredOnly && !opts.showDeclared) continue;
    const [a, b] = l.src < l.dst ? [l.src, l.dst] : [l.dst, l.src];
    const key = `${a}~${b}`;
    const p = pairs.get(key) ?? { a, b, flows: [], declaredOnly: true };
    if (!l.declaredOnly) {
      p.declaredOnly = false;
      p.flows.push({ from: l.src, to: l.dst, weight: l.weight, forward: l.src === a });
    }
    pairs.set(key, p);
  }
  const list = [...pairs.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1));
  const weightOf = (p: Pair) => p.flows.reduce((s, f) => s + f.weight, 0);
  const maxW = Math.max(1, ...list.map(([, p]) => weightOf(p)));
  const clsOf = (p: Pair): RoadClass => (p.declaredOnly ? "lane" : classify(weightOf(p), maxW));

  // Gates: each site spreads the roads that leave it.
  const wants = new Map<string, { key: string; ang: number; width: number }[]>();
  for (const [key, p] of list) {
    const A = byId.get(p.a) as RoadSite;
    const B = byId.get(p.b) as RoadSite;
    const w = ROAD_WIDTH[clsOf(p)];
    wants.set(p.a, [...(wants.get(p.a) ?? []), { key, ang: Math.atan2(B.z - A.z, B.x - A.x), width: w }]);
    wants.set(p.b, [...(wants.get(p.b) ?? []), { key, ang: Math.atan2(A.z - B.z, A.x - B.x), width: w }]);
  }
  const gates = new Map<string, Map<string, number>>();
  for (const s of sites) gates.set(s.id, gateAngles(s, wants.get(s.id) ?? []));

  const roads: Road[] = [];
  for (const [key, p] of list) {
    const A = byId.get(p.a) as RoadSite;
    const B = byId.get(p.b) as RoadSite;
    const ga = gates.get(p.a)?.get(key) ?? 0;
    const gb = gates.get(p.b)?.get(key) ?? 0;
    const at = (s: RoadSite, ang: number, r: number): Pt => [
      s.x + Math.cos(ang) * r,
      s.z + Math.sin(ang) * r,
    ];
    const exitA = at(A, ga, A.clear + KEEP_OUT);
    const exitB = at(B, gb, B.clear + KEEP_OUT);
    const middle = routeAround([exitA, exitB], sites, new Set());
    const raw: Pt[] = [
      at(A, ga, A.gate),
      at(A, ga, (A.gate + A.clear) / 2),
      ...middle,
      at(B, gb, (B.gate + B.clear) / 2),
      at(B, gb, B.gate),
    ];
    const pts = resample(smooth(raw, 3), 0.9);
    let length = 0;
    for (let i = 1; i < pts.length; i++)
      length += Math.hypot(
        (pts[i] as Pt)[0] - (pts[i - 1] as Pt)[0],
        (pts[i] as Pt)[1] - (pts[i - 1] as Pt)[1],
      );
    const cls = clsOf(p);
    roads.push({
      key,
      a: p.a,
      b: p.b,
      cls,
      weight: weightOf(p),
      flows: p.flows.sort((f, g) => (f.from < g.from ? -1 : 1)),
      declaredOnly: p.declaredOnly,
      pts,
      length,
      width: ROAD_WIDTH[cls],
    });
  }
  return roads.sort((p, q) => q.weight - p.weight || (p.key < q.key ? -1 : 1));
}

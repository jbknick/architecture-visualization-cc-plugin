// Vehicles on the roads between settlements. Each flow (importer -> imported) carries vehicles in its own lane(s),
// driving on the right, from the importer towards the imported settlement. Density is proportional to the flow's
// import count (the heaviest flow fills its lanes to `MAX_DENSITY`), with at least one vehicle per flow. Pure: a
// vehicle's place is a function of time, so a paused or reduced-motion scene is just a fixed time.
import { makePath, type Path, type Sample, sampleAt } from "./path.ts";
import { hash01 } from "./rng.ts";
import { LANE_OFFSETS, type Road, type RoadClass } from "./roads.ts";

/** Vehicles per world unit of one lane at the heaviest flow. */
export const MAX_DENSITY = 0.42;
export const SPEED: Record<RoadClass, number> = { lane: 1.6, road: 2.6, highway: 4.2 };

export type VehicleKind = "car" | "van" | "truck";

export interface Vehicle {
  road: number;
  /** Index into the road's flows. */
  flow: number;
  path: Path;
  offset: number;
  /** Arc length at time 0. */
  phase: number;
  speed: number;
  kind: VehicleKind;
  /** 0..1 for the paint colour. */
  paint: number;
}

/** How many vehicles a flow gets on one lane of `length`. */
export function vehicleCount(weight: number, maxWeight: number, length: number, lanes: number): number {
  const density = MAX_DENSITY * Math.min(1, weight / Math.max(1, maxWeight));
  return Math.max(1, Math.round(density * length * lanes));
}

export function planTraffic(roads: readonly Road[]): Vehicle[] {
  const maxFlow = Math.max(1, ...roads.flatMap((r) => r.flows.map((f) => f.weight)));
  const out: Vehicle[] = [];
  roads.forEach((road, ri) => {
    if (road.declaredOnly) return;
    const fwd = makePath(road.pts);
    const back = makePath([...road.pts].reverse());
    road.flows.forEach((f, fi) => {
      const lanes = LANE_OFFSETS[road.cls];
      const n = vehicleCount(f.weight, maxFlow, road.length, lanes.length);
      const path = f.forward ? fwd : back;
      for (let k = 0; k < n; k++) {
        const key = `${road.key}|${f.from}|${k}`;
        const h = hash01(key);
        const lane = lanes[k % lanes.length] as number;
        const kind: VehicleKind =
          road.cls === "highway" && h < 0.22 ? "truck" : road.cls !== "lane" && h > 0.82 ? "van" : "car";
        out.push({
          road: ri,
          flow: fi,
          path,
          offset: lane,
          // Even spacing with a little seeded jitter, so they do not drive in lockstep.
          phase: ((k + 0.35 * hash01(`${key}:p`)) / n) * path.length,
          // The fast lane (outer offset on a highway) is a little faster.
          speed: SPEED[road.cls] * (0.85 + 0.3 * hash01(`${key}:s`)) * (lane > 1.5 ? 1.12 : 1),
          kind,
          paint: hash01(`${key}:c`),
        });
      }
    });
  });
  return out;
}

/** Where a vehicle is at time `t` (seconds). */
export function vehicleAt(v: Vehicle, t: number): Sample {
  return sampleAt(v.path, v.phase + v.speed * t, v.offset);
}

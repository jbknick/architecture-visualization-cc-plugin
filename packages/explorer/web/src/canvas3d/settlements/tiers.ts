// Settlement tiers: every workspace is a village, town, city or metropolis according to its function count.
// The tier is the smaller of two grades: its rank among the repo's workspaces (so any repo shows a spread) and a
// fixed floor on its own size (so a tiny workspace is always a village, however it ranks). A big workspace is never
// demoted below what its own size earns (two equal giants are both metropolises).

export const TIERS = ["village", "town", "city", "metropolis"] as const;
export type Tier = (typeof TIERS)[number];

/** Least functions a workspace needs to be at least this tier, whatever its rank. 0 = village. */
export const TIER_FLOOR: Record<Tier, number> = { village: 0, town: 20, city: 150, metropolis: 600 };
/** A workspace this big is that tier even when others rank above it. */
export const TIER_EARNED: Record<Tier, number> = { village: 0, town: 150, city: 800, metropolis: 2500 };
/** Rank share (0 = smallest, 1 = biggest) from which the rank grade reaches the tier. */
export const TIER_RANK: Record<Tier, number> = { village: 0, town: 0.4, city: 0.7, metropolis: 0.95 };

const index = (t: Tier): number => TIERS.indexOf(t);

function gradeBy(table: Record<Tier, number>, v: number): number {
  let g = 0;
  for (let i = 0; i < TIERS.length; i++) if (v >= table[TIERS[i] as Tier]) g = i;
  return g;
}

/**
 * Tier per workspace id. `functions` maps an id to its function count. Ranks count the workspaces with strictly
 * fewer functions, so equal workspaces share a rank; a single workspace ranks as the biggest.
 */
export function assignTiers(functions: ReadonlyMap<string, number>): Map<string, Tier> {
  const values = [...functions.values()];
  const n = values.length;
  const out = new Map<string, Tier>();
  for (const [id, fns] of functions) {
    const below = values.filter((v) => v < fns).length;
    const rank = n <= 1 ? 1 : below / (n - 1);
    const byRank = gradeBy(TIER_RANK, rank);
    const byFloor = gradeBy(TIER_FLOOR, fns);
    const earned = gradeBy(TIER_EARNED, fns);
    out.set(id, TIERS[Math.max(Math.min(byRank, byFloor), earned)] as Tier);
  }
  return out;
}

export function tierIndex(t: Tier): number {
  return index(t);
}

export const TIER_LABEL: Record<Tier, string> = {
  village: "Village",
  town: "Town",
  city: "City",
  metropolis: "Metropolis",
};

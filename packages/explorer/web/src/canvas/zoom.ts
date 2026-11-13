// Semantic zoom: three levels chosen from the camera ratio (1 = whole graph fits).
import { TIER_DIR, TIER_FILE, TIER_SYMBOL, TIER_WORKSPACE } from "./hierarchy.ts";

export type Level = "far" | "mid" | "near";

/** Zoom factors (1 / camera ratio) at which the next level starts. */
export const MID_AT = 1.6;
export const NEAR_AT = 4.5;

export function levelForRatio(ratio: number): Level {
  const zoom = 1 / Math.max(ratio, 1e-9);
  return zoom >= NEAR_AT ? "near" : zoom >= MID_AT ? "mid" : "far";
}

/** Containers up to this tier are drawn as regions at the level. */
export function regionTier(level: Level): number {
  return level === "far" ? TIER_WORKSPACE : level === "mid" ? TIER_DIR : TIER_FILE;
}

/** Nodes up to this tier are shown at the level (containers drawn as regions are not shown as nodes). */
export function nodeTier(level: Level): number {
  return level === "far" ? TIER_WORKSPACE : level === "mid" ? TIER_FILE : TIER_SYMBOL;
}

/** Smallest label font in CSS pixels. */
export const MIN_LABEL_PX = 11;

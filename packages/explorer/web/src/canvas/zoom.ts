// Zoom bands from the camera ratio (1 = whole map fits). The treemap canvas reports the band in `data-level` and
// the status line; what is drawn depends on the size of each cell on screen, not on the band.

export type Level = "far" | "mid" | "near";

/** Zoom factors (1 / camera ratio) at which the next band starts. */
export const MID_AT = 1.6;
export const NEAR_AT = 4.5;

export function levelForRatio(ratio: number): Level {
  const zoom = 1 / Math.max(ratio, 1e-9);
  return zoom >= NEAR_AT ? "near" : zoom >= MID_AT ? "mid" : "far";
}

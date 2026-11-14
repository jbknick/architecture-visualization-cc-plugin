// "Tiny" workspaces: the few functions a workspace has next to the biggest one. The 3D city gives them a larger
// minimum footprint and a title strip (`LayoutInput.tinyBoxes`); the 2D map never does. Pure, no imports.

/** A workspace with at most this share of the biggest workspace's functions is tiny. */
export const TINY_SHARE = 0.03;
/** Smallest slab of a tiny district (layout units, roughly px at the fit zoom). */
export const TINY_MIN_W = 140;
export const TINY_MIN_H = 76;
/** Room kept free under a tiny district's slab for its title, so the title sits right next to the slab. */
export const TINY_STRIP = 22;

/** True when `fns` is tiny next to `maxFns` (never in a map with one workspace or none with functions). */
export function isTinyWorkspace(fns: number, maxFns: number): boolean {
  return maxFns > 0 && fns < maxFns && fns <= maxFns * TINY_SHARE;
}

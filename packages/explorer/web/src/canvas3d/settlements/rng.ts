// Seeded randomness for the settlements. Nothing in the landscape uses Math.random: every jitter, tree and car is
// drawn from a generator seeded by the ids it belongs to, so the same repo always gives the same landscape.
import { fnv1a } from "../layout.ts";

export { fnv1a };

/** Small fast PRNG (mulberry32): a function returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded by a string (an id, or several joined). */
export function rngFor(key: string): () => number {
  return mulberry32(fnv1a(key));
}

/** A stable float in [0, 1) for a string. */
export function hash01(key: string): number {
  return fnv1a(key) / 4294967296;
}

// Deterministic helpers. Layout code never calls Math.random: every "random" number derives from a node id.

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG returning floats in [0, 1). */
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

/** Two stable floats in [0, 1) for an id. */
export function unitPair(id: string): [number, number] {
  const rand = mulberry32(hashString(id));
  return [rand(), rand()];
}

/** Hash of a position map (rounded to 1e-3) for "same data, same picture" checks. */
export function hashPositions(positions: Record<string, readonly [number, number]>): string {
  const ids = Object.keys(positions).sort();
  let h = 0x811c9dc5;
  for (const id of ids) {
    const p = positions[id] as readonly [number, number];
    const text = `${id}:${Math.round(p[0] * 1000)}:${Math.round(p[1] * 1000)};`;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

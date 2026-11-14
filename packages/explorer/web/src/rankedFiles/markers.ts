// Rank markers (numbered circles) on the canvas must never overlap each other and none may be dropped: a marker
// that would collide is nudged to the nearest free spot. Deterministic: markers are placed in rank order.
export interface MarkerSpot {
  id: string;
  /** Where the marker wants to be (centre, px). */
  x: number;
  y: number;
}

export interface PlacedMarker extends MarkerSpot {
  /** Distance from the wanted position. */
  moved: number;
}

const ANGLES = 16;

/**
 * Centres for `spots` (in the order given, which is rank order) so that no two circles of radius `r` plus `gap`
 * overlap. Every spot gets a position. `blocked(x, y)` may veto positions (e.g. outside the canvas).
 */
export function decollideMarkers(
  spots: readonly MarkerSpot[],
  r: number,
  gap = 2,
  blocked: (x: number, y: number) => boolean = () => false,
): PlacedMarker[] {
  const out: PlacedMarker[] = [];
  const min = 2 * r + gap;
  const free = (x: number, y: number): boolean =>
    !blocked(x, y) && out.every((p) => Math.hypot(p.x - x, p.y - y) >= min - 1e-6);
  for (const s of spots) {
    let best: { x: number; y: number } | null = free(s.x, s.y) ? { x: s.x, y: s.y } : null;
    for (let ring = 1; !best && ring <= 60; ring++) {
      const d = ring * (r * 0.6);
      for (let k = 0; k < ANGLES && !best; k++) {
        const a = (k / ANGLES) * Math.PI * 2 + ring * 0.37;
        const x = s.x + Math.cos(a) * d;
        const y = s.y + Math.sin(a) * d;
        if (free(x, y)) best = { x, y };
      }
    }
    // The ring search reaches 36 radii around the spot, far more than 15 markers can fill. Should the canvas veto
    // everything nearby, the marker stays where it wanted to be rather than disappearing.
    const p = best ?? { x: s.x, y: s.y };
    out.push({ id: s.id, x: p.x, y: p.y, moved: Math.hypot(p.x - s.x, p.y - s.y) });
  }
  return out;
}

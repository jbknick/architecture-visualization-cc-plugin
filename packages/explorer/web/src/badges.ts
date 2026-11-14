// M2 badges on symbol nodes: what they mean, how to colour them and how to draw the small marks on canvases.
// The server decides which badges a node has (`GraphNode.badges`); nothing here reads descriptions or source text.

import type { Scheme } from "./theme.ts";

export type M2Badge = "dup" | "undescribed" | "misleading";

interface BadgeSpec {
  name: M2Badge;
  /** Short plain-word label for legends and chips. */
  label: string;
  /** Tooltip text. */
  help: string;
  /** Mark colours, light then dark theme. */
  colour: [string, string];
  /** Hollow ring instead of a filled disc (used for the very common "not yet described" state). */
  hollow: boolean;
}

export const M2_BADGES: readonly BadgeSpec[] = [
  {
    name: "dup",
    label: "duplicate",
    help: "Has a duplicate or near-duplicate elsewhere (open the Duplicates view)",
    colour: ["#b45309", "#fbbf24"],
    hollow: false,
  },
  {
    name: "misleading",
    label: "misleading name",
    help: "The description says the name does not fit what the function does",
    colour: ["#b91c1c", "#f87171"],
    hollow: false,
  },
  {
    name: "undescribed",
    label: "undescribed",
    help: "No description yet (run the describer to add one)",
    colour: ["#4b5563", "#cbd5e1"],
    hollow: true,
  },
];

const BY_NAME = new Map(M2_BADGES.map((b) => [b.name as string, b]));

export function m2Spec(name: string): BadgeSpec | undefined {
  return BY_NAME.get(name);
}

/** The M2 badges of a node in a fixed order (dup, misleading, undescribed); other badges are ignored. */
export function m2Of(badges: readonly string[] | undefined): BadgeSpec[] {
  if (!badges || badges.length === 0) return [];
  return M2_BADGES.filter((b) => badges.includes(b.name));
}

export function badgeColour(spec: BadgeSpec, scheme: Scheme): string {
  return spec.colour[scheme === "dark" ? 1 : 0];
}

/** Tooltip lines for a node's M2 badges, e.g. "duplicate: Has a duplicate ...". */
export function badgeTipLines(badges: readonly string[] | undefined): string[] {
  return m2Of(badges).map((b) => `${b.label}: ${b.help}`);
}

export const BADGE_MARK_R = 4;

/**
 * Draws one mark per M2 badge, right to left from (`right`, `cy`). A halo in the surface colour keeps the mark apart
 * from whatever is under it. Returns how many pixels were used.
 */
export function drawBadgeMarks(
  ctx: CanvasRenderingContext2D,
  badges: readonly string[] | undefined,
  right: number,
  cy: number,
  scheme: Scheme,
  halo: string,
): number {
  const specs = m2Of(badges);
  let x = right - BADGE_MARK_R;
  for (const spec of specs) {
    const colour = badgeColour(spec, scheme);
    ctx.beginPath();
    ctx.arc(x, cy, BADGE_MARK_R + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, cy, spec.hollow ? BADGE_MARK_R - 0.5 : BADGE_MARK_R, 0, Math.PI * 2);
    if (spec.hollow) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colour;
      ctx.stroke();
    } else {
      ctx.fillStyle = colour;
      ctx.fill();
    }
    x -= BADGE_MARK_R * 2 + 4;
  }
  return specs.length * (BADGE_MARK_R * 2 + 4);
}

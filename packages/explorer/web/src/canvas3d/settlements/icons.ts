// Tier silhouettes for the labels and the legend (24 x 14 viewBox, filled with currentColor).
import type { Tier } from "./tiers.ts";

export const TIER_PATH: Record<Tier, string> = {
  // A cottage with a gable roof and a windmill.
  village:
    "M2 14V9l3.5-3L9 9v5zM15 14l1-7h2l1 7zM17 6.5l-3-3 .7-.7 2.3 2.3 2.3-2.3.7.7-2.3 2.3 2.3 2.3-.7.7L17 7.9l-2.3 2.3-.7-.7z",
  // Houses and a church spire.
  town: "M1 14V9l3-2.5L7 9v5zM8 14V7.5L10.5 0 13 7.5V14zM14 14V10l2.5-2 2.5 2v4zM19.5 14v-3.5l2-1.6 2 1.6V14z",
  // Mid-rise blocks of a few heights.
  city: "M1 14V7h4v7zM6 14V4h5v10zM12 14V6h4v8zM17 14V2h4v12zM22 14V8h2v6z",
  // A skyscraper core with low suburbs either side.
  metropolis:
    "M0 14v-2.5l1.5-1 1.5 1V14zM4 14V5h3v9zM8 14V0h3v14zM12 14V2.5h3V14zM16 14V6h3v8zM20.5 14v-2.5l1.5-1 1.5 1V14z",
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function tierIcon(tier: Tier): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 14");
  svg.setAttribute("class", "s3-icon");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", TIER_PATH[tier]);
  p.setAttribute("fill", "currentColor");
  svg.appendChild(p);
  return svg;
}

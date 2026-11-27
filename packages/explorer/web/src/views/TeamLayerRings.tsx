// The blast radius of the picked change set as small concentric bands, in the review view's colours: the changed code
// in the middle, then the directly affected, the potentially affected and the reachable code. Each band shows one dot
// per node (at most 18, spread by the golden angle); a node reached through a hub is a hollow dot.
import { motion, useReducedMotion } from "motion/react";
import type { TeamChangeSet } from "../api.ts";
import { Swatch } from "./TeamBits.tsx";
import { countText, type Tier, tierCounts } from "./teamModel.ts";
import "./review.css";
import "./team.css";

const SIZE = 120;
const MID = SIZE / 2;
const MAX_DOTS = 18;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const SHRUNK = { opacity: 0, scale: 0.7 };
const GROWN = { opacity: 1, scale: 1 };

const BANDS: readonly { tier: Tier; radius: number; label: string; swatch: string; hint: string }[] = [
  {
    tier: "direct",
    radius: 20,
    label: "Direct",
    swatch: "rv-mark-affected",
    hint: "Uses a changed node itself (hop 1)",
  },
  { tier: "potential", radius: 36, label: "Potential", swatch: "rv-mark-potential", hint: "Hops 2 and 3" },
  {
    tier: "reachable",
    radius: 52,
    label: "Reachable",
    swatch: "team-swatch-reach",
    hint: "4 or more calls away",
  },
];

/** Dot positions on a band: `shown` points spread around the circle, offset per band so the bands do not line up. */
function spread(shown: number, radius: number, turn: number): { x: number; y: number }[] {
  return Array.from({ length: shown }, (_, k) => {
    const a = turn + k * GOLDEN;
    return { x: MID + radius * Math.cos(a), y: MID + radius * Math.sin(a) };
  });
}

export function TeamLayerRings({ set }: { set: TeamChangeSet }) {
  const calm = useReducedMotion() ?? false;
  const counts = tierCounts(set);
  const centre = Math.max(1, Math.min(counts.changed, 6));
  return (
    <div className="team-radar" data-testid="team-rings">
      <svg
        className="team-radar-svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
      >
        {BANDS.map((band, b) => {
          const inTier = set.radius.filter((r) => r.tier === band.tier);
          const shown = Math.min(counts[band.tier], MAX_DOTS);
          // Dots stand for entries in proportion, so a tier that is mostly through hubs is mostly hollow.
          const hollow =
            inTier.length === 0
              ? 0
              : Math.min(shown, Math.ceil((shown * inTier.filter((r) => r.via_hub).length) / inTier.length));
          return (
            <motion.g
              key={band.tier}
              initial={calm ? false : SHRUNK}
              animate={GROWN}
              transition={{ duration: calm ? 0 : 0.24, ease: EASE_OUT, delay: calm ? 0 : b * 0.06 }}
              style={{ transformOrigin: `${MID}px ${MID}px` }}
            >
              <circle cx={MID} cy={MID} r={band.radius} className="rv-ring" />
              {spread(shown, band.radius, b * 0.9).map((p, k) => (
                <circle
                  key={`${band.tier}-${p.x.toFixed(2)}-${p.y.toFixed(2)}`}
                  cx={p.x}
                  cy={p.y}
                  r={band.tier === "reachable" ? 2.6 : 3.6}
                  className={`team-radar-dot is-${band.tier}${k >= shown - hollow ? " is-hub" : ""}`}
                />
              ))}
            </motion.g>
          );
        })}
        {Array.from({ length: centre }, (_, k) => {
          const a = (2 * Math.PI * k) / centre;
          const r = centre > 1 ? 8 : 0;
          return (
            <circle
              key={`changed-${a.toFixed(3)}`}
              cx={MID + r * Math.cos(a)}
              cy={MID + r * Math.sin(a)}
              r={5}
              className="rv-node rv-fill-modified"
            />
          );
        })}
      </svg>
      <dl className="team-radar-key">
        <div>
          <dt>
            <Swatch tone="modified" />
            Changed
          </dt>
          <dd>{countText(counts.changed, counts.changedFloor)}</dd>
        </div>
        {BANDS.map((band) => (
          <div key={band.tier} title={`${band.hint}. A hollow dot is reached through a hub.`}>
            <dt>
              <span className={`rv-swatch ${band.swatch}`} aria-hidden="true" />
              {band.label}
            </dt>
            <dd>{countText(counts[band.tier], counts.floor[band.tier])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

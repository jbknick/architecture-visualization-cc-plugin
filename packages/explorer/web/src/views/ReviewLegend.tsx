import "./review.css";
import type { ReviewMarkKind } from "../api.ts";
import { MARK_KINDS, MARK_WORDS } from "./reviewModel.ts";

export type LegendMode = "2d" | "3d" | "rings";

/** The colours and lines of the review, drawn over the canvas's bottom-right corner (the same palette in every mode). */
export function ReviewLegend({
  mode,
  reachable = false,
  kinds = MARK_KINDS,
  lines = true as boolean | "solid",
  className,
}: {
  mode: LegendMode;
  /** Add the row for the reachable tier (hop 4 and over, or through a hub), which the Team layer shows. */
  reachable?: boolean;
  /** The change colours to list (all five by default). */
  kinds?: readonly ReviewMarkKind[];
  /** The rows for the solid and dashed lines; `solid` lists only the solid one (the Team layer has no dashed lines). */
  lines?: boolean | "solid";
  className?: string;
}) {
  return (
    <aside
      className={className ? `rv-legend ${className}` : "rv-legend"}
      aria-label="Review legend"
      data-testid="review-legend"
    >
      <ul>
        {kinds.map((k) => (
          <li key={k} title={MARK_WORDS[k].hint}>
            <span className={`rv-swatch rv-mark-${k}`} aria-hidden="true" />
            {MARK_WORDS[k].label}
          </li>
        ))}
        {mode === "rings" ? (
          <>
            <li title="Code that calls the ring inside it: darker is nearer the change">
              <span className="rv-swatch rv-caller-swatch" aria-hidden="true" />
              Caller (fainter = farther)
            </li>
            <li title="From a caller to the code it calls">
              <span className="rv-line" aria-hidden="true" />
              Caller → called
            </li>
          </>
        ) : (
          <>
            <li title="Calls, renders, imports or otherwise uses a changed symbol itself (hop 1)">
              <span className="rv-swatch rv-mark-affected" aria-hidden="true" />
              Directly affected
            </li>
            <li title="Uses a directly affected node, or one that uses it (hops 2 and 3)">
              <span className="rv-swatch rv-mark-potential" aria-hidden="true" />
              Potentially affected
            </li>
            {reachable && (
              <li title="4 or more calls away, or reached through a hub (dashed outline)">
                <span className="rv-swatch team-swatch-reach" aria-hidden="true" />
                Reachable, or through a hub
              </li>
            )}
            <li title="Code this range did not touch, in its usual place">
              <span className="rv-swatch rv-mark-faded" aria-hidden="true" />
              Untouched
            </li>
            {lines && (
              <li title="From a directly affected node to the changed code it uses">
                <span className="rv-line" aria-hidden="true" />
                {mode === "3d" ? "Solid: uses the change (file to file)" : "Solid: uses the change"}
              </li>
            )}
            {lines === true && (
              <li title="From a potentially affected node to the node one step nearer the change">
                <span className="rv-line rv-line-dashed" aria-hidden="true" />
                Dashed: one step nearer
              </li>
            )}
          </>
        )}
      </ul>
    </aside>
  );
}

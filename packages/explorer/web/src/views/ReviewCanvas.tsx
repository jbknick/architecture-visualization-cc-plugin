import "./review.css";
import { CanvasHost } from "../canvas/CanvasHost.tsx";
import { Canvas3D } from "../canvas3d/index.tsx";
import type { CanvasProps } from "../slots.ts";
import { ReviewRings } from "./ReviewRings.tsx";
import { MARK_KINDS, MARK_WORDS } from "./reviewModel.ts";

type LegendMode = "2d" | "3d" | "rings";

/** The colours and lines of the review, drawn over the canvas's bottom-right corner (the same palette in every mode). */
export function ReviewLegend({ mode }: { mode: LegendMode }) {
  return (
    <aside className="rv-legend" aria-label="Review legend" data-testid="review-legend">
      <ul>
        {MARK_KINDS.map((k) => (
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
            <li title="Code this range did not touch, in its usual place">
              <span className="rv-swatch rv-mark-faded" aria-hidden="true" />
              Untouched
            </li>
            <li title="From a directly affected node to the changed code it uses">
              <span className="rv-line" aria-hidden="true" />
              {mode === "3d" ? "Solid: uses the change (file to file)" : "Solid: uses the change"}
            </li>
            <li title="From a potentially affected node to the node one step nearer the change">
              <span className="rv-line rv-line-dashed" aria-hidden="true" />
              Dashed: one step nearer
            </li>
          </>
        )}
      </ul>
    </aside>
  );
}

/**
 * The review view's canvas (hint `review`, #167). Mode `map` (default): the project map itself, 2D (the map canvas, at
 * the level asked for) or 3D (the settlements), with the review layer on it; the map's nodes and layout are the plain
 * map's. Mode `rings`: the changed code in the centre and its callers on rings by hop.
 */
export function ReviewCanvas(props: CanvasProps) {
  const review = props.data?.review ?? null;
  if (!review) {
    return (
      <div className="empty-state" data-testid="review-canvas">
        <h2>Pick a change to review</h2>
        <p>
          Enter a range such as <code>main...HEAD</code> in the left panel, or run{" "}
          <code>gantry review main...HEAD --open</code> or <code>/gantry:review</code> in Claude Code.
        </p>
      </div>
    );
  }
  const rings = review.mode === "rings";
  const mode: LegendMode = rings ? "rings" : review.map;
  return (
    <div
      className="rv-canvas"
      data-testid="review-canvas"
      data-ready="true"
      data-mode={rings ? "rings" : "map"}
      data-map={review.map}
    >
      {rings ? (
        <ReviewRings {...props} />
      ) : review.map === "3d" ? (
        <Canvas3D {...props} layoutHint="force-3d" />
      ) : (
        <CanvasHost {...props} layoutHint="nested-elk" />
      )}
      {review.changes.length === 0 && review.files.length === 0 ? (
        <p className="rv-banner" role="status">
          This range changes no indexable TypeScript file.
        </p>
      ) : review.changes.length === 0 ? (
        <p className="rv-banner" role="status">
          The changed files hold no changed functions, types or constants.
        </p>
      ) : null}
      <ReviewLegend mode={mode} />
    </div>
  );
}

import "./review.css";
import { CanvasHost } from "../canvas/CanvasHost.tsx";
import { Canvas3D } from "../canvas3d/index.tsx";
import type { CanvasProps } from "../slots.ts";
import { type LegendMode, ReviewLegend } from "./ReviewLegend.tsx";
import { ReviewRings } from "./ReviewRings.tsx";

export { ReviewLegend };

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

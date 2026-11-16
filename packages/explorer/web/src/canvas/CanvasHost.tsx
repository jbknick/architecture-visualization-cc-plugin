import { lazy, Suspense, useState } from "react";
import { ListCanvas } from "../components/ListCanvas.tsx";
import type { CanvasProps } from "../slots.ts";
import { useStore } from "../store.tsx";

// sigma and the layout engine load on first use, so the shell itself stays small (and testable without WebGL).
const GraphCanvas = lazy(() => import("./GraphCanvas.tsx").then((m) => ({ default: m.GraphCanvas })));
// The ego view's bow-tie is a plain 2D canvas: no sigma, no WebGL.
const BowtieCanvas = lazy(() => import("./BowtieCanvas.tsx").then((m) => ({ default: m.BowtieCanvas })));
// The cross-stack views (#48) send lanes: boxes in columns or swimlanes on a plain 2D canvas.
const FlowCanvas = lazy(() => import("./FlowCanvas.tsx").then((m) => ({ default: m.FlowCanvas })));

type Mode = "graph" | "list";

// Remembered for the page's lifetime so switching views keeps the user's choice.
let lastMode: Mode = "graph";

/** sigma needs WebGL2; without it (old browsers, jsdom) the list stays the renderer. */
const hasWebGL = () => typeof WebGL2RenderingContext !== "undefined";
const has2d = () => typeof CanvasRenderingContext2D !== "undefined";

/** The registered canvas for graph hints: the sigma canvas with a List / Graph toggle. */
export function CanvasHost(props: CanvasProps) {
  const { view } = useStore();
  const bowtie = props.layoutHint === "bowtie";
  const flow = Array.isArray(props.data?.lanes);
  const webgl = bowtie || flow ? has2d() : hasWebGL();
  const [mode, setMode] = useState<Mode>(webgl ? lastMode : "list");
  const choose = (next: Mode) => {
    lastMode = next;
    setMode(next);
  };
  return (
    <div className="gc-host">
      <fieldset className="gc-mode" aria-label="Renderer">
        <button type="button" aria-pressed={mode === "list"} onClick={() => choose("list")}>
          List
        </button>
        <button
          type="button"
          aria-pressed={mode === "graph"}
          disabled={!webgl}
          title={webgl ? undefined : "Canvas drawing is not available in this browser"}
          onClick={() => choose("graph")}
        >
          Graph
        </button>
      </fieldset>
      {mode === "graph" ? (
        <Suspense fallback={<p className="empty">Loading graph…</p>}>
          {bowtie ? (
            <BowtieCanvas {...props} />
          ) : flow ? (
            <FlowCanvas {...props} />
          ) : (
            <GraphCanvas {...props} viewId={view} />
          )}
        </Suspense>
      ) : (
        <ListCanvas {...props} />
      )}
    </div>
  );
}

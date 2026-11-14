// biome-ignore-all lint/suspicious/noThenProperty: sigma's style DSL is { whenState, then, else }
import { type CanvasTheme, hexToRgba } from "./style.ts";

/**
 * Sigma v4 style declaration. Level, selection and dimming arrive as item states (dim, useKind, sel,
 * isHidden) set in batches by the canvas, so no node or edge reducer is needed.
 */
export function makeSigmaStyles(theme: CanvasTheme) {
  const edgeInk = theme.scheme === "light" ? "#475569" : "#aab4c5";
  return {
    nodes: {
      x: { attribute: "x" },
      y: { attribute: "y" },
      size: { attribute: "size" },
      color: { whenState: "useKind", then: { attribute: "colorKind" }, else: { attribute: "colorWs" } },
      opacity: { whenState: "dim", then: 0.18, else: 1 },
      label: { attribute: "label" },
      labelSize: 12,
      labelColor: theme.text,
      labelVisibility: {
        whenState: "dim",
        then: "hidden",
        else: { whenState: ["sel", "isHovered"], then: "visible", else: "auto" },
      },
      visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
      depth: { whenState: ["sel", "isHovered"], then: "topNodes", else: "nodes" },
    },
    edges: {
      size: { whenState: "sel", then: 2, else: 1.1 },
      color: { whenState: "sel", then: theme.accent, else: hexToRgba(edgeInk, 0.4) },
      opacity: { whenState: "dim", then: 0.07, else: 1 },
      head: "arrow",
      label: { whenState: "sel", then: { attribute: "weightLabel" } },
      labelColor: theme.text,
      labelSize: 12,
      visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
      depth: { whenState: ["sel", "isHovered"], then: "topEdges", else: "edges" },
    },
  };
}

// Extension points for later issues. See ../README.md.
import type { ComponentType } from "react";
import type { Filters, GraphEdge, GraphNode } from "./api.ts";

/** Props every canvas renderer receives. */
export interface CanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The hint the view sent, e.g. "list", "force", "layered", "3d". */
  layoutHint: string;
  /** Focused node id (the `focus` route param), or null. */
  focus: string | null;
  /** Call with a node id to focus it (updates the hash and opens the inspector), or null to clear. */
  onSelect: (id: string | null) => void;
  /** Call with the hovered node id, or null when the pointer leaves. */
  onHover: (id: string | null) => void;
}

/** Props for the view-specific filter panel in the left slot. */
export interface FilterPanelProps {
  viewId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  filters: Filters;
  /** Replace the filters; they are written to the hash and sent to /api/view. */
  onFiltersChange: (filters: Filters) => void;
}

export type CanvasRenderer = ComponentType<CanvasProps>;
export type FilterPanel = ComponentType<FilterPanelProps>;

const canvases = new Map<string, CanvasRenderer>();
const filterPanels = new Map<string, FilterPanel>();
let defaultCanvas: CanvasRenderer | null = null;

/** Register a renderer for a layoutHint. A later registration for the same hint replaces the earlier one. */
export function registerCanvas(layoutHint: string, renderer: CanvasRenderer): void {
  canvases.set(layoutHint, renderer);
}

export function setDefaultCanvas(renderer: CanvasRenderer): void {
  defaultCanvas = renderer;
}

/** The renderer for a hint; unknown hints fall back to the default (the placeholder list). */
export function getCanvas(layoutHint: string): CanvasRenderer {
  const found = canvases.get(layoutHint) ?? defaultCanvas;
  if (!found) throw new Error("No canvas renderer registered");
  return found;
}

export function registerFilterPanel(viewId: string, panel: FilterPanel): void {
  filterPanels.set(viewId, panel);
}

export function getFilterPanel(viewId: string): FilterPanel | null {
  return filterPanels.get(viewId) ?? null;
}

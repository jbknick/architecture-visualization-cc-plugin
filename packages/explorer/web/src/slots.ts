// Extension points for later issues. See ../README.md.
import type { ComponentType } from "react";
import type { Filters, GraphEdge, GraphNode, ViewData } from "./api.ts";
import type { Route } from "./route.ts";

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
  /** The whole view response, for views that send more than nodes and edges (duplicates: clusters). */
  data?: ViewData;
  /** Optional: call on double-click / Enter-with-modifier to "go into" a node (project map: show its contents; ego: re-centre). */
  onDrill?: (id: string) => void;
}

/** Props for the view-specific filter panel in the left slot. */
export interface FilterPanelProps {
  viewId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The whole view response (see CanvasProps.data). */
  data?: ViewData | null;
  filters: Filters;
  /** Replace the filters; they are written to the hash and sent to /api/view. */
  onFiltersChange: (filters: Filters) => void;
  /** The current hash route (view params: focus, level, hops). Optional so older panels and tests keep working. */
  route?: Route;
  /** Merge a patch into the route (focus, level, hops, filters, ...). */
  onRouteChange?: (patch: Partial<Route>) => void;
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

/** Shown in the centre instead of the canvas while a view that needs a `focus` has none. */
export type FocusPrompt = ComponentType<{ viewId: string }>;
const focusPrompts = new Map<string, FocusPrompt>();

/** Mark a view as needing `focus`: no request is sent until it is set, and `prompt` explains what to do. */
export function registerFocusRequired(viewId: string, prompt: FocusPrompt): void {
  focusPrompts.set(viewId, prompt);
}

export function getFocusPrompt(viewId: string): FocusPrompt | null {
  return focusPrompts.get(viewId) ?? null;
}

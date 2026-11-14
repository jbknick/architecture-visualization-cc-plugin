// Tiny store shared by the left panel (rendered by the shell) and the canvas, which sit in different parts of
// the React tree. View-local UI state (auto-rotate, camera reset, island focus) lives here.
import { useSyncExternalStore } from "react";
import type { GraphEdge, GraphNode } from "../api.ts";

export type MapStyle = "city" | "islands";
export type CameraView = "angled" | "top" | "reset";

const STYLE_KEY = "gantry.map3d.style";

/** The rendering style: `style=islands` in the hash, else the remembered choice, else the city (the default). */
export function readStyle(filters: Record<string, string>): MapStyle {
  if (filters.style === "islands") return "islands";
  if (filters.style === "city") return "city";
  try {
    return window.localStorage.getItem(STYLE_KEY) === "islands" ? "islands" : "city";
  } catch {
    return "city";
  }
}

export function rememberStyle(style: MapStyle): void {
  try {
    window.localStorage.setItem(STYLE_KEY, style);
  } catch {
    // blocked storage: the hash still carries the choice
  }
}

export interface MapUi {
  autoRotate: boolean;
  /** Show arcs that only come from package.json `depends_on` (no imports). Off by default. */
  showDeclared: boolean;
  /** Island under the pointer in the legend; the scene highlights it and reveals its labels and arcs. */
  hoverIsland: string | null;
  /** Island id picked from the legend or by clicking an island; null for none. */
  island: string | null;
  /** Bumped on every request so the canvas reacts even when the target is unchanged. */
  resetNonce: number;
  flyNonce: number;
  /** City style: the camera preset the panel asked for; `cameraNonce` changes on every request. */
  cameraView: CameraView;
  cameraNonce: number;
  /** Bumped when the remembered style changes without the hash changing, so the panel and canvas read it again. */
  styleNonce: number;
  /** City style: the project-map data the city is built from, shared with the panel (list of largest files, legend). */
  cityData: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

let state: MapUi = {
  autoRotate: false, // off by default: a rotating scene makes labels swim
  showDeclared: false,
  hoverIsland: null,
  island: null,
  resetNonce: 0,
  flyNonce: 0,
  cameraView: "angled",
  cameraNonce: 0,
  styleNonce: 0,
  cityData: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<MapUi>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const mapUi = {
  get: (): MapUi => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setAutoRotate: (autoRotate: boolean) => set({ autoRotate }),
  setShowDeclared: (showDeclared: boolean) => set({ showDeclared }),
  setHoverIsland: (hoverIsland: string | null) => set({ hoverIsland }),
  resetCamera: () =>
    set({
      island: null,
      resetNonce: state.resetNonce + 1,
      cameraView: "reset",
      cameraNonce: state.cameraNonce + 1,
    }),
  setCameraView: (cameraView: CameraView) => set({ cameraView, cameraNonce: state.cameraNonce + 1 }),
  touchStyle: () => set({ styleNonce: state.styleNonce + 1 }),
  setCityData: (cityData: MapUi["cityData"]) => set({ cityData }),
  /** Select an island and fly the camera to it. */
  focusIsland: (island: string) => set({ island, flyNonce: state.flyNonce + 1 }),
  /** Select or clear an island without moving the camera. */
  selectIsland: (island: string | null) => set({ island }),
};

export function useMapUi(): MapUi {
  return useSyncExternalStore(mapUi.subscribe, mapUi.get, mapUi.get);
}

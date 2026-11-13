// Tiny store shared by the left panel (rendered by the shell) and the canvas, which sit in different parts of
// the React tree. View-local UI state (auto-rotate, camera reset, island focus) lives here.
import { useSyncExternalStore } from "react";

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
  resetCamera: () => set({ island: null, resetNonce: state.resetNonce + 1 }),
  /** Select an island and fly the camera to it. */
  focusIsland: (island: string) => set({ island, flyNonce: state.flyNonce + 1 }),
  /** Select or clear an island without moving the camera. */
  selectIsland: (island: string | null) => set({ island }),
};

export function useMapUi(): MapUi {
  return useSyncExternalStore(mapUi.subscribe, mapUi.get, mapUi.get);
}

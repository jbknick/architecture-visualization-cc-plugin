// Tiny store shared by the project map's left panel and its canvas, which sit in different parts of the React
// tree: whether declared-only dependencies are drawn, and the workspace row the pointer is over in the panel.
import { useSyncExternalStore } from "react";

export interface MapViewState {
  /** Draw links that only come from package.json `depends_on` (no imports). Off by default. */
  showDeclared: boolean;
  /** Workspace id under the pointer in the left panel; the canvas shows its links in full. */
  hoverWorkspace: string | null;
  /** "api › agreement": the workspace and folder at the centre of the canvas while it is zoomed in, else null. */
  zoomedInto: string | null;
}

let state: MapViewState = { showDeclared: false, hoverWorkspace: null, zoomedInto: null };
const listeners = new Set<() => void>();

function set(patch: Partial<MapViewState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const mapView = {
  get: (): MapViewState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setShowDeclared: (showDeclared: boolean) => set({ showDeclared }),
  setHoverWorkspace: (hoverWorkspace: string | null) => set({ hoverWorkspace }),
  setZoomedInto: (zoomedInto: string | null) => {
    if (state.zoomedInto !== zoomedInto) set({ zoomedInto });
  },
};

export function useMapView(): MapViewState {
  return useSyncExternalStore(mapView.subscribe, mapView.get, mapView.get);
}

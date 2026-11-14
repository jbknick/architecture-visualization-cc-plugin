// Small store shared by the "Largest files" list (left panel) and the canvas of each map, which sit in different
// parts of the React tree: which workspace the ranking is restricted to, the file the pointer is over in the list,
// and a request to bring a file into view.
import { useSyncExternalStore } from "react";

export interface RankViewState {
  /** Workspace id the ranking is restricted to, or null for all visible workspaces. */
  scope: string | null;
  /** File id under the pointer in the list; the canvas highlights it. */
  hoverFile: string | null;
  /** File the list asked the canvas to zoom or fly to; `focusNonce` changes on every request. */
  focusFile: string | null;
  focusNonce: number;
}

let state: RankViewState = { scope: null, hoverFile: null, focusFile: null, focusNonce: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<RankViewState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const rankView = {
  get: (): RankViewState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setScope: (scope: string | null) => {
    if (state.scope !== scope) set({ scope, hoverFile: null });
  },
  setHoverFile: (hoverFile: string | null) => {
    if (state.hoverFile !== hoverFile) set({ hoverFile });
  },
  focus: (focusFile: string) => set({ focusFile, focusNonce: state.focusNonce + 1 }),
};

export function useRankView(): RankViewState {
  return useSyncExternalStore(rankView.subscribe, rankView.get, rankView.get);
}

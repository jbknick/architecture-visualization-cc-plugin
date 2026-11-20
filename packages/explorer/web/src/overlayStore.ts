// The curation overlay (labels, hidden parts, groups, saved views) as a small external store, like `rankedFiles/store.ts`.
// It is not part of the React store's state on purpose: the overlay arrives after the first paint, and putting it in the
// state that `App` reads re-rendered the whole shell, canvas included, a second time. Only the controls that show the
// overlay subscribe to it.
import { useSyncExternalStore } from "react";
import { api, type OverlayResponse } from "./api.ts";

let state: OverlayResponse | null = null;
const listeners = new Set<() => void>();

function set(next: OverlayResponse | null): void {
  // Nothing to tell anyone when a load brings back what is already shown.
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const l of listeners) l();
}

export const overlayStore = {
  get: (): OverlayResponse | null => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Loads the overlay. A server without overlay routes leaves it null (the curation controls stay hidden). */
  async load(signal?: AbortSignal): Promise<void> {
    try {
      set(await api.getOverlay(signal));
    } catch {
      // keep what is shown
    }
  },
  /** Back to "not loaded" (component tests). */
  clear(): void {
    state = null;
    for (const l of listeners) l();
  },
};

/** The overlay, or null until it has loaded. */
export function useOverlay(): OverlayResponse | null {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.get, overlayStore.get);
}

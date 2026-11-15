// Small store shared by the review panel and the review canvases (#169), which sit in different parts of the React
// tree: the change whose consumers are shown. Clicking a consumer in the panel selects the consumer but keeps its
// change in focus, so the map keeps showing that change's lines only.
import { useSyncExternalStore } from "react";

let change: string | null = null;
const listeners = new Set<() => void>();

export const reviewFocus = {
  get: (): string | null => change,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  set(id: string | null): void {
    if (change === id) return;
    change = id;
    for (const l of listeners) l();
  },
};

export function useReviewFocus(): string | null {
  return useSyncExternalStore(reviewFocus.subscribe, reviewFocus.get, reviewFocus.get);
}

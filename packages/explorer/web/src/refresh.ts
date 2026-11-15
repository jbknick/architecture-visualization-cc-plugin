// Refresh on request (spec section 11 (c)): the explorer is not live. Every view and meta response says how many
// files changed since the index was last brought up to date (`stale.files`); the Refresh button asks the server to
// re-index them, then every loaded thing (view, node, source, overview) is fetched again in place. Shared by the top
// bar, the data hooks and the canvases, which sit in different parts of the React tree.
import { useSyncExternalStore } from "react";
import { api, type RefreshResult } from "./api.ts";

export interface RefreshState {
  /** Files changed since the last refresh, from the latest response; 0 when up to date. */
  stale: number;
  running: boolean;
  error: string | null;
  /** Bumped after every successful refresh: the data hooks include it in their keys. */
  generation: number;
  /** The last refresh's answer, or null before the first. */
  last: RefreshResult | null;
  /** Ids drawn with a highlight until the next refresh: added and changed functions, and the changed files. */
  fresh: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();
let state: RefreshState = { stale: 0, running: false, error: null, generation: 0, last: null, fresh: EMPTY };
const listeners = new Set<() => void>();

function set(patch: Partial<RefreshState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function freshIds(r: RefreshResult): Set<string> {
  return new Set([...r.functions.added, ...r.functions.changed, ...r.files]);
}

export const refreshStore = {
  get: (): RefreshState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** A response said how out of date the index is. */
  noteStale(files: number | undefined): void {
    if (files === undefined || state.running || files === state.stale) return;
    set({ stale: files });
  },
  /** Runs one refresh (a second press while one runs is ignored). Resolves when the server has answered. */
  async run(): Promise<RefreshResult | null> {
    if (state.running) return null;
    set({ running: true, error: null });
    try {
      const r = await api.refresh();
      set({ running: false, stale: 0, last: r, fresh: freshIds(r), generation: state.generation + 1 });
      return r;
    } catch (err) {
      set({ running: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  /** Tests only. */
  reset(): void {
    state = { stale: 0, running: false, error: null, generation: 0, last: null, fresh: EMPTY };
    for (const l of listeners) l();
  },
};

export function useRefresh(): RefreshState {
  return useSyncExternalStore(refreshStore.subscribe, refreshStore.get, refreshStore.get);
}

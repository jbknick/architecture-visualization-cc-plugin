// The team's saved views and groups, as the explorer's own server reads them from the local team cache
// (`GET /api/team/views`). A small external store like `overlayStore.ts`: the switcher and the Curation section read it,
// and only they re-render when it changes. A server without the route, or any failure, leaves it null: no Team heading,
// no publish items, and the switcher is the one there has always been.
import { useSyncExternalStore } from "react";
import { api, type TeamViewsData } from "./api.ts";

export interface TeamViewsState {
  data: TeamViewsData | null;
  /** `Date.now()` when `data` was read: `data.age_s` is the age at that moment. */
  loadedAt: number | null;
  /** True once the first read has answered (with data or without). */
  loaded: boolean;
}

const INITIAL: TeamViewsState = { data: null, loadedAt: null, loaded: false };
let state: TeamViewsState = INITIAL;
let scenarioInUse: string | undefined;
let newest = 0;
const listeners = new Set<() => void>();

function set(next: TeamViewsState): void {
  state = next;
  for (const l of listeners) l();
}

export const teamViewsStore = {
  get: (): TeamViewsState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Reads the cache through the explorer's server. `scenario` is mock-only and is kept for later reloads. */
  async load(scenario?: string): Promise<void> {
    if (scenario !== undefined) scenarioInUse = scenario;
    const mine = ++newest;
    let data: TeamViewsData | null = null;
    try {
      const got = await api.teamViews(undefined, scenarioInUse);
      data = got.available ? got : null;
    } catch {
      data = null;
    }
    if (mine !== newest) return;
    const same = JSON.stringify(data) === JSON.stringify(state.data);
    set(same && state.loaded ? state : { data, loadedAt: data === null ? null : Date.now(), loaded: true });
  },
  /** Reads again with the scenario the last read used. */
  reload: (): Promise<void> => teamViewsStore.load(),
  /** Tests only. */
  clear(): void {
    state = INITIAL;
    scenarioInUse = undefined;
    newest = 0;
    for (const l of listeners) l();
  },
};

/** The team's views and groups, or `data: null` with no team cache. */
export function useTeamViews(): TeamViewsState {
  return useSyncExternalStore(teamViewsStore.subscribe, teamViewsStore.get, teamViewsStore.get);
}

// ---- the person's own last choice: a later session opens on it, not on the team default

/** Tells the explorer's server which saved view the person picked, so a later `gantry map` (any port) opens on it. */
export function rememberView(id: string): void {
  void api.putLastView(id).catch(() => {
    // not remembered: the next session opens on the team default
  });
}

/**
 * Which saved view a session with no view in its link opens on: the person's own last pick when it still exists, else
 * the team default, else none (the map as it always opens).
 */
export function openingView(data: TeamViewsData): string | null {
  if (data.last_view !== null && data.views.some((v) => v.id === data.last_view)) return data.last_view;
  return data.default_view;
}

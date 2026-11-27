// The Team layer's state for the session (spec section 11): the data read from the local team cache, whether the
// layer is on, the picked change set and the person filter. A tiny store like `mapView`, because the toggle, the
// panel and the map canvas sit in different parts of the React tree. Nothing is stored on disk.
import { useSyncExternalStore } from "react";
import { api, type TeamLayerData } from "../api.ts";

export interface TeamLayerState {
  /** The last answer of `GET /api/team/layer`; null before it has loaded or when the request failed. */
  data: TeamLayerData | null;
  loaded: boolean;
  /** `Date.now()` when `data` was read: `data.age_s` is the age at that moment. */
  loadedAt: number | null;
  /** The layer is switched on (off by default). */
  on: boolean;
  /** The picked change set's id. */
  pickedId: string | null;
  /** Ticked owners; everyone when none is ticked. */
  people: string[];
  /** A Refresh is re-reading the cache. */
  refreshing: boolean;
}

const INITIAL: TeamLayerState = {
  data: null,
  loaded: false,
  loadedAt: null,
  on: false,
  pickedId: null,
  people: [],
  refreshing: false,
};
let state: TeamLayerState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<TeamLayerState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** The newest read: an older read that answers late is dropped, so the last question decides what is shown. */
let newest = 0;

export const teamStore = {
  get: (): TeamLayerState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /**
   * Reads the local cache through the explorer's own server (one request, no team server). A server without the route,
   * or any failure, counts as "no team data": the toggle stays hidden. `scenario` is mock-only.
   */
  async load(scenario?: string): Promise<void> {
    const mine = ++newest;
    let data: TeamLayerData | null = null;
    try {
      data = await api.teamLayer(undefined, scenario);
    } catch {
      data = null;
    }
    if (mine !== newest) return;
    if (data === null) {
      set({ data: null, loaded: true, loadedAt: null, on: false, pickedId: null });
      return;
    }
    // A change set that is gone after a re-read is no longer selected, nor a person nobody owns.
    const ids = new Set(data.change_sets.map((c) => c.id));
    const people = data.people;
    set({
      data,
      loaded: true,
      loadedAt: Date.now(),
      pickedId: state.pickedId !== null && ids.has(state.pickedId) ? state.pickedId : null,
      people: state.people.filter((p) => people.includes(p)),
      on: data.available ? state.on : false,
    });
  },
  /** The Refresh button: re-reads the cache (it never pulls from the server). */
  async refresh(scenario?: string): Promise<void> {
    set({ refreshing: true });
    try {
      await teamStore.load(scenario);
    } finally {
      set({ refreshing: false });
    }
  },
  setOn: (on: boolean) => set(on ? { on } : { on, pickedId: null }),
  pick: (pickedId: string | null) => set({ pickedId }),
  setPeople: (people: string[]) => set({ people, pickedId: null }),
  /** Tests only. */
  reset(): void {
    state = INITIAL;
    newest = 0;
    for (const l of listeners) l();
  },
};

export function useTeam(): TeamLayerState {
  return useSyncExternalStore(teamStore.subscribe, teamStore.get, teamStore.get);
}

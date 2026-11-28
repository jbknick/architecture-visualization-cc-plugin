import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { api, type Meta, type SearchHit } from "./api.ts";
import { RELOAD_VIEW_EVENT } from "./hooks.ts";
import { overlayStore } from "./overlayStore.ts";
import { refreshStore, useRefresh } from "./refresh.ts";
import { emptyRoute, formatHash, parseHash, parseInitialHash, type Route } from "./route.ts";
import { openingView, teamViewsStore } from "./teamViewsStore.ts";

export interface State {
  route: Route;
  meta: Meta | null;
  metaError: string | null;
  leftOpen: boolean;
  hoverId: string | null;
  /** Last search hit the user picked; gives the inspector a path:line before /api/node answers. */
  pickedHit: SearchHit | null;
}

type Action =
  | { type: "route"; route: Route }
  | { type: "meta"; meta: Meta }
  | { type: "metaError"; message: string }
  | { type: "toggleLeft" }
  | { type: "hover"; id: string | null }
  | { type: "pick"; hit: SearchHit | null };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "route":
      return { ...state, route: action.route };
    case "meta":
      return { ...state, meta: action.meta, metaError: null };
    case "metaError":
      return { ...state, metaError: action.message };
    case "toggleLeft":
      return { ...state, leftOpen: !state.leftOpen };
    case "hover":
      return { ...state, hoverId: action.id };
    case "pick":
      return { ...state, pickedHit: action.hit };
  }
}

export interface Store {
  state: State;
  /** Current view id: the route's, else the first enabled view. */
  view: string | null;
  /** Merge a patch into the route and write it to the hash (creates a history entry). */
  navigate: (patch: Partial<Route>) => void;
  /** Change view; focus, selection, level, hops and filters are cleared. */
  setView: (view: string) => void;
  /** Open a node in the inspector (`sel`). */
  selectNode: (id: string | null, hit?: SearchHit | null) => void;
  /** Set the view's focus (project-map subtree, ego center) and open the node in the inspector. */
  focusOn: (id: string, hit?: SearchHit | null) => void;
  /** Switch to `view` centered on `id`, with that view's default options. `selectId` is shown in the inspector. */
  openInView: (view: string, id: string, selectId?: string | null) => void;
  toggleLeft: () => void;
  setHover: (id: string | null) => void;
  /**
   * Runs an overlay write, then loads the overlay again and asks the open view to fetch itself again (labels,
   * hidden parts and groups are applied when a view is built). Rejects with the server's message when the write fails.
   */
  writeOverlay: (write: () => Promise<unknown>) => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

function readRoute(): Route {
  return parseHash(window.location.hash);
}

/** Load-time route: a focus-only link also selects the focus node, and the hash is rewritten to say so. */
function readInitialRoute(): Route {
  const route = parseInitialHash(window.location.hash);
  if (route.view) {
    const hash = formatHash(route);
    if (hash !== window.location.hash) window.history.replaceState(null, "", hash);
  }
  return route;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    route: readInitialRoute(),
    meta: null,
    metaError: null,
    leftOpen: true,
    hoverId: null,
    pickedHit: null,
  }));

  useEffect(() => {
    const onHash = () => dispatch({ type: "route", route: readRoute() });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Mock-only: a `scenario` flag in the hash makes the mock's /api/meta describe that scenario's data.
  const scenario = state.route.filters.scenario;
  const scenarioView = scenario ? (state.route.view ?? undefined) : undefined;
  // Fetched again after a refresh (new counts) and when the tab comes back into view: that is the request that
  // shows the "Out of date" marker after a save in the editor (spec section 11 (c); no watcher, no push).
  const { generation } = useRefresh();
  const [focusTick, setFocusTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setFocusTick();
    };
    window.addEventListener("focus", setFocusTick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", setFocusTick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` and `focusTick` only trigger a new request
  useEffect(() => {
    const controller = new AbortController();
    api.meta(controller.signal, scenario, scenarioView).then(
      (meta) => {
        refreshStore.noteStale(meta.stale?.files);
        dispatch({ type: "meta", meta });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ type: "metaError", message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => controller.abort();
  }, [scenario, scenarioView, generation, focusTick]);

  // The overlay is loaded at start and again after every write (`writeOverlay`) and every Refresh. A server without
  // overlay routes (the in-repo mock before this feature) leaves it null and the curation controls hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` only triggers a new request
  useEffect(() => {
    const controller = new AbortController();
    void overlayStore.load(controller.signal);
    return () => controller.abort();
  }, [generation]);

  // The team's views and groups come from the same local cache read as the Team layer: loaded at start and after every
  // Refresh and write. With no team cache the answer is "unavailable" and nothing about teams shows.
  useEffect(() => {
    void teamViewsStore.load(scenario);
    let seen = refreshStore.get().generation;
    return refreshStore.subscribe(() => {
      const now = refreshStore.get().generation;
      if (now === seen) return;
      seen = now;
      void teamViewsStore.reload();
    });
  }, [scenario]);

  const writeOverlay = useCallback(async (write: () => Promise<unknown>) => {
    await write();
    await overlayStore.load();
    await teamViewsStore.reload();
    window.dispatchEvent(new Event(RELOAD_VIEW_EVENT));
  }, []);

  // With no view in the hash, land on the project map when the server has it, else the first enabled view.
  const enabledViews = state.meta?.views.filter((v) => v.enabled) ?? [];
  const view =
    state.route.view ?? (enabledViews.find((v) => v.id === "project-map") ?? enabledViews[0])?.id ?? null;

  // An empty hash lands on the first enabled view without adding a history entry.
  useEffect(() => {
    if (!state.route.view && view) {
      window.history.replaceState(null, "", formatHash({ ...state.route, view }));
      dispatch({ type: "route", route: readRoute() });
    }
  }, [state.route, view]);

  // A session that opens with no view in its link opens on the person's own last saved view, or else on the team's
  // default view, once both the repo name and the team views are known. One decision per page load.
  const freshSession = useRef(state.route.view === null);
  useEffect(() => {
    const repo = state.meta?.repo;
    if (!freshSession.current || repo === undefined) return;
    let unsubscribe = () => {};
    const decide = (): void => {
      const { data, loaded } = teamViewsStore.get();
      if (!loaded) return;
      unsubscribe();
      freshSession.current = false;
      if (data === null || readRoute().saved !== null) return;
      const id = openingView(data);
      const picked = id === null ? undefined : data.views.find((v) => v.id === id && v.shadowed !== true);
      if (!picked) return;
      window.history.replaceState(
        null,
        "",
        formatHash({ ...emptyRoute, view: picked.spec.view, saved: picked.id }),
      );
      dispatch({ type: "route", route: readRoute() });
    };
    unsubscribe = teamViewsStore.subscribe(decide);
    decide();
    return () => unsubscribe();
  }, [state.meta?.repo]);

  const navigate = useCallback(
    (patch: Partial<Route>) => {
      const next: Route = { ...state.route, view, ...patch };
      const hash = formatHash(next);
      if (hash !== window.location.hash) window.location.hash = hash;
    },
    [state.route, view],
  );

  const value = useMemo<Store>(
    () => ({
      state,
      view,
      navigate,
      setView: (id) => navigate({ ...emptyRoute, view: id }),
      selectNode: (id, hit = null) => {
        dispatch({ type: "pick", hit });
        navigate({ sel: id });
      },
      focusOn: (id, hit = null) => {
        dispatch({ type: "pick", hit });
        // The default connection types depend on whether the center is a function or a file, so drop a stale choice.
        const { edgeKinds: _drop, expand: _expand, ...filters } = state.route.filters;
        navigate({ focus: id, sel: id, filters });
      },
      openInView: (id, nodeId, selectId = nodeId) =>
        navigate({ ...emptyRoute, view: id, focus: nodeId, sel: selectId }),
      toggleLeft: () => dispatch({ type: "toggleLeft" }),
      setHover: (id) => dispatch({ type: "hover", id }),
      writeOverlay,
    }),
    [state, view, navigate, writeOverlay],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <StoreProvider>");
  return store;
}

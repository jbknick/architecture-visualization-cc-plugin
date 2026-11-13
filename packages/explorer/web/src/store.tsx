import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { api, type Meta, type SearchHit } from "./api.ts";
import { emptyRoute, formatHash, parseHash, type Route } from "./route.ts";

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
  /** Set the view's focus (project-map subtree, ego centre) and open the node in the inspector. */
  focusOn: (id: string, hit?: SearchHit | null) => void;
  /** Switch to `view` centred on `id`, with that view's default options. `selectId` is shown in the inspector. */
  openInView: (view: string, id: string, selectId?: string | null) => void;
  toggleLeft: () => void;
  setHover: (id: string | null) => void;
}

const StoreContext = createContext<Store | null>(null);

function readRoute(): Route {
  return parseHash(window.location.hash);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    route: readRoute(),
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

  useEffect(() => {
    const controller = new AbortController();
    api.meta(controller.signal).then(
      (meta) => dispatch({ type: "meta", meta }),
      (err: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ type: "metaError", message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => controller.abort();
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
        // The default connection types depend on whether the centre is a function or a file, so drop a stale choice.
        const { edgeKinds: _drop, ...filters } = state.route.filters;
        navigate({ focus: id, sel: id, filters });
      },
      openInView: (id, nodeId, selectId = nodeId) =>
        navigate({ ...emptyRoute, view: id, focus: nodeId, sel: selectId }),
      toggleLeft: () => dispatch({ type: "toggleLeft" }),
      setHover: (id) => dispatch({ type: "hover", id }),
    }),
    [state, view, navigate],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <StoreProvider>");
  return store;
}

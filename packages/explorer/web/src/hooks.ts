import { useEffect, useState } from "react";
import {
  api,
  type Filters,
  type NodeDetail,
  type OverviewDetail,
  type SearchHit,
  type SourceSlice,
  type ViewData,
  type ViewLevel,
} from "./api.ts";
import { refreshStore, useRefresh } from "./refresh.ts";

/** Dispatch on `window` to fetch the current view again (after a write such as a dismissal). */
export const RELOAD_VIEW_EVENT = "gantry:reload-view";

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Runs `load` when `key` changes. Keeps the previous data on screen while the next load is in flight. */
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, loading: key !== null, error: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` fully describes `load`
  useEffect(() => {
    if (key === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    load(controller.signal).then(
      (data) => setState({ data, loading: false, error: null }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          data: prev.data,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      },
    );
    return () => controller.abort();
  }, [key]);
  return state;
}

/** Fetches a view with its hash-route params. Pass `view: null` to skip the request. */
export function useViewData(
  view: string | null,
  params: {
    focus: string | null;
    level: ViewLevel | null;
    hops: number | null;
    saved?: string | null;
    filters: Filters;
  },
): Loadable<ViewData> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onReload = () => setTick((t) => t + 1);
    window.addEventListener(RELOAD_VIEW_EVENT, onReload);
    return () => window.removeEventListener(RELOAD_VIEW_EVENT, onReload);
  }, []);
  const { generation } = useRefresh();
  const key = view === null ? null : JSON.stringify([view, params, tick, generation]);
  return useLoad(key, async (signal) => {
    const data = await api.view(
      view ?? "",
      {
        focus: params.focus ?? undefined,
        level: params.level ?? undefined,
        hops: params.hops ?? undefined,
        saved: params.saved ?? undefined,
        filters: params.filters,
      },
      signal,
    );
    refreshStore.noteStale(data.stale?.files);
    return data;
  });
}

/** `key` plus the refresh generation, so a refresh fetches it again; null stays null (no request). */
function useFreshKey(key: string | null): string | null {
  const { generation } = useRefresh();
  return key === null ? null : `${generation}\u0000${key}`;
}

export function useNodeDetail(id: string | null): Loadable<NodeDetail> {
  return useLoad(useFreshKey(id), (signal) => api.node(id ?? "", signal));
}

/**
 * The cached overview of a workspace or folder. The server normalises ids (the 3D map's `dir:<workspace id>:<path>`
 * comes back as `dir:<repo path>`), so a response is matched to its request by the id that was asked for, never by
 * the `node_id` it carries. Data from an earlier id is hidden and counts as loading.
 */
export function useOverview(id: string | null): Loadable<OverviewDetail> {
  const r = useLoad(useFreshKey(id), async (signal) => ({
    asked: id,
    detail: await api.overview(id ?? "", signal),
  }));
  if (id === null) return { data: null, loading: false, error: null };
  const fetched = r.data !== null && r.data.asked === id ? r.data.detail : null;
  return {
    data: fetched,
    loading: r.loading || (fetched === null && r.error === null),
    error: r.error,
  };
}

export function useSource(path: string | null, start: number, end: number): Loadable<SourceSlice> {
  const key = useFreshKey(path === null ? null : `${path}:${start}:${end}`);
  return useLoad(key, (signal) => api.source(path ?? "", start, end, signal));
}

/** Debounced search. An empty query clears the hits without a request. */
export function useSearchHits(query: string, delayMs = 150): Loadable<SearchHit[]> {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), delayMs);
    return () => clearTimeout(t);
  }, [query, delayMs]);
  const key = debounced.length === 0 ? null : debounced;
  return useLoad(key, (signal) => api.search(debounced, signal));
}

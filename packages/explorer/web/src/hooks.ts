import { useEffect, useState } from "react";
import {
  api,
  type Filters,
  type NodeDetail,
  type SearchHit,
  type SourceSlice,
  type ViewData,
  type ViewLevel,
} from "./api.ts";

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
  params: { focus: string | null; level: ViewLevel | null; hops: number | null; filters: Filters },
): Loadable<ViewData> {
  const key = view === null ? null : JSON.stringify([view, params]);
  return useLoad(key, (signal) =>
    api.view(
      view ?? "",
      {
        focus: params.focus ?? undefined,
        level: params.level ?? undefined,
        hops: params.hops ?? undefined,
        filters: params.filters,
      },
      signal,
    ),
  );
}

export function useNodeDetail(id: string | null): Loadable<NodeDetail> {
  return useLoad(id, (signal) => api.node(id ?? "", signal));
}

export function useSource(path: string | null, start: number, end: number): Loadable<SourceSlice> {
  const key = path === null ? null : `${path}:${start}:${end}`;
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

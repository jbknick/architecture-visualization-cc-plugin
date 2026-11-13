import type { Filters } from "./api.ts";

/** Hash route: `#/<view>?focus=<id>&depth=<n>&<filters>`. Everything that is not focus/depth is a filter. */
export interface Route {
  view: string | null;
  focus: string | null;
  depth: number | null;
  filters: Filters;
}

export const emptyRoute: Route = { view: null, focus: null, depth: null, filters: {} };

export function parseHash(hash: string): Route {
  const body = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = body.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  const filters: Filters = {};
  let focus: string | null = null;
  let depth: number | null = null;
  for (const [key, value] of params) {
    if (key === "focus") focus = value || null;
    else if (key === "depth") {
      const n = Number.parseInt(value, 10);
      depth = Number.isFinite(n) && n >= 0 ? n : null;
    } else filters[key] = value;
  }
  const view = decodeURIComponent(path).trim();
  return { view: view || null, focus, depth, filters };
}

export function formatHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.focus) params.set("focus", route.focus);
  if (route.depth !== null) params.set("depth", String(route.depth));
  for (const key of Object.keys(route.filters).sort()) params.set(key, route.filters[key] ?? "");
  const qs = params.toString();
  return `#/${encodeURIComponent(route.view ?? "")}${qs ? `?${qs}` : ""}`;
}

import type { Filters, ViewLevel } from "./api.ts";

/**
 * Hash route: `#/<view>?focus=<id>&level=<level>&hops=<n>&sel=<id>&<filters>`.
 *
 * - `focus`, `level`, `hops` go to `/api/view/:id` as the query params of the same name.
 * - `sel` is the node open in the inspector. It never reaches the server.
 * - Every other key is a filter. They are sent as one JSON `filters` param (see `encodeFilters`).
 */
export interface Route {
  view: string | null;
  /** The subject of the view: the project-map subtree root or the ego centre. */
  focus: string | null;
  /** The node shown in the inspector. */
  sel: string | null;
  level: ViewLevel | null;
  hops: number | null;
  filters: Filters;
}

export const emptyRoute: Route = { view: null, focus: null, sel: null, level: null, hops: null, filters: {} };

export const VIEW_LEVELS: readonly ViewLevel[] = ["workspaces", "dirs", "files", "symbols"];

const isLevel = (v: string): v is ViewLevel => (VIEW_LEVELS as readonly string[]).includes(v);

export function parseHash(hash: string): Route {
  const body = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = body.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  const route: Route = { ...emptyRoute, filters: {} };
  for (const [key, value] of params) {
    if (key === "focus") route.focus = value || null;
    else if (key === "sel") route.sel = value || null;
    else if (key === "level") route.level = isLevel(value) ? value : null;
    else if (key === "hops") {
      const n = Number.parseInt(value, 10);
      route.hops = Number.isFinite(n) && n >= 1 ? n : null;
    } else route.filters[key] = value;
  }
  route.view = decodeURIComponent(path).trim() || null;
  return route;
}

export function formatHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.focus) params.set("focus", route.focus);
  if (route.level) params.set("level", route.level);
  if (route.hops !== null) params.set("hops", String(route.hops));
  if (route.sel) params.set("sel", route.sel);
  for (const key of Object.keys(route.filters).sort()) params.set(key, route.filters[key] ?? "");
  const qs = params.toString();
  return `#/${encodeURIComponent(route.view ?? "")}${qs ? `?${qs}` : ""}`;
}

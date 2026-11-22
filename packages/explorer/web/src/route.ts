import type { Filters, ViewLevel } from "./api.ts";

/**
 * Hash route: `#/<view>?focus=<id>&level=<level>&hops=<n>&sel=<id>&<filters>`.
 *
 * - `focus`, `level`, `hops` go to `/api/view/:id` as the query params of the same name.
 * - `saved` is the id of a saved view; it goes to `/api/view/:id` as the query param `saved`.
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
  /** Id of the saved view the map was opened from. Sent to `/api/view/:id` as `saved`. */
  saved: string | null;
  filters: Filters;
}

export const emptyRoute: Route = {
  view: null,
  focus: null,
  sel: null,
  level: null,
  hops: null,
  saved: null,
  filters: {},
};

export const VIEW_LEVELS: readonly ViewLevel[] = ["repos", "workspaces", "dirs", "files", "symbols"];

const isLevel = (v: string): v is ViewLevel => (VIEW_LEVELS as readonly string[]).includes(v);

/** Splits at the first `?` only; later `?` characters stay in the query. */
function splitHash(body: string): [string, string] {
  const i = body.indexOf("?");
  return i < 0 ? [body, ""] : [body.slice(0, i), body.slice(i + 1)];
}

export function parseHash(hash: string): Route {
  const body = hash.replace(/^#\/?/, "");
  const [path, query] = splitHash(body);
  const params = new URLSearchParams(query);
  const route: Route = { ...emptyRoute, filters: {} };
  for (const [key, value] of params) {
    if (key === "focus") route.focus = value || null;
    else if (key === "sel") route.sel = value || null;
    else if (key === "saved") route.saved = value || null;
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
  if (route.saved) params.set("saved", route.saved);
  if (route.level) params.set("level", route.level);
  if (route.hops !== null) params.set("hops", String(route.hops));
  // With a focus, an empty `sel=` records "nothing selected", so a reload does not select the focus again.
  if (route.sel) params.set("sel", route.sel);
  else if (route.focus) params.set("sel", "");
  for (const key of Object.keys(route.filters).sort()) params.set(key, route.filters[key] ?? "");
  const qs = params.toString();
  return `#/${encodeURIComponent(route.view ?? "")}${qs ? `?${qs}` : ""}`;
}

/**
 * The route for a page load. A link with a `focus` and no `sel` key opens that node in the inspector, as a click in
 * the app does (`focusOn` sets both). A `sel` key, even an empty one, is explicit and wins. Applied once at load; closing
 * the inspector writes `sel=`, so a reload keeps it closed.
 */
export function parseInitialHash(hash: string): Route {
  const route = parseHash(hash);
  const query = splitHash(hash.replace(/^#\/?/, ""))[1];
  if (route.focus && !new URLSearchParams(query).has("sel")) route.sel = route.focus;
  return route;
}

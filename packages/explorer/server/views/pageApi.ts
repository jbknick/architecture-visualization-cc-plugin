import type { ViewModule, ViewResult } from "../types.js";
import {
  barycentreRanks,
  crossCtx,
  describeNode,
  FlowBuilder,
  frontSet,
  type Lane,
  labelRanks,
  needsKinds,
  traceOf,
  type WorkspaceCount,
  workspaceCounts,
  wsFilter,
} from "./crossStack.js";
import { cmp, optBool } from "./options.js";

export interface PageApiResult extends ViewResult {
  lanes: Lane[];
  wsCounts: WorkspaceCount[];
  totals: {
    routes: number;
    endpoints: number;
    links: number;
    /** Routes shown with no request; endpoints no page requests (hidden unless `all`). */
    routesWithout: number;
    endpointsWithout: number;
    /** Unmatched client calls (no endpoint found) in the pages' code. */
    unmatched: number;
  };
}

const VIA_SAMPLE = 6;
const normalizePrefix = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const p = `/${raw.trim().replace(/^\/+|\/+$/g, "")}`;
  return p === "/" ? "" : p;
};

/**
 * View 8. Page -> API (#48, hint `columns`): routes on the left, endpoints on the right. Each `requests` edge is
 * the page's whole front end aggregated: everything a down `trace` from the route reaches before an endpoint (the
 * component tree, the route file's `Route` const with its loader, hooks and helpers) that requests the endpoint.
 * `via` counts those requesting places and `viaSample` names some; an edge is `low` when every request behind it
 * is a low-confidence match (dashed). Requests made by server code (a handler calling another endpoint) are not a
 * page's. A route with unmatched client calls carries the badge `n unmatched`.
 *
 * Filters: `ws` (the routes' app), `prefix` (route URL prefix), `all` (also routes and endpoints without a link).
 */
export const pageApiView: ViewModule = {
  id: "page-api",
  title: "Page → API",
  enabled: needsKinds("route", "endpoint"),
  disabledReason: "Needs routes (TanStack Router) and endpoints (oRPC, Hono, TanStack Start).",
  build({ store }, params): PageApiResult {
    const c = crossCtx(store);
    const all = optBool(params, "all", false);
    const prefix = normalizePrefix(params.options?.prefix);
    const wsOk = wsFilter(c, params);
    const allRoutes = c.byKind.get("route") ?? [];
    const routes = allRoutes.filter((r) => {
      if (!wsOk(r.ws)) return false;
      const url = typeof r.data.urlPath === "string" ? r.data.urlPath : "/";
      return prefix === "" || url === prefix || url.startsWith(`${prefix}/`);
    });
    const unmatchedByCaller = new Map<string, number>();
    for (const u of c.byKind.get("client_call") ?? []) {
      const caller = typeof u.data.caller === "string" ? u.data.caller : null;
      if (caller) unmatchedByCaller.set(caller, (unmatchedByCaller.get(caller) ?? 0) + 1);
    }

    const b = new FlowBuilder(c);
    const via = new Map<string, Set<string>>();
    let unmatched = 0;
    for (const r of routes) {
      const t = traceOf(c, r.id, "down");
      if (!t) continue;
      const front = frontSet(t);
      let routeUnmatched = 0;
      for (const id of front) routeUnmatched += unmatchedByCaller.get(id) ?? 0;
      unmatched += routeUnmatched;
      const kindOf = new Map(t.chain.map((s) => [s.id, s.kind]));
      for (const e of t.edges) {
        if (e.kind !== "requests" || !front.has(e.src) || kindOf.get(e.dst) !== "endpoint") continue;
        b.node(r.id, 0);
        b.node(e.dst, 1);
        const edge = b.edge(r.id, e.dst, "requests", e.confidence === "low", 0);
        let set = via.get(edge.id);
        if (!set) {
          set = new Set();
          via.set(edge.id, set);
        }
        set.add(e.src);
      }
      if (routeUnmatched > 0 || all) {
        const n = b.node(r.id, 0);
        if (routeUnmatched > 0) n.badges = [...(n.badges ?? []), `${routeUnmatched} unmatched`];
      }
    }
    if (all) for (const ep of c.byKind.get("endpoint") ?? []) b.node(ep.id, 1);
    const { nodes, edges } = b.result();
    for (const e of edges) {
      const places = [...(via.get(e.id) ?? [])].sort(cmp);
      e.weight = places.length;
      e.via = places.length;
      e.viaSample = places
        .slice(0, VIA_SAMPLE)
        .map((id) => (id === e.src ? "route loader" : describeNode(c, id).label));
    }
    // Routes by URL path (the route tree reads top to bottom), endpoints by the routes that request them.
    nodes
      .filter((n) => n.lane === 0)
      .sort((x, y) => cmp(x.label, y.label) || cmp(x.id, y.id))
      .forEach((n, i) => {
        n.rank = i;
      });
    barycentreRanks(nodes, edges, 1, 0);
    if (nodes.every((n) => n.lane !== 0)) labelRanks(nodes, 1);
    const linkedRoutes = new Set(edges.map((e) => e.src));
    const linkedEps = new Set(edges.map((e) => e.dst));
    const epTotal = (c.byKind.get("endpoint") ?? []).length;
    return {
      nodes,
      edges,
      layoutHint: "columns",
      lanes: [
        { lane: 0, label: "Pages (routes)" },
        { lane: 1, label: "Endpoints" },
      ],
      wsCounts: workspaceCounts(c, allRoutes),
      totals: {
        routes: routes.length,
        endpoints: epTotal,
        links: edges.length,
        routesWithout: routes.filter((r) => !linkedRoutes.has(r.id)).length,
        endpointsWithout: epTotal - linkedEps.size,
        unmatched,
      },
    };
  },
};

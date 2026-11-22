import { type AdapterNodeRecord, type EdgeRecord, repoOfId } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { ViewModule, ViewResult } from "../types.js";
import {
  crossCtx,
  type EndpointGroup,
  endpointFilter,
  endpointGroup,
  endpointMethod,
  FlowBuilder,
  GROUP_LABEL,
  GROUP_ORDER,
  type Lane,
  labelRanks,
  needsKinds,
  type WorkspaceCount,
  workspaceCounts,
} from "./crossStack.js";
import { cmp, optInt } from "./options.js";

export const ENDPOINT_DEPTH_DEFAULT = 2;
export const ENDPOINT_DEPTH_MAX = 4;
/** Nodes drawn at most; the endpoints come first, so a cut drops services. */
export const ENDPOINTS_MAX_NODES = 1500;

export interface EndpointsResult extends ViewResult {
  lanes: Lane[];
  groups: { id: EndpointGroup; label: string; count: number }[];
  methods: string[];
  wsCounts: WorkspaceCount[];
  totals: {
    endpoints: number;
    shown: number;
    middleware: number;
    withoutHandler: number;
    truncated: boolean;
  };
}

const MW = 1;
const HANDLER = 2;
const SERVICE = 3;

interface Span {
  start: number;
  end: number;
}
const spanOf = (n: AdapterNodeRecord): Span | null => {
  const s = n.data.handlerSpan as { start?: unknown; end?: unknown } | undefined;
  return s && typeof s.start === "number" && typeof s.end === "number"
    ? { start: s.start, end: s.end }
    : null;
};
/** Does a call leave the handler from inside the span (or can that not be told)? Same rule as `trace`. */
export const inSpan = (e: EdgeRecord, span: Span): boolean => {
  const entries = e.evidence.filter((x) => !x.startsWith("sibling:")); // `sibling:<repo>` is a note, not a line
  const lines = entries.map((x) => Number(x.slice(x.lastIndexOf(":") + 1)));
  if (lines.some((l) => l >= span.start && l <= span.end)) return true;
  return entries.length < e.count; // capped evidence: the dropped lines may be inside
};

/**
 * View 7. Endpoints (#48, hint `elk-layered`): every endpoint an adapter found (oRPC procedures, Hono routes,
 * TanStack Start server functions), grouped by kind (`band`: rpc, http, server fn), then the middleware it passes
 * through, the code that handles it and the services that code calls (`calls`, `depth` hops, default 2, at most 4).
 * Lanes: endpoint, middleware, handler, then one per call depth. Hono middleware are adapter nodes (`mw:`); the
 * middleware an oRPC procedure or server function names (`data.middleware`) are drawn as `mwref:<ws>:<name>` nodes.
 * An inline handler's calls are followed only from inside its own span, as `trace` does.
 *
 * Filters: `ws` (workspace ids or names), `kind` (rpc | http | fn), `method` (GET, POST, ..., RPC), `prefix` (URL
 * path, dotted rpc path or server function name).
 */
export const endpointsView: ViewModule = {
  id: "endpoints",
  title: "Endpoints",
  enabled: needsKinds("endpoint"),
  disabledReason: "No endpoints found: this view reads oRPC, Hono and TanStack Start server functions.",
  build({ store }, params): EndpointsResult {
    const depth = optInt(params, "hops") ?? params.depth ?? ENDPOINT_DEPTH_DEFAULT;
    if (!Number.isInteger(depth) || depth < 1 || depth > ENDPOINT_DEPTH_MAX)
      throw new HttpError(400, `depth must be an integer 1-${ENDPOINT_DEPTH_MAX}`);
    const c = crossCtx(store);
    const all = c.byKind.get("endpoint") ?? [];
    const pass = endpointFilter(c, params);
    const shown = all.filter(pass);
    const b = new FlowBuilder(c);

    const groupCounts = new Map<EndpointGroup, number>();
    for (const n of all) groupCounts.set(endpointGroup(n), (groupCounts.get(endpointGroup(n)) ?? 0) + 1);
    const order = (n: AdapterNodeRecord) => GROUP_ORDER.indexOf(endpointGroup(n));
    const sorted = [...shown].sort((x, y) => order(x) - order(y) || cmp(x.label, y.label) || cmp(x.id, y.id));
    let withoutHandler = 0;
    let truncated = false;
    const mwIds = new Set<string>();

    sorted.forEach((ep, i) => {
      const band = GROUP_LABEL[endpointGroup(ep)];
      b.node(ep.id, 0, { band, rank: i });
    });
    for (const ep of sorted) {
      if (b.nodes.size >= ENDPOINTS_MAX_NODES) {
        truncated = true;
        break;
      }
      const band = GROUP_LABEL[endpointGroup(ep)];
      // Middleware: Hono middleware nodes that serve it, then the names the endpoint lists itself.
      for (const e of c.snap.effectiveEdges({ dst: ep.id, kind: ["serves"] })) {
        if (c.adapters.get(e.src)?.kind !== "middleware") continue;
        b.node(e.src, MW, { band });
        b.edge(ep.id, e.src, "middleware", false);
        mwIds.add(e.src);
      }
      const named = Array.isArray(ep.data.middleware) ? ep.data.middleware.map(String) : [];
      for (const name of named) {
        const id = `mwref:${ep.ws ? (c.wsName.get(ep.ws) ?? ep.ws) : ""}:${name}`;
        if (!b.nodes.has(id)) {
          b.nodes.set(id, {
            id,
            kind: "middleware",
            label: name,
            size: 1,
            lane: MW,
            band,
            ...(ep.ws ? { workspace: ep.ws } : {}),
          });
        }
        b.edge(ep.id, id, "middleware", false);
        mwIds.add(id);
      }
      // Handler, then the calls it makes (from inside its own span when it is inline).
      const handles = c.snap.effectiveEdges({ src: ep.id, kind: ["handles"] });
      if (handles.length === 0) {
        withoutHandler++;
        const n = b.nodes.get(ep.id);
        if (n) n.badges = [...(n.badges ?? []), "no handler"];
        continue;
      }
      const span = spanOf(ep);
      let frontier: string[] = [];
      for (const h of handles) {
        b.node(h.dst, HANDLER, { band });
        b.edge(ep.id, h.dst, "handles", h.confidence === "low");
        frontier.push(h.dst);
      }
      const seen = new Set(frontier);
      for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of c.snap.effectiveEdges({ src: id, kind: ["calls"] })) {
            if (d === 1 && span && !inSpan(e, span)) continue;
            if (c.adapters.has(e.dst)) continue;
            if (b.nodes.size >= ENDPOINTS_MAX_NODES && !b.nodes.has(e.dst)) {
              truncated = true;
              continue;
            }
            b.node(e.dst, SERVICE + d - 1, { band });
            b.edge(id, e.dst, "calls", e.confidence === "low", e.count);
            if (!seen.has(e.dst)) {
              seen.add(e.dst);
              next.push(e.dst);
            }
          }
        }
        frontier = next;
      }
    }
    const { nodes, edges } = b.result();
    // A workspace of several repos: every node says which repo it is in (`mwref:` nodes are names, not code).
    if (store.listRepos().length > 1) {
      for (const n of nodes) {
        const repo = n.id.startsWith("mwref:") ? undefined : repoOfId(n.id);
        if (repo !== undefined) n.repo = repo;
      }
    }
    for (let lane = 1; lane < SERVICE + depth; lane++) labelRanks(nodes, lane);
    const lanes: Lane[] = [
      { lane: 0, label: "Endpoint" },
      { lane: MW, label: "Middleware" },
      { lane: HANDLER, label: "Handler" },
      ...Array.from({ length: depth }, (_, k) => ({
        lane: SERVICE + k,
        label: depth === 1 ? "Services" : `Services, call ${k + 1}`,
      })),
    ];
    return {
      nodes,
      edges,
      layoutHint: "elk-layered",
      lanes,
      groups: GROUP_ORDER.filter((g) => groupCounts.has(g)).map((g) => ({
        id: g,
        label: GROUP_LABEL[g],
        count: groupCounts.get(g) ?? 0,
      })),
      methods: [...new Set(all.map(endpointMethod))].sort(cmp),
      wsCounts: workspaceCounts(c, all),
      totals: {
        endpoints: all.length,
        shown: shown.length,
        middleware: mwIds.size,
        withoutHandler,
        truncated,
      },
    };
  },
};

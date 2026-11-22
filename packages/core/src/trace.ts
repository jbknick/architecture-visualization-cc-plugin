import {
  fileIdOfSymId,
  isFileId,
  isSymId,
  pathOfFileId,
  qualifyId,
  repoOfId,
  symIdOfFileId,
  tableId,
} from "./ids.js";
import { EVIDENCE_CAP } from "./resolve/index.js";
import { nodeInfo } from "./search/node.js";
import { type Store, safeRepo } from "./store/index.js";
import type { AdapterNodeRecord, EdgeKind, EdgeRecord } from "./types.js";

/**
 * Page → API → table chains (spec section 9, "Trace", #47). Read-only, synchronous and deterministic.
 *
 * Down (from a route, endpoint, symbol or file): route `serves` its component (and the route file's `Route` const,
 * which holds the loader) → `renders` / `calls` / `uses_hook` (at most 6 hops) → `requests` endpoint → `handles`
 * handler → `calls` (at most 6 hops) → `reads` / `writes` table. Up (from a table, or with `direction: "up"`): the
 * same edges backwards, to the routes. A `requests` or `handles` hop starts a new 6-hop budget.
 *
 * An endpoint whose handler is inline (`data.handlerSpan`) `handles` the code that encloses it, which also holds its
 * siblings' calls (the router object of an oRPC procedure, the function registering a Hono route). From such an
 * endpoint only the handler's outgoing `calls` / `requests` / `reads` / `writes` edges with an evidence line inside
 * the span are followed, so one procedure never reaches the tables of its siblings; going up, an endpoint is reached
 * from its handler only through such an edge. An edge whose evidence was capped (`EVIDENCE_CAP` lines, fewer than its count) and
 * shows no line inside the span is kept and reported in `gaps`, since the dropped lines may be inside it.
 *
 * The walk visits at most `maxNodes` (2,000) nodes, each once (cycles are common), in sorted edge order. The chain
 * keeps only the nodes on a path to an endpoint or table (down) or to an endpoint or route (up); `omitted` counts
 * the rest. Chain order: depth, then id.
 *
 * The walk has no repo filter: a `requests` edge whose endpoint is in another repo of the workspace, and the
 * handler's calls and table edges there, are followed like any other. When the store holds more than one repo each
 * step names its repo.
 */

export type TraceDirection = "down" | "up";

export interface TraceStep {
  id: string;
  /** Symbol kind, `file`, or the adapter node kind (`route`, `endpoint`, `table`). */
  kind: string;
  label: string;
  /** The repo the node is in; present only when the store holds more than one repo. */
  repo?: string;
  /** The edge kind it was reached by (`target` for the start node). */
  via: string;
  depth: number;
  /** The node it was reached from (absent on the start node). */
  from?: string;
  /** Present when the edge it was reached by is low confidence (a name-only or fetch match). */
  confidence?: "low";
}

export interface TraceEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: "high" | "low";
  /** A read or write written in a query file: the repo-relative path of that file (spec section 5). */
  textFile?: string;
}

export interface TraceResult {
  /** The resolved start node id. */
  target: string;
  direction: TraceDirection;
  chain: TraceStep[];
  /** The traversed edges between chain nodes, in graph direction (src → dst), sorted. */
  edges: TraceEdge[];
  /** Where the chain stops: unmatched client calls, endpoints without a handler or table, limits (in that order). */
  gaps: string[];
  /** Visited nodes not on any path to an endpoint, table or route. */
  omitted: number;
  /** True when the node budget stopped the walk. */
  truncated: boolean;
}

export interface TraceOptions {
  direction?: TraceDirection;
  /** Default 2,000. */
  maxNodes?: number;
  /** Hops of `calls` / `renders` / `uses_hook` per stage; default 6. */
  maxDepth?: number;
}

export const TRACE_MAX_NODES = 2000;
export const TRACE_MAX_DEPTH = 6;

const FRONT: ReadonlySet<string> = new Set(["calls", "renders", "uses_hook"]);
const DOWN_KINDS: EdgeKind[] = [
  "serves",
  "requests",
  "handles",
  "calls",
  "renders",
  "uses_hook",
  "reads",
  "writes",
];
const SPAN_KINDS: ReadonlySet<string> = new Set(["calls", "requests", "reads", "writes"]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Gaps that break a chain first, limits last. */
const GAP_ORDER = ["unmatched", "no resolved", "no table", "no client", "span", "node budget", "depth"];
const gapRank = (g: string): number => {
  const i = GAP_ORDER.findIndex((p) => g.startsWith(p));
  return i < 0 ? GAP_ORDER.length : i;
};

interface Span {
  start: number;
  end: number;
}

function spanOf(n: AdapterNodeRecord | undefined): Span | null {
  const s = n?.data.handlerSpan as { start?: unknown; end?: unknown } | undefined;
  return s && typeof s.start === "number" && typeof s.end === "number"
    ? { start: s.start, end: s.end }
    : null;
}

/** The `path:line` entries of an edge's evidence (an edge into another repo also carries a `sibling:<repo>` note). */
const lineEntries = (e: EdgeRecord): string[] => e.evidence.filter((x) => !x.startsWith("sibling:"));
const evidenceLines = (e: EdgeRecord): number[] =>
  lineEntries(e)
    .map((x) => Number(x.slice(x.lastIndexOf(":") + 1)))
    .filter((n) => Number.isInteger(n) && n > 0);

/** Does an edge leave the handler from inside one of the spans? `capped` when that cannot be told. Exported for its test. */
export function inSpans(e: EdgeRecord, spans: Span[]): "yes" | "no" | "capped" {
  const lines = evidenceLines(e);
  if (lines.some((l) => spans.some((s) => l >= s.start && l <= s.end))) return "yes";
  const kept = lineEntries(e).length;
  return kept >= EVIDENCE_CAP && e.count > kept ? "capped" : "no";
}

/** Resolves a target: an id (route, endpoint, table, middleware, symbol, file), a route path, an endpoint label, a table name, a file path or path:line. */
export function resolveTraceTarget(store: Store, target: string): string | null {
  const t = target.trim();
  if (t === "") return null;
  const adapters = store.effectiveAdapterNodes();
  const repo = safeRepo(store);
  const long = repo === undefined ? undefined : qualifyId(repo, t);
  if (adapters.some((n) => n.id === t)) return t;
  if (long !== undefined && adapters.some((n) => n.id === long)) return long;
  if (isSymId(t)) return store.getSymbol(t) ? t : long !== undefined && store.getSymbol(long) ? long : null;
  // A route id or URL path (`/posts/$postId`), an endpoint label (`GET /posts/:id`, `rpc posts.list`), a table name.
  const pick = (ns: AdapterNodeRecord[]): string | null =>
    ns.length > 0 ? (ns.map((n) => n.id).sort(cmp)[0] as string) : null;
  const route = pick(
    adapters.filter((n) => n.kind === "route" && (n.data.routeId === t || n.data.urlPath === t)),
  );
  if (route) return route;
  const ep = pick(adapters.filter((n) => n.kind === "endpoint" && n.label === t));
  if (ep) return ep;
  const table = pick(
    adapters.filter(
      (n) => n.kind === "table" && (n.label === t || (repo !== undefined && n.id === tableId(repo, t))),
    ),
  );
  if (table) return table;
  const info = nodeInfo(store, t);
  return info ? info.node.id : null;
}

interface Visit {
  depth: number;
  /** Hops of calls/renders/uses_hook since the last stage change. */
  local: number;
  via: string;
  from?: string;
  low: boolean;
}

/** Traces from a target; null when the target is unknown. */
export function trace(store: Store, target: string, opts: TraceOptions = {}): TraceResult | null {
  const start = resolveTraceTarget(store, target);
  if (!start) return null;
  const maxNodes = opts.maxNodes ?? TRACE_MAX_NODES;
  const maxDepth = opts.maxDepth ?? TRACE_MAX_DEPTH;
  const adapters = new Map(store.effectiveAdapterNodes().map((n) => [n.id, n]));
  const startNode = adapters.get(start);
  const direction: TraceDirection = opts.direction ?? (startNode?.kind === "table" ? "up" : "down");

  const routeByFile = new Map<string, string[]>();
  for (const n of adapters.values()) {
    if (n.kind !== "route") continue;
    routeByFile.set(n.fileId, [...(routeByFile.get(n.fileId) ?? []), n.id].sort(cmp));
  }
  const unmatchedByCaller = new Map<string, AdapterNodeRecord[]>();
  for (const n of adapters.values()) {
    if (n.kind !== "client_call" || typeof n.data.caller !== "string") continue;
    unmatchedByCaller.set(n.data.caller, [...(unmatchedByCaller.get(n.data.caller) ?? []), n]);
  }
  const kindOf = (id: string): string => {
    const a = adapters.get(id);
    if (a) return a.kind;
    if (isFileId(id)) return "file";
    return store.getSymbol(id)?.kind ?? "symbol";
  };
  const labelOf = (id: string): string => {
    const a = adapters.get(id);
    if (a) return a.label;
    if (isFileId(id)) return pathOfFileId(id);
    return store.getSymbol(id)?.name ?? id;
  };
  /** The `Route` const of a route's file: it holds the loader and any inline component. */
  const routeConst = (routeId: string): string | null => {
    const r = adapters.get(routeId);
    if (!r) return null;
    const id = symIdOfFileId(r.fileId, "Route");
    return store.getSymbol(id) ? id : null;
  };

  const visits = new Map<string, Visit>();
  const traversed = new Map<string, TraceEdge>();
  /** The store edges behind `traversed` (with evidence), for the span checks after the walk. */
  const full = new Map<string, EdgeRecord>();
  const gaps = new Set<string>();
  /** Nodes whose next calls/renders/uses_hook hop was past the limit; reported as one gap. */
  const depthStops = new Set<string>();
  let truncated = false;
  const queue: string[] = [];
  /** Spans a handler may be left through (down), from the endpoints that reached it; null = unrestricted. */
  const handlerSpans = new Map<string, Span[] | null>();
  /** Up: forward edges by which a node was reached from below (to gate reverse `handles`). */
  const arrivals = new Map<string, EdgeRecord[]>();

  const record = (e: EdgeRecord | TraceEdge) => {
    const key = `${e.src}\0${e.dst}\0${e.kind}`;
    if ("evidence" in e) full.set(key, e);
    traversed.set(key, {
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      confidence: e.confidence,
      ...("textFileId" in e && e.textFileId ? { textFile: pathOfFileId(e.textFileId) } : {}),
      ...("textFile" in e && e.textFile ? { textFile: e.textFile } : {}),
    });
  };
  const reach = (id: string, from: string, via: string, low: boolean): boolean => {
    const prev = visits.get(from) as Visit;
    const stage = !FRONT.has(via);
    const local = stage ? 0 : prev.local + 1;
    if (!stage && local > maxDepth) {
      depthStops.add(from);
      return false;
    }
    if (visits.has(id)) return true;
    if (visits.size >= maxNodes) {
      truncated = true;
      return false;
    }
    visits.set(id, { depth: prev.depth + 1, local, via, from, low });
    queue.push(id);
    return true;
  };

  visits.set(start, { depth: 0, local: 0, via: "target", low: false });
  queue.push(start);

  const sortEdges = (es: EdgeRecord[]): EdgeRecord[] =>
    [...es].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.dst, b.dst) || cmp(a.src, b.src));

  if (direction === "down") {
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi] as string;
      const node = adapters.get(id);
      if (node?.kind === "route") {
        const rc = routeConst(id);
        if (rc && reach(rc, id, "serves", false))
          record({ src: id, dst: rc, kind: "serves", confidence: "high" });
      }
      for (const u of unmatchedByCaller.get(id) ?? []) {
        gaps.add(
          `unmatched client call "${u.label}" (${u.data.reason}) in ${id} at ${u.data.file}:${u.data.line}`,
        );
      }
      const spans = handlerSpans.get(id);
      const out = sortEdges(store.effectiveEdges({ src: id, kind: DOWN_KINDS }));
      let handled = false;
      for (const e of out) {
        // `serves` from a route only (middleware also serves endpoints); requests/handles start a stage.
        if (e.kind === "serves" && node?.kind !== "route") continue;
        if (e.kind === "handles") handled = true;
        if (spans && SPAN_KINDS.has(e.kind)) {
          const s = inSpans(e, spans);
          if (s === "no") continue;
          if (s === "capped") gaps.add(`span check incomplete (evidence capped) for ${e.src} -> ${e.dst}`);
        }
        if (e.kind === "handles") {
          const span = spanOf(node);
          const prev = handlerSpans.get(e.dst);
          const seen = visits.has(e.dst);
          if (span === null) handlerSpans.set(e.dst, null);
          else if (prev !== null) handlerSpans.set(e.dst, [...(prev ?? []), span]);
          // A handler already expanded under narrower spans is expanded again for the new span.
          if (seen && prev !== undefined && prev !== null) queue.push(e.dst);
        }
        if (reach(e.dst, id, e.kind, e.confidence === "low")) record(e);
      }
      if (node?.kind === "endpoint" && !handled) gaps.add(`no resolved handler for ${id}`);
      if (truncated) break;
    }
  } else {
    const UP_KINDS: EdgeKind[] = [
      "reads",
      "writes",
      "calls",
      "renders",
      "uses_hook",
      "handles",
      "requests",
      "serves",
    ];
    /** Reverse `handles` from `h`: endpoints whose (inline) handler span `h` was left through. */
    const endpointsOf = (h: string) => {
      for (const e of sortEdges(store.effectiveEdges({ dst: h, kind: ["handles"] }))) {
        const span = spanOf(adapters.get(e.src));
        if (span && h !== start) {
          const ok = (arrivals.get(h) ?? []).some((a) => inSpans(a, [span]) !== "no");
          if (!ok) continue;
        }
        if (reach(e.src, h, "handles", false)) record(e);
      }
    };
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi] as string;
      const node = adapters.get(id);
      const inc = [...store.effectiveEdges({ dst: id, kind: UP_KINDS })].sort(
        (a, b) => cmp(a.kind, b.kind) || cmp(a.src, b.src),
      );
      for (const e of inc) {
        if (e.kind === "handles") continue;
        if (e.kind === "serves" && adapters.get(e.src)?.kind !== "route") continue;
        const known = visits.has(e.src);
        if (SPAN_KINDS.has(e.kind)) {
          const list = arrivals.get(e.src) ?? [];
          list.push(e);
          arrivals.set(e.src, list);
        }
        if (reach(e.src, id, e.kind, e.confidence === "low")) record(e);
        // A handler reached again through another edge may now open a sibling's endpoint.
        if (known && SPAN_KINDS.has(e.kind)) endpointsOf(e.src);
      }
      endpointsOf(id);
      // The `Route` const of a route file leads to its route.
      if (id.endsWith("#Route")) {
        const fileId = fileIdOfSymId(id) as string;
        for (const r of routeByFile.get(fileId) ?? []) {
          if (reach(r, id, "serves", false)) record({ src: r, dst: id, kind: "serves", confidence: "high" });
        }
      }
      if (node?.kind === "endpoint" && store.effectiveEdges({ dst: id, kind: ["requests"] }).length === 0) {
        gaps.add(`no client call found for ${id}`);
      }
      if (truncated) break;
    }
  }
  if (truncated) gaps.add(`node budget (${maxNodes}) reached; the chain is incomplete`);
  if (depthStops.size > 0) {
    const first = [...depthStops].sort(cmp).slice(0, 3).join(", ");
    gaps.add(`depth limit (${maxDepth} hops) reached at ${depthStops.size} nodes, first: ${first}`);
  }

  // Keep the nodes on a path to a sink, over the traversed edges.
  const sinks = direction === "down" ? new Set(["endpoint", "table"]) : new Set(["endpoint", "route"]);
  const parentsOf = new Map<string, string[]>();
  for (const e of traversed.values()) {
    const [a, b] = direction === "down" ? [e.src, e.dst] : [e.dst, e.src];
    parentsOf.set(b, [...(parentsOf.get(b) ?? []), a]);
  }
  const keep = new Set<string>();
  const stack = [...visits.keys()].filter((id) => sinks.has(kindOf(id)));
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const p of parentsOf.get(id) ?? []) if (visits.has(p)) stack.push(p);
  }
  keep.add(start);

  if (direction === "down") {
    // An endpoint that reaches no table within the limits (following only its own handler's span).
    const out = new Map<string, EdgeRecord[]>();
    for (const e of full.values()) out.set(e.src, [...(out.get(e.src) ?? []), e]);
    for (const id of [...keep].sort(cmp)) {
      if (kindOf(id) !== "endpoint") continue;
      const span = spanOf(adapters.get(id));
      const handlers = new Set((out.get(id) ?? []).filter((e) => e.kind === "handles").map((e) => e.dst));
      const seen = new Set<string>([id]);
      const st = [id];
      let table = false;
      while (st.length > 0 && !table) {
        const x = st.pop() as string;
        for (const e of out.get(x) ?? []) {
          if (e.kind === "requests" || seen.has(e.dst)) continue;
          if (span && handlers.has(x) && inSpans(e, [span]) === "no") continue;
          if (e.kind === "reads" || e.kind === "writes") table = true;
          seen.add(e.dst);
          st.push(e.dst);
        }
      }
      if (!table) gaps.add(`no table reached from ${id}`);
    }
  }

  const multiRepo = store.listRepos().length > 1;
  const chain: TraceStep[] = [...keep]
    .map((id) => {
      const v = visits.get(id) as Visit;
      const repo = multiRepo ? repoOfId(id) : undefined;
      return {
        id,
        kind: kindOf(id),
        label: labelOf(id),
        ...(repo !== undefined ? { repo } : {}),
        via: v.via,
        depth: v.depth,
        ...(v.from !== undefined ? { from: v.from } : {}),
        ...(v.low ? { confidence: "low" as const } : {}),
      };
    })
    .sort((a, b) => a.depth - b.depth || cmp(a.id, b.id));
  const edges = [...traversed.values()]
    .filter((e) => keep.has(e.src) && keep.has(e.dst))
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
  return {
    target: start,
    direction,
    chain,
    edges,
    gaps: [...gaps].sort((a, b) => gapRank(a) - gapRank(b) || cmp(a, b)),
    omitted: visits.size - keep.size,
    truncated,
  };
}

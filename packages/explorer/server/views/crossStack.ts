import {
  type AdapterNodeRecord,
  type FileRecord,
  type Store,
  snapshotOf,
  type TraceEdge,
  type TraceResult,
  trace,
} from "@gantry/core";
import type { ApiContext, GraphEdge, GraphNode, ViewParams } from "../types.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, optList } from "./options.js";

/**
 * Shared parts of the cross-stack views (#48): endpoints, page -> API, API -> tables, feature path, table usage.
 * They read the adapter nodes (routes, endpoints, middleware, tables, unmatched client calls) and `trace`
 * (spec section 9) over an in-memory snapshot of the store (`snapshotOf`), so tracing every route or endpoint costs
 * one load of the edges instead of a query per visited node.
 */

/** A lane (column or swimlane) title, sent with the view so the canvas can label it. */
export interface Lane {
  lane: number;
  label: string;
}

export interface WorkspaceCount {
  id: string;
  name: string;
  shortLabel: string;
  count: number;
}

/** Endpoint groups of the endpoints view and their filter values. */
export type EndpointGroup = "rpc" | "http" | "fn";
export const GROUP_LABEL: Record<EndpointGroup, string> = { rpc: "rpc", http: "http", fn: "server fn" };
export const GROUP_ORDER: EndpointGroup[] = ["rpc", "http", "fn"];

export interface CrossCtx {
  store: Store;
  snap: Store;
  adapters: Map<string, AdapterNodeRecord>;
  byKind: Map<string, AdapterNodeRecord[]>;
  files: Map<string, FileRecord>;
  wsName: Map<string, string>;
  wsShort: Map<string, string>;
  traceCache: Map<string, TraceResult | null>;
}

const contexts = new WeakMap<Store, { generation: string; ctx: CrossCtx }>();

/** The cross-stack context of the store's current generation (cached like the snapshot it wraps). */
export function crossCtx(store: Store): CrossCtx {
  const gen = store.generation();
  const cur = contexts.get(store);
  if (cur && cur.generation === gen) return cur.ctx;
  const snap = snapshotOf(store);
  const nodes = snap.effectiveAdapterNodes();
  const byKind = new Map<string, AdapterNodeRecord[]>();
  for (const n of nodes) {
    let list = byKind.get(n.kind);
    if (!list) {
      list = [];
      byKind.set(n.kind, list);
    }
    list.push(n);
  }
  const workspaces = store.listWorkspaces();
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const short = shortWorkspaceLabels(workspaces.map((w) => w.name));
  const ctx: CrossCtx = {
    store,
    snap,
    adapters: new Map(nodes.map((n) => [n.id, n])),
    byKind,
    files: new Map(snap.effectiveFiles().map((f) => [f.id, f])),
    wsName,
    wsShort: new Map(workspaces.map((w) => [w.id, short.get(w.name) ?? w.name])),
    traceCache: new Map(),
  };
  contexts.set(store, { generation: gen, ctx });
  return ctx;
}

/** `trace` over the snapshot, memoised per generation. */
export function traceOf(c: CrossCtx, id: string, direction: "down" | "up"): TraceResult | null {
  const key = `${direction}\0${id}`;
  if (!c.traceCache.has(key)) c.traceCache.set(key, trace(c.snap, id, { direction }));
  return c.traceCache.get(key) ?? null;
}

/** How many adapter nodes of each kind the index holds (`/api/meta` decides the tabs from it). */
export function adapterCounts(store: Store): Record<string, number> {
  const c = crossCtx(store);
  const out: Record<string, number> = {};
  for (const [k, list] of c.byKind) out[k] = list.length;
  return out;
}

/** `enabled` for a cross-stack view: true when the index holds adapter nodes of every listed kind. */
export function needsKinds(...kinds: string[]): (ctx: ApiContext) => boolean {
  return ({ store }) => {
    const counts = adapterCounts(store);
    return kinds.every((k) => (counts[k] ?? 0) > 0);
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function endpointGroup(n: AdapterNodeRecord): EndpointGroup {
  const a = n.data.adapter;
  return a === "orpc" ? "rpc" : a === "tanstack-start" ? "fn" : "http";
}

/** GET / POST / ..., `RPC` for an oRPC procedure without an OpenAPI route. */
export function endpointMethod(n: AdapterNodeRecord): string {
  if (n.data.adapter === "orpc") {
    const route = n.data.route as { method?: unknown } | undefined;
    return str(route?.method)?.toUpperCase() ?? "RPC";
  }
  return (str(n.data.method) ?? "ALL").toUpperCase();
}

/** The URL path an endpoint answers on, or the server function's name. */
export function endpointPath(n: AdapterNodeRecord): string {
  const d = n.data;
  if (d.adapter === "orpc") {
    const route = d.route as { path?: unknown } | undefined;
    const p = str(route?.path);
    if (p) return `${str(d.mountedAt) ?? ""}${p}`;
    const dotted = str(d.path) ?? "";
    return `${str(d.mountedAt) ?? ""}/${dotted.replaceAll(".", "/")}`;
  }
  if (d.adapter === "tanstack-start") return str(d.name) ?? n.label;
  return str(d.path) ?? n.label;
}

/** Workspace filter (`ws`: ids or package names). */
export function wsFilter(c: CrossCtx, params: ViewParams): (ws: string | null) => boolean {
  const list = optList(params, "ws") ?? optList(params, "app");
  if (!list || list.length === 0) return () => true;
  return (ws) => ws !== null && (list.includes(ws) || list.includes(c.wsName.get(ws) ?? ""));
}

/** Endpoint filters shared by the endpoints and API -> tables views: `ws`, `kind`, `method`, `prefix`. */
export function endpointFilter(c: CrossCtx, params: ViewParams): (n: AdapterNodeRecord) => boolean {
  const ws = wsFilter(c, params);
  const kinds = optList(params, "kind");
  const methods = optList(params, "method")?.map((m) => m.toUpperCase());
  const rawPrefix = params.options?.prefix;
  const prefix = typeof rawPrefix === "string" ? rawPrefix.trim() : "";
  return (n) => {
    if (!ws(n.ws)) return false;
    if (kinds && kinds.length > 0 && !kinds.includes(endpointGroup(n))) return false;
    if (methods && methods.length > 0 && !methods.includes(endpointMethod(n))) return false;
    if (prefix) {
      const dotted = str(n.data.path) ?? "";
      const bare = n.label.replace(/^(rpc|fn|[A-Z]+) /, "");
      if (![endpointPath(n), dotted, bare].some((p) => p.startsWith(prefix))) return false;
    }
    return true;
  };
}

export function workspaceCounts(c: CrossCtx, nodes: AdapterNodeRecord[]): WorkspaceCount[] {
  const counts = new Map<string, number>();
  for (const n of nodes) if (n.ws) counts.set(n.ws, (counts.get(n.ws) ?? 0) + 1);
  return [...counts]
    .map(([id, count]) => ({
      id,
      name: c.wsName.get(id) ?? id,
      shortLabel: c.wsShort.get(id) ?? id,
      count,
    }))
    .sort((a, b) => cmp(a.id, b.id));
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** A drawn node for any id the cross-stack views meet: an adapter node, a symbol or a file. */
export function describeNode(c: CrossCtx, id: string): GraphNode {
  const a = c.adapters.get(id);
  if (a) {
    const badges: string[] = [];
    if (a.kind === "endpoint") badges.push(GROUP_LABEL[endpointGroup(a)], endpointMethod(a));
    if (a.kind === "table" && str(a.data.dialect)) badges.push(str(a.data.dialect) as string);
    if (a.kind === "route") {
      if (a.data.root === true) badges.push("root layout");
      else if (a.data.pathless === true) badges.push("layout");
    }
    return {
      id,
      kind: a.kind,
      label: a.label,
      size: 1,
      ...(str(a.data.file)
        ? { path: str(a.data.file) }
        : str(a.data.path) && a.kind === "route"
          ? { path: str(a.data.path) }
          : {}),
      ...(a.ws ? { workspace: a.ws } : {}),
      ...(badges.length > 0 ? { badges } : {}),
    };
  }
  if (id.startsWith("file:")) {
    const f = c.files.get(id);
    return {
      id,
      kind: "file",
      label: baseName(id.slice(5)),
      size: 1,
      path: id.slice(5),
      ...(f?.workspaceId ? { workspace: f.workspaceId } : {}),
    };
  }
  const s = c.snap.getSymbol(id);
  const f = s ? c.files.get(s.fileId) : undefined;
  return {
    id,
    kind: s?.kind ?? "symbol",
    label: s?.name ?? id.slice(id.lastIndexOf("#") + 1),
    size: 1,
    ...(f ? { path: f.path } : {}),
    ...(f?.workspaceId ? { workspace: f.workspaceId } : {}),
    ...(s ? { stats: { functions: 1, loc: s.loc } } : {}),
  };
}

/** Collects nodes and edges once each, merging repeated edges (weight summed, low only if every one is low). */
export class FlowBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge & { highSeen: boolean }>();
  constructor(private readonly c: CrossCtx) {}

  node(id: string, lane: number, extra: Partial<GraphNode> = {}): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { ...describeNode(this.c, id), lane, ...extra };
      this.nodes.set(id, n);
    }
    return n;
  }

  edge(src: string, dst: string, kind: string, low: boolean, weight = 1): GraphEdge {
    const id = `${src}|${kind}|${dst}`;
    let e = this.edges.get(id);
    if (!e) {
      e = { id, src, dst, kind, weight: 0, confidence: "low", highSeen: false };
      this.edges.set(id, e);
    }
    e.weight += weight;
    if (!low) e.highSeen = true;
    e.confidence = e.highSeen ? "high" : "low";
    return e;
  }

  traceEdge(e: TraceEdge): GraphEdge {
    return this.edge(e.src, e.dst, e.kind, e.confidence === "low");
  }

  /** Sorted, with ranks unset filled in (by label then id within each lane). */
  result(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [...this.nodes.values()].sort((a, b) => cmp(a.id, b.id));
    const edges = [...this.edges.values()]
      .filter((e) => this.nodes.has(e.src) && this.nodes.has(e.dst))
      .map(({ highSeen: _h, ...e }) => e)
      .sort((a, b) => cmp(a.id, b.id));
    return { nodes, edges };
  }
}

/** Rank the nodes of `lane` by the mean rank of their neighbours in `fromLane` (barycentre), ties by label. */
export function barycentreRanks(
  nodes: GraphNode[],
  edges: GraphEdge[],
  lane: number,
  fromLane: number,
): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sums = new Map<string, { s: number; k: number }>();
  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (!a || !b) continue;
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      if (me.lane !== lane || other.lane !== fromLane || other.rank === undefined) continue;
      const cur = sums.get(me.id) ?? { s: 0, k: 0 };
      cur.s += other.rank;
      cur.k += 1;
      sums.set(me.id, cur);
    }
  }
  const inLane = nodes.filter((n) => n.lane === lane);
  const key = (n: GraphNode) => {
    const v = sums.get(n.id);
    return v ? v.s / v.k : Number.POSITIVE_INFINITY;
  };
  inLane
    .sort((a, b) => key(a) - key(b) || cmp(a.label, b.label) || cmp(a.id, b.id))
    .forEach((n, i) => {
      n.rank = i;
    });
}

/** Rank the nodes of a lane by label then id. */
export function labelRanks(nodes: GraphNode[], lane: number): void {
  nodes
    .filter((n) => n.lane === lane)
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id))
    .forEach((n, i) => {
      n.rank = i;
    });
}

/**
 * The code a route's page uses before any endpoint (its component tree, its `Route` const and loader), from a down
 * trace: the start plus every node reached through `serves`, `renders`, `calls` or `uses_hook` without passing an
 * endpoint.
 */
export function frontSet(t: TraceResult): Set<string> {
  const kindOf = new Map(t.chain.map((s) => [s.id, s.kind]));
  const out = new Map<string, TraceEdge[]>();
  for (const e of t.edges) {
    let list = out.get(e.src);
    if (!list) {
      list = [];
      out.set(e.src, list);
    }
    list.push(e);
  }
  const front = new Set([t.target]);
  const stack = [t.target];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const e of out.get(id) ?? []) {
      if (e.kind === "requests" || e.kind === "handles" || e.kind === "reads" || e.kind === "writes")
        continue;
      const k = kindOf.get(e.dst);
      if (k === "endpoint" || k === "table" || front.has(e.dst)) continue;
      front.add(e.dst);
      stack.push(e.dst);
    }
  }
  return front;
}

export interface EndpointTables {
  endpoint: string;
  /** Code between the endpoint and the database call, the handler first (`own` in API -> tables). */
  services: string[];
  /** Sources of the read/write edges. */
  dbCallers: string[];
  reads: string[];
  writes: string[];
  /** Edges of the endpoint's own part of its trace (no other endpoint's handler). */
  edges: TraceEdge[];
  /** Hops from the endpoint to each service node. */
  hops: Map<string, number>;
}

/**
 * The tables an endpoint itself reads and writes: its down trace without the parts reached through another endpoint
 * (a `requests` edge from server code), and only the code on a path from the endpoint to a read or write.
 */
export function endpointTables(c: CrossCtx, endpoint: string): EndpointTables {
  const t = traceOf(c, endpoint, "down");
  const empty: EndpointTables = {
    endpoint,
    services: [],
    dbCallers: [],
    reads: [],
    writes: [],
    edges: [],
    hops: new Map(),
  };
  if (!t) return empty;
  const kindOf = new Map(t.chain.map((s) => [s.id, s.kind]));
  const out = new Map<string, TraceEdge[]>();
  for (const e of t.edges) {
    if (e.kind === "requests") continue;
    let list = out.get(e.src);
    if (!list) {
      list = [];
      out.set(e.src, list);
    }
    list.push(e);
  }
  // Forward: what the endpoint reaches without entering another endpoint.
  const hops = new Map<string, number>([[endpoint, 0]]);
  const queue = [endpoint];
  const own: TraceEdge[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const e of out.get(id) ?? []) {
      if (kindOf.get(e.dst) === "endpoint") continue;
      own.push(e);
      if (!hops.has(e.dst)) {
        hops.set(e.dst, (hops.get(id) as number) + 1);
        if (kindOf.get(e.dst) !== "table") queue.push(e.dst);
      }
    }
  }
  // Backward from the read/write edges: keep only the code on a path to a table.
  const db = own.filter((e) => e.kind === "reads" || e.kind === "writes");
  const into = new Map<string, TraceEdge[]>();
  for (const e of own) {
    let list = into.get(e.dst);
    if (!list) {
      list = [];
      into.set(e.dst, list);
    }
    list.push(e);
  }
  const onPath = new Set<string>();
  const stack = db.map((e) => e.src);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (onPath.has(id) || id === endpoint) continue;
    onPath.add(id);
    for (const e of into.get(id) ?? []) stack.push(e.src);
  }
  const keep = new Set([endpoint, ...onPath]);
  const edges = own.filter(
    (e) => keep.has(e.src) && (keep.has(e.dst) || e.kind === "reads" || e.kind === "writes"),
  );
  const uniq = (xs: string[]) => [...new Set(xs)].sort(cmp);
  return {
    endpoint,
    services: [...onPath].sort((a, b) => (hops.get(a) ?? 0) - (hops.get(b) ?? 0) || cmp(a, b)),
    dbCallers: uniq(db.map((e) => e.src)),
    reads: uniq(db.filter((e) => e.kind === "reads").map((e) => e.dst)),
    writes: uniq(db.filter((e) => e.kind === "writes").map((e) => e.dst)),
    edges,
    hops,
  };
}

/** Focus choices for the feature path and table usage views when no focus is given. */
export interface FocusChoice {
  id: string;
  label: string;
  kind: string;
  /** What it is grouped under in the picker: the app, the endpoint group, the table's package. */
  group: string;
  /** A short count line ("3 endpoints", "2 writers · 5 readers"). */
  note?: string;
}

export function groupOfWs(c: CrossCtx, ws: string | null): string {
  return ws ? (c.wsShort.get(ws) ?? ws) : "(no workspace)";
}

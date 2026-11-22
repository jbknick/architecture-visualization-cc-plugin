import { repoOfId, resolveTraceTarget, type TraceResult } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { ViewModule, ViewResult } from "../types.js";
import {
  barycentreRanks,
  type CrossCtx,
  crossCtx,
  endpointGroup,
  FlowBuilder,
  type FocusChoice,
  GROUP_LABEL,
  groupOfWs,
  type Lane,
  labelRanks,
  needsKinds,
  traceOf,
} from "./crossStack.js";
import { cmp } from "./options.js";

export const FEATURE_MAX_NODES = 600;

export const PAGE = 0;
export const CLIENT = 1;
export const ENDPOINT = 2;
export const SERVICE = 3;
export const TABLE = 4;

export interface FeaturePathResult extends ViewResult {
  lanes: Lane[];
  /** Set when no `focus` was given: the routes and endpoints to pick from, and nothing to draw. */
  choices?: FocusChoice[];
  focus: string | null;
  gaps: string[];
  truncated: boolean;
  totals: { routes: number; endpoints: number; tables: number; steps: number };
}

const LANES: Lane[] = [
  { lane: PAGE, label: "Page" },
  { lane: CLIENT, label: "Client" },
  { lane: ENDPOINT, label: "Endpoint" },
  { lane: SERVICE, label: "Service" },
  { lane: TABLE, label: "Table" },
];

/** Lane of each chain node of a trace: by kind, and for code by which side of an endpoint it sits on. */
function lanesOf(t: TraceResult): Map<string, number> {
  const byId = new Map(t.chain.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  const fixed = (kind: string): number | null =>
    kind === "route" ? PAGE : kind === "endpoint" ? ENDPOINT : kind === "table" ? TABLE : null;
  if (t.direction === "down") {
    // Code below an endpoint (its from-chain to the start passes one) is service code; the rest is the page's.
    for (const s of t.chain) {
      const f = fixed(s.kind);
      if (f !== null) {
        out.set(s.id, f);
        continue;
      }
      let server = false;
      for (let p = s.from; p !== undefined; p = byId.get(p)?.from) {
        if (byId.get(p)?.kind === "endpoint") {
          server = true;
          break;
        }
      }
      out.set(s.id, server ? SERVICE : CLIENT);
    }
  } else {
    // Up: code between another endpoint and the start (a handler calling the start) is service code.
    const service = new Set<string>();
    for (const s of t.chain) {
      if (s.kind !== "endpoint" || s.id === t.target) continue;
      for (let p = s.from; p !== undefined && p !== t.target; p = byId.get(p)?.from) service.add(p);
    }
    for (const s of t.chain) out.set(s.id, fixed(s.kind) ?? (service.has(s.id) ? SERVICE : CLIENT));
  }
  return out;
}

function choicesOf(c: CrossCtx): FocusChoice[] {
  const out: FocusChoice[] = [];
  for (const r of c.byKind.get("route") ?? [])
    out.push({ id: r.id, label: r.label, kind: "route", group: `Pages · ${groupOfWs(c, r.ws)}` });
  for (const e of c.byKind.get("endpoint") ?? [])
    out.push({
      id: e.id,
      label: e.label,
      kind: "endpoint",
      group: `Endpoints · ${GROUP_LABEL[endpointGroup(e)]}`,
    });
  return out.sort((a, b) => cmp(a.group, b.group) || cmp(a.label, b.label) || cmp(a.id, b.id));
}

/**
 * View 10. Full feature path (#48, hint `elk-layered` with swimlanes page / client / endpoint / service / table).
 * Needs `focus`: a route or an endpoint (an id, a URL path or an endpoint label, as `gantry trace` takes). From a
 * route the path is its down `trace`; from an endpoint the down trace plus the up trace (the pages and client code
 * that request it). Every chain node is drawn in its lane and every traversed edge between them. Without a focus the
 * response has no nodes and lists `choices`. At most 600 nodes (`truncated`); `gaps` are the traces' own.
 */
export const featurePathView: ViewModule = {
  id: "feature-path",
  title: "Feature path",
  enabled: needsKinds("endpoint"),
  disabledReason: "No endpoints found: this view follows a page to its endpoints and tables.",
  build({ store }, params): FeaturePathResult {
    const c = crossCtx(store);
    const empty = {
      nodes: [],
      edges: [],
      layoutHint: "elk-layered" as const,
      lanes: LANES,
      gaps: [],
      truncated: false,
    };
    if (!params.focus) {
      return {
        ...empty,
        focus: null,
        choices: choicesOf(c),
        totals: { routes: 0, endpoints: 0, tables: 0, steps: 0 },
      };
    }
    const id = resolveTraceTarget(c.snap, params.focus);
    if (!id) throw new HttpError(404, `Unknown focus: ${params.focus}`);
    const kind = c.adapters.get(id)?.kind;
    if (kind !== "route" && kind !== "endpoint")
      throw new HttpError(
        400,
        "focus must be a route or an endpoint (the table usage view starts from a table)",
      );
    const traces = [traceOf(c, id, "down")];
    if (kind === "endpoint") traces.push(traceOf(c, id, "up"));
    const b = new FlowBuilder(c);
    const gaps = new Set<string>();
    let truncated = false;
    for (const t of traces) {
      if (!t) continue;
      if (t.truncated) truncated = true;
      for (const g of t.gaps) gaps.add(g);
      const lanes = lanesOf(t);
      for (const s of t.chain) {
        if (b.nodes.has(s.id)) continue;
        if (b.nodes.size >= FEATURE_MAX_NODES) {
          truncated = true;
          continue;
        }
        const n = b.node(s.id, lanes.get(s.id) ?? CLIENT);
        if (s.id === id) n.badges = [...(n.badges ?? []), "focus"];
      }
      for (const e of t.edges) b.traceEdge(e);
    }
    const { nodes, edges } = b.result();
    // A workspace of several repos: a path can cross from a page to a handler in another repo, so each node names its repo.
    if (store.listRepos().length > 1) {
      for (const n of nodes) {
        const repo = repoOfId(n.id);
        if (repo !== undefined) n.repo = repo;
      }
    }
    labelRanks(nodes, PAGE);
    for (const lane of [CLIENT, ENDPOINT, SERVICE, TABLE]) barycentreRanks(nodes, edges, lane, lane - 1);
    const count = (k: string) => nodes.filter((n) => n.kind === k).length;
    return {
      ...empty,
      nodes,
      edges,
      focus: id,
      gaps: [...gaps].slice(0, 40),
      truncated,
      totals: {
        routes: count("route"),
        endpoints: count("endpoint"),
        tables: count("table"),
        steps: nodes.length,
      },
    };
  },
};

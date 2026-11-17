import { resolveTraceTarget, type TraceStep } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { ViewModule, ViewResult } from "../types.js";
import {
  type CrossCtx,
  crossCtx,
  FlowBuilder,
  type FocusChoice,
  groupOfWs,
  type Lane,
  needsKinds,
  traceOf,
} from "./crossStack.js";
import { cmp } from "./options.js";

export const TABLE_USAGE_MAX_NODES = 600;

export interface TableUsageResult extends ViewResult {
  lanes: Lane[];
  choices?: FocusChoice[];
  focus: string | null;
  table: { name: string; columns: string[]; dialect: string | null } | null;
  gaps: string[];
  truncated: boolean;
  totals: { writers: number; readers: number; endpoints: number; routes: number; steps: number };
}

/** Readers and writers of each table (distinct code holding the calls), from the `reads` / `writes` edges. */
export function tableUsers(c: CrossCtx, table: string): { readers: string[]; writers: string[] } {
  const into = c.snap.effectiveEdges({ dst: table, kind: ["reads", "writes"] });
  const uniq = (xs: string[]) => [...new Set(xs)].sort(cmp);
  return {
    readers: uniq(into.filter((e) => e.kind === "reads").map((e) => e.src)),
    writers: uniq(into.filter((e) => e.kind === "writes").map((e) => e.src)),
  };
}

function choicesOf(c: CrossCtx): FocusChoice[] {
  return (c.byKind.get("table") ?? [])
    .map((t) => {
      const u = tableUsers(c, t.id);
      return {
        id: t.id,
        label: t.label,
        kind: "table",
        group: `Tables · ${groupOfWs(c, t.ws)}`,
        note: `${u.writers.length} ${u.writers.length === 1 ? "writer" : "writers"} · ${u.readers.length} ${u.readers.length === 1 ? "reader" : "readers"}`,
      };
    })
    .sort((a, b) => cmp(a.group, b.group) || cmp(a.label, b.label));
}

/**
 * View 11. Table usage (#48, hint `tree-lr`, reversed: the table on the right). Needs `focus` = a table (id or name).
 * Built from the table's up `trace`: the code that writes it, then the code that reads it, then their callers up to
 * the endpoints that handle them and the pages that request those. A node's lane is its distance from the table
 * counted from the right (`lane = deepest - depth`); inside a lane nodes follow their tree parent (`chain[].from`),
 * writers' subtrees above readers'. Edges are the trace's (graph direction, so arrows point at the table).
 */
export const tableUsageView: ViewModule = {
  id: "table-usage",
  title: "Table usage",
  enabled: needsKinds("table"),
  disabledReason: "No tables found: this view reads Drizzle table definitions.",
  build({ store }, params): TableUsageResult {
    const c = crossCtx(store);
    const base = {
      nodes: [],
      edges: [],
      layoutHint: "tree-lr" as const,
      gaps: [],
      truncated: false,
      table: null,
    };
    const zero = { writers: 0, readers: 0, endpoints: 0, routes: 0, steps: 0 };
    if (!params.focus) return { ...base, lanes: [], focus: null, choices: choicesOf(c), totals: zero };
    const id = resolveTraceTarget(c.snap, params.focus);
    if (!id) throw new HttpError(404, `Unknown focus: ${params.focus}`);
    const tableNode = c.adapters.get(id);
    if (tableNode?.kind !== "table") throw new HttpError(400, "focus must be a table");
    const t = traceOf(c, id, "up");
    if (!t) throw new HttpError(404, `Unknown focus: ${params.focus}`);
    const users = tableUsers(c, id);
    const writers = new Set(users.writers);

    // Tree order: children of each node by writer-first (depth 1), then label; a pre-order walk gives the ranks.
    const kids = new Map<string, TraceStep[]>();
    for (const s of t.chain) {
      if (s.from === undefined) continue;
      let list = kids.get(s.from);
      if (!list) {
        list = [];
        kids.set(s.from, list);
      }
      list.push(s);
    }
    const seq = new Map<string, number>();
    const walk = (nodeId: string) => {
      seq.set(nodeId, seq.size);
      const list = (kids.get(nodeId) ?? []).sort(
        (a, b) =>
          Number(writers.has(b.id)) - Number(writers.has(a.id)) || cmp(a.label, b.label) || cmp(a.id, b.id),
      );
      for (const k of list) if (!seq.has(k.id)) walk(k.id);
    };
    walk(id);
    const steps = [...t.chain].sort((a, b) => (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0));
    const kept = steps.slice(0, TABLE_USAGE_MAX_NODES);
    const deepest = Math.max(1, ...kept.map((s) => s.depth));
    const b = new FlowBuilder(c);
    for (const s of kept) {
      const n = b.node(s.id, deepest - s.depth, { rank: seq.get(s.id) ?? 0 });
      if (s.depth === 1) {
        const role = writers.has(s.id)
          ? users.readers.includes(s.id)
            ? "writes · reads"
            : "writes"
          : "reads";
        n.badges = [...(n.badges ?? []), role];
      }
    }
    for (const e of t.edges) b.traceEdge(e);
    // The trace keeps only code on a path to an endpoint or page; every direct reader and writer is drawn anyway.
    let extra = seq.size;
    for (const e of c.snap
      .effectiveEdges({ dst: id, kind: ["writes", "reads"] })
      .sort((x, y) => cmp(y.kind, x.kind) || cmp(x.src, y.src))) {
      if (!b.nodes.has(e.src)) {
        const role = writers.has(e.src)
          ? users.readers.includes(e.src)
            ? "writes · reads"
            : "writes"
          : "reads";
        const n = b.node(e.src, Math.max(0, deepest - 1), { rank: extra++ });
        n.badges = [...(n.badges ?? []), role, "no endpoint"];
      }
      if (!b.edges.has(`${e.src}|${e.kind}|${e.dst}`)) b.edge(e.src, e.dst, e.kind, e.confidence === "low");
    }
    const { nodes, edges } = b.result();
    const lanes: Lane[] = [];
    const laneTitle = (lane: number): string => {
      const d = deepest - lane;
      if (d === 0) return "Table";
      if (d === 1) return "Writes / reads it";
      return `${d} steps away`;
    };
    for (let lane = 0; lane <= deepest; lane++) lanes.push({ lane, label: laneTitle(lane) });
    const count = (k: string) => nodes.filter((n) => n.kind === k).length;
    const d = tableNode.data;
    return {
      ...base,
      nodes,
      edges,
      lanes,
      focus: id,
      table: {
        name: tableNode.label,
        columns: Array.isArray(d.columns) ? d.columns.map(String) : [],
        dialect: typeof d.dialect === "string" ? d.dialect : null,
      },
      gaps: t.gaps.slice(0, 40),
      truncated: t.truncated || steps.length > kept.length,
      totals: {
        writers: users.writers.length,
        readers: users.readers.length,
        endpoints: count("endpoint"),
        routes: count("route"),
        steps: nodes.length,
      },
    };
  },
};

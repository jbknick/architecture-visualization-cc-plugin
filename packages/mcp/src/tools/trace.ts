import { type TraceResult, trace } from "@gantry/core";
import { z } from "zod";
import { MAX_RESPONSE_CHARS } from "../envelope.js";
import { defineTool } from "../tool.js";

/** Caps that keep a response inside the 4,000-character limit; totals are always reported. */
export const TRACE_LIMITS = { gaps: 8, gapText: 200, budget: MAX_RESPONSE_CHARS - 200 } as const;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const ENDS = new Set(["route", "endpoint", "table"]);

interface Step {
  id: string;
  kind: string;
  via: string;
  depth: number;
  from?: string;
  low?: true;
}

/**
 * The MCP shape of a trace: the routes, endpoints and tables it reached, then the chain. When the chain does not fit,
 * the steps between them (components, hooks, helpers) are summarised as repeats `{ depth, via, kind, count, sample }`
 * and the lists are cut, with totals. Ids, kinds and edge kinds only: no description text.
 */
export function shapeTrace(r: TraceResult, budget: number = TRACE_LIMITS.budget) {
  const steps: Step[] = r.chain.map((s) => ({
    id: s.id,
    kind: s.kind,
    via: s.via,
    depth: s.depth,
    ...(s.from !== undefined ? { from: s.from } : {}),
    ...(s.confidence === "low" ? { low: true as const } : {}),
  }));
  const ofKind = (k: string) => steps.filter((s) => s.kind === k && s.id !== r.target);
  const lists = {
    routes: ofKind("route").map((s) => s.id),
    endpoints: ofKind("endpoint").map((s) => ({ id: s.id, ...(s.low ? { low: true } : {}) })),
    tables: ofKind("table").map((s) => s.id),
  };
  const gaps = r.gaps.slice(0, TRACE_LIMITS.gaps).map((g) => clip(g, TRACE_LIMITS.gapText));
  const base = {
    target: r.target,
    direction: r.direction,
    omitted: r.omitted,
    truncated: r.truncated,
    gaps,
    ...(r.gaps.length > TRACE_LIMITS.gaps ? { gaps_total: r.gaps.length } : {}),
  };
  const build = (cap: number, collapse: boolean) => {
    const cut = <T>(xs: T[]) => xs.slice(0, cap);
    let chain = steps;
    let repeats: { depth: number; via: string; kind: string; count: number; sample: string }[] | undefined;
    if (collapse) {
      const groups = new Map<
        string,
        { depth: number; via: string; kind: string; count: number; sample: string }
      >();
      chain = [];
      for (const s of steps) {
        if (ENDS.has(s.kind) || s.id === r.target) {
          chain.push(s);
          continue;
        }
        const k = `${s.depth}\0${s.via}\0${s.kind}`;
        const g = groups.get(k);
        if (g) g.count++;
        else groups.set(k, { depth: s.depth, via: s.via, kind: s.kind, count: 1, sample: s.id });
      }
      repeats = [...groups.values()];
    }
    const out: Record<string, unknown> = {
      ...base,
      routes: cut(lists.routes),
      endpoints: cut(lists.endpoints),
      tables: cut(lists.tables),
      chain: cut(chain),
    };
    for (const [k, v] of Object.entries({ ...lists, chain })) {
      if (v.length > cap) out[`${k}_total`] = v.length;
    }
    if (repeats) {
      out.repeats = cut(repeats);
      if (repeats.length > cap) out.repeats_total = repeats.length;
    }
    return out;
  };
  let out = build(Number.POSITIVE_INFINITY, false);
  if (JSON.stringify(out).length <= budget) return out;
  for (let cap = 40; cap >= 1; cap = Math.floor(cap / 2)) {
    out = build(cap, true);
    if (JSON.stringify(out).length <= budget) return out;
    if (cap === 1) break;
  }
  return out;
}

export const traceTool = defineTool({
  name: "gantry_trace",
  description:
    "Page → API → table chain. From a route (route:<ws>:<route id>, or a route path such as /posts/$postId) it follows the page's component, what it renders, calls and hooks, the endpoints those request (oRPC procedures, Hono routes, server functions), their handlers and the database tables they read or write; from a table (table:<name>) it goes up to the endpoints and pages that use it. " +
    "Also takes an endpoint id or label (ep:..., GET /api/posts/:id, rpc posts.list), a symbol id, a file path or path:line; direction defaults to up for a table and down otherwise. " +
    "Returns {target, direction, routes, endpoints: [{id, low?}], tables, chain: [{id, kind, via, depth, from?, low?}], repeats?, gaps, omitted, truncated}: via is the edge kind a step was reached by, low marks a low-confidence match (fetch URL or name only), gaps lists where the chain stops (unmatched client calls, endpoints without a handler or table, limits). " +
    "When the chain is long the steps between pages, endpoints and tables are summarised in repeats with counts; *_total fields count what was cut. No description text is returned.",
  inputSchema: {
    target: z
      .string()
      .min(1)
      .max(500)
      .describe("route, endpoint or table id or label, symbol id, path or path:line"),
    direction: z.enum(["down", "up"]).optional().describe("down: toward tables; up: toward pages"),
  },
  run({ target, direction }, { store }) {
    const r = trace(store, target, direction ? { direction } : {});
    if (!r)
      return {
        error: "not_found",
        message: "No route, endpoint, table, symbol or file matches that target.",
      };
    return shapeTrace(r);
  },
});

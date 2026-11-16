import type { ViewModule, ViewResult } from "../types.js";
import {
  barycentreRanks,
  crossCtx,
  endpointFilter,
  endpointGroup,
  endpointTables,
  FlowBuilder,
  GROUP_ORDER,
  type Lane,
  needsKinds,
  type WorkspaceCount,
  workspaceCounts,
} from "./crossStack.js";
import { cmp, optBool } from "./options.js";

/** One endpoint's tables, as the bench and the inspector read them. */
export interface EndpointTableRow {
  endpoint: string;
  reads: string[];
  writes: string[];
}

export interface ApiTablesResult extends ViewResult {
  lanes: Lane[];
  wsCounts: WorkspaceCount[];
  /** Every shown endpoint's tables (also those hidden for reaching none, with empty lists). */
  endpointTables: EndpointTableRow[];
  totals: { endpoints: number; withTables: number; tables: number; services: number; expanded: boolean };
}

/**
 * View 9. API -> tables (#48, hint `columns`, 3 lanes): endpoints, the services between the handler and the
 * database call, tables. Built from each endpoint's own part of its down `trace` (`endpointTables`: nothing
 * reached through another endpoint, only code on a path to a read or write). `reads` edges are drawn blue and
 * `writes` orange; low-confidence matches are dashed.
 *
 * Services are collapsed by default: the middle lane holds only the code that makes the database call, joined
 * to its endpoint by an edge whose `via` is the number of functions in between. `services=all` expands it to every
 * function on the way (the handler and its `calls`).
 *
 * Filters: `ws`, `kind` (rpc | http | fn), `method`, `prefix` (as the endpoints view), `all` (also endpoints that
 * reach no table).
 */
export const apiTablesView: ViewModule = {
  id: "api-tables",
  title: "API → tables",
  enabled: needsKinds("endpoint", "table"),
  disabledReason: "Needs endpoints and Drizzle tables.",
  build({ store }, params): ApiTablesResult {
    const c = crossCtx(store);
    const expanded = params.options?.services === "all" || optBool(params, "expand", false);
    const showAll = optBool(params, "all", false);
    const pass = endpointFilter(c, params);
    const all = c.byKind.get("endpoint") ?? [];
    const order = (id: string) => {
      const n = c.adapters.get(id);
      return n ? GROUP_ORDER.indexOf(endpointGroup(n)) : 0;
    };
    const shown = all.filter(pass).sort((a, b) => order(a.id) - order(b.id) || cmp(a.label, b.label));
    const b = new FlowBuilder(c);
    const rows: EndpointTableRow[] = [];
    let withTables = 0;
    let rank = 0;
    for (const ep of shown) {
      const et = endpointTables(c, ep.id);
      rows.push({ endpoint: ep.id, reads: et.reads, writes: et.writes });
      const hasTables = et.reads.length + et.writes.length > 0;
      if (hasTables) withTables++;
      if (!hasTables && !showAll) continue;
      const n = b.node(ep.id, 0, { rank: rank++ });
      if (!hasTables) n.badges = [...(n.badges ?? []), "no table"];
      for (const e of et.edges) {
        const db = e.kind === "reads" || e.kind === "writes";
        if (db) {
          b.node(e.src, 1);
          b.node(e.dst, 2);
          b.traceEdge(e);
        } else if (expanded) {
          if (e.src !== ep.id) b.node(e.src, 1);
          b.node(e.dst, 1);
          b.traceEdge(e);
        }
      }
      if (!expanded) {
        for (const caller of et.dbCallers) {
          const hops = et.hops.get(caller) ?? 1;
          const edge = b.edge(ep.id, caller, "uses", false, 0);
          edge.weight = 1;
          edge.via = Math.max(0, hops - 1);
        }
      }
    }
    const { nodes, edges } = b.result();
    barycentreRanks(nodes, edges, 1, 0);
    barycentreRanks(nodes, edges, 2, 1);
    return {
      nodes,
      edges,
      layoutHint: "columns",
      lanes: [
        { lane: 0, label: "Endpoints" },
        { lane: 1, label: expanded ? "Services" : "Database calls" },
        { lane: 2, label: "Tables" },
      ],
      wsCounts: workspaceCounts(c, all),
      endpointTables: rows,
      totals: {
        endpoints: shown.length,
        withTables,
        tables: nodes.filter((n) => n.kind === "table").length,
        services: nodes.filter((n) => n.lane === 1).length,
        expanded,
      },
    };
  },
};

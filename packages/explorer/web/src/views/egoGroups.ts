import type { Filters, GraphNode } from "../api.ts";
import { weightOf } from "../canvas/bowtieLayout.ts";

/** The server's node cap for the ego view (server/views/ego.ts `EGO_MAX_NODES`). */
export const EGO_MAX_NODES = 400;

/** Group ids the route asks the server to expand: the `expand` filter, `|` separated. */
export function expandedIds(filters: Filters): string[] {
  return (filters.expand ?? "").split("|").filter(Boolean);
}

/** The filters with `ids` as the expanded groups; an empty list drops the key so the hash stays short. */
export function withExpanded(filters: Filters, ids: readonly string[]): Filters {
  const next = { ...filters };
  const unique = [...new Set(ids)];
  if (unique.length === 0) delete next.expand;
  else next.expand = unique.join("|");
  return next;
}

/** Toggles one group in the `expand` filter. */
export function toggleExpanded(filters: Filters, id: string): Filters {
  const ids = expandedIds(filters);
  return withExpanded(filters, ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
}

export interface SideSummary {
  /** Callers (or callees) the side stands for, groups and "+K more" nodes included. */
  count: number;
  workspaces: number;
  files: number;
}

export interface EgoSummary {
  callers: SideSummary;
  callees: SideSummary;
  groups: GraphNode[];
  /** Nodes the view would hold with every collapsed group expanded. */
  nodesIfAllExpanded: number;
}

/** Counts for the left panel, from the nodes the server returned. */
export function summarizeEgo(nodes: readonly GraphNode[]): EgoSummary {
  const side = (s: "in" | "out"): SideSummary => {
    const ws = new Set<string>();
    const files = new Set<string>();
    let count = 0;
    for (const n of nodes) {
      if (n.side !== s) continue;
      count += weightOf(n);
      if (n.workspace) ws.add(n.workspace);
      if (n.kind === "group") for (const m of n.members ?? []) if (m.path) files.add(m.path);
      if (n.kind !== "group" && n.kind !== "more" && n.path) files.add(n.path);
    }
    return { count, workspaces: ws.size, files: files.size };
  };
  const groups = nodes
    .filter((n) => n.kind === "group")
    .sort(
      (a, b) =>
        (a.side === b.side ? 0 : a.side === "in" ? -1 : 1) || b.size - a.size || (a.id < b.id ? -1 : 1),
    );
  const extra = groups.reduce((s, g) => s + (g.expanded ? 0 : g.size - 1), 0);
  return { callers: side("in"), callees: side("out"), groups, nodesIfAllExpanded: nodes.length + extra };
}

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "221 callers in 3 workspaces · 96 files", or just "1 callee" when nothing needs the detail. */
export function describeSide(s: SideSummary, one: string, many: string): string {
  const head = plural(s.count, one, many);
  if (s.count <= 1 || (s.workspaces <= 1 && s.files <= 1)) return head;
  const parts = [];
  if (s.workspaces > 1) parts.push(`in ${plural(s.workspaces, "workspace", "workspaces")}`);
  const where = parts.length ? `${head} ${parts.join(" ")}` : head;
  return s.files > 1 ? `${where} · ${plural(s.files, "file", "files")}` : where;
}

/**
 * Short names for workspace ids (`ws:@acme/ui` -> `ui`): the npm scope is dropped when most of the names share it.
 * Mirrors server/views/labels.ts so the panel and the group labels agree.
 */
export function workspaceShortNames(ids: readonly string[]): Map<string, string> {
  const names = ids.map((id) => id.replace(/^ws:/, ""));
  const scopeOf = (n: string): string | null => /^(@[^/]+)\//.exec(n)?.[1] ?? null;
  const counts = new Map<string, number>();
  let scoped = 0;
  for (const n of names) {
    const sc = scopeOf(n);
    if (sc) {
      scoped++;
      counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
  }
  let shared: string | null = null;
  let best = 0;
  for (const [sc, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c > best) {
      best = c;
      shared = sc;
    }
  }
  const strip = shared !== null && best >= 2 && best * 2 > scoped;
  const out = new Map<string, string>();
  ids.forEach((id, i) => {
    const n = names[i] as string;
    out.set(id, strip && scopeOf(n) === shared ? n.slice((shared as string).length + 1) : n);
  });
  return out;
}

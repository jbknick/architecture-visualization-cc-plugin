import type { Neighbour, UseKind } from "./consumers.js";

/**
 * The walk to the end behind the reachable tier (#293, spec section 11). The constants (`REACHABLE_NODE_CAP`,
 * `FAN_IN_ORDER`) are in `consumers.ts`.
 */

/** How a hop-1 node reaches the change: the edge kinds, and whether some edge to it is `high`. */
export interface DirectUse {
  uses: Set<UseKind>;
  high: boolean;
}

/** One node of the walk, kept at the first hop it appears at. */
export interface ReachRow {
  id: string;
  hop: number;
  /** The node one step nearer the change this one uses (the first in sorted order); the node itself at hop 1. */
  next: string;
  /** The hop-1 node the path goes through. */
  via: string;
  /** Edge kinds from this node to `next` (to the change at hop 1), as the potential tier records them. */
  uses: Set<UseKind>;
  /** True when some path of hop-many edges from this node to the change has only `high` edges. */
  high: boolean;
}

export interface ReachResult {
  /** Every node reached, hop 1 first, then by hop and id. */
  rows: ReachRow[];
  /** True when the node cap stopped the walk. */
  capped: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Breadth-first from `direct` (hop 1) over the incoming consumer edges of `graph`, until nothing new is reached or
 * `cap` nodes are held. `exclude` (the change itself) is never listed. Order never depends on the order of edges:
 * a hop's new nodes are taken in sorted id order, so the cap cuts the same nodes on every run, and a node's `next`
 * is the first node of the sorted frontier that it uses. Each node keeps its first hop.
 */
export function walkToEnd(
  graph: { incoming(node: string): Neighbour[] },
  direct: Map<string, DirectUse>,
  exclude: ReadonlySet<string>,
  cap: number,
): ReachResult {
  const rows = new Map<string, ReachRow>();
  let capped = false;
  let frontier: string[] = [];
  for (const id of [...direct.keys()].filter((d) => !exclude.has(d)).sort(cmp)) {
    if (rows.size >= cap) {
      capped = true;
      break;
    }
    const d = direct.get(id) as DirectUse;
    rows.set(id, { id, hop: 1, next: id, via: id, uses: new Set(d.uses), high: d.high });
    frontier.push(id);
  }
  for (let hop = 2; frontier.length > 0 && !capped; hop++) {
    const found = new Map<string, { next: string; uses: Set<UseKind>; high: boolean }>();
    for (const node of frontier) {
      const here = rows.get(node) as ReachRow;
      for (const n of graph.incoming(node)) {
        if (rows.has(n.src) || exclude.has(n.src)) continue;
        let f = found.get(n.src);
        if (!f) {
          f = { next: node, uses: new Set(), high: false };
          found.set(n.src, f);
        }
        if (f.next === node) f.uses.add(n.kind);
        if (here.high && n.confidence === "high") f.high = true;
      }
    }
    frontier = [];
    for (const id of [...found.keys()].sort(cmp)) {
      if (rows.size >= cap) {
        capped = true;
        break;
      }
      const f = found.get(id) as { next: string; uses: Set<UseKind>; high: boolean };
      rows.set(id, {
        id,
        hop,
        next: f.next,
        via: (rows.get(f.next) as ReachRow).via,
        uses: f.uses,
        high: f.high,
      });
      frontier.push(id);
    }
  }
  return { rows: [...rows.values()], capped };
}

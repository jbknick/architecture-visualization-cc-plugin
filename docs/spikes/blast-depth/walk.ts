/**
 * The prototype walk of the blast-depth spike (not shipped; nothing here is imported by packages/). Breadth-first from
 * the direct consumers of a set of changed symbols over `CONSUMER_KINDS` (a `file:` node also through its importers),
 * with no hop limit, keeping for every node its first hop, its path confidence, its fan-in and its predecessors.
 * Ids are the ones origin/main has (`sym:<repo>:<path>#<name>`, `file:<repo>:<path>`).
 */

import { fileIdOfSymId, isFileId } from "../../../packages/core/src/ids.js";
import {
  CONSUMER_KINDS,
  ConsumerGraph,
  directConsumers,
} from "../../../packages/core/src/review/consumers.js";
import type { SymbolChange } from "../../../packages/core/src/review/diff.js";
import type { Store } from "../../../packages/core/src/store/index.js";
import type { EdgeKind, EdgeRecord } from "../../../packages/core/src/types.js";

export interface WalkNode {
  id: string;
  hop: number;
  /** Path confidence: true when some path of hop-many edges to the change has only `high` edges. */
  high: boolean;
  /** Distinct sources of incoming consumer edges, as `ConsumerGraph.incoming` returns them. */
  fanIn: number;
  /** Nodes at hop - 1 this node uses (empty at hop 1). */
  preds: string[];
}

export interface WalkResult {
  nodes: Map<string, WalkNode>;
  /** The graph reader the walk used (for `info`: workspace, path, name). */
  graph: ConsumerGraph;
  /** True when the optional node cap stopped the walk. */
  capped: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Walks the radius of `changes` (added symbols are not walked) in `store`. `cap` limits the node count. */
export function walkRadius(
  store: Store,
  changes: SymbolChange[],
  cap = Number.POSITIVE_INFINITY,
): WalkResult {
  const g = new ConsumerGraph(store);
  const edgeCache = new Map<string, EdgeRecord[]>();
  const inEdges = (node: string): EdgeRecord[] => {
    let hit = edgeCache.get(node);
    if (hit) return hit;
    const kinds: EdgeKind[] = isFileId(node) ? [...CONSUMER_KINDS, "imports"] : [...CONSUMER_KINDS];
    hit = store
      .effectiveEdges({ dst: node, kind: kinds })
      .filter((e) => !e.src.startsWith("ext:") && e.src !== node);
    edgeCache.set(node, hit);
    return hit;
  };
  const fanInOf = (node: string): number => new Set(g.incoming(node).map((n) => n.src)).size;

  const sources = changes.filter((c) => c.kind !== "added");
  const own = new Set<string>();
  for (const c of sources) for (const id of [c.after?.id, c.before?.id]) if (id !== undefined) own.add(id);

  const nodes = new Map<string, WalkNode>();
  let capped = false;
  const add = (id: string, hop: number, high: boolean, pred?: string): boolean => {
    const prior = nodes.get(id);
    if (prior) {
      if (prior.hop === hop && pred !== undefined) {
        if (!prior.preds.includes(pred)) prior.preds.push(pred);
        prior.high = prior.high || high;
      }
      return false;
    }
    if (own.has(id)) return false;
    if (nodes.size >= cap) {
      capped = true;
      return false;
    }
    nodes.set(id, { id, hop, high, fanIn: 0, preds: pred === undefined ? [] : [pred] });
    return true;
  };

  // Hop 1: the direct consumers, confidence from the edge to the change (or the import edge for an importer file).
  const high1 = new Map<string, boolean>();
  const direct = new Set<string>();
  for (const c of sources) {
    const ids = [c.after?.id, c.before?.id].filter((x): x is string => x !== undefined);
    const path = (c.after ?? c.before)?.path;
    const here = directConsumers(g, c);
    const edges = [
      ...ids.flatMap((id) => inEdges(id)),
      ...(path !== undefined ? inEdges(g.fileId(path)) : []),
    ];
    for (const d of here.keys()) {
      direct.add(d);
      const found = edges.filter((e) => e.src === d);
      const high = found.length === 0 || found.some((e) => e.confidence === "high");
      high1.set(d, (high1.get(d) ?? false) || high);
    }
  }
  let frontier: string[] = [];
  for (const d of [...direct].sort(cmp)) {
    if (capped) break;
    if (add(d, 1, high1.get(d) ?? true)) frontier.push(d);
  }
  for (let hop = 2; frontier.length > 0; hop++) {
    const found: string[] = [];
    for (const p of frontier) {
      const pn = nodes.get(p) as WalkNode;
      for (const e of inEdges(p)) {
        if (add(e.src, hop, pn.high && e.confidence === "high", p)) found.push(e.src);
      }
    }
    frontier = found.sort(cmp);
  }
  for (const n of nodes.values()) n.fanIn = fanInOf(n.id);
  return { nodes, graph: g, capped };
}

/**
 * For every node, the smallest hub threshold T at which it is listed rather than collapsed into a hub entry. A node
 * is a hub when its fan-in is above T; a node at hop >= 2 is collapsed when every predecessor is a hub or collapsed.
 * So v(hop 1) = 0 and v(n) = min over predecessors p of max(v(p), fanIn(p)); n is visible exactly when T >= v(n).
 */
export function visibleFrom(nodes: Map<string, WalkNode>): Map<string, number> {
  const v = new Map<string, number>();
  const byHop = [...nodes.values()].sort((a, b) => a.hop - b.hop || cmp(a.id, b.id));
  for (const n of byHop) {
    if (n.hop === 1) {
      v.set(n.id, 0);
      continue;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const p of n.preds) {
      const pv = v.get(p);
      const pn = nodes.get(p);
      if (pv === undefined || pn === undefined) continue;
      best = Math.min(best, Math.max(pv, pn.fanIn));
    }
    v.set(n.id, best);
  }
  return v;
}

/** One in-memory adjacency of the whole store: consumer edges by destination, loaded with a single store query. */
export function loadConsumerMap(store: Store): Map<string, EdgeRecord[]> {
  const byDst = new Map<string, EdgeRecord[]>();
  for (const e of store.effectiveEdges({ kind: [...CONSUMER_KINDS, "imports"] })) {
    if (e.src.startsWith("ext:") || e.src === e.dst) continue;
    if (e.kind === "imports" && !isFileId(e.dst)) continue;
    const list = byDst.get(e.dst);
    if (list) list.push(e);
    else byDst.set(e.dst, [e]);
  }
  return byDst;
}

/**
 * The same breadth-first walk as `walkRadius` over a loaded adjacency (no store query per node). The hop-1 nodes are
 * the sources of the edges into the seed symbols and the importers of their files (as `directConsumers` reads them). Returns the walk's nodes by id with hop, path confidence and fan-in.
 */
export function walkBatched(map: Map<string, EdgeRecord[]>, seeds: string[]): Map<string, WalkNode> {
  const nodes = new Map<string, WalkNode>();
  const own = new Set(seeds);
  let frontier: string[] = [];
  const entries = seeds.flatMap((s) => [s, fileIdOfSymId(s)].filter((x): x is string => x !== undefined));
  for (const s of entries) {
    for (const e of map.get(s) ?? []) {
      if (own.has(e.src)) continue;
      const prior = nodes.get(e.src);
      if (prior) prior.high = prior.high || e.confidence === "high";
      else {
        nodes.set(e.src, { id: e.src, hop: 1, high: e.confidence === "high", fanIn: 0, preds: [] });
        frontier.push(e.src);
      }
    }
  }
  for (let hop = 2; frontier.length > 0; hop++) {
    const found: string[] = [];
    for (const p of frontier) {
      const pn = nodes.get(p) as WalkNode;
      for (const e of map.get(p) ?? []) {
        const prior = nodes.get(e.src);
        const high = pn.high && e.confidence === "high";
        if (prior) {
          if (prior.hop === hop) {
            if (!prior.preds.includes(p)) prior.preds.push(p);
            prior.high = prior.high || high;
          }
        } else if (!own.has(e.src)) {
          nodes.set(e.src, { id: e.src, hop, high, fanIn: 0, preds: [p] });
          found.push(e.src);
        }
      }
    }
    frontier = found;
  }
  for (const n of nodes.values()) n.fanIn = new Set((map.get(n.id) ?? []).map((e) => e.src)).size;
  return nodes;
}

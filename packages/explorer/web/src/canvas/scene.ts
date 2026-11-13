// Everything derived from (nodes, edges) that does not depend on positions or the camera.
import type { GraphEdge, GraphNode } from "../api.ts";
import {
  type AggEdge,
  aggregateEdges,
  buildTree,
  isRegion,
  liftTo,
  TIER_DIR,
  TIER_FILE,
  TIER_SYMBOL,
  TIER_WORKSPACE,
  type Tree,
  type TreeNode,
} from "./hierarchy.ts";
import type { LayoutInput } from "./types.ts";

export interface SceneEdge {
  src: number;
  dst: number;
  weight: number;
  kind: string;
}

export interface Scene {
  tree: Tree;
  /** Input nodes in tree order (sorted by id). */
  nodes: GraphNode[];
  edges: SceneEdge[];
  /** Rank of each root among roots sorted by id; drives the stable workspace colours. */
  rootRank: Map<number, number>;
  roots: number[];
  /** Symbols under each node (1 for a symbol itself). */
  symbolCount: Int32Array;
  /** Aggregated edges drawn by the overlay, per level (cached). */
  overlayEdges: { far: AggEdge[]; mid: AggEdge[]; near: AggEdge[] };
  /** Edge indices incident to each node. */
  incident: Map<number, number[]>;
  hierarchical: boolean;
}

const MID_EDGE_LIMIT = 220;
const NEAR_EDGE_LIMIT = 400;

/** `hint` decides whether childless workspaces become boxes: only the nested hint (project map) does. */
export function buildScene(nodes: GraphNode[], edges: GraphEdge[], hint = "nested-elk"): Scene {
  const tree = buildTree(nodes, { boxWorkspaces: hint === "nested-elk" });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = tree.nodes.map((n) => byId.get(n.id) as GraphNode);
  const sceneEdges: SceneEdge[] = [];
  for (const e of edges) {
    const a = tree.index.get(e.src);
    const b = tree.index.get(e.dst);
    if (a === undefined || b === undefined || a === b) continue;
    sceneEdges.push({ src: a, dst: b, weight: Math.max(1, e.weight || 1), kind: e.kind });
  }
  const roots: number[] = [];
  tree.nodes.forEach((n, i) => {
    if (n.parent === -1) roots.push(i);
  });
  const rootRank = new Map(roots.map((r, k) => [r, k]));

  const symbolCount = new Int32Array(tree.nodes.length);
  const count = (i: number): number => {
    const n = tree.nodes[i] as TreeNode;
    if (n.children.length === 0) return n.tier >= TIER_SYMBOL ? 1 : 0;
    let sum = 0;
    for (const c of n.children) sum += count(c);
    symbolCount[i] = sum;
    return sum;
  };
  for (const r of roots) symbolCount[r] = count(r);
  tree.nodes.forEach((n, i) => {
    if (n.children.length === 0 && n.tier >= TIER_SYMBOL) symbolCount[i] = 1;
  });

  const incident = new Map<number, number[]>();
  sceneEdges.forEach((e, k) => {
    for (const end of [e.src, e.dst]) {
      let list = incident.get(end);
      if (!list) {
        list = [];
        incident.set(end, list);
      }
      list.push(k);
    }
  });

  const far = aggregateEdges(sceneEdges, (i) => liftTo(tree, i, TIER_WORKSPACE));
  const mid = aggregateEdges(sceneEdges, (i) => liftTo(tree, i, TIER_DIR)).slice(0, MID_EDGE_LIMIT);
  // Near level: only edges that touch a region (file/dir/workspace). Leaf-to-leaf edges are drawn by sigma.
  const near = tree.hierarchical
    ? aggregateEdges(sceneEdges, (i) => i)
        .filter((e) => isRegion(tree, e.src) || isRegion(tree, e.dst))
        .slice(0, NEAR_EDGE_LIMIT)
    : [];

  return {
    tree,
    nodes: ordered,
    edges: sceneEdges,
    rootRank,
    roots,
    symbolCount,
    overlayEdges: { far, mid, near },
    incident,
    hierarchical: tree.hierarchical,
  };
}

/** Layout input for a scene (positions are the only output the renderer needs). */
export function layoutInputFor(
  scene: Scene,
  hint: string,
  focus: string | null,
  saved?: LayoutInput["saved"],
): LayoutInput {
  return {
    nodes: scene.nodes.map((n) => ({ id: n.id, kind: n.kind, parent: n.parent, size: n.size })),
    edges: scene.edges.map((e) => ({
      src: (scene.tree.nodes[e.src] as TreeNode).id,
      dst: (scene.tree.nodes[e.dst] as TreeNode).id,
      weight: e.weight,
    })),
    hint,
    focus,
    saved,
  };
}

/**
 * Nodes kept at full opacity when `selected` is chosen: the node, its ancestors and descendants, every node
 * connected to the node or to anything inside it, and those nodes' ancestors.
 */
export function brightSet(scene: Scene, selected: number): Set<number> {
  const { tree } = scene;
  const bright = new Set<number>();
  const addWithAncestors = (i: number) => {
    let cur = i;
    while (cur !== -1 && !bright.has(cur)) {
      bright.add(cur);
      cur = (tree.nodes[cur] as TreeNode).parent;
    }
  };
  const subtree: number[] = [];
  const collect = (i: number) => {
    subtree.push(i);
    for (const c of (tree.nodes[i] as TreeNode).children) collect(c);
  };
  collect(selected);
  addWithAncestors(selected);
  for (const i of subtree) bright.add(i);
  const inside = new Set(subtree);
  for (const i of subtree) {
    for (const k of scene.incident.get(i) ?? []) {
      const e = scene.edges[k] as SceneEdge;
      const other = inside.has(e.src) ? e.dst : e.src;
      addWithAncestors(other);
    }
  }
  return bright;
}

/** Selected node, its descendants and its ancestors: edges touching any of them count as the selection's edges. */
export function relatedSet(scene: Scene, selected: number): Set<number> {
  const { tree } = scene;
  const out = new Set<number>();
  const down = (i: number) => {
    out.add(i);
    for (const c of (tree.nodes[i] as TreeNode).children) down(c);
  };
  down(selected);
  let cur = (tree.nodes[selected] as TreeNode).parent;
  while (cur !== -1) {
    out.add(cur);
    cur = (tree.nodes[cur] as TreeNode).parent;
  }
  return out;
}

/** Noun for a count on an edge: "imports" stays "imports"; unknown kinds fall back to "edges". */
export function edgeNoun(kind: string, mixed: boolean): string {
  if (mixed || !kind) return "edges";
  return kind.replace(/_/g, " ");
}

export function tierName(tier: number): string {
  return tier === TIER_WORKSPACE
    ? "workspace"
    : tier === TIER_DIR
      ? "directory"
      : tier === TIER_FILE
        ? "file"
        : "symbol";
}

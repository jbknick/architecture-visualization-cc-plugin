// Everything derived from (nodes, edges) that does not depend on positions or the camera.
import type { GraphEdge, GraphNode } from "../api.ts";
import {
  buildTree,
  kindTier,
  liftTo,
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

/** A workspace-to-workspace link. `weight` counts imports (or uses); `declaredOnly` links come only from package.json. */
export interface WsEdge {
  src: number;
  dst: number;
  weight: number;
  declaredOnly: boolean;
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
  /** Functions under each node: its own `stats.functions` when the server sent it, else the symbols counted below. */
  functions: Int32Array;
  /** Files under each node (`stats.files` when sent, else counted). */
  files: Int32Array;
  /** Workspace-to-workspace links, heaviest first. */
  wsEdges: WsEdge[];
  /** Edge indices incident to each node. */
  incident: Map<number, number[]>;
  hierarchical: boolean;
}

/**
 * Links between workspaces. When the server sent edges between the workspace nodes themselves (the project map
 * does, at every level) only those count, so a link is not summed twice with the file-level edges below it.
 * Otherwise the edges of everything inside a workspace are lifted to it.
 */
function buildWsEdges(tree: Tree, edges: readonly SceneEdge[]): WsEdge[] {
  const isRoot = (i: number) => (tree.nodes[i] as TreeNode).parent === -1;
  const direct = edges.filter((e) => isRoot(e.src) && isRoot(e.dst));
  const source = direct.length > 0 ? direct : edges;
  const map = new Map<string, WsEdge>();
  for (const e of source) {
    const a = liftTo(tree, e.src, TIER_WORKSPACE);
    const b = liftTo(tree, e.dst, TIER_WORKSPACE);
    if (a === b) continue;
    const key = `${a}>${b}`;
    const cur = map.get(key) ?? { src: a, dst: b, weight: 0, declaredOnly: true, kind: e.kind };
    if (e.kind !== "depends_on") {
      cur.weight += e.weight;
      cur.declaredOnly = false;
      cur.kind = e.kind;
    } else if (cur.declaredOnly) cur.weight = Math.max(cur.weight, e.weight);
    map.set(key, cur);
  }
  return [...map.values()].sort((p, q) => q.weight - p.weight || p.src - q.src || p.dst - q.dst);
}

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
    if (n.children.length === 0) return kindTier(n.kind) >= TIER_SYMBOL ? 1 : 0;
    let sum = 0;
    for (const c of n.children) sum += count(c);
    symbolCount[i] = sum;
    return sum;
  };
  for (const r of roots) symbolCount[r] = count(r);
  tree.nodes.forEach((n, i) => {
    if (n.children.length === 0 && kindTier(n.kind) >= TIER_SYMBOL) symbolCount[i] = 1;
  });

  const files = new Int32Array(tree.nodes.length);
  const countFiles = (i: number): number => {
    const n = tree.nodes[i] as TreeNode;
    let sum = kindTier(n.kind) === TIER_FILE ? 1 : 0;
    for (const c of n.children) sum += countFiles(c);
    files[i] = sum;
    return sum;
  };
  for (const r of roots) countFiles(r);
  const functions = new Int32Array(tree.nodes.length);
  tree.nodes.forEach((_, i) => {
    const stats = ordered[i]?.stats;
    functions[i] = stats?.functions ?? symbolCount[i] ?? 0;
    if (stats?.files !== undefined) files[i] = stats.files;
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

  return {
    tree,
    nodes: ordered,
    edges: sceneEdges,
    rootRank,
    roots,
    symbolCount,
    functions,
    files,
    wsEdges: tree.hierarchical ? buildWsEdges(tree, sceneEdges) : [],
    incident,
    hierarchical: tree.hierarchical,
  };
}

/** The name drawn on a workspace box: the short name when the server sent one. */
export function nodeTitle(scene: Scene, i: number): string {
  const n = scene.nodes[i];
  return n?.shortLabel ?? n?.label ?? "";
}

/** Parts of a workspace's second title line: "app", "1,700 functions", "260 files". Counts come from the node itself. */
export function subtitleParts(scene: Scene, i: number): string[] {
  const node = scene.nodes[i];
  const fn = scene.functions[i] ?? 0;
  const files = scene.files[i] ?? 0;
  const parts: string[] = [];
  const badge = node?.badges?.[0];
  if (badge) parts.push(badge);
  parts.push(`${fn.toLocaleString("en-US")} ${fn === 1 ? "function" : "functions"}`);
  if (files > 0 || node?.stats?.files !== undefined)
    parts.push(`${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}`);
  return parts;
}

/** Layout input for a scene (positions are the only output the renderer needs). */
export function layoutInputFor(
  scene: Scene,
  hint: string,
  focus: string | null,
  saved?: LayoutInput["saved"],
  viewport?: { w: number; h: number },
): LayoutInput {
  return {
    nodes: scene.nodes.map((n, i) => ({
      id: n.id,
      kind: n.kind,
      parent: n.parent,
      size: n.size,
      functions: scene.functions[i],
      ...((scene.tree.nodes[i] as TreeNode).parent === -1
        ? { title: nodeTitle(scene, i), subtitle: subtitleParts(scene, i) }
        : {}),
    })),
    edges: scene.edges.map((e) => ({
      src: (scene.tree.nodes[e.src] as TreeNode).id,
      dst: (scene.tree.nodes[e.dst] as TreeNode).id,
      weight: e.weight,
      kind: e.kind,
    })),
    hint,
    focus,
    saved,
    viewport,
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

/**
 * The links drawn when a folder, file or function is selected: edges between anything inside the selection and
 * anything outside it (ancestors excluded), summed per pair, strongest `limit` first.
 */
export function selectionLinks(
  scene: Scene,
  selected: number,
  limit = 120,
): { src: number; dst: number; weight: number }[] {
  const { tree } = scene;
  const inside = new Set<number>();
  const collect = (i: number): void => {
    if (inside.size > 8000) return;
    inside.add(i);
    for (const c of (tree.nodes[i] as TreeNode).children) collect(c);
  };
  collect(selected);
  const ancestors = new Set<number>();
  for (let a = (tree.nodes[selected] as TreeNode).parent; a !== -1; a = (tree.nodes[a] as TreeNode).parent)
    ancestors.add(a);
  const sums = new Map<string, { src: number; dst: number; weight: number }>();
  for (const i of inside) {
    for (const k of scene.incident.get(i) ?? []) {
      const e = scene.edges[k] as SceneEdge;
      if (inside.has(e.src) && inside.has(e.dst)) continue;
      const other = inside.has(e.src) ? e.dst : e.src;
      if (ancestors.has(other)) continue;
      const key = `${e.src}>${e.dst}`;
      const cur = sums.get(key);
      if (cur) cur.weight += e.weight;
      else sums.set(key, { src: e.src, dst: e.dst, weight: e.weight });
    }
  }
  return [...sums.values()]
    .sort((a, b) => b.weight - a.weight || a.src - b.src || a.dst - b.dst)
    .slice(0, limit);
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
    : tier === 1
      ? "directory"
      : tier === TIER_FILE
        ? "file"
        : "symbol";
}

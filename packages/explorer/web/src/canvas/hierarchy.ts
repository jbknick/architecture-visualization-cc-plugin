import type { Positions, Rect } from "./types.ts";

// Geometry shared by the layout (which reserves the space) and the renderer (which derives the regions).
export const CELL_W = 46;
export const CELL_H = 26;
export const FILE_LEAF_W = 58;
export const FILE_LEAF_H = 30;
export const PAD = 12;
/** Header strip reserved at the top of a region for its label, by tier. */
export const HEAD: Record<number, number> = { 0: 84, 1: 46, 2: 32 };
export const GAP = 22;
/** A workspace with no children (the project map at workspace level) is drawn as a box this size. */
export const WS_LEAF_W = 210;
export const WS_LEAF_H = 104;

export const TIER_WORKSPACE = 0;
export const TIER_DIR = 1;
export const TIER_FILE = 2;
export const TIER_SYMBOL = 3;

export interface TreeNode {
  id: string;
  kind: string;
  parent: number;
  children: number[];
  /** 0 workspace/root, 1 directory, 2 file, 3 symbol. */
  tier: number;
  /** Index of the root ancestor (or itself). */
  root: number;
  size: number;
}

export interface Tree {
  nodes: TreeNode[];
  index: Map<string, number>;
  /** True when at least one node has a parent in the set, or workspaces are boxed (see `buildTree`). */
  hierarchical: boolean;
  /** Childless workspaces are drawn as labelled boxes (the project map at workspace level). */
  boxWorkspaces: boolean;
}

function kindTier(kind: string): number {
  if (kind === "workspace") return TIER_WORKSPACE;
  if (kind === "directory" || kind === "dir") return TIER_DIR;
  if (kind === "file") return TIER_FILE;
  return TIER_SYMBOL;
}

interface TreeInput {
  id: string;
  kind: string;
  parent?: string;
  size: number;
}

/** Builds the containment tree. Nodes are ordered by id so every later step is deterministic. */
export function buildTree(input: readonly TreeInput[], opts: { boxWorkspaces?: boolean } = {}): Tree {
  const sorted = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = new Map<string, number>();
  const nodes: TreeNode[] = sorted.map((n, i) => {
    index.set(n.id, i);
    return { id: n.id, kind: n.kind, parent: -1, children: [], tier: 0, root: i, size: n.size };
  });
  // Detach parent links that would form a cycle (walk up at most `nodes.length` hops).
  const parentOf = sorted.map((n) => (n.parent === undefined ? -1 : (index.get(n.parent) ?? -1)));
  for (let i = 0; i < nodes.length; i++) {
    let cur = parentOf[i] as number;
    let hops = 0;
    while (cur !== -1 && cur !== i && hops <= nodes.length) {
      cur = parentOf[cur] as number;
      hops++;
    }
    if (cur === i || hops > nodes.length) parentOf[i] = -1;
  }
  let hierarchical = false;
  parentOf.forEach((p, i) => {
    if (p === -1) return;
    (nodes[i] as TreeNode).parent = p;
    (nodes[p] as TreeNode).children.push(i);
    hierarchical = true;
  });
  const visit = (i: number, tier: number, root: number): void => {
    const n = nodes[i] as TreeNode;
    n.tier = tier;
    n.root = root;
    for (const c of n.children) {
      const child = nodes[c] as TreeNode;
      visit(c, Math.min(TIER_SYMBOL, Math.max(kindTier(child.kind), tier + 1)), root);
    }
  };
  nodes.forEach((n, i) => {
    if (n.parent === -1) visit(i, 0, i);
  });
  const boxWorkspaces =
    Boolean(opts.boxWorkspaces) && nodes.some((n) => n.kind === "workspace" && n.children.length === 0);
  return { nodes, index, hierarchical: hierarchical || boxWorkspaces, boxWorkspaces };
}

export const isContainer = (t: Tree, i: number): boolean => (t.nodes[i] as TreeNode).children.length > 0;

/** A workspace without children still gets a labelled region, so the workspace-level map reads the same. */
export const isRegionLeaf = (t: Tree, i: number): boolean => {
  const n = t.nodes[i] as TreeNode;
  return t.boxWorkspaces && n.children.length === 0 && n.tier === TIER_WORKSPACE && n.kind === "workspace";
};

/** True when the node is drawn as a region (box with a label) rather than as a sigma node. */
export const isRegion = (t: Tree, i: number): boolean => isContainer(t, i) || isRegionLeaf(t, i);

/** Ancestor-or-self of `i` that is deepest while `tier <= maxTier`. */
export function liftTo(t: Tree, i: number, maxTier: number): number {
  let cur = i;
  while ((t.nodes[cur] as TreeNode).tier > maxTier) {
    const p = (t.nodes[cur] as TreeNode).parent;
    if (p === -1) break;
    cur = p;
  }
  return cur;
}

/** All leaf descendants (or the node itself when it is a leaf). */
export function leavesOf(t: Tree, i: number, out: number[] = []): number[] {
  const n = t.nodes[i] as TreeNode;
  if (n.children.length === 0) out.push(i);
  else for (const c of n.children) leavesOf(t, c, out);
  return out;
}

export function leafSize(t: Tree, i: number): [number, number] {
  const n = t.nodes[i] as TreeNode;
  if (isRegionLeaf(t, i)) return [WS_LEAF_W, WS_LEAF_H];
  return n.tier >= TIER_SYMBOL ? [CELL_W, CELL_H] : [FILE_LEAF_W, FILE_LEAF_H];
}

export function headFor(tier: number): number {
  return HEAD[Math.min(tier, TIER_FILE)] ?? 26;
}

/** True when every child is a leaf, so the container is laid out as a grid block. */
export function isGridBlock(t: Tree, i: number): boolean {
  const n = t.nodes[i] as TreeNode;
  return n.children.length > 0 && n.children.every((c) => (t.nodes[c] as TreeNode).children.length === 0);
}

export function gridDims(count: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.7)));
  return { cols, rows: Math.ceil(count / cols) };
}

/** Size of a grid block (children are leaves) including padding and header. */
export function gridBlockSize(t: Tree, i: number): [number, number] {
  const n = t.nodes[i] as TreeNode;
  const { cols, rows } = gridDims(n.children.length);
  return [cols * CELL_W + 2 * PAD, rows * CELL_H + PAD + headFor(n.tier)];
}

/** Cell centre of the k-th child of a grid block whose top-left corner is (x, y). */
export function gridCell(t: Tree, container: number, k: number, x: number, y: number): [number, number] {
  const n = t.nodes[container] as TreeNode;
  const { cols } = gridDims(n.children.length);
  return [
    x + PAD + (k % cols) * CELL_W + CELL_W / 2,
    y + headFor(n.tier) + Math.floor(k / cols) * CELL_H + CELL_H / 2,
  ];
}

/**
 * Regions (rounded boxes) for every container, derived bottom-up from leaf positions. Because the layout
 * reserves exactly these paddings, the derived boxes never overlap their siblings.
 */
export function deriveRegions(t: Tree, positions: Positions): Map<number, Rect> {
  const regions = new Map<number, Rect>();
  const box = (i: number): { x0: number; y0: number; x1: number; y1: number } | null => {
    const n = t.nodes[i] as TreeNode;
    if (n.children.length === 0) {
      const p = positions[n.id];
      if (!p) return null;
      const [w, h] = leafSize(t, i);
      const r = { x0: p[0] - w / 2, y0: p[1] - h / 2, x1: p[0] + w / 2, y1: p[1] + h / 2 };
      if (isRegionLeaf(t, i)) regions.set(i, { x: r.x0, y: r.y0, w, h });
      return r;
    }
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const c of n.children) {
      const b = box(c);
      if (!b) continue;
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
    }
    if (x0 === Number.POSITIVE_INFINITY) return null;
    const head = headFor(n.tier);
    const r = { x0: x0 - PAD, y0: y0 - head, x1: x1 + PAD, y1: y1 + PAD };
    regions.set(i, { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 });
    return r;
  };
  t.nodes.forEach((n, i) => {
    if (n.parent === -1) box(i);
  });
  return regions;
}

export interface AggEdge {
  src: number;
  dst: number;
  weight: number;
  kind: string;
  /** True when edges of different kinds were merged. */
  mixed: boolean;
}

/** Sums edge weights after mapping both ends through `rep`. Self-loops are dropped. Output order is deterministic. */
export function aggregateEdges(
  edges: readonly { src: number; dst: number; weight: number; kind: string }[],
  rep: (i: number) => number,
): AggEdge[] {
  const map = new Map<string, AggEdge>();
  for (const e of edges) {
    const a = rep(e.src);
    const b = rep(e.dst);
    if (a === b) continue;
    const key = `${a}>${b}`;
    const cur = map.get(key);
    if (cur) {
      cur.weight += e.weight;
      if (cur.kind !== e.kind) cur.mixed = true;
    } else map.set(key, { src: a, dst: b, weight: e.weight, kind: e.kind, mixed: false });
  }
  return [...map.values()].sort((p, q) => q.weight - p.weight || p.src - q.src || p.dst - q.dst);
}

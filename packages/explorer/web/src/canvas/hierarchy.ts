// The containment tree shared by the layout (which reserves the space) and the renderer.
export const CELL_W = 46;
export const CELL_H = 26;

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

/** The role of a node by its kind: 0 workspace, 1 folder, 2 file, 3 anything else (functions, externals). */
export function kindTier(kind: string): number {
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

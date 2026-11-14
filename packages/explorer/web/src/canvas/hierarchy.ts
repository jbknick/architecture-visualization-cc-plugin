// The containment tree shared by the layout (which reserves the space) and the renderer.
export const CELL_W = 46;
export const CELL_H = 26;

export const TIER_WORKSPACE = 0;
export const TIER_DIR = 1;
export const TIER_FILE = 2;
export const TIER_SYMBOL = 3;

/** Kind of the synthetic cell that gathers the loose files next to a collapsed lone folder ("(root files)"). */
export const GROUP_KIND = "group";
/** A lone folder is lifted when the files beside it hold less than this share of the container's functions. */
export const LOOSE_SHARE = 0.1;

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
  if (kind === "directory" || kind === "dir" || kind === GROUP_KIND) return TIER_DIR;
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

export interface ChainInfo {
  /** 1 for a folder that is the only child folder of a workspace or folder (see `collapseChains`): no header, no box. */
  skipped: Uint8Array;
  /** Visible container -> the skipped folders below it, outermost first (`src`, `lib` for `src/lib`). */
  chain: Map<number, number[]>;
  /** Folders between a node and its workspace that have a header (skipped ones do not count), 0 for roots. */
  depth: Uint8Array;
}

/**
 * Single-child folder chains: a workspace or folder with exactly one child folder shows that folder's children
 * directly when it holds no file of its own, or when its loose files (config files next to `src`) hold less than
 * `LOOSE_SHARE` of its functions. In the second case the files are gathered in a "(root files)" group cell next
 * to the lifted children (see `withRootFileGroups` in `scene.ts`), or, when no file cells are loaded, only counted.
 * `files[i]` and `functions[i]` are the numbers of files and functions under node `i`; without them a folder
 * with loose files is never collapsed. Purely structural, so the layout worker and the renderer agree; ids and
 * selection are untouched.
 */
export function collapseChains(t: Tree, files?: ArrayLike<number>, functions?: ArrayLike<number>): ChainInfo {
  const skipped = new Uint8Array(t.nodes.length);
  const isGroup = (k: number) => (t.nodes[k] as TreeNode).kind === GROUP_KIND;
  const isFolder = (k: number) => kindTier((t.nodes[k] as TreeNode).kind) === TIER_DIR && !isGroup(k);
  /** The only child folder of `i` when everything else below `i` is a group cell, else -1. */
  const loneFolder = (i: number): number => {
    const n = t.nodes[i] as TreeNode;
    if (kindTier(n.kind) > TIER_DIR || isGroup(i)) return -1;
    const folders = n.children.filter(isFolder);
    if (folders.length !== 1) return -1;
    if (n.children.some((k) => !isFolder(k) && !isGroup(k))) return -1; // loose file cells that were not grouped
    return folders[0] as number;
  };
  t.nodes.forEach((n, i) => {
    const c = loneFolder(i);
    if (c === -1) return;
    const hasGroup = n.children.some(isGroup);
    const loose = files ? (files[i] as number) - (files[c] as number) : 0;
    if (!hasGroup && loose > 0) {
      // Counts only (no file cells below this node): collapse when the loose files are a small share.
      const total = functions ? (functions[i] as number) : Number.NaN;
      if (!(total >= 0)) return;
      const share = total > 0 ? (total - (functions?.[c] as number)) / total : 0;
      if (share >= LOOSE_SHARE) return;
    }
    skipped[c] = 1;
  });
  const chain = new Map<number, number[]>();
  const depth = new Uint8Array(t.nodes.length);
  const walk = (i: number, d: number): void => {
    const n = t.nodes[i] as TreeNode;
    const mine = n.parent === -1 || skipped[i] ? d : d + (kindTier(n.kind) === TIER_DIR ? 1 : 0);
    depth[i] = Math.min(255, mine);
    if (!skipped[i] && n.children.length > 0) {
      const below: number[] = [];
      for (let cur = n; ; ) {
        const c = cur.children.find((k) => skipped[k] === 1);
        if (c === undefined) break;
        below.push(c);
        cur = t.nodes[c] as TreeNode;
      }
      if (below.length > 0) chain.set(i, below);
    }
    for (const c of n.children) walk(c, mine);
  };
  t.nodes.forEach((n, i) => {
    if (n.parent === -1) walk(i, 0);
  });
  return { skipped, chain, depth };
}

/** All leaf descendants (or the node itself when it is a leaf). */
export function leavesOf(t: Tree, i: number, out: number[] = []): number[] {
  const n = t.nodes[i] as TreeNode;
  if (n.children.length === 0) out.push(i);
  else for (const c of n.children) leavesOf(t, c, out);
  return out;
}

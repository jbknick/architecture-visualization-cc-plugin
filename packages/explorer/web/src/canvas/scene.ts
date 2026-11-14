// Everything derived from (nodes, edges) that does not depend on positions or the camera.
import type { GraphEdge, GraphNode } from "../api.ts";
import {
  buildTree,
  collapseChains,
  GROUP_KIND,
  kindTier,
  LOOSE_SHARE,
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

/** A workspace-to-workspace link. `weight` counts imports (or uses); `declaredOnly` links come only from package.json. */
export interface WsEdge {
  src: number;
  dst: number;
  weight: number;
  declaredOnly: boolean;
  /** The pair also has a `depends_on` link in package.json (it never adds to `weight`). */
  declared: boolean;
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
  /** 1 for a folder drawn without a header or box: the only child folder of a container with no files of its own. */
  skipped: Uint8Array;
  /** Visible container -> the skipped folders below it, outermost first. */
  chain: Map<number, number[]>;
  /** Folders with a header between a cell and its workspace (see `collapseChains`). */
  depth: Uint8Array;
  /** Workspace-to-workspace links, heaviest first. */
  wsEdges: WsEdge[];
  /** Edge indices incident to each node. */
  incident: Map<number, number[]>;
  hierarchical: boolean;
  /**
   * True at the Folders level when file nodes were loaded in the background only to fill folders with a faint
   * mosaic: file cells are drawn without text and cannot be picked.
   */
  mosaic: boolean;
}

/**
 * A workspace or folder where one child folder holds at least `1 - LOOSE_SHARE` (90%) of the functions, with other
 * folders or files beside it (config files, story-config folders): everything beside the big folder moves into one
 * synthetic trailing group cell, "(other)" (or "(root files)" when only files are gathered), so the big folder can be
 * lifted (see `collapseChains`). Ids are unchanged; only the `parent` of the gathered nodes is. A group that is
 * already there (the Folders level loads file cells later, in a second pass) takes the files that arrive.
 */
export function withRootFileGroups(nodes: GraphNode[]): GraphNode[] {
  const kids = new Map<string, GraphNode[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const regroup = new Map<string, string>(); // gathered node id -> group id
  const groups: GraphNode[] = [];
  const isFolder = (k: GraphNode) => kindTier(k.kind) === TIER_DIR && k.kind !== GROUP_KIND;
  for (const x of nodes) {
    if (kindTier(x.kind) > TIER_DIR || x.kind === GROUP_KIND) continue;
    const list = kids.get(x.id) ?? [];
    const folders = list.filter(isFolder);
    if (folders.length === 0) continue;
    const existing = list.find((k) => k.kind === GROUP_KIND);
    // The biggest folder (ties: first by id) and everything beside it.
    const main = folders.reduce((best, f) =>
      (f.stats?.functions ?? 0) > (best.stats?.functions ?? 0) ? f : best,
    );
    const others = list.filter((k) => k !== main && k !== existing);
    if (others.length === 0) continue; // a lone folder: `collapseChains` lifts it
    const inMain = main.stats?.functions;
    if (inMain === undefined) continue;
    const othersFns = others.reduce((sum, k) => sum + (k.stats?.functions ?? 0), 0);
    const total = x.stats?.functions;
    const all = total ?? inMain + othersFns;
    const loose = total !== undefined ? Math.max(0, total - inMain) : othersFns;
    if (all > 0 ? inMain / all < 1 - LOOSE_SHARE : folders.length !== 1) continue;
    if (existing) {
      for (const k of others) regroup.set(k.id, existing.id);
      continue;
    }
    const id = `rootfiles:${x.id}`;
    const withFolders = others.some(isFolder);
    const fileCount = others.reduce((sum, k) => sum + (k.stats?.files ?? (k.kind === "file" ? 1 : 0)), 0);
    groups.push({
      id,
      kind: GROUP_KIND,
      label: withFolders ? "(other)" : "(root files)",
      parent: x.id,
      size: Math.max(1, others.length),
      stats: { files: fileCount, functions: loose },
    });
    for (const k of others) regroup.set(k.id, id);
  }
  if (groups.length === 0 && regroup.size === 0) return nodes;
  return [...nodes.map((n) => (regroup.has(n.id) ? { ...n, parent: regroup.get(n.id) } : n)), ...groups];
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
  // Declared dependencies are tracked apart: an import count is the sum of the import edges only, whatever the
  // order the edges arrive in.
  const declaredWeight = new Map<string, number>();
  for (const e of source) {
    const a = liftTo(tree, e.src, TIER_WORKSPACE);
    const b = liftTo(tree, e.dst, TIER_WORKSPACE);
    if (a === b) continue;
    const key = `${a}>${b}`;
    const cur = map.get(key) ?? {
      src: a,
      dst: b,
      weight: 0,
      declaredOnly: true,
      declared: false,
      kind: e.kind,
    };
    if (e.kind !== "depends_on") {
      cur.weight += e.weight;
      cur.declaredOnly = false;
      cur.kind = e.kind;
    } else {
      cur.declared = true;
      declaredWeight.set(key, Math.max(declaredWeight.get(key) ?? 0, e.weight));
    }
    map.set(key, cur);
  }
  for (const [key, e] of map) if (e.declaredOnly) e.weight = declaredWeight.get(key) ?? e.weight;
  return [...map.values()].sort((p, q) => q.weight - p.weight || p.src - q.src || p.dst - q.dst);
}

/** `hint` decides whether childless workspaces become boxes: only the nested hint (project map) does. */
export function buildScene(
  input: GraphNode[],
  edges: GraphEdge[],
  hint = "nested-elk",
  opts: { mosaic?: boolean } = {},
): Scene {
  const nodes = hint === "nested-elk" ? withRootFileGroups(input) : input;
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

  const collapsed = collapseChains(tree, files, functions);

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
    skipped: collapsed.skipped,
    chain: collapsed.chain,
    depth: collapsed.depth,
    wsEdges: tree.hierarchical ? buildWsEdges(tree, sceneEdges) : [],
    incident,
    hierarchical: tree.hierarchical,
    mosaic: Boolean(opts.mosaic),
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
  // The repo-root workspace shows "(repo root)" where the others show their type ("app", "package").
  const badge = node?.id === "ws:." ? "(repo root)" : node?.badges?.[0];
  if (badge) parts.push(badge);
  parts.push(`${fn.toLocaleString("en-US")} ${fn === 1 ? "function" : "functions"}`);
  if (files > 0 || node?.stats?.files !== undefined)
    parts.push(`${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}`);
  // Folders skipped below the workspace (a lone `src`): named here instead of in a header of their own.
  const skipped = scene.chain.get(i);
  if (skipped && skipped.length > 0)
    parts.push(`${skipped.map((k) => folderName(scene.nodes[k]?.label ?? "")).join("/")}/`);
  return parts;
}

/** A folder's display name: its last path segment, or the last two when the server joined a chain (`a/b/c` -> `b/c`). */
export function folderName(label: string): string {
  const segs = label.split("/").filter(Boolean);
  return segs.slice(-2).join("/") || label;
}

/** Header text of a folder: its name plus the folders skipped below it (`src/lib`). */
export function folderTitle(scene: Scene, i: number): string {
  const own = folderName(scene.nodes[i]?.label ?? "");
  const below = (scene.chain.get(i) ?? []).map((k) => folderName(scene.nodes[k]?.label ?? ""));
  return below.length > 0 ? [own, ...below].join("/") : own;
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
      files: scene.files[i],
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

// Deterministic layouts. Pure functions (no DOM), so the same code runs in the worker and in tests.
// No Math.random anywhere: initial positions come from a hash of the node id.
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import {
  aggregateEdges,
  buildTree,
  CELL_H,
  CELL_W,
  deriveRegions,
  GAP,
  gridBlockSize,
  gridCell,
  headFor,
  isGridBlock,
  leafSize,
  leavesOf,
  PAD,
  type Tree,
  type TreeNode,
} from "./hierarchy.ts";
import { hashString, unitPair } from "./prng.ts";
import type { LayoutInput, LayoutResult, Positions } from "./types.ts";

type Hint = "layered" | "radial" | "tree" | "force" | "columns" | "clusters" | "grid" | "packed";

function normaliseHint(raw: string, hierarchical: boolean): Hint {
  switch (raw) {
    case "nested-elk":
      return hierarchical ? "layered" : "force";
    case "elk-layered":
    case "layered":
      return "layered";
    case "tree-lr":
    case "tree":
      return hierarchical ? "layered" : "tree";
    case "radial":
      return "radial";
    case "columns":
      return hierarchical ? "packed" : "columns";
    case "clusters":
      return hierarchical ? "packed" : "clusters";
    case "grid":
      return hierarchical ? "packed" : "grid";
    default:
      return hierarchical ? "layered" : "force";
  }
}

interface IdxEdge {
  src: number;
  dst: number;
  weight: number;
  kind: string;
}

function indexEdges(tree: Tree, input: LayoutInput): IdxEdge[] {
  const out: IdxEdge[] = [];
  for (const e of input.edges) {
    const a = tree.index.get(e.src);
    const b = tree.index.get(e.dst);
    if (a !== undefined && b !== undefined && a !== b)
      out.push({ src: a, dst: b, weight: e.weight, kind: "" });
  }
  return out;
}

/** Entry point: lay out everything, honouring saved positions. */
export async function computeLayout(input: LayoutInput): Promise<LayoutResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const tree = buildTree(input.nodes, { boxWorkspaces: input.hint === "nested-elk" });
  const edges = indexEdges(tree, input);
  const hint = normaliseHint(input.hint, tree.hierarchical);

  const saved = input.saved ?? {};
  const placed = new Set<number>();
  tree.nodes.forEach((n, i) => {
    if (saved[n.id] && n.children.length === 0) placed.add(i);
  });
  const leafCount = tree.nodes.filter((n) => n.children.length === 0).length;

  let positions: Positions;
  let strategy: string;
  let changed: boolean;
  if (placed.size > 0 && placed.size >= leafCount * 0.5) {
    positions = placeIncremental(tree, edges, saved, placed);
    strategy = "saved";
    const removed = Object.keys(saved).some((id) => !tree.index.has(id));
    changed = placed.size < leafCount || removed;
  } else {
    const fresh = await layoutFresh(tree, edges, hint, input.focus);
    positions = fresh.positions;
    strategy = fresh.strategy;
    changed = true;
  }
  finalizeContainers(tree, positions);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { positions, changed, ms: Math.round(t1 - t0), strategy };
}

async function layoutFresh(
  tree: Tree,
  edges: IdxEdge[],
  hint: Hint,
  focus: string | null,
): Promise<{ positions: Positions; strategy: string }> {
  if (tree.hierarchical) {
    const positions = await layoutHierarchy(tree, edges, hint, focus);
    return { positions, strategy: `hierarchy/${hint}` };
  }
  switch (hint) {
    case "layered":
      return { positions: await layoutFlatElk(tree, edges), strategy: "elk-layered" };
    case "tree":
      return { positions: layoutTree(tree, edges), strategy: "tree-lr" };
    case "radial":
      return { positions: layoutRadial(tree, edges, focus), strategy: "radial" };
    case "columns":
      return { positions: layoutColumns(tree), strategy: "columns" };
    case "clusters":
      return { positions: layoutClusters(tree), strategy: "clusters" };
    case "grid":
    case "packed":
      return { positions: layoutGrid(tree), strategy: "grid" };
    default:
      return { positions: layoutForce(tree, edges), strategy: "force" };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Hierarchical (nested) layout

interface Built {
  elk: ElkNode;
  /** elk id -> tree index */
  byId: Map<string, number>;
}

function elkIdOf(i: number): string {
  return `n${i}`;
}

function buildElkTree(tree: Tree, i: number, byId: Map<string, number>): ElkNode {
  const n = tree.nodes[i] as TreeNode;
  byId.set(elkIdOf(i), i);
  if (n.children.length === 0) {
    const [w, h] = leafSize(tree, i);
    return { id: elkIdOf(i), width: w, height: h };
  }
  if (isGridBlock(tree, i)) {
    const [w, h] = gridBlockSize(tree, i);
    return { id: elkIdOf(i), width: w, height: h };
  }
  const head = headFor(n.tier);
  return {
    id: elkIdOf(i),
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.padding": `[top=${head},left=${PAD},bottom=${PAD},right=${PAD}]`,
      "elk.spacing.nodeNode": String(GAP),
      "elk.aspectRatio": "1.35",
    },
    children: n.children.map((c) => buildElkTree(tree, c, byId)),
  };
}

function rootsOf(tree: Tree): number[] {
  const roots: number[] = [];
  tree.nodes.forEach((n, i) => {
    if (n.parent === -1) roots.push(i);
  });
  return roots;
}

async function layoutHierarchy(
  tree: Tree,
  edges: IdxEdge[],
  hint: Hint,
  focus: string | null,
): Promise<Positions> {
  const roots = rootsOf(tree);
  const byId = new Map<string, number>();
  const rootElk = roots.map((r) => buildElkTree(tree, r, byId));
  const built: Built = { elk: { id: "root", children: rootElk }, byId };
  const rootEdges = aggregateEdges(
    edges.map((e) => ({ ...e })),
    (i) => (tree.nodes[i] as TreeNode).root,
  );

  const layered = hint === "layered";
  built.elk.layoutOptions = layered
    ? {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "70",
        "elk.layered.spacing.nodeNodeBetweenLayers": "200",
        "elk.spacing.componentComponent": "70",
        "elk.aspectRatio": "1.6",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      }
    : {
        "elk.algorithm": "rectpacking",
        "elk.spacing.nodeNode": "70",
        "elk.aspectRatio": "1.5",
      };
  if (layered) {
    built.elk.edges = rootEdges.map((e, k) => ({
      id: `e${k}`,
      sources: [elkIdOf(e.src)],
      targets: [elkIdOf(e.dst)],
    }));
  }
  const elk = new ELK();
  const out = await elk.layout(built.elk);

  // Absolute top-left of every elk node.
  const topLeft = new Map<number, [number, number]>();
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const c of node.children ?? []) {
      const i = built.byId.get(c.id);
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      if (i !== undefined) topLeft.set(i, [x, y]);
      walk(c, x, y);
    }
  };
  walk(out, 0, 0);

  if (hint === "radial") {
    const sizes = new Map<number, [number, number]>();
    for (const c of out.children ?? []) {
      const i = built.byId.get(c.id);
      if (i !== undefined) sizes.set(i, [c.width ?? 0, c.height ?? 0]);
    }
    const centres = radialBoxes(tree, roots, sizes, rootEdges, focus);
    for (const r of roots) {
      const old = topLeft.get(r) as [number, number];
      const size = sizes.get(r) as [number, number];
      const c = centres.get(r) as [number, number];
      const dx = c[0] - size[0] / 2 - old[0];
      const dy = c[1] - size[1] / 2 - old[1];
      shiftSubtree(tree, r, dx, dy, topLeft);
    }
  }

  // Leaves: grid-block children sit in their cells, free leaves at their box centre.
  const positions: Positions = {};
  const place = (i: number): void => {
    const n = tree.nodes[i] as TreeNode;
    const tl = topLeft.get(i);
    if (n.children.length === 0) {
      if (tl) {
        const [w, h] = leafSize(tree, i);
        positions[n.id] = [tl[0] + w / 2, tl[1] + h / 2];
      }
      return;
    }
    if (isGridBlock(tree, i)) {
      if (!tl) return;
      n.children.forEach((c, k) => {
        positions[(tree.nodes[c] as TreeNode).id] = gridCell(tree, i, k, tl[0], tl[1]);
      });
      return;
    }
    for (const c of n.children) place(c);
  };
  for (const r of roots) place(r);
  return positions;
}

function shiftSubtree(
  tree: Tree,
  i: number,
  dx: number,
  dy: number,
  topLeft: Map<number, [number, number]>,
): void {
  const tl = topLeft.get(i);
  if (tl) topLeft.set(i, [tl[0] + dx, tl[1] + dy]);
  for (const c of (tree.nodes[i] as TreeNode).children) shiftSubtree(tree, c, dx, dy, topLeft);
}

/** Ring placement of boxes: the focus (or most connected) box in the middle, neighbours on outer rings. */
function radialBoxes(
  tree: Tree,
  roots: number[],
  sizes: Map<number, [number, number]>,
  rootEdges: { src: number; dst: number; weight: number }[],
  focus: string | null,
): Map<number, [number, number]> {
  const adj = new Map<number, number[]>();
  const degree = new Map<number, number>();
  for (const r of roots) {
    adj.set(r, []);
    degree.set(r, 0);
  }
  for (const e of rootEdges) {
    adj.get(e.src)?.push(e.dst);
    adj.get(e.dst)?.push(e.src);
    degree.set(e.src, (degree.get(e.src) ?? 0) + e.weight);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + e.weight);
  }
  const focusIdx = focus ? tree.index.get(focus) : undefined;
  let centre = focusIdx === undefined ? undefined : (tree.nodes[focusIdx] as TreeNode).root;
  if (centre === undefined) {
    centre = roots[0] as number;
    for (const r of roots) if ((degree.get(r) ?? 0) > (degree.get(centre) ?? 0)) centre = r;
  }
  const ring = new Map<number, number>([[centre, 0]]);
  const queue = [centre];
  for (let q = 0; q < queue.length; q++) {
    const cur = queue[q] as number;
    for (const nb of [...(adj.get(cur) ?? [])].sort((a, b) => a - b)) {
      if (!ring.has(nb)) {
        ring.set(nb, (ring.get(cur) as number) + 1);
        queue.push(nb);
      }
    }
  }
  const maxRing = Math.max(...ring.values());
  for (const r of roots) if (!ring.has(r)) ring.set(r, maxRing + 1);

  const extent = (i: number): number => {
    const s = sizes.get(i) as [number, number];
    return Math.hypot(s[0], s[1]) / 2;
  };
  const out = new Map<number, [number, number]>([[centre, [0, 0]]]);
  let prevRadius = 0;
  let prevExtent = extent(centre);
  for (let level = 1; level <= Math.max(...ring.values()); level++) {
    const members = roots.filter((r) => ring.get(r) === level);
    if (members.length === 0) continue;
    const maxExt = Math.max(...members.map(extent));
    const circumference = members.reduce((sum, r) => sum + extent(r) * 2 + 60, 0);
    const radius = Math.max(prevRadius + prevExtent + maxExt + 120, circumference / (2 * Math.PI));
    let angle = -Math.PI / 2 + (level % 2 === 0 ? Math.PI / members.length : 0);
    for (const r of members) {
      const share = ((extent(r) * 2 + 60) / circumference) * 2 * Math.PI;
      const a = angle + share / 2;
      out.set(r, [Math.cos(a) * radius, Math.sin(a) * radius]);
      angle += share;
    }
    prevRadius = radius;
    prevExtent = maxExt;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Flat layouts

function nodeIdsByOrder(tree: Tree): number[] {
  return tree.nodes.map((_, i) => i);
}

async function layoutFlatElk(tree: Tree, edges: IdxEdge[]): Promise<Positions> {
  if (tree.nodes.length > 4000) return layoutTree(tree, edges);
  const children: ElkNode[] = tree.nodes.map((_, i) => ({ id: elkIdOf(i), width: 48, height: 24 }));
  const seen = new Set<string>();
  const elkEdges: NonNullable<ElkNode["edges"]> = [];
  for (const e of edges) {
    const key = `${e.src}>${e.dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elkEdges.push({ id: `e${elkEdges.length}`, sources: [elkIdOf(e.src)], targets: [elkIdOf(e.dst)] });
  }
  const out = await new ELK().layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.aspectRatio": "1.6",
    },
    children,
    edges: elkEdges,
  });
  const positions: Positions = {};
  for (const c of out.children ?? []) {
    const i = Number(c.id.slice(1));
    positions[(tree.nodes[i] as TreeNode).id] = [
      (c.x ?? 0) + (c.width ?? 0) / 2,
      (c.y ?? 0) + (c.height ?? 0) / 2,
    ];
  }
  return positions;
}

function layoutForce(tree: Tree, edges: IdxEdge[]): Positions {
  const n = tree.nodes.length;
  const graph = new Graph({ type: "undirected", multi: false });
  const spread = 40 * Math.sqrt(Math.max(n, 1));
  tree.nodes.forEach((node) => {
    const [u, v] = unitPair(node.id);
    const angle = u * Math.PI * 2;
    const r = spread * Math.sqrt(v);
    graph.addNode(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });
  for (const e of edges) {
    const a = (tree.nodes[e.src] as TreeNode).id;
    const b = (tree.nodes[e.dst] as TreeNode).id;
    if (!graph.hasEdge(a, b)) graph.addEdge(a, b, { weight: Math.max(1, e.weight) });
  }
  if (n > 1) {
    const iterations = n <= 500 ? 400 : n <= 5000 ? 200 : 80;
    const inferred = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations,
      settings: { ...inferred, barnesHutOptimize: n > 800, gravity: 1.2, scalingRatio: 14, slowDown: 2 },
      getEdgeWeight: "weight",
    });
  }
  const positions: Positions = {};
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const node of tree.nodes) {
    const x = graph.getNodeAttribute(node.id, "x") as number;
    const y = graph.getNodeAttribute(node.id, "y") as number;
    positions[node.id] = [x, y];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  // Scale so neighbouring nodes keep room for labels regardless of how FA2 normalised the picture.
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const target = 110 * Math.sqrt(Math.max(n, 1));
  const k = target / span;
  for (const node of tree.nodes) {
    const p = positions[node.id] as [number, number];
    p[0] = round((p[0] - (x0 + x1) / 2) * k);
    p[1] = round((p[1] - (y0 + y1) / 2) * k);
  }
  return positions;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function undirectedAdj(tree: Tree, edges: IdxEdge[]): number[][] {
  const adj: number[][] = tree.nodes.map(() => []);
  for (const e of edges) {
    (adj[e.src] as number[]).push(e.dst);
    (adj[e.dst] as number[]).push(e.src);
  }
  for (const list of adj) list.sort((a, b) => a - b);
  return adj;
}

function layoutTree(tree: Tree, edges: IdxEdge[]): Positions {
  const n = tree.nodes.length;
  const indeg = new Int32Array(n);
  const out: number[][] = tree.nodes.map(() => []);
  for (const e of edges) {
    indeg[e.dst] = (indeg[e.dst] as number) + 1;
    (out[e.src] as number[]).push(e.dst);
  }
  for (const list of out) list.sort((a, b) => a - b);
  const depth = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  const seed = (i: number): void => {
    if (depth[i] === -1) {
      depth[i] = 0;
      queue.push(i);
    }
  };
  for (let i = 0; i < n; i++) if (indeg[i] === 0) seed(i);
  for (let q = 0; ; q++) {
    for (; q < queue.length; q++) {
      const cur = queue[q] as number;
      for (const nb of out[cur] as number[]) {
        if (depth[nb] === -1) {
          depth[nb] = (depth[cur] as number) + 1;
          queue.push(nb);
        }
      }
    }
    const rest = depth.indexOf(-1); // cycles: start from the first unreached node
    if (rest === -1) break;
    seed(rest);
  }
  const layers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const d = depth[i] as number;
    if (!layers.has(d)) layers.set(d, []);
    (layers.get(d) as number[]).push(i);
  }
  const positions: Positions = {};
  for (const [d, members] of layers) {
    members.forEach((i, k) => {
      positions[(tree.nodes[i] as TreeNode).id] = [d * 240, (k - (members.length - 1) / 2) * 38];
    });
  }
  return positions;
}

function layoutRadial(tree: Tree, edges: IdxEdge[], focus: string | null): Positions {
  const n = tree.nodes.length;
  const adj = undirectedAdj(tree, edges);
  const focusIdx = focus ? tree.index.get(focus) : undefined;
  let centre = focusIdx ?? 0;
  if (focusIdx === undefined) {
    for (let i = 0; i < n; i++)
      if ((adj[i] as number[]).length > (adj[centre] as number[]).length) centre = i;
  }
  const ring = new Int32Array(n).fill(-1);
  const order: number[] = [];
  const bfs = (start: number, base: number): void => {
    ring[start] = base;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q] as number;
      order.push(cur);
      for (const nb of adj[cur] as number[]) {
        if (ring[nb] === -1) {
          ring[nb] = (ring[cur] as number) + 1;
          queue.push(nb);
        }
      }
    }
  };
  if (n > 0) bfs(centre, 0);
  const outer = Math.max(0, ...ring) + 1;
  for (let i = 0; i < n; i++) if (ring[i] === -1) bfs(i, outer);
  const byRing = new Map<number, number[]>();
  for (const i of order) {
    const r = ring[i] as number;
    if (!byRing.has(r)) byRing.set(r, []);
    (byRing.get(r) as number[]).push(i);
  }
  const positions: Positions = {};
  let radius = 0;
  for (const [r, members] of [...byRing.entries()].sort((a, b) => a[0] - b[0])) {
    if (r === 0) {
      for (const i of members) positions[(tree.nodes[i] as TreeNode).id] = [0, 0];
      continue;
    }
    radius = Math.max(radius + 170, (members.length * 62) / (2 * Math.PI));
    members.forEach((i, k) => {
      const a = (k / members.length) * Math.PI * 2 - Math.PI / 2;
      positions[(tree.nodes[i] as TreeNode).id] = [round(Math.cos(a) * radius), round(Math.sin(a) * radius)];
    });
  }
  return positions;
}

function groupByKind(tree: Tree): [string, number[]][] {
  const groups = new Map<string, number[]>();
  tree.nodes.forEach((n, i) => {
    if (!groups.has(n.kind)) groups.set(n.kind, []);
    (groups.get(n.kind) as number[]).push(i);
  });
  for (const members of groups.values()) {
    members.sort((a, b) => (tree.nodes[b] as TreeNode).size - (tree.nodes[a] as TreeNode).size || a - b);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
}

function layoutColumns(tree: Tree): Positions {
  const positions: Positions = {};
  let x = 0;
  for (const [, members] of groupByKind(tree)) {
    const perColumn = 40;
    members.forEach((i, k) => {
      const col = Math.floor(k / perColumn);
      positions[(tree.nodes[i] as TreeNode).id] = [x + col * 190, (k % perColumn) * 34];
    });
    x += (Math.floor((members.length - 1) / perColumn) + 1) * 190 + 120;
  }
  return positions;
}

function layoutClusters(tree: Tree): Positions {
  const positions: Positions = {};
  const groups = groupByKind(tree);
  const radii = groups.map(([, m]) => 60 + 34 * Math.sqrt(m.length));
  const rowWidth = Math.max(1200, 2.2 * Math.max(...radii, 1));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  groups.forEach(([, members], g) => {
    const r = radii[g] as number;
    if (x > 0 && x + 2 * r > rowWidth) {
      x = 0;
      y += rowHeight + 80;
      rowHeight = 0;
    }
    const cx = x + r;
    const cy = y + r;
    members.forEach((i, k) => {
      const a = k * 2.399963229728653; // golden angle
      const d = 34 * Math.sqrt(k + 0.5);
      positions[(tree.nodes[i] as TreeNode).id] = [round(cx + Math.cos(a) * d), round(cy + Math.sin(a) * d)];
    });
    x += 2 * r + 80;
    rowHeight = Math.max(rowHeight, 2 * r);
  });
  return positions;
}

function layoutGrid(tree: Tree): Positions {
  const positions: Positions = {};
  const order = nodeIdsByOrder(tree).sort(
    (a, b) =>
      (tree.nodes[a] as TreeNode).kind.localeCompare((tree.nodes[b] as TreeNode).kind) ||
      (tree.nodes[a] as TreeNode).id.localeCompare((tree.nodes[b] as TreeNode).id),
  );
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
  order.forEach((i, k) => {
    positions[(tree.nodes[i] as TreeNode).id] = [(k % cols) * 190, Math.floor(k / cols) * 60];
  });
  return positions;
}

// ---------------------------------------------------------------------------------------------------------
// Saved positions: keep what is known, place newcomers near their parent.

function placeIncremental(tree: Tree, edges: IdxEdge[], saved: Positions, placed: Set<number>): Positions {
  const positions: Positions = {};
  for (const i of placed) {
    const id = (tree.nodes[i] as TreeNode).id;
    positions[id] = [...(saved[id] as [number, number])] as [number, number];
  }
  const adj = undirectedAdj(tree, edges);
  const counters = new Map<number, number>();
  const unplaced: number[] = [];
  tree.nodes.forEach((n, i) => {
    if (n.children.length === 0 && !placed.has(i)) unplaced.push(i);
  });
  for (const i of unplaced) {
    const n = tree.nodes[i] as TreeNode;
    let anchorKey = -1;
    let pos: [number, number] | undefined;
    if (n.parent !== -1) {
      // Below the lowest placed sibling-or-cousin leaf of the parent, one cell per newcomer.
      anchorKey = n.parent;
      const sibs = leavesOf(tree, n.parent)
        .filter((s) => positions[(tree.nodes[s] as TreeNode).id])
        .map((s) => positions[(tree.nodes[s] as TreeNode).id] as [number, number]);
      const k = counters.get(anchorKey) ?? 0;
      counters.set(anchorKey, k + 1);
      if (sibs.length > 0) {
        const minX = Math.min(...sibs.map((p) => p[0]));
        const maxY = Math.max(...sibs.map((p) => p[1]));
        pos = [minX + (k % 4) * CELL_W, maxY + CELL_H * (1 + Math.floor(k / 4))];
      }
    }
    if (!pos) {
      const near = (adj[i] as number[])
        .map((j) => positions[(tree.nodes[j] as TreeNode).id])
        .filter((p): p is [number, number] => p !== undefined);
      const base: [number, number] =
        near.length > 0
          ? [avg(near.map((p) => p[0])), avg(near.map((p) => p[1]))]
          : (() => {
              const all = Object.values(positions);
              return all.length > 0 ? [avg(all.map((p) => p[0])), avg(all.map((p) => p[1]))] : [0, 0];
            })();
      const k = counters.get(anchorKey) ?? 0;
      counters.set(anchorKey, k + 1);
      const h = hashString(n.id);
      const a = ((h % 3600) / 3600) * Math.PI * 2;
      const d = 70 + 14 * Math.sqrt(k);
      pos = [base[0] + Math.cos(a) * d, base[1] + Math.sin(a) * d];
    }
    positions[n.id] = [round(pos[0]), round(pos[1])];
  }
  return positions;
}

function avg(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Container nodes sit at the centre of their derived region (or the centroid of their leaves when flat). */
function finalizeContainers(tree: Tree, positions: Positions): void {
  const regions = deriveRegions(tree, positions);
  tree.nodes.forEach((n, i) => {
    if (n.children.length === 0) return;
    const r = regions.get(i);
    if (r) {
      positions[n.id] = [round(r.x + r.w / 2), round(r.y + r.h / 2)];
      return;
    }
    const leaves = leavesOf(tree, i)
      .map((l) => positions[(tree.nodes[l] as TreeNode).id])
      .filter((p): p is [number, number] => p !== undefined);
    positions[n.id] = [round(avg(leaves.map((p) => p[0]))), round(avg(leaves.map((p) => p[1])))];
  });
  for (const p of Object.values(positions)) {
    p[0] = round(p[0]);
    p[1] = round(p[1]);
  }
}

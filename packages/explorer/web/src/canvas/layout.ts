// Deterministic layouts. Pure functions (no DOM), so the same code runs in the worker and in tests.
// No Math.random anywhere: initial positions come from a hash of the node id.
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { FLOW_BOX_H, FLOW_BOX_W } from "./flowGeom.ts";
import { buildTree, CELL_H, CELL_W, leavesOf, type Tree, type TreeNode } from "./hierarchy.ts";
import { layoutMap } from "./mapLayout.ts";
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
      out.push({ src: a, dst: b, weight: e.weight, kind: e.kind ?? "" });
  }
  return out;
}

const LANE_GAP_COLUMNS = 150;
const LANE_GAP_TREE = 110;
const LANE_ROW = 40;
const BAND_GAP = 90;

/** Entry point: lay out everything, honouring saved positions. */
export async function computeLayout(input: LayoutInput): Promise<LayoutResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const tree = buildTree(input.nodes, { boxWorkspaces: input.hint === "nested-elk" });
  const edges = indexEdges(tree, input);
  const hint = normaliseHint(input.hint, tree.hierarchical);

  if (!tree.hierarchical && input.nodes.some((n) => n.lane !== undefined)) {
    // Lanes (#48) come from the data: the same answer gives the same picture, nothing is saved.
    const lanes = lanesOf(tree, input);
    const positions =
      hint === "layered"
        ? await layoutLaneElk(tree, edges, lanes, input)
        : hint === "tree"
          ? layoutLaneTree(tree, edges, lanes)
          : layoutLaneColumns(tree, lanes, FLOW_BOX_W + LANE_GAP_COLUMNS);
    for (const p of Object.values(positions)) {
      p[0] = round(p[0]);
      p[1] = round(p[1]);
    }
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return { positions, changed: false, ms: Math.round(t1 - t0), strategy: `lanes/${hint}` };
  }

  if (tree.hierarchical) {
    // Workspace boxes with a treemap inside. Everything is derived from the data, so saved positions do not apply.
    const { positions, map } = await layoutMap(tree, edges, input);
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return { positions, changed: false, ms: Math.round(t1 - t0), strategy: "treemap/layered", map };
  }

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
  for (const p of Object.values(positions)) {
    p[0] = round(p[0]);
    p[1] = round(p[1]);
  }
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { positions, changed, ms: Math.round(t1 - t0), strategy };
}

async function layoutFresh(
  tree: Tree,
  edges: IdxEdge[],
  hint: Hint,
  focus: string | null,
): Promise<{ positions: Positions; strategy: string }> {
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

function elkIdOf(i: number): string {
  return `n${i}`;
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
// Lanes (#48): columns, swimlanes and reversed trees of the cross-stack views.

interface LaneInfo {
  lane: Int32Array;
  rank: Float64Array;
  band: string[];
}

function lanesOf(tree: Tree, input: LayoutInput): LaneInfo {
  const n = tree.nodes.length;
  const byId = new Map(input.nodes.map((x) => [x.id, x]));
  const lane = new Int32Array(n);
  const rank = new Float64Array(n);
  const band: string[] = [];
  tree.nodes.forEach((t, i) => {
    const x = byId.get(t.id);
    lane[i] = x?.lane ?? 0;
    rank[i] = x?.rank ?? Number.MAX_SAFE_INTEGER;
    band[i] = x?.band ?? "";
  });
  return { lane, rank, band };
}

/** Members of each lane in rank order (ties: tree order, which is by id). */
function laneMembers(l: LaneInfo, members: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const i of members) {
    const k = l.lane[i] as number;
    let list = out.get(k);
    if (!list) {
      list = [];
      out.set(k, list);
    }
    list.push(i);
  }
  for (const list of out.values())
    list.sort((a, b) => (l.rank[a] as number) - (l.rank[b] as number) || a - b);
  return out;
}

/** Columns: one per lane, nodes in rank order, each column centred on y = 0. */
function layoutLaneColumns(tree: Tree, l: LaneInfo, colW: number): Positions {
  const positions: Positions = {};
  const all = tree.nodes.map((_, i) => i);
  for (const [k, members] of laneMembers(l, all)) {
    members.forEach((i, j) => {
      positions[(tree.nodes[i] as TreeNode).id] = [k * colW, (j - (members.length - 1) / 2) * LANE_ROW];
    });
  }
  return positions;
}

/**
 * A tree over lanes. The root side is the outer lane with fewer nodes (the table of the table usage view, on the
 * right); every other node hangs off its neighbour one lane nearer the root with the smallest rank. Leaves get
 * rows in depth-first order and a parent sits at the middle of its children, so a subtree stays together.
 */
function layoutLaneTree(tree: Tree, edges: IdxEdge[], l: LaneInfo): Positions {
  const n = tree.nodes.length;
  const positions: Positions = {};
  if (n === 0) return positions;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, l.lane[i] as number);
    hi = Math.max(hi, l.lane[i] as number);
  }
  const count = (k: number) => l.lane.filter((v) => v === k).length;
  const step = count(hi) <= count(lo) ? 1 : -1; // +1: the root is on the right
  const adj = undirectedAdj(tree, edges);
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -1;
    for (const j of adj[i] as number[]) {
      if ((l.lane[j] as number) !== (l.lane[i] as number) + step) continue;
      if (
        best === -1 ||
        (l.rank[j] as number) < (l.rank[best] as number) ||
        ((l.rank[j] as number) === (l.rank[best] as number) && j < best)
      )
        best = j;
    }
    parent[i] = best;
  }
  const kids: number[][] = tree.nodes.map(() => []);
  const roots: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parent[i] as number;
    if (p === -1) roots.push(i);
    else (kids[p] as number[]).push(i);
  }
  const byRank = (a: number, b: number) => (l.rank[a] as number) - (l.rank[b] as number) || a - b;
  roots.sort(byRank);
  for (const k of kids) k.sort(byRank);
  const y = new Float64Array(n);
  let row = 0;
  const place = (i: number): number => {
    const ks = kids[i] as number[];
    if (ks.length === 0) {
      y[i] = row++ * LANE_ROW;
      return y[i] as number;
    }
    let sum = 0;
    for (const k of ks) sum += place(k);
    y[i] = sum / ks.length;
    return y[i] as number;
  };
  for (const r of roots) {
    place(r);
    row += 0.5;
  }
  const mid = (row * LANE_ROW) / 2;
  for (let i = 0; i < n; i++)
    positions[(tree.nodes[i] as TreeNode).id] = [
      (l.lane[i] as number) * (FLOW_BOX_W + LANE_GAP_TREE),
      (y[i] as number) - mid,
    ];
  return positions;
}

/** ELK layered with one partition per lane (swimlanes left to right); bands, when set, are laid out apart and stacked. */
/** Above this many boxes the swimlane layout uses `layoutLaneSweep` instead of ELK. */
export const LANE_ELK_MAX = 250;

/**
 * The large-graph form of the swimlane layout: per band, lane 0 in rank order, then each lane ordered by the mean row
 * of its neighbours in the lanes to its left (ties by rank), one row per box; bands stacked. Linear in the edges.
 */
function layoutLaneSweep(tree: Tree, edges: IdxEdge[], l: LaneInfo, input: LayoutInput): Positions {
  const bandOrder = input.nodes.map((x) => x.band ?? "").filter((b, i, a) => a.indexOf(b) === i);
  const adj = undirectedAdj(tree, edges);
  const row = new Float64Array(tree.nodes.length).fill(Number.NaN);
  const positions: Positions = {};
  let top = 0;
  for (const band of bandOrder) {
    const members = tree.nodes.map((_, i) => i).filter((i) => l.band[i] === band);
    const lanes = [...laneMembers(l, members).entries()].sort((a, b) => a[0] - b[0]);
    let rows = 0;
    for (const [k, list] of lanes) {
      const key = (i: number): number => {
        let s = 0;
        let c = 0;
        for (const j of adj[i] as number[]) {
          if ((l.lane[j] as number) < k && l.band[j] === band && !Number.isNaN(row[j] as number)) {
            s += row[j] as number;
            c++;
          }
        }
        return c > 0 ? s / c : Number.POSITIVE_INFINITY;
      };
      const keys = new Map(list.map((i) => [i, key(i)]));
      const ordered = [...list].sort(
        (a, b) =>
          (keys.get(a) as number) - (keys.get(b) as number) ||
          (l.rank[a] as number) - (l.rank[b] as number) ||
          a - b,
      );
      ordered.forEach((i, j) => {
        row[i] = j;
        positions[(tree.nodes[i] as TreeNode).id] = [k * (FLOW_BOX_W + LANE_GAP_COLUMNS), top + j * LANE_ROW];
      });
      rows = Math.max(rows, ordered.length);
    }
    top += rows * LANE_ROW + BAND_GAP;
  }
  return positions;
}

async function layoutLaneElk(
  tree: Tree,
  edges: IdxEdge[],
  l: LaneInfo,
  input: LayoutInput,
): Promise<Positions> {
  // ELK with partitions takes tens of seconds on a thousand boxes; past a few hundred a barycentre sweep is used.
  if (tree.nodes.length > LANE_ELK_MAX) return layoutLaneSweep(tree, edges, l, input);
  const bands = [...new Set(l.band)];
  const bandOrder = input.nodes.map((x) => x.band ?? "").filter((b, i, a) => a.indexOf(b) === i);
  bands.sort((a, b) => bandOrder.indexOf(a) - bandOrder.indexOf(b));
  const positions: Positions = {};
  let top = 0;
  for (const band of bands) {
    const members = tree.nodes.map((_, i) => i).filter((i) => l.band[i] === band);
    const inBand = new Set(members);
    const seen = new Set<string>();
    const elkEdges: NonNullable<ElkNode["edges"]> = [];
    for (const e of edges) {
      if (!inBand.has(e.src) || !inBand.has(e.dst)) continue;
      const key = `${e.src}>${e.dst}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elkEdges.push({ id: `e${elkEdges.length}`, sources: [elkIdOf(e.src)], targets: [elkIdOf(e.dst)] });
    }
    const ordered = [...laneMembers(l, members).entries()].sort((a, b) => a[0] - b[0]).flatMap(([, m]) => m);
    const out = await new ELK().layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.partitioning.activate": "true",
        "elk.spacing.nodeNode": "12",
        "elk.layered.spacing.nodeNodeBetweenLayers": "90",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      },
      children: ordered.map((i) => ({
        id: elkIdOf(i),
        width: FLOW_BOX_W,
        height: FLOW_BOX_H,
        layoutOptions: { "elk.partitioning.partition": String(l.lane[i]) },
      })),
      edges: elkEdges,
    });
    let maxY = 0;
    for (const c of out.children ?? []) {
      const i = Number(c.id.slice(1));
      const cy = top + (c.y ?? 0) + (c.height ?? 0) / 2;
      positions[(tree.nodes[i] as TreeNode).id] = [(c.x ?? 0) + (c.width ?? 0) / 2, cy];
      maxY = Math.max(maxY, (c.y ?? 0) + (c.height ?? 0));
    }
    top += maxY + BAND_GAP;
  }
  if (bands.length > 1) alignLanes(tree, l, positions);
  return positions;
}

/**
 * Bands are laid out apart, so one lane can start at a different x in each. Every lane is moved to one x for all
 * bands: the furthest right any band put it, and right of the previous lane's widest extent.
 */
function alignLanes(tree: Tree, l: LaneInfo, positions: Positions): void {
  const key = (i: number) => `${l.band[i]}|${l.lane[i]}`;
  const startOf = new Map<string, number>();
  const endOf = new Map<string, number>();
  tree.nodes.forEach((t, i) => {
    const p = positions[t.id];
    if (!p) return;
    const k = key(i);
    startOf.set(k, Math.min(startOf.get(k) ?? Number.POSITIVE_INFINITY, p[0]));
    endOf.set(k, Math.max(endOf.get(k) ?? Number.NEGATIVE_INFINITY, p[0]));
  });
  const laneStart = new Map<number, number>();
  const laneWidth = new Map<number, number>();
  tree.nodes.forEach((_, i) => {
    const k = key(i);
    const x0 = startOf.get(k);
    if (x0 === undefined) return;
    const lane = l.lane[i] as number;
    laneStart.set(lane, Math.max(laneStart.get(lane) ?? Number.NEGATIVE_INFINITY, x0));
    laneWidth.set(lane, Math.max(laneWidth.get(lane) ?? 0, (endOf.get(k) ?? x0) - x0));
  });
  let minNext = Number.NEGATIVE_INFINITY;
  for (const lane of [...laneStart.keys()].sort((a, b) => a - b)) {
    const x = Math.max(laneStart.get(lane) as number, minNext);
    laneStart.set(lane, x);
    minNext = x + (laneWidth.get(lane) ?? 0) + FLOW_BOX_W + 90;
  }
  tree.nodes.forEach((t, i) => {
    const p = positions[t.id];
    const x0 = startOf.get(key(i));
    if (!p || x0 === undefined) return;
    p[0] += (laneStart.get(l.lane[i] as number) as number) - x0;
  });
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

// The ego view's left-to-right "bow-tie": the focus in the middle, callers in columns to its left (nearest
// hop next to the focus), callees in columns to its right. Pure and deterministic (no randomness, ties by id).
// Units are world pixels at zoom 1.
import type { GraphEdge, GraphNode } from "../api.ts";

export const FOCUS_W = 340;
export const FOCUS_H = 104;
export const GROUP_W = 500;
export const GROUP_H = 26;
export const HEAD_H = 28;
export const ROW_W = 380;
export const ROW_H = 26;
export const ROW_GAP = 2;
export const UNIT_GAP = 3;
export const BLOCK_GAP = 16;
/** Space between columns: room for the edges of a busy column, less for a small graph. */
export const COL_GAP = 360;
export const COL_GAP_SMALL = 200;
/** Space above the tallest column for the column titles. */
export const TITLE_H = 44;

export type ItemType = "focus" | "group" | "head" | "row" | "more";

export interface Placed {
  node: GraphNode;
  type: ItemType;
  /** Top-left corner and size in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  side: "in" | "out" | "focus";
  hop: number;
  /** Index of the column in left-to-right order. */
  col: number;
  /** Id of the expanded group this row sits under, if any. */
  block?: string;
}

export interface Column {
  side: "in" | "out" | "focus";
  hop: number;
  x: number;
  w: number;
  top: number;
  bottom: number;
  count: number;
}

export interface BowtieLayout {
  items: Placed[];
  byId: Map<string, Placed>;
  columns: Column[];
  /** World bounding box of everything, column titles included. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function typeOf(n: GraphNode): ItemType {
  if (n.side === "focus") return "focus";
  if (n.kind === "group") return n.expanded ? "head" : "group";
  if (n.kind === "more") return "more";
  return "row";
}

const sizeOf = (t: ItemType): [number, number] =>
  t === "focus"
    ? [FOCUS_W, FOCUS_H]
    : t === "group"
      ? [GROUP_W, GROUP_H]
      : t === "head"
        ? [GROUP_W, HEAD_H]
        : [ROW_W, ROW_H];

/** A run of nodes that move together: one individual node, one collapsed group, or an expanded group with its members. */
interface Block {
  nodes: GraphNode[];
  /** Default order key. */
  rank: string;
  grouped: boolean;
  size: number;
  ws: string;
}

function blocksOf(nodes: GraphNode[]): Block[] {
  const byGroup = new Map<string, GraphNode[]>();
  const blocks: Block[] = [];
  const heads = new Map<string, GraphNode>();
  for (const n of nodes) if (n.kind === "group" && n.expanded) heads.set(n.id, n);
  for (const n of nodes) {
    if (n.group && heads.has(n.group)) {
      const list = byGroup.get(n.group) ?? [];
      list.push(n);
      byGroup.set(n.group, list);
    }
  }
  for (const n of nodes) {
    if (n.group && heads.has(n.group)) continue; // placed under its header
    if (n.kind === "group" && n.expanded) {
      const members = (byGroup.get(n.id) ?? []).sort((a, b) => {
        const am = a.kind === "more" ? 1 : 0;
        const bm = b.kind === "more" ? 1 : 0;
        return am - bm || cmp(a.path ?? "", b.path ?? "") || cmp(a.label, b.label) || cmp(a.id, b.id);
      });
      blocks.push({ nodes: [n, ...members], rank: n.id, grouped: true, size: n.size, ws: n.workspace ?? "" });
    } else if (n.kind === "group") {
      blocks.push({ nodes: [n], rank: n.id, grouped: true, size: n.size, ws: n.workspace ?? "" });
    } else {
      blocks.push({
        nodes: [n],
        rank: `${n.workspace ?? ""}\0${n.label}\0${n.id}`,
        grouped: false,
        size: 1,
        ws: n.workspace ?? "",
      });
    }
  }
  // Groups first, one workspace after another (the workspace with the most callers first, so each colour forms a
  // run), largest group first within a workspace; then individual nodes by workspace and name.
  const wsWeight = new Map<string, number>();
  for (const b of blocks) if (b.grouped) wsWeight.set(b.ws, (wsWeight.get(b.ws) ?? 0) + b.size);
  return blocks.sort((a, b) => {
    if (a.grouped !== b.grouped) return a.grouped ? -1 : 1;
    if (!a.grouped) return cmp(a.rank, b.rank);
    return (
      (wsWeight.get(b.ws) ?? 0) - (wsWeight.get(a.ws) ?? 0) ||
      cmp(a.ws, b.ws) ||
      b.size - a.size ||
      cmp(a.rank, b.rank)
    );
  });
}

export function layoutBowtie(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): BowtieLayout {
  const focus = nodes.find((n) => n.side === "focus");
  // Column keys in left-to-right order: callers far to near, the focus, callees near to far.
  const hopsIn = new Set<number>();
  const hopsOut = new Set<number>();
  for (const n of nodes) {
    if (n.side === "in") hopsIn.add(n.hop ?? 1);
    else if (n.side === "out") hopsOut.add(n.hop ?? 1);
  }
  // An empty side keeps its (empty) first column, so its title can say "0".
  const hopsInReal = hopsIn.size > 0;
  const hopsOutReal = hopsOut.size > 0;
  if (focus && hopsIn.size === 0) hopsIn.add(1);
  if (focus && hopsOut.size === 0) hopsOut.add(1);
  const order: { side: "in" | "out" | "focus"; hop: number }[] = [
    ...[...hopsIn].sort((a, b) => b - a).map((hop) => ({ side: "in" as const, hop })),
    ...(focus ? [{ side: "focus" as const, hop: 0 }] : []),
    ...[...hopsOut].sort((a, b) => a - b).map((hop) => ({ side: "out" as const, hop })),
  ];

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    (neighbours.get(e.src) ?? neighbours.set(e.src, []).get(e.src))?.push(e.dst);
    (neighbours.get(e.dst) ?? neighbours.set(e.dst, []).get(e.dst))?.push(e.src);
  }

  const items: Placed[] = [];
  const byId = new Map<string, Placed>();
  const columns: Column[] = [];
  const centreY = new Map<string, number>(); // y centre of already placed nodes, by id
  let x = 0;

  // Place the inner columns first so outer columns can order by their neighbours (barycentre).
  const placeOrder = order
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => (a.side === "focus" ? -1 : b.side === "focus" ? 1 : a.hop - b.hop || a.i - b.i));
  const colX: number[] = [];
  const tallest = Math.max(
    0,
    ...order.map((c) =>
      c.side === "focus" ? 0 : nodes.filter((n) => n.side === c.side && (n.hop ?? 1) === c.hop).length,
    ),
  );
  const gap = tallest <= 12 ? COL_GAP_SMALL : COL_GAP;
  const widths = order.map((c) => {
    const ns =
      c.side === "focus"
        ? focus
          ? [focus]
          : []
        : nodes.filter((n) => n.side === c.side && (n.hop ?? 1) === c.hop);
    return Math.max(...ns.map((n) => sizeOf(typeOf(n))[0]), ROW_W);
  });
  for (let i = 0; i < order.length; i++) {
    colX[i] = x;
    x += (widths[i] as number) + gap;
  }

  for (const c of placeOrder) {
    const colIdx = c.i;
    const ns =
      c.side === "focus"
        ? focus
          ? [focus]
          : []
        : nodes.filter((n) => n.side === c.side && (n.hop ?? 1) === c.hop);
    let blocks = blocksOf(ns);
    if (c.side !== "focus" && c.hop > 1) {
      const bary = (b: Block): number => {
        let sum = 0;
        let n = 0;
        for (const node of b.nodes)
          for (const nb of neighbours.get(node.id) ?? []) {
            const y = centreY.get(nb);
            if (y !== undefined) {
              sum += y;
              n++;
            }
          }
        return n === 0 ? Number.POSITIVE_INFINITY : sum / n;
      };
      const keyed = blocks.map((b, k) => ({ b, k, y: bary(b) }));
      keyed.sort((p, q) => (p.y === q.y ? p.k - q.k : p.y - q.y));
      blocks = keyed.map((p) => p.b);
    }
    // Vertical gaps: tight between individual rows, wider around groups and expanded blocks.
    const gapBefore = (k: number): number => {
      if (k === 0) return 0;
      const prev = blocks[k - 1] as Block;
      const cur = blocks[k] as Block;
      if (prev.nodes.length > 1 || cur.nodes.length > 1) return BLOCK_GAP;
      return prev.grouped || cur.grouped ? UNIT_GAP : ROW_GAP;
    };
    const blockHeight = (b: Block): number =>
      b.nodes.reduce((h, n, m) => h + sizeOf(typeOf(n))[1] + (m > 0 ? ROW_GAP : 0), 0);
    const total = blocks.reduce((s, b, k) => s + blockHeight(b) + gapBefore(k), 0);
    let y = -total / 2;
    const colW = widths[colIdx] as number;
    blocks.forEach((b, k) => {
      y += gapBefore(k);
      const headId = b.nodes[0]?.kind === "group" && b.nodes[0].expanded ? b.nodes[0].id : undefined;
      b.nodes.forEach((n, m) => {
        const type = typeOf(n);
        const [w, h] = sizeOf(type);
        if (m > 0) y += ROW_GAP;
        // Callers are right-aligned and callees left-aligned, so edges meet the focus from a common edge.
        const px =
          c.side === "in"
            ? (colX[colIdx] as number) + colW - w
            : c.side === "out"
              ? (colX[colIdx] as number)
              : (colX[colIdx] as number) + (colW - w) / 2;
        const p: Placed = {
          node: n,
          type,
          x: px,
          y,
          w,
          h,
          side: c.side,
          hop: c.hop,
          col: colIdx,
          ...(headId && type !== "head" ? { block: headId } : {}),
        };
        items.push(p);
        byId.set(n.id, p);
        centreY.set(n.id, y + h / 2);
        y += h;
      });
    });
    columns[colIdx] = {
      side: c.side,
      hop: c.hop,
      x: colX[colIdx] as number,
      w: colW,
      top: -total / 2,
      bottom: total / 2,
      count: ns.length,
    };
  }

  // Centre the whole picture so the focus sits at x = 0.
  const focusItem = focus ? byId.get(focus.id) : undefined;
  const shift = focusItem ? focusItem.x + focusItem.w / 2 : 0;
  for (const p of items) p.x -= shift;
  for (const c of columns) c.x -= shift;

  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of items) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h);
  }
  if (items.length === 0) {
    x0 = y0 = -100;
    x1 = y1 = 100;
  }
  if (focusItem && hopsInReal && hopsOutReal) {
    // Symmetric around the focus when both sides have nodes: the bow-tie stays centred even when one side is shorter.
    const half = Math.max(-x0, x1);
    x0 = -half;
    x1 = half;
  }
  if (focusItem) {
    // The focus card is drawn a little larger than its box when zoomed out.
    x0 = Math.min(x0, focusItem.x - 70);
    x1 = Math.max(x1, focusItem.x + focusItem.w + 70);
  }
  return { items, byId, columns, bounds: { x0, y0: y0 - TITLE_H, x1, y1 } };
}

/** Rank of each workspace id among the workspaces present, sorted by id: drives the colours (see workspacePalette.ts). */
export function workspaceRanks(nodes: readonly GraphNode[]): Map<string, number> {
  const ids = [...new Set(nodes.map((n) => n.workspace).filter((w): w is string => Boolean(w)))].sort(cmp);
  return new Map(ids.map((id, i) => [id, i]));
}

/** How many callers or callees a node stands for (a collapsed group counts its members, an expanded one nothing (its members are nodes), a "+K more" node its K). */
export function weightOf(n: GraphNode): number {
  if (n.kind === "group") return n.expanded ? 0 : (n.stats?.members ?? n.size);
  if (n.kind === "more") return n.size;
  return 1;
}

// The ego view's left-to-right "bow-tie": the focus in the middle, callers in columns to its left (nearest
// hop next to the focus), callees in columns to its right. Pure and deterministic (no randomness, ties by id).
//
// Units are screen pixels at zoom 1, and the layout is sized for the canvas it is shown in (`view`): the fit
// camera then lands at about zoom 1 and every row stays at least 26px tall. A side with more rows than fit the
// height is spread over up to 3 columns (column-major, hop distance still left to right) before the rows are
// squeezed; they are never thinner than 18px (the server's row budget keeps it from coming to that).
import type { GraphEdge, GraphNode } from "../api.ts";

export const FOCUS_W = 190;
export const FOCUS_H = 110;
/** Row height and gap at the preferred pitch (30px per row). */
export const ROW_H = 26;
export const ROW_GAP = 4;
export const ROW_MIN_H = 18;
export const MAX_SUBCOLS = 3;
/** Space between the focus card and the nearest column, between hops, and between columns of one hop. */
export const FOCUS_GAP = 72;
export const COL_GAP = 120;
export const SUBCOL_GAP = 20;
/** Outline padding around an expanded group, per nesting level. */
export const BLOCK_PAD = 6;
/** Inset of rows inside an expanded group, per nesting level. */
export const INSET = 10;
/** Screen space kept free above (column titles) and below the picture, and at the sides. */
export const TOP_MARGIN = 72;
export const BOTTOM_MARGIN = 24;
export const SIDE_MARGIN = 28;
export const COL_MIN_W = 290;
export const COL_MAX_W = 600;

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
  /** Nesting depth inside expanded groups (0 for a top-level row). */
  depth: number;
  /** Ids of the expanded groups this row sits under, outermost first. */
  blocks: string[];
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

/** The outline of an expanded group in one column. */
export interface Outline {
  id: string;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface BowtieLayout {
  items: Placed[];
  byId: Map<string, Placed>;
  columns: Column[];
  outlines: Outline[];
  /** World bounding box of everything. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Row height used (at least 18). */
  rowH: number;
  /** Column count used per side and hop, for tests and the canvas. */
  subcols: { side: "in" | "out"; hop: number; n: number }[];
}

export interface LayoutView {
  w: number;
  h: number;
}

export const DEFAULT_VIEW: LayoutView = { w: 1100, h: 800 };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function typeOf(n: GraphNode): ItemType {
  if (n.side === "focus") return "focus";
  if (n.kind === "group") return n.expanded ? "head" : "group";
  if (n.kind === "more") return "more";
  return "row";
}

/** Rough width of a label in the canvas font, plus what the row spends on caret, count chip and padding. */
export function estimateWidth(n: GraphNode): number {
  const t = typeOf(n);
  const chars = n.label.length;
  if (t === "group" || t === "head") return Math.ceil(chars * 6.5 + 86);
  if (t === "more") return Math.ceil(chars * 6.4 + 30);
  return Math.ceil(chars * 6.6 + 34);
}

const isRest = (n: GraphNode): boolean => n.id.includes(":rest:") || n.id.includes(":more:");

interface Line {
  node: GraphNode;
  depth: number;
  blocks: string[];
  /** Outlines opened right before this line / closed right after it. */
  open: number;
  close: number;
}

/** Orders one level of rows: groups first (the workspace with the most callers first, largest first, "other" rows last), then individuals. */
function orderLevel(list: GraphNode[], top: boolean): GraphNode[] {
  const wsWeight = new Map<string, number>();
  if (top)
    for (const n of list)
      if (n.kind === "group")
        wsWeight.set(n.workspace ?? "", (wsWeight.get(n.workspace ?? "") ?? 0) + n.size);
  return [...list].sort((a, b) => {
    const ga = a.kind === "group" ? 0 : 1;
    const gb = b.kind === "group" ? 0 : 1;
    if (ga !== gb) return ga - gb;
    if (ga === 1)
      return (
        cmp(a.workspace ?? "", b.workspace ?? "") ||
        cmp(a.path ?? "", b.path ?? "") ||
        cmp(a.label, b.label) ||
        cmp(a.id, b.id)
      );
    const ra = isRest(a) ? 1 : 0;
    const rb = isRest(b) ? 1 : 0;
    if (top) {
      const wa = wsWeight.get(a.workspace ?? "") ?? 0;
      const wb = wsWeight.get(b.workspace ?? "") ?? 0;
      return (
        wb - wa || cmp(a.workspace ?? "", b.workspace ?? "") || ra - rb || b.size - a.size || cmp(a.id, b.id)
      );
    }
    return ra - rb || b.size - a.size || cmp(a.id, b.id);
  });
}

/** The rows of one (side, hop) in reading order, expanded groups followed by their rows. */
function flatten(nodes: GraphNode[], reorder?: (top: GraphNode[]) => GraphNode[]): Line[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string, GraphNode[]>();
  const top: GraphNode[] = [];
  for (const n of nodes) {
    if (n.group && ids.has(n.group)) (kids.get(n.group) ?? kids.set(n.group, []).get(n.group))?.push(n);
    else top.push(n);
  }
  const out: Line[] = [];
  const walk = (list: GraphNode[], depth: number, blocks: string[], isTop: boolean): void => {
    const ordered = isTop && reorder ? reorder(orderLevel(list, true)) : orderLevel(list, isTop);
    for (const n of ordered) {
      const sub = n.expanded ? (kids.get(n.id) ?? []) : [];
      const line: Line = { node: n, depth, blocks, open: n.expanded ? 1 : 0, close: 0 };
      out.push(line);
      if (n.expanded) {
        walk(sub, depth + 1, [...blocks, n.id], false);
        // The outline closes after the last line under this group (which may itself close deeper ones).
        (out[out.length - 1] as Line).close += 1;
      }
    }
  };
  walk(top, 0, [], true);
  return out;
}

interface Slice {
  lines: Line[];
  height: number;
}

/** Height of a run of lines at a pitch: each line, plus padding where outlines open and close. */
function heightOf(lines: Line[], pitch: number): number {
  let h = 0;
  for (const l of lines) h += pitch + (l.open + l.close) * BLOCK_PAD;
  return h;
}

/** Fills `cols` columns in reading order, as evenly as the line boundaries allow. Null when a column would be taller than `limit`. */
function fill(lines: Line[], pitch: number, cols: number, limit: number): Slice[] | null {
  const total = heightOf(lines, pitch);
  const target = total / cols + pitch / 2;
  const out: Slice[] = [];
  let cur: Line[] = [];
  let curH = 0;
  for (const l of lines) {
    const h = pitch + (l.open + l.close) * BLOCK_PAD;
    if (cur.length > 0 && curH + h > target && out.length < cols - 1) {
      out.push({ lines: cur, height: curH });
      cur = [];
      curH = 0;
    }
    cur.push(l);
    curH += h;
  }
  out.push({ lines: cur, height: curH });
  return out.every((s) => s.height <= limit + 0.5) ? out : null;
}

interface Plan {
  slices: Slice[];
  pitch: number;
}

/** Fewest columns (up to 3) at the preferred pitch; failing that, the roomiest pitch down to the 18px minimum row. */
function planBucket(lines: Line[], limit: number): Plan {
  const pitch0 = ROW_H + ROW_GAP;
  for (let cols = 1; cols <= MAX_SUBCOLS; cols++) {
    const s = fill(lines, pitch0, cols, limit);
    if (s) return { slices: s, pitch: pitch0 };
  }
  for (let pitch = pitch0 - 1; pitch >= ROW_MIN_H + 4; pitch--) {
    const s = fill(lines, pitch, MAX_SUBCOLS, limit);
    if (s) return { slices: s, pitch };
  }
  const pitch = ROW_MIN_H + 4;
  return { slices: fill(lines, pitch, MAX_SUBCOLS, Number.POSITIVE_INFINITY) as Slice[], pitch };
}

export function layoutBowtie(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  view: LayoutView = DEFAULT_VIEW,
): BowtieLayout {
  const focus = nodes.find((n) => n.side === "focus");
  const hopsOf = (side: "in" | "out"): number[] => {
    const s = new Set<number>();
    for (const n of nodes) if (n.side === side) s.add(n.hop ?? 1);
    if (focus && s.size === 0) s.add(1); // an empty side keeps its (empty) first column, so its title can say "0"
    return [...s].sort((a, b) => a - b);
  };
  const hopsIn = hopsOf("in");
  const hopsOut = hopsOf("out");

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    (neighbours.get(e.src) ?? neighbours.set(e.src, []).get(e.src))?.push(e.dst);
    (neighbours.get(e.dst) ?? neighbours.set(e.dst, []).get(e.dst))?.push(e.src);
  }

  const limit = Math.max(120, view.h - TOP_MARGIN - BOTTOM_MARGIN);
  const availW = Math.max(400, view.w - 2 * SIDE_MARGIN);

  // Lines of every bucket; hop 1 first so farther hops can order by where their neighbours sit.
  const buckets: { side: "in" | "out"; hop: number; lines: Line[]; slices: Slice[] }[] = [];
  for (const side of ["in", "out"] as const)
    for (const hop of side === "in" ? hopsIn : hopsOut) {
      const ns = nodes.filter((n) => n.side === side && (n.hop ?? 1) === hop);
      buckets.push({ side, hop, lines: flatten(ns), slices: [] });
    }

  // How many columns each bucket gets, and the row pitch. Hop 1 of each side tries 1 to 3 columns and every pitch
  // down to 22px; the choice is the one whose rows end up tallest on screen once the whole picture is fitted
  // (a column that does not fit the width costs zoom just as one that does not fit the height does).
  const colNeed = (slice: Slice): number =>
    Math.min(
      COL_MAX_W,
      Math.max(140, ...slice.lines.map((l) => estimateWidth(l.node) + l.depth * 2 * INSET + 2 * BLOCK_PAD)),
    );
  const baseCols = buckets.map((b) => planBucket(b.lines, limit).slices.length);
  const hop1 = buckets.map((b, i) => (b.hop === 1 ? i : -1)).filter((i) => i >= 0);
  const evaluate = (counts: number[], pitch: number): number => {
    let tallest = 0;
    let need = FOCUS_W;
    let floors = FOCUS_W;
    for (const side of ["in", "out"] as const) {
      let hopsSeen = 0;
      buckets.forEach((b, i) => {
        if (b.side !== side) return;
        const slices = fill(b.lines, pitch, counts[i] as number, Number.POSITIVE_INFINITY) as Slice[];
        for (const sl of slices) tallest = Math.max(tallest, sl.height);
        const widths = slices.map(colNeed);
        need +=
          widths.reduce((x, w) => x + w, 0) + (slices.length - 1) * SUBCOL_GAP + (hopsSeen > 0 ? COL_GAP : 0);
        floors +=
          widths.reduce((x, w) => x + Math.min(w, COL_MIN_W), 0) +
          (slices.length - 1) * SUBCOL_GAP +
          (hopsSeen > 0 ? COL_GAP : 0);
        hopsSeen++;
      });
      if (hopsSeen > 0) {
        need += FOCUS_GAP;
        floors += FOCUS_GAP;
      }
    }
    const width = need <= availW ? need : Math.max(availW, floors);
    const k = Math.min(1, availW / width, limit / Math.max(1, tallest));
    return (pitch - ROW_GAP) * k;
  };
  let best = { score: -1, pitch: ROW_H + ROW_GAP, counts: baseCols };
  const combos: number[][] = [];
  const walk = (i: number, cur: number[]): void => {
    if (i === hop1.length) {
      combos.push(cur);
      return;
    }
    for (let c = 1; c <= MAX_SUBCOLS; c++) {
      const next = [...cur];
      next[hop1[i] as number] = c;
      walk(i + 1, next);
    }
  };
  walk(0, baseCols);
  for (const pitch of [30, 28, 26, 24, 22]) {
    for (const counts of combos) {
      const score = evaluate(counts, pitch);
      const cols = counts.reduce((x, c) => x + c, 0);
      const bestCols = best.counts.reduce((x, c) => x + c, 0);
      if (score > best.score + 0.01 || (Math.abs(score - best.score) <= 0.01 && cols < bestCols)) {
        best = { score, pitch, counts };
      }
    }
  }
  const pitch = best.pitch;
  const rowH = pitch - ROW_GAP;
  buckets.forEach((b, i) => {
    b.slices = fill(b.lines, pitch, best.counts[i] as number, Number.POSITIVE_INFINITY) as Slice[];
  });

  // Column widths, then x positions outward from the focus.
  const focusH = (() => {
    const ports = Math.max(
      nodes.filter((n) => n.side === "in" && (n.hop ?? 1) === 1 && !n.expanded).length,
      nodes.filter((n) => n.side === "out" && (n.hop ?? 1) === 1 && !n.expanded).length,
    );
    return Math.max(FOCUS_H, Math.min(220, 40 + ports * 6));
  })();
  interface Col {
    side: "in" | "out";
    hop: number;
    sub: number;
    slice: Slice;
    w: number;
    /** The narrowest the column may be squeezed to. */
    floor: number;
    x: number;
  }
  const cols: Col[] = [];
  for (const b of buckets) {
    b.slices.forEach((slice, sub) => {
      const w = colNeed(slice);
      cols.push({ side: b.side, hop: b.hop, sub, slice, w, floor: Math.min(w, COL_MIN_W), x: 0 });
    });
  }
  const order = (side: "in" | "out"): Col[] =>
    cols.filter((c) => c.side === side).sort((a, b) => a.hop - b.hop || a.sub - b.sub);
  const gapAfter = (list: Col[], i: number): number => {
    const c = list[i] as Col;
    const nx = list[i + 1];
    return !nx ? 0 : nx.hop === c.hop ? SUBCOL_GAP : COL_GAP;
  };
  const sideWidth = (list: Col[]): number =>
    list.reduce((s, c, i) => s + c.w + gapAfter(list, i), 0) + (list.length ? FOCUS_GAP : 0);
  const left = order("in");
  const right = order("out");
  // Too wide for the canvas: the widest columns give way first (labels are then shortened as a last resort).
  let over = FOCUS_W + sideWidth(left) + sideWidth(right) - availW;
  for (let guard = 0; over > 0.5 && guard < 200; guard++) {
    const shrinkable = [...left, ...right].filter((c) => c.w > c.floor);
    if (shrinkable.length === 0) break;
    const widest = Math.max(...shrinkable.map((c) => c.w));
    const take = Math.min(over, 8);
    for (const c of shrinkable.filter((c) => c.w >= widest - 0.5)) c.w = Math.max(c.floor, c.w - take);
    over = FOCUS_W + sideWidth(left) + sideWidth(right) - availW;
  }
  let x = -FOCUS_W / 2 - FOCUS_GAP;
  left.forEach((c, i) => {
    c.x = x - c.w;
    x = c.x - gapAfter(left, i);
  });
  x = FOCUS_W / 2 + FOCUS_GAP;
  right.forEach((c, i) => {
    c.x = x;
    x = c.x + c.w + gapAfter(right, i);
  });

  const items: Placed[] = [];
  const byId = new Map<string, Placed>();
  const columns: Column[] = [];
  const outlines: Outline[] = [];
  const centreY = new Map<string, number>();

  if (focus) {
    const p: Placed = {
      node: focus,
      type: "focus",
      x: -FOCUS_W / 2,
      y: -focusH / 2,
      w: FOCUS_W,
      h: focusH,
      side: "focus",
      hop: 0,
      col: left.length,
      depth: 0,
      blocks: [],
    };
    items.push(p);
    byId.set(focus.id, p);
    centreY.set(focus.id, 0);
  }

  // Place hop 1 first, then farther hops ordered by their neighbours' heights.
  const placeOrder = [...cols].sort(
    (a, b) => a.hop - b.hop || (a.side === b.side ? a.sub - b.sub : a.side === "in" ? -1 : 1),
  );
  const colIndex = (c: Col): number =>
    c.side === "in" ? left.length - 1 - left.indexOf(c) : left.length + 1 + right.indexOf(c);
  const byHop = new Map<string, Col[]>();
  for (const c of placeOrder)
    (byHop.get(`${c.side}${c.hop}`) ?? byHop.set(`${c.side}${c.hop}`, []).get(`${c.side}${c.hop}`))?.push(c);
  for (const [, group] of byHop) {
    const first = group[0] as Col;
    if (first.hop > 1) {
      // Re-order the whole bucket by the barycentre of already placed neighbours, then re-slice.
      const bary = (l: Line): number => {
        let sum = 0;
        let n = 0;
        for (const nb of neighbours.get(l.node.id) ?? []) {
          const y = centreY.get(nb);
          if (y !== undefined) {
            sum += y;
            n++;
          }
        }
        return n === 0 ? Number.POSITIVE_INFINITY : sum / n;
      };
      const lines = flatten(
        nodes.filter((n) => n.side === first.side && (n.hop ?? 1) === first.hop),
        (top) => {
          const keyed = top.map((n, k) => ({ n, k, y: bary({ node: n } as Line) }));
          keyed.sort((p, q) => (p.y === q.y ? p.k - q.k : p.y - q.y));
          return keyed.map((p) => p.n);
        },
      );
      const slices = fill(lines, pitch, group.length, Number.POSITIVE_INFINITY) as Slice[];
      group.forEach((c, i) => {
        c.slice = slices[i] ?? { lines: [], height: 0 };
      });
    }
    for (const c of group) {
      const colIdx = colIndex(c);
      let y = -c.slice.height / 2;
      const top = y;
      for (const l of c.slice.lines) {
        y += l.open * BLOCK_PAD;
        const n = l.node;
        const t = typeOf(n);
        const inset = l.depth * INSET;
        const w = c.w - 2 * inset;
        const p: Placed = {
          node: n,
          type: t,
          x: c.x + inset,
          y,
          w,
          h: rowH,
          side: c.side,
          hop: c.hop,
          col: colIdx,
          depth: l.depth,
          blocks: l.blocks,
        };
        items.push(p);
        byId.set(n.id, p);
        centreY.set(n.id, y + rowH / 2);
        y += pitch;
        y += l.close * BLOCK_PAD;
      }
      columns[colIdx] = {
        side: c.side,
        hop: c.hop,
        x: c.x,
        w: c.w,
        top,
        bottom: top + c.slice.height,
        count: c.slice.lines.length,
      };
    }
  }
  if (focus) {
    columns[left.length] = {
      side: "focus",
      hop: 0,
      x: -FOCUS_W / 2,
      w: FOCUS_W,
      top: -focusH / 2,
      bottom: focusH / 2,
      count: 1,
    };
  }
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i]) columns[i] = { side: "focus", hop: 0, x: 0, w: 0, top: 0, bottom: 0, count: 0 };
  }

  // Outlines of expanded groups: one per column the group's rows reach.
  const heads = items.filter((p) => p.type === "head");
  const depthBelow = new Map<string, number>();
  for (const p of items) {
    for (let i = 0; i < p.blocks.length; i++) {
      const id = p.blocks[i] as string;
      depthBelow.set(id, Math.max(depthBelow.get(id) ?? 0, p.blocks.length - i));
    }
  }
  for (const hd of heads) {
    const under = items.filter((p) => p.node.id === hd.node.id || p.blocks.includes(hd.node.id));
    const cols2 = new Set(under.map((p) => p.col));
    for (const col of cols2) {
      const mine = under.filter((p) => p.col === col);
      const pad = BLOCK_PAD * (depthBelow.get(hd.node.id) ?? 1);
      const c = columns[col] as Column;
      const x0 = c.x + hd.depth * INSET - pad + BLOCK_PAD;
      const y0 = Math.min(...mine.map((p) => p.y)) - BLOCK_PAD;
      const y1 = Math.max(...mine.map((p) => p.y + p.h)) + BLOCK_PAD;
      outlines.push({
        id: hd.node.id,
        col,
        x: x0,
        y: y0,
        w: c.w - 2 * hd.depth * INSET - 2 * BLOCK_PAD + 2 * pad,
        h: y1 - y0,
        depth: hd.depth,
      });
    }
  }
  outlines.sort((a, b) => a.depth - b.depth || cmp(a.id, b.id) || a.col - b.col);

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
  // An empty column still has its title ("CALLEES · 0"), so it counts.
  for (const c of columns) {
    if (c.side === "focus" || c.w === 0) continue;
    x0 = Math.min(x0, c.x);
    x1 = Math.max(x1, c.x + c.w);
  }
  for (const o of outlines) {
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + o.w);
    y1 = Math.max(y1, o.y + o.h);
  }
  if (items.length === 0) {
    x0 = y0 = -100;
    x1 = y1 = 100;
  }
  // Vertically symmetric around the focus too, so the card stays in the middle of the canvas.
  if (focus) {
    const half = Math.max(-y0, y1);
    y0 = -half;
    y1 = half;
  }
  return {
    items,
    byId,
    columns,
    outlines,
    bounds: { x0, y0, x1, y1 },
    rowH,
    subcols: buckets.map((b) => ({ side: b.side, hop: b.hop, n: b.slices.length })),
  };
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

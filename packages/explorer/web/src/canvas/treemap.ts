// Pure geometry for the nested treemap drawn inside every workspace box (project map, #36/#37).
// No DOM, no randomness: the same tree always gives the same rectangles.
import type { Rect } from "./types.ts";

export interface WeightedItem {
  id: string;
  weight: number;
}

export interface PlacedItem {
  id: string;
  rect: Rect;
}

const byWeightThenId = (a: WeightedItem, b: WeightedItem): number =>
  b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). Every item gets a rectangle whose area is
 * `weight / total * area(rect)`; the rectangles tile `rect` exactly. Items are placed largest first
 * (ties by id), so the output depends only on the input set, not its order. Items with a non-positive weight
 * get no rectangle.
 */
export function squarify(items: readonly WeightedItem[], rect: Rect, aspect = 1): PlacedItem[] {
  if (aspect !== 1) {
    // Squarify in a rectangle stretched vertically by `aspect`, then squash the result back: cells come out
    // `aspect` times wider than tall, which leaves room for a label in more of them.
    const stretched = { x: rect.x, y: rect.y * aspect, w: rect.w, h: rect.h * aspect };
    return squarify(items, stretched).map((p) => ({
      id: p.id,
      rect: { x: p.rect.x, y: p.rect.y / aspect, w: p.rect.w, h: p.rect.h / aspect },
    }));
  }
  const sorted = items.filter((i) => i.weight > 0).sort(byWeightThenId);
  const out: PlacedItem[] = [];
  if (sorted.length === 0) return out;
  const total = sorted.reduce((sum, i) => sum + i.weight, 0);
  const scale = (rect.w * rect.h) / total;
  const areas = sorted.map((i) => i.weight * scale);

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  let start = 0;
  const worst = (from: number, to: number, side: number, sum: number): number => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (let k = from; k < to; k++) {
      const a = areas[k] as number;
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    const s2 = side * side;
    return Math.max((s2 * hi) / (sum * sum), (sum * sum) / (s2 * lo));
  };
  while (start < sorted.length) {
    const side = Math.min(w, h);
    if (side <= 0) {
      for (let k = start; k < sorted.length; k++)
        out.push({ id: (sorted[k] as WeightedItem).id, rect: { x, y, w: 0, h: 0 } });
      break;
    }
    let end = start + 1;
    let sum = areas[start] as number;
    let score = worst(start, end, side, sum);
    while (end < sorted.length) {
      const nextSum = sum + (areas[end] as number);
      const next = worst(start, end + 1, side, nextSum);
      if (next > score) break;
      sum = nextSum;
      score = next;
      end++;
    }
    // The row of items [start, end) fills a strip along the shorter side.
    if (w >= h) {
      const stripW = sum / h;
      let cy = y;
      for (let k = start; k < end; k++) {
        const ih = (areas[k] as number) / stripW;
        out.push({ id: (sorted[k] as WeightedItem).id, rect: { x, y: cy, w: stripW, h: ih } });
        cy += ih;
      }
      x += stripW;
      w -= stripW;
    } else {
      const stripH = sum / w;
      let cx = x;
      for (let k = start; k < end; k++) {
        const iw = (areas[k] as number) / stripH;
        out.push({ id: (sorted[k] as WeightedItem).id, rect: { x: cx, y, w: iw, h: stripH } });
        cx += iw;
      }
      y += stripH;
      h -= stripH;
    }
    start = end;
  }
  return out;
}

/** A node of the treemap input tree. */
export interface TmNode {
  id: string;
  /** Own weight; used for leaves. Containers weigh the sum of their children. */
  weight: number;
  children: TmNode[];
  /** Header strip reserved at the top of a container, in layout units. */
  head: number;
  /** Keep the header even when the container is short (workspace boxes always show their title). */
  keepHead?: boolean;
  /** A single-child folder that is not drawn: it takes its parent's whole inner rectangle, with no padding. */
  transparent?: boolean;
}

export interface TmResult {
  rects: Map<string, Rect>;
  /** The header actually reserved (0 when the container is too small for one). */
  heads: Map<string, number>;
}

export const TM_PAD = 1.5;
/** Cells are laid out about this much wider than tall, so folder and file names fit in more of them. */
export const TM_ASPECT = 1.7;

/** Total weight of a node: the sum over its leaves. */
export function totalWeight(n: TmNode): number {
  if (n.children.length === 0) return n.weight;
  let sum = 0;
  for (const c of n.children) sum += totalWeight(c);
  return sum;
}

/**
 * Lays `root` out inside `rect`. Containers keep `head` units at the top for their title (dropped when the
 * container is shorter than `2.2 * head`) and `TM_PAD` around the children; children are squarified by weight.
 */
export function layoutTreemap(
  root: TmNode,
  rect: Rect,
  out: TmResult = { rects: new Map(), heads: new Map() },
) {
  const weights = new Map<TmNode, number>();
  const weigh = (n: TmNode): number => {
    const w = n.children.length === 0 ? n.weight : n.children.reduce((s, c) => s + weigh(c), 0);
    weights.set(n, w);
    return w;
  };
  weigh(root);
  const place = (n: TmNode, r: Rect): void => {
    out.rects.set(n.id, r);
    if (n.children.length === 0) {
      out.heads.set(n.id, 0);
      return;
    }
    const head = n.keepHead || (r.h >= n.head * 2.2 && r.w >= 16) ? n.head : 0;
    out.heads.set(n.id, head);
    const pad = n.transparent ? 0 : TM_PAD;
    const top = head > 0 ? head : pad;
    // A cell thinner than its padding has no room inside: its children get a zero-size rectangle on the cell.
    const inner: Rect = {
      x: Math.min(r.x + pad, r.x + r.w / 2),
      y: Math.min(r.y + top, r.y + r.h),
      w: Math.max(0, r.w - 2 * pad),
      h: Math.max(0, r.h - top - pad),
    };
    const byId = new Map(n.children.map((c) => [c.id, c]));
    for (const placed of squarify(
      n.children.map((c) => ({ id: c.id, weight: weights.get(c) as number })),
      inner,
      TM_ASPECT,
    )) {
      place(byId.get(placed.id) as TmNode, placed.rect);
    }
    // A child with no weight still needs a rectangle (zero-area), so lookups never miss.
    for (const c of n.children) if (!out.rects.has(c.id)) out.rects.set(c.id, { x: r.x, y: r.y, w: 0, h: 0 });
  };
  place(root, rect);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Label rules

/** Smallest label font on a treemap cell, in CSS pixels. */
export const MIN_CELL_FONT = 10;
/** Cells narrower than this get no ellipsized label at all. */
export const MIN_ELLIPSIS_CELL_W = 60;

/** `abcdef...uvwxyz` style: keeps both ends of a long name. Returns the text unchanged when it fits. */
export function ellipsizeMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  const keep = maxChars - 1;
  const tail = Math.ceil(keep * 0.45);
  const head = keep - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * The label to print in a cell, or null for none. `measure(text)` is the text width in pixels at the font the
 * label will be drawn in. A label that fits whole is returned whole; a longer one is middle-ellipsized only
 * when the cell is at least `MIN_ELLIPSIS_CELL_W` wide, otherwise nothing is drawn. Text never leaves the cell.
 */
export function fitCellLabel(
  measure: (text: string) => number,
  text: string,
  cellW: number,
  cellH: number,
  fontPx: number,
  padding = 3,
  allowEllipsis = true,
): string | null {
  if (fontPx < MIN_CELL_FONT) return null;
  if (cellH < fontPx + 2) return null;
  const room = cellW - 2 * padding;
  if (room <= 0) return null;
  if (measure(text) <= room) return text;
  if (!allowEllipsis || cellW < MIN_ELLIPSIS_CELL_W) return null;
  let lo = 1;
  let hi = text.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = ellipsizeMiddle(text, mid);
    if (measure(candidate) <= room) {
      best = candidate;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Wraps `text` into lines no wider than `maxW`, breaking after `-`, `_`, `/`, `.` or spaces and, as a last
 * resort, inside a word. Never truncates: a text that cannot be wrapped still returns all of its characters.
 */
export function wrapText(measure: (text: string) => number, text: string, maxW: number): string[] {
  if (measure(text) <= maxW) return [text];
  const parts = text.match(/[^-_/. ]+[-_/. ]*|[-_/. ]+/g) ?? [text];
  const lines: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if (measure(cur + piece) <= maxW || cur === "") cur += piece;
    else {
      lines.push(cur.trimEnd());
      cur = piece;
    }
  };
  for (const part of parts) {
    if (measure(part) <= maxW) push(part);
    else {
      // A single word wider than the line: break inside it.
      for (const ch of part) {
        if (measure(cur + ch) <= maxW || cur === "") cur += ch;
        else {
          lines.push(cur.trimEnd());
          cur = ch;
        }
      }
    }
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}

// ---------------------------------------------------------------------------------------------------------
// File name labels

/** `orderService.ts` -> `orderService`; names without a short extension are returned unchanged. */
export function stripExtension(name: string): string {
  const m = /^(.+?)\.[A-Za-z0-9]{1,5}$/.exec(name);
  return m?.[1] ?? name;
}

/** Indices at which `text` may break: after `.`, `-`, `_`, and before an upper-case letter that follows a lower-case one. */
export function breakPoints(text: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const prev = text.charAt(i - 1);
    const cur = text.charAt(i);
    if (/[._-]/.test(prev) && !/[._-]/.test(cur)) out.push(i);
    else if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)) out.push(i);
  }
  return out;
}

/** Two lines whose widths are both at most `maxW`, split at a break point as evenly as possible, or null. */
export function wrapTwoLines(measure: (text: string) => number, text: string, maxW: number): string[] | null {
  let best: string[] | null = null;
  let bestW = Number.POSITIVE_INFINITY;
  for (const at of breakPoints(text)) {
    const a = text.slice(0, at);
    const b = text.slice(at);
    const w = Math.max(measure(a), measure(b));
    if (w <= maxW && w < bestW) {
      best = [a, b];
      bestW = w;
    }
  }
  return best;
}

/** File names are middle-ellipsized only in cells at least this wide; narrower ones show the whole name or nothing. */
export const FILE_ELLIPSIS_CELL_W = 140;

export interface FileLabel {
  lines: string[];
  font: number;
}

/**
 * How to print a file name in a cell: 11px, then 10px. One line when the whole name fits, then one line without its
 * extension, then (when the cell is tall enough for two lines) two lines broken at `.`/`-`/`_`/camelCase
 * boundaries, and only then, in cells at least 140px wide, a middle-ellipsis; otherwise no label. A name that fits
 * at 10px is never ellipsized. `measureAt` gives the text width at a font size.
 */
export function fitFileLabel(
  measureAt: (text: string, font: number) => number,
  name: string,
  cellW: number,
  cellH: number,
  padding = 3,
): FileLabel | null {
  const room = cellW - 2 * padding;
  if (room <= 0) return null;
  const bare = stripExtension(name);
  const forms = bare === name ? [name] : [name, bare];
  for (const form of forms) {
    for (const font of [11, 10]) {
      if (cellH >= font + 2 && measureAt(form, font) <= room) return { lines: [form], font };
    }
  }
  for (const form of forms) {
    for (const font of [11, 10]) {
      if (cellH < 2 * font * 1.15 + 3) continue;
      const two = wrapTwoLines((t) => measureAt(t, font), form, room);
      if (two) return { lines: two, font };
    }
  }
  // The whole name does not fit on two lines: no label (zooming in shows it), unless the cell is wide enough
  // for a middle-ellipsis that still says something.
  if (cellW < FILE_ELLIPSIS_CELL_W) return null;
  const text = fitCellLabel((t) => measureAt(t, 10), bare, cellW, cellH, 10, padding);
  return text ? { lines: [text], font: 10 } : null;
}

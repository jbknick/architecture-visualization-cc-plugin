// Drawing and hit testing for the project map: workspace boxes, the treemap inside them, routed workspace links
// and the links of the selected cell. Everything is drawn on one 2D canvas; cells smaller than two pixels and
// cells outside the viewport are skipped, which keeps 30k-function maps smooth.

import { decollideMarkers } from "../rankedFiles/markers.ts";
import { GROUP_KIND, kindTier, type TreeNode } from "./hierarchy.ts";
import {
  actualInner,
  type Cam,
  FONT,
  fnCount,
  folderStrip,
  headPx,
  mapChild,
  normInner,
  rectAt,
  rootRect,
  screenRectOf,
  setStripMeasure,
  WS_HEAD_MAX,
} from "./mapGeom.ts";
import { edgeNoun, folderTitle, nodeTitle, type Scene, subtitleParts } from "./scene.ts";
import {
  type CanvasTheme,
  hexToRgba,
  inkAgainst,
  kindColor,
  labelInk,
  mix,
  workspaceColor,
} from "./style.ts";
import { fitCellLabel, fitFileLabel, fitLargestFileLabel, wrapText } from "./treemap.ts";
import type { MapGeometry, Rect } from "./types.ts";

export type Camera = Cam;

/** A link between two cells, drawn as a thin curve when one of them is selected. */
export interface CellLink {
  src: number;
  dst: number;
  weight: number;
}

export interface DrawEnv {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  scene: Scene;
  geo: MapGeometry;
  theme: CanvasTheme;
  cam: Camera;
  selected: number | null;
  hovered: number | null;
  /** Workspace whose links are shown in full (hovered, selected or picked in the left panel). */
  highlightWs: number | null;
  /** Workspace whose row the pointer is over in the left panel: its box is outlined and the others recede. */
  panelHover?: number | null;
  showDeclared: boolean;
  bright: Set<number> | null;
  links: CellLink[];
  hoverEdge: string | null;
  /** Folder strips that are partly scrolled out stick to this y (0, or lower to keep clear of the breadcrumb). */
  stickyTop?: number;
  /** Screen rectangles (the key) that count pills and titles keep clear of. */
  reserved?: Rect[];
  /** Rank markers (Files level): the largest files, numbered from 1; `index` is the file's tree index. */
  ranks?: { index: number; rank: number }[];
  /** Tree index of the file the pointer is over in the "Largest files" list: its tile and marker are highlighted. */
  rankHover?: number | null;
}

/** A rank marker as drawn: a numbered circle on (or beside) the tile of one of the largest files. */
export interface RankMarker {
  rank: number;
  index: number;
  id: string;
  x: number;
  y: number;
  r: number;
}

/** Marker radius in px (an 18px circle). */
export const MARKER_R = 9;

export interface EdgeHit {
  key: string;
  src: number;
  dst: number;
  weight: number;
  noun: string;
  /** The pair has a declared (package.json) dependency as well. */
  declared: boolean;
  declaredOnly: boolean;
  pts: [number, number][];
  /** The routed polyline itself (screen px, as drawn), for tests. */
  route: [number, number][];
  width: number;
  /** The line colour (the importing workspace's), for tests. */
  colour: string;
  /** Opacity the line was drawn with, and the arrowhead's length in px. */
  alpha: number;
  head: number;
}

export interface DrawResult {
  edgeHits: EdgeHit[];
  /** Screen rectangle of every workspace box that is on screen. */
  boxes: { index: number; x: number; y: number; w: number; h: number }[];
  /** Workspaces whose title was neither inside nor beside the box. */
  hiddenTitles: Set<number>;
  /** Where each workspace title went: inside its box, beside it, or nowhere (shown on hover only). */
  titles: Map<number, "inside" | "beside" | "hidden">;
  /** The text drawn as each workspace's title (name lines joined, or the text beside the box). */
  titleTexts: Map<number, string>;
  /** Count pills that were drawn: the link key, the number shown (import count) and the full text. */
  pills: { key: string; count: string; text: string; x: number; y: number; w: number; h: number }[];
  /** The text printed on every folder strip and file cell: `cellW` is the cell's width on screen. */
  labels: { id: string; kind: "folder" | "file"; cellW: number; lines: string[]; box?: Rect }[];
  /** The rank markers that were drawn (centre and radius in px), in rank order. */
  markers: RankMarker[];
}

export { FONT };
/** Cells smaller than this on screen (either side) are not drawn. */
export const MIN_CELL_PX = 2;
const MIN_TITLE_PX = 11;
/** Up to this many visible arrows, every arrow gets a count pill; above it only the heaviest few do. */
export const MAX_NUMBERED_ARROWS = 40;
const PILL_PX = 12;
const PILL_MINOR_PX = 11;
/** Strength of the file mosaic at the Folders level, against the file cells of the Files level. */
const MOSAIC_ALPHA = 0.45;

type Pt = [number, number];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Layout rectangle of a node (normalized for cells inside a workspace box; see `mapGeom.ts`). */
export function rectOf(geo: MapGeometry, i: number): Rect {
  return rectAt(geo, i);
}

export function distanceToPolyline(px: number, py: number, pts: [number, number][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k] as [number, number];
    const [x1, y1] = pts[k + 1] as [number, number];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
  }
  return best;
}

function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0] as Pt];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function strokeRounded(ctx: CanvasRenderingContext2D, pts: Pt[], radius: number): void {
  const first = pts[0] as Pt;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    // The first and last leg are short (they hold the start dot and the arrowhead): small corners there.
    const r = Math.min(
      i === 1 || i === pts.length - 2 ? 5 : radius,
      radius,
      Math.hypot(b[0] - a[0], b[1] - a[1]) / 2,
      Math.hypot(c[0] - b[0], c[1] - b[1]) / 2,
    );
    ctx.arcTo(b[0], b[1], c[0], c[1], r);
  }
  const last = pts[pts.length - 1] as Pt;
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
  outline = false,
): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle - 0.38) * size, y - Math.sin(angle - 0.38) * size);
  ctx.lineTo(x - Math.cos(angle + 0.38) * size, y - Math.sin(angle + 0.38) * size);
  ctx.closePath();
  ctx.fill();
  if (outline) ctx.stroke();
}

const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Width in px of an edge: grows with the square root of the weight, at most 8 (lanes are 10px apart). */
export function edgeWidth(weight: number): number {
  return Math.min(8, Math.max(1, 0.8 + 0.3 * Math.sqrt(weight)));
}

/** Workspace boxes smaller than this on screen show their title and counts only; the tiles appear on zoom. */
export const TINY_BOX_W = 160;
export const TINY_BOX_H = 90;
export const isTinyBox = (r: { w: number; h: number }): boolean => r.w < TINY_BOX_W || r.h < TINY_BOX_H;

/** The deepest cell under a screen point (cells under two pixels are not pickable), or null. */
export function pickCell(scene: Scene, geo: MapGeometry, cam: Camera, px: number, py: number): number | null {
  const tree = scene.tree;
  const has = (r: Rect): boolean => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  let cur = -1;
  let rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  for (const r of scene.roots) {
    const rr = rootRect(geo, r, cam);
    if (has(rr)) {
      cur = r;
      rect = rr;
      break;
    }
  }
  if (cur === -1) return null;
  if (isTinyBox(rect)) return cur; // its tiles are not drawn, so they are not pickable either
  for (;;) {
    const kids = (tree.nodes[cur] as TreeNode).children;
    if (kids.length === 0) break;
    const norm = normInner(scene, geo, cur);
    const act = actualInner(scene, geo, cur, rect, cam.scale);
    let next = -1;
    let nextRect = rect;
    for (const c of kids) {
      const cr = mapChild(geo, c, norm, act);
      if (has(cr)) {
        next = c;
        nextRect = cr;
        break;
      }
    }
    if (next === -1 || Math.min(nextRect.w, nextRect.h) < MIN_CELL_PX) break;
    if (scene.mosaic && kindTier((tree.nodes[next] as TreeNode).kind) === 2) break; // decorative, not pickable
    cur = next;
    rect = nextRect;
  }
  // A folder that is not drawn (the lone child of its parent) is never the answer: its parent is.
  while (scene.skipped[cur] && (tree.nodes[cur] as TreeNode).parent !== -1)
    cur = (tree.nodes[cur] as TreeNode).parent;
  return cur;
}

/**
 * The workspace and the folders (those that are drawn, outermost first) that contain a screen point: the "you are
 * here" path of the breadcrumb. Empty when the point is outside every box. Stops at files and at "(other)" groups.
 */
export function locatePath(scene: Scene, geo: MapGeometry, cam: Camera, px: number, py: number): number[] {
  const tree = scene.tree;
  const has = (r: Rect): boolean => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  let cur = -1;
  let rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  for (const r of scene.roots) {
    const rr = rootRect(geo, r, cam);
    if (has(rr)) {
      cur = r;
      rect = rr;
      break;
    }
  }
  if (cur === -1) return [];
  const path = [cur];
  if (isTinyBox(rect)) return path;
  for (;;) {
    const norm = normInner(scene, geo, cur);
    const act = actualInner(scene, geo, cur, rect, cam.scale);
    let next = -1;
    let nextRect = rect;
    for (const c of (tree.nodes[cur] as TreeNode).children) {
      const cr = mapChild(geo, c, norm, act);
      if (has(cr)) {
        next = c;
        nextRect = cr;
        break;
      }
    }
    if (next === -1) break;
    const node = tree.nodes[next] as TreeNode;
    if (kindTier(node.kind) !== 1 || node.kind === GROUP_KIND) break;
    if (!scene.skipped[next]) path.push(next);
    cur = next;
    rect = nextRect;
  }
  return path;
}

export function drawMap(env: DrawEnv): DrawResult {
  const { ctx, w, h, scene, geo, theme, cam } = env;
  const tree = scene.tree;
  const light = theme.scheme === "light";
  const result: DrawResult = {
    edgeHits: [],
    boxes: [],
    hiddenTitles: new Set(),
    titles: new Map(),
    titleTexts: new Map(),
    pills: [],
    labels: [],
    markers: [],
  };
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const measureCache = new Map<string, number>();
  const measure = (font: string, text: string): number => {
    const key = `${font}|${text}`;
    let v = measureCache.get(key);
    if (v === undefined) {
      ctx.font = font;
      v = ctx.measureText(text).width;
      measureCache.set(key, v);
    }
    return v;
  };

  // Per-workspace colours, computed once per frame. Siblings alternate between two close tints (by index), so
  // neighbouring cells read as separate cells in both themes; folder strips get a little stronger per depth.
  interface Tint {
    colour: string;
    box: string;
    folder: [string, string];
    band: [string, string, string];
    file: [string, string];
    sep: string;
    ink: string;
  }
  const tints = new Map<number, Tint>();
  const tintOf = (root: number): Tint => {
    let t = tints.get(root);
    if (!t) {
      const colour = workspaceColor(scene.rootRank.get(root) ?? 0, theme.scheme);
      const m = (amount: number) => mix(colour, theme.surface, amount);
      t = {
        colour,
        box: m(light ? 0.08 : 0.13),
        folder: light ? [m(0.3), m(0.38)] : [m(0.32), m(0.44)],
        // Solid bands, darker than the tiles under them (light) or the folder fills (dark).
        band: light ? [m(0.62), m(0.72), m(0.8)] : [m(0.58), m(0.68), m(0.78)],
        file: light ? [m(0.18), m(0.27)] : [m(0.2), m(0.32)],
        sep: light ? hexToRgba("#ffffff", 0.95) : hexToRgba("#06080b", 0.85),
        ink: labelInk(colour, theme.scheme),
      };
      tints.set(root, t);
    }
    return t;
  };
  // Link ink: the workspace colour moved toward black (light) or white (dark) just far enough for 3:1 against the
  // canvas (lines) and 4.5:1 against the pill background (numbers).
  const inks = new Map<number, { line: string; text: string }>();
  const linkInk = (root: number): { line: string; text: string } => {
    let k = inks.get(root);
    if (!k) {
      const colour = tintOf(root).colour;
      k = {
        line: inkAgainst(colour, theme.bg, theme.scheme, 3),
        text: inkAgainst(colour, theme.surface, theme.scheme, 4.5),
      };
      inks.set(root, k);
    }
    return k;
  };
  const kindCache = new Map<string, string>();
  const kindOf = (kind: string): string => {
    let c = kindCache.get(kind);
    if (!c) {
      c = kindColor(kind, theme.scheme);
      kindCache.set(kind, c);
    }
    return c;
  };

  const panelHover = env.panelHover != null && env.panelHover < tree.nodes.length ? env.panelHover : null;
  const dimmed = (i: number): boolean =>
    (env.bright !== null && !env.bright.has(i)) ||
    (panelHover !== null && (tree.nodes[i] as TreeNode).root !== panelHover);

  // The largest file of each folder (most functions, then first in order) gets a third chance at a label.
  const largestCache = new Map<number, number>();
  const largestFileOf = (parent: number): number => {
    let v = largestCache.get(parent);
    if (v === undefined) {
      v = -1;
      let top = -1;
      for (const c of (tree.nodes[parent] as TreeNode).children) {
        const cn = tree.nodes[c] as TreeNode;
        if (kindTier(cn.kind) !== 2 || cn.children.length > 0) continue;
        const f = scene.functions[c] ?? 0;
        if (f > top) {
          top = f;
          v = c;
        }
      }
      largestCache.set(parent, v);
    }
    return v;
  };

  setStripMeasure(measure);
  const measureAt = (weight: number, text: string, font: number) =>
    measure(`${weight} ${font}px ${FONT}`, text);
  const stickyTop = env.stickyTop ?? 0;
  const drawKids = (i: number, r: Rect, root: number, tint: Tint, top: number): void => {
    const kids = (tree.nodes[i] as TreeNode).children;
    if (kids.length === 0) return;
    const norm = normInner(scene, geo, i);
    const act = actualInner(scene, geo, i, r, cam.scale);
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k] as number;
      drawCell(c, mapChild(geo, c, norm, act), root, tint, k, top);
    }
  };

  /** The folder glyph in front of a strip's name: a small tab on a body. */
  const folderGlyph = (gx: number, gy: number, colour: string): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(gx, gy, 5, 2);
    ctx.fillRect(gx, gy + 2, 11, 7);
  };

  const drawCell = (i: number, r: Rect, root: number, tint: Tint, sib: number, top: number): void => {
    const { x, y, w: pw, h: ph } = r;
    if (pw < MIN_CELL_PX || ph < MIN_CELL_PX) return;
    if (x > w || y > h || x + pw < 0 || y + ph < 0) return;
    if (scene.skipped[i]) {
      drawKids(i, r, root, tint, top);
      return;
    }
    const node = tree.nodes[i] as TreeNode;
    const container = node.children.length > 0;
    const cls = kindTier(node.kind);
    ctx.globalAlpha = dimmed(i) ? 0.3 : 1;

    if (cls >= 3) {
      ctx.fillStyle = kindOf(node.kind);
      ctx.fillRect(x, y, pw, ph);
      if (pw >= 5 && ph >= 5) {
        ctx.strokeStyle = tint.sep;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
      }
      const label = scene.nodes[i]?.label ?? "";
      const fs = Math.min(12, Math.max(10, ph * 0.55));
      const text = fitCellLabel((t) => measure(`500 ${fs}px ${FONT}`, t), label, pw, ph, fs, 3);
      if (text) {
        ctx.font = `500 ${fs}px ${FONT}`;
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fillText(text, x + 3, y + (ph - fs) / 2);
      }
      return;
    }

    if (scene.mosaic && cls === 2 && !container) {
      // Folders level: files are only a faint mosaic that shows how big and how dense a folder is.
      ctx.globalAlpha = (dimmed(i) ? 0.3 : 1) * MOSAIC_ALPHA;
      ctx.fillStyle = tint.file[sib & 1] as string;
      ctx.fillRect(x, y, pw, ph);
      if (pw >= 4 && ph >= 4) {
        ctx.strokeStyle = tint.sep;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
      }
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = (cls === 1 ? tint.folder : tint.file)[sib & 1] as string;
    ctx.fillRect(x, y, pw, ph);
    if (pw >= 4 && ph >= 4) {
      ctx.strokeStyle = tint.sep;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
    }

    const head = headPx(scene, geo, i, pw, ph, cam.scale);
    const name = scene.nodes[i]?.label ?? "";
    // Labels stick to the left edge of the canvas while their cell is partly scrolled out of view.
    const vx = Math.max(x, 0);
    const vw = Math.min(x + pw, w) - vx;
    let kidsTop = top;
    let stuckStrip: (() => void) | null = null;
    if (cls === 1) {
      // Folder strip: a solid band with a folder glyph, the name in bold (last path segment, plus any skipped
      // folders below) and the function count when it fits. The strip sticks to the top edge while its folder is
      // partly scrolled out of view; strips of nested folders stack below it.
      if (head > 0) {
        const sy = Math.min(Math.max(y, top), y + ph - head);
        const stuck = sy > y + 0.5;
        if (stuck) kidsTop = sy + head;
        const paintStrip = (): void => {
          ctx.globalAlpha = dimmed(i) ? 0.3 : 1;
          const depth = Math.min(3, Math.max(1, scene.depth[i] as number));
          ctx.fillStyle = tint.band[depth - 1] as string;
          ctx.fillRect(x + 1, sy + 1, pw - 2, head - 1);
          // `headPx` only reserves a strip when the whole name fits (wrapped, at 10 to 11px), so this layout exists;
          // the name is never cut and the glyph never stands alone.
          const strip = folderStrip(folderTitle(scene, i), fnCount(scene, i), pw, ph);
          if (!strip) return;
          const textW = Math.max(...strip.lines.map((t) => measure(`700 ${strip.fs}px ${FONT}`, t)));
          const off = strip.glyph ? 19 : 5;
          // Scrolled partly out on the left, the label slides along with the visible part, never past its cell.
          const tx = Math.max(x + off, Math.min(vx + off, x + pw - textW - 4));
          result.labels.push({ id: node.id, kind: "folder", cellW: pw, lines: strip.lines });
          const lh = strip.fs * 1.15;
          ctx.font = `700 ${strip.fs}px ${FONT}`;
          ctx.fillStyle = tint.ink;
          const y0 = sy + 1 + (head - 1 - strip.lines.length * lh) / 2;
          strip.lines.forEach((line, k) => {
            ctx.fillText(line, tx, y0 + k * lh + (lh - strip.fs) / 2);
          });
          if (strip.glyph) folderGlyph(tx - 13, sy + 1 + (head - 1 - 9) / 2, tint.ink);
        };
        // A stuck strip is painted after the tiles under it, so they do not cover it.
        if (stuck) stuckStrip = paintStrip;
        else paintStrip();
      }
    } else if (container) {
      // A file that holds function chips: its name in a slim strip, regular weight, no band.
      if (head > 0) {
        const label = fitFileLabel((t, f) => measureAt(400, t, f), name, vw, head, 3);
        if (label) {
          ctx.font = `400 ${label.font}px ${FONT}`;
          ctx.fillStyle = tint.ink;
          ctx.fillText(label.lines[0] as string, vx + 3, y + (head - label.font) / 2);
        }
      }
    } else {
      // A file cell: the whole name at 10 to 11px in regular weight (on two lines when that is what it takes), and
      // a second small line with its function count when the cell has room. A name that does not fit gets no
      // label: zooming in reveals it.
      let label = fitFileLabel((t, f) => measureAt(400, t, f), name, vw, ph, 3);
      if (!label && node.parent !== -1 && largestFileOf(node.parent) === i)
        label = fitLargestFileLabel((t, f) => measureAt(400, t, f), name, vw, ph, 3);
      if (label) {
        const font = label.font;
        const lh = font * 1.15;
        const lw = Math.max(...label.lines.map((t) => measureAt(400, t, font)));
        result.labels.push({
          id: node.id,
          kind: "file",
          cellW: pw,
          lines: label.lines,
          box: { x: vx + 3, y: y + 2, w: lw, h: label.lines.length * lh },
        });
        ctx.font = `400 ${label.font}px ${FONT}`;
        ctx.fillStyle = tint.ink;
        label.lines.forEach((line, k) => {
          ctx.fillText(line, vx + 3, y + 2 + k * lh);
        });
        const used = 2 + label.lines.length * lh;
        if (pw >= 120 && ph >= 34 && used + 11 <= ph - 1) {
          ctx.font = `400 10px ${FONT}`;
          ctx.fillStyle = theme.scheme === "light" ? "#3d4756" : theme.muted;
          ctx.fillText(`${(scene.functions[i] ?? 0).toLocaleString("en-US")} fn`, vx + 3, y + used + 1);
        }
      }
    }

    if (container && pw >= 6 && ph >= 6) drawKids(i, r, root, tint, kidsTop);
    (stuckStrip as (() => void) | null)?.();
  };

  // 1. Workspace boxes and their treemaps.
  const rootBoxes: Rect[] = [];
  for (const r of scene.roots) {
    const rb = rootRect(geo, r, cam);
    const { x: bx, y: by, w: bw, h: bh } = rb;
    rootBoxes[r] = rb;
    if (bx > w || by > h || bx + bw < 0 || by + bh < 0) continue;
    result.boxes.push({ index: r, x: bx, y: by, w: bw, h: bh });
    const tint = tintOf(r);
    ctx.globalAlpha = dimmed(r) ? 0.3 : 1;
    roundRect(ctx, bx, by, bw, bh, Math.min(12, 12 * cam.scale + 2));
    ctx.fillStyle = tint.box;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hexToRgba(tint.colour, 0.9);
    ctx.stroke();
    if (!isTinyBox(rb)) drawKids(r, rb, r, tint, stickyTop);
  }
  ctx.globalAlpha = 1;

  // Obstacles for labels placed later: every visible box.
  const obstacles: Rect[] = result.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const placed: Rect[] = [];
  /** Titles beside a box also keep clear of the links; count pills only avoid boxes and each other. */
  let linesToAvoid = false;
  const free = (r: Rect, ignoreBox = -1): boolean => {
    if (r.x < 4 || r.y < 4 || r.x + r.w > w - 4 || r.y + r.h > h - 4) return false;
    for (let k = 0; k < result.boxes.length; k++) {
      const b = result.boxes[k] as { index: number };
      if (b.index === ignoreBox) continue;
      if (overlaps(r, obstacles[k] as Rect, 2)) return false;
    }
    if (placed.some((p) => overlaps(r, p, 2))) return false;
    if (env.reserved?.some((k) => overlaps(r, k, 2))) return false;
    if (linesToAvoid) {
      for (const e of result.edgeHits)
        for (const [px, py] of e.pts)
          if (
            px > r.x - 2 &&
            px < r.x + r.w + 2 &&
            py > r.y - 2 - e.width / 2 &&
            py < r.y + r.h + 2 + e.width / 2
          )
            return false;
    }
    return true;
  };

  // 2. Routed workspace links.
  drawWsEdges(env, result, placed, free, measure, linkInk);
  linesToAvoid = true;

  // 3. Links of the selected cell.
  drawCellLinks(env);

  // 4. Hover and selection outlines.
  const outline = (i: number | null, width: number, colour: string) => {
    if (i === null || i >= tree.nodes.length) return; // an index from the previous scene, for one frame
    const { x, y, w: pw, h: ph } = screenRectOf(scene, geo, cam, i);
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.strokeRect(x + width / 2, y + width / 2, Math.max(1, pw - width), Math.max(1, ph - width));
  };
  ctx.globalAlpha = 1;
  if (panelHover !== null) outline(panelHover, 3, theme.accent);
  if (env.hovered !== null && env.hovered !== env.selected) outline(env.hovered, 2, theme.text);
  outline(env.selected, 3, theme.accent);
  if (env.rankHover != null) outline(env.rankHover, 3, theme.accent);
  // A folder with no strip of its own (too small, or nested deeper than three levels) shows its name on hover.
  if (env.hovered !== null && env.hovered < tree.nodes.length) {
    const hn = tree.nodes[env.hovered] as TreeNode;
    const hr = screenRectOf(scene, geo, cam, env.hovered);
    if (
      kindTier(hn.kind) === 1 &&
      !scene.skipped[env.hovered] &&
      headPx(scene, geo, env.hovered, hr.w, hr.h, cam.scale) === 0 &&
      hr.w >= 30 &&
      hr.h >= 16
    ) {
      // The whole name, even when it is wider than the folder: a hover label is never cut.
      const text = folderTitle(scene, env.hovered);
      const font = `600 11px ${FONT}`;
      const tw = measure(font, text) + 10;
      const lx = Math.max(2, Math.min(hr.x + 1, w - tw - 2));
      ctx.fillStyle = hexToRgba(theme.surface, 0.95);
      ctx.fillRect(lx, hr.y + 1, tw, 15);
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 0.5, hr.y + 1.5, tw - 1, 14);
      ctx.font = font;
      ctx.fillStyle = theme.text;
      ctx.fillText(text, lx + 5, hr.y + 3);
    }
  }

  // 4b. Rank markers: numbered circles on the tiles of the largest files (Files level), nudged apart.
  drawRankMarkers(env, result, tintOf);

  // 5. Workspace titles last so nothing covers them; the selected and hovered ones first claim their space.
  const order = [...scene.roots]
    .filter((r) => rootBoxes[r] && result.boxes.some((b) => b.index === r))
    .sort((a, b) => {
      const pa = a === env.selected || a === env.highlightWs ? 1 : 0;
      const pb = b === env.selected || b === env.highlightWs ? 1 : 0;
      return pb - pa || (scene.functions[b] ?? 0) - (scene.functions[a] ?? 0) || a - b;
    });
  for (const r of order) {
    const forced = r === env.selected || r === env.hovered || r === env.highlightWs;
    drawTitle(env, result, r, rootBoxes[r] as Rect, tintOf(r), measure, placed, free, forced);
  }
  ctx.globalAlpha = 1;
  return result;
}

/**
 * The numbered markers of the ranked files. Each sits on its tile (the middle, or a corner when the tile's name label
 * is there); markers that would overlap are nudged apart, and none is ever dropped.
 */
function drawRankMarkers(
  env: DrawEnv,
  result: DrawResult,
  tintOf: (root: number) => { colour: string },
): void {
  const ranks = env.ranks;
  if (!ranks || ranks.length === 0) return;
  const { ctx, scene, geo, cam, theme, w, h } = env;
  const tree = scene.tree;
  const R = MARKER_R;
  const labelBox = new Map<string, Rect>();
  for (const l of result.labels) if (l.box) labelBox.set(l.id, l.box);
  const hitsLabel = (cx: number, cy: number, b: Rect | undefined): boolean =>
    !!b && cx + R > b.x - 1 && cx - R < b.x + b.w + 1 && cy + R > b.y - 1 && cy - R < b.y + b.h + 1;
  const items = [...ranks]
    .filter((r) => r.index < tree.nodes.length)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const rect = screenRectOf(scene, geo, cam, r.index);
      const id = (tree.nodes[r.index] as TreeNode).id;
      const box = labelBox.get(id);
      // Candidates: the middle, then the corners away from the name label.
      const cands: [number, number][] = [
        [rect.x + rect.w / 2, rect.y + rect.h / 2],
        [rect.x + rect.w - R - 2, rect.y + rect.h - R - 2],
        [rect.x + rect.w - R - 2, rect.y + R + 2],
        [rect.x + R + 2, rect.y + rect.h - R - 2],
      ];
      const roomy = rect.w >= 2 * R + 4 && rect.h >= 2 * R + 4;
      const pick =
        (roomy ? cands.find(([cx, cy]) => !hitsLabel(cx, cy, box)) : undefined) ??
        (cands[0] as [number, number]);
      return { ...r, id, x: pick[0], y: pick[1] };
    });
  const reserved = env.reserved ?? [];
  const placed = decollideMarkers(items, R, 2, (x, y) => {
    if (x < R + 2 || y < R + 2 || x > w - R - 2 || y > h - R - 2) return true;
    return reserved.some((k) => x + R > k.x && x - R < k.x + k.w && y + R > k.y && y - R < k.y + k.h);
  });
  const light = theme.scheme === "light";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  placed.forEach((p, k) => {
    const it = items[k] as (typeof items)[number];
    const hot = env.rankHover === it.index;
    const dim = env.panelHover != null && (tree.nodes[it.index] as TreeNode).root !== env.panelHover;
    const colour = tintOf((tree.nodes[it.index] as TreeNode).root).colour;
    const r = hot ? R + 2 : R;
    ctx.globalAlpha = dim ? 0.35 : 1;
    // Halo in the canvas colour keeps the circle apart from the tiles under it.
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(light ? "#ffffff" : "#0b0e13", 0.92);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = light ? "#12161d" : "#f5f7fa";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = hot ? theme.accent : colour;
    ctx.stroke();
    ctx.font = `700 ${it.rank > 9 ? 10 : 11}px ${FONT}`;
    ctx.fillStyle = light ? "#ffffff" : "#10141a";
    ctx.fillText(String(it.rank), p.x, p.y + 0.5);
    result.markers.push({ rank: it.rank, index: it.index, id: it.id, x: p.x, y: p.y, r: R });
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function drawTitle(
  env: DrawEnv,
  result: DrawResult,
  i: number,
  box: Rect,
  tint: { colour: string; ink: string },
  measure: (font: string, text: string) => number,
  placed: Rect[],
  free: (r: Rect, ignoreBox?: number) => boolean,
  _forced: boolean,
): void {
  const { ctx, scene, theme, cam, geo } = env;
  const realName = nodeTitle(scene, i);
  const baseSub = subtitleParts(scene, i);
  const isRepoRoot = scene.nodes[i]?.id === "ws:.";
  // The title block is at most `WS_HEAD_MAX` px tall whatever the zoom: it fills the header the cells leave free,
  // or the whole box when there is nothing inside to leave room for.
  // A tiny box (no tiles drawn) keeps its title and counts and uses the whole box for them.
  const tiny = isTinyBox(box);
  const head = tiny ? 0 : headPx(scene, geo, i, box.w, box.h, cam.scale);
  const leaf = (scene.tree.nodes[i] as TreeNode).children.length === 0 || tiny;
  const availH = (head > 0 ? head : leaf ? Math.min(box.h - 4, WS_HEAD_MAX + 16) : 0) - 7;
  const availW = box.w - 20;
  ctx.globalAlpha = 1;

  /** The name on at most `maxLines` lines of `availW`; the last line ends in an ellipsis when the name is longer. */
  const nameLinesFor = (fontStr: string, name: string, maxLines: number): string[] => {
    const m = (t: string) => measure(fontStr, t);
    const lines = wrapText(m, name, availW);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = `${(kept[maxLines - 1] as string).replace(/[-_/. ]+$/, "")}…`;
    while (last.length > 2 && m(last) > availW) last = `${last.slice(0, -2)}…`;
    kept[maxLines - 1] = last;
    return kept;
  };
  const layout = (name: string, nameFont: number, parts: string[], maxNameLines: number) => {
    const subFont = Math.min(12, Math.max(10, Math.round(nameFont * 0.7)));
    const nameFontStr = `700 ${nameFont}px ${FONT}`;
    const subFontStr = `500 ${subFont}px ${FONT}`;
    const nameLines = nameLinesFor(nameFontStr, name, maxNameLines);
    // Sub line: as many " · " parts per line as fit.
    const subLines: string[] = [];
    let cur = "";
    for (const part of parts) {
      const next = cur ? `${cur} · ${part}` : part;
      if (cur && measure(subFontStr, next) > availW) {
        subLines.push(cur);
        cur = part;
      } else cur = next;
    }
    if (cur) subLines.push(cur);
    const height =
      nameLines.length * nameFont * 1.2 + (subLines.length > 0 ? 3 + subLines.length * subFont * 1.25 : 0);
    const wide = subLines.some((t) => measure(subFontStr, t) > availW);
    const truncated = nameLines.length === maxNameLines && nameLines.some((t) => t.endsWith("…"));
    return { nameFont, subFont, nameFontStr, subFontStr, nameLines, subLines, height, wide, truncated };
  };

  /** Tries the title inside the box: full detail line first, shorter ones next, then smaller type, then no detail. */
  const fitInside = (name: string, sub: string[], allowEllipsis: boolean) => {
    if (availH <= 0) return null;
    const short = sub.map((p) => p.replace(/ functions?$/, " fn"));
    // The type ("app", "package", "(repo root)") goes first when space is short, except for the repo root, whose
    // type is what tells it apart.
    const noKind = short.length > 2 && !isRepoRoot ? short.slice(1) : short;
    // [detail parts, smallest name font, most name lines]
    const tries: [string[], number, number][] = [
      [sub, 12, 9],
      [short, 11, 9],
      [noKind, 11, 9],
      [noKind, 10, 2], // two lines at 10px
      [[], 10, 2], // name only
    ];
    for (const [parts, floor, lines] of tries) {
      for (let f = 18; f >= floor; f--) {
        const l = layout(name, f, parts, lines);
        if (l.truncated && !allowEllipsis) continue;
        if (l.height <= availH && !l.wide && l.nameLines.every((t) => measure(l.nameFontStr, t) <= availW))
          return l;
      }
    }
    return null;
  };

  // 1. The name as is; 2. for the repo root: "(repo root)" with the name moved to the detail line;
  // 3. the name cut to two lines.
  let name = realName;
  let chosen = fitInside(name, baseSub, false);
  if (!chosen && isRepoRoot) {
    name = "(repo root)";
    chosen = fitInside(name, baseSub.slice(1), true);
  }
  if (!chosen) {
    name = realName;
    chosen = fitInside(name, baseSub, true);
  }
  if (chosen) {
    result.titles.set(i, "inside");
    result.titleTexts.set(i, chosen.nameLines.join(" "));
    let y = box.y + 5;
    ctx.fillStyle = tint.ink;
    ctx.font = chosen.nameFontStr;
    for (const line of chosen.nameLines) {
      ctx.fillText(line, box.x + 10, y);
      y += chosen.nameFont * 1.2;
    }
    if (chosen.subLines.length > 0) y += 3;
    ctx.font = chosen.subFontStr;
    ctx.fillStyle = theme.scheme === "light" ? "#3d4756" : theme.muted;
    for (const line of chosen.subLines) {
      ctx.fillText(line, box.x + 10, y);
      y += chosen.subFont * 1.25;
    }
    return;
  }

  // Too small for its title: beside the box if there is free space. A box never goes without a name: when no
  // spot is free the title goes on the box itself, over its cells, on a halo.
  const font = `700 ${MIN_TITLE_PX + 1}px ${FONT}`;
  const fn = (scene.functions[i] ?? 0).toLocaleString("en-US");
  const fullText = `${isRepoRoot ? `(repo root) ${realName}` : realName} · ${fn} fn`;
  const rootText = `(repo root) · ${fn} fn`;
  const maxTextW = Math.max(120, Math.min(300, env.w - 16));
  let text = fullText;
  if (measure(font, text) > maxTextW && isRepoRoot) text = rootText;
  while (measure(font, text) > maxTextW && text.length > 6) text = `${text.slice(0, -4)}…`;
  const tw = measure(font, text);
  const bw = tw + 8;
  const candidates: Rect[] = [
    { x: box.x, y: box.y - 20, w: bw, h: 18 },
    { x: box.x + box.w - bw, y: box.y - 20, w: bw, h: 18 },
    { x: box.x, y: box.y + box.h + 3, w: bw, h: 18 },
    { x: box.x + box.w - bw, y: box.y + box.h + 3, w: bw, h: 18 },
    { x: box.x + box.w + 4, y: box.y, w: bw, h: 18 },
    { x: box.x - bw - 4, y: box.y, w: bw, h: 18 },
    { x: box.x + box.w + 4, y: box.y + box.h - 18, w: bw, h: 18 },
    { x: box.x - bw - 4, y: box.y + box.h - 18, w: bw, h: 18 },
  ];
  const spot = candidates.find((r) => free(r, i));
  result.titles.set(i, spot ? "beside" : "inside");
  result.titleTexts.set(i, text);
  const at = spot ?? { x: box.x + 2, y: box.y + 2, w: bw, h: 18 };
  placed.push(at);
  const halo = hexToRgba(theme.scheme === "light" ? "#ffffff" : theme.surface, 0.9);
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, at.x + 4, at.y + 2);
  ctx.fillStyle = tint.ink;
  ctx.fillText(text, at.x + 4, at.y + 2);
}

/** Distance from a segment to a rectangle (0 when they touch or cross). */
function segmentRectDistance(a: Pt, b: Pt, r: Rect): number {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  // Clip the segment to the rectangle (Liang-Barsky): any overlap means distance 0.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) {
        t0 = 2;
        break;
      }
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 <= t1) return 0;
  // Otherwise the closest points are an end of the segment or a corner of the rectangle.
  const toRect = (p: Pt): number =>
    Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(y0 - p[1], 0, p[1] - y1));
  let best = Math.min(toRect(a), toRect(b));
  const len2 = dx * dx + dy * dy;
  for (const c of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as Pt[]) {
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len2));
    best = Math.min(best, Math.hypot(c[0] - (a[0] + t * dx), c[1] - (a[1] + t * dy)));
  }
  return best;
}

/** The link ink of one workspace: the line colour (3:1 on the canvas) and the pill text colour (4.5:1 on the pill). */
interface LinkInk {
  line: string;
  text: string;
}

function drawWsEdges(
  env: DrawEnv,
  result: DrawResult,
  placed: Rect[],
  free: (r: Rect, ignoreBox?: number) => boolean,
  measure: (font: string, text: string) => number,
  inkOf: (root: number) => LinkInk,
): void {
  const { ctx, scene, geo, theme, cam } = env;
  const tree = scene.tree;
  const visible = new Set(result.boxes.map((b) => b.index));
  const shown = scene.wsEdges.filter(
    (e) => (!e.declaredOnly || env.showDeclared) && visible.has(e.src) && visible.has(e.dst),
  );
  if (shown.length === 0) return;
  const hl = env.highlightWs;
  const real = shown.filter((e) => !e.declaredOnly).sort((a, b) => a.weight - b.weight);
  // Bottom third of the real links by weight: thinner and smaller pills, but the same hue and never faint.
  const faintBelow = real.length >= 3 ? (real[Math.floor(real.length / 3)] as { weight: number }).weight : 0;
  const top = new Set(
    [...real]
      .sort((a, b) => b.weight - a.weight || a.src - b.src || a.dst - b.dst)
      .slice(0, 8)
      .map((e) => `${e.src}>${e.dst}`),
  );

  const ordered = [...shown].sort((a, b) => {
    const ia = hl !== null && (a.src === hl || a.dst === hl) ? 1 : 0;
    const ib = hl !== null && (b.src === hl || b.dst === hl) ? 1 : 0;
    return ia - ib || a.weight - b.weight;
  });
  interface PillSpec {
    key: string;
    src: number;
    pts: Pt[];
    lines: string[];
    two: string[];
    short: string;
    /** Low-weight link: the same style, a little smaller. */
    minor: boolean;
    dim: boolean;
  }
  const pills: PillSpec[] = [];
  // A diagram with few arrows numbers every one of them; a busy one numbers the heaviest only.
  const everyArrow = shown.length <= MAX_NUMBERED_ARROWS;
  const halo = hexToRgba(theme.surface, 0.9);

  for (const e of ordered) {
    const a = tree.nodes[e.src] as TreeNode;
    const b = tree.nodes[e.dst] as TreeNode;
    const key = `${a.id}>${b.id}`;
    const raw = geo.routes[key];
    let pts: Pt[];
    if (raw && raw.length >= 2)
      pts = raw.map((p): Pt => [p[0] * cam.scale + cam.tx, p[1] * cam.scale + cam.ty]);
    else {
      const ra = rectOf(geo, e.src);
      const rb = rectOf(geo, e.dst);
      pts = [
        [(ra.x + ra.w) * cam.scale + cam.tx, (ra.y + ra.h / 2) * cam.scale + cam.ty],
        [rb.x * cam.scale + cam.tx, (rb.y + rb.h / 2) * cam.scale + cam.ty],
      ];
    }
    const incident = hl !== null && (e.src === hl || e.dst === hl);
    const hovered = env.hoverEdge === key;
    const minor = !e.declaredOnly && e.weight <= faintBelow && real.length >= 3;
    let width = e.declaredOnly ? 1.25 : edgeWidth(e.weight);
    if (minor) width = Math.max(1.25, Math.min(width, 1.6));
    if (incident || hovered) width = Math.max(width, 2) + (hovered ? 1.5 : 0);
    const dim = hl !== null && !incident;
    const selectedCell = env.selected !== null && env.selected !== hl; // a cell is selected: ws links recede
    // Every link keeps its hue; low-weight and declared-only ones are never fainter than 55%.
    let alpha = e.declaredOnly ? 0.6 : minor ? 0.65 : 0.9;
    if (incident || hovered) alpha = 1;
    if (dim) alpha = 0.07;
    else if (selectedCell && env.bright) alpha = Math.min(alpha, 0.14);
    const ink = inkOf(e.src);

    const last = pts[pts.length - 1] as Pt;
    let prev = pts[pts.length - 2] as Pt;
    for (let k = pts.length - 2; k >= 0; k--) {
      prev = pts[k] as Pt;
      if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > 0.5) break;
    }
    const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
    // At least 11px so it reads, at most 15px so neighbouring ports (12px apart) keep their own heads. The tip
    // touches the edge of the target box.
    const head = Math.min(15, Math.max(11, width * 1.3 + 8));
    const shaft = pts.slice(0, -1);
    const back = Math.min(head * 0.8, Math.hypot(last[0] - prev[0], last[1] - prev[1]) * 0.9);
    shaft.push([last[0] - Math.cos(ang) * back, last[1] - Math.sin(ang) * back]);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ink.line;
    ctx.fillStyle = ink.line;
    ctx.lineWidth = width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    if (e.declaredOnly) ctx.setLineDash([5, 4]);
    strokeRounded(ctx, shaft, 14);
    ctx.setLineDash([]);
    // The arrowhead, with a hairline of the canvas colour so neighbouring heads and the box edge stay apart.
    ctx.strokeStyle = halo;
    ctx.lineWidth = 0.75;
    arrowHead(ctx, last[0], last[1], ang, head, true);
    // The start: a filled dot on the source box's edge.
    const first = pts[0] as Pt;
    const dot = Math.max(3.5, Math.min(6, width / 2 + 1.5));
    ctx.beginPath();
    ctx.arc(first[0], first[1], dot, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;

    result.edgeHits.push({
      key,
      src: e.src,
      dst: e.dst,
      weight: e.weight,
      noun: e.declaredOnly ? "declared dependency" : edgeNoun(e.kind, false),
      declared: e.declared,
      declaredOnly: e.declaredOnly,
      pts: densify(pts, 12),
      route: pts,
      width,
      colour: ink.line,
      alpha,
      head,
    });
    if (hl !== null ? incident : everyArrow || top.has(`${e.src}>${e.dst}`)) {
      const A = nodeTitle(scene, e.src);
      const B = nodeTitle(scene, e.dst);
      const count = e.declaredOnly
        ? "declared"
        : `${e.weight.toLocaleString("en-US")} ${e.weight === 1 ? "import" : "imports"}`;
      pills.push({
        key,
        src: e.src,
        pts,
        lines: [`${A} → ${B}: ${count}`],
        // Narrow channel: the same words on two lines.
        two: [`${A} → ${B}`, count],
        short: e.declaredOnly ? "declared" : e.weight.toLocaleString("en-US"),
        minor: !incident && minor,
        dim: dim || (selectedCell && env.bright !== null),
      });
    }
  }

  // Count pills, heaviest first. A pill sits ON its own route, on a straight stretch, preferably the first long one
  // after the source (so the number is next to where the line starts), and only where nothing else is: no box, title,
  // pill or key, and (when there is room) no other line within 14px. When no such spot exists the search runs on
  // along the whole route, with less and less clearance from other lines, before it settles for overlapping one.
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const wide = hl !== null;
  const clearOf = (rect: Rect, own: string, gap: number): boolean => {
    for (const other of result.edgeHits) {
      if (other.key === own) continue;
      for (let s = 1; s < other.route.length; s++) {
        const a = other.route[s - 1] as Pt;
        const b = other.route[s] as Pt;
        const reach = gap + other.width / 2;
        if (
          Math.max(a[0], b[0]) < rect.x - reach ||
          Math.min(a[0], b[0]) > rect.x + rect.w + reach ||
          Math.max(a[1], b[1]) < rect.y - reach ||
          Math.min(a[1], b[1]) > rect.y + rect.h + reach
        )
          continue;
        if (segmentRectDistance(a, b, rect) < gap + other.width / 2) return false;
      }
    }
    return true;
  };
  for (const p of pills.reverse()) {
    const fontPx = p.minor ? PILL_MINOR_PX : PILL_PX;
    const pillFont = `700 ${fontPx}px ${FONT}`;
    const ink = inkOf(p.src);
    // One line with both names and the count, else two lines, else just the count.
    const variants = wide ? [p.lines, p.two, [p.short]] : [[p.short]];
    const sizes = variants.map((lines) => {
      const tw = Math.max(...lines.map((t) => measure(pillFont, t)));
      const lh = fontPx + 3;
      return { lines, lh, pw: tw + (p.minor ? 8 : 12), ph: lines.length * lh + (p.minor ? 3 : 5) };
    });
    const segs: { a: Pt; b: Pt; len: number; first: boolean; last: boolean }[] = [];
    for (let s = 1; s < p.pts.length; s++) {
      const a = p.pts[s - 1] as Pt;
      const b = p.pts[s] as Pt;
      segs.push({
        a,
        b,
        len: Math.hypot(b[0] - a[0], b[1] - a[1]),
        first: s === 1,
        last: s === p.pts.length - 1,
      });
    }
    let found: { rect: Rect; size: (typeof sizes)[number]; c: Pt } | null = null;
    // [clearance from other lines (-1: none), room kept before the arrowhead, room kept at bends, room after the
    // source]. The first rows are the clean spots; the later ones squeeze nearer the ends of short links.
    const tiers: [number, number, number, number][] = [
      [7, 30, 12, 8],
      [3, 30, 12, 8],
      [3, 20, 4, 4],
      [0.5, 30, 12, 8],
      [0.5, 20, 4, 4],
      [-1, 30, 12, 8],
      [-1, 14, 4, 4],
    ];
    const at = (seg: (typeof segs)[number], d: number, size: (typeof sizes)[number]) => {
      const t = d / seg.len;
      const c: Pt = [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t];
      return { c, rect: { x: c[0] - size.pw / 2, y: c[1] - size.ph / 2, w: size.pw, h: size.ph } as Rect };
    };
    /** How much other line the pill would cover: the sum of the widths of the lines that touch it. */
    const covered = (rect: Rect): number => {
      let sum = 0;
      for (const other of result.edgeHits) {
        if (other.key === p.key) continue;
        for (let s = 1; s < other.route.length; s++)
          if (segmentRectDistance(other.route[s - 1] as Pt, other.route[s] as Pt, rect) < other.width / 2) {
            sum += other.width;
            break;
          }
      }
      return sum;
    };
    for (const [gap, endRoom, bendRoom, startRoom] of tiers) {
      let leastCover = Number.POSITIVE_INFINITY;
      for (const size of sizes) {
        for (const seg of segs) {
          const horizontal = seg.a[1] === seg.b[1];
          const along = horizontal ? size.pw : size.ph;
          const lo = (seg.first ? startRoom : bendRoom) + along / 2;
          const hi = seg.len - (seg.last ? endRoom : bendRoom) - along / 2;
          if (hi < lo || seg.len < 1) continue;
          for (let d = lo; d <= hi + 0.01; d += 5) {
            const { c, rect } = at(seg, d, size);
            if (!free(rect)) continue;
            if (gap >= 0) {
              if (!clearOf(rect, p.key, gap)) continue;
              found = { rect, size, c };
              break;
            }
            // Nothing is clean: cover as little of the other lines as possible, earliest on the route first.
            const cover = covered(rect);
            if (cover < leastCover) {
              leastCover = cover;
              found = { rect, size, c };
            }
          }
          if (found && gap >= 0) break;
        }
        if (found && gap >= 0) break;
      }
      if (found) break;
    }
    if (!found) {
      // A very short link: the number goes on the middle of its longest stretch, over whatever is there.
      const seg = segs.reduce((m, s) => (s.len > m.len ? s : m), segs[0] as (typeof segs)[number]);
      const size = sizes[sizes.length - 1] as (typeof sizes)[number];
      found = { ...at(seg, seg.len / 2, size), size };
    }
    const { rect, size, c } = found;
    placed.push(rect);
    ctx.globalAlpha = p.dim ? 0.3 : 1;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.min(rect.h / 2, 11));
    ctx.fillStyle = theme.surface;
    ctx.fill();
    ctx.lineWidth = p.minor ? 1.25 : 1.75;
    ctx.strokeStyle = ink.line;
    ctx.stroke();
    ctx.font = pillFont;
    ctx.fillStyle = ink.text;
    result.pills.push({
      key: p.key,
      count: p.short,
      text: size.lines.join(" | "),
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    size.lines.forEach((text, k) => {
      ctx.fillText(text, c[0], rect.y + (p.minor ? 1.5 : 2.5) + (k + 0.5) * size.lh + 0.5);
    });
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function drawCellLinks(env: DrawEnv): void {
  const { ctx, geo, cam, theme } = env;
  if (env.links.length === 0) return;
  const centre = (i: number): Pt => {
    const r = rectOf(geo, i);
    return [(r.x + r.w / 2) * cam.scale + cam.tx, (r.y + r.h / 2) * cam.scale + cam.ty];
  };
  const maxW = Math.max(...env.links.map((l) => l.weight), 1);
  ctx.lineCap = "round";
  for (const l of env.links) {
    const a = centre(l.src);
    const b = centre(l.dst);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 6) continue;
    const bow = Math.min(90, len * 0.22);
    const cx = (a[0] + b[0]) / 2 - (dy / len) * bow;
    const cy = (a[1] + b[1]) / 2 + (dx / len) * bow;
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 1 + 1.2 * Math.sqrt(l.weight / maxW);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(cx, cy, b[0], b[1]);
    ctx.stroke();
    const ang = Math.atan2(b[1] - cy, b[0] - cx);
    arrowHead(ctx, b[0], b[1], ang, 8);
    // Dots at the source so the direction reads at both ends.
    ctx.beginPath();
    ctx.arc(a[0], a[1], 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}

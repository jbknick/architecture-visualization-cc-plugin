// Drawing and hit testing for the project map: workspace boxes, the treemap inside them, routed workspace links
// and the links of the selected cell. Everything is drawn on one 2D canvas; cells smaller than two pixels and
// cells outside the viewport are skipped, which keeps 30k-function maps smooth.
import { kindTier, type TreeNode } from "./hierarchy.ts";
import {
  actualInner,
  type Cam,
  headPx,
  mapChild,
  normInner,
  rectAt,
  rootRect,
  screenRectOf,
  WS_HEAD_MAX,
} from "./mapGeom.ts";
import { edgeNoun, folderTitle, nodeTitle, type Scene, subtitleParts } from "./scene.ts";
import { type CanvasTheme, hexToRgba, kindColor, labelInk, mix, workspaceColor } from "./style.ts";
import { fitCellLabel, fitFileLabel, wrapText } from "./treemap.ts";
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
}

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
  width: number;
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
  pills: { key: string; count: string; text: string }[];
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Cells smaller than this on screen (either side) are not drawn. */
export const MIN_CELL_PX = 2;
const MIN_TITLE_PX = 11;
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

function polylineLength(pts: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    sum += Math.hypot((pts[i] as Pt)[0] - (pts[i - 1] as Pt)[0], (pts[i] as Pt)[1] - (pts[i - 1] as Pt)[1]);
  }
  return sum;
}

function strokeRounded(ctx: CanvasRenderingContext2D, pts: Pt[], radius: number): void {
  const first = pts[0] as Pt;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const r = Math.min(
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

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle - 0.42) * size, y - Math.sin(angle - 0.42) * size);
  ctx.lineTo(x - Math.cos(angle + 0.42) * size, y - Math.sin(angle + 0.42) * size);
  ctx.closePath();
  ctx.fill();
}

/** Point at `fraction` of the polyline's length. */
function pointAlong(pts: Pt[], fraction: number): Pt {
  let remaining = polylineLength(pts) * fraction;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= seg || i === pts.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= seg;
  }
  return pts[0] as Pt;
}

const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Width in px of an edge: sqrt of the weight, clamped. */
export function edgeWidth(weight: number): number {
  return Math.min(9, Math.max(1, 0.8 + 0.4 * Math.sqrt(weight)));
}

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
        band: light ? [m(0.5), m(0.6), m(0.7)] : [m(0.5), m(0.6), m(0.7)],
        file: light ? [m(0.18), m(0.27)] : [m(0.2), m(0.32)],
        sep: light ? hexToRgba("#ffffff", 0.95) : hexToRgba("#06080b", 0.85),
        ink: labelInk(colour, theme.scheme),
      };
      tints.set(root, t);
    }
    return t;
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

  const measureAt = (weight: number, text: string, font: number) =>
    measure(`${weight} ${font}px ${FONT}`, text);
  const drawKids = (i: number, r: Rect, root: number, tint: Tint): void => {
    const kids = (tree.nodes[i] as TreeNode).children;
    if (kids.length === 0) return;
    const norm = normInner(scene, geo, i);
    const act = actualInner(scene, geo, i, r, cam.scale);
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k] as number;
      drawCell(c, mapChild(geo, c, norm, act), root, tint, k);
    }
  };

  const drawCell = (i: number, r: Rect, root: number, tint: Tint, sib: number): void => {
    const { x, y, w: pw, h: ph } = r;
    if (pw < MIN_CELL_PX || ph < MIN_CELL_PX) return;
    if (x > w || y > h || x + pw < 0 || y + ph < 0) return;
    if (scene.skipped[i]) {
      drawKids(i, r, root, tint);
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
    if (cls === 1) {
      // Folder strip: the name (last path segment, plus any skipped folders below) and the function count.
      if (head > 0) {
        const depth = Math.min(3, Math.max(1, scene.depth[i] as number));
        ctx.fillStyle = tint.band[depth - 1] as string;
        ctx.fillRect(x + 1, y + 1, pw - 2, head - 1);
        const fs = Math.min(12, head - 4);
        const title = folderTitle(scene, i);
        const full = `${title} · ${(scene.functions[i] ?? 0).toLocaleString("en-US")} fn`;
        const font = `600 ${fs}px ${FONT}`;
        const m = (t: string) => measure(font, t);
        const text =
          fitCellLabel(m, full, vw - 2, head - 1, fs, 2, false) ??
          fitCellLabel(m, title, vw - 2, head - 1, fs, 2);
        if (text) {
          ctx.font = font;
          ctx.fillStyle = tint.ink;
          ctx.fillText(text, vx + 5, y + 1 + (head - 1 - fs) / 2 + 0.5);
        }
      }
    } else if (container) {
      // A file that holds function chips: its name in a slim strip.
      if (head > 0) {
        const label = fitFileLabel((t, f) => measureAt(600, t, f), name, vw, head, 3);
        if (label) {
          ctx.font = `600 ${label.font}px ${FONT}`;
          ctx.fillStyle = tint.ink;
          ctx.fillText(label.lines[0] as string, vx + 3, y + (head - label.font) / 2);
        }
      }
    } else {
      // A file cell: the name at 10 to 11px, wrapped onto two lines when that is what it takes.
      const label = fitFileLabel((t, f) => measureAt(600, t, f), name, vw, ph, 3);
      if (label) {
        ctx.font = `600 ${label.font}px ${FONT}`;
        ctx.fillStyle = tint.ink;
        label.lines.forEach((line, k) => {
          ctx.fillText(line, vx + 3, y + 2 + k * label.font * 1.15);
        });
      }
    }

    if (container && pw >= 6 && ph >= 6) drawKids(i, r, root, tint);
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
    drawKids(r, rb, r, tint);
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
  drawWsEdges(env, result, placed, free, measure);
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
      const title = folderTitle(scene, env.hovered);
      const font = `600 11px ${FONT}`;
      const text = fitCellLabel((t) => measure(font, t), title, hr.w - 2, 15, 11, 2) ?? "";
      if (text) {
        ctx.fillStyle = hexToRgba(theme.surface, 0.92);
        ctx.fillRect(hr.x + 1, hr.y + 1, Math.min(hr.w - 2, measure(font, text) + 10), 15);
        ctx.font = font;
        ctx.fillStyle = theme.text;
        ctx.fillText(text, hr.x + 5, hr.y + 3);
      }
    }
  }

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
  const head = headPx(scene, geo, i, box.w, box.h, cam.scale);
  const leaf = (scene.tree.nodes[i] as TreeNode).children.length === 0;
  const availH = (head > 0 ? head : leaf ? Math.min(box.h, WS_HEAD_MAX + 12) : 0) - 7;
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
    const noKind = short.length > 2 ? short.slice(1) : short;
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
    chosen = fitInside(name, [realName, ...baseSub], true);
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

function drawWsEdges(
  env: DrawEnv,
  result: DrawResult,
  placed: Rect[],
  free: (r: Rect, ignoreBox?: number) => boolean,
  measure: (font: string, text: string) => number,
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
  // Bottom third of the real links by weight: thin and faint.
  const faintBelow = real.length >= 3 ? (real[Math.floor(real.length / 3)] as { weight: number }).weight : 0;
  const top = new Set(
    [...real]
      .sort((a, b) => b.weight - a.weight || a.src - b.src || a.dst - b.dst)
      .slice(0, 8)
      .map((e) => `${e.src}>${e.dst}`),
  );
  const ink = theme.scheme === "light" ? "#566175" : "#aab4c5";
  const baseAlpha = theme.scheme === "light" ? 0.7 : 0.55;

  const ordered = [...shown].sort((a, b) => {
    const ia = hl !== null && (a.src === hl || a.dst === hl) ? 1 : 0;
    const ib = hl !== null && (b.src === hl || b.dst === hl) ? 1 : 0;
    return ia - ib || a.weight - b.weight;
  });
  const pills: { key: string; pts: Pt[]; lines: string[]; two: string[]; short: string; strong: boolean }[] =
    [];

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
    const faint = !e.declaredOnly && e.weight <= faintBelow && real.length >= 3 && !incident && !hovered;
    let width = e.declaredOnly ? 1 : edgeWidth(e.weight);
    if (faint) width = Math.min(width, 1.3);
    if (incident || hovered) width = Math.max(width, 1.6) + (hovered ? 1.5 : 0);
    const dim = hl !== null && !incident;
    const selectedCell = env.selected !== null && env.selected !== hl; // a cell is selected: ws links recede
    let alpha = baseAlpha;
    if (faint) alpha = 0.3;
    if (e.declaredOnly) alpha = 0.35;
    if (incident || hovered) alpha = 0.95;
    if (dim) alpha = 0.07;
    else if (selectedCell && env.bright) alpha = Math.min(alpha, 0.14);
    const colour = incident || hovered ? theme.accent : ink;

    const last = pts[pts.length - 1] as Pt;
    let prev = pts[pts.length - 2] as Pt;
    for (let k = pts.length - 2; k >= 0; k--) {
      prev = pts[k] as Pt;
      if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > 0.5) break;
    }
    const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
    const head = Math.max(9, width * 2.3 + 5);
    const shaft = pts.slice(0, -1);
    const back = Math.min(head * 0.8, Math.hypot(last[0] - prev[0], last[1] - prev[1]) * 0.9);
    shaft.push([last[0] - Math.cos(ang) * back, last[1] - Math.sin(ang) * back]);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = e.declaredOnly ? 1 : width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    if (e.declaredOnly) ctx.setLineDash([5, 4]);
    strokeRounded(ctx, shaft, 14);
    ctx.setLineDash([]);
    arrowHead(ctx, last[0], last[1], ang, head);
    ctx.globalAlpha = 1;

    const noun = edgeNoun(e.kind, false);
    result.edgeHits.push({
      key,
      src: e.src,
      dst: e.dst,
      weight: e.weight,
      noun: e.declaredOnly ? "declared dependency" : noun,
      declared: e.declared,
      declaredOnly: e.declaredOnly,
      pts: densify(pts, 12),
      width,
    });
    if (hl !== null ? incident : top.has(`${e.src}>${e.dst}`)) {
      const A = nodeTitle(scene, e.src);
      const B = nodeTitle(scene, e.dst);
      const count = e.declaredOnly
        ? "declared"
        : `${e.weight.toLocaleString("en-US")} ${e.weight === 1 ? "import" : "imports"}`;
      pills.push({
        key,
        pts,
        lines: [`${A} → ${B}: ${count}`],
        // Narrow channel: the same words on two lines.
        two: [`${A} → ${B}`, count],
        short: e.declaredOnly ? "declared" : e.weight.toLocaleString("en-US"),
        strong: incident,
      });
    }
  }

  // Count pills. Strongest first; each takes the free spot nearest the middle of its line.
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const pillFont = `700 ${MIN_TITLE_PX}px ${FONT}`;
  const wide = hl !== null;
  for (const p of pills.reverse()) {
    // One line with both names and the count, else two lines, else just the count.
    const variants = wide ? [p.lines, p.two, [p.short]] : [[p.short]];
    let done = false;
    for (const lines of variants) {
      const tw = Math.max(...lines.map((t) => measure(pillFont, t)));
      const pw = tw + 12;
      const ph = lines.length * (MIN_TITLE_PX + 3) + 5;
      const len = polylineLength(p.pts);
      const fractions = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
      for (const f of fractions) {
        const c = pointAlong(p.pts, f);
        const rect: Rect = { x: c[0] - pw / 2, y: c[1] - ph / 2, w: pw, h: ph };
        if (len < 12 || !free(rect)) continue;
        placed.push(rect);
        roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.min(ph / 2, 11));
        ctx.fillStyle = theme.surface;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = p.strong ? theme.accent : theme.scheme === "light" ? "#566175" : "#aab4c5";
        ctx.stroke();
        ctx.font = pillFont;
        ctx.fillStyle = theme.text;
        result.pills.push({ key: p.key, count: p.short, text: lines.join(" | ") });
        lines.forEach((text, k) => {
          ctx.fillText(text, c[0], rect.y + 2.5 + (k + 0.5) * (MIN_TITLE_PX + 3) + 0.5);
        });
        done = true;
        break;
      }
      if (done) break;
    }
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

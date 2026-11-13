// Screen-space geometry of the project map. The layout (worker) puts every cell in a normalized content
// rectangle of its parent (the parent's rectangle minus `TM_PAD`, no header reserved). Headers are a constant size
// on screen, so the real content area of a container is its on-screen rectangle minus the header that fits at
// the current zoom, and a child is mapped from the normalized rectangle into that area. Drawing and picking use
// the same functions, so a click always lands on what was drawn. No elk, no squarify at zoom time.
import { kindTier, type TreeNode } from "./hierarchy.ts";
import type { Scene } from "./scene.ts";
import { TM_PAD } from "./treemap.ts";
import type { MapGeometry, Rect } from "./types.ts";

/** Workspace title block, folder strip and file-name strip: the tallest they get on screen, in px. */
export const WS_HEAD_MAX = 44;
export const DIR_STRIP_MAX = 20;
export const FILE_STRIP_MAX = 16;
/** A folder gets a header strip when it is at least this big on screen. */
export const DIR_MIN_W = 70;
export const DIR_MIN_H = 28;
/** Folders nested deeper than this get no strip (their name shows on hover). */
export const MAX_STRIP_DEPTH = 3;
/** Below this a workspace title block is not reserved (the title goes beside the box). */
export const WS_HEAD_MIN = 30;

/** Padding around the children of a container on screen, in px. */
export function padPx(scale: number): number {
  return Math.min(2, Math.max(0.5, scale * TM_PAD));
}

/** Height of the header strip reserved at the top of cell `i` (on-screen size `pw` x `ph`) at zoom `scale`. */
export function headPx(
  scene: Scene,
  geo: MapGeometry,
  i: number,
  pw: number,
  ph: number,
  scale: number,
): number {
  if (scene.skipped[i]) return 0;
  const node = scene.tree.nodes[i] as TreeNode;
  const tier = kindTier(node.kind);
  if (tier === 0) {
    if (node.children.length === 0) return 0;
    const h = Math.min(WS_HEAD_MAX, (geo.heads[i] as number) * scale);
    return h >= WS_HEAD_MIN && ph >= h + 12 ? h : 0;
  }
  if (tier === 1) {
    if ((scene.depth[i] as number) > MAX_STRIP_DEPTH || pw < DIR_MIN_W || ph < DIR_MIN_H) return 0;
    return Math.min(DIR_STRIP_MAX, Math.max(14, ph * 0.3));
  }
  if (tier === 2 && node.children.length > 0) {
    if (pw < 40 || ph < 24) return 0;
    return Math.min(FILE_STRIP_MAX, Math.max(13, ph * 0.25));
  }
  return 0;
}

export function rectAt(geo: MapGeometry, i: number): Rect {
  const k = i * 4;
  return {
    x: geo.rects[k] as number,
    y: geo.rects[k + 1] as number,
    w: geo.rects[k + 2] as number,
    h: geo.rects[k + 3] as number,
  };
}

/** The normalized content rectangle the children of `i` were laid out in. */
export function normInner(scene: Scene, geo: MapGeometry, i: number): Rect {
  const r = rectAt(geo, i);
  if (scene.skipped[i]) return r;
  return {
    x: r.x + TM_PAD,
    y: r.y + TM_PAD,
    w: Math.max(0, r.w - 2 * TM_PAD),
    h: Math.max(0, r.h - 2 * TM_PAD),
  };
}

/** Where the children of `i` really go, given the on-screen rectangle `r` of `i`. */
export function actualInner(scene: Scene, geo: MapGeometry, i: number, r: Rect, scale: number): Rect {
  if (scene.skipped[i]) return r;
  const pad = padPx(scale);
  const head = headPx(scene, geo, i, r.w, r.h, scale);
  return {
    x: r.x + pad,
    y: r.y + pad + head,
    w: Math.max(0, r.w - 2 * pad),
    h: Math.max(0, r.h - 2 * pad - head),
  };
}

/** The on-screen rectangle of a child, from its normalized rectangle in the parent's normalized content area. */
export function mapChild(geo: MapGeometry, c: number, norm: Rect, actual: Rect): Rect {
  const k = c * 4;
  const fx = norm.w > 1e-9 ? actual.w / norm.w : 0;
  const fy = norm.h > 1e-9 ? actual.h / norm.h : 0;
  return {
    x: actual.x + ((geo.rects[k] as number) - norm.x) * fx,
    y: actual.y + ((geo.rects[k + 1] as number) - norm.y) * fy,
    w: (geo.rects[k + 2] as number) * fx,
    h: (geo.rects[k + 3] as number) * fy,
  };
}

export interface Cam {
  scale: number;
  tx: number;
  ty: number;
}

/** On-screen rectangle of a workspace box. */
export function rootRect(geo: MapGeometry, i: number, cam: Cam): Rect {
  const r = rectAt(geo, i);
  return { x: r.x * cam.scale + cam.tx, y: r.y * cam.scale + cam.ty, w: r.w * cam.scale, h: r.h * cam.scale };
}

/** On-screen rectangle of any cell, by walking down from its workspace. */
export function screenRectOf(scene: Scene, geo: MapGeometry, cam: Cam, i: number): Rect {
  const path: number[] = [];
  for (let c = i; c !== -1; c = (scene.tree.nodes[c] as TreeNode).parent) path.push(c);
  path.reverse();
  let r = rootRect(geo, path[0] as number, cam);
  for (let k = 1; k < path.length; k++) {
    const p = path[k - 1] as number;
    r = mapChild(geo, path[k] as number, normInner(scene, geo, p), actualInner(scene, geo, p, r, cam.scale));
  }
  return r;
}

/** The same rectangle in layout (world) units: what the camera should fit to show cell `i` at zoom `scale`. */
export function worldRectOf(scene: Scene, geo: MapGeometry, i: number, scale: number): Rect {
  const r = screenRectOf(scene, geo, { scale, tx: 0, ty: 0 }, i);
  return { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale };
}

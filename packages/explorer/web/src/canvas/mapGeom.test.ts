// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../mock/largeMap.ts";
import { kindTier, type TreeNode } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { pickCell } from "./mapDraw.ts";
import {
  actualInner,
  DIR_STRIP_MAX,
  FILE_STRIP_MAX,
  headPx,
  mapChild,
  normInner,
  screenRectOf,
  WS_HEAD_MAX,
} from "./mapGeom.ts";
import { buildScene, folderTitle, layoutInputFor, subtitleParts } from "./scene.ts";

async function large(level: "workspaces" | "dirs" | "files" | "symbols") {
  const view = projectMapLarge({ focus: null, level, options: {} });
  if ("error" in view) throw new Error(view.error);
  const scene = buildScene(view.nodes, view.edges, "nested-elk");
  const out = await computeLayout(layoutInputFor(scene, "nested-elk", null, undefined, { w: 1180, h: 812 }));
  if (!out.map) throw new Error("no map geometry");
  return { scene, geo: out.map };
}

describe("single-child folder chains in the project map", () => {
  it("skips the lone `src` of a workspace and says so in the sub-line, without touching ids", async () => {
    const { scene } = await large("dirs");
    const api = scene.tree.index.get("ws:@acme-platform-monorepo/api") as number;
    const src = scene.tree.index.get("dir:apps/api/src") as number;
    expect(scene.skipped[src]).toBe(1);
    expect(scene.tree.nodes[src]?.id).toBe("dir:apps/api/src"); // ids are the server's
    expect(subtitleParts(scene, api).at(-1)).toBe("src/");
    // Its children are the workspace's visible top-level folders, at depth 1.
    const routes = scene.tree.index.get("dir:apps/api/src/routes") as number;
    expect(scene.skipped[routes]).toBe(0);
    expect(scene.depth[routes]).toBe(1);
    expect(folderTitle(scene, routes)).toBe("routes");
  });

  it("keeps the layout of the skipped folder's children identical to being direct children of the workspace", async () => {
    const { scene, geo } = await large("dirs");
    const api = scene.tree.index.get("ws:@acme-platform-monorepo/api") as number;
    const src = scene.tree.index.get("dir:apps/api/src") as number;
    const r = (i: number) => [0, 1, 2, 3].map((k) => geo.rects[i * 4 + k] as number);
    // `src` takes the workspace's whole inner rectangle (the box minus the padding), nothing more.
    const inner = normInner(scene, geo, api);
    [inner.x, inner.y, inner.w, inner.h].forEach((v, k) => {
      expect(r(src)[k]).toBeCloseTo(v, 6);
    });
    expect(normInner(scene, geo, src)).toEqual({ x: inner.x, y: inner.y, w: inner.w, h: inner.h });
  });
});

describe("headers are a constant size on screen", () => {
  it("never exceed 44 / 20 / 16 px at any zoom, and shrink or vanish when zoomed out", async () => {
    const { scene, geo } = await large("symbols");
    const seen = { ws: 0, dir: 0, file: 0 };
    for (const scale of [0.3, 0.6, 1, 2, 5, 12, 40]) {
      const cam = { scale, tx: 0, ty: 0 };
      for (let i = 0; i < scene.tree.nodes.length; i += 3) {
        const node = scene.tree.nodes[i] as TreeNode;
        if (node.children.length === 0 && kindTier(node.kind) !== 1) continue;
        const r = screenRectOf(scene, geo, cam, i);
        const head = headPx(scene, geo, i, r.w, r.h, scale);
        const tier = kindTier(node.kind);
        if (tier === 0) {
          expect(head).toBeLessThanOrEqual(WS_HEAD_MAX);
          if (head > 0) seen.ws++;
        } else if (tier === 1) {
          expect(head).toBeLessThanOrEqual(DIR_STRIP_MAX);
          if (head > 0) {
            seen.dir++;
            expect(r.w).toBeGreaterThanOrEqual(70);
            expect(r.h).toBeGreaterThanOrEqual(28);
          }
        } else if (tier === 2) {
          expect(head).toBeLessThanOrEqual(FILE_STRIP_MAX);
          if (head > 0) seen.file++;
        }
      }
    }
    expect(seen.ws).toBeGreaterThan(0);
    expect(seen.dir).toBeGreaterThan(0);
    expect(seen.file).toBeGreaterThan(0);
    // Fully zoomed out nothing keeps a folder strip: cells are too small.
    const tiny = { scale: 0.1, tx: 0, ty: 0 };
    for (let i = 0; i < scene.tree.nodes.length; i++) {
      if (kindTier((scene.tree.nodes[i] as TreeNode).kind) !== 1) continue;
      const r = screenRectOf(scene, geo, tiny, i);
      expect(headPx(scene, geo, i, r.w, r.h, 0.1)).toBe(0);
    }
  });

  it("strips folders nested deeper than three levels (their names show on hover)", async () => {
    const { scene, geo } = await large("dirs");
    const deep = scene.tree.nodes.findIndex((_, i) => (scene.depth[i] as number) > 3);
    // The mock has no folder that deep: the rule is covered by forcing a depth.
    expect(deep).toBe(-1);
    const routes = scene.tree.index.get("dir:apps/api/src/routes") as number;
    const r = screenRectOf(scene, geo, { scale: 20, tx: 0, ty: 0 }, routes);
    expect(headPx(scene, geo, routes, r.w, r.h, 20)).toBeGreaterThan(0);
    scene.depth[routes] = 4;
    expect(headPx(scene, geo, routes, r.w, r.h, 20)).toBe(0);
    scene.depth[routes] = 1;
  });
});

describe("picking is exact with screen-space headers", () => {
  it("finds the cell that was drawn under every sampled point, at several zooms", async () => {
    const { scene, geo } = await large("symbols");
    let checked = 0;
    for (const scale of [0.7, 3, 14]) {
      const cam = { scale, tx: 12, ty: 30 };
      for (let i = 0; i < scene.tree.nodes.length; i += 5) {
        if (scene.skipped[i]) continue;
        const r = screenRectOf(scene, geo, cam, i);
        if (Math.min(r.w, r.h) < 6) continue;
        // Tiles of a tiny box (under 160 x 90 on screen) are not drawn, so they are not pickable either.
        const root = screenRectOf(scene, geo, cam, (scene.tree.nodes[i] as TreeNode).root);
        if (root.w < 160 || root.h < 90) continue;
        // The centre of a cell is the cell, or something drawn on top of it (its own children).
        const picked = pickCell(scene, geo, cam, r.x + r.w / 2, r.y + r.h / 2);
        expect(picked).not.toBeNull();
        let inside = false;
        for (let c = picked as number; c !== -1; c = (scene.tree.nodes[c] as TreeNode).parent)
          if (c === i) inside = true;
        expect(inside).toBe(true);
        // Just inside the top-left corner, in the header strip: the container itself, never a child.
        const head = headPx(scene, geo, i, r.w, r.h, scale);
        if (head > 4 && (scene.tree.nodes[i] as TreeNode).children.length > 0) {
          expect(pickCell(scene, geo, cam, r.x + r.w / 2, r.y + head / 2)).toBe(i);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("never returns a skipped folder, and maps children inside the parent's content area", async () => {
    const { scene, geo } = await large("dirs");
    const cam = { scale: 9, tx: 0, ty: 0 };
    const api = scene.tree.index.get("ws:@acme-platform-monorepo/api") as number;
    const src = scene.tree.index.get("dir:apps/api/src") as number;
    const box = screenRectOf(scene, geo, cam, api);
    expect(pickCell(scene, geo, cam, box.x + box.w / 2, box.y + box.h / 2)).not.toBe(src);
    const inner = actualInner(scene, geo, api, box, 9);
    expect(inner.y).toBeGreaterThan(box.y + 20); // the title block is reserved, not scaled
    expect(inner.y).toBeLessThanOrEqual(box.y + WS_HEAD_MAX + 3);
    for (const c of (scene.tree.nodes[api] as TreeNode).children) {
      const cr = mapChild(geo, c, normInner(scene, geo, api), inner);
      expect(cr.x).toBeGreaterThanOrEqual(inner.x - 1e-6);
      expect(cr.y).toBeGreaterThanOrEqual(inner.y - 1e-6);
      expect(cr.x + cr.w).toBeLessThanOrEqual(inner.x + inner.w + 1e-6);
      expect(cr.y + cr.h).toBeLessThanOrEqual(inner.y + inner.h + 1e-6);
    }
  });
});

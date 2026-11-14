// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { projectMapLarge } from "../../../mock/largeMap.ts";
import { computeLayout } from "../../canvas/layout.ts";
import { buildScene, layoutInputFor, type Scene } from "../../canvas/scene.ts";
import type { MapGeometry, Rect } from "../../canvas/types.ts";
import { rankFiles } from "../../rankedFiles/rank.ts";
import { convexHull, FLAG_R, placeFlags, quadHitsRect, rectInsideHull } from "./labels.ts";
import {
  type Box3,
  buildCity,
  type City,
  type CityLevel,
  HeightGrid,
  makeHeightScale,
  rectToBox,
} from "./model.ts";

const VIEWPORT = { w: 1160, h: 810 };

interface Built {
  scene: Scene;
  map: MapGeometry;
  /** The 2D map's own layout for the same data (default title blocks). */
  plain: MapGeometry;
  city: City;
  nodes: ReturnType<typeof nodesOf>;
}

function nodesOf(level: CityLevel) {
  const view = projectMapLarge({ focus: null, level, options: {} });
  if ("error" in view) throw new Error(view.error);
  return view;
}

const built = new Map<CityLevel, Built>();

beforeAll(async () => {
  for (const level of ["workspaces", "dirs", "files"] as const) {
    const view = nodesOf(level);
    const scene = buildScene(view.nodes, view.edges, "nested-elk");
    const result = await computeLayout(layoutInputFor(scene, "nested-elk", null, undefined, VIEWPORT, true));
    const map = result.map as MapGeometry;
    const plain = (await computeLayout(layoutInputFor(scene, "nested-elk", null, undefined, VIEWPORT)))
      .map as MapGeometry;
    built.set(level, { scene, map, plain, city: buildCity(scene, map, { level }), nodes: view });
  }
}, 120_000);

const get = (level: CityLevel): Built => built.get(level) as Built;
const rectOf = (map: MapGeometry, i: number): Rect => ({
  x: map.rects[i * 4] as number,
  y: map.rects[i * 4 + 1] as number,
  w: map.rects[i * 4 + 2] as number,
  h: map.rects[i * 4 + 3] as number,
});
const within = (inner: Box3, outer: Box3, eps = 0.01): boolean =>
  inner.cx - inner.sx / 2 >= outer.cx - outer.sx / 2 - eps &&
  inner.cx + inner.sx / 2 <= outer.cx + outer.sx / 2 + eps &&
  inner.cz - inner.sz / 2 >= outer.cz - outer.sz / 2 - eps &&
  inner.cz + inner.sz / 2 <= outer.cz + outer.sz / 2 + eps;

describe("2D rectangle to 3D box", () => {
  it("maps x to X and y to Z around the origin, and stands the box on its base", () => {
    const b = rectToBox({ x: 100, y: 40, w: 60, h: 20 }, 5, 12, { x: 80, y: 30 });
    expect(b).toEqual({ cx: 50, cy: 11, cz: 20, sx: 60, sy: 12, sz: 20 });
  });
  it("insets a share of the size on every side", () => {
    const b = rectToBox({ x: 0, y: 0, w: 100, h: 50 }, 0, 1, { x: 0, y: 0 }, 0.1);
    expect(b.sx).toBeCloseTo(80);
    expect(b.sz).toBeCloseTo(40);
    expect(b.cx).toBeCloseTo(50);
    expect(b.cz).toBeCloseTo(25);
  });
});

describe("height scale", () => {
  const values = [0, 1, 2, 3, 5, 8, 13, 21, 400];
  const scale = makeHeightScale(values, 2, 60);
  it("has a floor: 0 functions is a flat tile, not nothing", () => {
    expect(scale.at(0)).toBe(2);
    expect(scale.at(-5)).toBe(2);
  });
  it("is monotonic and linear below the cap", () => {
    let prev = -1;
    for (const v of [0, 1, 2, 4, 8, 16, 32, 64, 128]) {
      const h = scale.at(v);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
    const half = scale.at(scale.cap / 2);
    expect(half).toBeCloseTo((2 + 60) / 2, 6);
  });
  it("is capped: one giant file cannot dwarf the scene", () => {
    expect(scale.at(400)).toBe(60);
    expect(scale.at(1_000_000)).toBe(60);
    expect(scale.cap).toBeLessThan(400);
  });
});

describe("the city on the large mock", () => {
  it("has 11 districts whose rectangles are the 2D map's workspace rectangles (within a few px: the city sizes every box as if it had contents)", () => {
    for (const level of ["workspaces", "dirs", "files"] as const) {
      const { plain, city } = get(level);
      for (const d of city.districts) {
        const r = rectOf(plain, d.idx);
        // The 2D map sizes a box with no contents (Workspaces level) a pixel or two smaller; the city does not.
        const eps = 6;
        expect(Math.abs(d.rect.x - r.x), `${level} ${d.id} x`).toBeLessThanOrEqual(eps);
        expect(Math.abs(d.rect.y - r.y), `${level} ${d.id} y`).toBeLessThanOrEqual(eps);
        expect(Math.abs(d.rect.w - r.w), `${level} ${d.id} w`).toBeLessThanOrEqual(3);
        expect(Math.abs(d.rect.h - r.h), `${level} ${d.id} h`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("maps its own layout to world boxes, with the palette index the 2D map uses", () => {
    for (const level of ["workspaces", "dirs", "files"] as const) {
      const { scene, map, city } = get(level);
      expect(city.districts).toHaveLength(11);
      for (const d of city.districts) {
        const r = rectOf(map, d.idx);
        expect(d.rect).toEqual(r);
        // World box = 2D rect shifted to the centre of the diagram (x -> X, y -> Z).
        expect(d.box.cx).toBeCloseTo(r.x + r.w / 2 - city.origin.x, 6);
        expect(d.box.cz).toBeCloseTo(r.y + r.h / 2 - city.origin.y, 6);
        expect(d.box.sx).toBeCloseTo(r.w, 6);
        expect(d.box.sz).toBeCloseTo(r.h, 6);
        expect(d.colorIndex).toBe(scene.rootRank.get(d.idx));
      }
    }
  });

  it("puts every district in the same place at the Workspaces, Folders and Files levels", () => {
    const by = (level: CityLevel) =>
      Object.fromEntries(
        get(level).city.districts.map((d) => [d.id, [d.rect.x, d.rect.y, d.rect.w, d.rect.h]]),
      );
    expect(by("dirs")).toEqual(by("workspaces"));
    expect(by("files")).toEqual(by("workspaces"));
  });

  it("is deterministic", () => {
    const { scene, map } = get("files");
    const again = buildCity(scene, map, { level: "files" });
    const strip = (c: City) => JSON.stringify({ d: c.districts, f: c.folders, b: c.buildings, a: c.arches });
    expect(strip(again)).toBe(strip(get("files").city));
  });

  it("keeps building footprints inside their folder and district, and folders inside their district", () => {
    const { city } = get("files");
    expect(city.buildings.length).toBeGreaterThan(800);
    for (const b of city.buildings) {
      const d = city.districts[b.district] as (typeof city.districts)[number];
      expect(within(b.box, d.box), b.id).toBe(true);
      if (b.folder >= 0)
        expect(within(b.box, (city.folders[b.folder] as (typeof city.folders)[number]).box), b.id).toBe(true);
    }
    for (const f of city.folders) {
      const d = city.districts[f.district] as (typeof city.districts)[number];
      expect(within(f.box, d.box), f.id).toBe(true);
    }
  });

  it("stands a building on its folder: height grows with functions, 0 functions is a flat tile", () => {
    const { city } = get("files");
    const flat = city.buildings.filter((b) => b.fns === 0);
    expect(flat.length).toBeGreaterThan(0);
    for (const b of flat) expect(b.box.sy).toBeCloseTo(city.files.floor, 6);
    const sorted = [...city.buildings].sort((p, q) => p.fns - q.fns);
    for (let i = 1; i < sorted.length; i++)
      expect((sorted[i] as (typeof sorted)[number]).box.sy).toBeGreaterThanOrEqual(
        (sorted[i - 1] as (typeof sorted)[number]).box.sy - 1e-9,
      );
    const max = Math.max(...city.buildings.map((b) => b.box.sy));
    expect(max).toBeLessThanOrEqual(city.files.max + 1e-9);
  });

  it("extrudes only the leaf folders at the Folders level, and no building at that level", () => {
    const { city } = get("dirs");
    expect(city.buildings).toHaveLength(0);
    const extruded = city.folders.filter((f) => f.extruded);
    expect(extruded.length).toBeGreaterThan(10);
    for (const f of extruded) expect(f.leaf).toBe(true);
    const big = extruded.reduce((a, b) => (b.fns > a.fns ? b : a));
    const small = extruded.reduce((a, b) => (b.fns < a.fns ? b : a));
    expect(big.box.sy).toBeGreaterThan(small.box.sy);
  });

  it("has one low block per district at the Workspaces level, taller for bigger workspaces", () => {
    const { city } = get("workspaces");
    expect(city.districts.every((d) => d.block !== null)).toBe(true);
    const api = city.districts.find((d) => d.id.endsWith("/api"));
    const types = city.districts.find((d) => d.id.endsWith("/types"));
    expect((api as (typeof city.districts)[number]).block?.sy).toBeGreaterThan(
      (types as (typeof city.districts)[number]).block?.sy ?? 0,
    );
  });

  it("draws one arch per import link (declared-only ones only on request), with the 2D route's ports", () => {
    const { scene, map, city } = get("files");
    const imports = scene.wsEdges.filter((e) => !e.declaredOnly);
    expect(city.arches).toHaveLength(imports.length);
    expect(city.arches.length).toBe(23);
    const withDeclared = buildCity(scene, map, { level: "files", showDeclared: true });
    expect(withDeclared.arches.length).toBeGreaterThan(city.arches.length);
    for (const a of city.arches) {
      const route = map.routes[a.key] as [number, number][];
      const first = a.pts[0] as (typeof a.pts)[number];
      const last = a.pts[a.pts.length - 1] as (typeof a.pts)[number];
      expect(first.x).toBeCloseTo((route[0] as [number, number])[0] - city.origin.x, 6);
      expect(first.z).toBeCloseTo((route[0] as [number, number])[1] - city.origin.y, 6);
      expect(last.x).toBeCloseTo((route[route.length - 1] as [number, number])[0] - city.origin.x, 6);
    }
    // The two directions of api <-> core are separate arches.
    const keys = city.arches.map((a) => a.key);
    expect(keys.some((k) => k.includes("api>") && k.endsWith("core"))).toBe(true);
    expect(keys.some((k) => k.includes("core>") && k.endsWith("api"))).toBe(true);
  });

  it("lifts every arch clear of the tallest building under its route", () => {
    for (const level of ["workspaces", "dirs", "files"] as const) {
      const { city } = get(level);
      const solids: Box3[] = [
        ...city.districts.flatMap((d) => (d.block ? [d.block] : [])),
        ...city.folders.map((f) => f.box),
        ...city.buildings.map((b) => b.box),
      ];
      for (const a of city.arches) {
        expect(a.pts.length).toBeGreaterThan(8);
        // Interior samples: the ends sit on the districts' floors.
        for (const p of a.pts.slice(1, -1)) {
          for (const s of solids) {
            const under =
              Math.abs(p.x - s.cx) <= s.sx / 2 && Math.abs(p.z - s.cz) <= s.sz / 2 && s.sx > 0 && s.sz > 0;
            if (under) expect(p.y, `${a.key} over ${level}`).toBeGreaterThanOrEqual(s.cy + s.sy / 2);
          }
        }
        // And it is an arch: the middle is above the ends.
        const mid = a.pts[Math.floor(a.pts.length / 2)] as (typeof a.pts)[number];
        expect(mid.y).toBeGreaterThan((a.pts[0] as (typeof a.pts)[number]).y);
      }
    }
  });

  it("gives thicker arches to heavier links (square root, clamped)", () => {
    const { city } = get("files");
    const heavy = city.arches.reduce((a, b) => (b.weight > a.weight ? b : a));
    const light = city.arches.reduce((a, b) => (b.weight < a.weight ? b : a));
    expect(heavy.radius).toBeGreaterThan(light.radius);
    expect(heavy.radius / light.radius).toBeLessThan(5);
  });

  it("has a pill spot on every arch, nearest the source third first", () => {
    const { city } = get("files");
    for (const a of city.arches) {
      expect(a.pillAt.length).toBeGreaterThan(3);
      expect(a.pillAt[0]).toBe(Math.round(0.3 * (a.pts.length - 1)));
    }
  });

  it("finds the ranked files as buildings", () => {
    const { city, nodes } = get("files");
    const ranked = rankFiles(nodes.nodes, { hideTests: true, limit: 15 });
    expect(ranked).toHaveLength(15);
    for (const r of ranked) expect(city.byId.get(r.id)?.type, r.id).toBe("building");
  });
});

describe("height grid", () => {
  it("returns the highest top within a radius", () => {
    const g = new HeightGrid(-50, -50, 100, 100, 2);
    g.add({ cx: 10, cy: 10, cz: 10, sx: 10, sy: 20, sz: 10 });
    expect(g.at(10, 10)).toBe(20);
    expect(g.at(40, 40)).toBe(0);
    expect(g.at(20, 10, 6)).toBe(20);
  });
});

describe("flags", () => {
  it("never overlap, none is dropped, all stay inside the canvas, even when the buildings crowd together", () => {
    const anchors = Array.from({ length: 15 }, (_, i) => ({
      id: String(i + 1),
      x: 300 + (i % 3) * 4,
      y: 300 + (i % 4) * 3,
    }));
    const placed = placeFlags(anchors, { w: 800, h: 600 });
    expect(placed.map((p) => p.id)).toEqual(anchors.map((a) => a.id));
    for (const [i, p] of placed.entries()) {
      expect(p.x).toBeGreaterThanOrEqual(FLAG_R);
      expect(p.x).toBeLessThanOrEqual(800 - FLAG_R);
      expect(p.y).toBeGreaterThanOrEqual(FLAG_R);
      for (const q of placed.slice(i + 1))
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(2 * FLAG_R);
    }
  });
  it("keeps flags off the given obstacles", () => {
    const avoid = [{ l: 280, t: 250, r: 420, b: 290 }];
    const placed = placeFlags([{ id: "1", x: 340, y: 290 }], { w: 800, h: 600 }, avoid);
    const p = placed[0] as (typeof placed)[number];
    const hit = p.x + FLAG_R > 280 && p.x - FLAG_R < 420 && p.y + FLAG_R > 250 && p.y - FLAG_R < 290;
    expect(hit).toBe(false);
  });
});

describe("screen geometry helpers", () => {
  it("tests a convex polygon against a rectangle", () => {
    const quad: [number, number][] = [
      [0, 0],
      [100, 20],
      [90, 80],
      [-10, 60],
    ];
    expect(quadHitsRect(quad, { l: 40, t: 30, r: 60, b: 50 })).toBe(true);
    expect(quadHitsRect(quad, { l: 200, t: 30, r: 220, b: 50 })).toBe(false);
    // Inside the bounding box of the quad but outside the quad itself.
    expect(quadHitsRect(quad, { l: 95, t: 70, r: 99, b: 78 })).toBe(false);
  });
  it("builds a convex hull and checks containment", () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ]);
    expect(hull).toHaveLength(4);
    expect(rectInsideHull(hull, { l: 1, t: 1, r: 9, b: 9 })).toBe(true);
    expect(rectInsideHull(hull, { l: 1, t: 1, r: 11, b: 9 })).toBe(false);
  });
});

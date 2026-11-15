import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../../mock/largeMap.ts";
import type { ViewData } from "../../api.ts";
import { buildScene } from "../../canvas/scene.ts";
import { dashesOf } from "./kit.ts";
import { archetypeFor, buildLandscape, districtKeys } from "./model.ts";
import { makePath, type Pt, sampleAt, segPoint } from "./path.ts";
import { placeSettlements } from "./placement.ts";
import { planSettlement } from "./plan.ts";
import { buildRoads, classify, routeAround } from "./roads.ts";
import { roleOf } from "./roles.ts";
import { assignTiers } from "./tiers.ts";
import { planTraffic, vehicleAt, vehicleCount } from "./traffic.ts";

function large(): ViewData {
  return projectMapLarge({ focus: null, level: "files", options: {} }) as ViewData;
}

describe("tiers", () => {
  it("spreads the mock large repo over all four tiers", () => {
    const fns = new Map([
      ["api", 1700],
      ["web", 986],
      ["core", 964],
      ["types", 32],
      ["logger", 24],
      ["config", 18],
      ["root", 17],
      ["ui", 12],
      ["db", 9],
      ["testing", 6],
      ["scripts", 1],
    ]);
    const t = assignTiers(fns);
    expect(t.get("api")).toBe("metropolis");
    expect(t.get("web")).toBe("city");
    expect(t.get("core")).toBe("city");
    expect(t.get("types")).toBe("town");
    expect(t.get("logger")).toBe("town");
    expect(t.get("config")).toBe("village");
    expect(t.get("scripts")).toBe("village");
  });

  it("keeps a tiny workspace a village whatever its rank, and never demotes a giant", () => {
    expect(assignTiers(new Map([["only", 5]])).get("only")).toBe("village");
    expect(
      assignTiers(
        new Map([
          ["a", 3],
          ["b", 9],
        ]),
      ).get("b"),
    ).toBe("village");
    const twins = assignTiers(
      new Map([
        ["a", 3000],
        ["b", 3000],
        ["c", 4],
      ]),
    );
    expect(twins.get("a")).toBe("metropolis");
    expect(twins.get("b")).toBe("metropolis");
    expect(assignTiers(new Map([["solo", 700]])).get("solo")).toBe("metropolis");
    expect(assignTiers(new Map([["solo", 200]])).get("solo")).toBe("city");
  });
});

describe("roles and building types", () => {
  it("reads a file's role from its path", () => {
    expect(roleOf("apps/web/src/components/Button.tsx")).toBe("component");
    expect(roleOf("apps/api/src/routes/users.ts")).toBe("route");
    expect(roleOf("packages/core/src/a.test.ts")).toBe("test");
    expect(roleOf("vite.config.ts")).toBe("config");
    expect(roleOf("packages/core/src/index.ts")).toBe("entry");
    expect(roleOf("packages/core/src/billing/invoice.ts")).toBe("code");
  });

  it("gives every tier its own houses", () => {
    expect(archetypeFor("village", "code", 0.5)).toBe("cottage");
    expect(archetypeFor("town", "code", 0.5)).toBe("house");
    expect(archetypeFor("city", "code", 0.5)).toBe("block");
    expect(archetypeFor("metropolis", "code", 0.9)).toBe("tower");
    expect(archetypeFor("metropolis", "code", 0.05)).toBe("house");
    expect(archetypeFor("town", "route", 0.5)).toBe("hall");
    expect(archetypeFor("city", "config", 0.5)).toBe("tank");
  });

  it("names districts by the first folder below what all files share", () => {
    expect(districtKeys(["src/a", "src/b/c", "src/a"])).toEqual(["src/a", "src/b", "src/a"]);
    expect(districtKeys(["src", "src"])).toEqual(["src", "src"]);
    expect(districtKeys(["", "lib"])).toEqual([".", "lib"]);
  });
});

describe("settlement plan", () => {
  const lots = Array.from({ length: 60 }, (_, i) => ({
    id: `f${i}`,
    district: `d${i % 4}`,
    side: 1 + (i % 7) * 0.2,
  }));

  it("places every lot once, without overlaps, and is deterministic", () => {
    const a = planSettlement(lots, "city", "ws:x");
    const b = planSettlement(lots, "city", "ws:x");
    expect(a).toEqual(b);
    expect(a.lots).toHaveLength(60);
    expect(new Set(a.lots.map((l) => l.id)).size).toBe(60);
    for (let i = 0; i < a.lots.length; i++)
      for (let j = i + 1; j < a.lots.length; j++) {
        const p = a.lots[i] as (typeof a.lots)[number];
        const q = a.lots[j] as (typeof a.lots)[number];
        // Footprints are squares of `side`, rotated: their inscribed circles never overlap.
        expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThan(
          (p.side + q.side) / 2 - 1e-6 - (p.side + q.side) * 0.3,
        );
      }
    for (const l of a.lots) expect(Math.hypot(l.x, l.z)).toBeLessThanOrEqual(a.built + 1e-6);
  });

  it("keeps each district inside its own wedge", () => {
    const p = planSettlement(lots, "metropolis", "ws:y");
    for (const l of p.lots) {
      const d = p.districts.find((x) => x.id === l.district);
      if (!d) throw new Error("no district");
      let ang = Math.atan2(l.z, l.x);
      while (ang < d.a0) ang += Math.PI * 2;
      expect(ang).toBeLessThanOrEqual(d.a1 + 1e-6);
    }
  });

  it("puts the biggest files in the inner rings", () => {
    const p = planSettlement(lots, "metropolis", "ws:z");
    const inner = p.lots.filter((l) => l.ring === 0).map((l) => l.side);
    const outer = p.lots.filter((l) => l.ring === Math.max(...p.lots.map((x) => x.ring))).map((l) => l.side);
    expect(Math.min(...inner)).toBeGreaterThanOrEqual(Math.max(...outer));
  });
});

describe("placement and roads", () => {
  const sites = [
    { id: "a", radius: 20 },
    { id: "b", radius: 12 },
    { id: "c", radius: 6 },
    { id: "d", radius: 4 },
  ];
  const links = [
    { a: "a", b: "b", weight: 300 },
    { a: "b", b: "c", weight: 5 },
    { a: "a", b: "d", weight: 1 },
  ];

  it("keeps plates apart and is deterministic", () => {
    const p = placeSettlements(sites, links);
    expect(placeSettlements(sites, links)).toEqual(p);
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) {
        const s = p[i] as (typeof p)[number];
        const t = p[j] as (typeof p)[number];
        expect(Math.hypot(s.x - t.x, s.z - t.z)).toBeGreaterThan(s.radius + t.radius);
      }
  });

  it("classes roads by import count", () => {
    expect(classify(640, 640)).toBe("highway");
    expect(classify(150, 640)).toBe("road");
    expect(classify(3, 640)).toBe("lane");
    expect(classify(30, 30)).toBe("road");
  });

  it("routes a road round a settlement standing in its way", () => {
    const blocker = { id: "m", x: 0, z: 0, gate: 4, clear: 5 };
    const path = routeAround(
      [
        [-20, 0.5],
        [20, 0.5],
      ],
      [blocker],
      new Set(),
    );
    for (let i = 0; i < path.length - 1; i++)
      expect(segPoint([0, 0], path[i] as Pt, path[i + 1] as Pt).d).toBeGreaterThanOrEqual(5);
  });

  it("merges both directions of a pair into one road with one flow each, importer first", () => {
    const s = [
      { id: "a", x: -30, z: 0, gate: 5, clear: 6 },
      { id: "b", x: 30, z: 0, gate: 5, clear: 6 },
      { id: "m", x: 0, z: 1, gate: 4, clear: 8 },
    ];
    const roads = buildRoads(s, [
      { src: "a", dst: "b", weight: 100 },
      { src: "b", dst: "a", weight: 3 },
    ]);
    expect(roads).toHaveLength(1);
    const r = roads[0] as (typeof roads)[number];
    expect(r.weight).toBe(103);
    expect(r.flows.map((f) => [f.from, f.to, f.weight, f.forward])).toEqual([
      ["a", "b", 100, true],
      ["b", "a", 3, false],
    ]);
    // It starts at a's gate, ends at b's and keeps out of m.
    expect(Math.hypot((r.pts[0] as Pt)[0] + 30, (r.pts[0] as Pt)[1])).toBeCloseTo(5, 1);
    for (let i = 0; i < r.pts.length - 1; i++)
      expect(segPoint([0, 1], r.pts[i] as Pt, r.pts[i + 1] as Pt).d).toBeGreaterThan(8);
  });
});

describe("traffic", () => {
  it("gives a flow vehicles in proportion to its import count, at least one", () => {
    expect(vehicleCount(640, 640, 100, 1)).toBe(42);
    expect(vehicleCount(64, 640, 100, 1)).toBe(4);
    expect(vehicleCount(1, 640, 100, 1)).toBe(1);
  });

  it("drives from the importer to the imported settlement, on the right", () => {
    const s = [
      { id: "a", x: -30, z: 0, gate: 5, clear: 6 },
      { id: "b", x: 30, z: 0, gate: 5, clear: 6 },
    ];
    const roads = buildRoads(s, [{ src: "b", dst: "a", weight: 50 }]);
    const v = planTraffic(roads);
    expect(v.length).toBeGreaterThan(0);
    for (const car of v) {
      const p0 = vehicleAt(car, 0);
      // b is east, a is west: travel is westwards; right of a westbound driver is north (-z).
      expect(p0.dx).toBeLessThan(0);
      expect(p0.z).toBeLessThan(0.0001);
    }
  });

  it("samples a path by arc length and wraps", () => {
    const p = makePath([
      [0, 0],
      [10, 0],
    ]);
    expect(sampleAt(p, 5).x).toBeCloseTo(5);
    expect(sampleAt(p, 15).x).toBeCloseTo(5);
    expect(sampleAt(p, 5, 1).z).toBeCloseTo(1);
  });
});

describe("landscape from the mock large repo", () => {
  const view = large();
  const scene = buildScene(view.nodes, view.edges, "nested-elk");
  const land = buildLandscape(scene);

  it("is deterministic", () => {
    const again = buildLandscape(buildScene(large().nodes, large().edges, "nested-elk"));
    expect(again.buildings.map((b) => [b.id, b.x, b.z, b.h, b.arch])).toEqual(
      land.buildings.map((b) => [b.id, b.x, b.z, b.h, b.arch]),
    );
    expect(again.roads.map((r) => r.pts)).toEqual(land.roads.map((r) => r.pts));
  });

  it("draws one building per file and keeps the API's counts", () => {
    const files = view.nodes.filter((n) => n.kind === "file");
    expect(land.buildings).toHaveLength(files.length);
    for (const s of land.settlements) {
      const node = view.nodes.find((n) => n.id === s.id);
      expect(s.fns).toBe(node?.stats?.functions);
      expect(s.files).toBe(node?.stats?.files);
    }
    const api = view.edges.filter(
      (e) => e.kind === "imports" && e.src.startsWith("ws:") && e.dst.startsWith("ws:"),
    );
    for (const e of api) {
      const road = land.roads.find((r) => r.flows.some((f) => f.from === e.src && f.to === e.dst));
      expect(road?.flows.find((f) => f.from === e.src && f.to === e.dst)?.weight).toBe(e.weight);
    }
  });

  it("shows four tiers, a highway for the heaviest link, and roads that keep out of other settlements", () => {
    expect(new Set(land.settlements.map((s) => s.tier))).toEqual(
      new Set(["village", "town", "city", "metropolis"]),
    );
    expect(land.roads[0]?.cls).toBe("highway");
    for (const r of land.roads)
      for (const s of land.settlements) {
        if (s.id === r.a || s.id === r.b) continue;
        for (let i = 0; i < r.pts.length - 1; i++)
          expect(segPoint([s.x, s.z], r.pts[i] as Pt, r.pts[i + 1] as Pt).d).toBeGreaterThan(s.clear * 0.97);
      }
  });

  it("varies the buildings inside a settlement", () => {
    for (const s of land.settlements.filter((x) => x.buildings.length > 30)) {
      const archs = new Set(s.buildings.map((i) => land.buildings[i]?.arch));
      expect(archs.size).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("review arcs (#173)", () => {
  it("a potential arc is cut into dashes along the curve, with gaps between them", () => {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(5, 6, 0),
      new THREE.Vector3(10, 1, 0),
    );
    const len = curve.getLength();
    const pieces = dashesOf(curve, 0.9, 0.55);
    expect(pieces.length).toBe(Math.floor((len + 0.55) / 1.45));
    let drawn = 0;
    for (const p of pieces) drawn += p.getLength();
    // About dash / (dash + gap) of the arc is drawn: the rest is gaps.
    expect(drawn / len).toBeGreaterThan(0.5);
    expect(drawn / len).toBeLessThan(0.75);
    expect(pieces[0]?.getPoint(0).distanceTo(curve.getPoint(0))).toBeLessThan(1e-6);
    // A very short arc still shows as one piece.
    const short = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.3, 0, 0));
    expect(dashesOf(short, 0.9, 0.55)).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import {
  ALL_PILLS,
  arcWidthPx,
  arrowSpreadAngle,
  bestViewDir,
  computeLayout,
  folderCaption,
  folderKey,
  islandGap,
  islandHash,
  islandLabelPx,
  islandRadius,
  nodeRadius,
  packCircles,
  packFolders,
  pillArcIds,
  positionHash,
  spreadAngles,
  stripSharedSrc,
  summarizeIslands,
  sunflower,
  TOP_PILLS,
  viewBasis,
} from "./layout.ts";

const files = map3dView("files");

describe("3D layout", () => {
  it("is deterministic: two computations give the same position hash and values", () => {
    const a = computeLayout(files);
    const b = computeLayout(map3dView("files"));
    expect(positionHash(a)).toBe(positionHash(b));
    expect(positionHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect([...a.positions]).toEqual([...b.positions]);
    expect(a.arcs).toEqual(b.arcs);
  });

  it("does not depend on input order", () => {
    const shuffled = { nodes: [...files.nodes].reverse(), edges: [...files.edges].reverse() };
    expect(positionHash(computeLayout(shuffled))).toBe(positionHash(computeLayout(files)));
  });

  it("changes when the data changes", () => {
    const fewer = { nodes: files.nodes.filter((n) => !n.id.includes("/button.")), edges: files.edges };
    expect(positionHash(computeLayout(fewer))).not.toBe(positionHash(computeLayout(files)));
  });

  for (const level of ["workspaces", "dirs", "files"]) {
    it(`keeps islands apart and nodes inside their island at level=${level}`, () => {
      const layout = computeLayout(map3dView(level));
      expect(layout.islands.length).toBe(5);
      for (const [i, a] of layout.islands.entries()) {
        for (const b of layout.islands.slice(i + 1)) {
          const d = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
          expect(d).toBeGreaterThan(a.radius + b.radius);
        }
        for (const id of a.nodeIds) {
          const p = layout.positions.get(id);
          const r = layout.nodeRadius.get(id) ?? 0;
          expect(p).toBeDefined();
          if (!p) continue;
          const d = Math.hypot(p.x - a.center.x, p.y - a.center.y, p.z - a.center.z);
          expect(d + r).toBeLessThanOrEqual(a.radius + 1e-6);
        }
      }
    });
  }

  it("bundles cross-island imports into one arc per ordered workspace pair, weighted by total imports", () => {
    const layout = computeLayout(files);
    const ids = layout.arcs.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const total = files.edges
      .filter((e) => {
        const ws = (id: string) => files.nodes.find((n) => n.id === id)?.parent;
        return ws(e.src) !== ws(e.dst);
      })
      .reduce((a, e) => a + e.weight, 0);
    expect(layout.arcs.reduce((a, x) => a + x.weight, 0)).toBe(total);
  });

  it("labels arcs with imports (weight) and carries the imported-name total as bindings only when it differs", () => {
    const n = (id: string, parent?: string) => ({
      id,
      kind: parent ? "file" : "workspace",
      label: id,
      size: 3,
      parent,
    });
    const e = (id: string, src: string, dst: string, bindings?: number) => ({
      id,
      src,
      dst,
      kind: "imports",
      weight: 1,
      confidence: "high" as const,
      ...(bindings === undefined ? {} : { bindings }),
    });
    const layout = computeLayout({
      nodes: [n("ws:a"), n("ws:b"), n("f1", "ws:a"), n("f2", "ws:a"), n("g1", "ws:b")],
      edges: [e("1", "f1", "g1", 4), e("2", "f2", "g1")],
    });
    const arc = layout.arcs.find((a) => a.src === "ws:a" && a.dst === "ws:b");
    expect(arc?.weight).toBe(2);
    expect(arc?.bindings).toBe(5);
  });

  it("sizes nodes with a clamped sqrt scale", () => {
    expect(nodeRadius(0, "file")).toBeLessThan(nodeRadius(4, "file"));
    expect(nodeRadius(4, "file")).toBeLessThan(nodeRadius(100, "file"));
    expect(nodeRadius(1e9, "file")).toBe(12);
    expect(nodeRadius(0, "file")).toBeGreaterThan(0);
  });

  it("summarizes islands in colour order for the legend", () => {
    const s = summarizeIslands(files.nodes);
    expect(s.map((i) => i.label)).toEqual(["api", "db", "ui", "utils", "web"]);
    expect(s.map((i) => i.fullLabel)).toEqual([
      "@acme/api",
      "@acme/db",
      "@acme/ui",
      "@acme/utils",
      "@acme/web",
    ]);
    expect(s.find((i) => i.label === "web")?.wsKind).toBe("app");
    expect(s.every((i, k) => i.index === k && i.files > 0 && i.functions > 0)).toBe(true);
  });
});

/** Spheres must be at least r1 + r2 + gap apart; checked for every pair. */
function expectNoIslandOverlap(layout: ReturnType<typeof computeLayout>): void {
  for (const [i, a] of layout.islands.entries()) {
    for (const b of layout.islands.slice(i + 1)) {
      const d = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
      expect(d, `${a.label} vs ${b.label}`).toBeGreaterThanOrEqual(
        a.radius + b.radius + islandGap(a.radius, b.radius) - 1e-6,
      );
    }
  }
}

describe("3D layout of a large monorepo (3 huge workspaces, 8 tiny)", () => {
  const fns = [1700, 980, 960, 32, 25, 18, 12, 9, 6, 3, 1];
  const nodes = fns.map((f, i) => ({
    id: `ws:ws${i}`,
    kind: "workspace",
    label: `@some-long-org-scope/ws${i}`,
    shortLabel: `ws${i}`,
    size: f,
    badges: ["package", "4 files", `${f} functions`],
  }));
  const edges = [] as {
    id: string;
    src: string;
    dst: string;
    kind: string;
    weight: number;
    confidence: "high";
  }[];
  for (let i = 0; i < nodes.length; i++) {
    for (const j of [0, 1, 2, 3]) {
      if (i === j) continue;
      edges.push({
        id: `${i}>${j}`,
        src: `ws:ws${i}`,
        dst: `ws:ws${j}`,
        kind: "imports",
        weight: 1 + ((i * 7 + j * 3) % 9),
        confidence: "high",
      });
    }
  }

  it("keeps every pair of island spheres at least r1 + r2 + gap apart", () => {
    const layout = computeLayout({ nodes, edges });
    expect(layout.islands).toHaveLength(11);
    expectNoIslandOverlap(layout);
  });

  it("is order independent and deterministic", () => {
    const a = computeLayout({ nodes, edges });
    const b = computeLayout({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    expect(positionHash(a)).toBe(positionHash(b));
  });

  it("sizes islands by sqrt of function count with a floor, big ones in the middle of the map", () => {
    const layout = computeLayout({ nodes, edges });
    const byFns = [...layout.islands].sort((a, b) => b.functions - a.functions);
    const r = byFns.map((i) => i.radius);
    expect(r[0]).toBeGreaterThan(r[3] as number);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(8);
    const dist = (i: (typeof layout.islands)[number]) => Math.hypot(i.center.x, i.center.y, i.center.z);
    const bigMean = byFns.slice(0, 3).reduce((a, i) => a + dist(i), 0) / 3;
    const tinyMean = byFns.slice(3).reduce((a, i) => a + dist(i), 0) / 8;
    // Small islands are satellites around the big ones, which sit near the mass centre.
    expect(bigMean).toBeLessThan(tinyMean);
  });

  it("holds the invariant on the mock large scenario at every level", () => {
    for (const level of ["workspaces", "dirs", "files"]) {
      const layout = computeLayout(
        map3dView({ focus: null, level: level as "dirs", hops: null, options: { scenario: "large" } }),
      );
      expect(layout.islands).toHaveLength(11);
      expectNoIslandOverlap(layout);
    }
  });

  it("scales label size with importance and arc width with sqrt(weight), both clamped", () => {
    expect(islandLabelPx(1700)).toBeGreaterThan(islandLabelPx(30));
    expect(islandLabelPx(30)).toBeGreaterThan(islandLabelPx(1) - 1e-9);
    expect(islandLabelPx(1e9)).toBe(30);
    expect(islandLabelPx(0)).toBe(12);
    expect(arcWidthPx(1)).toBeLessThan(arcWidthPx(100));
    expect(arcWidthPx(1e9)).toBe(6);
  });
});

const large = (level: string) =>
  computeLayout(
    map3dView({ focus: null, level: level as "dirs", hops: null, options: { scenario: "large" } }),
  );

describe("one picture at every level", () => {
  it("island centres, radii and the default camera are identical at Workspaces, Folders and Files", () => {
    const ws = large("workspaces");
    for (const level of ["dirs", "files"]) {
      const other = large(level);
      expect(other.islands.map((i) => i.id)).toEqual(ws.islands.map((i) => i.id));
      for (const [k, a] of ws.islands.entries()) {
        const b = other.islands[k] as typeof a;
        expect(b.center).toEqual(a.center);
        expect(b.radius).toBe(a.radius);
        expect(b.functions).toBe(a.functions);
      }
      expect(other.viewDir).toEqual(ws.viewDir);
      expect(other.extent).toBe(ws.extent);
      expect(islandHash(other)).toBe(islandHash(ws));
    }
  });

  it("island radius follows the workspace function count alone", () => {
    const ws = large("workspaces");
    for (const i of ws.islands) expect(i.radius).toBeCloseTo(islandRadius(i.functions), 9);
  });

  it("keeps every drawn node inside its island at every level", () => {
    for (const level of ["workspaces", "dirs", "files"]) {
      const l = large(level);
      for (const i of l.islands) {
        for (const id of i.nodeIds) {
          const p = l.positions.get(id) as { x: number; y: number; z: number };
          const d = Math.hypot(p.x - i.center.x, p.y - i.center.y, p.z - i.center.z);
          expect(d + (l.nodeRadius.get(id) ?? 0)).toBeLessThanOrEqual(i.radius + 1e-6);
        }
      }
    }
  });
});

describe("default camera and plane", () => {
  const l = large("workspaces");
  const project = (dir: { x: number; y: number; z: number }) => {
    const n = Math.hypot(dir.x, dir.y, dir.z);
    const d = { x: dir.x / n, y: dir.y / n, z: dir.z / n };
    // right = up x d (world up = +y), up' = d x right
    const rx = d.z;
    const rz = -d.x;
    const rl = Math.hypot(rx, rz) || 1;
    const right = { x: rx / rl, y: 0, z: rz / rl };
    const up = {
      x: d.y * right.z - d.z * right.y,
      y: d.z * right.x - d.x * right.z,
      z: d.x * right.y - d.y * right.x,
    };
    return l.islands.map((i) => ({
      x: i.center.x * right.x + i.center.y * right.y + i.center.z * right.z,
      y: i.center.x * up.x + i.center.y * up.y + i.center.z * up.z,
      r: i.radius,
    }));
  };
  const overlap = (dir: { x: number; y: number; z: number }): number => {
    const pts = project(dir);
    let o = 0;
    for (const [i, a] of pts.entries()) {
      for (const b of pts.slice(i + 1)) o += Math.max(0, a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y));
    }
    return o;
  };

  it("no two island discs overlap on screen from the default direction", () => {
    expect(overlap(l.viewDir)).toBe(0);
  });

  it("is tilted for depth but still faces the plane of islands", () => {
    expect(l.viewDir.z).toBeLessThan(0.99);
    expect(l.viewDir.z).toBeGreaterThan(0.6);
  });

  it("is deterministic for the same islands", () => {
    expect(bestViewDir(l.islands)).toEqual(bestViewDir(l.islands));
  });

  it("lays islands out in a shallow dome: depth is a small fraction of the width", () => {
    const zs = l.islands.map((i) => i.center.z);
    const xs = l.islands.map((i) => i.center.x);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.25 * (Math.max(...xs) - Math.min(...xs)));
  });

  it("separates small islands from each other by at least the required gap", () => {
    const small = l.islands.filter((i) => i.radius < 20);
    expect(small.length).toBeGreaterThanOrEqual(6);
    for (const [k, a] of small.entries()) {
      for (const b of small.slice(k + 1)) {
        const d = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
        expect(d - a.radius - b.radius).toBeGreaterThanOrEqual(islandGap(a.radius, b.radius) - 1e-6);
        expect(d).toBeGreaterThan(1.8 * (a.radius + b.radius));
      }
    }
  });
});

describe("folders in the Files level", () => {
  const files = large("files");

  it("groups file nodes by folder: one cluster per folder, every file in exactly one", () => {
    const api = files.islands.find((i) => i.label === "api");
    expect(api).toBeDefined();
    const cs = files.clusters.filter((c) => c.island === api?.id);
    expect(cs.map((c) => c.key).sort()).toEqual(
      [
        "src/graphql",
        "src/jobs",
        "src/lib",
        "src/middleware",
        "src/models",
        "src/routes",
        "src/services",
      ].sort(),
    );
    const seen = cs.flatMap((c) => c.nodeIds);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(api?.nodeIds.length);
    expect(cs.reduce((a, c) => a + c.functions, 0)).toBe(api?.functions);
    expect(cs.map((c) => c.rank)).toEqual(cs.map((_, k) => k));
    for (let k = 1; k < cs.length; k++) {
      expect((cs[k - 1] as (typeof cs)[number]).functions).toBeGreaterThanOrEqual(
        (cs[k] as (typeof cs)[number]).functions,
      );
    }
  });

  it("keeps folder clusters apart", () => {
    const api = files.islands.find((i) => i.label === "api");
    const cs = files.clusters.filter((c) => c.island === api?.id);
    for (const [k, a] of cs.entries()) {
      for (const b of cs.slice(k + 1)) {
        const d = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
        expect(d).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6);
      }
    }
  });

  it("derives folder keys from the path relative to the workspace", () => {
    const node = (path: string, kind = "file") => ({ id: `file:${path}`, kind, label: "x", size: 1, path });
    expect(folderKey(node("apps/web/src/components/button.ts"), "apps/web")).toBe("src/components");
    expect(folderKey(node("apps/web/src/a/b/c/deep.ts"), "apps/web")).toBe("src/a");
    expect(folderKey(node("apps/web/index.ts"), "apps/web")).toBe(".");
    expect(folderKey(node("apps/web/src/lib", "folded"), "apps/web")).toBe("src/lib");
    expect(folderKey(node("apps/web", "folded"), "apps/web")).toBe(".");
  });

  it("drops a leading src/ only when every labelled folder shares it", () => {
    expect(stripSharedSrc(["src/routes", "src/lib"])).toEqual(["routes", "lib"]);
    expect(stripSharedSrc(["src/routes", "scripts"])).toEqual(["src/routes", "scripts"]);
    expect(stripSharedSrc(["src", "src/lib"])).toEqual(["src", "src/lib"]);
    expect(stripSharedSrc([])).toEqual([]);
  });

  it("captions a folder with its function count", () => {
    expect(folderCaption("components", 855)).toBe("components · 855 fn");
    expect(folderCaption("lib", 1234)).toBe("lib · 1,234 fn");
  });
});

describe("arrow data", () => {
  it("arcs run from the importing workspace to the imported one and end just outside the target island", () => {
    const l = large("dirs");
    const web = l.islands.find((i) => i.label === "web");
    const core = l.islands.find((i) => i.label === "core");
    const arc = l.arcs.find((a) => a.src === web?.id && a.dst === core?.id);
    expect(arc).toBeDefined();
    if (!arc || !core) return;
    const d = Math.hypot(arc.p2.x - core.center.x, arc.p2.y - core.center.y, arc.p2.z - core.center.z);
    expect(d).toBeGreaterThan(core.radius);
    expect(d).toBeLessThan(core.radius + 4);
  });
});

describe("circle packing", () => {
  const items = [90, 60, 44, 30, 22, 14, 9, 5, 5, 2].map((f, i) => ({ id: `f${i}`, r: Math.sqrt(f) }));

  it("never overlaps, keeps the padding, and is deterministic", () => {
    const a = packCircles(items, 0.3);
    const b = packCircles([...items].reverse(), 0.3);
    expect(a.circles).toEqual(b.circles);
    for (const [i, p] of a.circles.entries()) {
      for (const q of a.circles.slice(i + 1)) {
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r + 0.3 - 1e-6);
      }
      expect(Math.hypot(p.x, p.y) + p.r).toBeLessThanOrEqual(a.radius + 1e-6);
    }
  });

  it("scales folders to fit the island: radius ~ sqrt(functions), inside, no overlap", () => {
    const folders = [820, 400, 255, 120, 64, 33, 12, 3].map((f, i) => ({ key: `src/d${i}`, functions: f }));
    const { circles } = packFolders(folders, 100);
    const again = packFolders([...folders].reverse(), 100).circles;
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1);
    expect([...circles].sort(byId)).toEqual([...again].sort(byId));
    for (const [i, p] of circles.entries()) {
      expect(Math.hypot(p.x, p.y) + p.r).toBeLessThanOrEqual(100 + 1e-6);
      for (const q of circles.slice(i + 1)) {
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r);
      }
    }
    // Radius follows sqrt(functions) for every folder above the floor.
    const byKey = new Map(circles.map((c) => [c.id, c]));
    const ratio = (key: string, fns: number) => (byKey.get(key)?.r ?? 0) / Math.sqrt(fns);
    expect(ratio("src/d1", 400)).toBeCloseTo(ratio("src/d0", 820), 6);
    expect(ratio("src/d4", 64)).toBeCloseTo(ratio("src/d0", 820), 6);
  });

  it("packs a single folder in the middle", () => {
    const one = packFolders([{ key: "a", functions: 5 }], 50);
    expect(one.circles).toHaveLength(1);
    expect(one.circles[0]?.r).toBeCloseTo(50, 6);
  });
});

describe("files as a sunflower inside a folder ring", () => {
  const files = [41, 30, 22, 17, 9, 9, 5, 3, 2, 1, 1, 1].map((f, i) => ({ id: `file${i}`, functions: f }));

  it("puts the biggest file in the middle, keeps every dot inside the ring and clear of its neighbours", () => {
    const dots = sunflower(files, 60);
    expect(dots[0]).toMatchObject({ id: "file0", x: 0, y: 0 });
    for (const [i, p] of dots.entries()) {
      expect(Math.hypot(p.x, p.y) + p.r).toBeLessThanOrEqual(60);
      for (const q of dots.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r);
    }
    expect((dots[0]?.r ?? 0) >= (dots[5]?.r ?? 0)).toBe(true);
    expect(sunflower([...files].reverse(), 60)).toEqual(dots);
  });

  it("handles a folder with one file", () => {
    expect(sunflower([{ id: "only", functions: 4 }], 40)).toEqual([{ id: "only", x: 0, y: 0, r: 20 }]);
  });
});

type P3 = { x: number; y: number; z: number };

describe("folder discs in the large mock", () => {
  const dirs = large("dirs");
  const files = large("files");

  it("sit on a flat disc facing the default camera, inside the island, without overlap, at both levels", () => {
    for (const l of [dirs, files]) {
      for (const isl of l.islands) {
        const cs = l.clusters.filter((c) => c.island === isl.id);
        for (const [i, a] of cs.entries()) {
          const off = {
            x: a.center.x - isl.center.x,
            y: a.center.y - isl.center.y,
            z: a.center.z - isl.center.z,
          };
          expect(off.x * l.viewDir.x + off.y * l.viewDir.y + off.z * l.viewDir.z).toBeCloseTo(0, 6);
          expect(Math.hypot(off.x, off.y, off.z) + a.radius).toBeLessThanOrEqual(isl.radius + 1e-6);
          for (const b of cs.slice(i + 1)) {
            const d = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
            expect(d, `${isl.label}: ${a.key} / ${b.key}`).toBeGreaterThan(a.radius + b.radius);
          }
        }
      }
    }
  });

  it("puts every folder in the same place at the Folders and the Files level", () => {
    expect(dirs.clusters.length).toBeGreaterThanOrEqual(18);
    for (const c of dirs.clusters) {
      const same = files.clusters.find((d) => d.id === c.id);
      expect(same, c.id).toBeDefined();
      expect(same?.center).toEqual(c.center);
      expect(same?.radius).toBeCloseTo(c.radius, 9);
      expect(same?.functions).toBe(c.functions);
    }
  });

  it("does not draw folders without functions; they are only counted as empty", () => {
    const api = dirs.islands.find((i) => i.label === "api");
    expect(api?.emptyFolders).toBe(1);
    const apiClusters = dirs.clusters.filter((c) => c.island === api?.id);
    expect(apiClusters.some((c) => c.key === ".")).toBe(false);
    expect(files.clusters.filter((c) => c.island === api?.id).some((c) => c.key === ".")).toBe(false);
    for (const l of [dirs, files]) for (const c of l.clusters) expect(c.functions).toBeGreaterThan(0);
    expect(api?.nodeIds.some((id) => id.endsWith(":."))).toBe(false);
    expect(api?.nodeIds).toHaveLength(7);
  });

  it("keeps file dots inside their folder ring and clear of each other", () => {
    for (const c of files.clusters) {
      const dots = c.nodeIds.map((id) => ({
        p: files.positions.get(id) as P3,
        r: files.nodeRadius.get(id) as number,
      }));
      for (const [i, a] of dots.entries()) {
        const fromCentre = Math.hypot(a.p.x - c.center.x, a.p.y - c.center.y, a.p.z - c.center.z);
        expect(fromCentre + a.r).toBeLessThanOrEqual(c.radius + 1e-6);
        for (const b of dots.slice(i + 1)) {
          expect(Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z)).toBeGreaterThan(a.r + b.r - 1e-6);
        }
      }
    }
  });

  it("is deterministic across loads", () => {
    expect(positionHash(large("files"))).toBe(positionHash(files));
    expect(files.clusters).toEqual(large("files").clusters);
  });
});

describe("arcs", () => {
  const l = large("workspaces");
  const id = (short: string) => l.islands.find((i) => i.label === short)?.id as string;
  const { right, up } = viewBasis(l.viewDir);
  const to2 = (p: P3) => ({
    x: p.x * right.x + p.y * right.y + p.z * right.z,
    y: p.x * up.x + p.y * up.y + p.z * up.z,
  });

  it("draws the two opposite links between a pair as two separate arcs, bowed to opposite sides", () => {
    const ab = l.arcs.find((a) => a.src === id("api") && a.dst === id("core"));
    const ba = l.arcs.find((a) => a.src === id("core") && a.dst === id("api"));
    expect(ab?.weight).toBe(267);
    expect(ba?.weight).toBe(3);
    if (!ab || !ba) return;
    expect(ab.reciprocal && ba.reciprocal).toBe(true);
    // The peak of each bow (t = 0.5), seen from the default camera: opposite sides of the straight chord.
    const peak = (a: typeof ab) => {
      const q = (k: "x" | "y" | "z") => 0.25 * a.p0[k] + 0.5 * a.p1[k] + 0.25 * a.p2[k];
      return to2({ x: q("x"), y: q("y"), z: q("z") });
    };
    const a = to2(l.islands.find((i) => i.id === id("api"))?.center as P3);
    const b = to2(l.islands.find((i) => i.id === id("core"))?.center as P3);
    const side = (p: { x: number; y: number }) =>
      Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    expect(side(peak(ab)) * side(peak(ba))).toBe(-1);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    expect(Math.hypot(peak(ab).x - peak(ba).x, peak(ab).y - peak(ba).y)).toBeGreaterThan(0.2 * chord);
  });

  it("gives every arc its own end point on the rim of an island: arrowheads at least 12px apart", () => {
    const pxPerUnit = 330 / l.extent;
    for (const isl of l.islands) {
      const ends = l.arcs
        .filter((a) => !a.dependsOnly && (a.src === isl.id || a.dst === isl.id))
        .map((a) => (a.dst === isl.id ? a.p2 : a.p0));
      const angles = ends.map((p) => {
        const d = to2({ x: p.x - isl.center.x, y: p.y - isl.center.y, z: p.z - isl.center.z });
        return Math.atan2(d.y, d.x);
      });
      const need = Math.min(arrowSpreadAngle(isl.radius, l.extent), (Math.PI * 2) / Math.max(1, ends.length));
      for (const [i, p] of angles.entries()) {
        for (const q of angles.slice(i + 1)) {
          let diff = Math.abs(p - q) % (Math.PI * 2);
          diff = Math.min(diff, Math.PI * 2 - diff);
          expect(diff, isl.label).toBeGreaterThanOrEqual(need - 1e-6);
        }
      }
      // And in pixels (estimated at the default camera) the nearest two are about 12px or more apart.
      if (ends.length >= 2) {
        const min = Math.min(
          ...angles.flatMap((p, i) =>
            angles.slice(i + 1).map((q) => {
              const d = Math.abs(p - q) % (Math.PI * 2);
              return Math.min(d, Math.PI * 2 - d);
            }),
          ),
        );
        const px = 2 * isl.radius * Math.sin(min / 2) * pxPerUnit;
        const ring = 2 * Math.PI * isl.radius * pxPerUnit;
        expect(px, isl.label).toBeGreaterThanOrEqual(Math.min(12, ring / ends.length / 1.3));
      }
    }
  });

  it("spreads angles on a circle without moving well-spaced ones", () => {
    const out = spreadAngles(
      [
        { key: "a", angle: 1 },
        { key: "b", angle: 1.05 },
        { key: "c", angle: 4 },
      ],
      0.5,
    );
    expect(Math.abs((out.get("a") as number) - (out.get("b") as number))).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(out.get("c")).toBeCloseTo(4, 9);
  });

  it("raises arcs so they stay out of the middle of the islands between their ends", () => {
    let through = 0;
    for (const a of l.arcs.filter((x) => !x.dependsOnly)) {
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        const u = 1 - t;
        const pt = to2({
          x: u * u * a.p0.x + 2 * u * t * a.p1.x + t * t * a.p2.x,
          y: u * u * a.p0.y + 2 * u * t * a.p1.y + t * t * a.p2.y,
          z: u * u * a.p0.z + 2 * u * t * a.p1.z + t * t * a.p2.z,
        });
        for (const isl of l.islands) {
          if (isl.id === a.src || isl.id === a.dst) continue;
          const c = to2(isl.center);
          if (Math.hypot(pt.x - c.x, pt.y - c.y) < isl.radius * 0.8) through++;
        }
      }
    }
    expect(through).toBe(0);
  });

  it("gives every arc a count pill when there are at most 40; above that only the heaviest", () => {
    expect(l.arcs.length).toBeLessThanOrEqual(ALL_PILLS);
    expect(pillArcIds(l.arcs).size).toBe(l.arcs.length);
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `a${i}`,
      weight: i + 1,
      dependsOnly: i % 9 === 0,
    }));
    const top = pillArcIds(many);
    expect(top.size).toBe(TOP_PILLS);
    expect(top.has("a44")).toBe(true);
    expect(top.has("a0")).toBe(false);
  });
});

describe("workspace type text", () => {
  it('shows "(repo root)" instead of "unknown"', () => {
    const node = (id: string, kind: string) => ({
      id,
      kind: "workspace",
      label: id,
      size: 3,
      badges: [kind, "1 files", "3 functions"],
    });
    const s = summarizeIslands([node("ws:.", "unknown"), node("ws:a", "app")]);
    expect(s.find((i) => i.id === "ws:.")?.wsKind).toBe("(repo root)");
    expect(s.find((i) => i.id === "ws:a")?.wsKind).toBe("app");
    expect(computeLayout({ nodes: [node("ws:.", "unknown")], edges: [] }).islands[0]?.wsKind).toBe(
      "(repo root)",
    );
  });
});

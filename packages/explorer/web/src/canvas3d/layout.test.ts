import { describe, expect, it } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import {
  arcWidthPx,
  bestViewDir,
  computeLayout,
  folderCaption,
  folderKey,
  islandGap,
  islandHash,
  islandLabelPx,
  islandRadius,
  nodeRadius,
  positionHash,
  stripSharedSrc,
  summarizeIslands,
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

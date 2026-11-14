import { describe, expect, it } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import {
  arcWidthPx,
  computeLayout,
  islandGap,
  islandLabelPx,
  nodeRadius,
  positionHash,
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
    expect(nodeRadius(1e9, "file")).toBe(6);
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

  it("sizes islands by sqrt of function count with a floor, big ones on the outside", () => {
    const layout = computeLayout({ nodes, edges });
    const byFns = [...layout.islands].sort((a, b) => b.functions - a.functions);
    const r = byFns.map((i) => i.radius);
    expect(r[0]).toBeGreaterThan(r[3] as number);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(8);
    const dist = (i: (typeof layout.islands)[number]) => Math.hypot(i.center.x, i.center.y, i.center.z);
    const bigMean = byFns.slice(0, 3).reduce((a, i) => a + dist(i), 0) / 3;
    const tinyMean = byFns.slice(3).reduce((a, i) => a + dist(i), 0) / 8;
    expect(bigMean).toBeGreaterThan(tinyMean);
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
    expect(islandLabelPx(1e9)).toBe(32);
    expect(islandLabelPx(0)).toBe(12);
    expect(arcWidthPx(1)).toBeLessThan(arcWidthPx(100));
    expect(arcWidthPx(1e9)).toBe(6);
  });
});

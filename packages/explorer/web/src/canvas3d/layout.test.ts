import { describe, expect, it } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import { computeLayout, nodeRadius, positionHash, summarizeIslands } from "./layout.ts";

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
    expect(nodeRadius(1e9, "file")).toBe(8);
    expect(nodeRadius(0, "file")).toBeGreaterThan(0);
  });

  it("summarizes islands in colour order for the legend", () => {
    const s = summarizeIslands(files.nodes);
    expect(s.map((i) => i.label)).toEqual(["@acme/api", "@acme/db", "@acme/ui", "@acme/utils", "@acme/web"]);
    expect(s.find((i) => i.label === "@acme/web")?.wsKind).toBe("app");
    expect(s.every((i, k) => i.index === k && i.files > 0 && i.functions > 0)).toBe(true);
  });
});

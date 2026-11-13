// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../api.ts";
import { buildTree, deriveRegions } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { hashPositions } from "./prng.ts";
import { generateSynthetic } from "./synthetic.ts";
import type { LayoutInput, Positions } from "./types.ts";

const small = () => generateSynthetic({ workspaces: 4, files: 24, symbols: 120, edges: 200, seed: 7 });

function input(hint: string, saved?: Positions, extra: GraphNode[] = []): LayoutInput {
  const { nodes, edges } = small();
  return {
    nodes: [...nodes, ...extra].map((n) => ({ id: n.id, kind: n.kind, parent: n.parent, size: n.size })),
    edges: edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight })),
    hint,
    focus: null,
    saved,
  };
}

describe("computeLayout", () => {
  it.each(["nested-elk", "elk-layered", "radial", "force", "tree-lr", "columns", "clusters"])(
    "is deterministic for %s on a hierarchical graph",
    async (hint) => {
      const a = await computeLayout(input(hint));
      const b = await computeLayout(input(hint));
      expect(hashPositions(a.positions)).toBe(hashPositions(b.positions));
      expect(Object.keys(a.positions).length).toBe(input(hint).nodes.length);
    },
  );

  it.each(["force", "elk-layered", "radial", "tree-lr", "columns", "clusters", "grid", "layered", "tree"])(
    "lays out a flat graph with hint %s deterministically",
    async (hint) => {
      const flat = (): LayoutInput => {
        const i = input(hint);
        return {
          ...i,
          nodes: i.nodes
            .filter((n) => n.kind !== "workspace" && n.kind !== "directory" && n.kind !== "file")
            .map((n) => ({ ...n, parent: undefined })),
        };
      };
      const a = await computeLayout(flat());
      const b = await computeLayout(flat());
      expect(hashPositions(a.positions)).toBe(hashPositions(b.positions));
      for (const p of Object.values(a.positions)) {
        expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
      }
    },
  );

  it("keeps regions of sibling containers from overlapping (nested-elk)", async () => {
    const i = input("nested-elk");
    const { positions } = await computeLayout(i);
    const tree = buildTree(i.nodes);
    const regions = deriveRegions(tree, positions);
    const roots = [...regions.entries()].filter(([idx]) => tree.nodes[idx]?.parent === -1).map(([, r]) => r);
    expect(roots.length).toBe(4);
    for (let a = 0; a < roots.length; a++) {
      for (let b = a + 1; b < roots.length; b++) {
        const p = roots[a];
        const q = roots[b];
        if (!p || !q) continue;
        const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it("keeps saved positions and places one new node near its parent without moving the rest", async () => {
    const first = await computeLayout(input("nested-elk"));
    const parent = small().nodes.find((n) => n.kind === "file") as GraphNode;
    const extra: GraphNode = {
      id: "sym:new#added",
      kind: "function",
      label: "added",
      parent: parent.id,
      size: 1,
    };
    const second = await computeLayout(input("nested-elk", first.positions, [extra]));
    expect(second.strategy).toBe("saved");
    expect(second.changed).toBe(true);
    const moved = Object.keys(first.positions).filter((id) => {
      const n = small().nodes.find((x) => x.id === id);
      if (!n || n.kind === "workspace" || n.kind === "directory" || n.kind === "file") return false; // containers follow their leaves
      const a = first.positions[id] as [number, number];
      const b = second.positions[id] as [number, number];
      return a[0] !== b[0] || a[1] !== b[1];
    });
    expect(moved).toEqual([]);
    const added = second.positions[extra.id] as [number, number];
    const parentPos = first.positions[parent.id] as [number, number];
    expect(Math.hypot(added[0] - parentPos[0], added[1] - parentPos[1])).toBeLessThan(400);
  });

  it("reports no change when saved positions cover every node", async () => {
    const first = await computeLayout(input("force"));
    const again = await computeLayout(input("force", first.positions));
    expect(again.changed).toBe(false);
    expect(hashPositions(again.positions)).toBe(hashPositions(first.positions));
  });

  it("gives childless workspaces a region of their own", async () => {
    const nodes = ["a", "b", "c"].map((n) => ({ id: `ws:${n}`, kind: "workspace", size: 2 }));
    const edges = [{ src: "ws:a", dst: "ws:b", weight: 2 }];
    const out = await computeLayout({ nodes, edges, hint: "nested-elk", focus: null });
    const tree = buildTree(nodes, { boxWorkspaces: true });
    const regions = deriveRegions(tree, out.positions);
    expect(regions.size).toBe(3);
    const rects = [...regions.values()];
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const p = rects[a];
        const q = rects[b];
        if (!p || !q) continue;
        expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h).toBe(false);
      }
    }
  });
});

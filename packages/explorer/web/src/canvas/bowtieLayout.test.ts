import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../api.ts";
import { COL_GAP, layoutBowtie, weightOf, workspaceRanks } from "./bowtieLayout.ts";

const focus: GraphNode = { id: "f", kind: "function", label: "f", size: 1, side: "focus", hop: 0 };
const node = (id: string, side: "in" | "out", hop: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: "function",
  label: id,
  size: 1,
  side,
  hop,
  ...extra,
});
const edge = (src: string, dst: string): GraphEdge => ({
  id: `${src}|calls|${dst}`,
  src,
  dst,
  kind: "calls",
  weight: 1,
  confidence: "high",
});

describe("layoutBowtie", () => {
  it("puts callers left of the focus, callees right, and farther hops further out", () => {
    const nodes = [
      focus,
      node("c1", "in", 1),
      node("c2", "in", 2),
      node("e1", "out", 1),
      node("e2", "out", 2),
    ];
    const L = layoutBowtie(nodes, [edge("c2", "c1"), edge("c1", "f"), edge("f", "e1"), edge("e1", "e2")]);
    const x = (id: string) => (L.byId.get(id) as { x: number }).x;
    const right = (id: string) =>
      (L.byId.get(id) as { x: number; w: number }).x + (L.byId.get(id) as { w: number }).w;
    expect(right("c1")).toBeLessThan(x("f"));
    expect(x("c2")).toBeLessThan(x("c1"));
    expect(x("e1")).toBeGreaterThan(right("f"));
    expect(x("e2")).toBeGreaterThan(x("e1"));
    // Every edge flows left to right.
    for (const e of [edge("c2", "c1"), edge("c1", "f"), edge("f", "e1"), edge("e1", "e2")])
      expect(x(e.src)).toBeLessThan(x(e.dst));
    expect(COL_GAP).toBeGreaterThan(0);
  });

  it("stacks a column vertically without overlap: groups first by workspace, then individuals by name", () => {
    const group = (id: string, ws: string, size: number): GraphNode => ({
      ...node(id, "in", 1, { kind: "group", size, workspace: ws }),
      stats: { members: size },
    });
    const nodes = [
      focus,
      node("zeta", "in", 1, { workspace: "ws:a" }),
      node("alpha", "in", 1, { workspace: "ws:a" }),
      group("g-small-a", "ws:a", 5),
      group("g-big-b", "ws:b", 40),
      group("g-mid-b", "ws:b", 10),
      group("g-top-a", "ws:a", 8),
    ];
    const L = layoutBowtie(nodes, []);
    const col = L.items.filter((p) => p.side === "in").sort((a, b) => a.y - b.y);
    // ws:b has 50 callers in groups, ws:a 13: ws:b's groups come first, largest first.
    expect(col.map((p) => p.node.id)).toEqual([
      "g-big-b",
      "g-mid-b",
      "g-top-a",
      "g-small-a",
      "alpha",
      "zeta",
    ]);
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1] as { y: number; h: number };
      expect((col[i] as { y: number }).y).toBeGreaterThanOrEqual(prev.y + prev.h);
    }
  });

  it("keeps an expanded group's members under its header, inside one block", () => {
    const head: GraphNode = {
      ...node("g", "in", 1, { kind: "group", size: 3, expanded: true }),
      stats: { members: 3 },
    };
    const nodes = [
      focus,
      head,
      node("m2", "in", 1, { group: "g", path: "b.ts" }),
      node("m1", "in", 1, { group: "g", path: "a.ts" }),
      node("m3", "in", 1, { group: "g", path: "c.ts" }),
      node("lone", "in", 1),
    ];
    const L = layoutBowtie(nodes, []);
    const order = L.items
      .filter((p) => p.side === "in")
      .sort((a, b) => a.y - b.y)
      .map((p) => p.node.id);
    expect(order).toEqual(["g", "m1", "m2", "m3", "lone"]);
    expect(L.byId.get("m1")?.block).toBe("g");
    expect(L.byId.get("g")?.type).toBe("head");
  });

  it("is deterministic and centred on the focus when both sides have nodes", () => {
    const nodes = [focus, node("c1", "in", 1), node("e1", "out", 1)];
    const a = layoutBowtie(nodes, [edge("c1", "f"), edge("f", "e1")]);
    const b = layoutBowtie([...nodes].reverse(), [edge("f", "e1"), edge("c1", "f")]);
    expect(a.items.map((p) => [p.node.id, p.x, p.y])).toEqual(b.items.map((p) => [p.node.id, p.x, p.y]));
    expect(a.bounds.x0).toBeCloseTo(-a.bounds.x1);
    const f = a.byId.get("f") as { x: number; w: number };
    expect(f.x + f.w / 2).toBeCloseTo(0);
  });

  it("an empty side still has its (empty) column, and orders hop 2 by its neighbours", () => {
    const L = layoutBowtie([focus, node("c1", "in", 1)], [edge("c1", "f")]);
    expect(L.columns.map((c) => [c.side, c.count])).toEqual([
      ["in", 1],
      ["focus", 1],
      ["out", 0],
    ]);
    const nodes = [focus, node("a", "in", 1), node("b", "in", 1), node("p", "in", 2), node("q", "in", 2)];
    const M = layoutBowtie(nodes, [edge("a", "f"), edge("b", "f"), edge("q", "a"), edge("p", "b")]);
    const y = (id: string) => (M.byId.get(id) as { y: number }).y;
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("q")).toBeLessThan(y("p")); // q feeds a (above b), so it sits above p
  });
});

describe("helpers", () => {
  it("ranks workspaces by sorted id and weighs nodes by what they stand for", () => {
    const ranks = workspaceRanks([
      node("a", "in", 1, { workspace: "ws:z" }),
      node("b", "in", 1, { workspace: "ws:a" }),
      node("c", "in", 1),
    ]);
    expect([...ranks]).toEqual([
      ["ws:a", 0],
      ["ws:z", 1],
    ]);
    expect(weightOf(node("a", "in", 1))).toBe(1);
    expect(weightOf({ ...node("g", "in", 1, { kind: "group", size: 9 }), stats: { members: 9 } })).toBe(9);
    expect(weightOf(node("g", "in", 1, { kind: "group", size: 9, expanded: true }))).toBe(0);
    expect(weightOf(node("m", "in", 1, { kind: "more", size: 4 }))).toBe(4);
  });
});

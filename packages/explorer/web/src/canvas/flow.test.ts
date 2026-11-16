import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../api.ts";
import { distanceToCurve, edgeCurve, edgeStyle, edgeTipLines, FLOW_BOX_W, laneExtents } from "./flowGeom.ts";
import { computeLayout } from "./layout.ts";
import type { LayoutInput } from "./types.ts";

const node = (id: string, lane: number, rank?: number, band?: string) => ({
  id,
  kind: "endpoint",
  size: 1,
  lane,
  ...(rank !== undefined ? { rank } : {}),
  ...(band !== undefined ? { band } : {}),
});
const edge = (src: string, dst: string) => ({ src, dst, weight: 1, kind: "requests" });

describe("lane layouts (#48)", () => {
  it("columns: one x per lane, rank order top to bottom, deterministic", async () => {
    const input: LayoutInput = {
      nodes: [node("b", 0, 1), node("a", 0, 0), node("z", 1, 0), node("y", 1, 1)],
      edges: [edge("a", "z")],
      hint: "columns",
      focus: null,
    };
    const r = await computeLayout(input);
    const p = r.positions;
    expect(p.a?.[0]).toBe(p.b?.[0]);
    expect(p.z?.[0]).toBeGreaterThan((p.a?.[0] ?? 0) + FLOW_BOX_W);
    expect(p.a?.[1]).toBeLessThan(p.b?.[1] ?? 0);
    expect(p.z?.[1]).toBeLessThan(p.y?.[1] ?? 0);
    expect((await computeLayout(input)).positions).toEqual(p);
    expect(r.changed).toBe(false);
  });

  it("tree: a reversed tree keeps each subtree together around its parent", async () => {
    // Table t on the right (lane 2); writer w and reader r in lane 1; callers of w (a, b) and of r (c) in lane 0.
    const r = await computeLayout({
      nodes: [
        node("t", 2, 0),
        node("w", 1, 1),
        node("r", 1, 4),
        node("a", 0, 2),
        node("b", 0, 3),
        node("c", 0, 5),
      ],
      edges: [edge("w", "t"), edge("r", "t"), edge("a", "w"), edge("b", "w"), edge("c", "r")],
      hint: "tree-lr",
      focus: null,
    });
    const y = (id: string) => r.positions[id]?.[1] ?? 0;
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("b")).toBeLessThan(y("c"));
    expect(y("w")).toBe((y("a") + y("b")) / 2);
    expect(y("r")).toBe(y("c"));
    expect(r.positions.t?.[0]).toBeGreaterThan(r.positions.w?.[0] ?? 0);
  });

  it("elk-layered: lanes are partitions and bands stack with lanes aligned", async () => {
    const r = await computeLayout({
      nodes: [
        node("e1", 0, 0, "rpc"),
        node("h1", 2, 0, "rpc"),
        node("e2", 0, 1, "http"),
        node("m2", 1, 0, "http"),
        node("h2", 2, 1, "http"),
      ],
      edges: [edge("e1", "h1"), edge("e2", "m2"), edge("e2", "h2")],
      hint: "elk-layered",
      focus: null,
    });
    const p = r.positions;
    expect(p.h1?.[0]).toBe(p.h2?.[0]);
    expect(p.e1?.[0]).toBe(p.e2?.[0]);
    expect(p.m2?.[0]).toBeGreaterThan(p.e2?.[0] ?? 0);
    expect(p.h2?.[0]).toBeGreaterThan(p.m2?.[0] ?? 0);
    expect(p.e2?.[1]).toBeGreaterThan(p.e1?.[1] ?? 0);
  });
});

describe("flow geometry", () => {
  it("styles reads blue, writes orange, low edges dashed", () => {
    const e = (kind: string, confidence: "high" | "low") => ({ kind, confidence, weight: 1 });
    expect(edgeStyle(e("reads", "high"), "light").color).toBe("#1d5fd6");
    expect(edgeStyle(e("writes", "high"), "light").color).toBe("#c2510c");
    expect(edgeStyle(e("requests", "low"), "light").dash).not.toBeNull();
    expect(edgeStyle(e("requests", "high"), "light").dash).toBeNull();
  });

  it("curves leave the right side and hit-test near the line", () => {
    const c = edgeCurve({ x: 0, y: 0 }, { x: 400, y: 100 });
    expect(c.p0.x).toBe(FLOW_BOX_W / 2);
    expect(c.p3.x).toBe(400 - FLOW_BOX_W / 2);
    expect(distanceToCurve(c, { x: 200, y: 50 })).toBeLessThan(3);
    expect(distanceToCurve(c, { x: 200, y: 200 })).toBeGreaterThan(50);
    // Same column: a loop out of the right sides.
    const loop = edgeCurve({ x: 0, y: 0 }, { x: 0, y: 80 });
    expect(loop.p1.x).toBeGreaterThan(loop.p0.x);
  });

  it("titles lanes and says what an edge stands for", () => {
    const ext = laneExtents(
      [
        { id: "a", kind: "route", label: "/", size: 1, lane: 0 },
        { id: "b", kind: "endpoint", label: "rpc x", size: 1, lane: 1 },
      ],
      { a: [0, 0], b: [360, 0] },
      [
        { lane: 0, label: "Pages" },
        { lane: 1, label: "Endpoints" },
      ],
    );
    expect(ext.map((x) => x.label)).toEqual(["Pages", "Endpoints"]);
    const e: GraphEdge = {
      id: "a|requests|b",
      src: "a",
      dst: "b",
      kind: "requests",
      weight: 3,
      confidence: "low",
      via: 3,
      viaSample: ["Page", "useX"],
    };
    const t = edgeTipLines(e, (id) => id.toUpperCase());
    expect(t.title).toBe("A requests B");
    expect(t.lines).toEqual(["via 3 places in the page", "Page, useX, …", "uncertain match (dashed)"]);
  });
});

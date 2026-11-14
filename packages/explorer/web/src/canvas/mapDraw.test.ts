// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../../mock/hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { drawMap, edgeWidth, pickCell, rectOf } from "./mapDraw.ts";
import { buildScene, layoutInputFor, nodeTitle, subtitleParts } from "./scene.ts";
import { readTheme } from "./style.ts";

async function laidOut() {
  const { nodes, edges } = buildHierarchy();
  const scene = buildScene(nodes, edges, "nested-elk");
  const out = await computeLayout(layoutInputFor(scene, "nested-elk", null));
  if (!out.map) throw new Error("no map geometry");
  return { scene, geo: out.map };
}

describe("picking", () => {
  it("returns the deepest cell under the pointer, and the workspace for its title strip", async () => {
    const { scene, geo } = await laidOut();
    const cam = { scale: 1, tx: 0, ty: 0 };
    const symbol = scene.tree.nodes.findIndex((n) => n.kind === "function");
    const r = rectOf(geo, symbol);
    // A big enough zoom that the cell is over 2px: its centre picks the function itself.
    const zoomed = { scale: 20, tx: 0, ty: 0 };
    expect(pickCell(scene, geo, zoomed, (r.x + r.w / 2) * 20, (r.y + r.h / 2) * 20)).toBe(symbol);

    // At fit-like zoom the function is under two pixels, so the pick stops at its file.
    const small = { scale: 0.05, tx: 0, ty: 0 };
    const picked = pickCell(scene, geo, small, (r.x + r.w / 2) * 0.05, (r.y + r.h / 2) * 0.05);
    expect(picked).not.toBeNull();
    expect(scene.tree.nodes[picked as number]?.kind).not.toBe("function");

    // The top strip of a workspace box holds no cell: the pick is the workspace itself.
    const ws = scene.roots[0] as number;
    const box = rectOf(geo, ws);
    expect(pickCell(scene, geo, cam, box.x + 6, box.y + 3)).toBe(ws);
    // Outside every box: nothing.
    expect(pickCell(scene, geo, cam, -500, -500)).toBeNull();
  });
});

describe("titles and edge widths", () => {
  it("uses the short name when the server sent one and prints the node's own counts", () => {
    const scene = buildScene(
      [
        {
          id: "ws:@org/api",
          kind: "workspace",
          label: "@org/api",
          shortLabel: "api",
          size: 1,
          badges: ["app"],
          stats: { files: 260, functions: 1700 },
        },
        {
          id: "file:a.ts",
          kind: "file",
          label: "a.ts",
          parent: "ws:@org/api",
          size: 1,
          stats: { functions: 3 },
        },
      ],
      [],
    );
    const ws = scene.tree.index.get("ws:@org/api") as number;
    expect(nodeTitle(scene, ws)).toBe("api");
    // 1,700 functions in 260 files from the workspace node, not the 1 file / 3 functions loaded below it.
    expect(subtitleParts(scene, ws)).toEqual(["app", "1,700 functions", "260 files"]);
  });

  it("grows with the square root of the weight, clamped", () => {
    expect(edgeWidth(1)).toBeCloseTo(1.2, 5);
    expect(edgeWidth(100)).toBeCloseTo(4.8, 5);
    expect(edgeWidth(640)).toBeLessThanOrEqual(9);
    expect(edgeWidth(1_000_000)).toBe(9);
    expect(edgeWidth(0)).toBe(1);
  });
});

/** A 2D context that records nothing: text is measured at 6px per character, every other call is a no-op. */
function stubContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get: (t, key: string) =>
      key === "measureText" ? (text: string) => ({ width: text.length * 6 }) : (t[key] ?? (() => {})),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

describe("count pills", () => {
  it("print the import count of a pair that also has a declared dependency, not the sum", async () => {
    const ws = ["a", "b"].map((n) => ({
      id: `ws:${n}`,
      kind: "workspace",
      label: n,
      size: 3,
      stats: { functions: 40, files: 4 },
    }));
    const edges = [
      { id: "d", src: "ws:a", dst: "ws:b", kind: "depends_on", weight: 1, confidence: "high" as const },
      { id: "i", src: "ws:a", dst: "ws:b", kind: "imports", weight: 319, confidence: "high" as const },
    ];
    const scene = buildScene(ws, edges, "nested-elk");
    const out = await computeLayout(layoutInputFor(scene, "nested-elk", null));
    if (!out.map) throw new Error("no map geometry");
    const result = drawMap({
      ctx: stubContext(),
      w: out.map.bounds.w + 100,
      h: out.map.bounds.h + 100,
      scene,
      geo: out.map,
      theme: readTheme(null),
      cam: { scale: 1, tx: 40, ty: 40 },
      selected: null,
      hovered: null,
      highlightWs: null,
      showDeclared: true,
      bright: null,
      links: [],
      hoverEdge: null,
    });
    expect(result.edgeHits).toHaveLength(1);
    expect(result.edgeHits[0]?.weight).toBe(319);
    expect(result.pills.map((p) => p.count)).toEqual(["319"]);
  });
});

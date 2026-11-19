// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectMapLarge } from "../../mock/largeMap.ts";
import type { GraphNode } from "../api.ts";
import type { TreeNode } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { keepFrom } from "./mapLayout.ts";
import { buildScene, layoutInputFor, type Scene, stickyOf } from "./scene.ts";
import type { MapGeometry, Rect } from "./types.ts";

const VIEWPORT = { w: 1180, h: 812 };

function view(level: "files" | "symbols") {
  const v = projectMapLarge({ focus: null, level, options: {} });
  if ("error" in v) throw new Error(v.error);
  return v;
}

async function lay(scene: Scene, keep?: ReturnType<typeof keepFrom>) {
  const out = await computeLayout({
    ...layoutInputFor(scene, "nested-elk", null, undefined, VIEWPORT),
    keep,
  });
  if (!out.map) throw new Error("no map geometry");
  return { positions: out.positions, map: out.map };
}

const keepOf = (scene: Scene, map: MapGeometry) =>
  keepFrom(
    scene.nodes.map((n) => n.id),
    map,
    (i) => (scene.tree.nodes[i] as TreeNode).parent === -1,
  );

const rectOf = (scene: Scene, map: MapGeometry, id: string): Rect => {
  const i = scene.tree.index.get(id) as number;
  return {
    x: map.rects[i * 4] as number,
    y: map.rects[i * 4 + 1] as number,
    w: map.rects[i * 4 + 2] as number,
    h: map.rects[i * 4 + 3] as number,
  };
};

/** The server's answer after a refresh: one function added to `file`, one removed from `other`, counts updated. */
function edited(nodes: GraphNode[], file: string, other: string): GraphNode[] {
  const parents = new Map(nodes.map((n) => [n.id, n.parent]));
  const bump = (id: string | undefined, by: number, out: GraphNode[]) => {
    for (let p = id; p; p = parents.get(p)) {
      const k = out.findIndex((n) => n.id === p);
      const n = out[k] as GraphNode;
      out[k] = { ...n, stats: { ...n.stats, functions: (n.stats?.functions ?? 0) + by } };
    }
  };
  const gone = nodes.find((n) => n.parent === other)?.id;
  const out = nodes.filter((n) => n.id !== gone);
  out.push({
    id: `sym:pnpm-turbo:${file.slice(5)}#addedByRefresh`,
    kind: "function",
    label: "addedByRefresh",
    parent: file,
    size: 1,
  });
  bump(file, 1, out);
  bump(other, -1, out);
  return out;
}

describe("a refresh keeps the map layout (spec section 11 (c))", () => {
  it("nothing outside the changed files moves; the added function lands inside its file", async () => {
    const before = view("symbols");
    const scene0 = buildScene(before.nodes, before.edges, "nested-elk");
    const first = await lay(scene0);
    const files = before.nodes.filter(
      (n) => n.kind === "file" && before.nodes.filter((c) => c.parent === n.id).length >= 2,
    );
    const file = (files[3] as GraphNode).id;
    const other = (files[files.length - 2] as GraphNode).id;

    const nodes = edited(before.nodes, file, other);
    const scene1 = buildScene(nodes, before.edges, "nested-elk");
    const fresh = await lay(scene1);
    const kept = await lay(scene1, keepOf(scene0, first.map));

    const parent = new Map(nodes.map((n) => [n.id, n.parent]));
    /** Inside a changed file (the file itself keeps its place). */
    const inChanged = (id: string) => {
      for (let p = parent.get(id); p; p = parent.get(p)) if (p === file || p === other) return true;
      return false;
    };
    const unchanged = Object.keys(first.positions).filter((id) => id in kept.positions && !inChanged(id));
    expect(unchanged.length).toBeGreaterThan(100);
    for (const id of unchanged) expect(kept.positions[id], id).toEqual(first.positions[id]);
    // Without the kept layout the same edit moves things (that is what keep is for).
    expect(
      unchanged.some(
        (id) =>
          fresh.positions[id]?.[0] !== first.positions[id]?.[0] ||
          fresh.positions[id]?.[1] !== first.positions[id]?.[1],
      ),
    ).toBe(true);

    const added = `sym:pnpm-turbo:${file.slice(5)}#addedByRefresh`;
    const a = rectOf(scene1, kept.map, added);
    const f = rectOf(scene1, kept.map, file);
    expect(a.w * a.h).toBeGreaterThan(0);
    expect(
      a.x >= f.x - 1e-6 &&
        a.y >= f.y - 1e-6 &&
        a.x + a.w <= f.x + f.w + 1e-6 &&
        a.y + a.h <= f.y + f.h + 1e-6,
    ).toBe(true);
    // The same keep gives the same picture twice.
    expect((await lay(scene1, keepOf(scene0, first.map))).positions).toEqual(kept.positions);
  });

  it("lays out from scratch when the workspaces changed", async () => {
    const before = view("files");
    const scene0 = buildScene(before.nodes, before.edges, "nested-elk");
    const first = await lay(scene0);
    const keep = keepOf(scene0, first.map);
    const ws = Object.keys(keep.boxes)[0] as string;
    delete keep.boxes[ws];
    keep.boxes["ws:not-there"] = [0, 0, 10, 10];
    const again = await lay(scene0, keep);
    expect(again.positions).toEqual(first.positions);
  });
});

describe("a refresh keeps the structure decisions of the scene", () => {
  // One workspace: `src` holds nearly every function, `cfg.ts` sits beside it. With 0 functions in the loose file it
  // is gathered in a "(root files)" group and `src` is lifted; with 3 of 12 it is not.
  const nodes = (loose: number): GraphNode[] => {
    const fns = (file: string, n: number): GraphNode[] =>
      Array.from({ length: n }, (_, k) => ({
        id: `sym:pnpm-turbo:${file}#f${k}`,
        kind: "function",
        label: `f${k}`,
        parent: `file:pnpm-turbo:${file}`,
        size: 1,
      }));
    return [
      { id: "ws:a", kind: "workspace", label: "a", size: 1, stats: { functions: 9 + loose, files: 2 } },
      {
        id: "dir:a/src",
        kind: "dir",
        label: "src",
        parent: "ws:a",
        size: 1,
        stats: { functions: 9, files: 1 },
      },
      {
        id: "file:pnpm-turbo:a/src/x.ts",
        kind: "file",
        label: "x.ts",
        parent: "dir:a/src",
        size: 1,
        stats: { functions: 9 },
      },
      ...fns("a/src/x.ts", 9),
      {
        id: "file:pnpm-turbo:a/cfg.ts",
        kind: "file",
        label: "cfg.ts",
        parent: "ws:a",
        size: 1,
        stats: { functions: loose },
      },
      ...fns("a/cfg.ts", loose),
    ];
  };
  const shape = (scene: Scene) => ({
    groups: scene.tree.nodes.filter((n) => n.kind.startsWith("group") || n.id.startsWith("rootfiles:"))
      .length,
    skipped: scene.tree.nodes.filter((_, i) => scene.skipped[i] === 1).map((n) => n.id),
  });

  it("an added function does not regroup the cells around it, and a fresh scene still decides from the counts", () => {
    const before = buildScene(nodes(0), [], "nested-elk");
    expect(shape(before)).toEqual({ groups: 1, skipped: ["dir:a/src"] });
    const fresh = buildScene(nodes(3), [], "nested-elk");
    expect(shape(fresh)).toEqual({ groups: 0, skipped: [] });
    const kept = buildScene(nodes(3), [], "nested-elk", { sticky: stickyOf(before) });
    expect(shape(kept)).toEqual(shape(before));
    expect(kept.sticky).toBeDefined();
    // And the other way round: no group before, none after.
    const keptNone = buildScene(nodes(0), [], "nested-elk", { sticky: stickyOf(fresh) });
    expect(shape(keptNone)).toEqual(shape(fresh));
    // The layout pads exactly the folders the scene lifted.
    expect(layoutInputFor(kept, "nested-elk", null).transparent).toEqual(["dir:a/src"]);
  });
});

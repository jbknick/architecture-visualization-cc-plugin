// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildTree, collapseChains } from "./hierarchy.ts";

const n = (id: string, kind: string, parent?: string) => ({ id, kind, parent, size: 1 });

describe("collapseChains", () => {
  const tree = buildTree([
    n("ws:a", "workspace"),
    n("dir:a/src", "dir", "ws:a"),
    n("dir:a/src/lib", "dir", "dir:a/src"),
    n("dir:a/src/lib/x", "dir", "dir:a/src/lib"),
    n("dir:a/src/lib/x/deep", "dir", "dir:a/src/lib/x"),
    n("file:a/src/lib/x/f.ts", "file", "dir:a/src/lib/x"),
    n("file:a/src/lib/x/deep/g.ts", "file", "dir:a/src/lib/x/deep"),
    n("ws:b", "workspace"),
    n("dir:b/src", "dir", "ws:b"),
    n("file:b/src/h.ts", "file", "dir:b/src"),
    n("file:b/readme.ts", "file", "ws:b"),
    n("ws:c", "workspace"),
    n("dir:c/src", "dir", "ws:c"),
    n("dir:c/src/a", "dir", "dir:c/src"),
    n("dir:c/src/b", "dir", "dir:c/src"),
  ]);
  const idx = (id: string) => tree.index.get(id) as number;

  it("skips a lone folder under a workspace or folder with no files of its own, however long the chain", () => {
    const info = collapseChains(tree);
    const skipped = (id: string) => info.skipped[idx(id)] === 1;
    expect(skipped("dir:a/src")).toBe(true);
    expect(skipped("dir:a/src/lib")).toBe(true);
    expect(skipped("dir:a/src/lib/x")).toBe(true);
    expect(skipped("dir:a/src/lib/x/deep")).toBe(false); // x also holds a file
    expect(info.chain.get(idx("ws:a"))).toEqual(["dir:a/src", "dir:a/src/lib", "dir:a/src/lib/x"].map(idx));
  });

  it("keeps folders that have siblings, or files next to them", () => {
    const info = collapseChains(tree);
    expect(info.skipped[idx("dir:b/src")]).toBe(0); // ws:b also has a file of its own
    expect(info.skipped[idx("dir:c/src")]).toBe(1);
    expect(info.skipped[idx("dir:c/src/a")]).toBe(0);
    expect(info.skipped[idx("dir:c/src/b")]).toBe(0);
    expect(info.chain.get(idx("ws:c"))).toEqual([idx("dir:c/src")]);
  });

  it("uses the file counts: a folder that holds files of its own keeps its only subfolder visible", () => {
    const solo = buildTree([
      n("ws:d", "workspace"),
      n("dir:d/src", "dir", "ws:d"),
      n("dir:d/src/a", "dir", "dir:d/src"),
    ]);
    const at = (id: string) => solo.index.get(id) as number;
    const f = new Int32Array(3);
    f[at("ws:d")] = 5;
    f[at("dir:d/src")] = 5;
    f[at("dir:d/src/a")] = 3; // two files live directly in src
    const info = collapseChains(solo, f);
    expect(info.skipped[at("dir:d/src")]).toBe(1);
    expect(info.skipped[at("dir:d/src/a")]).toBe(0);
    expect(collapseChains(solo).skipped[at("dir:d/src/a")]).toBe(1); // no counts: nothing says otherwise
  });

  it("counts only folders that keep a header as depth", () => {
    const info = collapseChains(tree);
    expect(info.depth[idx("ws:c")]).toBe(0);
    expect(info.depth[idx("dir:c/src/a")]).toBe(1);
    expect(info.depth[idx("dir:a/src/lib/x/deep")]).toBe(1);
    expect(info.depth[idx("dir:b/src")]).toBe(1);
  });
});

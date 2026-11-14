import { describe, expect, it } from "vitest";
import type { GraphNode } from "../api.ts";
import { decollideMarkers } from "./markers.ts";
import { folderIn, isTestPath, RANK_COUNT, rankFiles, whereLine, workspacesWithFiles } from "./rank.ts";

const ws = (id: string, path: string, shortLabel?: string): GraphNode => ({
  id,
  kind: "workspace",
  label: `@acme/${id}`,
  shortLabel,
  size: 1,
  path,
});
const dir = (path: string, parent: string): GraphNode => ({
  id: `dir:${path}`,
  kind: "dir",
  label: path.slice(path.lastIndexOf("/") + 1),
  size: 1,
  path,
  parent,
});
const file = (path: string, parent: string, functions: number): GraphNode => ({
  id: `file:${path}`,
  kind: "file",
  label: path.slice(path.lastIndexOf("/") + 1),
  size: 1,
  path,
  parent,
  stats: { functions },
});

const nodes: GraphNode[] = [
  ws("api", "apps/api", "api"),
  ws("web", "apps/web", "web"),
  dir("apps/api/src", "api"),
  dir("apps/api/src/routes", "dir:apps/api/src"),
  dir("apps/web/src", "web"),
  file("apps/api/src/routes/b.ts", "dir:apps/api/src/routes", 40),
  file("apps/api/src/routes/a.ts", "dir:apps/api/src/routes", 40), // ties with b.ts: path order decides
  file("apps/api/src/routes/a.test.ts", "dir:apps/api/src/routes", 99),
  file("apps/api/index.ts", "api", 7),
  file("apps/web/src/page.tsx", "dir:apps/web/src", 55),
];

describe("rankFiles", () => {
  it("orders by function count and breaks ties by path", () => {
    const r = rankFiles(nodes, { hideTests: true });
    expect(r.map((f) => f.path)).toEqual([
      "apps/web/src/page.tsx",
      "apps/api/src/routes/a.ts",
      "apps/api/src/routes/b.ts",
      "apps/api/index.ts",
    ]);
    expect(r.map((f) => f.rank)).toEqual([1, 2, 3, 4]);
  });

  it("is deterministic whatever order the nodes arrive in", () => {
    const a = rankFiles(nodes);
    const b = rankFiles([...nodes].reverse());
    expect(b).toEqual(a);
  });

  it("leaves tests out only when asked to", () => {
    expect(rankFiles(nodes, { hideTests: true }).some((f) => f.name === "a.test.ts")).toBe(false);
    const shown = rankFiles(nodes, { hideTests: false });
    expect(shown[0]?.name).toBe("a.test.ts");
  });

  it("restricts to one workspace and keeps the top of that workspace", () => {
    const r = rankFiles(nodes, { workspace: "api" });
    expect(r.every((f) => f.workspaceId === "api")).toBe(true);
    expect(r.map((f) => f.name)).toEqual(["a.ts", "b.ts", "index.ts"]);
  });

  it("limits to 15 and names workspace and folder (no leading src/)", () => {
    const many = Array.from({ length: 40 }, (_, i) => file(`apps/web/src/f${i}.ts`, "dir:apps/web/src", i));
    const r = rankFiles([...nodes, ...many]);
    expect(r).toHaveLength(RANK_COUNT);
    expect(r[0]?.functions).toBe(55);
    const routes = rankFiles(nodes).find((f) => f.name === "a.ts");
    expect(routes && whereLine(routes)).toBe("api › routes");
    const root = rankFiles(nodes).find((f) => f.name === "index.ts");
    expect(root && whereLine(root)).toBe("api");
  });

  it("lists the workspaces that own files", () => {
    expect(workspacesWithFiles(nodes)).toEqual([
      { id: "api", label: "api" },
      { id: "web", label: "web" },
    ]);
  });
});

describe("helpers", () => {
  it("folderIn drops the workspace dir and a leading src", () => {
    expect(folderIn("apps/api/src/routes/v1/x.ts", "apps/api")).toBe("routes/v1");
    expect(folderIn("apps/api/src/x.ts", "apps/api")).toBe("");
    expect(folderIn("lib/x.ts", ".")).toBe("lib");
  });
  it("isTestPath matches the server's rule", () => {
    expect(isTestPath("a/b.test.ts")).toBe(true);
    expect(isTestPath("a/__tests__/b.ts")).toBe(true);
    expect(isTestPath("a/b.ts")).toBe(false);
  });
});

describe("decollideMarkers", () => {
  it("separates 15 markers that all want the same spot and drops none", () => {
    const spots = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, x: 100 + (i % 3), y: 100 + (i % 2) }));
    const r = 9;
    const out = decollideMarkers(spots, r, 2);
    expect(out).toHaveLength(15);
    expect(out.map((p) => p.id)).toEqual(spots.map((s) => s.id));
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i] as (typeof out)[number];
        const b = out[j] as (typeof out)[number];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * r + 2 - 1e-6);
      }
  });

  it("leaves a free marker where it wants to be and is deterministic", () => {
    const spots = [
      { id: "a", x: 10, y: 10 },
      { id: "b", x: 200, y: 200 },
      { id: "c", x: 12, y: 12 },
    ];
    const a = decollideMarkers(spots, 9);
    expect(a[0]).toMatchObject({ x: 10, y: 10, moved: 0 });
    expect(a[1]).toMatchObject({ x: 200, y: 200, moved: 0 });
    expect(a[2]?.moved).toBeGreaterThan(0);
    expect(decollideMarkers(spots, 9)).toEqual(a);
  });

  it("keeps a marker even when every nearby spot is vetoed", () => {
    const out = decollideMarkers([{ id: "a", x: 5, y: 5 }], 9, 2, () => true);
    expect(out).toEqual([{ id: "a", x: 5, y: 5, moved: 0 }]);
  });
});

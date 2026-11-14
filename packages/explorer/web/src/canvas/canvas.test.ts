// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../../mock/hierarchy.ts";
import { buildTree, liftTo, TIER_DIR, TIER_SYMBOL, TIER_WORKSPACE } from "./hierarchy.ts";
import { hashPositions } from "./prng.ts";
import { brightSet, buildScene, relatedSet, selectionLinks } from "./scene.ts";
import { labelInk, mix, WORKSPACE_PALETTE_SIZE, workspaceColor } from "./style.ts";
import { generateSynthetic } from "./synthetic.ts";
import { levelForRatio, MID_AT, NEAR_AT } from "./zoom.ts";

const fixture = () => buildHierarchy();

describe("hierarchy", () => {
  it("assigns tiers workspace > directory > file > symbol and finds roots", () => {
    const { nodes } = fixture();
    const tree = buildTree(nodes);
    expect(tree.hierarchical).toBe(true);
    const tiers = new Set(tree.nodes.map((n) => n.tier));
    expect([...tiers].sort()).toEqual([0, 1, 2, 3]);
    const roots = tree.nodes.filter((n) => n.parent === -1);
    expect(roots.map((r) => r.kind)).toEqual(Array(5).fill("workspace"));
    for (const n of tree.nodes) expect((tree.nodes[n.root] as { parent: number }).parent).toBe(-1);
  });

  it("treats a graph without parents as flat and survives parent cycles", () => {
    const flat = buildTree([
      { id: "a", kind: "function", size: 1 },
      { id: "b", kind: "function", size: 1 },
    ]);
    expect(flat.hierarchical).toBe(false);
    const cyclic = buildTree([
      { id: "a", kind: "file", parent: "b", size: 1 },
      { id: "b", kind: "file", parent: "a", size: 1 },
    ]);
    expect(cyclic.nodes.some((n) => n.parent === -1)).toBe(true);
  });

  it("lifts nodes to their ancestor at a tier and sums edges into workspace links", () => {
    const { nodes, edges } = fixture();
    const tree = buildTree(nodes);
    const sym = tree.nodes.findIndex((n) => n.tier === TIER_SYMBOL);
    expect((tree.nodes[liftTo(tree, sym, TIER_WORKSPACE)] as { tier: number }).tier).toBe(TIER_WORKSPACE);
    expect((tree.nodes[liftTo(tree, sym, TIER_DIR)] as { tier: number }).tier).toBe(TIER_DIR);
    const agg = buildScene(nodes, edges).wsEdges;
    const byName = new Map(
      agg.map((e) => [`${tree.nodes[e.src]?.id}>${tree.nodes[e.dst]?.id}`, e.weight] as const),
    );
    expect(byName.get("ws:@acme/web>ws:@acme/ui")).toBe(38);
    expect(byName.get("ws:@acme/api>ws:@acme/db")).toBe(29);
    expect(agg.every((e) => e.src !== e.dst)).toBe(true);
  });
});

describe("workspace-level map", () => {
  const nodes = ["a", "b", "c"].map((n) => ({
    id: `ws:${n}`,
    kind: "workspace",
    label: n,
    size: 3,
    badges: ["package"],
  }));
  const edges = [
    { id: "e", src: "ws:a", dst: "ws:b", kind: "depends_on", weight: 4, confidence: "high" as const },
  ];

  it("boxes childless workspaces for the nested hint only", () => {
    const boxed = buildScene(nodes, edges, "nested-elk");
    expect(boxed.hierarchical).toBe(true);
    expect(boxed.wsEdges).toHaveLength(1);
    expect(boxed.wsEdges[0]?.declaredOnly).toBe(true); // a depends_on edge with no imports
    const flat = buildScene(nodes, edges, "force");
    expect(flat.hierarchical).toBe(false);
  });
});

describe("scene", () => {
  it("computes workspace links and highlights a selection's neighbours", () => {
    const { nodes, edges } = fixture();
    const scene = buildScene(nodes, edges);
    expect(scene.wsEdges.length).toBe(7);
    expect(scene.wsEdges[0]?.weight).toBe(38); // sorted by weight
    expect(scene.wsEdges.every((e) => !e.declaredOnly)).toBe(true);
    const web = scene.tree.index.get("ws:@acme/web") as number;
    const bright = brightSet(scene, web);
    const names = [...bright].map((i) => scene.tree.nodes[i]?.id);
    expect(names).toContain("ws:@acme/ui");
    expect(names).toContain("ws:@acme/api");
    expect(names).not.toContain("ws:@acme/db");
    expect(relatedSet(scene, web).has(web)).toBe(true);
  });

  it("counts functions under each workspace", () => {
    const { nodes, edges } = fixture();
    const scene = buildScene(nodes, edges);
    const web = scene.tree.index.get("ws:@acme/web") as number;
    expect(scene.symbolCount[web]).toBe(scene.nodes[web]?.size);
  });
});

describe("zoom levels", () => {
  it("maps camera ratio to far, mid and near", () => {
    expect(levelForRatio(1)).toBe("far");
    expect(levelForRatio(1 / MID_AT)).toBe("mid");
    expect(levelForRatio(1 / (NEAR_AT + 0.1))).toBe("near");
    expect(levelForRatio(0.01)).toBe("near");
  });
});

describe("workspace colours", () => {
  const luminance = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("is stable per rank, distinct within the palette, and wraps", () => {
    const colours = Array.from({ length: WORKSPACE_PALETTE_SIZE }, (_, i) => workspaceColor(i, "light"));
    expect(new Set(colours).size).toBe(WORKSPACE_PALETTE_SIZE);
    expect(workspaceColor(WORKSPACE_PALETTE_SIZE, "light")).toBe(workspaceColor(0, "light"));
    expect(workspaceColor(2, "dark")).toBe(workspaceColor(2, "dark"));
  });

  it("keeps label ink at 4.5:1 or better on the region background in both themes", () => {
    for (let i = 0; i < WORKSPACE_PALETTE_SIZE; i++) {
      for (const [scheme, surface] of [
        ["light", "#ffffff"],
        ["dark", "#171b22"],
      ] as const) {
        const colour = workspaceColor(i, scheme);
        // The darkest region background is the workspace tint over the surface (see overlay.ts).
        const background = mix(colour, surface, scheme === "light" ? 0.11 : 0.17);
        expect(contrast(labelInk(colour, scheme), background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("selection links", () => {
  it("lists the links of a selected function, strongest first, and none for an isolated node", () => {
    const { nodes, edges } = fixture();
    const scene = buildScene(nodes, edges);
    const connected = scene.tree.nodes.findIndex(
      (n, i) => n.tier === 3 && (scene.incident.get(i) ?? []).length > 0,
    );
    const links = selectionLinks(scene, connected);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.src === connected || l.dst === connected).toBe(true);
    for (let i = 1; i < links.length; i++)
      expect((links[i - 1] as { weight: number }).weight).toBeGreaterThanOrEqual(
        (links[i] as { weight: number }).weight,
      );
    const lonely = scene.tree.nodes.findIndex((n, i) => n.tier === 3 && !scene.incident.has(i));
    if (lonely >= 0) expect(selectionLinks(scene, lonely)).toEqual([]);
  });

  it("sums the links of everything inside a selected folder and skips internal ones", () => {
    const { nodes, edges } = fixture();
    const scene = buildScene(nodes, edges);
    const dir = scene.tree.nodes.findIndex((n) => n.id === "dir:@acme/web/src/components");
    const links = selectionLinks(scene, dir);
    const inside = new Set<number>();
    const walk = (i: number) => {
      inside.add(i);
      for (const c of scene.tree.nodes[i]?.children ?? []) walk(c);
    };
    walk(dir);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(inside.has(l.src) && inside.has(l.dst)).toBe(false);
  });
});

describe("synthetic generator and position hashing", () => {
  it("is deterministic and reaches 30k symbols", () => {
    const a = generateSynthetic();
    const b = generateSynthetic();
    expect(a.nodes.length).toBe(b.nodes.length);
    expect(
      a.nodes.filter((n) => n.kind !== "workspace" && n.kind !== "directory" && n.kind !== "file"),
    ).toHaveLength(30_000);
    expect(a.edges[100]?.id).toBe(b.edges[100]?.id);
  });

  it("hashes position maps independent of key order", () => {
    const p = { a: [1, 2], b: [3, 4] } as Record<string, [number, number]>;
    const q = { b: [3, 4], a: [1, 2] } as Record<string, [number, number]>;
    expect(hashPositions(p)).toBe(hashPositions(q));
    expect(hashPositions(p)).not.toBe(hashPositions({ a: [1, 2], b: [3, 5] }));
  });
});

describe("workspace link counts", () => {
  const ws = ["a", "b"].map((n) => ({ id: `ws:${n}`, kind: "workspace", label: n, size: 3 }));
  const imports = { id: "ws:a|imports|ws:b", src: "ws:a", dst: "ws:b", kind: "imports", weight: 319 };
  const declared = { id: "ws:a|depends_on|ws:b", src: "ws:a", dst: "ws:b", kind: "depends_on", weight: 1 };

  it("counts only the imports, whatever order the edges come in", () => {
    for (const edges of [
      [declared, imports],
      [imports, declared],
    ]) {
      const link = buildScene(
        ws,
        edges.map((e) => ({ ...e, confidence: "high" as const })),
        "nested-elk",
      ).wsEdges;
      expect(link).toHaveLength(1);
      expect(link[0]?.weight).toBe(319);
      expect(link[0]?.declaredOnly).toBe(false);
      expect(link[0]?.declared).toBe(true);
    }
  });

  it("keeps a declared-only pair as a dashed link with the declared flag and no import count", () => {
    const link = buildScene(ws, [{ ...declared, confidence: "high" as const }], "nested-elk").wsEdges;
    expect(link[0]?.declaredOnly).toBe(true);
    expect(link[0]?.declared).toBe(true);
  });
});

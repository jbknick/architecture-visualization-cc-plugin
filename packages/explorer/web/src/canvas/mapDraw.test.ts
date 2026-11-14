// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../../mock/hierarchy.ts";
import { projectMapLarge } from "../../mock/largeMap.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import { kindTier } from "./hierarchy.ts";
import { computeLayout } from "./layout.ts";
import { distanceToPolyline, drawMap, edgeWidth, pickCell, rectOf } from "./mapDraw.ts";
import { headPx, screenRectOf } from "./mapGeom.ts";
import { FIT_INSETS } from "./mapLayout.ts";
import { segmentHitsBox } from "./route.ts";
import { buildScene, folderTitle, layoutInputFor, nodeTitle, subtitleParts } from "./scene.ts";
import { contrastRatio, inkAgainst, readTheme } from "./style.ts";

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

  it("names the repo-root workspace's type '(repo root)' where the others show app / package", () => {
    const scene = buildScene(
      [
        {
          id: "ws:.",
          kind: "workspace",
          label: "acme-root",
          size: 1,
          badges: ["app"],
          stats: { files: 9, functions: 17 },
        },
        {
          id: "ws:pkg",
          kind: "workspace",
          label: "pkg",
          size: 1,
          badges: ["package"],
          stats: { files: 2, functions: 5 },
        },
      ],
      [],
    );
    const root = scene.tree.index.get("ws:.") as number;
    const pkg = scene.tree.index.get("ws:pkg") as number;
    expect(subtitleParts(scene, root)).toEqual(["(repo root)", "17 functions", "9 files"]);
    expect(subtitleParts(scene, pkg)[0]).toBe("package");
  });

  it("grows with the square root of the weight, clamped", () => {
    expect(edgeWidth(1)).toBeCloseTo(1.1, 5);
    expect(edgeWidth(100)).toBeCloseTo(3.8, 5);
    expect(edgeWidth(640)).toBeGreaterThan(edgeWidth(410));
    expect(edgeWidth(640)).toBeLessThanOrEqual(8); // lanes are 10px apart
    expect(edgeWidth(1_000_000)).toBe(8);
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

describe("the large mock, drawn at the fit zoom of a 1180 x 812 canvas", () => {
  const VIEW = { w: 1180, h: 812 };
  async function drawLarge(level: "workspaces" | "dirs" | "files", showDeclared = false, zoom = 1) {
    const view = projectMapLarge({ focus: null, level, options: {} });
    if ("error" in view) throw new Error(view.error);
    const scene = buildScene(view.nodes, view.edges, "nested-elk");
    const out = await computeLayout(layoutInputFor(scene, "nested-elk", null, undefined, VIEW));
    if (!out.map) throw new Error("no map geometry");
    const b = out.map.bounds;
    const aw = VIEW.w - FIT_INSETS.left - FIT_INSETS.right;
    const ah = VIEW.h - FIT_INSETS.top - FIT_INSETS.bottom;
    const scale = Math.min(aw / (b.w + 6), ah / (b.h + 6));
    const fit = {
      scale,
      tx: FIT_INSETS.left + (aw - (b.w + 6) * scale) / 2 - (b.x - 3) * scale,
      ty: FIT_INSETS.top + (ah - (b.h + 6) * scale) / 2 - (b.y - 3) * scale,
    };
    // Zoomed about the middle of the canvas.
    const cam = {
      scale: fit.scale * zoom,
      tx: VIEW.w / 2 - (VIEW.w / 2 - fit.tx) * zoom,
      ty: VIEW.h / 2 - (VIEW.h / 2 - fit.ty) * zoom,
    };
    const result = drawMap({
      ctx: stubContext(),
      w: VIEW.w,
      h: VIEW.h,
      scene,
      geo: out.map,
      theme: readTheme(null),
      cam,
      selected: null,
      hovered: null,
      highlightWs: null,
      showDeclared,
      bright: null,
      links: [],
      hoverEdge: null,
    });
    return { scene, result, cam, geo: out.map };
  }
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("numbers every arrow when there are 40 or fewer, with no two pills overlapping and none on a box", async () => {
    const { result } = await drawLarge("workspaces");
    expect(result.edgeHits).toHaveLength(23);
    expect(result.pills).toHaveLength(23);
    expect(new Set(result.pills.map((p) => p.key)).size).toBe(23);
    for (let a = 0; a < result.pills.length; a++) {
      const p = result.pills[a] as (typeof result.pills)[number];
      for (const box of result.boxes) expect(overlap(p, box), `${p.key} on a box`).toBe(false);
      for (let b = a + 1; b < result.pills.length; b++)
        expect(overlap(p, result.pills[b] as typeof p), `${p.key} / ${result.pills[b]?.key}`).toBe(false);
    }
  });

  it("puts every pill on its own route and clear of the other routes, except where a channel is full", async () => {
    const { result } = await drawLarge("workspaces");
    const report: string[] = [];
    for (const p of result.pills) {
      const own = result.edgeHits.find((e) => e.key === p.key);
      if (!own) throw new Error(`no route for ${p.key}`);
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      // On its own route (the pill is centred on a straight stretch of it).
      expect(distanceToPolyline(cx, cy, own.route), `${p.key} is on its route`).toBeLessThan(1);
      for (const other of result.edgeHits) {
        if (other.key === p.key) continue;
        for (let s = 1; s < other.route.length; s++) {
          const a = other.route[s - 1] as [number, number];
          const b = other.route[s] as [number, number];
          // Orthogonal segments: the stroke touches the pill when the ranges overlap on both axes.
          const x0 = Math.min(a[0], b[0]) - other.width / 2;
          const x1 = Math.max(a[0], b[0]) + other.width / 2;
          const y0 = Math.min(a[1], b[1]) - other.width / 2;
          const y1 = Math.max(a[1], b[1]) + other.width / 2;
          if (x0 < p.x + p.w && x1 > p.x && y0 < p.y + p.h && y1 > p.y)
            report.push(`${p.key.slice(26)} / ${other.key.slice(26)} ${p.count}`);
        }
      }
    }
    // At most two links of this crowded diagram have no clean stretch anywhere (their channel is a bundle of
    // lanes): their pills cover as little of the other lines as they can. Every other pill is clear of all lines.
    const crowded = new Set(report.map((r) => r.split(" ").pop()));
    expect(crowded.size).toBeLessThanOrEqual(2);
  });

  it("numbers only the heaviest arrows above 40 (declared dependencies shown: 54 arrows)", async () => {
    const { result } = await drawLarge("workspaces", true);
    expect(result.edgeHits.length).toBeGreaterThan(40);
    expect(result.pills.length).toBeLessThanOrEqual(8);
  });

  it("routes every arrow around the other boxes: no segment enters the interior of a box that is not its end", async () => {
    for (const level of ["workspaces", "dirs"] as const) {
      const { result } = await drawLarge(level, true);
      for (const e of result.edgeHits) {
        for (const box of result.boxes) {
          if (box.index === e.src || box.index === e.dst) continue;
          for (let s = 1; s < e.route.length; s++) {
            const p = e.route[s - 1] as [number, number];
            const q = e.route[s] as [number, number];
            expect(
              segmentHitsBox(p, q, {
                x0: box.x + 1,
                y0: box.y + 1,
                x1: box.x + box.w - 1,
                y1: box.y + box.h - 1,
              }),
              `${level} ${e.key} through box ${box.index}`,
            ).toBe(false);
            expect(p[0] === q[0] || p[1] === q[1], `${e.key} is orthogonal`).toBe(true);
          }
        }
      }
    }
  });

  it("draws the two directions of a pair in lanes at least 10px apart, each pill on its own lane", async () => {
    const { scene, result, cam } = await drawLarge("workspaces");
    const id = (name: string) => `ws:@acme-platform-monorepo/${name}`;
    const fwd = result.edgeHits.find((e) => e.key === `${id("api")}>${id("core")}`);
    const back = result.edgeHits.find((e) => e.key === `${id("core")}>${id("api")}`);
    if (!fwd || !back) throw new Error("api <-> core arrows missing");
    expect(scene.wsEdges.some((e) => e.weight === 3)).toBe(true);
    for (const [x, y] of fwd.route)
      expect(distanceToPolyline(x, y, back.route)).toBeGreaterThanOrEqual(10 * cam.scale - 0.5);
    for (const [x, y] of back.route)
      expect(distanceToPolyline(x, y, fwd.route)).toBeGreaterThanOrEqual(10 * cam.scale - 0.5);
    // Each pill is nearer to its own lane than to the other one.
    for (const [own, other, count] of [
      [fwd, back, "640"],
      [back, fwd, "3"],
    ] as const) {
      const pill = result.pills.find((p) => p.key === own.key);
      expect(pill?.count).toBe(count);
      const cx = (pill?.x ?? 0) + (pill?.w ?? 0) / 2;
      const cy = (pill?.y ?? 0) + (pill?.h ?? 0) / 2;
      expect(distanceToPolyline(cx, cy, own.route)).toBeLessThan(distanceToPolyline(cx, cy, other.route));
    }
  });

  it("gives each link its own port, at least 12px apart, and arrowheads of at least 11px", async () => {
    const { result, cam } = await drawLarge("workspaces");
    const ends = new Map<number, [number, number][]>();
    const starts = new Map<number, [number, number][]>();
    for (const e of result.edgeHits) {
      const list = ends.get(e.dst) ?? [];
      list.push(e.route[e.route.length - 1] as [number, number]);
      ends.set(e.dst, list);
      const out = starts.get(e.src) ?? [];
      out.push(e.route[0] as [number, number]);
      starts.set(e.src, out);
      expect(e.head, `${e.key}: arrowhead`).toBeGreaterThanOrEqual(11);
    }
    for (const list of [...ends.values(), ...starts.values()])
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i] as [number, number];
          const q = list[j] as [number, number];
          expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThanOrEqual(12 * cam.scale - 0.5);
        }
  });

  it("colours every line, arrowhead and pill by the importing workspace, and never fades the light ones", async () => {
    const { scene, result } = await drawLarge("workspaces", true);
    const bySource = new Map<number, Set<string>>();
    for (const e of result.edgeHits) {
      bySource.set(e.src, (bySource.get(e.src) ?? new Set()).add(e.colour));
      expect(e.width, `${e.key} width`).toBeGreaterThanOrEqual(1.25);
      expect(e.alpha, `${e.key} opacity`).toBeGreaterThanOrEqual(0.55);
    }
    // One colour per source workspace, a different one for each.
    for (const set of bySource.values()) expect(set.size).toBe(1);
    const colours = [...bySource.values()].map((s) => [...s][0]);
    expect(new Set(colours).size).toBe(bySource.size);
    expect(bySource.size).toBeGreaterThanOrEqual(8);
    expect(scene.roots.length).toBe(11);
  });

  it("keeps the link ink readable on both themes (3:1 for lines, 4.5:1 for the numbers)", () => {
    for (const scheme of ["light", "dark"] as const) {
      const theme = { ...readTheme(null), scheme };
      const bg = scheme === "light" ? "#f3f4f7" : "#0f1217";
      const surface = scheme === "light" ? "#ffffff" : "#171b22";
      for (let k = 0; k < 12; k++) {
        const colour = workspaceColorAt(k, scheme);
        const line = inkAgainst(colour, bg, scheme, 3);
        const text = inkAgainst(colour, surface, scheme, 4.5);
        expect(contrastRatio(line, bg), `${scheme} ${k} line`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(text, surface), `${scheme} ${k} text`).toBeGreaterThanOrEqual(4.5);
      }
      expect(theme.scheme).toBe(scheme);
    }
  });

  it("shows a folder strip only when it can show the whole folder name, and never cuts the name", async () => {
    let strips = 0;
    for (const zoom of [1, 2, 4, 9]) {
      const { scene, geo, cam, result } = await drawLarge("dirs", false, zoom);
      for (let i = 0; i < scene.tree.nodes.length; i++) {
        const node = scene.tree.nodes[i];
        if (!node || kindTier(node.kind) !== 1 || scene.skipped[i]) continue;
        const r = screenRectOf(scene, geo, cam, i);
        if (r.x > VIEW.w || r.y > VIEW.h || r.x + r.w < 0 || r.y + r.h < 0 || r.w < 2 || r.h < 2) continue;
        const head = headPx(scene, geo, i, r.w, r.h, cam.scale);
        const label = result.labels.find((l) => l.id === node.id && l.kind === "folder");
        if (head === 0) {
          // No strip, no glyph, no name: the tiles stay and the name shows on hover.
          expect(label, `${node.id} has no strip but a label`).toBeUndefined();
          continue;
        }
        strips++;
        expect(label, `${node.id} has a strip with no name`).toBeDefined();
        const shown = (label?.lines ?? [])
          .join(" ")
          .replace(/( ·)? [\d,]+ fn$/, "")
          .replace(/\s+/g, "");
        expect(shown, node.id).toBe(folderTitle(scene, i).replace(/\s+/g, ""));
        expect(shown).not.toContain("…");
        expect(shown).not.toContain("...");
      }
    }
    expect(strips).toBeGreaterThan(20);
  });

  it("never cuts a folder name that has 90px or more, and never prints a file name with an ellipsis", async () => {
    const dirs = await drawLarge("dirs");
    const folders = dirs.result.labels.filter((l) => l.kind === "folder");
    expect(folders.length).toBeGreaterThan(10);
    for (const l of folders) {
      expect(l.lines.length).toBeLessThanOrEqual(2);
      if (l.cellW >= 90) expect(l.lines.join(""), l.id).not.toContain("…");
    }
    const files = await drawLarge("files");
    for (const l of files.result.labels.filter((x) => x.kind === "file"))
      if (l.cellW < 140) expect(l.lines.join(""), l.id).not.toContain("…");
  });
});

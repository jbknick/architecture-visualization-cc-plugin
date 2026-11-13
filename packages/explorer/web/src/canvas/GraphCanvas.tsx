import "./canvas.css";
import Graph from "graphology";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sigma from "sigma";
import { extremityArrow } from "sigma/rendering";
import { api } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { deriveRegions, isContainer, isRegion, type TreeNode } from "./hierarchy.ts";
import { Legend } from "./Legend.tsx";
import { runLayout } from "./layoutClient.ts";
import { distanceToPolyline, drawOverlay, type OverlayResult } from "./overlay.ts";
import { hashPositions } from "./prng.ts";
import { brightSet, buildScene, layoutInputFor, relatedSet } from "./scene.ts";
import { makeSigmaStyles } from "./sigmaStyles.ts";
import { type CanvasTheme, kindColor, readTheme, workspaceColor } from "./style.ts";
import type { LayoutResult, Positions, Rect } from "./types.ts";
import { type Level, levelForRatio, nodeTier, regionTier } from "./zoom.ts";

export interface GraphCanvasProps extends CanvasProps {
  /** View id used as the key for saved positions. Omit to skip persistence. */
  viewId?: string | null;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

/** Sigma's y axis points up on screen; layouts are y-down, so graph y is stored negated. */
const SY = -1;
const FIT_MARGIN = 40;
const MAX_LABEL_CHARS = 26;

interface Live {
  level: Level;
  theme: CanvasTheme;
  bright: Set<number> | null;
  related: Set<number> | null;
  selected: number | null;
  hoverEdge: string | null;
}

function shortLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

function plain(id: string): string {
  return id.replace(/^(sym|file|ws|dir):/, "");
}

export function GraphCanvas({
  nodes,
  edges,
  layoutHint,
  focus,
  onSelect,
  onHover,
  onDrill,
  viewId,
}: GraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme(null));
  const [layout, setLayout] = useState<(LayoutResult & { key: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("far");
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);
  const live = useRef<Live>({
    level: "far",
    theme,
    bright: null,
    related: null,
    selected: null,
    hoverEdge: null,
  });
  const api2 = useRef<{
    fit(): void;
    zoom(factor: number): void;
    zoomTo(index: number): void;
    redraw(): void;
    refresh(): void;
  } | null>(null);
  const callbacks = useRef({ onSelect, onHover, onDrill });
  callbacks.current = { onSelect, onHover, onDrill };
  const internalSelect = useRef(false);

  const scene = useMemo(() => buildScene(nodes, edges, layoutHint), [nodes, edges, layoutHint]);
  const sceneKey = useMemo(
    () => `${scene.nodes.length}:${scene.edges.length}:${scene.nodes[0]?.id ?? ""}`,
    [scene],
  );
  const persist = Boolean(viewId) && layoutHint !== "radial";

  // Theme: follow the shell's CSS variables and the OS colour scheme.
  useEffect(() => {
    const update = () => setTheme(readTheme(wrapRef.current));
    update();
    const mq =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", update);
    return () => mq?.removeEventListener("change", update);
  }, []);

  // Layout in a worker; saved positions first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the layout (Re-layout button)
  useEffect(() => {
    let alive = true;
    setError(null);
    const useFresh = fresh.current;
    fresh.current = false;
    let cancel = () => {};
    (async () => {
      let saved: Positions | undefined;
      if (persist && viewId && !useFresh) {
        try {
          saved = await api.layout(viewId);
        } catch {
          saved = undefined;
        }
      }
      if (!alive) return;
      const centre = scene.nodes.find((n) => n.side === "focus")?.id ?? focus;
      const job = runLayout(
        layoutInputFor(scene, layoutHint, layoutHint === "radial" ? centre : null, saved),
      );
      cancel = job.cancel;
      const result = await job.promise;
      if (!alive) return;
      setLayout({ ...result, key: sceneKey });
      if (persist && viewId && result.changed) api.saveLayout(viewId, result.positions).catch(() => {});
    })().catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      alive = false;
      cancel();
    };
    // eslint-disable-next-line: focus only matters to the radial layout
  }, [scene, sceneKey, layoutHint, viewId, persist, tick, layoutHint === "radial" ? focus : null]);

  const regions = useMemo<Map<number, Rect>>(
    () => (layout && layout.key === sceneKey ? deriveRegions(scene.tree, layout.positions) : new Map()),
    [layout, scene, sceneKey],
  );

  // Selection state shared with the reducers.
  const selectedIndex = focus ? (scene.tree.index.get(focus) ?? null) : null;
  useEffect(() => {
    const bright = selectedIndex === null ? null : brightSet(scene, selectedIndex);
    const related = selectedIndex === null ? null : relatedSet(scene, selectedIndex);
    live.current = { ...live.current, theme, bright, related, selected: selectedIndex };
    api2.current?.refresh();
  }, [scene, selectedIndex, theme]);

  // The sigma instance, rebuilt whenever the positions change.
  useEffect(() => {
    const box = boxRef.current;
    const under = underRef.current;
    if (!box || !under || !layout || layout.key !== sceneKey) return;
    const positions = layout.positions;
    const tree = scene.tree;
    const hierarchical = scene.hierarchical;
    const startTheme = live.current.theme;

    const graph = new Graph({ type: "directed", multi: false });
    tree.nodes.forEach((n, i) => {
      const p = positions[n.id] ?? [0, 0];
      const container = isContainer(tree, i);
      const size = !hierarchical
        ? Math.min(16, 6 + 2.2 * Math.sqrt(Math.max(0, scene.nodes[i]?.size ?? 0)))
        : container
          ? Math.min(20, 9 + 1.6 * Math.sqrt(scene.symbolCount[i] ?? 1))
          : n.tier >= 3
            ? 7
            : 10;
      graph.addNode(n.id, {
        x: p[0],
        y: SY * p[1],
        size,
        label: shortLabel(scene.nodes[i]?.label ?? n.id),
        i,
        tier: n.tier,
        kind: n.kind,
        container,
        colorWs: hierarchical
          ? workspaceColor(scene.rootRank.get(n.root) ?? 0, startTheme.scheme)
          : kindColor(n.kind, startTheme.scheme),
        colorKind: kindColor(n.kind, startTheme.scheme),
      });
    });
    for (const e of scene.edges) {
      const a = (tree.nodes[e.src] as TreeNode).id;
      const b = (tree.nodes[e.dst] as TreeNode).id;
      if (hierarchical && (isRegion(tree, e.src) || isRegion(tree, e.dst))) continue;
      if (graph.hasEdge(a, b))
        graph.updateEdgeAttributes(a, b, (attrs) => ({
          ...attrs,
          weight: (attrs.weight as number) + e.weight,
          weightLabel: String((attrs.weight as number) + e.weight),
        }));
      else
        graph.addEdge(a, b, {
          weight: e.weight,
          weightLabel: String(e.weight),
          kind: e.kind,
          src: e.src,
          dst: e.dst,
        });
    }

    const wsColor = (root: number) =>
      workspaceColor(scene.rootRank.get(root) ?? 0, live.current.theme.scheme);

    const nodeVisible = (i: number, lvl: Level): boolean => {
      if (!hierarchical) return true;
      const n = tree.nodes[i] as TreeNode;
      if (n.tier > nodeTier(lvl)) return false;
      if (isRegion(tree, i) && n.tier <= regionTier(lvl)) return false; // drawn as a region instead
      return true;
    };

    // Visual changes (level, selection) are sigma item states set in batches, not reducers: a reducer makes
    // sigma re-evaluate every node and edge whenever the camera starts or stops moving.
    const styles = makeSigmaStyles(startTheme);

    const sigma = new Sigma(graph, box, {
      primitives: { edges: { extremities: [extremityArrow({ lengthRatio: 6, widthRatio: 4.5 })] } },
      styles,
      customNodeState: { dim: false, useKind: false, sel: false },
      customEdgeState: { dim: false, sel: false },
      settings: {
        itemSizesReference: "positions",
        renderEdgeLabels: true,
        hideEdgesOnMove: false,
        enableEdgeEvents: true,
        labelDensity: 1,
        labelGridCellSize: 130,
        labelRenderedSizeThreshold: 0,
        minCameraRatio: 0.0015,
        maxCameraRatio: 12,
        stagePadding: 30,
        autoRescale: true,
      },
    } as never) as Sigma;

    const nodeApplied = new Int16Array(tree.nodes.length).fill(-1);
    const edgeKeys: string[] = [];
    const edgeEnds: [number, number][] = [];
    graph.forEachEdge((key, attrs) => {
      edgeKeys.push(key);
      edgeEnds.push([attrs.src as number, attrs.dst as number]);
    });
    const edgeApplied = new Int16Array(edgeKeys.length).fill(-1);

    /** Pushes the level/selection/theme-dependent item states to sigma, touching only items that changed. */
    const applyFlags = () => {
      const l = live.current;
      const nodeGroups = new Map<number, string[]>();
      for (let i = 0; i < nodeApplied.length; i++) {
        const dim = l.bright !== null && !l.bright.has(i);
        const flags =
          (nodeVisible(i, l.level) ? 0 : 1) |
          (dim ? 2 : 0) |
          (!hierarchical || l.level === "near" ? 4 : 0) |
          (l.selected === i ? 8 : 0);
        if (nodeApplied[i] === flags) continue;
        nodeApplied[i] = flags;
        let list = nodeGroups.get(flags);
        if (!list) {
          list = [];
          nodeGroups.set(flags, list);
        }
        list.push((tree.nodes[i] as TreeNode).id);
      }
      for (const [flags, keys] of nodeGroups) {
        sigma.setNodesState(keys, {
          isHidden: (flags & 1) !== 0,
          dim: (flags & 2) !== 0,
          useKind: (flags & 4) !== 0,
          sel: (flags & 8) !== 0,
        } as never);
      }
      const edgeGroups = new Map<number, string[]>();
      for (let k = 0; k < edgeKeys.length; k++) {
        const [s, d] = edgeEnds[k] as [number, number];
        const incident = l.related !== null && (l.related.has(s) || l.related.has(d));
        const sameRoot = (tree.nodes[s] as TreeNode).root === (tree.nodes[d] as TreeNode).root;
        const shown =
          (!hierarchical || l.level === "near") &&
          nodeVisible(s, l.level) &&
          nodeVisible(d, l.level) &&
          (!hierarchical || sameRoot || incident);
        const flags = (shown ? 0 : 1) | (l.bright !== null && !incident ? 2 : 0) | (incident ? 4 : 0);
        if (edgeApplied[k] === flags) continue;
        edgeApplied[k] = flags;
        let list = edgeGroups.get(flags);
        if (!list) {
          list = [];
          edgeGroups.set(flags, list);
        }
        list.push(edgeKeys[k] as string);
      }
      for (const [flags, keys] of edgeGroups) {
        sigma.setEdgesState(keys, {
          isHidden: (flags & 1) !== 0,
          dim: (flags & 2) !== 0,
          sel: (flags & 4) !== 0,
        } as never);
      }
      sigma.scheduleRender();
    };
    let applyTimer: ReturnType<typeof setTimeout> | null = null;

    // Region-inclusive bounding box so "fit" shows every container fully.
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const p of Object.values(positions)) grow(p[0], p[1]);
    for (const r of regions.values()) {
      grow(r.x, r.y);
      grow(r.x + r.w, r.y + r.h);
    }
    if (x0 === Number.POSITIVE_INFINITY) {
      x0 = y0 = -100;
      x1 = y1 = 100;
    }
    sigma.setCustomBBox({
      x: [x0 - FIT_MARGIN, x1 + FIT_MARGIN],
      y: [SY * (y1 + FIT_MARGIN), SY * (y0 - FIT_MARGIN)].sort((a, b) => a - b) as [number, number],
    });

    const fullRect: Rect = {
      x: x0 - FIT_MARGIN,
      y: y0 - FIT_MARGIN,
      w: x1 - x0 + 2 * FIT_MARGIN,
      h: y1 - y0 + 2 * FIT_MARGIN,
    };

    const ctx = under.getContext("2d");
    let overlay: OverlayResult = { edgeHits: [], regionHits: [] };
    let hoveredNode: string | null = null;

    const project = (x: number, y: number) => sigma.graphToViewport({ x, y: SY * y });
    const draw = () => {
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (under.width !== Math.round(w * dpr) || under.height !== Math.round(h * dpr)) {
        under.width = Math.round(w * dpr);
        under.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const a = project(0, 0);
      const b = project(1, 0);
      const l = live.current;
      overlay = drawOverlay({
        ctx,
        w,
        h,
        scene,
        regions,
        positions,
        level: l.level,
        theme: l.theme,
        project,
        scale: Math.hypot(b.x - a.x, b.y - a.y),
        wsColor,
        bright: l.bright,
        related: l.related,
        hoverEdge: l.hoverEdge,
      });
    };

    const camera = sigma.getCamera();
    // Camera state that shows `fullRect` completely; levels are measured relative to it.
    let fit = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
    const syncLevel = () => {
      const next = hierarchical ? levelForRatio(camera.ratio / fit.ratio) : "near";
      if (next !== live.current.level) {
        live.current = { ...live.current, level: next };
        setLevel(next);
        if (applyTimer) clearTimeout(applyTimer);
        applyTimer = setTimeout(applyFlags, 90);
      }
      box.dataset.level = next;
    };
    camera.on("updated", syncLevel);
    sigma.on("afterRender", draw);

    const targetState = (rect: Rect, padding: number) => {
      const W = box.clientWidth;
      const H = box.clientHeight;
      const probe = { x: 0.5, y: 0.5, angle: 0, ratio: 1 };
      const p1 = sigma.graphToViewport({ x: rect.x, y: SY * rect.y }, { cameraState: probe });
      const p2 = sigma.graphToViewport(
        { x: rect.x + rect.w, y: SY * (rect.y + rect.h) },
        { cameraState: probe },
      );
      const ratio = Math.max(
        Math.abs(p2.x - p1.x) / Math.max(1, W - 2 * padding),
        Math.abs(p2.y - p1.y) / Math.max(1, H - 2 * padding),
        0.0015,
      );
      const centre = sigma.graphToFramedGraph({ x: rect.x + rect.w / 2, y: SY * (rect.y + rect.h / 2) });
      return { x: centre.x, y: centre.y, ratio, angle: 0 };
    };

    api2.current = {
      fit: () => {
        fit = targetState(fullRect, 28);
        camera.animate(fit, { duration: 300 });
      },
      zoom: (factor) =>
        factor > 1
          ? camera.zoomIn({ factor, duration: 200 })
          : camera.zoomOut({ factor: 1 / factor, duration: 200 }),
      zoomTo: (index) => {
        const region = regions.get(index);
        const id = (tree.nodes[index] as TreeNode).id;
        const p = positions[id];
        const rect = region ?? (p ? { x: p[0] - 120, y: p[1] - 80, w: 240, h: 160 } : null);
        if (rect) camera.animate(targetState(rect, 60), { duration: 450 });
      },
      redraw: draw,
      refresh: applyFlags,
    };

    // Hit testing: sigma handles nodes; edges and regions come from the overlay's last frame.
    const local = (clientX: number, clientY: number) => {
      const r = box.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };
    const regionAt = (x: number, y: number): number | null => {
      let best: number | null = null;
      let bestTier = -1;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const r of overlay.regionHits) {
        if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
        const tier = (tree.nodes[r.index] as TreeNode).tier;
        const area = r.w * r.h;
        if (tier > bestTier || (tier === bestTier && area < bestArea)) {
          best = r.index;
          bestTier = tier;
          bestArea = area;
        }
      }
      return best;
    };
    const edgeAt = (x: number, y: number) => {
      let best: OverlayResult["edgeHits"][number] | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const e of overlay.edgeHits) {
        const d = distanceToPolyline(x, y, e.pts);
        if (d < bestD && d <= Math.max(7, e.width / 2 + 4)) {
          best = e;
          bestD = d;
        }
      }
      return best;
    };
    const describe = (i: number): Tooltip["lines"] => {
      const n = tree.nodes[i] as TreeNode;
      const count = scene.symbolCount[i] ?? 0;
      return [
        `${n.kind}${count > 0 && isContainer(tree, i) ? ` · ${count.toLocaleString("en-US")} functions` : ""}`,
        plain(n.id),
      ];
    };
    const setHoverEdge = (key: string | null) => {
      if (live.current.hoverEdge === key) return;
      live.current = { ...live.current, hoverEdge: key };
      draw();
    };

    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        setTooltip(null);
        return;
      }
      const { x, y } = local(event.clientX, event.clientY);
      if (hoveredNode !== null) {
        const i = graph.getNodeAttribute(hoveredNode, "i") as number;
        setTooltip({ x, y, title: scene.nodes[i]?.label ?? hoveredNode, lines: describe(i) });
        setHoverEdge(null);
        return;
      }
      const edge = edgeAt(x, y);
      if (edge) {
        const from = scene.nodes[edge.src]?.label ?? "";
        const to = scene.nodes[edge.dst]?.label ?? "";
        setHoverEdge(edge.key);
        setTooltip({
          x,
          y,
          title: `${from} → ${to}: ${edge.weight.toLocaleString("en-US")} ${edge.noun}`,
          lines: [],
        });
        return;
      }
      setHoverEdge(null);
      const region = regionAt(x, y);
      if (region !== null) {
        setTooltip({ x, y, title: scene.nodes[region]?.label ?? "", lines: describe(region) });
        callbacks.current.onHover(scene.nodes[region]?.id ?? null);
      } else {
        setTooltip(null);
        callbacks.current.onHover(null);
      }
    };
    const onLeave = () => {
      setTooltip(null);
      setHoverEdge(null);
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);
    // Test hook: write the last frame's hit geometry and a hash of the positions to `data-probe`.
    const onProbe = () => {
      box.dataset.probe = JSON.stringify({
        hash: hashPositions(positions),
        edges: overlay.edgeHits.map((e) => {
          const mid = e.pts[Math.floor(e.pts.length / 2)] as [number, number];
          return { key: e.key, x: mid[0], y: mid[1], weight: e.weight };
        }),
        regions: overlay.regionHits.map((r) => ({
          id: scene.nodes[r.index]?.id,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
        })),
      });
    };
    box.addEventListener("gantry:probe", onProbe);

    sigma.on("enterNode", ({ node }) => {
      hoveredNode = node;
      callbacks.current.onHover(node);
      box.style.cursor = "pointer";
    });
    sigma.on("leaveNode", () => {
      hoveredNode = null;
      callbacks.current.onHover(null);
      box.style.cursor = "";
      setTooltip(null);
    });
    sigma.on("clickNode", ({ node }) => {
      internalSelect.current = true;
      callbacks.current.onSelect(node);
    });
    sigma.on("clickStage", ({ event }) => {
      const { x, y } = local(
        event.original instanceof MouseEvent ? event.original.clientX : 0,
        event.original instanceof MouseEvent ? event.original.clientY : 0,
      );
      const region = regionAt(x, y);
      internalSelect.current = true;
      callbacks.current.onSelect(region === null ? null : (scene.nodes[region]?.id ?? null));
    });
    const goInto = (index: number | null) => {
      if (index === null) return;
      const id = (tree.nodes[index] as TreeNode).id;
      // Views that can drill (project map: show the contents, ego: re-centre) get the first say.
      if (callbacks.current.onDrill) callbacks.current.onDrill(id);
      else api2.current?.zoomTo(index);
    };
    sigma.on("doubleClickNode", ({ node, event }) => {
      event.preventSigmaDefault();
      goInto(graph.getNodeAttribute(node, "i") as number);
    });
    sigma.on("doubleClickStage", ({ event }) => {
      event.preventSigmaDefault();
      const o = event.original;
      if (o instanceof MouseEvent) {
        const { x, y } = local(o.clientX, o.clientY);
        goInto(regionAt(x, y));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      setTooltip(null);
      const atFit = Math.abs(camera.ratio - fit.ratio) < 1e-6;
      sigma.resize();
      if (atFit) {
        fit = targetState(fullRect, 28);
        camera.setState(fit);
      }
      sigma.scheduleRender();
    });
    resizeObserver.observe(box);

    live.current = { ...live.current, theme: startTheme, level: "far" };
    fit = targetState(fullRect, 28);
    camera.setState(fit);
    syncLevel();
    applyFlags();
    box.dataset.ready = "true";
    box.dataset.nodes = String(graph.order);

    return () => {
      delete box.dataset.ready;
      resizeObserver.disconnect();
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
      box.removeEventListener("gantry:probe", onProbe);
      api2.current = null;
      if (applyTimer) clearTimeout(applyTimer);
      sigma.kill();
    };
  }, [layout, scene, sceneKey, regions]);

  // Selecting from outside the canvas (search, inspector, deep link) brings the node into view.
  useEffect(() => {
    if (selectedIndex === null) return;
    if (internalSelect.current) {
      internalSelect.current = false;
      return;
    }
    api2.current?.zoomTo(selectedIndex);
  }, [selectedIndex]);

  // Keyboard: + / - zoom, 0 fits, Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") api2.current?.zoom(1.6);
      else if (e.key === "-" || e.key === "_") api2.current?.zoom(1 / 1.6);
      else if (e.key === "0") api2.current?.fit();
      else if (e.key === "Escape") callbacks.current.onSelect(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Test and automation hook: zoom to a node by id without touching the pointer.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      const index = id ? scene.tree.index.get(id) : undefined;
      if (index !== undefined) api2.current?.zoomTo(index);
    };
    el.addEventListener("gantry:zoom-to", handler);
    return () => el.removeEventListener("gantry:zoom-to", handler);
  }, [scene]);

  const relayout = useCallback(() => {
    fresh.current = true;
    setLayout(null);
    setTick((t) => t + 1);
  }, []);

  const busy = !layout || layout.key !== sceneKey;
  const scheme = theme.scheme ?? currentScheme();

  return (
    <div className="gc" ref={wrapRef} data-testid="graph-canvas">
      <canvas ref={underRef} className="gc-under" />
      <div
        ref={boxRef}
        className="gc-sigma"
        role="img"
        aria-label={`Graph of ${nodes.length} nodes and ${edges.length} edges. Press plus or minus to zoom, 0 to fit, Escape to clear.`}
      />
      <div className="gc-controls" role="toolbar" aria-label="Graph controls">
        <button
          type="button"
          className="gc-btn"
          onClick={() => api2.current?.zoom(1.6)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          type="button"
          className="gc-btn"
          onClick={() => api2.current?.zoom(1 / 1.6)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button
          type="button"
          className="gc-btn wide"
          onClick={() => api2.current?.fit()}
          title="Fit to view (0)"
        >
          Fit
        </button>
        <button
          type="button"
          className="gc-btn wide"
          onClick={relayout}
          title="Recompute the layout and save it"
        >
          Re-layout
        </button>
      </div>
      <Legend scene={scene} scheme={scheme} level={level} />
      <div className="gc-status" aria-live="polite">
        {error
          ? `Layout failed: ${error}`
          : busy
            ? `Laying out ${nodes.length.toLocaleString("en-US")} nodes…`
            : `${layout.strategy} · ${layout.ms} ms · ${level} zoom`}
      </div>
      {tooltip && (
        <div className="gc-tooltip" role="tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}>
          <strong>{tooltip.title}</strong>
          {tooltip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

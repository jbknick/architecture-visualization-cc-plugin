import "./canvas.css";
import Graph from "graphology";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sigma from "sigma";
import { extremityArrow } from "sigma/rendering";
import { api } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { getFilterPanel } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import type { TreeNode } from "./hierarchy.ts";
import { Legend } from "./Legend.tsx";
import { runLayout } from "./layoutClient.ts";
import { hashPositions } from "./prng.ts";
import { brightSet, buildScene, layoutInputFor, relatedSet, type Scene } from "./scene.ts";
import { makeSigmaStyles } from "./sigmaStyles.ts";
import { type CanvasTheme, kindColor, readTheme } from "./style.ts";
import { TreemapCanvas } from "./TreemapCanvas.tsx";
import type { LayoutResult, Positions } from "./types.ts";

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
  theme: CanvasTheme;
  bright: Set<number> | null;
  related: Set<number> | null;
  selected: number | null;
}

function shortLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

function plain(id: string): string {
  return id.replace(/^(sym|file|ws|dir):/, "");
}

/**
 * The canvas for every 2D view. Hierarchical views (the project map: workspaces, folders, files, functions)
 * get the treemap canvas; flat graphs (ego, debug) keep the sigma force/layered canvas.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const { nodes, edges, layoutHint, viewId } = props;
  const scene = useMemo(() => buildScene(nodes, edges, layoutHint), [nodes, edges, layoutHint]);
  if (scene.hierarchical) {
    const panelLegend = Boolean(viewId) && getFilterPanel(viewId ?? "") !== null;
    return <TreemapCanvas {...props} scene={scene} panelLegend={panelLegend} />;
  }
  return <FlatGraphCanvas {...props} scene={scene} />;
}

function FlatGraphCanvas({
  scene,
  nodes,
  edges,
  layoutHint,
  focus,
  onSelect,
  onHover,
  onDrill,
  viewId,
}: GraphCanvasProps & { scene: Scene }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme(null));
  const [layout, setLayout] = useState<(LayoutResult & { key: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);
  const live = useRef<Live>({ theme, bright: null, related: null, selected: null });
  const api2 = useRef<{
    fit(): void;
    zoom(factor: number): void;
    zoomTo(index: number): void;
    refresh(): void;
  } | null>(null);
  const callbacks = useRef({ onSelect, onHover, onDrill });
  callbacks.current = { onSelect, onHover, onDrill };
  const internalSelect = useRef(false);

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
    const startTheme = live.current.theme;

    const graph = new Graph({ type: "directed", multi: false });
    tree.nodes.forEach((n, i) => {
      const p = positions[n.id] ?? [0, 0];
      graph.addNode(n.id, {
        x: p[0],
        y: SY * p[1],
        size: Math.min(16, 6 + 2.2 * Math.sqrt(Math.max(0, scene.nodes[i]?.size ?? 0))),
        label: shortLabel(scene.nodes[i]?.label ?? n.id),
        i,
        tier: n.tier,
        kind: n.kind,
        colorWs: kindColor(n.kind, startTheme.scheme),
        colorKind: kindColor(n.kind, startTheme.scheme),
      });
    });
    for (const e of scene.edges) {
      const a = (tree.nodes[e.src] as TreeNode).id;
      const b = (tree.nodes[e.dst] as TreeNode).id;
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

    // Visual changes (selection) are sigma item states set in batches, not reducers: a reducer makes sigma
    // re-evaluate every node and edge whenever the camera starts or stops moving.
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

    /** Pushes the selection/theme-dependent item states to sigma, touching only items that changed. */
    const applyFlags = () => {
      const l = live.current;
      const nodeGroups = new Map<number, string[]>();
      for (let i = 0; i < nodeApplied.length; i++) {
        const dim = l.bright !== null && !l.bright.has(i);
        const flags = (dim ? 2 : 0) | 4 | (l.selected === i ? 8 : 0);
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
          isHidden: false,
          dim: (flags & 2) !== 0,
          useKind: (flags & 4) !== 0,
          sel: (flags & 8) !== 0,
        } as never);
      }
      const edgeGroups = new Map<number, string[]>();
      for (let k = 0; k < edgeKeys.length; k++) {
        const [s, d] = edgeEnds[k] as [number, number];
        const incident = l.related !== null && (l.related.has(s) || l.related.has(d));
        const flags = (l.bright !== null && !incident ? 2 : 0) | (incident ? 4 : 0);
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
          isHidden: false,
          dim: (flags & 2) !== 0,
          sel: (flags & 4) !== 0,
        } as never);
      }
      sigma.scheduleRender();
    };

    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const p of Object.values(positions)) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    if (x0 === Number.POSITIVE_INFINITY) {
      x0 = y0 = -100;
      x1 = y1 = 100;
    }
    sigma.setCustomBBox({
      x: [x0 - FIT_MARGIN, x1 + FIT_MARGIN],
      y: [SY * (y1 + FIT_MARGIN), SY * (y0 - FIT_MARGIN)].sort((a, b) => a - b) as [number, number],
    });
    const fullRect = {
      x: x0 - FIT_MARGIN,
      y: y0 - FIT_MARGIN,
      w: x1 - x0 + 2 * FIT_MARGIN,
      h: y1 - y0 + 2 * FIT_MARGIN,
    };

    const camera = sigma.getCamera();
    let fit = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
    box.dataset.level = "near";

    const targetState = (rect: { x: number; y: number; w: number; h: number }, padding: number) => {
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
        const p = positions[(tree.nodes[index] as TreeNode).id];
        if (p)
          camera.animate(targetState({ x: p[0] - 120, y: p[1] - 80, w: 240, h: 160 }, 60), { duration: 450 });
      },
      refresh: applyFlags,
    };

    const describe = (i: number): Tooltip["lines"] => {
      const n = tree.nodes[i] as TreeNode;
      return [n.kind, plain(n.id)];
    };
    const local = (clientX: number, clientY: number) => {
      const r = box.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };
    let hoveredNode: string | null = null;
    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        setTooltip(null);
        return;
      }
      const { x, y } = local(event.clientX, event.clientY);
      if (hoveredNode !== null) {
        const i = graph.getNodeAttribute(hoveredNode, "i") as number;
        setTooltip({ x, y, title: scene.nodes[i]?.label ?? hoveredNode, lines: describe(i) });
      } else setTooltip(null);
    };
    const onLeave = () => setTooltip(null);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);
    // Test hook: write a hash of the positions to `data-probe`.
    const onProbe = () => {
      box.dataset.probe = JSON.stringify({ hash: hashPositions(positions), edges: [], regions: [] });
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
    sigma.on("clickStage", () => {
      internalSelect.current = true;
      callbacks.current.onSelect(null);
    });
    sigma.on("doubleClickNode", ({ node, event }) => {
      event.preventSigmaDefault();
      const index = graph.getNodeAttribute(node, "i") as number;
      // Views that can drill (ego: re-centre) get the first say.
      if (callbacks.current.onDrill) callbacks.current.onDrill(node);
      else api2.current?.zoomTo(index);
    });
    sigma.on("doubleClickStage", ({ event }) => event.preventSigmaDefault());

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

    live.current = { ...live.current, theme: startTheme };
    fit = targetState(fullRect, 28);
    camera.setState(fit);
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
      sigma.kill();
    };
  }, [layout, scene, sceneKey]);

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
      <Legend scene={scene} scheme={scheme} level="near" />
      <div className="gc-status" aria-live="polite">
        {error
          ? `Layout failed: ${error}`
          : busy
            ? `Laying out ${nodes.length.toLocaleString("en-US")} nodes…`
            : `${layout.strategy} · ${layout.ms} ms`}
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

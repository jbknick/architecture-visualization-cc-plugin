import "./canvas.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Filters, type GraphNode } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { useStore } from "../store.tsx";
import { currentScheme } from "../theme.ts";
import { GROUP_KIND, kindTier, type TreeNode } from "./hierarchy.ts";
import { Legend } from "./Legend.tsx";
import { runLayout } from "./layoutClient.ts";
import {
  type Camera,
  type CellLink,
  type DrawResult,
  distanceToPolyline,
  drawMap,
  type EdgeHit,
  pickCell,
} from "./mapDraw.ts";
import { worldRectOf } from "./mapGeom.ts";
import { DEFAULT_VIEWPORT, FIT_INSETS } from "./mapLayout.ts";
import { useMapView } from "./mapView.ts";
import { hashPositions } from "./prng.ts";
import { brightSet, buildScene, layoutInputFor, type Scene, selectionLinks } from "./scene.ts";
import { type CanvasTheme, readTheme } from "./style.ts";
import type { LayoutResult, Rect } from "./types.ts";
import { type Level, levelForRatio } from "./zoom.ts";

export interface TreemapCanvasProps extends CanvasProps {
  scene: Scene;
  /** True when the shell shows a legend of its own for this view, so no floating one is drawn. */
  panelLegend: boolean;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

const MAX_SCALE = 90;

/** Debug text (layout strategy, timing, zoom level) is shown only with `?debug=1` or the `gantry.debug` flag. */
export function debugEnabled(): boolean {
  try {
    if (/[?&]debug=1(&|$)/.test(`${window.location.search}&${window.location.hash.split("?")[1] ?? ""}`))
      return true;
    return window.localStorage.getItem("gantry.debug") === "1";
  } catch {
    return false;
  }
}

function plain(id: string): string {
  return id.replace(/^(sym|file|ws|dir):/, "");
}

/** File nodes fetched in the background for the Folders-level mosaic, by request (focus + filters). */
const mosaicCache = new Map<string, GraphNode[]>();

/**
 * Folders level: the response has no files, so ask once for the Files level and keep its file nodes, which fill
 * the folders with a faint mosaic. Returns null until they are there (or when the request fails).
 */
function useMosaicFiles(
  active: boolean,
  view: string | null,
  focus: string | null,
  filters: Filters,
): GraphNode[] | null {
  const key = JSON.stringify([view, focus, filters]);
  const [loaded, setLoaded] = useState<{ key: string; files: GraphNode[] } | null>(() => {
    const hit = mosaicCache.get(key);
    return hit ? { key, files: hit } : null;
  });
  useEffect(() => {
    if (!active || !view) return;
    const hit = mosaicCache.get(key);
    if (hit) {
      setLoaded({ key, files: hit });
      return;
    }
    const controller = new AbortController();
    api.view(view, { focus: focus ?? undefined, level: "files", filters }, controller.signal).then(
      (data) => {
        const files = data.nodes.filter((n) => n.kind === "file");
        mosaicCache.set(key, files);
        setLoaded({ key, files });
      },
      () => {}, // the mosaic is decoration: without it the folders stay plain
    );
    return () => controller.abort();
  }, [active, view, focus, filters, key]);
  return active && loaded?.key === key ? loaded.files : null;
}

/** The hierarchical map: workspace boxes in a layered diagram, a treemap inside each, drawn on one canvas. */
export function TreemapCanvas({
  scene: baseScene,
  nodes,
  edges,
  layoutHint,
  focus,
  onSelect,
  onHover,
  onDrill,
  panelLegend,
}: TreemapCanvasProps) {
  const { view, state } = useStore();
  const { route } = state;
  // Folders level: file cells arrive in the background and are drawn as a faint mosaic (see `useMosaicFiles`).
  const wantMosaic =
    route.level === "dirs" && layoutHint === "nested-elk" && !baseScene.nodes.some((n) => n.kind === "file");
  const mosaicFiles = useMosaicFiles(wantMosaic, view, route.focus, route.filters);
  const scene = useMemo(() => {
    if (!mosaicFiles || mosaicFiles.length === 0) return baseScene;
    const known = new Set(baseScene.nodes.map((n) => n.id));
    const files = mosaicFiles.filter((f) => f.parent && known.has(f.parent) && !known.has(f.id));
    return files.length === 0
      ? baseScene
      : buildScene([...baseScene.nodes, ...files], edges, layoutHint, { mosaic: true });
  }, [baseScene, mosaicFiles, edges, layoutHint]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme(null));
  const [layout, setLayout] = useState<(LayoutResult & { key: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("far");
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [tick, setTick] = useState(0);
  const layoutViewport = useRef<{ w: number; h: number } | null>(null);
  const ui = useMapView();
  const debug = useMemo(debugEnabled, []);
  const callbacks = useRef({ onSelect, onHover, onDrill });
  callbacks.current = { onSelect, onHover, onDrill };
  const internalSelect = useRef(false);
  const engine = useRef<{
    fit(animate?: boolean): void;
    zoom(factor: number): void;
    zoomTo(index: number): void;
    redraw(): void;
  } | null>(null);
  const live = useRef({
    theme,
    selected: null as number | null,
    hovered: null as number | null,
    highlightWs: null as number | null,
    panelHover: null as number | null,
    showDeclared: false,
    bright: null as Set<number> | null,
    links: [] as CellLink[],
    hoverEdge: null as string | null,
  });

  const sceneKey = useMemo(
    () =>
      `${scene.nodes.length}:${scene.edges.length}:${scene.nodes[0]?.id ?? ""}:${scene.nodes.at(-1)?.id ?? ""}`,
    [scene],
  );

  // Theme: follow the shell's CSS variables and the OS colour scheme.
  useEffect(() => {
    const update = () => setTheme(readTheme(wrapRef.current));
    update();
    const mq =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", update);
    return () => mq?.removeEventListener("change", update);
  }, []);

  // Layout in a worker. Deterministic, so nothing is saved: positions follow from the data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the layout (Re-layout button)
  useEffect(() => {
    let alive = true;
    setError(null);
    let cancel = () => {};
    let frames = 0;
    // The layout is made for the canvas's real size, so wait (a few frames at most) until it has one.
    const start = () => {
      if (!alive) return;
      const box = boxRef.current;
      const sized = box && box.clientWidth > 0 && box.clientHeight > 0;
      if (!sized && frames++ < 30) {
        requestAnimationFrame(start);
        return;
      }
      const viewport = sized ? { w: box.clientWidth, h: box.clientHeight } : DEFAULT_VIEWPORT;
      layoutViewport.current = viewport;
      const job = runLayout(layoutInputFor(scene, layoutHint, null, undefined, viewport));
      cancel = job.cancel;
      job.promise.then(
        (result) => {
          if (alive) setLayout({ ...result, key: sceneKey });
        },
        (err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        },
      );
    };
    start();
    return () => {
      alive = false;
      cancel();
    };
  }, [scene, sceneKey, layoutHint, tick]);

  // Selection and highlight state shared with the draw loop.
  const selectedIndex = focus ? (scene.tree.index.get(focus) ?? null) : null;
  const hoverWsIndex = ui.hoverWorkspace ? (scene.tree.index.get(ui.hoverWorkspace) ?? null) : null;
  useEffect(() => {
    const selectedTier =
      selectedIndex === null ? -1 : kindTier((scene.tree.nodes[selectedIndex] as TreeNode).kind);
    live.current = {
      ...live.current,
      theme,
      selected: selectedIndex,
      bright: selectedIndex === null ? null : brightSet(scene, selectedIndex),
      links: selectedIndex !== null && selectedTier > 0 ? selectionLinks(scene, selectedIndex) : [],
      showDeclared: ui.showDeclared,
      panelHover: hoverWsIndex,
      highlightWs:
        selectedIndex !== null && selectedTier === 0
          ? selectedIndex
          : selectedIndex === null
            ? hoverWsIndex
            : null,
    };
    engine.current?.redraw();
  }, [scene, selectedIndex, theme, ui.showDeclared, hoverWsIndex]);

  // The camera, pointer handling and the draw loop, rebuilt whenever the layout changes.
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const map = layout?.map;
    if (!box || !canvas || !layout || layout.key !== sceneKey || !map) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const geo = map;
    const tree = scene.tree;

    const cam: Camera = { scale: 1, tx: 0, ty: 0 };
    let fitScale = 1;
    let userMoved = false;
    let last: DrawResult = {
      edgeHits: [],
      boxes: [],
      hiddenTitles: new Set(),
      titles: new Map(),
      titleTexts: new Map(),
      pills: [],
    };
    let raf = 0;
    let anim = 0;
    let hoverEdge: EdgeHit | null = null;
    /** Where the running camera animation ends; repeated zoom steps build on it, not on the half-way state. */
    let animTarget: Camera | null = null;

    const size = () => ({ w: box.clientWidth, h: box.clientHeight });
    const fitTarget = (rect: Rect, pad: { top: number; right: number; bottom: number; left: number }) => {
      const { w, h } = size();
      const aw = Math.max(40, w - pad.left - pad.right);
      const ah = Math.max(40, h - pad.top - pad.bottom);
      const scale = Math.min(aw / Math.max(rect.w, 1), ah / Math.max(rect.h, 1));
      return {
        scale,
        tx: pad.left + (aw - rect.w * scale) / 2 - rect.x * scale,
        ty: pad.top + (ah - rect.h * scale) / 2 - rect.y * scale,
      };
    };
    const bounds = (): Rect => ({
      x: geo.bounds.x - 3,
      y: geo.bounds.y - 3,
      w: geo.bounds.w + 6,
      h: geo.bounds.h + 6,
    });

    const draw = () => {
      raf = 0;
      const { w, h } = size();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const l = live.current;
      last = drawMap({
        ctx,
        w,
        h,
        scene,
        geo,
        theme: l.theme,
        cam,
        selected: l.selected,
        hovered: l.hovered,
        panelHover: l.panelHover,
        highlightWs:
          l.highlightWs ??
          (l.hovered !== null && l.selected === null ? (tree.nodes[l.hovered] as TreeNode).root : null),
        showDeclared: l.showDeclared,
        bright: l.bright,
        links: l.links,
        hoverEdge: l.hoverEdge,
      });
      const next = levelForRatio(fitScale / cam.scale);
      if (box.dataset.level !== next) {
        box.dataset.level = next;
        setLevel(next);
      }
      box.dataset.ready = "true";
    };
    const requestDraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const setCam = (c: Camera) => {
      cam.scale = c.scale;
      cam.tx = c.tx;
      cam.ty = c.ty;
      requestDraw();
    };
    const animateTo = (target: Camera, ms: number) => {
      cancelAnimationFrame(anim);
      animTarget = target;
      const from = { ...cam };
      const t0 = performance.now();
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (ms <= 0 || reduced) {
        animTarget = null;
        setCam(target);
        return;
      }
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        // Interpolate the scale geometrically so zooming feels even.
        const scale = from.scale * (target.scale / from.scale) ** e;
        // Keep the screen point that maps to the target centre moving linearly.
        setCam({
          scale,
          tx: from.tx + (target.tx - from.tx) * e,
          ty: from.ty + (target.ty - from.ty) * e,
        });
        if (t < 1) anim = requestAnimationFrame(step);
        else animTarget = null;
      };
      anim = requestAnimationFrame(step);
    };

    const doFit = (animate: boolean) => {
      const target = fitTarget(bounds(), FIT_INSETS);
      fitScale = target.scale;
      userMoved = false;
      if (animate) animateTo(target, 300);
      else {
        cancelAnimationFrame(anim);
        animTarget = null;
        setCam(target);
      }
    };

    const zoomAbout = (px: number, py: number, factor: number, animate = false) => {
      const from = animate && animTarget ? animTarget : cam;
      const next = Math.min(fitScale * MAX_SCALE, Math.max(fitScale * 0.35, from.scale * factor));
      const k = next / from.scale;
      const target = { scale: next, tx: px - (px - from.tx) * k, ty: py - (py - from.ty) * k };
      userMoved = true;
      if (animate) animateTo(target, 200);
      else {
        cancelAnimationFrame(anim);
        animTarget = null;
        setCam(target);
      }
    };

    engine.current = {
      fit: (animate = true) => doFit(animate),
      zoom: (factor) => {
        const { w, h } = size();
        zoomAbout(w / 2, h / 2, factor, true);
      },
      zoomTo: (index) => {
        const pad = { top: 70, right: 60, bottom: 60, left: 60 };
        // Headers keep their size on screen, so the cell's rectangle depends on the zoom: fit, then fit again to
        // the rectangle it has at that zoom.
        let t = fitTarget(worldRectOf(scene, geo, index, fitScale), pad);
        for (let k = 0; k < 2; k++) t = fitTarget(worldRectOf(scene, geo, index, t.scale), pad);
        userMoved = true;
        animateTo({ ...t, scale: Math.min(t.scale, fitScale * MAX_SCALE) }, 450);
      },
      redraw: requestDraw,
    };

    // ---- pointer handling -------------------------------------------------------------------------
    const local = (e: { clientX: number; clientY: number }) => {
      const r = box.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const edgeAt = (x: number, y: number): EdgeHit | null => {
      let best: EdgeHit | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const e of last.edgeHits) {
        const d = distanceToPolyline(x, y, e.pts);
        if (d < bestD && d <= Math.max(7, e.width / 2 + 4)) {
          best = e;
          bestD = d;
        }
      }
      return best;
    };
    /** The "(root files)" group is not a node of the repo: clicking it means its parent. */
    const realId = (i: number): string => {
      const n = tree.nodes[i] as TreeNode;
      return n.kind === GROUP_KIND && n.parent !== -1 ? (tree.nodes[n.parent] as TreeNode).id : n.id;
    };
    const describe = (i: number): string[] => {
      const n = tree.nodes[i] as TreeNode;
      const node = scene.nodes[i];
      const lines: string[] = [];
      if (n.kind === GROUP_KIND) {
        const paths = n.children.map((c) => scene.nodes[c]?.path ?? plain((tree.nodes[c] as TreeNode).id));
        return [
          `${paths.length} loose ${paths.length === 1 ? "file" : "files"} next to the folders`,
          ...paths.slice(0, 12),
          ...(paths.length > 12 ? [`and ${paths.length - 12} more`] : []),
        ];
      }
      const fn = scene.functions[i] ?? 0;
      const files = scene.files[i] ?? 0;
      const bits = [n.kind];
      const cls = kindTier(n.kind);
      if (cls < 3) bits.push(`${fn.toLocaleString("en-US")} functions`);
      if (cls < 2 && files > 0) bits.push(`${files.toLocaleString("en-US")} files`);
      if (node?.stats?.loc) bits.push(`${node.stats.loc.toLocaleString("en-US")} lines`);
      lines.push(bits.join(" · "));
      lines.push(node?.path ?? plain(n.id));
      return lines;
    };
    const setHover = (i: number | null) => {
      if (live.current.hovered === i) return;
      live.current = { ...live.current, hovered: i };
      callbacks.current.onHover(i === null ? null : realId(i));
      requestDraw();
    };
    const setHoverEdge = (key: string | null) => {
      if (live.current.hoverEdge === key) return;
      live.current = { ...live.current, hoverEdge: key };
      requestDraw();
    };

    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty, moved: false, id: e.pointerId };
      box.setPointerCapture?.(e.pointerId);
      cancelAnimationFrame(anim);
      animTarget = null;
    };
    const onMove = (e: PointerEvent) => {
      if (drag && e.buttons !== 0) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          userMoved = true;
          setTooltip(null);
          cam.tx = drag.tx + dx;
          cam.ty = drag.ty + dy;
          requestDraw();
        }
        return;
      }
      const { x, y } = local(e);
      const cell = pickCell(scene, geo, cam, x, y);
      const edge = cell === null ? edgeAt(x, y) : null;
      if (edge) {
        hoverEdge = edge;
        setHover(null);
        setHoverEdge(edge.key);
        const from = scene.nodes[edge.src]?.label ?? "";
        const to = scene.nodes[edge.dst]?.label ?? "";
        setTooltip({
          x,
          y,
          title: edge.declaredOnly
            ? `${from} → ${to}: declared dependency`
            : `${from} → ${to}: ${edge.weight.toLocaleString("en-US")} ${edge.weight === 1 && edge.noun === "imports" ? "import" : edge.noun}`,
          lines: edge.declared && !edge.declaredOnly ? ["also declared in package.json"] : [],
        });
        return;
      }
      hoverEdge = null;
      setHoverEdge(null);
      setHover(cell);
      box.style.cursor = cell === null ? "" : "pointer";
      if (cell === null) setTooltip(null);
      else setTooltip({ x, y, title: scene.nodes[cell]?.label ?? "", lines: describe(cell) });
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      box.releasePointerCapture?.(e.pointerId);
      if (wasDrag) return;
      const { x, y } = local(e);
      const cell = pickCell(scene, geo, cam, x, y);
      internalSelect.current = true;
      if (cell === null && hoverEdge) return;
      callbacks.current.onSelect(cell === null ? null : realId(cell));
    };
    const onLeave = () => {
      setTooltip(null);
      setHoverEdge(null);
      setHover(null);
    };
    const onDouble = (e: MouseEvent) => {
      const { x, y } = local(e);
      const cell = pickCell(scene, geo, cam, x, y);
      if (cell === null) return;
      const id = realId(cell);
      if (callbacks.current.onDrill) callbacks.current.onDrill(id);
      else engine.current?.zoomTo(cell);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAbout(x, y, Math.exp(-dy * 0.0016));
      setTooltip(null);
    };
    box.addEventListener("pointerdown", onDown);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointerleave", onLeave);
    box.addEventListener("dblclick", onDouble);
    box.addEventListener("wheel", onWheel, { passive: false });

    // Test hook: write the last frame's hit geometry and a hash of the positions to `data-probe`.
    const onProbe = () => {
      box.dataset.probe = JSON.stringify({
        hash: hashPositions(layout.positions),
        scale: cam.scale,
        fitScale,
        panelHover: live.current.panelHover === null ? null : scene.nodes[live.current.panelHover]?.id,
        hiddenTitles: [...last.hiddenTitles].map((i) => scene.nodes[i]?.id),
        titles: Object.fromEntries([...last.titles].map(([i, where]) => [scene.nodes[i]?.id, where])),
        titleTexts: Object.fromEntries([...last.titleTexts].map(([i, t]) => [scene.nodes[i]?.id, t])),
        pills: last.pills,
        edges: last.edgeHits.map((e) => {
          const mid = e.pts[Math.floor(e.pts.length / 2)] as [number, number];
          return { key: e.key, x: mid[0], y: mid[1], weight: e.weight };
        }),
        regions: last.boxes.map((b) => ({ id: scene.nodes[b.index]?.id, x: b.x, y: b.y, w: b.w, h: b.h })),
      });
    };
    box.addEventListener("gantry:probe", onProbe);

    // A canvas that changed size a lot (the inspector opened, the window was resized) gets a layout made for its
    // new size, so titles and gaps keep their readable size. Otherwise the camera just refits.
    let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      setTooltip(null);
      const { w, h } = size();
      const made = layoutViewport.current;
      const changed =
        w > 0 &&
        h > 0 &&
        (!made || Math.abs(w - made.w) / made.w > 0.12 || Math.abs(h - made.h) / made.h > 0.12);
      if (!userMoved) doFit(false);
      else requestDraw();
      if (changed && !userMoved) {
        clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(() => setTick((t) => t + 1), 160);
      }
    });
    resizeObserver.observe(box);

    doFit(false);
    box.dataset.nodes = String(tree.nodes.length);
    box.dataset.mosaic = String(scene.mosaic);
    requestDraw();

    return () => {
      delete box.dataset.ready;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(anim);
      clearTimeout(relayoutTimer);
      resizeObserver.disconnect();
      box.removeEventListener("pointerdown", onDown);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointerleave", onLeave);
      box.removeEventListener("dblclick", onDouble);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("gantry:probe", onProbe);
      engine.current = null;
    };
  }, [layout, scene, sceneKey]);

  // Selecting from outside the canvas (search, inspector, deep link) brings the node into view.
  useEffect(() => {
    if (selectedIndex === null) return;
    if (internalSelect.current) {
      internalSelect.current = false;
      return;
    }
    engine.current?.zoomTo(selectedIndex);
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
      if (e.key === "+" || e.key === "=") engine.current?.zoom(1.6);
      else if (e.key === "-" || e.key === "_") engine.current?.zoom(1 / 1.6);
      else if (e.key === "0") engine.current?.fit(true);
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
      if (index !== undefined) engine.current?.zoomTo(index);
    };
    el.addEventListener("gantry:zoom-to", handler);
    return () => el.removeEventListener("gantry:zoom-to", handler);
  }, [scene]);

  const relayout = useCallback(() => {
    setLayout(null);
    setTick((t) => t + 1);
  }, []);

  const busy = !layout || layout.key !== sceneKey;
  const scheme = theme.scheme ?? currentScheme();

  return (
    <div className="gc" ref={wrapRef} data-testid="graph-canvas">
      <canvas ref={canvasRef} className="gc-under" />
      <div
        ref={boxRef}
        className="gc-sigma"
        role="img"
        aria-label={`Map of ${nodes.length} nodes and ${edges.length} links. Press plus or minus to zoom, 0 to fit, Escape to clear.`}
      />
      <div className="gc-controls" role="toolbar" aria-label="Graph controls">
        <button
          type="button"
          className="gc-btn"
          onClick={() => engine.current?.zoom(1.6)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          type="button"
          className="gc-btn"
          onClick={() => engine.current?.zoom(1 / 1.6)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button
          type="button"
          className="gc-btn wide"
          onClick={() => engine.current?.fit(true)}
          title="Fit to view (0)"
        >
          Fit
        </button>
        <button type="button" className="gc-btn wide" onClick={relayout} title="Recompute the layout">
          Re-layout
        </button>
      </div>
      {!panelLegend && <Legend scene={scene} scheme={scheme} level={level} />}
      {(error || busy || debug) && (
        <div className="gc-status" aria-live="polite">
          {error
            ? `Layout failed: ${error}`
            : busy
              ? `Laying out ${nodes.length.toLocaleString("en-US")} nodes…`
              : `${layout.strategy} · ${layout.ms} ms · ${level} zoom`}
        </div>
      )}
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

import "./canvas.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, LaneInfo } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { edgeKindColor, kindColor } from "../theme.ts";
import {
  type Box,
  bandExtents,
  boxesOf,
  type Curve,
  distanceToCurve,
  edgeCurve,
  edgeStyle,
  edgeTipLines,
  FLOW_BOX_H,
  FLOW_BOX_W,
  hitBox,
  laneExtents,
  type Pt,
} from "./flowGeom.ts";
import { runLayout } from "./layoutClient.ts";
import { type CanvasTheme, hexToRgba, readTheme } from "./style.ts";
import type { LayoutInput, Positions } from "./types.ts";

interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

const MIN_K = 0.08;
const MAX_K = 3;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
/** The lane titles sit in a strip under the toolbar row (the List / Graph toggle and the zoom buttons). */
const HEADER_TOP = 46;
const HEADER_H = 24;
const TOP = HEADER_TOP + HEADER_H;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : `${text.slice(0, lo)}…`;
}

/**
 * The canvas of the cross-stack views (#48): nodes as labelled boxes in lanes (columns, swimlanes or a reversed
 * tree, laid out by layout.ts from the server's `lane` and `rank`), edges as curves. Reads are blue, writes orange,
 * low-confidence matches dashed; hovering an edge says how many places it stands for (`via`). A plain 2D canvas:
 * no WebGL needed. Wheel or +/- zoom, drag pans, 0 fits, Esc clears the selection.
 */
export function FlowCanvas({
  nodes,
  edges,
  layoutHint,
  focus,
  onSelect,
  onHover,
  onDrill,
  data,
}: CanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [positions, setPositions] = useState<{ key: string; pos: Positions; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme(null));
  const cam = useRef<Camera>({ x: 0, y: 0, k: 1 });
  /** True until the user pans or zooms: a resize then fits the picture again. */
  const autoFit = useRef(true);
  const hover = useRef<{ node: string | null; edge: number | null }>({ node: null, edge: null });
  const callbacks = useRef({ onSelect, onHover, onDrill });
  callbacks.current = { onSelect, onHover, onDrill };
  const lanes: LaneInfo[] = data?.lanes ?? [];
  const key = useMemo(
    () =>
      `${layoutHint}:${nodes.length}:${edges.length}:${nodes[0]?.id ?? ""}:${nodes[nodes.length - 1]?.id ?? ""}`,
    [nodes, edges, layoutHint],
  );

  useEffect(() => {
    const update = () => setTheme(readTheme(wrapRef.current));
    update();
    const mq =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", update);
    return () => mq?.removeEventListener("change", update);
  }, []);

  // Layout in the worker (the same engine as every flat view).
  useEffect(() => {
    let alive = true;
    setError(null);
    const input: LayoutInput = {
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        size: n.size,
        ...(n.lane !== undefined ? { lane: n.lane } : {}),
        ...(n.rank !== undefined ? { rank: n.rank } : {}),
        ...(n.band !== undefined ? { band: n.band } : {}),
      })),
      edges: edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight, kind: e.kind })),
      hint: layoutHint,
      focus: null,
    };
    const job = runLayout(input);
    job.promise.then(
      (r) => {
        if (alive) setPositions({ key, pos: r.positions, ms: r.ms });
      },
      (err: unknown) => {
        if (alive && !(err instanceof Error && err.message === "cancelled"))
          setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [nodes, edges, layoutHint, key]);

  const ready = positions !== null && positions.key === key;
  const pos = ready ? positions.pos : null;
  const boxes = useMemo<Box[]>(() => (pos ? boxesOf(nodes, pos) : []), [nodes, pos]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const curves = useMemo<(Curve | null)[]>(() => {
    if (!pos) return [];
    // Two edges between the same pair (reads and writes) are drawn a little apart.
    const pairs = new Map<string, number>();
    return edges.map((e) => {
      const a = pos[e.src];
      const b = pos[e.dst];
      if (!a || !b) return null;
      const pk = [e.src, e.dst].sort().join("\0");
      const k = pairs.get(pk) ?? 0;
      pairs.set(pk, k + 1);
      return edgeCurve({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, k === 0 ? 0 : k % 2 === 1 ? k : -k);
    });
  }, [edges, pos]);
  const lanesX = useMemo(() => (pos ? laneExtents(nodes, pos, lanes) : []), [nodes, pos, lanes]);
  const bands = useMemo(() => (pos ? bandExtents(nodes, pos) : []), [nodes, pos]);
  const related = useMemo(() => {
    // The view's own subject (feature path, table usage) is selected on arrival: that does not fade the rest.
    if (!focus || !byId.has(focus) || focus === data?.focus) return null;
    const set = new Set([focus]);
    for (const e of edges) {
      if (e.src === focus) set.add(e.dst);
      if (e.dst === focus) set.add(e.src);
    }
    return set;
  }, [focus, edges, byId, data?.focus]);

  const toWorld = useCallback((sx: number, sy: number): Pt => {
    const el = canvasRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    const c = cam.current;
    return { x: (sx - w / 2) / c.k + c.x, y: (sy - h / 2) / c.k + c.y };
  }, []);

  const draw = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !pos) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const c = cam.current;
    const scheme = theme.scheme;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    const sx = (x: number) => (x - c.x) * c.k + w / 2;
    const sy = (y: number) => (y - c.y) * c.k + h / 2;

    // Swimlane stripes (feature path) or column guides, and band frames (endpoints).
    const swim = layoutHint === "elk-layered" && bands.length === 0;
    lanesX.forEach((l, i) => {
      if (swim && i % 2 === 0) {
        ctx.fillStyle = hexToRgba(theme.border, scheme === "light" ? 0.35 : 0.25);
        ctx.fillRect(sx(l.x0 - 20), 0, (l.x1 - l.x0 + 40) * c.k, h);
      }
    });
    for (const b of bands) {
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(sx(b.x0 - 24), sy(b.y0 - 30), (b.x1 - b.x0 + 48) * c.k, (b.y1 - b.y0 + 48) * c.k);
      ctx.fillStyle = theme.muted;
      ctx.font = `600 ${clamp(12 * c.k, 9, 14)}px ${FONT}`;
      ctx.textBaseline = "bottom";
      ctx.fillText(b.label, sx(b.x0 - 18), sy(b.y0 - 12));
    }

    // Edges first, then the boxes on top.
    edges.forEach((e, i) => {
      const cv = curves[i];
      if (!cv) return;
      const st = edgeStyle(e, scheme);
      const dim =
        related !== null &&
        !(related.has(e.src) && related.has(e.dst) && (e.src === focus || e.dst === focus));
      const hot = hover.current.edge === i;
      ctx.globalAlpha = dim ? 0.12 : hot ? 1 : edgeKindColor(e.kind, scheme) ? 0.9 : 0.6;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = (hot ? st.width + 1.5 : st.width) * clamp(c.k, 0.6, 1.4);
      ctx.setLineDash(st.dash ? st.dash.map((d) => d * clamp(c.k, 0.6, 1.4)) : []);
      ctx.beginPath();
      ctx.moveTo(sx(cv.p0.x), sy(cv.p0.y));
      ctx.bezierCurveTo(sx(cv.p1.x), sy(cv.p1.y), sx(cv.p2.x), sy(cv.p2.y), sx(cv.p3.x), sy(cv.p3.y));
      ctx.stroke();
      // Arrowhead at the target, along the last tangent.
      const ax = sx(cv.p3.x);
      const ay = sy(cv.p3.y);
      const ang = Math.atan2(cv.p3.y - cv.p2.y, cv.p3.x - cv.p2.x);
      const s = 7 * clamp(c.k, 0.6, 1.3);
      ctx.setLineDash([]);
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - s * Math.cos(ang - 0.45), ay - s * Math.sin(ang - 0.45));
      ctx.lineTo(ax - s * Math.cos(ang + 0.45), ay - s * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Text shrinks slower than the boxes, so a fitted overview of a few dozen boxes stays readable.
    const fontPx = clamp(FLOW_BOX_H * c.k * 0.5, 7, 13);
    ctx.font = `${fontPx}px ${FONT}`;
    ctx.textBaseline = "middle";
    for (const b of boxes) {
      const n = byId.get(b.id) as GraphNode;
      const dim = related !== null && !related.has(b.id);
      const sel = b.id === focus;
      const hot = hover.current.node === b.id;
      ctx.globalAlpha = dim ? 0.25 : 1;
      const x = sx(b.x);
      const y = sy(b.y);
      const bw = b.w * c.k;
      const bh = b.h * c.k;
      ctx.fillStyle = theme.surface;
      ctx.strokeStyle = sel ? theme.accent : hot ? theme.text : theme.border;
      ctx.lineWidth = sel ? 2.5 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 5 * c.k);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = kindColor(n.kind, scheme);
      ctx.fillRect(x + 1, y + 1, Math.max(2, 5 * c.k), bh - 2);
      if (FLOW_BOX_W * c.k >= 60) {
        ctx.fillStyle = theme.text;
        ctx.fillText(fitText(ctx, n.label, bw - 16 * c.k), x + 11 * c.k, y + bh / 2);
      }
    }
    ctx.globalAlpha = 1;

    // Lane titles stay at the top of the screen.
    ctx.font = `600 12px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = hexToRgba(theme.bg, 0.92);
    ctx.fillRect(0, 0, w, TOP);
    for (const l of lanesX) {
      const cx = sx((l.x0 + l.x1) / 2);
      if (cx < -100 || cx > w + 100) continue;
      ctx.fillStyle = theme.muted;
      const t = fitText(ctx, l.label, Math.max(40, (l.x1 - l.x0) * c.k));
      ctx.fillText(t, cx - ctx.measureText(t).width / 2, HEADER_TOP + HEADER_H / 2);
    }
  }, [pos, theme, edges, curves, boxes, byId, lanesX, bands, related, focus, layoutHint]);

  const fitView = useCallback(() => {
    const el = canvasRef.current;
    if (!el || boxes.length === 0 || el.clientWidth === 0 || el.clientHeight === 0) return;
    autoFit.current = true;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const b of boxes) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    const pad = 40;
    const k = clamp(
      Math.min(
        (el.clientWidth - 2 * pad) / Math.max(1, x1 - x0 + 60),
        (el.clientHeight - TOP - 2 * pad) / Math.max(1, y1 - y0),
      ),
      MIN_K,
      1.2,
    );
    cam.current = { x: (x0 + x1) / 2 + 20, y: (y0 + y1) / 2 - TOP / (2 * k), k };
  }, [boxes]);

  // Fit when a new picture arrives; redraw on every change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit only when the laid-out picture changes
  useEffect(() => {
    if (!pos) return;
    fitView();
    draw();
  }, [pos]);
  useEffect(() => draw(), [draw]);

  // Pointer: hover (nodes first, then edges), click, double click, drag to pan, wheel to zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !pos) return;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const local = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const pick = (sx0: number, sy0: number): { node: string | null; edge: number | null } => {
      const p = toWorld(sx0, sy0);
      const b = hitBox(boxes, p);
      if (b) return { node: b.id, edge: null };
      let best = -1;
      let bestD = 6 / cam.current.k;
      curves.forEach((cv, i) => {
        if (!cv) return;
        const d = distanceToCurve(cv, p);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return { node: null, edge: best === -1 ? null : best };
    };
    const onMove = (ev: PointerEvent) => {
      const { x, y } = local(ev);
      if (drag) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        autoFit.current = false;
        cam.current.x -= dx / cam.current.k;
        cam.current.y -= dy / cam.current.k;
        drag.x = x;
        drag.y = y;
        setTip(null);
        draw();
        return;
      }
      const hit = pick(x, y);
      const prev = hover.current;
      if (hit.node !== prev.node || hit.edge !== prev.edge) {
        hover.current = hit;
        if (hit.node !== prev.node) callbacks.current.onHover(hit.node);
        el.style.cursor = hit.node ? "pointer" : "";
        draw();
      }
      if (hit.node) {
        const n = byId.get(hit.node) as GraphNode;
        setTip({
          x,
          y,
          title: n.label,
          lines: [n.kind, ...(n.path ? [n.path] : []), ...(n.badges ?? [])],
        });
      } else if (hit.edge !== null) {
        const e = edges[hit.edge] as GraphEdge;
        const t = edgeTipLines(e, (id) => byId.get(id)?.label ?? id);
        setTip({ x, y, ...t });
      } else setTip(null);
    };
    const onDown = (ev: PointerEvent) => {
      const { x, y } = local(ev);
      drag = { x, y, moved: false };
      el.setPointerCapture?.(ev.pointerId);
    };
    const onUp = (ev: PointerEvent) => {
      const d = drag;
      drag = null;
      el.releasePointerCapture?.(ev.pointerId);
      if (!d || d.moved) return;
      const { x, y } = local(ev);
      callbacks.current.onSelect(pick(x, y).node);
    };
    const onDbl = (ev: MouseEvent) => {
      const { x, y } = local(ev);
      const id = pick(x, y).node;
      if (id) callbacks.current.onDrill?.(id);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const { x, y } = local(ev);
      autoFit.current = false;
      const before = toWorld(x, y);
      cam.current.k = clamp(cam.current.k * Math.exp(-ev.deltaY * 0.0015), MIN_K, MAX_K);
      const after = toWorld(x, y);
      cam.current.x += before.x - after.x;
      cam.current.y += before.y - after.y;
      setTip(null);
      draw();
    };
    const onLeave = () => {
      hover.current = { node: null, edge: null };
      setTip(null);
      callbacks.current.onHover(null);
      draw();
    };
    // Test hook: screen geometry of every box and the style of every edge.
    const onProbe = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const c = cam.current;
      const scr = (p: Pt) => ({ x: (p.x - c.x) * c.k + w / 2, y: (p.y - c.y) * c.k + h / 2 });
      el.dataset.probe = JSON.stringify({
        nodes: boxes.map((b) => {
          const s = scr({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
          return { id: b.id, x: Math.round(s.x), y: Math.round(s.y), lane: byId.get(b.id)?.lane };
        }),
        edges: edges.map((e, i) => {
          const cv = curves[i];
          const st = edgeStyle(e, theme.scheme);
          const m = cv ? scr(bezierMid(cv)) : null;
          return {
            id: e.id,
            kind: e.kind,
            color: st.color,
            dashed: st.dash !== null,
            x: m ? Math.round(m.x) : null,
            y: m ? Math.round(m.y) : null,
          };
        }),
        lanes: lanesX.map((l) => l.label),
        zoom: Math.round(c.k * 1000) / 1000,
      });
    };
    const ro = new ResizeObserver(() => {
      if (autoFit.current) fitView();
      draw();
    });
    ro.observe(el);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("gantry:probe", onProbe);
    el.dataset.ready = "true";
    el.dataset.nodes = String(boxes.length);
    el.dataset.edges = String(edges.length);
    return () => {
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("gantry:probe", onProbe);
      delete el.dataset.ready;
    };
  }, [pos, boxes, curves, edges, byId, draw, toWorld, lanesX, theme, fitView]);

  const zoom = (f: number) => {
    autoFit.current = false;
    cam.current.k = clamp(cam.current.k * f, MIN_K, MAX_K);
    draw();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoom(1.4);
      else if (e.key === "-" || e.key === "_") zoom(1 / 1.4);
      else if (e.key === "0") {
        fitView();
        draw();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hasDb = edges.some((e) => e.kind === "reads" || e.kind === "writes");
  const hasLow = edges.some((e) => e.confidence === "low");
  return (
    <div className="gc flow" ref={wrapRef} data-testid="flow-canvas">
      <canvas
        ref={canvasRef}
        className="flow-canvas"
        role="img"
        aria-label={`Diagram of ${nodes.length} nodes and ${edges.length} edges in ${lanes.length} lanes. Press plus or minus to zoom, 0 to fit.`}
      />
      <div className="gc-controls" role="toolbar" aria-label="Diagram controls">
        <button
          type="button"
          className="gc-btn"
          onClick={() => zoom(1.4)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          type="button"
          className="gc-btn"
          onClick={() => zoom(1 / 1.4)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button
          type="button"
          className="gc-btn wide"
          onClick={() => {
            fitView();
            draw();
          }}
          title="Fit to view (0)"
        >
          Fit
        </button>
      </div>
      {(hasDb || hasLow) && (
        <ul className="flow-key" aria-label="Line key">
          {hasDb && (
            <>
              <li className="flow-key-row">
                <span
                  className="flow-swatch"
                  style={{ background: edgeKindColor("reads", theme.scheme) ?? undefined }}
                />{" "}
                reads
              </li>
              <li className="flow-key-row">
                <span
                  className="flow-swatch"
                  style={{ background: edgeKindColor("writes", theme.scheme) ?? undefined }}
                />{" "}
                writes
              </li>
            </>
          )}
          {hasLow && (
            <li className="flow-key-row">
              <span className="flow-swatch dashed" /> uncertain match
            </li>
          )}
        </ul>
      )}
      {nodes.length === 0 && <p className="empty flow-empty">Nothing to draw with these filters.</p>}
      <div className="gc-status" aria-live="polite" data-ms={ready ? positions?.ms : undefined}>
        {error
          ? `Layout failed: ${error}`
          : !ready
            ? `Laying out ${nodes.length.toLocaleString("en-US")} nodes…`
            : `${lanes.length} ${lanes.length === 1 ? "lane" : "lanes"} · ${nodes.length.toLocaleString("en-US")} boxes`}
      </div>
      {tip && (
        <div className="gc-tooltip" role="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          {tip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function bezierMid(c: Curve): Pt {
  return {
    x: 0.125 * c.p0.x + 0.375 * c.p1.x + 0.375 * c.p2.x + 0.125 * c.p3.x,
    y: 0.125 * c.p0.y + 0.375 * c.p1.y + 0.375 * c.p2.y + 0.125 * c.p3.y,
  };
}

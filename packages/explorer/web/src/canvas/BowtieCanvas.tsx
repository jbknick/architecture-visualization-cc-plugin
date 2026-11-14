import "./canvas.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { useStore } from "../store.tsx";
import { kindColor, type Scheme } from "../theme.ts";
import { toggleExpanded } from "../views/egoGroups.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import {
  type BowtieLayout,
  DEFAULT_VIEW,
  layoutBowtie,
  type Placed,
  TOP_MARGIN,
  weightOf,
  workspaceRanks,
} from "./bowtieLayout.ts";
import { type CanvasTheme, hexToRgba, readTheme } from "./style.ts";

interface Camera {
  cx: number;
  cy: number;
  k: number;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

interface DrawnLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DrawnRect {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_K = 0.05;
const MAX_K = 3;
const FIT_MAX_K = 1.15;
/** Rows below this on-screen height (zoomed far out) lose their label. */
export const LABEL_MIN_ROW_PX = 12;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Shortens `text` with an ellipsis so it fits `maxW` pixels in the context's current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 8) return "";
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

/** Like `fitText`, but keeps the end (a file name) and shortens the middle. */
function fitMiddle(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 8) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  for (let keep = text.length - 2; keep >= 4; keep--) {
    const head = Math.ceil(keep * 0.45);
    const tail = keep - head;
    const t = `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
    if (ctx.measureText(t).width <= maxW) return t;
  }
  return fitText(ctx, text, maxW);
}

/**
 * Shorter wordings of a group label, longest first: the whole label, without the workspace in front of the folder,
 * without "in N files". The first that fits is drawn; only when none does is the last one cut in the middle.
 */
export function labelForms(label: string): string[] {
  const forms = [label];
  const add = (f: string) => {
    if (f !== forms[forms.length - 1] && f.length > 0) forms.push(f);
  };
  const noWs = label.includes(" › ") ? label.slice(label.indexOf(" › ") + 3) : label;
  add(noWs);
  const noFiles = noWs.replace(/ in [\d,]+ files?$/, "");
  add(noFiles);
  if (label.includes(" · ")) add(label.slice(label.indexOf(" · ") + 3).replace(/ in [\d,]+ files?$/, ""));
  const name = noFiles.split(" — ")[0] ?? noFiles;
  add(name);
  return forms;
}

function fitForms(ctx: CanvasRenderingContext2D, forms: string[], maxW: number): string {
  for (const f of forms) if (ctx.measureText(f).width <= maxW) return f;
  return fitMiddle(ctx, forms[forms.length - 1] as string, maxW);
}

/**
 * The rectangle an item is drawn in, in world units. The focus never gets smaller than about 0.9 of its natural
 * size on screen; everything else is drawn where the layout put it.
 */
export function worldRect(p: Placed, k: number): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = p;
  if (p.type === "focus") {
    const g = clamp(0.9 / k, 1, 2.2);
    if (g > 1) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      w *= g;
      h *= g;
      x = cx - w / 2;
      y = cy - h / 2;
    }
  }
  return { x, y, w, h };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function columnTitle(side: "in" | "out" | "focus", hop: number, count: number): string {
  const n = count.toLocaleString("en-US");
  if (side === "focus") return "";
  const word = side === "in" ? "CALLERS" : "CALLEES";
  const label = hop <= 1 ? word : `${word}, ${hop} STEPS AWAY`;
  return side === "in" ? `← ${label} · ${n}` : `${label} · ${n} →`;
}

/**
 * The ego view: a left-to-right bow-tie drawn on one 2D canvas. The focus is a card in the middle, callers sit in
 * columns to its left, callees to its right, farther hops further out. Large sides arrive grouped from the server
 * (pills with a count); clicking a pill expands it through the `expand` filter in the hash route.
 */
export function BowtieCanvas({ nodes, edges, focus, onSelect, onHover, onDrill }: CanvasProps) {
  const { state, navigate } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme(null));
  const [tip, setTip] = useState<Tip | null>(null);

  const [view, setView] = useState({ w: 0, h: 0 });
  const layout = useMemo<BowtieLayout>(
    () => layoutBowtie(nodes, edges, view.w > 0 ? view : DEFAULT_VIEW),
    [nodes, edges, view],
  );
  const ranks = useMemo(() => workspaceRanks(nodes), [nodes]);
  const layoutKey = useMemo(
    () => `${view.w}x${view.h}\n${layout.items.map((p) => p.node.id).join("\n")}`,
    [layout, view],
  );

  const cam = useRef<Camera>({ cx: 0, cy: 0, k: 1 });
  const size = useRef({ w: 800, h: 600 });
  const moved = useRef(false); // the user has panned or zoomed: stop refitting on resize
  const blockView = useRef<string | null>(null); // an expanded group the camera is framing (reframed on resize)
  const hover = useRef<string | null>(null);
  const drawn = useRef<DrawnLabel[]>([]);
  const drawnRects = useRef<DrawnRect[]>([]);
  const raf = useRef(0);
  const anim = useRef(0);
  const pending = useRef<{ id: string; expand: boolean } | null>(null);
  const internalSelect = useRef(false);
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      (m.get(e.src) ?? m.set(e.src, new Set()).get(e.src))?.add(e.dst);
      (m.get(e.dst) ?? m.set(e.dst, new Set()).get(e.dst))?.add(e.src);
    }
    // An expanded group's header is related to its members and to what they connect to.
    for (const n of nodes) {
      if (!n.group) continue;
      const head = m.get(n.group) ?? m.set(n.group, new Set()).get(n.group);
      head?.add(n.id);
      for (const nb of m.get(n.id) ?? []) head?.add(nb);
    }
    return m;
  }, [edges, nodes]);
  const live = useRef({ layout, theme, ranks, focus, edges, adj });
  live.current = { layout, theme, ranks, focus, edges, adj };
  const callbacks = useRef({ onSelect, onHover, onDrill });
  callbacks.current = { onSelect, onHover, onDrill };
  const filtersRef = useRef(state.route.filters);
  filtersRef.current = state.route.filters;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Theme: follow the shell's CSS variables and the OS colour scheme.
  useEffect(() => {
    const update = () => setTheme(readTheme(wrapRef.current));
    update();
    const mq =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", update);
    return () => mq?.removeEventListener("change", update);
  }, []);

  const colorOf = useCallback((n: GraphNode, scheme: Scheme, r: Map<string, number>): string => {
    const rank = n.workspace ? r.get(n.workspace) : undefined;
    return rank === undefined
      ? kindColor(n.kind === "group" ? "type" : n.kind, scheme)
      : workspaceColorAt(rank, scheme);
  }, []);

  const draw = useCallback(() => {
    raf.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { layout: L, theme: T, ranks: R, focus: sel, edges: E, adj } = live.current;
    const { w: W, h: H } = size.current;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const c = cam.current;
    const k = c.k;
    const sx = (wx: number) => (wx - c.cx) * k + W / 2;
    const sy = (wy: number) => (wy - c.cy) * k + H / 2;
    const dark = T.scheme === "dark";
    const labels: DrawnLabel[] = [];
    const rects: DrawnRect[] = [];
    const active = hover.current ?? sel;
    const groupOf = (id: string) => L.byId.get(id)?.blocks.at(-1);
    const activeEdge = (src: string, dst: string) =>
      active !== null &&
      (src === active || dst === active || groupOf(src) === active || groupOf(dst) === active);
    const visible = (p: Placed) =>
      sx(p.x + p.w) > -20 && sx(p.x) < W + 20 && sy(p.y + p.h) > -20 && sy(p.y) < H + 20;

    // Outlines of expanded groups.
    for (const o of L.outlines) {
      const hd = L.byId.get(o.id);
      if (!hd) continue;
      const col = colorOf(hd.node, T.scheme, R);
      const x = sx(o.x);
      const y = sy(o.y);
      const w = o.w * k;
      const h = o.h * k;
      if (x > W || x + w < 0 || y > H || y + h < 0) continue;
      roundRect(ctx, x, y, w, h, 10 * k);
      ctx.fillStyle = hexToRgba(col, dark ? 0.1 : 0.07);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(col, 0.6);
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    // Edges. One curve per edge (the server already merges the callers of a row into it). Where several edges meet
    // one side of a node they enter at evenly spaced ports, ordered by where they come from.
    const edgeInk = dark ? "#aab4c5" : "#475569";
    const endpoint = (src: string, dst: string): GraphNode | undefined => {
      const a = L.byId.get(src)?.node;
      const b = L.byId.get(dst)?.node;
      return a?.side === "focus" ? b : a;
    };
    const rectOf = (p: Placed) => worldRect(p, k);
    interface Seg {
      e: (typeof E)[number];
      forward: boolean;
      sr: ReturnType<typeof rectOf>;
      dr: ReturnType<typeof rectOf>;
      y0: number;
      y1: number;
      maxW: number;
    }
    const segs: Seg[] = [];
    const ends = new Map<string, { seg: Seg; end: 0 | 1; other: number; id: string }[]>();
    for (const e of E) {
      const s = L.byId.get(e.src);
      const d = L.byId.get(e.dst);
      if (!s || !d) continue;
      const sr = rectOf(s);
      const dr = rectOf(d);
      const forward = s.x + s.w / 2 <= d.x + d.w / 2;
      const seg: Seg = { e, forward, sr, dr, y0: sr.y + sr.h / 2, y1: dr.y + dr.h / 2, maxW: 7 };
      segs.push(seg);
      const push = (key: string, end: 0 | 1, other: number) => {
        const list = ends.get(key) ?? [];
        list.push({ seg, end, other, id: e.id });
        ends.set(key, list);
      };
      push(`${e.src}|${forward ? "r" : "l"}`, 0, dr.y + dr.h / 2);
      push(`${e.dst}|${forward ? "l" : "r"}`, 1, sr.y + sr.h / 2);
    }
    const fan = new Map<Seg, [number, number]>();
    for (const [key, list] of ends) {
      const placed = L.byId.get(key.slice(0, key.lastIndexOf("|")));
      if (!placed) continue;
      const r = rectOf(placed);
      list.sort((p, q) => p.other - q.other || (p.id < q.id ? -1 : 1));
      const pad = placed.type === "focus" ? Math.min(14, r.h * 0.14) : r.h * 0.2;
      const span = r.h - 2 * pad;
      list.forEach((it, i) => {
        const y = r.y + pad + (span * (i + 0.5)) / list.length;
        const cur = fan.get(it.seg) ?? [it.seg.y0, it.seg.y1];
        cur[it.end] = y;
        fan.set(it.seg, cur);
        it.seg.maxW = Math.min(it.seg.maxW, Math.max(1.4, (span / list.length) * k * 0.9));
      });
    }
    const arrivals = new Map<string, number>();
    for (const sg of segs) {
      const key = `${sg.e.dst}|${sg.forward ? "l" : "r"}`;
      arrivals.set(key, (arrivals.get(key) ?? 0) + 1);
    }
    const labelEdges = E.length <= 14;
    const pills: { x: number; y: number; text: string; col: string }[] = [];
    const shared = new Map<string, { x: number; y: number; dir: number; hot: boolean }>();
    for (const sg of segs) {
      const { e, forward, sr, dr } = sg;
      const [fy0, fy1] = fan.get(sg) ?? [sg.y0, sg.y1];
      const x0 = sx(forward ? sr.x + sr.w : sr.x);
      const y0 = sy(fy0);
      const x1 = sx(forward ? dr.x : dr.x + dr.w);
      const y1 = sy(fy1);
      if (
        (x0 < -50 && x1 < -50) ||
        (x0 > W + 50 && x1 > W + 50) ||
        (y0 < -50 && y1 < -50) ||
        (y0 > H + 50 && y1 > H + 50)
      )
        continue;
      const dir = forward ? 1 : -1;
      const off = Math.max(30, Math.abs(x1 - x0) * 0.5) * dir;
      const hot = activeEdge(e.src, e.dst);
      const endNode = endpoint(e.src, e.dst);
      const col = endNode ? colorOf(endNode, T.scheme, R) : edgeInk;
      const alpha = active === null ? 0.55 : hot ? 0.95 : 0.08;
      const width =
        Math.min(sg.maxW, clamp(1 + 0.8 * Math.sqrt(Math.max(1, e.weight)), 1, 6)) * clamp(k, 0.7, 1.2);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + off, y0, x1 - off, y1, x1, y1);
      ctx.strokeStyle = hot ? T.accent : hexToRgba(col, alpha);
      ctx.lineWidth = hot ? Math.max(width, 2) : width;
      ctx.setLineDash(e.confidence === "low" ? [6, 4] : []);
      ctx.lineCap = "butt";
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrowhead at the callee end. Where several edges arrive (the focus card), one shared arrowhead.
      const dstItem = L.byId.get(e.dst);
      const side = forward ? "l" : "r";
      if (dstItem?.type === "focus" || (arrivals.get(`${e.dst}|${side}`) ?? 0) > 1) {
        const key = `${e.dst}|${side}`;
        const cur = shared.get(key);
        const cy = sy(dr.y + dr.h / 2);
        if (!cur) shared.set(key, { x: x1, y: cy, dir, hot });
        else cur.hot ||= hot;
      } else {
        const len = 8 + Math.min(width, 5) * 1.3;
        const half = 3.4 + Math.min(width, 5) * 0.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - dir * len, y1 - half);
        ctx.lineTo(x1 - dir * len, y1 + half);
        ctx.closePath();
        ctx.fillStyle = hot ? T.accent : hexToRgba(col, Math.min(1, alpha + 0.3));
        ctx.fill();
      }
      const grouped = L.byId.get(e.src)?.node.kind === "group" || L.byId.get(e.dst)?.node.kind === "group";
      if (e.weight > 1 && grouped && (labelEdges ? active === null || hot : hot && hover.current !== null)) {
        // A tag with the number of calls, a third of the way along the curve.
        const t = 0.32;
        const mt = 1 - t;
        const bx = mt ** 3 * x0 + 3 * mt * mt * t * (x0 + off) + 3 * mt * t * t * (x1 - off) + t ** 3 * x1;
        const by = mt ** 3 * y0 + 3 * mt * mt * t * y0 + 3 * mt * t * t * y1 + t ** 3 * y1;
        pills.push({ x: bx, y: by, text: String(e.weight), col });
      }
    }
    for (const b of shared.values()) {
      ctx.beginPath();
      ctx.moveTo(b.x + 1, b.y);
      ctx.lineTo(b.x - b.dir * 16, b.y - 9);
      ctx.lineTo(b.x - b.dir * 16, b.y + 9);
      ctx.closePath();
      ctx.fillStyle = b.hot ? T.accent : hexToRgba(edgeInk, active === null ? 0.95 : 0.6);
      ctx.fill();
    }

    // Nodes.
    const pxText = (base: number, lo: number, hi: number) => clamp(base * k, lo, hi);
    for (const p of L.items) {
      if (!visible(p)) continue;
      const n = p.node;
      const wr = worldRect(p, k);
      const x = sx(wr.x);
      const y = sy(wr.y);
      const w = wr.w * k;
      const h = wr.h * k;
      rects.push({ id: n.id, type: p.type, x: x, y: y, w: w, h: h });
      const isSel = sel === n.id;
      const isHot = hover.current === n.id;
      const dimmed = active !== null && !isSel && !isHot && !(adj.get(active)?.has(n.id) ?? false);
      ctx.globalAlpha = dimmed ? 0.65 : 1;
      const col = colorOf(n, T.scheme, R);
      const ink = dark ? "#0f1217" : "#ffffff";

      if (p.type === "focus") {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.28)";
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 4;
        roundRect(ctx, x, y, w, h, 14 * k);
        ctx.fillStyle = T.surface;
        ctx.fill();
        ctx.restore();
        roundRect(ctx, x, y, w, h, 14 * k);
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 3;
        ctx.stroke();
        const kc = kindColor(n.kind, T.scheme);
        roundRect(ctx, x, y, Math.max(6 * k, 4), h, 3);
        ctx.fillStyle = kc;
        ctx.fill();
        const padX = 18 * clamp(k, 0.6, 1.2);
        const maxW = w - padX - 12;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = T.accent;
        ctx.font = `700 ${pxText(11, 9.5, 12)}px ${FONT}`;
        ctx.fillText("FOCUS", x + padX, y + h * 0.27);
        const kindText = fitText(ctx, n.kind, w * 0.4);
        ctx.fillStyle = T.muted;
        ctx.font = `600 ${pxText(11, 9.5, 12)}px ${FONT}`;
        ctx.textAlign = "right";
        ctx.fillText(kindText, x + w - 12, y + h * 0.27);
        ctx.textAlign = "left";
        ctx.fillStyle = T.text;
        ctx.font = `700 ${pxText(19, 13, 22)}px ${FONT}`;
        const name = fitText(ctx, n.label, maxW);
        ctx.fillText(name, x + padX, y + h * 0.58);
        labels.push({
          id: n.id,
          text: name,
          x: x + padX,
          y: y + h * 0.58 - 14,
          w: ctx.measureText(name).width,
          h: 16,
        });
        if (n.path) {
          ctx.fillStyle = T.muted;
          ctx.font = `${pxText(11.5, 10, 12.5)}px ${MONO}`;
          const path = fitMiddle(ctx, `${n.path}`, maxW);
          ctx.fillText(path, x + padX, y + h * 0.84);
        }
      } else if (p.type === "group" || p.type === "head") {
        const r = h / 2;
        roundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = T.surface;
        ctx.fill();
        roundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = hexToRgba(col, p.type === "head" ? (dark ? 0.3 : 0.2) : dark ? 0.22 : 0.14);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = isSel || isHot ? 2.5 : 1.5;
        ctx.stroke();
        if (isSel) {
          roundRect(ctx, x - 3, y - 3, w + 6, h + 6, r + 3);
          ctx.strokeStyle = T.accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        const fs = pxText(12.5, 11, 14);
        const caretW = fs * 0.9;
        const padL = Math.max(10, r * 0.9);
        // Caret: right-pointing when collapsed, down-pointing when expanded.
        const cxm = x + padL + caretW / 2;
        const cym = y + h / 2;
        const cs = fs * 0.34;
        ctx.beginPath();
        if (p.type === "head") {
          ctx.moveTo(cxm - cs, cym - cs * 0.6);
          ctx.lineTo(cxm + cs, cym - cs * 0.6);
          ctx.lineTo(cxm, cym + cs * 0.9);
        } else {
          ctx.moveTo(cxm - cs * 0.6, cym - cs);
          ctx.lineTo(cxm - cs * 0.6, cym + cs);
          ctx.lineTo(cxm + cs * 0.9, cym);
        }
        ctx.closePath();
        ctx.fillStyle = T.text;
        ctx.fill();
        // Count chip on the right.
        const count = String(n.stats?.members ?? n.size);
        ctx.font = `700 ${fs}px ${FONT}`;
        const chipW = Math.max(fs * 2, ctx.measureText(count).width + fs * 1.2);
        const chipH = Math.min(h - 6, fs * 1.7);
        const chipX = x + w - chipW - Math.max(4, (h - chipH) / 2);
        roundRect(ctx, chipX, y + (h - chipH) / 2, chipW, chipH, chipH / 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.fillStyle = ink;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(count, chipX + chipW / 2, y + h / 2 + 0.5);
        // Label.
        ctx.textAlign = "left";
        ctx.fillStyle = T.text;
        ctx.font = `600 ${fs}px ${FONT}`;
        const lx = x + padL + caretW + 8;
        const text = fitForms(ctx, labelForms(n.label), chipX - lx - 8);
        ctx.fillText(text, lx, y + h / 2 + 0.5);
        labels.push({ id: n.id, text, x: lx, y: y + h / 2 - fs / 2, w: ctx.measureText(text).width, h: fs });
        ctx.textBaseline = "alphabetic";
      } else if (p.type === "more") {
        roundRect(ctx, x, y, w, h, Math.min(h / 2, 8));
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = T.muted;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        if (h >= LABEL_MIN_ROW_PX * 0.8) {
          const fs = pxText(12, 10.5, 13);
          ctx.font = `italic ${fs}px ${FONT}`;
          ctx.fillStyle = T.muted;
          ctx.textBaseline = "middle";
          const text = fitText(ctx, n.label, w - 14);
          ctx.fillText(text, x + 8, y + h / 2 + 0.5);
          labels.push({
            id: n.id,
            text,
            x: x + 8,
            y: y + h / 2 - fs / 2,
            w: ctx.measureText(text).width,
            h: fs,
          });
          ctx.textBaseline = "alphabetic";
        }
      } else {
        // An individual function or file: a row tinted with its workspace's colour.
        roundRect(ctx, x, y, w, h, Math.min(5, h / 3));
        ctx.fillStyle = T.surface;
        ctx.fill();
        roundRect(ctx, x, y, w, h, Math.min(5, h / 3));
        ctx.fillStyle = hexToRgba(col, dark ? 0.3 : 0.2);
        ctx.fill();
        if (isSel || isHot) {
          ctx.strokeStyle = isSel ? T.accent : T.text;
          ctx.lineWidth = isSel ? 2 : 1.2;
          ctx.stroke();
        }
        const bar = Math.max(2, 3 * k);
        ctx.fillStyle = col;
        ctx.fillRect(x, y + 1, bar, Math.max(1, h - 2));
        if (h >= LABEL_MIN_ROW_PX) {
          const fs = pxText(12, 10.5, 13);
          ctx.font = `${fs}px ${FONT}`;
          ctx.fillStyle = T.text;
          ctx.textBaseline = "middle";
          const text = fitText(ctx, n.label, w - bar - 12);
          ctx.fillText(text, x + bar + 7, y + h / 2 + 0.5);
          labels.push({
            id: n.id,
            text,
            x: x + bar + 7,
            y: y + h / 2 - fs / 2,
            w: ctx.measureText(text).width,
            h: fs,
          });
          ctx.textBaseline = "alphabetic";
        }
      }
      ctx.globalAlpha = 1;
    }

    // Weight tags on top of the edges.
    ctx.font = `600 10.5px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (const t of pills) {
      const tw = ctx.measureText(t.text).width + 10;
      roundRect(ctx, t.x - tw / 2, t.y - 8, tw, 16, 8);
      ctx.fillStyle = T.surface;
      ctx.fill();
      ctx.strokeStyle = hexToRgba(t.col, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = T.text;
      ctx.fillText(t.text, t.x, t.y + 0.5);
    }

    // Column titles stay pinned to the top so "callers left, callees right" is always visible.
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `700 11px ${FONT}`;
    const spans = new Map<string, { side: "in" | "out"; hop: number; x0: number; x1: number }>();
    for (const col of L.columns) {
      if (col.side === "focus") continue;
      const key = `${col.side}${col.hop}`;
      const cur = spans.get(key);
      if (cur) {
        cur.x0 = Math.min(cur.x0, col.x);
        cur.x1 = Math.max(cur.x1, col.x + col.w);
      } else spans.set(key, { side: col.side, hop: col.hop, x0: col.x, x1: col.x + col.w });
    }
    for (const sp of spans.values()) {
      const count = L.items
        .filter((p) => p.side === sp.side && p.hop === sp.hop)
        .reduce((s, p) => s + weightOf(p.node), 0);
      const cx = sx((sp.x0 + sp.x1) / 2);
      if (cx < -120 || cx > W + 120) continue;
      const title = columnTitle(sp.side, sp.hop, count);
      const tw = ctx.measureText(title).width + 20;
      roundRect(ctx, cx - tw / 2, 44, tw, 22, 11);
      ctx.fillStyle = hexToRgba(T.accent, dark ? 0.2 : 0.1);
      ctx.fill();
      ctx.fillStyle = T.text;
      ctx.fillText(title, cx, 59);
    }
    ctx.textAlign = "left";
    drawn.current = labels;
    drawnRects.current = rects;
  }, [colorOf]);

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  /** Animates the camera to a target over `ms` milliseconds (instant when 0). */
  const goTo = useCallback(
    (target: Camera, ms: number) => {
      cancelAnimationFrame(anim.current);
      const from = { ...cam.current };
      if (ms <= 0) {
        cam.current = target;
        schedule();
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = clamp((now - t0) / ms, 0, 1);
        const e = 1 - (1 - t) ** 3;
        cam.current = {
          cx: from.cx + (target.cx - from.cx) * e,
          cy: from.cy + (target.cy - from.cy) * e,
          k: from.k * (target.k / from.k) ** e,
        };
        draw();
        if (t < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [draw, schedule],
  );

  /** The camera that shows a world rectangle, leaving room for the column titles at the top. */
  const cameraFor = useCallback(
    (r: { x0: number; y0: number; x1: number; y1: number }, maxK: number): Camera => {
      const { w, h } = size.current;
      const padX = 28;
      const top = TOP_MARGIN;
      const bottom = 24;
      const k = clamp(
        Math.min((w - 2 * padX) / Math.max(1, r.x1 - r.x0), (h - top - bottom) / Math.max(1, r.y1 - r.y0)),
        MIN_K,
        maxK,
      );
      return { cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2 - (top - bottom) / 2 / k, k };
    },
    [],
  );

  const fitAll = useCallback(
    (ms = 0) => {
      const b = live.current.layout.bounds;
      moved.current = false;
      blockView.current = null;
      goTo(cameraFor(b, FIT_MAX_K), ms);
    },
    [cameraFor, goTo],
  );

  /** Centres an item (or an expanded group with its members) in the view. */
  const showItem = useCallback(
    (id: string, ms = 350) => {
      const L = live.current.layout;
      const p = L.byId.get(id);
      if (!p) return;
      moved.current = true;
      blockView.current = null;
      if (p.type === "head") {
        let r = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
        for (const m of L.items) {
          if (!m.blocks.includes(id)) continue;
          r = {
            x0: Math.min(r.x0, m.x),
            y0: r.y0,
            x1: Math.max(r.x1, m.x + m.w),
            y1: Math.max(r.y1, m.y + m.h),
          };
        }
        // Keep the focus in frame with the block. When the whole picture is readable at its fit zoom, show all of it.
        const b = L.bounds;
        const all = cameraFor(b, FIT_MAX_K);
        if (all.k >= 0.8) {
          moved.current = false;
          goTo(all, ms);
          return;
        }
        blockView.current = id;
        const f = L.items.find((m) => m.type === "focus");
        if (f)
          r = {
            x0: Math.min(r.x0, f.x - f.w * 0.3),
            y0: Math.min(r.y0, f.y),
            x1: Math.max(r.x1, f.x + f.w * 1.3),
            y1: Math.max(r.y1, f.y + f.h),
          };
        goTo(cameraFor({ x0: r.x0 - 40, y0: r.y0 - 30, x1: r.x1 + 40, y1: r.y1 + 30 }, 1), ms);
        return;
      }
      const k = clamp(Math.max(cam.current.k, 0.9), MIN_K, 1.4);
      goTo({ cx: p.x + p.w / 2, cy: p.y + p.h / 2, k }, ms);
    },
    [cameraFor, goTo],
  );

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      moved.current = true;
      blockView.current = null;
      const c = cam.current;
      const { w, h } = size.current;
      const px = at?.x ?? w / 2;
      const py = at?.y ?? h / 2;
      const k = clamp(c.k * factor, MIN_K, MAX_K);
      // Keep the world point under (px, py) fixed.
      const wx = (px - w / 2) / c.k + c.cx;
      const wy = (py - h / 2) / c.k + c.cy;
      cam.current = { k, cx: wx - (px - w / 2) / k, cy: wy - (py - h / 2) / k };
      schedule();
    },
    [schedule],
  );

  const toggleGroup = useCallback((id: string) => {
    const wasExpanded = live.current.layout.byId.get(id)?.type === "head";
    pending.current = { id, expand: !wasExpanded };
    // One navigation for both, so the second does not overwrite the first with a stale route.
    navigateRef.current({ filters: toggleExpanded(filtersRef.current, id), sel: id });
  }, []);

  // Canvas size.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      size.current = { w: Math.max(200, r.width), h: Math.max(200, r.height) };
      setView((v) => {
        const w = Math.round(size.current.w);
        const h = Math.round(size.current.h);
        return v.w === w && v.h === h ? v : { w, h };
      });
      const blk = blockView.current;
      if (blk && live.current.layout.byId.has(blk)) showItem(blk, 0);
      else if (!moved.current) fitAll(0);
      else schedule();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fitAll, showItem, schedule]);

  // New data: refit unless the user has moved; after a toggle, show the group that changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `layoutKey` identifies the layout
  useEffect(() => {
    const p = pending.current;
    pending.current = null;
    if (p && live.current.layout.byId.has(p.id)) showItem(p.id, 300);
    else if (!moved.current) fitAll(0);
    else schedule();
    const box = canvasRef.current;
    if (box) {
      box.dataset.ready = "true";
      box.dataset.nodes = String(live.current.layout.items.length);
    }
  }, [layoutKey, fitAll, showItem, schedule]);

  // Redraw on theme, selection and data changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values are read from `live` inside draw
  useEffect(() => schedule(), [theme, focus, layout, schedule]);

  // Selecting from outside the canvas (search, inspector, panel) brings the node into view.
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (!focus) return;
    if (internalSelect.current) {
      internalSelect.current = false;
      return;
    }
    // The first view is the fitted picture; the focus itself is always in it.
    if (first || live.current.layout.byId.get(focus)?.type === "focus") return;
    showItem(focus);
  }, [focus, showItem]);

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
      if (e.key === "+" || e.key === "=") zoomBy(1.4);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.4);
      else if (e.key === "0") fitAll(250);
      else if (e.key === "Escape") callbacks.current.onSelect(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitAll, zoomBy]);

  // Test and automation hooks: fly to a node, write the drawn labels to `data-probe`.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const zoom = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) showItem(id);
    };
    const probe = () => {
      draw();
      el.dataset.probe = JSON.stringify({
        k: Number(cam.current.k.toFixed(3)),
        labels: drawn.current.map((l) => ({
          ...l,
          x: Math.round(l.x),
          y: Math.round(l.y),
          w: Math.round(l.w),
          h: Math.round(l.h),
        })),
        rects: drawnRects.current.map((r) => ({
          id: r.id,
          type: r.type,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.w),
          h: Math.round(r.h * 10) / 10,
        })),
      });
    };
    el.addEventListener("gantry:zoom-to", zoom);
    el.addEventListener("gantry:probe", probe);
    return () => {
      el.removeEventListener("gantry:zoom-to", zoom);
      el.removeEventListener("gantry:probe", probe);
    };
  }, [showItem, draw]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(anim.current);
    },
    [],
  );

  // Pointer: drag pans, wheel zooms, a click without a drag selects (groups also expand or collapse).
  const pointer = useRef<{ x: number; y: number; cx: number; cy: number; dragged: boolean } | null>(null);
  const pick = (clientX: number, clientY: number): Placed | null => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return null;
    const { w, h } = size.current;
    const c = cam.current;
    const wx = (clientX - r.left - w / 2) / c.k + c.cx;
    const wy = (clientY - r.top - h / 2) / c.k + c.cy;
    const items = live.current.layout.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i] as Placed;
      const r = worldRect(p, c.k);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return p;
    }
    return null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const drag = pointer.current;
    if (drag && e.buttons === 1) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.dragged = true;
      if (drag.dragged) {
        moved.current = true;
        blockView.current = null;
        cam.current = { ...cam.current, cx: drag.cx - dx / cam.current.k, cy: drag.cy - dy / cam.current.k };
        setTip(null);
        schedule();
      }
      return;
    }
    const p = pick(e.clientX, e.clientY);
    const id = p?.node.id ?? null;
    if (id !== hover.current) {
      hover.current = id;
      callbacks.current.onHover(id);
      schedule();
    }
    if (canvasRef.current) canvasRef.current.style.cursor = p ? "pointer" : "grab";
    setTip(
      p
        ? { x: e.clientX - r.left, y: e.clientY - r.top, title: p.node.label, lines: describe(p.node) }
        : null,
    );
  };

  return (
    <div className="gc bt" ref={wrapRef} data-testid="graph-canvas">
      <canvas
        ref={canvasRef}
        className="bt-canvas"
        role="img"
        aria-label={`Callers on the left, callees on the right of the focused function: ${nodes.length} nodes. Press plus or minus to zoom, 0 to fitAll, Escape to clear.`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pointer.current = {
            x: e.clientX,
            y: e.clientY,
            cx: cam.current.cx,
            cy: cam.current.cy,
            dragged: false,
          };
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          const drag = pointer.current;
          pointer.current = null;
          if (!drag || drag.dragged) return;
          const p = pick(e.clientX, e.clientY);
          if (!p) {
            callbacks.current.onSelect(null);
            return;
          }
          internalSelect.current = true;
          if (p.type === "group" || p.type === "head") toggleGroup(p.node.id);
          else callbacks.current.onSelect(p.node.id);
        }}
        onPointerLeave={() => {
          if (hover.current !== null) {
            hover.current = null;
            callbacks.current.onHover(null);
            schedule();
          }
          setTip(null);
        }}
        onDoubleClick={(e) => {
          const p = pick(e.clientX, e.clientY);
          if (p && p.type === "row") callbacks.current.onDrill?.(p.node.id);
        }}
      />
      <div className="gc-controls" role="toolbar" aria-label="Graph controls">
        <button
          type="button"
          className="gc-btn"
          onClick={() => zoomBy(1.4)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          type="button"
          className="gc-btn"
          onClick={() => zoomBy(1 / 1.4)}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <button type="button" className="gc-btn wide" onClick={() => fitAll(300)} title="Fit to view (0)">
          Fit
        </button>
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

function describe(n: GraphNode): string[] {
  const lines: string[] = [];
  if (n.kind === "group") {
    const members = n.stats?.members ?? n.size;
    lines.push(
      `group of ${members} ${n.side === "in" ? "callers" : "callees"} · ${n.stats?.files ?? 0} files`,
    );
    lines.push(n.expanded ? "Click to collapse" : "Click to expand");
  } else if (n.kind === "more") lines.push("Not shown, to keep the view readable");
  else lines.push(n.kind);
  if (n.path && n.kind !== "group") lines.push(n.path);
  if (n.workspace) lines.push(n.workspace.replace(/^ws:/, ""));
  return lines;
}

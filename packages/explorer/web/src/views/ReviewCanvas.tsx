import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState, type WheelEvent } from "react";
import type { GraphEdge, GraphNode, ReviewData } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import {
  CHANGE_KINDS,
  CHANGE_WORDS,
  hopTitle,
  labelRing,
  layoutOverlay,
  OVERLAY_SIZE,
  ringBounds,
  ringRadii,
} from "./reviewModel.ts";

const MIN_SCALE = 0.5;
/** About 7.5 layout units per character at the overlay's 13px file labels. */
const CHAR_W = 7.5;

function fitName(name: string, width: number): string {
  const max = Math.floor(width / CHAR_W);
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1))}…`;
}
const MAX_SCALE = 8;

/** Wheel zoom and drag pan over an SVG viewBox. */
function useViewBox(bounds: { x: number; y: number; w: number; h: number }) {
  const [cam, setCam] = useState({ cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2, scale: 1 });
  const key = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}`;
  const last = useRef(key);
  if (last.current !== key) {
    last.current = key;
    setCam({ cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2, scale: 1 });
  }
  const w = bounds.w / cam.scale;
  const h = bounds.h / cam.scale;
  const viewBox = `${cam.cx - w / 2} ${cam.cy - h / 2} ${w} ${h}`;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setCam((c) => ({ ...c, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * f)) }));
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.buttons === 0) return;
    const el = e.currentTarget.getBoundingClientRect();
    const k = Math.max(w / Math.max(1, el.width), h / Math.max(1, el.height));
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setCam((c) => ({ ...c, cx: c.cx - dx * k, cy: c.cy - dy * k }));
  };
  const onPointerUp = () => {
    setTimeout(() => {
      drag.current = null;
    }, 0);
  };
  const dragged = () => drag.current?.moved ?? false;
  const zoom = (f: number) =>
    setCam((c) => ({ ...c, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * f)) }));
  const fit = () => setCam({ cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2, scale: 1 });
  return { viewBox, handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp }, dragged, zoom, fit };
}

function nodeClass(n: GraphNode, selected: boolean, dim: boolean): string {
  const parts = ["rv-node"];
  if ((n.hop ?? 0) === 0) parts.push(`rv-change-${n.change ?? "modified"}`);
  else parts.push(`rv-hop rv-hop-${Math.min(3, n.hop ?? 1)}`);
  if (n.signatureChanged) parts.push("rv-sig");
  if (selected) parts.push("rv-sel");
  if (dim) parts.push("rv-dim");
  return parts.join(" ");
}

function Legend({ review }: { review: ReviewData }) {
  return (
    <ul className="rv-legend" aria-label="Legend">
      {CHANGE_KINDS.map((k) => (
        <li key={k} title={CHANGE_WORDS[k].hint}>
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="5" className={`rv-node rv-change-${k}`} />
          </svg>
          {CHANGE_WORDS[k].label}
        </li>
      ))}
      <li title="The signature differs between the two sides">
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" className="rv-node rv-change-modified rv-sig" />
        </svg>
        Signature changed
      </li>
      {review.mode === "rings" ? (
        <li>
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="5" className="rv-node rv-hop rv-hop-1" />
          </svg>
          Caller
        </li>
      ) : (
        <>
          <li>
            <span className="rv-swatch rv-mark-affected" aria-hidden="true" />
            Calls changed code
          </li>
          <li>
            <span className="rv-swatch rv-dim-swatch" aria-hidden="true" />
            Not affected
          </li>
        </>
      )}
    </ul>
  );
}

function Rings({ nodes, edges, focus, onSelect, onHover }: Omit<CanvasProps, "layoutHint" | "data">) {
  const bounds = useMemo(() => ringBounds(nodes), [nodes]);
  const radii = useMemo(() => ringRadii(nodes), [nodes]);
  const { viewBox, handlers, dragged, zoom, fit } = useViewBox(bounds);
  const [hover, setHover] = useState<string | null>(null);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = hover ?? focus;
  const near = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>([active]);
    for (const e of edges) {
      if (e.src === active) s.add(e.dst);
      if (e.dst === active) s.add(e.src);
    }
    return s;
  }, [active, edges]);
  const countByHop = new Map(radii.map((r) => [r.hop, r.count]));
  const hoverOn = (id: string | null) => {
    setHover(id);
    onHover(id);
  };
  const edgeEl = (e: GraphEdge) => {
    const a = pos.get(e.src);
    const b = pos.get(e.dst);
    if (!a || !b) return null;
    const hot = active !== null && (e.src === active || e.dst === active);
    return (
      <line
        key={e.id}
        x1={a.x ?? 0}
        y1={a.y ?? 0}
        x2={b.x ?? 0}
        y2={b.y ?? 0}
        className={`rv-edge${hot ? " rv-edge-hot" : active ? " rv-dim" : ""}`}
      />
    );
  };
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a background click clears the selection; Escape does that from the keyboard */}
      <svg
        className="rv-svg"
        viewBox={viewBox}
        role="img"
        aria-label="Changed symbols in the centre, their callers on rings by hop"
        {...handlers}
        onClick={(e) => {
          if (e.target === e.currentTarget && !dragged()) onSelect(null);
        }}
      >
        {radii
          .filter((r) => r.r > 0 && r.hop > 0)
          .map((r) => (
            <g key={r.hop}>
              <circle className="rv-ring" cx={0} cy={0} r={r.r} />
              <text className="rv-ring-label" x={0} y={-r.r - 10} textAnchor="middle">
                {hopTitle(r.hop)} ({r.count})
              </text>
            </g>
          ))}
        <g>{edges.map(edgeEl)}</g>
        <g>
          {nodes.map((n) => {
            const hop = n.hop ?? 0;
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            const selected = focus === n.id;
            const dim = near !== null && !near.has(n.id);
            const label = labelRing(hop, countByHop.get(hop) ?? 0) || selected || hover === n.id;
            const right = x >= 0;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG node is a button for the keyboard and screen readers
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.label}${hop === 0 ? `, ${n.change ?? "changed"}` : `, ${hopTitle(hop).toLowerCase()}`}`}
                aria-pressed={selected}
                data-id={n.id}
                className="rv-node-g"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!dragged()) onSelect(n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(n.id);
                  }
                }}
                onPointerEnter={() => hoverOn(n.id)}
                onPointerLeave={() => hoverOn(null)}
                onFocus={() => hoverOn(n.id)}
                onBlur={() => hoverOn(null)}
              >
                <title>{n.path ? `${n.label} (${n.path})` : n.label}</title>
                <circle cx={x} cy={y} r={hop === 0 ? 11 : 7} className={nodeClass(n, selected, dim)} />
                {label && (
                  <text
                    className={`rv-label${dim ? " rv-dim" : ""}${hop === 0 ? " rv-label-strong" : ""}`}
                    x={x + (right ? 15 : -15)}
                    y={y + 4}
                    textAnchor={right ? "start" : "end"}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="rv-zoom">
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoom(1.25)}>
          +
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoom(0.8)}>
          −
        </button>
        <button type="button" className="btn rv-fit" onClick={fit}>
          Fit
        </button>
      </div>
    </>
  );
}

function Overlay({ nodes, focus, onSelect, onHover }: Omit<CanvasProps, "layoutHint" | "data" | "edges">) {
  const boxes = useMemo(() => layoutOverlay(nodes), [nodes]);
  const bounds = { x: 0, y: 0, w: OVERLAY_SIZE.w, h: OVERLAY_SIZE.h };
  const { viewBox, handlers, dragged } = useViewBox(bounds);
  return (
    <svg
      className="rv-svg rv-overlay"
      viewBox={viewBox}
      role="img"
      aria-label="Project map: changed and affected files highlighted, the rest dimmed"
      {...handlers}
    >
      {boxes.map((b) => (
        <g key={b.id}>
          <rect className="rv-ws" x={b.rect.x} y={b.rect.y} width={b.rect.w} height={b.rect.h} rx={4} />
          <text className="rv-ws-label" x={b.rect.x + 6} y={b.rect.y + 17}>
            {b.label}
            {b.changed + b.affected > 0 ? ` · ${b.changed} changed, ${b.affected} affected` : ""}
          </text>
          {b.files.map(({ node, rect }) => {
            const cls = node.mark
              ? node.mark === "changed"
                ? `rv-file rv-change-${node.change ?? "modified"}`
                : "rv-file rv-mark-affected"
              : "rv-file rv-dim-file";
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG tile is a button for the keyboard and screen readers
              <g
                key={node.id}
                role="button"
                tabIndex={node.mark ? 0 : -1}
                aria-label={`${node.path ?? node.label}${node.mark ? `, ${node.mark}` : ""}`}
                aria-pressed={focus === node.id}
                data-id={node.id}
                data-mark={node.mark ?? "none"}
                onClick={() => {
                  if (!dragged()) onSelect(node.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.id);
                  }
                }}
                onPointerEnter={() => onHover(node.id)}
                onPointerLeave={() => onHover(null)}
              >
                <title>{node.path ?? node.label}</title>
                <rect
                  className={`${cls}${focus === node.id ? " rv-sel" : ""}`}
                  x={rect.x + 0.5}
                  y={rect.y + 0.5}
                  width={Math.max(0, rect.w - 1)}
                  height={Math.max(0, rect.h - 1)}
                />
                {rect.w >= 60 && rect.h >= 22 && (
                  <text
                    className={`rv-file-label${node.mark ? "" : " rv-dim"}`}
                    x={rect.x + 6}
                    y={rect.y + 16}
                  >
                    {fitName(node.label, rect.w - 12)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

/** The review view's canvas (hint `radial`): rings by hop, or the project map overlay. */
export function ReviewCanvas({ nodes, edges, data, focus, onSelect, onHover }: CanvasProps) {
  const review = data?.review ?? null;
  if (!review) {
    return (
      <div className="empty-state" data-testid="review-canvas">
        <h2>Pick a change to review</h2>
        <p>
          Enter a range such as <code>main...HEAD</code> in the left panel, or run{" "}
          <code>gantry review main...HEAD --open</code> or <code>/gantry:review</code> in Claude Code.
        </p>
      </div>
    );
  }
  return (
    <div className="rv-canvas" data-testid="review-canvas" data-ready="true" data-mode={review.mode}>
      {nodes.length === 0 ? (
        <div className="empty-state">
          <h2>No code changes</h2>
          <p>
            {review.files.length === 0
              ? "This range changes no indexable TypeScript file."
              : "The changed files hold no changed functions, types or constants."}
          </p>
        </div>
      ) : review.mode === "overlay" ? (
        <Overlay nodes={nodes} focus={focus} onSelect={onSelect} onHover={onHover} />
      ) : (
        <Rings nodes={nodes} edges={edges} focus={focus} onSelect={onSelect} onHover={onHover} />
      )}
      <Legend review={review} />
    </div>
  );
}

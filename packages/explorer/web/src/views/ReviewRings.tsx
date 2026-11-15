import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState, type WheelEvent } from "react";
import type { GraphNode } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import {
  CHANGE_WORDS,
  labelRing,
  markKindOf,
  RINGS_CAPTION,
  ringBounds,
  ringGroups,
  ringPath,
  ringRadii,
  ringTitle,
} from "./reviewModel.ts";

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const R_CHANGED = 11;
const R_CALLER = 7;

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

/** What a node is, in words: its change, or how far it is from the change. */
function roleOf(n: GraphNode): string {
  const hop = n.hop ?? 0;
  if (hop === 0) {
    const kind = n.change ?? "modified";
    return `${(CHANGE_WORDS[kind as keyof typeof CHANGE_WORDS]?.label ?? kind).toLowerCase()}${n.signatureChanged ? ", signature changed" : ""}`;
  }
  return hop === 1 ? "calls the changed code directly" : `${hop} calls away`;
}

/** Point on a circle of radius `r` at clockwise angle `a` from the top. */
const at = (r: number, a: number): [number, number] => [r * Math.sin(a), -r * Math.cos(a)];

interface Tip {
  x: number;
  y: number;
  node: GraphNode;
}

/**
 * Rings mode of the review view: what changed in the centre, then one ring per hop of callers ("Call the changed code
 * directly", "2 calls away", ...), each labelled with its count. Nodes on a ring sit together by file, with a faint
 * arc and the file's name over each group. Changed nodes take the map layer's colours; callers a neutral tone that
 * fades by hop. Edges point from caller to callee; hovering or selecting a node keeps its own path through the rings
 * and fades the rest.
 */
export function ReviewRings({ nodes, edges, focus, onSelect, onHover }: CanvasProps) {
  const bounds = useMemo(() => ringBounds(nodes), [nodes]);
  const radii = useMemo(() => ringRadii(nodes), [nodes]);
  const groups = useMemo(() => ringGroups(nodes), [nodes]);
  const { viewBox, handlers, dragged, zoom, fit } = useViewBox(bounds);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = hover ?? (focus && pos.has(focus) ? focus : null);
  const path = useMemo(() => (active ? ringPath(active, edges) : null), [active, edges]);
  const countByHop = new Map(radii.map((r) => [r.hop, r.count]));
  const centreR = radii.find((r) => r.hop === 0)?.r ?? 0;

  const hoverOn = (n: GraphNode | null, e?: { clientX: number; clientY: number }) => {
    setHover(n?.id ?? null);
    onHover(n?.id ?? null);
    const box = wrap.current?.getBoundingClientRect();
    if (n && e && box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top, node: n });
    else setTip(null);
  };

  return (
    <div className="rv-rings" ref={wrap} data-active={active ?? ""}>
      <p className="rv-caption">{RINGS_CAPTION}</p>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a background click clears the selection; Escape does that from the keyboard */}
      <svg
        className="rv-svg"
        viewBox={viewBox}
        role="img"
        aria-label="Changed code in the centre; each ring out is code that calls the ring inside it"
        {...handlers}
        onClick={(e) => {
          if (e.target === e.currentTarget && !dragged()) onSelect(null);
        }}
      >
        <defs>
          <marker
            id="rv-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="rv-arrow" />
          </marker>
          <marker
            id="rv-arrow-hot"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="rv-arrow-hot" />
          </marker>
        </defs>
        {radii.map((r) =>
          r.hop === 0 ? (
            <text
              key={0}
              className="rv-ring-label rv-ring-label-centre"
              data-hop={0}
              x={0}
              y={-(centreR > 0 ? centreR + 34 : 30)}
              textAnchor="middle"
            >
              {ringTitle(0)} ({r.count})
            </text>
          ) : (
            <g key={r.hop}>
              <circle className="rv-ring" cx={0} cy={0} r={r.r} />
              <text className="rv-ring-label" data-hop={r.hop} x={0} y={-r.r - 12} textAnchor="middle">
                {ringTitle(r.hop)} ({r.count})
              </text>
            </g>
          ),
        )}
        <g>
          {groups.map((g) => {
            // Callers' groups are named just inside their ring (the ring's own title sits outside, at the top);
            // the changed ring's groups just outside it.
            const inside = g.hop > 0;
            const rr = inside ? g.r - 14 : g.r + 16;
            const [x0, y0] = at(rr, g.a0 - 0.04);
            const [x1, y1] = at(rr, g.a1 + 0.04);
            const [mx, my] = at(inside ? rr - 10 : rr + 12, (g.a0 + g.a1) / 2);
            const outward = inside ? mx < 0 : mx > 0;
            const show = g.count >= 2 || groups.filter((x) => x.hop === g.hop).length <= 12;
            return (
              <g key={`${g.hop}:${g.group}`} className="rv-group" data-group={g.group} data-hop={g.hop}>
                {g.count >= 2 && (
                  <path
                    className="rv-group-arc"
                    d={`M${x0},${y0} A${rr},${rr} 0 ${g.a1 - g.a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`}
                  />
                )}
                {show && (
                  <text
                    className="rv-group-label"
                    x={mx}
                    y={my}
                    textAnchor={Math.abs(mx) < 20 ? "middle" : outward ? "start" : "end"}
                  >
                    {g.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <g>
          {edges.map((e) => {
            const a = pos.get(e.src);
            const b = pos.get(e.dst);
            if (!a || !b) return null;
            const ax = a.x ?? 0;
            const ay = a.y ?? 0;
            const bx = b.x ?? 0;
            const by = b.y ?? 0;
            const len = Math.hypot(bx - ax, by - ay) || 1;
            // Stop at the callee's rim so the arrowhead shows.
            const stop = ((b.hop ?? 0) === 0 ? R_CHANGED : R_CALLER) + 2;
            const ex = bx - ((bx - ax) / len) * stop;
            const ey = by - ((by - ay) / len) * stop;
            const hot = path?.edges.has(e.id) ?? false;
            return (
              <line
                key={e.id}
                data-edge={e.id}
                x1={ax}
                y1={ay}
                x2={ex}
                y2={ey}
                markerEnd={`url(#${hot ? "rv-arrow-hot" : "rv-arrow"})`}
                className={`rv-edge${hot ? " rv-edge-hot" : path ? " rv-dim" : ""}`}
              />
            );
          })}
        </g>
        <g>
          {nodes.map((n) => {
            const hop = n.hop ?? 0;
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            const selected = focus === n.id;
            const dim = path !== null && !path.nodes.has(n.id);
            const label = labelRing(hop, countByHop.get(hop) ?? 0) || selected || hover === n.id;
            const right = x >= 0;
            const cls =
              hop === 0
                ? `rv-node rv-fill-${markKindOf({ kind: n.change ?? "modified", signatureChanged: n.signatureChanged === true })}`
                : `rv-node rv-caller rv-caller-${Math.min(3, hop)}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG node is a button for the keyboard and screen readers
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.label}, ${roleOf(n)}`}
                aria-pressed={selected}
                data-id={n.id}
                data-hop={hop}
                className={`rv-node-g${dim ? " rv-dim" : ""}`}
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
                onPointerEnter={(e) => hoverOn(n, e)}
                onPointerMove={(e) => hoverOn(n, e)}
                onPointerLeave={() => hoverOn(null)}
                onFocus={() => hoverOn(n)}
                onBlur={() => hoverOn(null)}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={hop === 0 ? R_CHANGED : R_CALLER}
                  className={`${cls}${selected ? " rv-sel" : ""}`}
                />
                {label && (
                  <text
                    className={`rv-label${hop === 0 ? " rv-label-strong" : ""}`}
                    x={x + (hop === 0 && x === 0 ? 0 : right ? 15 : -15)}
                    y={hop === 0 && x === 0 ? y + 28 : y + 4}
                    textAnchor={hop === 0 && x === 0 ? "middle" : right ? "start" : "end"}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {tip && (
        <div className="gc-tooltip rv-tip" role="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tip.node.label}</strong>
          {tip.node.path && <div>{tip.node.path}</div>}
          <div>{roleOf(tip.node)}</div>
        </div>
      )}
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
    </div>
  );
}

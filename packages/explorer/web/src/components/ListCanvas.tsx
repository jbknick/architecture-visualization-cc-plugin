import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "../api.ts";
import type { CanvasProps } from "../slots.ts";
import { KindBadge } from "./KindBadge.tsx";

const ROW_HEIGHT = 40;
const OVERSCAN = 6;
const FALLBACK_HEIGHT = 600;

const KEY_TARGET: Record<string, (cursor: number, count: number) => number> = {
  ArrowDown: (c) => c + 1,
  ArrowUp: (c) => c - 1,
  PageDown: (c) => c + 10,
  PageUp: (c) => c - 10,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/**
 * Reading order for the list: ego graphs go centre, callers (nearest first), callees (nearest first);
 * hierarchies go parent before children. Anything else keeps the server's order.
 */
export function orderNodes(nodes: GraphNode[]): GraphNode[] {
  if (nodes.some((n) => n.side)) {
    const rank = (n: GraphNode) => (n.side === "focus" ? 0 : n.side === "in" ? 1 : 2);
    return [...nodes].sort((a, b) => rank(a) - rank(b) || (a.hop ?? 0) - (b.hop ?? 0));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const n of nodes) {
    if (n.parent && ids.has(n.parent)) {
      const list = children.get(n.parent) ?? [];
      list.push(n);
      children.set(n.parent, list);
    } else roots.push(n);
  }
  if (children.size === 0) return nodes;
  const out: GraphNode[] = [];
  const visit = (n: GraphNode, guard = 0) => {
    out.push(n);
    if (guard < 20) for (const c of children.get(n.id) ?? []) visit(c, guard + 1);
  };
  // Workspaces and other top-level nodes alphabetically by label; the server sorts by id, which puts folders first.
  for (const r of [...roots].sort((a, b) => a.label.localeCompare(b.label))) visit(r);
  return out;
}

/** Placeholder canvas: a windowed list of nodes. Rows beyond the viewport are never rendered. */
export function ListCanvas({ nodes: rawNodes, edges, focus, onSelect, onHover, onDrill }: CanvasProps) {
  const nodes = useMemo(() => orderNodes(rawNodes), [rawNodes]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [cursor, setCursor] = useState(0);

  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of edges) {
      counts.set(e.src, (counts.get(e.src) ?? 0) + 1);
      counts.set(e.dst, (counts.get(e.dst) ?? 0) + 1);
    }
    return counts;
  }, [edges]);

  // Indent children under their parent so the project map reads as a tree even in this placeholder.
  const depth = useMemo(() => {
    const parentOf = new Map(nodes.map((n) => [n.id, n.parent]));
    const memo = new Map<string, number>();
    const of = (id: string, guard = 0): number => {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      const p = parentOf.get(id);
      const d = p && parentOf.has(p) && guard < 20 ? of(p, guard + 1) + 1 : 0;
      memo.set(id, d);
      return d;
    };
    return of;
  }, [nodes]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || FALLBACK_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the keyboard cursor on the focused node when focus changes from elsewhere (search, deep link).
  useEffect(() => {
    const i = focus ? nodes.findIndex((n) => n.id === focus) : -1;
    if (i >= 0) setCursor(i);
  }, [focus, nodes]);

  const scrollToIndex = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const move = (to: number) => {
    const next = Math.max(0, Math.min(nodes.length - 1, to));
    setCursor(next);
    scrollToIndex(next);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(nodes.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = nodes.slice(first, last);

  return (
    <section className="list-canvas" aria-label="Nodes">
      <div className="canvas-note">
        Placeholder list renderer. {nodes.length} nodes, {edges.length} edges.
      </div>
      {nodes.length === 0 ? (
        <p className="empty">This view has no nodes yet.</p>
      ) : (
        <div
          ref={scroller}
          className="list-scroll"
          role="listbox"
          tabIndex={0}
          aria-label="Graph nodes"
          aria-activedescendant={`node-row-${cursor}`}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={(e) => {
            const target = KEY_TARGET[e.key]?.(cursor, nodes.length);
            if (target !== undefined) {
              e.preventDefault();
              move(target);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const node = nodes[cursor];
              if (node) (e.shiftKey && onDrill ? onDrill : onSelect)(node.id);
            }
          }}
        >
          <div style={{ height: nodes.length * ROW_HEIGHT, position: "relative" }}>
            {visible.map((node, k) => {
              const index = first + k;
              const selected = node.id === focus;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled on the listbox
                <div
                  key={node.id}
                  id={`node-row-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`row ${selected ? "is-selected" : ""} ${index === cursor ? "is-cursor" : ""}`}
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  onClick={() => {
                    setCursor(index);
                    onSelect(node.id);
                  }}
                  onDoubleClick={() => onDrill?.(node.id)}
                  onMouseEnter={() => onHover(node.id)}
                  onMouseLeave={() => onHover(null)}
                >
                  <span className="row-label" style={{ paddingLeft: depth(node.id) * 18 }}>
                    {node.label}
                  </span>
                  <KindBadge kind={node.kind} />
                  <span className="row-meta">
                    {node.side
                      ? node.side === "focus"
                        ? "centre"
                        : `${node.side === "in" ? "caller" : "callee"}, ${node.hop} away`
                      : `${degree.get(node.id) ?? 0} links`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
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

/** Placeholder canvas: a windowed list of nodes. Rows beyond the viewport are never rendered. */
export function ListCanvas({ nodes, edges, focus, onSelect, onHover }: CanvasProps) {
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
              if (node) onSelect(node.id);
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
                  onMouseEnter={() => onHover(node.id)}
                  onMouseLeave={() => onHover(null)}
                >
                  <span className="row-label">{node.label}</span>
                  <KindBadge kind={node.kind} />
                  <span className="row-meta">{degree.get(node.id) ?? 0} links</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

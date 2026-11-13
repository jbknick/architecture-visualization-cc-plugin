import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { fnv1a } from "./layout.ts";
import { MapScene, type TipInfo } from "./scene.ts";
import { mapUi, prefersReducedMotion, useMapUi } from "./ui.ts";

interface Tip extends TipInfo {
  x: number;
  y: number;
}

/** The WebGL canvas for the `force-3d` layout. Loaded lazily; see index.tsx. */
export default function Graph3D({ nodes, edges, focus, onSelect, onHover }: CanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<MapScene | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [ready, setReady] = useState(false);
  const ui = useMapUi();
  // The shell refetches the view on every focus change; only a real data change may re-layout and move the camera.
  const dataKey = useMemo(
    () =>
      fnv1a(
        `${nodes.map((n) => `${n.id}:${n.size}:${n.parent ?? ""}`).join("|")}#${edges.map((e) => `${e.id}:${e.weight}`).join("|")}`,
      ),
    [nodes, edges],
  );
  // The scene is built once; callbacks go through refs so it never has to be rebuilt for a new closure.
  const handlers = useRef({ onSelect, onHover });
  handlers.current = { onSelect, onHover };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new MapScene(
      el,
      {
        onSelect: (id) => handlers.current.onSelect(id),
        onHover: (id) => handlers.current.onHover(id),
        onTip: (t, x, y) => setTip(t ? { ...t, x, y } : null),
      },
      { scheme: currentScheme(), reducedMotion: prefersReducedMotion() },
    );
    scene.current = s;
    s.setAutoRotate(mapUi.get().autoRotate);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => s.setScheme(currentScheme());
    mq?.addEventListener?.("change", onScheme);
    return () => {
      mq?.removeEventListener?.("change", onScheme);
      scene.current = null;
      s.dispose();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `dataKey` stands for nodes and edges; focus has its own effect
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.setData(nodes, edges);
    s.setFocus(focus);
    setReady(true);
  }, [dataKey]);

  useEffect(() => {
    scene.current?.setFocus(focus);
    const s = scene.current;
    if (s) mapUi.selectIsland(focus && s.isIsland(focus) ? focus : null);
  }, [focus]);

  useEffect(() => scene.current?.setAutoRotate(ui.autoRotate), [ui.autoRotate]);

  useEffect(() => {
    if (ui.resetNonce > 0) {
      scene.current?.resetCamera();
      handlers.current.onSelect(null);
    }
  }, [ui.resetNonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fires per request (nonce), not per island change
  useEffect(() => {
    if (ui.flyNonce === 0 || !ui.island) return;
    const s = scene.current;
    if (!s?.isIsland(ui.island)) return;
    handlers.current.onSelect(ui.island);
    s.flyToIsland(ui.island);
  }, [ui.flyNonce]);

  return (
    <div className="map3d" data-ready={ready ? "true" : "false"}>
      <div ref={host} className="map3d-host" data-testid="map3d-canvas" />
      {tip && (
        <div className="map3d-tip" style={{ left: tip.x + 14, top: tip.y + 14 }} role="status">
          <strong>{tip.title}</strong>
          {tip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      {nodes.length === 0 && <p className="empty map3d-empty">Nothing to draw at this level.</p>}
    </div>
  );
}

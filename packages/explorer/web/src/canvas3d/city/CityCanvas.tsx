import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphEdge, type GraphNode } from "../../api.ts";
import { runLayout } from "../../canvas/layoutClient.ts";
import { buildScene, layoutInputFor, type Scene } from "../../canvas/scene.ts";
import type { MapGeometry } from "../../canvas/types.ts";
import { useRankView } from "../../rankedFiles/store.ts";
import { useRanked } from "../../rankedFiles/useRanked.ts";
import type { CanvasProps } from "../../slots.ts";
import { useStore } from "../../store.tsx";
import { currentScheme } from "../../theme.ts";
import { getBool } from "../../views/filterUtils.ts";
import { mapUi, prefersReducedMotion, useMapUi } from "../ui.ts";
import { CityScene, type CityTip } from "./CityScene.ts";
import { buildCity, type CityLevel } from "./model.ts";

/** Layout viewport when the canvas has no size yet (the same default as the 2D map). Not imported from mapLayout: that pulls elk into this chunk. */
const DEFAULT_VIEWPORT = { w: 1200, h: 720 };

interface Tip extends CityTip {
  x: number;
  y: number;
}

interface Loaded {
  level: CityLevel;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
interface Laid {
  level: CityLevel;
  scene: Scene;
  map: MapGeometry;
}

/**
 * The code city: the 2D project map's ground plan (same layout, same collapse rules, same link routes) with folders as
 * plinths, files as buildings, import links as arches. The data comes from the project-map view, so the district
 * rectangles are the 2D map's, whatever level is shown.
 */
export default function CityCanvas({ focus, onSelect, onHover }: CanvasProps) {
  const { state } = useStore();
  const route = state.route;
  const level: CityLevel = route.level === "workspaces" || route.level === "files" ? route.level : "dirs";
  const hideTests = getBool(route.filters, "hideTests", true);
  const filtersKey = useMemo(() => {
    const { style: _style, ...rest } = route.filters;
    return JSON.stringify(rest);
  }, [route.filters]);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CityScene | null>(null);
  const viewport = useRef<{ w: number; h: number } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ui = useMapUi();
  const handlers = useRef({ onSelect, onHover });
  handlers.current = { onSelect, onHover };
  const ranked = useRanked(loaded?.nodes ?? [], hideTests, level === "files");
  const { focusFile, focusNonce } = useRankView();
  const seenFocus = useRef(focusNonce);
  const seenCamera = useRef(ui.cameraNonce);
  const seenFly = useRef(ui.flyNonce);

  // The scene is created once.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new CityScene(
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
      mapUi.setCityData(null);
    };
  }, []);

  // Data: the project-map view at this level and with these filters.
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    const filters = JSON.parse(filtersKey) as Record<string, string>;
    api.view("project-map", { level, filters }, ctl.signal).then(
      (v) => {
        setLoaded({ level, nodes: v.nodes, edges: v.edges });
        mapUi.setCityData({ nodes: v.nodes, edges: v.edges });
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => ctl.abort();
  }, [level, filtersKey]);

  // Layout: exactly what the 2D map runs, for a viewport latched at the first layout so the levels line up.
  useEffect(() => {
    if (!loaded) return;
    const sc = buildScene(loaded.nodes, loaded.edges, "nested-elk");
    if (!viewport.current) {
      const el = host.current;
      viewport.current =
        el && el.clientWidth > 0 && el.clientHeight > 0
          ? { w: el.clientWidth, h: el.clientHeight }
          : DEFAULT_VIEWPORT;
    }
    const job = runLayout(layoutInputFor(sc, "nested-elk", null, undefined, viewport.current, true));
    let alive = true;
    job.promise.then(
      (r) => {
        if (alive && r.map) setLaid({ level: loaded.level, scene: sc, map: r.map });
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [loaded]);

  const city = useMemo(
    () =>
      laid ? buildCity(laid.scene, laid.map, { level: laid.level, showDeclared: ui.showDeclared }) : null,
    [laid, ui.showDeclared],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and ranking have their own effects below
  useEffect(() => {
    if (!city) return;
    scene.current?.setCity(city, true);
    scene.current?.setRanked(ranked.files);
    scene.current?.setSelected(focus);
    mapUi.selectIsland(scene.current?.districtOf(focus) ?? null);
  }, [city]);

  useEffect(() => {
    scene.current?.setSelected(focus);
    mapUi.selectIsland(scene.current?.districtOf(focus) ?? null);
  }, [focus]);
  useEffect(() => scene.current?.setRanked(ranked.files), [ranked.files]);
  useEffect(() => scene.current?.setHoverFile(ranked.hoverFile), [ranked.hoverFile]);
  useEffect(() => {
    if (focusNonce === seenFocus.current) return;
    seenFocus.current = focusNonce;
    if (focusFile) scene.current?.flyTo(focusFile);
  }, [focusFile, focusNonce]);
  useEffect(() => scene.current?.setAutoRotate(ui.autoRotate), [ui.autoRotate]);
  useEffect(() => scene.current?.setPanelHover(ui.hoverIsland), [ui.hoverIsland]);
  useEffect(() => {
    if (ui.cameraNonce === seenCamera.current) return;
    seenCamera.current = ui.cameraNonce;
    scene.current?.setView(ui.cameraView === "top" ? "top" : ui.cameraView === "reset" ? "reset" : "angled");
    if (ui.cameraView === "reset") handlers.current.onSelect(null);
  }, [ui.cameraNonce, ui.cameraView]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires per request (nonce)
  useEffect(() => {
    if (ui.flyNonce <= seenFly.current || !ui.island) return;
    seenFly.current = ui.flyNonce;
    const s = scene.current;
    if (!s?.hasId(ui.island)) return;
    // A click in the list selects the district and shows its arches; double-clicking it on the map flies there.
    handlers.current.onSelect(ui.island);
  }, [ui.flyNonce]);

  const ready = laid !== null && laid.level === level && city !== null;
  return (
    <div className="map3d" data-ready={ready ? "true" : "false"} data-style="city" data-level={level}>
      <div ref={host} className="map3d-host" data-testid="map3d-canvas" />
      {tip && (
        <div className="map3d-tip" style={{ left: tip.x + 14, top: tip.y + 14 }} role="status">
          <strong>{tip.title}</strong>
          {tip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      <p className="map3d-key" data-testid="map3d-key">
        <span>
          <strong>District</strong> = workspace (area = functions)
        </span>
        {" · "}
        <span>
          <strong>Block height</strong> = functions
        </span>
        {" · "}
        <span>
          <strong>Arch A → B</strong> = A imports from B (colour = importer, number = imports)
        </span>
        {level === "files" && ranked.files.length > 0 && (
          <>
            {" · "}
            <span>
              <strong>Flags</strong> = largest files, listed on the left
            </span>
          </>
        )}
        {hideTests && (
          <>
            {" · "}
            <span>Tests hidden</span>
          </>
        )}
      </p>
      {error && <p className="empty map3d-empty">{error}</p>}
      {!error && !ready && <p className="empty map3d-empty">Laying out the city…</p>}
    </div>
  );
}

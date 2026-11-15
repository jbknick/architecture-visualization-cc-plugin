import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphEdge, type GraphNode, type ReviewData, type ReviewLayer } from "../../api.ts";
import { buildScene } from "../../canvas/scene.ts";
import type { CanvasProps } from "../../slots.ts";
import { useStore } from "../../store.tsx";
import { currentScheme } from "../../theme.ts";
import { getBool } from "../../views/filterUtils.ts";
import { useReviewFocus } from "../../views/reviewFocus.ts";
import { FAR_KEY, focusedChange, layerFocus, paintLayer } from "../../views/reviewModel.ts";
import { mapUi, prefersReducedMotion, useMapUi } from "../ui.ts";
import { buildLandscape } from "./model.ts";
import { SettlementScene, type SettlementTip } from "./SettlementScene.ts";

interface Tip extends SettlementTip {
  x: number;
  y: number;
}

/**
 * The settlements view: every workspace a village, town, city or metropolis, every file a building, imports between
 * workspaces as roads and highways with traffic on them. Built from the project map's files-level data, so the counts
 * are the 2D map's.
 */
export default function SettlementCanvas({ focus, onSelect, onHover, data: viewData }: CanvasProps) {
  const { state } = useStore();
  const route = state.route;
  const hideTests = getBool(route.filters, "hideTests", true);
  // The review view's own options (2D/3D, the hop 2-3 tint) do not change the map's data; `range` and `pr` add the
  // review layer to the project map response (#167).
  const filtersKey = useMemo(() => {
    const { style: _style, map: _map, [FAR_KEY]: _far, ...rest } = route.filters;
    return JSON.stringify(rest);
  }, [route.filters]);
  const far = getBool(route.filters, FAR_KEY, false);
  const reviewing = Boolean(viewData?.review);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<SettlementScene | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [data, setData] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    layer: ReviewLayer | null;
    review: ReviewData | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const ui = useMapUi();
  const handlers = useRef({ onSelect, onHover });
  handlers.current = { onSelect, onHover };
  const seenCamera = useRef(ui.cameraNonce);
  const seenFly = useRef(ui.flyNonce);
  const internalSelect = useRef(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new SettlementScene(
      el,
      {
        onSelect: (id) => {
          internalSelect.current = true;
          handlers.current.onSelect(id);
        },
        onHover: (id) => handlers.current.onHover(id),
        onTip: (t, x, y) => setTip(t ? { ...t, x, y } : null),
        onPlaying: setPlaying,
      },
      { scheme: currentScheme(), reducedMotion: prefersReducedMotion() },
    );
    scene.current = s;
    s.setAutoRotate(mapUi.get().autoRotate);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => s.setScheme(currentScheme());
    mq?.addEventListener?.("change", onScheme);
    const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      if (rm?.matches) s.setPlaying(false);
    };
    rm?.addEventListener?.("change", onMotion);
    return () => {
      mq?.removeEventListener?.("change", onScheme);
      rm?.removeEventListener?.("change", onMotion);
      scene.current = null;
      s.dispose();
      mapUi.setCityData(null);
    };
  }, []);

  // Data: the project map at the files level (one building per file), with the view's filters.
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    const filters = JSON.parse(filtersKey) as Record<string, string>;
    api.view("project-map", { level: "files", filters }, ctl.signal).then(
      (v) => {
        setData({ nodes: v.nodes, edges: v.edges, layer: v.review?.layer ?? null, review: v.review ?? null });
        mapUi.setCityData({ nodes: v.nodes, edges: v.edges });
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => ctl.abort();
  }, [filtersKey]);

  const land = useMemo(
    () =>
      data
        ? buildLandscape(buildScene(data.nodes, data.edges, "nested-elk"), { showDeclared: ui.showDeclared })
        : null,
    [data, ui.showDeclared],
  );

  // The review layer resolved against the buildings (one per file); only in the review view or with a range filter.
  // A selected change (or one of its consumers, picked from the panel) shows only that change's consumers and arcs.
  const storedChange = useReviewFocus();
  const focusChange = focusedChange(data?.review, focus, storedChange);
  const paint = useMemo(
    () =>
      land && data?.layer
        ? paintLayer(
            { ids: land.buildings.map((b) => b.id), parents: land.buildings.map(() => -1) },
            data.layer,
            far,
            layerFocus(data.review, focusChange),
          )
        : null,
    [land, data, far, focusChange],
  );
  // A changed symbol picked in the review panel selects (and flies to) the building of its file.
  const shown = (id: string | null): string | null => {
    if (!id || !paint || !land) return id;
    const i = paint.placed.get(id);
    return i === undefined ? id : (land.buildings[i]?.id ?? id);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus has its own effect below
  useEffect(() => {
    if (!land) return;
    scene.current?.setLandscape(land);
    scene.current?.setSelected(shown(focus));
    mapUi.selectIsland(scene.current?.settlementOf(shown(focus)) ?? null);
  }, [land]);
  useEffect(() => scene.current?.setReview(paint), [paint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` follows `paint`
  useEffect(() => {
    const id = shown(focus);
    scene.current?.setSelected(id);
    mapUi.selectIsland(scene.current?.settlementOf(id) ?? null);
    if (reviewing && id && !internalSelect.current && scene.current?.hasId(id)) {
      // A selected change: the camera frames it and its direct consumers (#171); a consumer or a file flies to itself.
      const group =
        focusChange && focus === focusChange
          ? (layerFocus(data?.review, focusChange)?.direct ?? []).flatMap((n) => {
              const i = paint?.placed.get(n);
              const b = i === undefined ? undefined : land?.buildings[i]?.id;
              return b && b !== id && scene.current?.hasId(b) ? [b] : [];
            })
          : [];
      if (group.length > 0) scene.current.flyToGroup(id, group);
      else scene.current.flyTo(id);
    }
    internalSelect.current = false;
  }, [focus, paint]);
  useEffect(() => scene.current?.setAutoRotate(ui.autoRotate), [ui.autoRotate]);
  useEffect(() => scene.current?.setPanelHover(ui.hoverIsland), [ui.hoverIsland]);
  useEffect(() => {
    if (ui.cameraNonce === seenCamera.current) return;
    seenCamera.current = ui.cameraNonce;
    const v = ui.cameraView;
    scene.current?.setView(
      v === "top" ? "top" : v === "street" ? "street" : v === "reset" ? "reset" : "overview",
    );
    if (v === "reset") handlers.current.onSelect(null);
  }, [ui.cameraNonce, ui.cameraView]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires per request (nonce)
  useEffect(() => {
    if (ui.flyNonce <= seenFly.current || !ui.island) return;
    seenFly.current = ui.flyNonce;
    if (!scene.current?.hasId(ui.island)) return;
    handlers.current.onSelect(ui.island);
    scene.current.flyTo(ui.island);
  }, [ui.flyNonce]);

  const ready = land !== null;
  return (
    <div className="map3d" data-ready={ready ? "true" : "false"} data-style="settlements">
      <div ref={host} className="map3d-host" data-testid="map3d-canvas" />
      <div className="s3-controls">
        <button
          type="button"
          className="s3-play"
          data-testid="map3d-pause"
          aria-pressed={!playing}
          title={playing ? "Stop the traffic and other motion" : "Start the traffic and other motion"}
          onClick={() => scene.current?.setPlaying(!playing)}
        >
          <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span> {playing ? "Pause life" : "Play life"}
        </button>
      </div>
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
          <strong>Settlement</strong> = workspace (village → town → city → metropolis by functions)
        </span>
        {" · "}
        <span>
          <strong>Building</strong> = file (taller = more functions, wider = more lines; roof = workspace
          colour)
        </span>
        {" · "}
        <span>
          <strong>Road</strong> = imports (lane, road, highway by count); traffic drives from importer to
          imported
        </span>
        {hideTests && (
          <>
            {" · "}
            <span>Tests hidden</span>
          </>
        )}
      </p>
      {error && <p className="empty map3d-empty">{error}</p>}
      {!error && !ready && <p className="empty map3d-empty">Founding the settlements…</p>}
    </div>
  );
}

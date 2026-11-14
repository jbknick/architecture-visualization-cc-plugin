import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Inspector } from "./components/Inspector.tsx";
import { LeftPanel } from "./components/LeftPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { useViewData } from "./hooks.ts";
import { getCanvas, getFocusPrompt } from "./slots.ts";
import { useStore } from "./store.tsx";
import { drillPatch } from "./views/drill.ts";
import "./canvases.ts";
import "./views/index.ts";

/** Rows one side of the ego view may have, from the room the canvas leaves (see canvas/bowtieLayout.ts): about 30px a row. */
export function egoMaxRows(innerHeight: number): number {
  const canvasHeight = innerHeight - 56 - 32; // top bar and status bar
  return Math.max(8, Math.min(24, Math.floor((canvasHeight - 96) / 30)));
}

function useEgoMaxRows(): number {
  const [h, setH] = useState(() => (typeof window === "undefined" ? 900 : window.innerHeight));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => setH(window.innerHeight), 300);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return egoMaxRows(h);
}

export function App() {
  const store = useStore();
  const { state, view, navigate, selectNode, toggleLeft, setHover, setView } = store;
  const { route, meta, metaError, leftOpen } = state;
  const FocusPrompt = view ? getFocusPrompt(view) : null;
  const needsFocus = FocusPrompt !== null && !route.focus;
  const maxRows = useEgoMaxRows();
  const filters = useMemo(
    () => (view === "ego" ? { ...route.filters, maxRows: String(maxRows) } : route.filters),
    [view, route.filters, maxRows],
  );
  const { data, loading, error } = useViewData(needsFocus ? null : view, {
    focus: route.focus,
    level: route.level,
    hops: route.hops,
    filters,
  });

  const nodes = needsFocus ? [] : (data?.nodes ?? []);
  const edges = needsFocus ? [] : (data?.edges ?? []);
  const Canvas = getCanvas(data?.layoutHint ?? "list");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && route.sel && !(e.target instanceof HTMLInputElement)) selectNode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.sel, selectNode]);

  if (metaError) {
    return (
      <div className="fatal" role="alert">
        <h1>Cannot reach the Gantry server</h1>
        <p>{metaError}. Start it again with `gantry map`, or open the link from `gantry_open_view`.</p>
      </div>
    );
  }

  const onDrill = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    const patch = view && node ? drillPatch(view, node) : null;
    if (patch) navigate(patch);
    else selectNode(id);
  };

  let center: ReactNode;
  if (needsFocus && FocusPrompt && view) center = <FocusPrompt viewId={view} />;
  else if (error)
    center = (
      <div className="empty-state" role="alert">
        <h2>This view could not be loaded</h2>
        <p>{error}</p>
        {view && (
          <button type="button" className="btn" onClick={() => setView(view)}>
            Reset this view
          </button>
        )}
      </div>
    );
  else if (!data) center = <p className="empty">Loading view…</p>;
  else
    center = (
      <Canvas
        nodes={nodes}
        edges={edges}
        layoutHint={data.layoutHint}
        focus={route.sel}
        onSelect={(id) => selectNode(id)}
        onHover={setHover}
        onDrill={onDrill}
      />
    );

  return (
    <div className={`app ${route.sel ? "has-inspector" : ""} ${leftOpen ? "" : "left-collapsed"}`}>
      <TopBar />
      <LeftPanel
        open={leftOpen}
        onToggle={toggleLeft}
        viewId={view}
        nodes={nodes}
        edges={edges}
        filters={route.filters}
        onFiltersChange={(filters) => navigate({ filters })}
        route={route}
        onRouteChange={navigate}
      />
      <main className="center">{center}</main>
      {route.sel && <Inspector nodes={nodes} />}
      <StatusBar
        meta={meta}
        shownNodes={nodes.length}
        shownEdges={edges.length}
        loading={loading && !needsFocus}
        error={needsFocus ? null : error}
      />
    </div>
  );
}

import { useEffect } from "react";
import { Inspector } from "./components/Inspector.tsx";
import { LeftPanel } from "./components/LeftPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { useViewData } from "./hooks.ts";
import { getCanvas } from "./slots.ts";
import { useStore } from "./store.tsx";
import "./canvases.ts";

export function App() {
  const store = useStore();
  const { state, view, navigate, focusNode, toggleLeft, setHover } = store;
  const { route, meta, metaError, leftOpen } = state;
  const { data, loading, error } = useViewData(view, route.focus, route.depth, route.filters);

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const Canvas = getCanvas(data?.layoutHint ?? "list");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && route.focus && !(e.target instanceof HTMLInputElement)) focusNode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.focus, focusNode]);

  if (metaError) {
    return (
      <div className="fatal" role="alert">
        <h1>Cannot reach the Gantry server</h1>
        <p>{metaError}. Start it again with `gantry map`, or open the link from `gantry_open_view`.</p>
      </div>
    );
  }

  return (
    <div className={`app ${route.focus ? "has-inspector" : ""} ${leftOpen ? "" : "left-collapsed"}`}>
      <TopBar />
      <LeftPanel
        open={leftOpen}
        onToggle={toggleLeft}
        viewId={view}
        nodes={nodes}
        edges={edges}
        filters={route.filters}
        onFiltersChange={(filters) => navigate({ filters })}
      />
      <main className="center">
        {!data && !error ? (
          <p className="empty">Loading view…</p>
        ) : (
          <Canvas
            nodes={nodes}
            edges={edges}
            layoutHint={data?.layoutHint ?? "list"}
            focus={route.focus}
            onSelect={(id) => focusNode(id)}
            onHover={setHover}
          />
        )}
      </main>
      {route.focus && <Inspector nodes={nodes} />}
      <StatusBar
        meta={meta}
        shownNodes={nodes.length}
        shownEdges={edges.length}
        loading={loading}
        error={error}
      />
    </div>
  );
}

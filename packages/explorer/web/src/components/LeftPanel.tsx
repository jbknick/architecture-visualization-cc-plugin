import type { Filters, GraphEdge, GraphNode, ViewData } from "../api.ts";
import type { Route } from "../route.ts";
import { getFilterPanel } from "../slots.ts";
import { KINDS } from "../theme.ts";

interface Props {
  open: boolean;
  onToggle: () => void;
  viewId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  data?: ViewData | null;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  route?: Route;
  onRouteChange?: (patch: Partial<Route>) => void;
}

export function LeftPanel({
  open,
  onToggle,
  viewId,
  nodes,
  edges,
  data,
  filters,
  onFiltersChange,
  route,
  onRouteChange,
}: Props) {
  const Panel = viewId ? getFilterPanel(viewId) : null;
  // The project map's panel already lists the workspaces with their colours; the kind colours only matter once
  // functions are drawn.
  // The ego view colours by workspace and lists them in its own panel; the 3D map has its own "how to read it"
  // block and workspace list (kind colours never appear in either).
  const showKindLegend =
    viewId !== "ego" &&
    viewId !== "map-3d" &&
    viewId !== "duplicates" &&
    (viewId !== "project-map" || route?.level === "symbols");
  return (
    <aside className={`left ${open ? "" : "is-collapsed"}`} aria-label="Filters">
      <button
        type="button"
        className="icon-btn left-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Collapse filters" : "Expand filters"}
        title={open ? "Collapse filters" : "Expand filters"}
      >
        {open ? "‹" : "›"}
      </button>
      {open && (
        <div className="left-body">
          <h2 className="panel-title">Filters</h2>
          {Panel && viewId ? (
            <Panel
              viewId={viewId}
              nodes={nodes}
              edges={edges}
              data={data}
              filters={filters}
              onFiltersChange={onFiltersChange}
              route={route}
              onRouteChange={onRouteChange}
            />
          ) : (
            <p className="muted">This view has no filters.</p>
          )}
          {showKindLegend && (
            <>
              <h2 className="panel-title legend-title">Legend</h2>
              <ul className="legend">
                {KINDS.map((kind) => (
                  <li key={kind}>
                    <span
                      className="kind-dot"
                      style={{ background: `var(--kind-${kind})` }}
                      aria-hidden="true"
                    />
                    {kind}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

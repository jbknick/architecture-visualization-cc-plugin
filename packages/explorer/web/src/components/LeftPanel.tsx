import type { Filters, GraphEdge, GraphNode } from "../api.ts";
import type { Route } from "../route.ts";
import { getFilterPanel } from "../slots.ts";
import { KINDS } from "../theme.ts";

interface Props {
  open: boolean;
  onToggle: () => void;
  viewId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  filters,
  onFiltersChange,
  route,
  onRouteChange,
}: Props) {
  const Panel = viewId ? getFilterPanel(viewId) : null;
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
              filters={filters}
              onFiltersChange={onFiltersChange}
              route={route}
              onRouteChange={onRouteChange}
            />
          ) : (
            <p className="muted">This view has no filters.</p>
          )}
          <h2 className="panel-title legend-title">Legend</h2>
          <ul className="legend">
            {KINDS.map((kind) => (
              <li key={kind}>
                <span className="kind-dot" style={{ background: `var(--kind-${kind})` }} aria-hidden="true" />
                {kind}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

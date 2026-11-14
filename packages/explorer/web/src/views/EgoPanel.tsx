import { useId, useMemo } from "react";
import type { GraphNode } from "../api.ts";
import { weightOf, workspaceRanks } from "../canvas/bowtieLayout.ts";
import type { FilterPanelProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import {
  describeSide,
  EGO_MAX_NODES,
  expandedIds,
  summarizeEgo,
  withExpanded,
  workspaceShortNames,
} from "./egoGroups.ts";
import { getBool, getList, setBool, setList } from "./filterUtils.ts";

export const DEFAULT_HOPS = 2;

const EDGE_KINDS: { id: string; label: string; hint: string }[] = [
  { id: "calls", label: "Calls", hint: "A function calling another function" },
  { id: "renders", label: "Renders", hint: "A component rendering another component" },
  { id: "uses_hook", label: "Uses hook", hint: "A component or hook using a hook" },
  { id: "imports", label: "Imports", hint: "A file importing another file" },
];

/** The server's default connection types: file imports for a file, everything else for a function. */
export function defaultEdgeKinds(focus: string | null): string[] {
  return focus?.startsWith("file:") ? ["imports"] : ["calls", "renders", "uses_hook"];
}

/** Scrolls and zooms the ego canvas to a node (the canvas listens for this event). */
function zoomCanvasTo(id: string): void {
  document
    .querySelector('[data-testid="graph-canvas"]')
    ?.dispatchEvent(new CustomEvent("gantry:zoom-to", { detail: { id } }));
}

function GroupsSection({
  nodes,
  filters,
  onFiltersChange,
}: Pick<FilterPanelProps, "nodes" | "filters" | "onFiltersChange">) {
  const summary = useMemo(() => summarizeEgo(nodes), [nodes]);
  const ranks = useMemo(() => workspaceRanks(nodes), [nodes]);
  const scheme = currentScheme();
  const expanded = expandedIds(filters);
  const { groups } = summary;
  if (groups.length === 0 && expanded.length === 0) return null;
  const collapsed = groups.filter((g) => !g.expanded);
  const tooMany = summary.nodesIfAllExpanded > EGO_MAX_NODES;
  const dot = (g: GraphNode) => {
    const rank = g.workspace ? ranks.get(g.workspace) : undefined;
    return rank === undefined ? "var(--muted)" : workspaceColorAt(rank, scheme);
  };
  const toggle = (g: GraphNode) =>
    onFiltersChange(
      withExpanded(filters, g.expanded ? expanded.filter((x) => x !== g.id) : [...expanded, g.id]),
    );
  return (
    <section className="filter-group" aria-label="Groups">
      <h3>Groups</h3>
      <p className="muted">
        Large sides are grouped by workspace, then folder, then file. Click a group to open it.
      </p>
      <div className="group-actions">
        <button
          type="button"
          className="btn"
          disabled={collapsed.length === 0 || tooMany}
          title={
            tooMany
              ? `Opening every group would show ${summary.nodesIfAllExpanded} nodes, over the limit of ${EGO_MAX_NODES}.`
              : "Show every member of every group"
          }
          onClick={() => onFiltersChange(withExpanded(filters, [...expanded, ...collapsed.map((g) => g.id)]))}
        >
          Expand all
        </button>
        <button
          type="button"
          className="btn"
          disabled={expanded.length === 0}
          onClick={() => onFiltersChange(withExpanded(filters, []))}
        >
          Collapse all
        </button>
      </div>
      {tooMany && collapsed.length > 0 && (
        <p className="muted" role="note">
          Too many to show at once ({summary.nodesIfAllExpanded.toLocaleString("en-US")} nodes, limit{" "}
          {EGO_MAX_NODES}). Open groups one at a time.
        </p>
      )}
      <ul className="group-list">
        {groups.map((g) => (
          <li key={g.id}>
            <button type="button" className="group-row" title={g.label} onClick={() => zoomCanvasTo(g.id)}>
              <span className="kind-dot" style={{ background: dot(g) }} aria-hidden="true" />
              <span className="group-name">{g.label}</span>
              <span className="group-count">{g.stats?.members ?? g.size}</span>
            </button>
            <button
              type="button"
              className="link-btn group-toggle"
              aria-label={`${g.expanded ? "Collapse" : "Expand"} ${g.label}`}
              aria-expanded={Boolean(g.expanded)}
              onClick={() => toggle(g)}
            >
              {g.expanded ? "Collapse" : "Expand"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkspaceKey({ nodes }: { nodes: FilterPanelProps["nodes"] }) {
  const ranks = useMemo(() => workspaceRanks(nodes), [nodes]);
  const names = useMemo(() => workspaceShortNames([...ranks.keys()]), [ranks]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes)
      if (n.workspace && n.side !== "focus") m.set(n.workspace, (m.get(n.workspace) ?? 0) + weightOf(n));
    return m;
  }, [nodes]);
  // Only workspaces that have callers or callees (the focus's own is not coloured).
  const rows = [...ranks].filter(([id]) => (counts.get(id) ?? 0) > 0);
  if (rows.length < 2) return null;
  const scheme = currentScheme();
  return (
    <section className="filter-group" aria-label="Workspace colours">
      <h3>Colours</h3>
      <ul className="group-list">
        {rows.map(([id, rank]) => (
          <li key={id}>
            <span className="group-row is-static" title={id}>
              <span
                className="kind-dot"
                style={{ background: workspaceColorAt(rank, scheme) }}
                aria-hidden="true"
              />
              <span className="group-name">{names.get(id) ?? id}</span>
              <span className="group-count">{counts.get(id) ?? 0}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EgoPanel({ nodes, filters, onFiltersChange, route, onRouteChange }: FilterPanelProps) {
  const sliderId = useId();
  const focus = route?.focus ?? null;
  const hops = route?.hops ?? DEFAULT_HOPS;
  const defaults = defaultEdgeKinds(focus);
  const kinds = getList(filters, "edgeKinds") ?? defaults;
  const centre = nodes.find((n) => n.side === "focus");
  const summary = useMemo(() => summarizeEgo(nodes), [nodes]);

  const setKind = (id: string, on: boolean) => {
    const next = on ? [...new Set([...kinds, id])] : kinds.filter((k) => k !== id);
    if (next.length === 0) return; // at least one connection type must stay on
    onFiltersChange(setList(filters, "edgeKinds", next, defaults));
  };

  return (
    <div className="filter-panel" data-view="ego">
      <section className="filter-group" aria-label="Centred on">
        <h3>Centred on</h3>
        {focus ? (
          <>
            <p className="focus-name">{centre?.label ?? focus}</p>
            {centre && (
              <div className="ego-summary">
                <p className="ego-line">{describeSide(summary.callers, "caller", "callers")}</p>
                <p className="ego-line">{describeSide(summary.callees, "callee", "callees")}</p>
                <p className="muted">
                  within {hops} {hops === 1 ? "step" : "steps"}
                </p>
              </div>
            )}
            {centre && nodes.length === 1 && (
              <p className="notice">
                Nothing is connected within {hops} {hops === 1 ? "step" : "steps"} for the selected connection
                types. Try more steps or turn on more connection types.
              </p>
            )}
            <p className="muted">Search (Cmd/Ctrl+K) to centre on a different function.</p>
          </>
        ) : (
          <p className="muted">Nothing chosen yet. Search for a function to begin.</p>
        )}
      </section>

      <GroupsSection nodes={nodes} filters={filters} onFiltersChange={onFiltersChange} />
      <WorkspaceKey nodes={nodes} />

      <section className="filter-group" aria-label="How far">
        <h3>How far to look</h3>
        <label htmlFor={sliderId} className="slider-label">
          <span>Steps away</span>
          <output htmlFor={sliderId}>{hops}</output>
        </label>
        <input
          id={sliderId}
          type="range"
          min={1}
          max={4}
          step={1}
          value={hops}
          aria-valuetext={`${hops} ${hops === 1 ? "step" : "steps"}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            onRouteChange?.({ hops: n === DEFAULT_HOPS ? null : n });
          }}
        />
        <p className="muted">1 shows direct callers and callees only.</p>
      </section>

      <section className="filter-group" aria-label="Connection types">
        <h3>Connection types</h3>
        {EDGE_KINDS.map((k) => (
          <label className="check" key={k.id} title={k.hint}>
            <input
              type="checkbox"
              checked={kinds.includes(k.id)}
              disabled={kinds.length === 1 && kinds.includes(k.id)}
              onChange={(e) => setKind(k.id, e.target.checked)}
            />
            <span className="check-label">{k.label}</span>
          </label>
        ))}
      </section>

      <section className="filter-group" aria-label="Certainty">
        <h3>Certainty</h3>
        <label className="check" title="Hide links that Gantry could only guess at">
          <input
            type="checkbox"
            checked={getBool(filters, "highConfidence", false)}
            onChange={(e) => onFiltersChange(setBool(filters, "highConfidence", e.target.checked, false))}
          />
          <span className="check-label">High confidence only</span>
        </label>
      </section>
    </div>
  );
}

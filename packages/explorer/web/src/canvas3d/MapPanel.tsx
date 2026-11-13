import { useMemo } from "react";
import "./map3d.css";
import type { FilterPanelProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { summarizeIslands } from "./layout.ts";
import { workspaceColor } from "./palette.ts";
import { mapUi, prefersReducedMotion, useMapUi } from "./ui.ts";

const LEVELS = [
  { id: "workspaces", label: "Workspaces" },
  { id: "dirs", label: "Folders" },
  { id: "files", label: "Files" },
] as const;

/** Left-panel controls for the 3D map: level, hide tests, auto-rotate, reset camera, and the workspace legend. */
export function MapPanel({ nodes, filters, onFiltersChange }: FilterPanelProps) {
  const ui = useMapUi();
  const level = filters.level ?? "dirs";
  const hideTests = filters.tests !== "show";
  const islands = useMemo(() => summarizeIslands(nodes), [nodes]);
  const scheme = currentScheme();
  const reduced = prefersReducedMotion();

  const patch = (next: Record<string, string | null>) => {
    const out = { ...filters };
    for (const [k, v] of Object.entries(next)) {
      if (v === null) delete out[k];
      else out[k] = v;
    }
    onFiltersChange(out);
  };

  return (
    <div className="map3d-panel">
      <fieldset className="map3d-levels">
        <legend className="muted">Level</legend>
        {LEVELS.map((l) => (
          <label key={l.id} className="map3d-radio">
            <input
              type="radio"
              name="map3d-level"
              checked={level === l.id}
              onChange={() => patch({ level: l.id === "dirs" ? null : l.id })}
            />
            {l.label}
          </label>
        ))}
      </fieldset>
      <label className="map3d-check">
        <input
          type="checkbox"
          checked={hideTests}
          onChange={(e) => patch({ tests: e.target.checked ? null : "show" })}
        />
        Hide tests
      </label>
      <label className="map3d-check">
        <input
          type="checkbox"
          checked={ui.autoRotate && !reduced}
          disabled={reduced}
          onChange={(e) => mapUi.setAutoRotate(e.target.checked)}
        />
        Auto-rotate{reduced ? " (off: reduced motion)" : ""}
      </label>
      <button type="button" className="map3d-reset" onClick={() => mapUi.resetCamera()}>
        Reset camera
      </button>

      <h3 className="panel-title legend-title">Workspaces</h3>
      <ul className="map3d-legend">
        {islands.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              className={`map3d-legend-row ${ui.island === i.id ? "is-active" : ""}`}
              aria-pressed={ui.island === i.id}
              onClick={() => mapUi.focusIsland(i.id)}
            >
              <span
                className="kind-dot"
                style={{ background: workspaceColor(i.index, scheme) }}
                aria-hidden="true"
              />
              <span className="map3d-legend-name">{i.label}</span>
              <span className="map3d-legend-meta">
                {i.wsKind} · {i.functions} fn · {i.files} files
              </span>
            </button>
          </li>
        ))}
        {islands.length === 0 && <li className="muted">No workspaces in this view.</li>}
      </ul>
    </div>
  );
}

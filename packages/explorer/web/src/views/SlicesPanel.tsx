import type { ViewLevel } from "../api.ts";
import type { FilterPanelProps } from "../slots.ts";
import { getBool, setBool } from "./filterUtils.ts";

const LEVELS: { id: ViewLevel; label: string; hint: string }[] = [
  { id: "workspaces", label: "Slices", hint: "One box per slice" },
  { id: "files", label: "Files", hint: "Slices and the files inside them" },
  { id: "symbols", label: "Functions", hint: "Files and the functions inside them" },
];

/** Slices view (#38): detail level, whether imports inside a slice are drawn, and the "shared by" list. */
export function SlicesPanel({
  nodes,
  data,
  filters,
  onFiltersChange,
  route,
  onRouteChange,
}: FilterPanelProps) {
  const level = route?.level ?? "files";
  const slices = nodes.filter((n) => n.kind === "slice");
  const shared = data?.shared ?? [];
  const crossEdges = (data?.edges ?? []).filter((e) => e.cross && e.src.startsWith("slice:"));
  const fallback = data?.routeFallback ?? [];
  return (
    <div className="filter-panel" data-view="slices">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        <p className="muted">
          {slices.length === 0
            ? "No slices found. Set views.slices in the config, or index an app that uses TanStack Router."
            : `${slices.length} ${slices.length === 1 ? "slice" : "slices"}; ${crossEdges.length} ${crossEdges.length === 1 ? "link" : "links"} between them. A link counts the files that import across the boundary.`}
        </p>
        {fallback.length > 0 && (
          <p className="muted">
            Some apps match no slice pattern, so their first-level route segments are used as slices.
          </p>
        )}
      </section>

      {onRouteChange && (
        <section className="filter-group" aria-label="Detail level">
          <h3>How much detail</h3>
          <div className="segmented" role="radiogroup" aria-label="Detail level">
            {LEVELS.map((l) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={level === l.id}
                title={l.hint}
                className="segment"
                onClick={() => onRouteChange({ level: l.id === "files" ? null : l.id })}
              >
                {l.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="filter-group" aria-label="Shared by">
        <h3>Shared by</h3>
        {shared.length === 0 ? (
          <p className="muted">No function is used from two or more other slices.</p>
        ) : (
          <>
            <p className="muted">Functions used from at least two other slices.</p>
            <ul className="group-list">
              {shared.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="group-row"
                    title={`${s.path}\nUsed by ${s.usedBy.map((u) => u.label).join(", ")}`}
                    onClick={() => onRouteChange?.({ sel: s.id })}
                  >
                    <span className="kind-dot" style={{ background: `var(--kind-${s.kind})` }} aria-hidden />
                    <span className="group-name">{s.name}</span>
                    <span className="group-count">{s.usedBy.length} slices</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="filter-group" aria-label="Show or hide">
        <h3>Show or hide</h3>
        <label className="check" title="Also draw imports between files of the same slice">
          <input
            type="checkbox"
            checked={getBool(filters, "intra", false)}
            onChange={(e) => onFiltersChange(setBool(filters, "intra", e.target.checked, false))}
          />
          <span className="check-label">Imports inside a slice</span>
        </label>
        <label className="check" title="Leave out test and spec files">
          <input
            type="checkbox"
            checked={getBool(filters, "hideTests", true)}
            onChange={(e) => onFiltersChange(setBool(filters, "hideTests", e.target.checked, true))}
          />
          <span className="check-label">Hide tests</span>
        </label>
      </section>
    </div>
  );
}

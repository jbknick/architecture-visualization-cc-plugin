import { useMemo } from "react";
import type { DupTier } from "../api.ts";
import type { FilterPanelProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import { TIER_ORDER, TIER_WORDS } from "./dupModel.ts";
import { getBool, getList, setBool, setList } from "./filterUtils.ts";

/** The server looks for all four unless told otherwise. */
const DEFAULT_TIERS: DupTier[] = [...TIER_ORDER];
const MIN_SIZES = [2, 3, 4, 5];

export function DuplicatesPanel({ data, filters, onFiltersChange }: FilterPanelProps) {
  const workspaces = data?.workspaces ?? [];
  const scheme = currentScheme();
  const tiers = (getList(filters, "tiers") ?? DEFAULT_TIERS) as DupTier[];
  const picked = getList(filters, "workspaces");
  const allIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const chosen = picked ?? allIds;
  const minSize = Number(filters.minSize ?? 2);

  return (
    <div className="filter-panel">
      <section className="filter-group" aria-label="How alike">
        <h3>How alike</h3>
        {TIER_ORDER.map((t) => {
          const skipped = data?.skipped?.some((s) => s.tier === t);
          return (
            <label className="check" key={t} title={TIER_WORDS[t].hint}>
              <input
                type="checkbox"
                checked={tiers.includes(t)}
                onChange={(e) =>
                  onFiltersChange(
                    setList(
                      filters,
                      "tiers",
                      e.target.checked ? [...tiers, t] : tiers.filter((x) => x !== t),
                      DEFAULT_TIERS,
                    ),
                  )
                }
              />
              <span className="check-text">
                <span>{TIER_WORDS[t].label}</span>
                {skipped && <span className="check-note">Not checked yet: run gantry embed</span>}
              </span>
            </label>
          );
        })}
      </section>

      <section className="filter-group" aria-label="Group size">
        <h3>Group size</h3>
        <label className="largest-scope">
          <span>At least</span>
          <select
            aria-label="Smallest group"
            value={minSize}
            onChange={(e) => {
              const next = { ...filters };
              if (Number(e.target.value) === 2) delete next.minSize;
              else next.minSize = e.target.value;
              onFiltersChange(next);
            }}
          >
            {MIN_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} copies
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="filter-group" aria-label="Workspaces">
        <h3>Workspaces</h3>
        <p className="muted">Show groups that have a copy in:</p>
        {workspaces.length === 0 && <p className="muted">No workspaces.</p>}
        {workspaces.map((w, i) => (
          <label className="check" key={w.id}>
            <input
              type="checkbox"
              checked={chosen.includes(w.id)}
              onChange={(e) =>
                onFiltersChange(
                  setList(
                    filters,
                    "workspaces",
                    e.target.checked ? [...chosen, w.id] : chosen.filter((x) => x !== w.id),
                    allIds,
                  ),
                )
              }
            />
            <span
              className="kind-dot"
              style={{ background: workspaceColorAt(i, scheme) }}
              aria-hidden="true"
            />
            <span className="check-label" title={w.name}>
              {w.shortLabel}
            </span>
          </label>
        ))}
      </section>

      <section className="filter-group" aria-label="Files">
        <h3>Files</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={getBool(filters, "hideTests", true)}
            onChange={(e) => onFiltersChange(setBool(filters, "hideTests", e.target.checked, true))}
          />
          <span>Hide tests</span>
        </label>
      </section>
    </div>
  );
}

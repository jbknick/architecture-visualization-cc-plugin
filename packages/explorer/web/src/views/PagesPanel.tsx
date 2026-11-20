import { useId, useState } from "react";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import type { FilterPanelProps } from "../slots.ts";
import { getList, setList } from "./filterUtils.ts";

/** Steps followed from a page's component through renders and hooks; the server's default. */
export const PAGES_DEFAULT_DEPTH = 2;

/** Pages view (#38): app and route-prefix filters, and how many steps below each component to show. */
export function PagesPanel({
  nodes,
  data,
  filters,
  onFiltersChange,
  route,
  onRouteChange,
}: FilterPanelProps) {
  const sliderId = useId();
  const prefixId = useId();
  const hops = route?.hops ?? PAGES_DEFAULT_DEPTH;
  const apps = data?.apps ?? [];
  const picked = getList(filters, "app");
  const allIds = apps.map((a) => a.id);
  const isOn = (id: string) => (picked ? picked.includes(id) : true);
  const setApp = (id: string, on: boolean) => {
    const current = picked ?? allIds;
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    onFiltersChange(setList(filters, "app", next.length === 0 ? allIds : next, allIds));
  };
  const prefix = filters.prefix ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (value: string) => {
    setDraft(null);
    const next = { ...filters };
    const v = value.trim();
    if (v === "" || v === "/") delete next.prefix;
    else next.prefix = v;
    if (JSON.stringify(next) !== JSON.stringify(filters)) onFiltersChange(next);
  };
  const routes = nodes.filter((n) => n.kind === "route");
  const shared = nodes.filter((n) => n.badges?.some((b) => b.startsWith("shared by")));

  return (
    <div className="filter-panel" data-view="pages">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        <p className="muted">
          {routes.length === 0
            ? "No routes found. This view reads TanStack Router file routes."
            : `${routes.length} ${routes.length === 1 ? "route" : "routes"}, each with the component it serves and what that component renders. Components used by several pages are drawn once.`}
        </p>
        {shared.length > 0 && (
          <ul className="group-list" aria-label="Shared components">
            {shared.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="group-row"
                  title={n.path ?? n.id}
                  onClick={() => onRouteChange?.({ sel: n.id })}
                >
                  <span className="kind-dot" style={{ background: `var(--kind-${n.kind})` }} aria-hidden />
                  <span className="group-name">{n.label}</span>
                  <span className="group-count">{n.badges?.find((b) => b.startsWith("shared by"))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="filter-group" aria-label="How far">
        <h3>How far to look</h3>
        <label htmlFor={sliderId} className="slider-label">
          <span>Steps below each component</span>
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
            onRouteChange?.({ hops: n === PAGES_DEFAULT_DEPTH ? null : n });
          }}
        />
        <p className="muted">1 shows only what the page component uses directly.</p>
      </section>

      <section className="filter-group" aria-label="Route prefix">
        <h3>Route prefix</h3>
        <label htmlFor={prefixId} className="slider-label">
          <span>Only routes under</span>
        </label>
        <Input
          id={prefixId}
          type="text"
          placeholder="/settings"
          value={draft ?? prefix}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          }}
        />
        <p className="muted">Parent layouts stay so the tree is connected.</p>
      </section>

      {apps.length > 1 && (
        <section className="filter-group" aria-label="Apps">
          <h3>Apps</h3>
          {apps.map((a) => (
            <label className="check" key={a.id} title={a.name}>
              <Checkbox checked={isOn(a.id)} onCheckedChange={(checked) => setApp(a.id, checked)} />
              <span className="check-text">
                <span className="check-label">{a.shortLabel}</span>
                <span className="check-note">
                  {a.routes} {a.routes === 1 ? "route" : "routes"}
                </span>
              </span>
            </label>
          ))}
        </section>
      )}
    </div>
  );
}

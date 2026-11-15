import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { Filters, ViewLevel } from "../api.ts";
import type { FilterPanelProps } from "../slots.ts";
import { useStore } from "../store.tsx";
import { getBool, setBool } from "./filterUtils.ts";
import { CHANGE_WORDS, CROSSING_WORDS, FAR_KEY, markKindOf, RISK_WORDS, shortName } from "./reviewModel.ts";

const MAPS = [
  {
    id: "2d",
    label: "2D map",
    hint: "The project map: workspaces, folders, files and functions in their usual place",
  },
  { id: "3d", label: "3D map", hint: "The settlements: one building per file, in its usual place" },
] as const;

const MODES = [
  {
    id: "map",
    label: "On the map",
    hint: "The review as a layer on the project map, every node in its usual place",
  },
  {
    id: "rings",
    label: "Rings",
    hint: "What changed in the centre; each ring out is code that calls the ring inside it",
  },
] as const;

const LEVELS: { id: ViewLevel; label: string; hint: string }[] = [
  { id: "workspaces", label: "Workspaces", hint: "Lines between workspaces" },
  { id: "dirs", label: "Folders", hint: "Lines between folders" },
  { id: "files", label: "Files", hint: "Lines from file to file" },
  { id: "symbols", label: "Functions", hint: "Lines from function to function" },
];

const STATUS_WORDS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

function without(filters: Filters, ...keys: string[]): Filters {
  const out = { ...filters };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Left panel of the review view: the range, which map (2D or 3D) and how much detail, risk and its reasons, changed
 * symbols and files, crossings and notes. Clicking an item selects it: the map focuses the node that shows it.
 */
export function ReviewPanel({ data, filters, onFiltersChange, route, onRouteChange }: FilterPanelProps) {
  const { selectNode, state } = useStore();
  const review = data?.review ?? null;
  const [range, setRange] = useState(filters.range ?? "");
  useEffect(() => setRange(filters.range ?? ""), [filters.range]);
  const map = filters.map === "3d" ? "3d" : "2d";
  const mode = filters.mode === "rings" ? "rings" : "map";
  const level = route?.level ?? "files";
  const far = getBool(filters, FAR_KEY, false);
  const sel = state.route.sel;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const r = range.trim();
    onFiltersChange(r ? { ...without(filters, "pr"), range: r } : without(filters, "pr", "range"));
  };
  const pick = (id: string) => selectNode(id);
  const item = (id: string, children: ReactNode, title?: string) => (
    <button
      type="button"
      className={`rv-item${sel === id ? " is-current" : ""}`}
      aria-current={sel === id ? "true" : undefined}
      title={title ?? id}
      onClick={() => pick(id)}
    >
      {children}
    </button>
  );
  const unplaced = new Set(review?.layer.unplaced ?? []);

  return (
    <div className="filter-panel rv-panel">
      <form className="filter-group" aria-label="Range" onSubmit={apply}>
        <h3>Range</h3>
        <label className="rv-range">
          <span className="muted">Base...head (git refs)</span>
          <input
            type="text"
            value={range}
            placeholder="main...HEAD"
            spellCheck={false}
            aria-label="Range to review"
            onChange={(e) => setRange(e.target.value)}
          />
        </label>
        <button type="submit" className="btn">
          Review
        </button>
        {filters.pr && !filters.range && <p className="muted">Pull request #{filters.pr}</p>}
      </form>

      <section className="filter-group" aria-label="Show">
        <h3>Show</h3>
        <div className="segmented" role="radiogroup" aria-label="Show">
          {MODES.map((m) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              title={m.hint}
              className="segment"
              onClick={() =>
                onFiltersChange(m.id === "map" ? without(filters, "mode") : { ...filters, mode: m.id })
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

      {mode === "map" && (
        <section className="filter-group" aria-label="Map">
          <h3>Map</h3>
          <div className="segmented" role="radiogroup" aria-label="Map">
            {MAPS.map((m) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={map === m.id}
                title={m.hint}
                className="segment"
                onClick={() =>
                  onFiltersChange(m.id === "2d" ? without(filters, "map") : { ...filters, map: m.id })
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          {map === "2d" ? (
            <div className="segmented rv-levels" role="radiogroup" aria-label="Detail level">
              {LEVELS.map((l) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={level === l.id}
                  title={l.hint}
                  className="segment"
                  onClick={() => onRouteChange?.({ level: l.id })}
                >
                  {l.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">One building per file: lines run from file to file.</p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={far}
              onChange={(e) => onFiltersChange(setBool(filters, FAR_KEY, e.target.checked, false))}
            />
            <span className="check-text">
              <span className="check-label">Tint callers at hop 2 and 3</span>
            </span>
          </label>
        </section>
      )}

      {review && (
        <>
          <section className="filter-group" aria-label="Risk">
            <h3>Risk</h3>
            <p className={`rv-risk rv-risk-${review.risk.level}`}>
              <strong>{RISK_WORDS[review.risk.level]}</strong> <span>{review.risk.score}/100</span>
            </p>
            {review.risk.reasons.length > 0 ? (
              <ul className="rv-reasons">
                {review.risk.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No risk rule fired.</p>
            )}
            <p className="muted rv-counts">
              {review.files.length} {review.files.length === 1 ? "file" : "files"} · {review.changes.length}{" "}
              {review.changes.length === 1 ? "symbol change" : "symbol changes"}
              {review.callersByHop.map((h) => ` · hop ${h.hop}: ${h.count}`).join("")}
            </p>
          </section>

          <section className="filter-group" aria-label="Changed symbols">
            <h3>
              Changed symbols <span className="count">{review.changes.length}</span>
            </h3>
            <ul className="rv-list">
              {review.changes.map((c) => (
                <li key={c.id}>
                  {item(
                    c.id,
                    <>
                      <span className={`rv-dot rv-mark-${markKindOf(c)}`} />
                      <span className="rv-item-name">{c.name}</span>
                      <span className="rv-item-meta">
                        {CHANGE_WORDS[c.kind].label.toLowerCase()}
                        {c.signatureChanged ? ", signature" : ""}
                        {c.callers > 0 ? `, ${c.callers} direct` : ""}
                        {unplaced.has(c.id) ? ", not on the map" : ""}
                      </span>
                    </>,
                  )}
                </li>
              ))}
            </ul>
            {unplaced.size > 0 && (
              <p className="muted">
                {unplaced.size} {unplaced.size === 1 ? "change is" : "changes are"} not on this map (removed
                with its file, or filtered out): listed only.
              </p>
            )}
          </section>

          <section className="filter-group" aria-label="Changed files">
            <h3>
              Changed files <span className="count">{review.files.length}</span>
            </h3>
            <ul className="rv-list">
              {review.files.map((f) => (
                <li key={f.path}>
                  {item(
                    `file:${f.path}`,
                    <>
                      <span className="rv-item-name rv-path">{f.path}</span>
                      <span className="rv-item-meta">
                        {STATUS_WORDS[f.status] ?? f.status}
                        {f.changes > 0 ? `, ${f.changes} ${f.changes === 1 ? "symbol" : "symbols"}` : ""}
                      </span>
                    </>,
                    f.path,
                  )}
                </li>
              ))}
            </ul>
          </section>

          {review.crossings.length > 0 && (
            <section className="filter-group" aria-label="Crossings">
              <h3>
                Crossings <span className="count">{review.crossings.length}</span>
              </h3>
              <ul className="rv-list">
                {review.crossings.map((x) => (
                  <li key={`${x.from}\0${x.to}\0${x.kind}`}>
                    {item(
                      x.to,
                      <>
                        <span className="rv-item-name">
                          {shortName(x.to)} → {shortName(x.from)}
                        </span>
                        <span className="rv-item-meta">{CROSSING_WORDS[x.kind] ?? x.kind}</span>
                      </>,
                      `${x.to} uses ${x.from}`,
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {review.notes.length > 0 && (
            <section className="filter-group" aria-label="Notes">
              <h3>Notes</h3>
              <ul className="rv-notes">
                {review.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="muted rv-meta">
            {review.base}...{review.head} · merge base <code>{review.mergeBase.slice(0, 7)}</code>
          </p>
        </>
      )}
    </div>
  );
}

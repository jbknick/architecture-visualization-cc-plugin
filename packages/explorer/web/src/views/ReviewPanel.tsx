import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { Filters } from "../api.ts";
import type { FilterPanelProps } from "../slots.ts";
import { useStore } from "../store.tsx";
import { CHANGE_WORDS, CROSSING_WORDS, RISK_WORDS, shortName } from "./reviewModel.ts";

const MODES = [
  { id: "rings", label: "Rings", hint: "Changed code in the centre, callers on rings by hop" },
  {
    id: "overlay",
    label: "Map overlay",
    hint: "The project map with changed and affected files highlighted",
  },
] as const;

const STATUS_WORDS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

function without(filters: Filters, ...keys: string[]): Filters {
  const out = { ...filters };
  for (const k of keys) delete out[k];
  return out;
}

/** Left panel of the review view: the range, the mode, risk and its reasons, files, changes, crossings and notes. */
export function ReviewPanel({ data, filters, onFiltersChange }: FilterPanelProps) {
  const { selectNode, state } = useStore();
  const review = data?.review ?? null;
  const [range, setRange] = useState(filters.range ?? "");
  useEffect(() => setRange(filters.range ?? ""), [filters.range]);
  const mode = filters.mode === "overlay" ? "overlay" : "rings";
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
                onFiltersChange(m.id === "rings" ? without(filters, "mode") : { ...filters, mode: m.id })
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

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
                      <span className={`rv-dot rv-change-${c.kind}${c.signatureChanged ? " rv-sig" : ""}`} />
                      <span className="rv-item-name">{c.name}</span>
                      <span className="rv-item-meta">
                        {CHANGE_WORDS[c.kind].label.toLowerCase()}
                        {c.signatureChanged ? ", signature" : ""}
                        {c.callers > 0 ? `, ${c.callers} direct` : ""}
                      </span>
                    </>,
                  )}
                </li>
              ))}
            </ul>
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

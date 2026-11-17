import { useEffect, useMemo, useState } from "react";
import { api, type FocusChoice } from "../api.ts";
import { useStore } from "../store.tsx";

/** Choices listed per group before "and n more". */
export const CHOICES_PER_GROUP = 200;

const TEXT: Record<string, { title: string; body: string; search: string }> = {
  "feature-path": {
    title: "Pick a page or an endpoint",
    body: "This view follows one feature from the page through its client code and endpoints to the services and tables.",
    search: "Filter pages and endpoints",
  },
  "table-usage": {
    title: "Pick a table",
    body: "This view shows the code that writes and reads one table, then their callers up to the endpoints and pages.",
    search: "Filter tables",
  },
};

/**
 * Shown by the feature path and table usage views (#48) until a focus is chosen: the server answers the view without
 * a focus with its `choices`, listed here by group with a filter box.
 */
export function FlowFocusPrompt({ viewId, notice }: { viewId: string; notice?: string }) {
  const { navigate, state } = useStore();
  const [choices, setChoices] = useState<FocusChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const scenario = state.route.filters.scenario;
  useEffect(() => {
    const ctl = new AbortController();
    api.view(viewId, scenario ? { filters: { scenario } } : {}, ctl.signal).then(
      (d) => setChoices(d.choices ?? []),
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => ctl.abort();
  }, [viewId, scenario]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<string, FocusChoice[]>();
    for (const c of choices ?? []) {
      if (needle && !c.label.toLowerCase().includes(needle) && !c.id.toLowerCase().includes(needle)) continue;
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    return [...out];
  }, [choices, q]);
  const text = TEXT[viewId] ?? { title: "Pick a starting point", body: "", search: "Filter" };
  return (
    <div className="empty-state flow-prompt" data-testid="flow-focus-prompt">
      <h2>{text.title}</h2>
      <p>{text.body}</p>
      {notice && (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {choices === null && !error && <p className="muted">Loading…</p>}
      {choices && (
        <>
          <input
            type="search"
            className="text-input"
            aria-label={text.search}
            placeholder={text.search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flow-choices">
            {groups.map(([group, list]) => (
              <section key={group} aria-label={group}>
                <h3>{group}</h3>
                <ul>
                  {list.slice(0, CHOICES_PER_GROUP).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="link-btn"
                        title={c.id}
                        onClick={() => navigate({ focus: c.id, sel: c.id })}
                      >
                        {c.label}
                      </button>
                      {c.note && <span className="muted"> {c.note}</span>}
                    </li>
                  ))}
                  {list.length > CHOICES_PER_GROUP && (
                    <li className="muted">
                      and {list.length - CHOICES_PER_GROUP} more: type to narrow the list
                    </li>
                  )}
                </ul>
              </section>
            ))}
            {groups.length === 0 && <p className="muted">Nothing matches.</p>}
          </div>
        </>
      )}
    </div>
  );
}

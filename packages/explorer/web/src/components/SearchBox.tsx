import { useEffect, useId, useRef, useState } from "react";
import { useSearchHits } from "../hooks.ts";
import { useStore } from "../store.tsx";
import { KindBadge } from "./KindBadge.tsx";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function SearchBox() {
  const { selectNode, focusOn, view } = useStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { data: hits, loading, error } = useSearchHits(query);
  const results = hits ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight whenever new hits arrive
  useEffect(() => setActive(0), [hits]);

  const choose = (index: number) => {
    const hit = results[index];
    if (!hit) return;
    // In the ego view a search result becomes the centre of the graph; elsewhere it opens in the inspector.
    if (view === "ego") focusOn(hit.id, hit);
    else selectNode(hit.id, hit);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search symbols"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search functions, files, routes"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(active);
          } else if (e.key === "Escape") {
            if (showList) setOpen(false);
            else inputRef.current?.blur();
          }
        }}
      />
      <span className="search-hint" aria-hidden="true">
        {isMac ? "⌘K" : "Ctrl K"}
      </span>
      {showList && (
        <div className="search-results" id={listId} role="listbox" aria-label="Search results" tabIndex={-1}>
          {results.map((hit, i) => (
            <div
              key={hit.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? "is-active" : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="hit-main">
                <span className="hit-name">{hit.name}</span>
                <KindBadge kind={hit.kind} />
                {!hit.exported && <span className="hit-tag">internal</span>}
              </span>
              <span className="hit-path">
                {hit.path}:{hit.line}
              </span>
            </div>
          ))}
          {results.length === 0 && (
            <div className="search-status" role="presentation">
              {error ? "Search failed. Is the server running?" : loading ? "Searching…" : "No matches"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

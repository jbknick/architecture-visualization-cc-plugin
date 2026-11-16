import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewInfo } from "../api.ts";
import { debugEnabled } from "../debug.ts";
import { refreshStore, useRefresh } from "../refresh.ts";
import { useStore } from "../store.tsx";
import { SearchBox } from "./SearchBox.tsx";

/**
 * The Refresh button (spec section 11 (c)): the explorer refreshes on request only. It turns primary while files are
 * out of date; the "Out of date (n files)" marker itself sits in the status bar, where there is room for it.
 */
export function RefreshButton() {
  const { stale, running, error, last } = useRefresh();
  const title = running
    ? "Re-indexing the changed files…"
    : stale > 0
      ? `${stale} ${stale === 1 ? "file has" : "files have"} changed since the map was last refreshed. Refresh re-indexes them and keeps the layout.`
      : last
        ? `Up to date. Last refresh: ${last.changed.files} files, ${last.changed.functions} functions, ${last.ms} ms.`
        : "Re-index files changed since the map was built";
  return (
    <button
      type="button"
      className={`btn refresh-btn${stale > 0 ? " primary" : ""}`}
      onClick={() => void refreshStore.run()}
      disabled={running}
      aria-busy={running}
      title={error ? `${title} Last error: ${error}` : title}
    >
      {running ? "Refreshing…" : "Refresh"}
    </button>
  );
}

/** "Out of date (n files)" while files changed since the last refresh, or why the last refresh failed. */
export function StaleMarker() {
  const { stale, running, error } = useRefresh();
  if (running) return null;
  if (error)
    return (
      <span className="refresh-error" role="alert">
        Refresh failed: {error}
      </span>
    );
  if (stale <= 0) return null;
  return (
    <span className="stale-marker" role="status" data-testid="stale-marker">
      Out of date ({stale} {stale === 1 ? "file" : "files"})
    </span>
  );
}

/** From this many view tabs on, the brand may shrink so the bar fits (see styles.css). */
const MANY_TABS = 7;

/**
 * The view tabs. With a dozen views (#48) they do not all fit next to the brand and the search box: the strip scrolls
 * sideways, a "‹" / "›" button shows on each side that has hidden tabs (overlay scrollbars on macOS show nothing),
 * and the open view's tab is scrolled into sight whenever the view changes, a deep link included.
 */
function TabStrip({
  tabs,
  view,
  onPick,
}: {
  tabs: ViewInfo[];
  view: string | null;
  onPick: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  /** Set once the user scrolls the strip themselves; a resize then leaves their scroll alone until the view changes. */
  const userScrolled = useRef(false);
  const update = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
  }, []);
  /** Scrolls the open view's tab fully into sight (clear of the scroll buttons laid over the ends). */
  const showActive = useCallback(() => {
    const el = navRef.current;
    const active = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !active) return;
    // Screen rectangles: the strip is the offset parent, so offsetLeft would not be relative to the scroll.
    const box = el.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    if (r.left < box.left) el.scrollLeft -= box.left - r.left + 36;
    else if (r.right > box.right) el.scrollLeft += r.right - box.right + 36;
  }, []);
  // The strip's width settles after the first paint (the brand and the search box share the bar): keep the open tab
  // in sight on every resize too.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!userScrolled.current) showActive();
            update();
          });
    ro?.observe(el);
    const tabsEl = el.firstElementChild;
    if (tabsEl) ro?.observe(tabsEl);
    const onWheel = () => {
      userScrolled.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [update, showActive]);
  const count = tabs.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tabs arrive (meta) or the view changes
  useEffect(() => {
    userScrolled.current = false;
    showActive();
    update();
  }, [view, count, update, showActive]);
  const scrollBy = (dir: 1 | -1) => {
    const el = navRef.current;
    userScrolled.current = true;
    if (el) el.scrollLeft += dir * Math.max(120, el.clientWidth * 0.7);
  };
  return (
    <div className="tab-strip">
      {edges.left && (
        <button
          type="button"
          className="tab-scroll left"
          aria-label="Show earlier views"
          onClick={() => scrollBy(-1)}
        >
          ‹
        </button>
      )}
      <nav aria-label="Views" ref={navRef}>
        <div className="tabs" role="tablist">
          {tabs.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={v.id === view}
              aria-disabled={!v.enabled}
              title={v.enabled ? undefined : (v.reason ?? `${v.title} is not available yet`)}
              onClick={() => v.enabled && onPick(v.id)}
            >
              {v.title}
            </button>
          ))}
        </div>
      </nav>
      {edges.right && (
        <button
          type="button"
          className="tab-scroll right"
          aria-label="Show more views"
          onClick={() => scrollBy(1)}
        >
          ›
        </button>
      )}
    </div>
  );
}

export function TopBar() {
  const { state, view, setView } = useStore();
  const { meta } = state;
  // The "Debug: workspaces" view is a developer aid: its tab shows only with ?debug=1 (or while it is the open view).
  const tabs = (meta?.views ?? []).filter((v) => v.id !== "debug" || v.id === view || debugEnabled());
  return (
    <header className={`topbar${tabs.length >= MANY_TABS ? " many-tabs" : ""}`}>
      <div className="topbar-id">
        <span className="brand">Claude Code Architecture Visualisation Plugin</span>
        {meta && (
          <span className="repo" title={meta.headSha ? `${meta.repo} at ${meta.headSha}` : meta.repo}>
            <span className="repo-name">{meta.repo}</span>
            {meta.headSha && <code className="sha">{meta.headSha.slice(0, 7)}</code>}
          </span>
        )}
      </div>
      <TabStrip tabs={tabs} view={view} onPick={setView} />
      <RefreshButton />
      <SearchBox />
    </header>
  );
}

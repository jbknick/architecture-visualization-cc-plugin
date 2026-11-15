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
      <nav aria-label="Views">
        <div className="tabs" role="tablist">
          {tabs.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={v.id === view}
              aria-disabled={!v.enabled}
              title={v.enabled ? undefined : `${v.title} is not available yet`}
              onClick={() => v.enabled && setView(v.id)}
            >
              {v.title}
            </button>
          ))}
        </div>
      </nav>
      <RefreshButton />
      <SearchBox />
    </header>
  );
}

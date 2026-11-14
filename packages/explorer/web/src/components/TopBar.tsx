import { debugEnabled } from "../debug.ts";
import { useStore } from "../store.tsx";
import { SearchBox } from "./SearchBox.tsx";

export function TopBar() {
  const { state, view, setView } = useStore();
  const { meta } = state;
  // The "Debug: workspaces" view is a developer aid: its tab shows only with ?debug=1 (or while it is the open view).
  const tabs = (meta?.views ?? []).filter((v) => v.id !== "debug" || v.id === view || debugEnabled());
  return (
    <header className="topbar">
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
      <SearchBox />
    </header>
  );
}

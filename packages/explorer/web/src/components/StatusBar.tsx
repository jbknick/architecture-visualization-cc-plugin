import type { Meta } from "../api.ts";

interface Props {
  meta: Meta | null;
  shownNodes: number;
  shownEdges: number;
  loading: boolean;
  error: string | null;
}

export function StatusBar({ meta, shownNodes, shownEdges, loading, error }: Props) {
  const c = meta?.counts ?? {};
  return (
    <footer className="statusbar">
      <span>
        {shownNodes} nodes, {shownEdges} edges shown
      </span>
      {c.files !== undefined && <span>{c.files} files</span>}
      {c.symbols !== undefined && <span>{c.symbols} symbols</span>}
      {c.edges !== undefined && <span>{c.edges} edges indexed</span>}
      <span className="spacer" />
      {error && <span className="status-error">View failed: {error}</span>}
      {loading && <span>Loading…</span>}
      {c.backlog !== undefined && <span>Backlog: {c.backlog}</span>}
      <span>Working changes: {c.workingFiles ?? 0} files</span>
    </footer>
  );
}

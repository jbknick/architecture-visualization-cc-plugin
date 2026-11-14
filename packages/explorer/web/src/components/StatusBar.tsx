import type { Meta } from "../api.ts";

interface Props {
  meta: Meta | null;
  shownNodes: number;
  shownEdges: number;
  loading: boolean;
  error: string | null;
}

export function StatusBar({ meta, shownNodes, shownEdges, loading, error }: Props) {
  const c: Partial<Meta["counts"]> = meta?.counts ?? {};
  return (
    <footer className="statusbar">
      <span>
        {shownNodes} nodes, {shownEdges} edges shown
      </span>
      {c.workspaces !== undefined && <span>{c.workspaces} workspaces</span>}
      {c.files !== undefined && <span>{c.files} files</span>}
      {c.symbols !== undefined && <span>{c.symbols} symbols</span>}
      {c.edges !== undefined && <span>{c.edges} edges indexed</span>}
      <span className="spacer" />
      {error && <span className="status-error">View failed: {error}</span>}
      {loading && <span>Loading…</span>}
      {/* The server only reports these once descriptions and working-tree overlays exist (M2, M4). */}
      {c.backlog !== undefined && <span>Backlog: {c.backlog}</span>}
      {c.workingFiles !== undefined && <span>Working changes: {c.workingFiles} files</span>}
    </footer>
  );
}

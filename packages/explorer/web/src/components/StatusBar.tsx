import { Alert02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Meta } from "../api.ts";
import { StaleMarker } from "./TopBar.tsx";

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
      {error && (
        <span className="status-error">
          <HugeiconsIcon icon={Alert02Icon} size={14} aria-hidden="true" />
          View failed: {error}
        </span>
      )}
      {loading && (
        <span className="status-loading">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={14}
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
          />
          Loading…
        </span>
      )}
      <StaleMarker />
      {/* The server only reports these once descriptions and working-tree overlays exist (M2, M4). */}
      {c.backlog !== undefined && <span>Backlog: {c.backlog}</span>}
      {c.workingFiles !== undefined && <span>Working changes: {c.workingFiles} files</span>}
    </footer>
  );
}

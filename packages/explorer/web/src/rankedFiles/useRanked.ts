import { useMemo } from "react";
import type { GraphNode } from "../api.ts";
import { RANK_COUNT, type RankedFile, rankFiles, workspacesWithFiles } from "./rank.ts";
import { useRankView } from "./store.ts";

export interface Ranked {
  files: RankedFile[];
  /** Workspaces to choose from in "Top files in". */
  scopes: { id: string; label: string }[];
  /** The workspace the ranking is restricted to (null: all). A workspace that is not shown any more counts as all. */
  scope: string | null;
  hoverFile: string | null;
}

/** The ranking for the current nodes, the hide-tests filter and the "Top files in" menu: the list and the canvas both use it. */
export function useRanked(nodes: readonly GraphNode[], hideTests: boolean, enabled = true): Ranked {
  const { scope: wanted, hoverFile } = useRankView();
  const ranked = useMemo(() => {
    if (!enabled) return { files: [] as RankedFile[], scopes: [], scope: null as string | null };
    const scopes = workspacesWithFiles(nodes);
    const scope = wanted && scopes.some((s) => s.id === wanted) ? wanted : null;
    return { files: rankFiles(nodes, { hideTests, workspace: scope, limit: RANK_COUNT }), scopes, scope };
  }, [nodes, hideTests, wanted, enabled]);
  return { ...ranked, hoverFile: enabled ? hoverFile : null };
}

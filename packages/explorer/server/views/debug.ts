import type { GraphEdge, GraphNode, ViewModule } from "../types.js";

/** Workspaces and their depends_on edges. Exists to exercise the API before real views land. */
export const debugView: ViewModule = {
  id: "debug",
  title: "Debug: workspaces",
  enabled: true,
  build({ store }) {
    const fileCounts = new Map<string, number>();
    for (const f of store.effectiveFiles()) {
      if (f.workspaceId) fileCounts.set(f.workspaceId, (fileCounts.get(f.workspaceId) ?? 0) + 1);
    }
    const nodes: GraphNode[] = store.listWorkspaces().map((w) => ({
      id: w.id,
      kind: "workspace",
      label: w.name,
      size: fileCounts.get(w.id) ?? 0,
      badges: [w.kind, ...w.frameworks],
    }));
    const known = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = store
      .effectiveEdges({ kind: ["depends_on"] })
      .filter((e) => known.has(e.src) && known.has(e.dst))
      .map((e) => ({
        id: `${e.src}|${e.kind}|${e.dst}`,
        src: e.src,
        dst: e.dst,
        kind: e.kind,
        weight: e.count,
        confidence: e.confidence,
      }));
    return { nodes, edges, layoutHint: "force" };
  },
};

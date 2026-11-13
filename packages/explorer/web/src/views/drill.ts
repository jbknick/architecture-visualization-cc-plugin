import type { GraphNode } from "../api.ts";
import type { Route } from "../route.ts";

/** Project-map nodes the server can use as `focus`. Symbols and `ext:` nodes are not hierarchy parents. */
const PROJECT_MAP_DRILLABLE = new Set(["workspace", "dir", "file"]);

/** True for ids that `/api/node` knows. Directories, `ext:*` and `more:*` nodes exist only in view responses. */
export const isServerNode = (id: string): boolean => /^(sym|file|ws):/.test(id);

export const isSymbolId = (id: string): boolean => id.startsWith("sym:");

/**
 * What a double-click ("go into this node") does in a view, as a route patch.
 * `null` means "nothing to go into": the caller just selects the node.
 */
export function drillPatch(view: string, node: GraphNode): Partial<Route> | null {
  if (view === "project-map" && PROJECT_MAP_DRILLABLE.has(node.kind)) {
    return { focus: node.id, level: null, sel: node.id };
  }
  if (view === "ego" && (isSymbolId(node.id) || node.id.startsWith("file:"))) {
    return { focus: node.id, sel: node.id };
  }
  return null;
}

/** Colours for workspace dots in the filter panel; stable per workspace id. */
const WORKSPACE_COLORS = [
  "#2f6fdb",
  "#c2570c",
  "#1f7a3d",
  "#b43fd0",
  "#a8261f",
  "#0d8f7a",
  "#7a5c1e",
  "#4f46c8",
];

export function workspaceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WORKSPACE_COLORS[h % WORKSPACE_COLORS.length] as string;
}

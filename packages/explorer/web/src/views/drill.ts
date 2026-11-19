import type { GraphNode } from "../api.ts";
import { isFileId, isSymId } from "../ids.ts";
import type { Route } from "../route.ts";

/** Project-map nodes the server can use as `focus`. Symbols and `ext:` nodes are not hierarchy parents. */
const PROJECT_MAP_DRILLABLE = new Set(["workspace", "dir", "file"]);

/** True for ids that `/api/node` knows. Directories, `ext:*` and `more:*` nodes exist only in view responses. */
export const isServerNode = (id: string): boolean => /^(sym|file|ws|route|ep|table|mw|mwref|call):/.test(id);

export const isSymbolId = isSymId;

/**
 * What a double-click ("go into this node") does in a view, as a route patch.
 * `null` means "nothing to go into": the caller just selects the node.
 */
export function drillPatch(view: string, node: GraphNode): Partial<Route> | null {
  if (view === "project-map" && PROJECT_MAP_DRILLABLE.has(node.kind)) {
    return { focus: node.id, level: null, sel: node.id };
  }
  if (view === "ego" && (isSymbolId(node.id) || isFileId(node.id))) {
    return { focus: node.id, sel: node.id };
  }
  // Cross-stack views (#48): a double-click on a route or endpoint follows its whole feature path, on a table its usage.
  if (
    view === "endpoints" ||
    view === "page-api" ||
    view === "api-tables" ||
    view === "feature-path" ||
    view === "table-usage"
  ) {
    if (node.kind === "route" || node.kind === "endpoint")
      return { view: "feature-path", focus: node.id, sel: node.id, filters: {}, level: null, hops: null };
    if (node.kind === "table")
      return { view: "table-usage", focus: node.id, sel: node.id, filters: {}, level: null, hops: null };
  }
  return null;
}

export { workspaceColor } from "../workspacePalette.ts";

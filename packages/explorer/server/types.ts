import type { GantryConfig, GantryPaths, Store } from "@gantry/core";

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  parent?: string;
  size: number;
  color?: string;
  badges?: string[];
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  confidence: "high" | "low";
}

export type LayoutHint = "force" | "force-3d" | "layered" | "tree" | "grid";

export interface ViewResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHint: LayoutHint;
}

export interface ViewParams {
  focus?: string;
  depth?: number;
  /** Drill level for views that have one (`level` query param); the view validates it. */
  level?: string;
  /** The comma-separated `filters` query value, split. */
  filters: string[];
}

export interface ApiContext {
  store: Store;
  paths: GantryPaths;
  config: GantryConfig;
}

/** Views register as `{ id, title, build(ctx, params) }`; later issues add one file each. */
export interface ViewModule {
  id: string;
  title: string;
  enabled: boolean;
  build(ctx: ApiContext, params: ViewParams): ViewResult;
}

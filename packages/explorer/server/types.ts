import type { GantryConfig, GantryPaths, Store } from "@gantry/core";

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  /** Workspace nodes only: `label` without the npm scope shared by most workspaces (see views/labels.ts). */
  shortLabel?: string;
  parent?: string;
  size: number;
  color?: string;
  badges?: string[];
  /** Repo-relative path of the file (or directory) the node stands for. */
  path?: string;
  /** Counts under this node; which keys are set depends on the node kind. */
  stats?: NodeStats;
  /** Ego view only: caller side ("in"), callee side ("out") or the focus itself. */
  side?: "in" | "out" | "focus";
  /** Ego view only: distance from the focus in hops. */
  hop?: number;
  /** Ego view only: id of the workspace the function or file belongs to (absent outside every workspace). */
  workspace?: string;
  /** Ego view group nodes (`kind: "group"`): the members, so a client can list them without another request. */
  members?: GroupMember[];
  /** Ego view group nodes: true when the group is expanded; its members follow as separate nodes. */
  expanded?: boolean;
  /** Ego view: id of the (expanded) group a node was listed under. */
  group?: string;
  x?: number;
  y?: number;
}

export interface NodeStats {
  files?: number;
  functions?: number;
  loc?: number;
  /** Ego group nodes: how many functions (or files) the group stands for. */
  members?: number;
}

export interface GroupMember {
  id: string;
  label: string;
  path?: string;
  line?: number;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  confidence: "high" | "low";
  /** Project map: number of call/render/hook edges between the same two nodes. */
  uses?: number;
}

/** The canvas layouts defined by issue #36. */
export type LayoutHint =
  | "nested-elk"
  | "elk-layered"
  | "radial"
  | "force"
  | "tree-lr"
  | "columns"
  | "clusters"
  | "bowtie"
  | "force-3d";

export type ViewLevel = "workspaces" | "dirs" | "files" | "symbols";

export interface ViewResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHint: LayoutHint;
}

export interface ViewParams {
  focus?: string;
  depth?: number;
  /** Project map: how deep the hierarchy goes. */
  level?: ViewLevel;
  /** The comma-separated `filters` query value, split. */
  filters: string[];
  /**
   * Parsed view options: the `filters` value (JSON object, or comma-separated `key=value`; list values
   * separated by `|`) layered over any other plain query parameters. Absent in older callers.
   */
  options?: Record<string, unknown>;
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

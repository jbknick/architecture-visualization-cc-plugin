import type { Embedder, GantryConfig, GantryPaths, Group, SavedView, Store } from "@gantry/core";

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  /** Overlay: the label before a person's label replaced it (spec section 11, "Overlay at view time"). */
  labelOriginal?: string;
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
  /** Review view, rings mode: how a changed symbol changed (added, modified, removed, moved, renamed). */
  change?: string;
  /** Review view, rings mode: the changed symbol's signature differs between the two sides. */
  signatureChanged?: boolean;
  /** Review view, rings mode: a hub node (`kind: "hub"`) stands for this many consumers. */
  count?: number;
  /**
   * Cross-stack views (#48): the column or swimlane the node is drawn in (0 = leftmost). The `columns` and
   * `tree-lr` layouts place nodes by it; `elk-layered` keeps it as an ELK partition.
   */
  lane?: number;
  /** Cross-stack views: order inside the lane (smaller first; ties by id). */
  rank?: number;
  /** Endpoints view of a store with several repos: the repo the node's id names (absent with one repo). */
  repo?: string;
  /** Endpoints view: the group the node is laid out in (`rpc`, `http`, `server fn`), stacked top to bottom. */
  band?: string;
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
  /** Table usage: a read or write written in a query file (a `query` rule), the repo-relative path of that file. */
  textFile?: string;
  /** Project map: number of call/render/hook edges between the same two nodes. */
  uses?: number;
  /** Imports edges: imported names summed over the underlying file edges. Present only when it differs from `weight`. */
  bindings?: number;
  /** Slices view: true when the edge crosses a slice boundary. */
  cross?: boolean;
  /** Project map of a store with several repos: true when the two ends are in different repos. */
  crossRepo?: boolean;
  /** Cross-stack views (#48): how many places the aggregated edge stands for (page -> API: the requesting code). */
  via?: number;
  /** Cross-stack views: up to 6 of those places, by label. */
  viaSample?: string[];
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
  | "force-3d"
  /** The review view (#167): the project map, 2D or 3D, with the review layer on it. */
  | "review";

export type ViewLevel = "repos" | "workspaces" | "dirs" | "files" | "symbols";

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
  /** The embedding model if it is already cached (never downloads); used by `/api/search`. Absent: keywords only. */
  getEmbedder?: () => Promise<Embedder | undefined>;
}

/** Views register as `{ id, title, build(ctx, params) }`; later issues add one file each. */
export interface ViewModule {
  id: string;
  title: string;
  /**
   * A function when it depends on the index (#48: the cross-stack views need adapter nodes). `/api/meta` reports the
   * value, and a disabled view answers 404.
   */
  enabled: boolean | ((ctx: ApiContext) => boolean);
  /** Why the view is disabled, shown as the tab's tooltip (`/api/meta` `views[].reason`). */
  disabledReason?: string;
  /** May return a promise (the review view reads git). */
  build(ctx: ApiContext, params: ViewParams): ViewResult | Promise<ViewResult>;
}

/** One open change set of the Team layer (`GET /api/team/layer`, spec section 11). Owner and title come from outside the machine: text only. */
export interface TeamChangeSet {
  id: string;
  source: "pr" | "branch";
  state: "proposed" | "in_progress" | "in_review" | "merged";
  /** A GitHub login. */
  owner: string;
  title?: string;
  pr?: number;
  /** The changed symbol and file ids, at most 200, sorted. */
  nodes: string[];
  /** The blast radius, at most 500 entries, lowest hop first. */
  radius: { id: string; hop: number; tier: "direct" | "potential" | "reachable"; via_hub: boolean }[];
  /** Counts before the caps. */
  nodes_total: number;
  radius_total: number;
  /** The workspace id of each changed node the local index knows, deduplicated, so the map can mark areas. */
  map_nodes: string[];
  /**
   * Which changed nodes each directly affected (hop 1) entry uses, by the local graph: `id` is the radius entry and
   * `changed` the ids of `nodes` that the entry (or its file) has an edge to. An entry with no such edge in the local
   * index is left out, so the map draws no arrow for it. Sorted by `id`; `changed` is sorted.
   */
  direct_uses: { id: string; changed: string[] }[];
}

/** `GET /api/team/layer`: the open change sets in the local team cache. Nothing here comes from a request to a team server. */
export interface TeamLayerResponse {
  available: boolean;
  /** Seconds since the last pull, or null with no cache. */
  age_s: number | null;
  change_sets: TeamChangeSet[];
  /** The owners, sorted and unique. */
  people: string[];
}

/** `GET /api/team/views`: the team's saved views and groups merged with the local ones (spec section 11). Names are text from teammates. */
export interface TeamViewsResponse {
  /** False when there is no team cache for this repo. */
  available: boolean;
  /** Seconds since the last pull, or null with no cache. */
  age_s: number | null;
  /** Team views first, then local ones; a local view with a team view's id is marked `shadowed`. */
  views: (SavedView & { origin: "team" | "local"; shadowed?: true; published?: true; own?: true })[];
  groups: (Group & { origin: "team" | "local"; shadowed?: true; published?: true; own?: true })[];
  /** The id of the team's default view, or null when there is none (or no cache). */
  default_view: string | null;
  /** The saved view this person last picked for this repo (kept in a file in the data directory), or null. */
  last_view: string | null;
}

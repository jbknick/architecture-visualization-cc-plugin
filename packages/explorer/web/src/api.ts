// The only place that talks to the explorer server (issues #33, #37). If the server contract moves, change it here.
// Shapes mirror packages/explorer/server/{types,api}.ts.

export interface NodeStats {
  files?: number;
  functions?: number;
  loc?: number;
  /** Ego group nodes: how many functions (or files) the group stands for. */
  members?: number;
}

/** One member of an ego group node. */
export interface GroupMember {
  id: string;
  label: string;
  path?: string;
  line?: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  /** The label before a person-set label replaced it. */
  labelOriginal?: string;
  /** Workspace nodes only: `label` without the npm scope shared by most workspaces. */
  shortLabel?: string;
  parent?: string;
  size: number;
  color?: string;
  badges?: string[];
  /** Repo-relative path of the file or directory the node stands for. */
  path?: string;
  /** Counts under this node; which keys are set depends on the node kind. */
  stats?: NodeStats;
  /** Ego view only: caller side ("in"), callee side ("out") or the focus itself. */
  side?: "in" | "out" | "focus";
  /** Ego view only: distance from the focus in hops. */
  hop?: number;
  /** Ego view: id of the workspace the function or file belongs to. */
  workspace?: string;
  /** Ego group nodes (`kind: "group"`): what is inside. */
  members?: GroupMember[];
  /** Ego group nodes: true when expanded; the members then follow as separate nodes. */
  expanded?: boolean;
  /** Ego view: id of the expanded group a node is listed under. Review rings: the node's file path. */
  group?: string;
  /** Review view, rings mode: how a changed symbol changed. */
  change?: ChangeKind;
  /** Review view, rings mode: the changed symbol's signature differs between the two sides. */
  signatureChanged?: boolean;
  /** Review view, rings mode: a hub node (`kind: "hub"`) stands for this many consumers. */
  count?: number;
  /** Cross-stack views (#48): the column or swimlane (0 = leftmost). */
  lane?: number;
  /** Cross-stack views: order inside the lane. */
  rank?: number;
  /** Endpoints view: the group (`rpc`, `http`, `server fn`) the node is stacked in. */
  band?: string;
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
  /** Project map: number of call/render/hook edges between the same two nodes. */
  uses?: number;
  /** Imports edges: imported names summed over the underlying file edges. Present only when it differs from `weight`. */
  bindings?: number;
  /** Slices view: true when the edge crosses a slice boundary. */
  cross?: boolean;
  /** Project map of a store with several repos: true when the two ends are in different repos. */
  crossRepo?: boolean;
  /** Cross-stack views: how many places the aggregated edge stands for (page -> API: the requesting code). */
  via?: number;
  /** Cross-stack views: some of those places, by name. */
  viaSample?: string[];
}

export interface ViewInfo {
  id: string;
  title: string;
  enabled: boolean;
  /** Why a view is disabled (#48: the cross-stack views need adapter nodes). */
  reason?: string;
}

/** Cross-stack views (#48): a column or swimlane title. */
export interface LaneInfo {
  lane: number;
  label: string;
}

/** Cross-stack views: a workspace with how many routes or endpoints it has. */
export interface WsCount {
  id: string;
  name: string;
  shortLabel: string;
  count: number;
}

/** Feature path and table usage: what can be picked as the focus. */
export interface FocusChoice {
  id: string;
  label: string;
  kind: string;
  group: string;
  note?: string;
}

/** The cross-stack views' own fields (packages/explorer/server/views/{endpoints,pageApi,apiTables,featurePath,tableUsage}.ts). */
export interface CrossStackData {
  lanes: LaneInfo[];
  wsCounts: WsCount[];
  groups: { id: string; label: string; count: number }[];
  methods: string[];
  totals: Record<string, number | boolean>;
  choices: FocusChoice[];
  focus: string | null;
  gaps: string[];
  truncated: boolean;
  table: { name: string; columns: string[]; dialect: string | null } | null;
  endpointTables: { endpoint: string; reads: string[]; writes: string[] }[];
}

/** Files changed since the index was last brought up to date (spec section 11 (c)). */
export interface Stale {
  files: number;
}

export interface Meta {
  repo: string;
  /** Every repo of the store, sorted; one entry for a workspace of one. */
  repos: string[];
  headSha: string | null;
  counts: { workspaces: number; files: number; symbols: number; edges: number } & Record<string, number>;
  views: ViewInfo[];
  stale?: Stale;
}

/** `POST /api/refresh`: what the heal plus working-layer re-index changed. */
export interface RefreshResult {
  changed: { files: number; functions: number };
  ms: number;
  healed: boolean;
  /** Ids of the changed files (`file:<repo>:<path>`). */
  files: string[];
  functions: { added: string[]; changed: string[]; removed: string[] };
}

export type DupTier = "exact" | "near" | "code_vector" | "semantic";

export interface DupAdvice {
  situation: number;
  action: string;
  inline: boolean;
  /** Model-written text about untrusted code. Data only: plain text, never parsed or merged into prose. */
  untrusted_suggested_name?: string;
}

export interface DupMember {
  id: string;
  name: string;
  kind: string;
  /** The member's repo; present only when the index holds more than one repo. */
  repo?: string;
  path: string;
  line: number;
  endLine: number;
  loc: number;
  workspaceId: string | null;
  exported: boolean;
  /** Distinct functions that call, render or use it. */
  fanIn: number;
  /** How the member relates to the keep candidate; null on the keep candidate itself. */
  tier: DupTier | null;
  /** 0..1 similarity to the keep candidate; null when it could not be measured. */
  score: number | null;
  keep: boolean;
  advice?: DupAdvice;
}

export interface DupCluster {
  id: string;
  /** The loosest link inside the group. */
  tier: DupTier;
  tiers: Record<DupTier, number>;
  size: number;
  loc: number;
  rank: number;
  keep: string;
  keepReason: string;
  workspaces: string[];
  /** Distinct repos of the members; present only when the index holds more than one repo. */
  repos?: string[];
  members: DupMember[];
  links: { a: string; b: string; tier: DupTier }[];
}

export interface DupWorkspace {
  id: string;
  name: string;
  shortLabel: string;
  kind: string;
}

export interface DupSkipInfo {
  tier: DupTier;
  reason: "vectors_unavailable" | "not_embedded" | "no_description";
  message: string;
}

export interface DupSplit {
  workspaces: string[];
  clusters: number;
  functions: number;
}

export interface DupSummary {
  clusters: number;
  functions: number;
  duplicateLines: number;
  crossWorkspace: number;
  /** Groups spanning several repos; present only when the index holds more than one repo. */
  crossRepo?: number;
}

/** The duplicates view's own fields, next to the usual nodes/edges. */
export interface DuplicatesData {
  clusters: DupCluster[];
  summary: DupSummary;
  splits: DupSplit[];
  workspaces: DupWorkspace[];
  skipped: DupSkipInfo[];
}

/** The pages view: an app that has routes (for the filter panel). */
export interface PagesApp {
  id: string;
  name: string;
  shortLabel: string;
  routes: number;
}

/** The slices view: a function used from at least two other slices. */
export interface SharedSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  slice: string;
  usedBy: { id: string; label: string }[];
}

export type ChangeKind = "added" | "modified" | "removed" | "moved" | "renamed";

/** One side (before or after) of a changed symbol. */
export interface ReviewSide {
  id: string;
  path: string;
  line: number;
  signature: string;
  exported: boolean;
}

/** How a consumer uses the changed item (or, for a potential consumer, the node one step nearer). */
export type UseKind =
  | "calls"
  | "renders"
  | "uses_hook"
  | "extends"
  | "implements"
  | "references_type"
  | "imports"
  | "serves"
  | "handles"
  | "requests";

/** One consumer of a change (#169): names and paths only. */
export interface ReviewConsumer {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number | null;
  workspace: string | null;
  /** 1: directly affected; 2 or 3: potentially affected; 4 or more: reachable. */
  hop: number;
  uses: UseKind[];
  crosses: ("workspace" | "app" | "client_server")[];
  /** Potential only: the direct consumer it reaches the change through. */
  via?: string;
  /** Potential and reachable only: the node it uses, one step nearer the change. */
  next?: string;
  /** The node of this map that shows it. */
  node?: string;
  /** Potential only: the node that shows `next`. */
  nextNode?: string;
}

/** One hub (a node with many consumers) and the consumers first reached through it. */
export interface ReviewHub {
  /** Node id of the hub. */
  hub: string;
  name: string;
  kind: string;
  path: string;
  workspace: string | null;
  /** Hop of the consumers it stands for. */
  hop: number;
  consumersTotal: number;
  byWorkspace: { workspace: string | null; count: number }[];
  /** The node of this map that shows the hub. */
  node?: string;
  members: ReviewConsumer[];
}

export interface ReviewConsumers {
  direct: ReviewConsumer[];
  directTotal: number;
  potential: ReviewConsumer[];
  potentialTotal: number;
  /** Hop 4 and later, as listed. */
  reachable: ReviewConsumer[];
  /** Every reachable consumer, the hubs' included. */
  reachableTotal: number;
  hubs: ReviewHub[];
}

/** Who wrote a stored description: a model, a template (copied from the code), or Gantry's fallback (no model). */
export type DescribedBy = "model" | "template" | "fallback";

export interface ReviewChange {
  id: string;
  kind: ChangeKind;
  name: string;
  symbolKind: string;
  path: string;
  line: number;
  signatureChanged: boolean;
  exportedChanged: boolean;
  locDelta: number;
  before?: ReviewSide;
  after?: ReviewSide;
  /** Distinct direct consumers (`consumers.directTotal`). */
  callers: number;
  /** Directly and potentially affected consumers. */
  consumers: ReviewConsumers;
  /** Model-, template- or fallback-written text about untrusted code. Untrusted: render as plain text only. */
  untrusted_description: string | null;
  /** Who wrote the description (#180): a model, a template, or Gantry's fallback without a model. */
  described_by?: DescribedBy;
}

export interface ReviewRiskRule {
  id: string;
  label: string;
  points: number;
  perUnit?: boolean;
  max?: number;
}

/** How a map node looks in the review layer (`moved` covers renamed and moved). */
export type ReviewMarkKind = "added" | "modified" | "signature" | "moved" | "removed";

export interface ReviewMark {
  id: string;
  change?: ReviewMarkKind;
  changes?: number;
  hop?: number;
}

export interface ReviewLink {
  id: string;
  src: string;
  dst: string;
  change: ReviewMarkKind;
  weight: number;
  /** `direct`: hop 1, solid, to the change. `potential` (#173): hops 2-3, dashed, to the node one step nearer. */
  tier: "direct" | "potential";
  hop: number;
}

/** The review as a layer on the map in the same response: marks and lines by node id, at the map's level. */
export interface ReviewLayer {
  marks: ReviewMark[];
  links: ReviewLink[];
  linksTotal: number;
  /** Changed symbol and file ids, and consumer ids -> the node that shows them. */
  placed: [string, string][];
  unplaced: string[];
}

/** `review` of the review view and of a project map with `range` (packages/explorer/server/views/review.ts). */
export interface ReviewData {
  range: string;
  pr?: number;
  base: string;
  head: string;
  mergeBase: string;
  headSha: string;
  /** `map`: the layer on the project map (default); `rings`: changed code in the centre, callers by hop. */
  mode: "map" | "rings";
  /** The map the review view draws on. */
  map: "2d" | "3d";
  /** Rings mode: edges between rings before the cap. */
  edgesTotal?: number;
  files: {
    id: string;
    path: string;
    status: "A" | "M" | "D" | "R";
    changes: number;
    consumers: ReviewConsumers;
  }[];
  changes: ReviewChange[];
  callersByHop: { hop: number; count: number }[];
  /** Distinct consumers at hop 4 or more, the hubs' included. */
  reachableTotal: number;
  crossings: { from: string; to: string; kind: "workspace" | "app" | "client_server" }[];
  risk: { score: number; level: "low" | "medium" | "high"; reasons: string[] };
  rules: ReviewRiskRule[];
  levels: { medium: number; high: number };
  notes: string[];
  layer: ReviewLayer;
  ms: number;
  cached: boolean;
}

export interface ViewData extends Partial<DuplicatesData>, Partial<CrossStackData> {
  /** Review view: the diff, impact and risk. Null when no range or pull request was given. */
  review?: ReviewData | null;
  /** Pages view: every app with routes, whatever the filter says. */
  apps?: PagesApp[];
  /** Slices view: functions used from at least two other slices. */
  shared?: SharedSymbol[];
  /** Slices view: apps (workspace ids) that use first-level route segments as slices. */
  routeFallback?: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHint: string;
  stale?: Stale;
  /** What the curation overlay did to this view (spec section 11). */
  overlay?: OverlayInfo;
}

// ---- Curation overlay (mirrors packages/core/src/overlay/types.ts and packages/explorer/server/overlay.ts) ----

export type SelectorKind =
  | "workspace"
  | "dir"
  | "file"
  | "function"
  | "method"
  | "component"
  | "hook"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "route"
  | "endpoint"
  | "middleware"
  | "table";

export type Selector =
  | { type: "glob"; glob: string }
  | { type: "kind"; kind: SelectorKind }
  | { type: "workspace"; workspace: string }
  | { type: "ids"; ids: string[] };

export interface FilterSpec {
  view: string;
  level?: ViewLevel;
  focus?: string;
  hidden: Selector[];
  groups: string[];
  filters: Record<string, string>;
}

export interface Group {
  id: string;
  name: string;
  selectors: Selector[];
  mayUse: string[] | null;
}

export interface SavedView {
  id: string;
  name: string;
  spec: FilterSpec;
}

export interface Label {
  nodeId: string;
  text: string;
}

export interface OverlayState {
  labels: Label[];
  hidden: Selector[];
  groups: Group[];
  views: SavedView[];
}

/** `GET /api/overlay`: the state plus the hand-picked entries that no longer name anything. */
export interface OverlayResponse extends OverlayState {
  unresolved: {
    entry: "label" | "hidden" | "group" | "view";
    id: string;
    groupId?: string;
    viewId?: string;
    text?: string;
    reason: "gone" | "ambiguous";
  }[];
}

/** The `overlay` object of a view response. */
export interface OverlayInfo {
  hidden: number;
  groups: { id: string; name: string; members: string[] }[];
}

export interface DismissResult {
  dismissed: { a: string; b: string; reason: string };
  summary: DupSummary;
  clusters: { id: string; size: number }[];
}

/** The `node` object of /api/node. Symbols carry the full set; files and workspaces only some of it. */
export interface NodeBody {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  /** Symbols and files: the language id (`typescript`) and its display label. */
  lang?: string;
  langLabel?: string;
  workspaceId?: string | null;
  workspaceKind?: string;
  line?: number;
  endLine?: number;
  exported?: boolean;
  loc?: number;
  complexity?: number;
  /** Endpoints (#48): what it answers and what it touches. */
  endpoint?: EndpointFacts;
  /** Tables (#48): columns and who reads and writes it. */
  table?: TableFacts;
  /** A middleware an oRPC procedure or server function names (`mwref:` ids, #48): the endpoints that use it. */
  middlewareRef?: { name: string; endpoints: NodeRef[] };
}

export interface NodeRef {
  id: string;
  label: string;
  path: string | null;
  line: number | null;
}

export interface EndpointFacts {
  adapter: string;
  group: string;
  method: string;
  path: string;
  rpcPath: string | null;
  protocol: string | null;
  handler: NodeRef | null;
  handlerName: string | null;
  middleware: string[];
  requestedBy: number;
  reads: NodeRef[];
  writes: NodeRef[];
}

export interface TableFacts {
  name: string;
  exportName: string | null;
  dialect: string | null;
  columns: string[];
  readers: number;
  writers: number;
  readerSample: NodeRef[];
  writerSample: NodeRef[];
}

export interface NeighborRef {
  id: string;
  direction: "in" | "out";
  kind: string;
  label: string;
  confidence: "high" | "low";
  count: number;
}

export interface NodeDetail {
  node: NodeBody;
  signature: string | null;
  fan_in: number;
  fan_out: number;
  /** Keyed by edge kind; each entry says which way the edge points. */
  neighbors: Record<string, NeighborRef[]>;
  /** Model-, template- or fallback-written text. Untrusted: render as plain text only. */
  untrusted_description: string | null;
  /** Who wrote the description: a model, a template, or Gantry's fallback without a model (#175). */
  described_by?: DescribedBy;
}

/** `/api/overview/:id` for a workspace or folder. Never generates anything; `null` means none is cached or it is stale. */
export interface OverviewDetail {
  node_id: string;
  /** Model-written text about untrusted code. Untrusted: render as plain text only. */
  untrusted_overview: string | null;
  stale: boolean;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  /** Language id and display label (`TypeScript`). */
  lang?: string;
  langLabel?: string;
  path: string;
  line: number;
  exported: boolean;
  signature?: string;
  score?: number;
  /** Model-, template- or fallback-written text about untrusted code. Data only; the search box does not render it. */
  untrusted_description?: string | null;
  /** Who wrote the description (#180); present when there is one. */
  described_by?: DescribedBy;
}

export interface SourceSlice {
  path: string;
  start: number;
  end: number;
  total: number;
  lines: string[];
}

/** Flat key/value filters. List values are `|` separated; booleans are "true" / "false". */
export type Filters = Record<string, string>;

export type ViewLevel = "repos" | "workspaces" | "dirs" | "files" | "symbols";

/** What the hash route can pass to /api/view/:id. */
export interface ViewOptions {
  focus?: string;
  level?: ViewLevel;
  hops?: number;
  /** Id of a saved view: its level, focus and filters are the defaults. */
  saved?: string;
  filters?: Filters;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  const res = await fetch(qs ? `${path}?${qs}` : path, { credentials: "same-origin", signal });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // not JSON; the status is enough
    }
    throw new ApiError(res.status, detail || `${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

/** A write to the overlay routes: JSON in, JSON out, the server's message in the error. */
async function writeJson<T>(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, detail || `${method} ${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Filters travel as one `filters` query param holding a JSON object, which the server's `parseOptions`
 * accepts. List values stay `|`-separated strings (`optList` splits them) and "true"/"false" strings read as booleans.
 */
export function encodeFilters(filters: Filters): string | undefined {
  return Object.keys(filters).length === 0 ? undefined : JSON.stringify(filters);
}

export const api = {
  // `scenario` and `view` are mock-only: the mock answers with that scenario's repo name and counts (they differ
  // between the 2D and 3D datasets). The real server ignores both.
  meta: (signal?: AbortSignal, scenario?: string, view?: string) =>
    getJson<Meta>("/api/meta", { scenario, view: scenario ? view : undefined }, signal),

  view: (id: string, opts: ViewOptions, signal?: AbortSignal) =>
    getJson<ViewData>(
      `/api/view/${encodeURIComponent(id)}`,
      {
        focus: opts.focus,
        level: opts.level,
        hops: opts.hops,
        saved: opts.saved,
        filters: opts.filters ? encodeFilters(opts.filters) : undefined,
      },
      signal,
    ),

  /** Saved canvas positions for a view: `{ nodeId: [x, y] }`. */
  layout: async (view: string, signal?: AbortSignal): Promise<Record<string, [number, number]>> =>
    (
      await getJson<{ positions: Record<string, [number, number]> }>(
        `/api/layout/${encodeURIComponent(view)}`,
        {},
        signal,
      )
    ).positions,

  saveLayout: async (view: string, positions: Record<string, [number, number]>): Promise<void> => {
    const res = await fetch(`/api/layout/${encodeURIComponent(view)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions }),
    });
    if (!res.ok) throw new ApiError(res.status, `layout save failed with ${res.status}`);
  },

  /** Re-indexes what changed (heal plus the working layer). One at a time on the server. */
  refresh: async (): Promise<RefreshResult> => {
    const res = await fetch("/api/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = body.error;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, detail || `refresh failed with ${res.status}`);
    }
    return (await res.json()) as RefreshResult;
  },

  /** Marks two functions as "not a duplicate". Hidden for good, and in the duplicate guard too. */
  dismiss: async (a: string, b: string, reason: string): Promise<DismissResult> => {
    const res = await fetch("/api/dismiss", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a, b, reason }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = body.error;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, detail || `dismiss failed with ${res.status}`);
    }
    return (await res.json()) as DismissResult;
  },

  getOverlay: (signal?: AbortSignal) => getJson<OverlayResponse>("/api/overlay", {}, signal),

  /** An empty `text` removes the label. */
  putLabel: (nodeId: string, text: string) =>
    writeJson<{ labels: Label[] }>("PUT", "/api/overlay/labels", { nodeId, text }),

  putHidden: (selectors: Selector[]) =>
    writeJson<{ hidden: Selector[] }>("PUT", "/api/overlay/hidden", { selectors }),

  putGroup: (group: Group) => {
    const { id, ...body } = group;
    return writeJson<{ group: Group }>("PUT", `/api/overlay/groups/${encodeURIComponent(id)}`, body);
  },

  deleteGroup: (id: string) =>
    writeJson<{ deleted: string }>("DELETE", `/api/overlay/groups/${encodeURIComponent(id)}`),

  putView: (view: SavedView) =>
    writeJson<{ view: SavedView }>("PUT", `/api/overlay/views/${encodeURIComponent(view.id)}`, {
      name: view.name,
      spec: view.spec,
    }),

  deleteView: (id: string) =>
    writeJson<{ deleted: string }>("DELETE", `/api/overlay/views/${encodeURIComponent(id)}`),

  resetOverlay: () => writeJson<OverlayState>("POST", "/api/overlay/reset", {}),

  node: (id: string, signal?: AbortSignal) =>
    getJson<NodeDetail>(`/api/node/${encodeURIComponent(id)}`, {}, signal),

  overview: (id: string, signal?: AbortSignal) =>
    getJson<OverviewDetail>(`/api/overview/${encodeURIComponent(id)}`, {}, signal),

  search: async (q: string, signal?: AbortSignal): Promise<SearchHit[]> =>
    (await getJson<{ hits: SearchHit[] }>("/api/search", { q }, signal)).hits,

  source: (path: string, start: number, end: number, signal?: AbortSignal, repo?: string) =>
    getJson<SourceSlice>(
      "/api/source",
      { path, start, end, ...(repo === undefined ? {} : { repo }) },
      signal,
    ),
};

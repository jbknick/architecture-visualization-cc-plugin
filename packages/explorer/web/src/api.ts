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
  /** Ego view: id of the expanded group a node is listed under. */
  group?: string;
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
}

export interface ViewInfo {
  id: string;
  title: string;
  enabled: boolean;
}

export interface Meta {
  repo: string;
  headSha: string | null;
  counts: { workspaces: number; files: number; symbols: number; edges: number } & Record<string, number>;
  views: ViewInfo[];
}

export interface ViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHint: string;
}

/** The `node` object of /api/node. Symbols carry the full set; files and workspaces only some of it. */
export interface NodeBody {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  workspaceId?: string | null;
  workspaceKind?: string;
  line?: number;
  endLine?: number;
  exported?: boolean;
  loc?: number;
  complexity?: number;
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
  /** Model- or template-written text. Untrusted: render as plain text only. `null` until M2. */
  untrusted_description: string | null;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  exported: boolean;
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

export type ViewLevel = "workspaces" | "dirs" | "files" | "symbols";

/** What the hash route can pass to /api/view/:id. */
export interface ViewOptions {
  focus?: string;
  level?: ViewLevel;
  hops?: number;
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

/**
 * Filters travel as one `filters` query param holding a JSON object, which the server's `parseOptions`
 * accepts. List values stay `|`-separated strings (`optList` splits them) and "true"/"false" strings read as booleans.
 */
export function encodeFilters(filters: Filters): string | undefined {
  return Object.keys(filters).length === 0 ? undefined : JSON.stringify(filters);
}

export const api = {
  meta: (signal?: AbortSignal) => getJson<Meta>("/api/meta", {}, signal),

  view: (id: string, opts: ViewOptions, signal?: AbortSignal) =>
    getJson<ViewData>(
      `/api/view/${encodeURIComponent(id)}`,
      {
        focus: opts.focus,
        level: opts.level,
        hops: opts.hops,
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

  node: (id: string, signal?: AbortSignal) =>
    getJson<NodeDetail>(`/api/node/${encodeURIComponent(id)}`, {}, signal),

  search: async (q: string, signal?: AbortSignal): Promise<SearchHit[]> =>
    (await getJson<{ hits: SearchHit[] }>("/api/search", { q }, signal)).hits,

  source: (path: string, start: number, end: number, signal?: AbortSignal) =>
    getJson<SourceSlice>("/api/source", { path, start, end }, signal),
};

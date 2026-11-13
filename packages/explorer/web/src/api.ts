// The only place that talks to the explorer server (issue #33). If the server contract moves, change it here.

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
  confidence: string;
}

export interface ViewInfo {
  id: string;
  title: string;
  enabled: boolean;
}

export interface Meta {
  repo: string;
  headSha: string;
  /** Free-form counts. The status bar reads `files`, `symbols`, `edges`, `backlog` and `workingFiles` when present. */
  counts: Record<string, number>;
  views: ViewInfo[];
}

export interface ViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHint: string;
}

export interface NodeDetail {
  node: GraphNode;
  signature: string;
  fan_in: number;
  fan_out: number;
  neighbors: Record<string, string[]>;
  /** Model- or template-written text. Untrusted: render as plain text only. */
  untrusted_description: string | null;
  /** Optional extras the inspector uses when the server provides them. */
  provenance?: { source: "template" | "model"; model?: string };
  path?: string;
  line?: number;
  end_line?: number;
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
  lines: string[];
}

export type Filters = Record<string, string>;

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
  if (!res.ok) throw new ApiError(res.status, `${path} failed with ${res.status}`);
  return (await res.json()) as T;
}

/** Filters travel as one `filters` query param holding a URL-encoded `k=v&k2=v2` string. */
export function encodeFilters(filters: Filters): string {
  return new URLSearchParams(filters).toString();
}

export const api = {
  meta: (signal?: AbortSignal) => getJson<Meta>("/api/meta", {}, signal),

  view: (id: string, opts: { focus?: string; depth?: number; filters?: Filters }, signal?: AbortSignal) =>
    getJson<ViewData>(
      `/api/view/${encodeURIComponent(id)}`,
      {
        focus: opts.focus,
        depth: opts.depth,
        filters: opts.filters ? encodeFilters(opts.filters) : undefined,
      },
      signal,
    ),

  node: (id: string, signal?: AbortSignal) =>
    getJson<NodeDetail>(`/api/node/${encodeURIComponent(id)}`, {}, signal),

  search: async (q: string, signal?: AbortSignal): Promise<SearchHit[]> =>
    (await getJson<{ hits: SearchHit[] }>("/api/search", { q }, signal)).hits,

  /** The contract says "source lines"; accept `{ lines: string[] }` or `{ text: string }`. */
  source: async (path: string, start: number, end: number, signal?: AbortSignal): Promise<SourceSlice> => {
    const raw = await getJson<{ lines?: string[]; text?: string; start?: number }>(
      "/api/source",
      { path, start, end },
      signal,
    );
    const lines = raw.lines ?? (raw.text ?? "").replace(/\n$/, "").split("\n");
    return { path, start: raw.start ?? start, lines };
  },
};

import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { isIndexable, isSensitive, MAX_FILE_BYTES, splitIdentifier } from "@gantry/core";
import type { ApiContext, ViewParams } from "./types.js";
import { getView, listViews } from "./views/index.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const MAX_SOURCE_LINES = 400;
export const SEARCH_LIMIT = 20;

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  exported: boolean;
}

export interface NeighborRef {
  id: string;
  direction: "out" | "in";
  kind: string;
  label: string;
  confidence: "high" | "low";
  count: number;
}

/** Dispatches `/api/*` GET requests. Returns the JSON body; throws HttpError for 4xx. */
export function handleApi(ctx: ApiContext, pathname: string, query: URLSearchParams): unknown {
  const segments = pathname.split("/").filter(Boolean); // ["api", name, ...rest]
  const name = segments[1];
  switch (name) {
    case "meta":
      return meta(ctx);
    case "view":
      return view(ctx, decodeSegment(segments[2]), query);
    case "node":
      return node(ctx, decodeSegment(segments[2]));
    case "search":
      return search(ctx, query.get("q") ?? "");
    case "source":
      return source(ctx, query);
    default:
      throw new HttpError(404, "Unknown API route");
  }
}

function decodeSegment(s: string | undefined): string {
  if (!s) throw new HttpError(400, "Missing id");
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "Malformed id");
  }
}

function meta({ store, paths }: ApiContext) {
  return {
    repo: path.basename(paths.root),
    headSha: store.getMeta("head_sha") ?? null,
    counts: {
      workspaces: store.listWorkspaces().length,
      files: store.effectiveFiles().length,
      symbols: store.effectiveSymbols().length,
      edges: store.effectiveEdges().length,
    },
    views: listViews().map((v) => ({ id: v.id, title: v.title, enabled: v.enabled })),
  };
}

function view(ctx: ApiContext, id: string, query: URLSearchParams) {
  const mod = getView(id);
  if (!mod) throw new HttpError(404, `Unknown view: ${id}`);
  if (!mod.enabled) throw new HttpError(404, `View disabled: ${id}`);
  const params: ViewParams = {
    filters: (query.get("filters") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const focus = query.get("focus");
  if (focus) params.focus = focus;
  const level = query.get("level");
  if (level) {
    if (!/^[a-z][a-z-]{0,15}$/.test(level)) throw new HttpError(400, "level must be a short lowercase word");
    params.level = level;
  }
  const depth = query.get("depth");
  if (depth !== null) {
    const n = Number(depth);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new HttpError(400, "depth must be an integer 0-20");
    params.depth = n;
  }
  return mod.build(ctx, params);
}

interface Labeler {
  label(id: string): string;
}

function makeLabeler({ store }: ApiContext): Labeler {
  const ws = new Map(store.listWorkspaces().map((w) => [w.id, w.name]));
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
  return {
    label(id) {
      if (id.startsWith("sym:")) return store.getSymbol(id)?.name ?? id.slice(4);
      if (id.startsWith("file:")) return files.get(id) ?? id.slice(5);
      if (id.startsWith("ws:")) return ws.get(id) ?? id.slice(3);
      return id;
    },
  };
}

function node(ctx: ApiContext, id: string) {
  const { store } = ctx;
  let nodeBody: Record<string, unknown> | undefined;
  let signature: string | null = null;
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  if (id.startsWith("sym:")) {
    const s = store.getSymbol(id);
    if (s) {
      const f = files.get(s.fileId);
      signature = s.signature;
      nodeBody = {
        id: s.id,
        kind: s.kind,
        name: s.name,
        path: f?.path ?? null,
        workspaceId: f?.workspaceId ?? null,
        line: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
        loc: s.loc,
        complexity: s.complexity,
      };
    }
  } else if (id.startsWith("file:")) {
    const f = files.get(id);
    if (f) nodeBody = { id: f.id, kind: "file", name: f.path, path: f.path, workspaceId: f.workspaceId };
  } else if (id.startsWith("ws:")) {
    const w = store.listWorkspaces().find((x) => x.id === id);
    if (w) {
      nodeBody = { id: w.id, kind: "workspace", name: w.name, path: w.dir, workspaceKind: w.kind };
    }
  }
  if (!nodeBody) throw new HttpError(404, `Unknown node: ${id}`);

  const labeler = makeLabeler(ctx);
  const neighbors: Record<string, NeighborRef[]> = {};
  const push = (kind: string, ref: NeighborRef) => {
    let list = neighbors[kind];
    if (!list) {
      list = [];
      neighbors[kind] = list;
    }
    list.push(ref);
  };
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const e of store.effectiveEdges({ src: id })) {
    push(e.kind, {
      id: e.dst,
      direction: "out",
      kind: e.kind,
      label: labeler.label(e.dst),
      confidence: e.confidence,
      count: e.count,
    });
    if (e.kind !== "contains") outgoing.add(e.dst);
  }
  for (const e of store.effectiveEdges({ dst: id })) {
    push(e.kind, {
      id: e.src,
      direction: "in",
      kind: e.kind,
      label: labeler.label(e.src),
      confidence: e.confidence,
      count: e.count,
    });
    if (e.kind !== "contains") incoming.add(e.src);
  }
  return {
    node: nodeBody,
    signature,
    fan_in: incoming.size,
    fan_out: outgoing.size,
    neighbors,
    untrusted_description: null, // descriptions arrive in M2
  };
}

const MAX_QUERY_LEN = 200;

function search(ctx: ApiContext, raw: string): { hits: SearchHit[] } {
  const { store } = ctx;
  const q = raw.trim().slice(0, MAX_QUERY_LEN);
  if (!q) return { hits: [] };
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const add = (s: ReturnType<typeof store.getSymbol>) => {
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    hits.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      path: files.get(s.fileId) ?? "",
      line: s.startLine,
      exported: s.exported,
    });
  };

  // Prefix-matched tokens over name_tokens and path. Tokens are alphanumeric only, so the MATCH string is safe.
  const tokens = [...new Set([...splitIdentifier(q), ...(q.toLowerCase().match(/[a-z0-9]+/g) ?? [])])];
  const ftsHits: string[] = [];
  if (tokens.length > 0) {
    const match = `{name_tokens path} : ${tokens.map((t) => `"${t}"*`).join(" ")}`;
    try {
      const rows = store.db
        .prepare("SELECT symbol_id FROM fts_symbols WHERE fts_symbols MATCH ? ORDER BY rank LIMIT 200")
        .all(match) as { symbol_id: string }[];
      for (const r of rows) ftsHits.push(r.symbol_id);
    } catch {
      // malformed FTS expression: fall through to the substring search
    }
  }
  const lower = q.toLowerCase();
  const all = store.effectiveSymbols();
  const byId = new Map(all.map((s) => [s.id, s]));
  for (const id of ftsHits) add(byId.get(id));
  for (const s of all) if (s.name.toLowerCase().includes(lower)) add(s);

  const rank = (name: string): number => {
    const n = name.toLowerCase();
    return n === lower ? 0 : n.startsWith(lower) ? 1 : 2;
  };
  // Array.prototype.sort is stable, so FTS order is kept within a rank.
  hits.sort((a, b) => rank(a.name) - rank(b.name));
  return { hits: hits.slice(0, SEARCH_LIMIT) };
}

function intParam(v: string | null, name: string): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
}

function source(ctx: ApiContext, query: URLSearchParams) {
  const rel = query.get("path");
  if (!rel) throw new HttpError(400, "Missing path");
  const start = intParam(query.get("start"), "start") ?? 1;
  const requestedEnd = intParam(query.get("end"), "end") ?? start + MAX_SOURCE_LINES - 1;
  if (requestedEnd < start) throw new HttpError(400, "end must be >= start");
  const end = Math.min(requestedEnd, start + MAX_SOURCE_LINES - 1);

  const normalized = rel.replaceAll("\\", "/");
  if (
    rel.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new HttpError(403, "Path outside the repository");
  }
  const clean = path.posix.normalize(normalized);
  if (isSensitive(clean) || !isIndexable(clean, ctx.config)) {
    throw new HttpError(403, "Path is not indexable");
  }

  const root = ctx.paths.root;
  let real: string;
  try {
    real = realpathSync(path.join(root, clean));
  } catch {
    throw new HttpError(404, "File not found");
  }
  const rootReal = realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new HttpError(403, "Path outside the repository");
  }
  // Re-check the resolved location (a symlink may point at a sensitive file inside the repo).
  const resolvedRel = path.relative(rootReal, real).split(path.sep).join("/");
  if (isSensitive(resolvedRel) || !isIndexable(resolvedRel, ctx.config)) {
    throw new HttpError(403, "Path is not indexable");
  }

  const fd = openSync(real, "r");
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new HttpError(404, "Not a file");
    if (st.size > MAX_FILE_BYTES) throw new HttpError(413, "File too large");
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const lines = all.slice(start - 1, end);
  return { path: clean, start, end: start + lines.length - 1, total: all.length, lines };
}

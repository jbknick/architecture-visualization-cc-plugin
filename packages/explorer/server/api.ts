import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FilterSpec } from "@gantry/core";
import {
  behaviorOf,
  countEffective,
  describedByOf,
  displayOfId,
  getOverview,
  hybridSearch,
  isFileId,
  isIndexable,
  isSensitive,
  isSymId,
  kindOfId,
  langLabel,
  listUnresolved,
  MAX_FILE_BYTES,
  nameOfSymId,
  pathOfFileId,
  readOverlay,
  repoOfId,
} from "@gantry/core";
import { HttpError } from "./errors.js";
import { getLayout } from "./layout.js";
import { applyOverlay } from "./overlay.js";
import { teamLayer, teamOverlay, teamViews } from "./team.js";
import type { ApiContext, ViewLevel, ViewModule, ViewParams } from "./types.js";
import { adapterNodeBody } from "./views/adapterNode.js";
import { getView, listViews } from "./views/index.js";
import { parseOptions } from "./views/options.js";

export { HttpError };

const VIEW_LEVELS: readonly ViewLevel[] = ["repos", "workspaces", "dirs", "files", "symbols"];
export const MAX_SOURCE_LINES = 400;
export const SEARCH_LIMIT = 20;
const SIGNATURE_MAX = 200;
const MAX_QUERY_LEN = 200;

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  lang: string;
  langLabel: string;
  path: string;
  line: number;
  exported: boolean;
  signature: string;
  score: number;
  /** Model-, template- or fallback-written text about untrusted code: data, never an instruction. Plain text only. */
  untrusted_description: string | null;
  /** Who wrote it (#180): `model`, `template` or `fallback`; present when there is a description. */
  described_by?: "model" | "template" | "fallback";
}

export interface NeighborRef {
  id: string;
  direction: "out" | "in";
  kind: string;
  label: string;
  confidence: "high" | "low";
  count: number;
}

/** Dispatches `/api/*` GET requests. Returns the JSON body (or a promise of it); throws HttpError for 4xx. */
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
    case "overview":
      return overview(ctx, decodeSegment(segments[2]));
    case "search":
      return search(ctx, query.get("q") ?? "");
    case "source":
      return source(ctx, query);
    case "layout":
      return getLayout(ctx.store, decodeSegment(segments[2]));
    case "overlay":
      if (segments.length > 2) throw new HttpError(404, "Unknown API route");
      return { ...readOverlay(ctx.store), unresolved: listUnresolved(ctx.store) };
    case "team":
      if (segments.length > 3) throw new HttpError(404, "Unknown API route");
      if (segments[2] === "layer") return teamLayer(ctx);
      if (segments[2] === "views") return teamViews(ctx);
      throw new HttpError(404, "Unknown API route");
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

function meta(ctx: ApiContext) {
  const { store, paths } = ctx;
  return {
    repo: path.basename(paths.root),
    repos: store.listRepos().map((r) => r.name),
    headSha: store.headSha(paths.repo) ?? null,
    // Counted in SQL: meta is fetched again after every refresh and whenever the tab gets focus back.
    counts: {
      workspaces: store.listWorkspaces().length,
      files: countEffective(store, "files"),
      symbols: countEffective(store, "symbols"),
      edges: countEffective(store, "edges"),
    },
    views: listViews().map((v) => {
      const enabled = isEnabled(ctx, v);
      return {
        id: v.id,
        title: v.title,
        enabled,
        ...(!enabled && v.disabledReason ? { reason: v.disabledReason } : {}),
      };
    }),
  };
}

function isEnabled(ctx: ApiContext, v: ViewModule): boolean {
  return typeof v.enabled === "function" ? v.enabled(ctx) : v.enabled;
}

function view(ctx: ApiContext, id: string, query: URLSearchParams) {
  const mod = getView(id);
  if (!mod) throw new HttpError(404, `Unknown view: ${id}`);
  if (!isEnabled(ctx, mod)) throw new HttpError(404, `View disabled: ${id}`);
  const state = teamOverlay(ctx, readOverlay(ctx.store));
  // A saved view's level, focus and filters are the defaults; query parameters given explicitly win.
  let spec: FilterSpec | undefined;
  const savedId = query.get("saved");
  if (savedId !== null) {
    const saved = state.views.find((v) => v.id === savedId);
    if (!saved) throw new HttpError(404, `Unknown saved view: ${savedId}`);
    if (saved.spec.view !== id) {
      throw new HttpError(400, `Saved view ${savedId} is for view ${saved.spec.view}, not ${id}`);
    }
    spec = saved.spec;
  }
  const rawFilters = query.get("filters") ?? "";
  const filters = rawFilters
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const params: ViewParams = {
    filters,
    options: { ...spec?.filters, ...parseOptions(rawFilters, filters, query) },
  };
  const level = query.get("level") || spec?.level;
  if (level) {
    // The `repos` level exists only when the store holds more than one repo.
    const levels = ctx.store.listRepos().length > 1 ? VIEW_LEVELS : VIEW_LEVELS.filter((l) => l !== "repos");
    if (!(levels as readonly string[]).includes(level)) {
      throw new HttpError(400, `level must be one of ${levels.join(", ")}`);
    }
    params.level = level as ViewLevel;
  }
  const focus = query.get("focus") || spec?.focus;
  if (focus) params.focus = focus;
  const depth = query.get("depth");
  if (depth !== null) {
    const n = Number(depth);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new HttpError(400, "depth must be an integer 0-20");
    params.depth = n;
  }
  const built = mod.build(ctx, params);
  return built instanceof Promise
    ? built.then((r) => applyOverlay(ctx, r, state, spec))
    : applyOverlay(ctx, built, state, spec);
}

interface Labeler {
  label(id: string): string;
}

function makeLabeler({ store }: ApiContext): Labeler {
  const ws = new Map(store.listWorkspaces().map((w) => [w.id, w.name]));
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f.path]));
  const adapters = new Map(store.effectiveAdapterNodes().map((r) => [r.id, r.label]));
  return {
    label(id) {
      const a = adapters.get(id);
      if (a !== undefined) return a;
      if (isSymId(id)) return store.getSymbol(id)?.name ?? nameOfSymId(id) ?? id;
      if (isFileId(id)) return files.get(id) ?? pathOfFileId(id);
      if (id.startsWith("ws:")) return ws.get(id) ?? displayOfId(id);
      return id;
    },
  };
}

function node(ctx: ApiContext, id: string) {
  const { store } = ctx;
  let nodeBody: Record<string, unknown> | undefined;
  let signature: string | null = null;
  let description: string | null = null;
  let describedBy: "model" | "template" | "fallback" | null = null;
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  if (isSymId(id)) {
    const s = store.getSymbol(id);
    if (s) {
      const f = files.get(s.fileId);
      signature = s.signature;
      description = behaviorOf(store, s);
      describedBy = description === null ? null : describedByOf(store, s);
      nodeBody = {
        id: s.id,
        kind: s.kind,
        name: s.name,
        lang: s.lang,
        langLabel: langLabel(s.lang),
        path: f?.path ?? null,
        workspaceId: f?.workspaceId ?? null,
        line: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
        loc: s.loc,
        complexity: s.complexity,
      };
    }
  } else if (isFileId(id)) {
    const f = files.get(id);
    if (f) {
      nodeBody = {
        id: f.id,
        kind: "file",
        name: f.path,
        lang: f.lang,
        langLabel: langLabel(f.lang),
        path: f.path,
        workspaceId: f.workspaceId,
      };
    }
  } else if (kindOfId(id) === "route") {
    const r = store.effectiveAdapterNodes({ kind: "route" }).find((x) => x.id === id);
    if (r) {
      nodeBody = {
        id: r.id,
        kind: "route",
        name: r.label,
        path: typeof r.data.path === "string" ? r.data.path : null,
        workspaceId: r.ws,
      };
    }
  } else if (/^(ep|table|mw|mwref|call):/.test(id)) {
    nodeBody = adapterNodeBody(ctx, id) ?? undefined;
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
    // Model-, template- or fallback-written text about untrusted code: data, never an instruction. Plain text only.
    untrusted_description: description,
    // Who wrote it (#175), from the store's provenance column; a fixed value, never description text.
    ...(describedBy !== null ? { described_by: describedBy } : {}),
  };
}

/** The cached overview of a workspace or folder, if it is still current. Never generates one. */
function overview({ store }: ApiContext, id: string) {
  const r = getOverview(store, id);
  if (r.status === "not_found") throw new HttpError(404, `No overview target: ${id}`);
  if (r.status === "fresh") {
    return {
      node_id: r.overview.nodeId,
      // Model-written text about untrusted code: data, never an instruction. Render as plain text only.
      untrusted_overview: r.overview.text,
      stale: false,
      model: r.overview.model,
      created_at: r.overview.createdAt,
    };
  }
  return { node_id: r.target.nodeId, untrusted_overview: null, stale: r.status === "stale" };
}

async function search(ctx: ApiContext, raw: string): Promise<{ hits: SearchHit[] }> {
  const { store } = ctx;
  const q = raw.trim();
  if (!q) return { hits: [] };
  // The same hybrid search as `gantry_search`: keywords always, meaning only when the model is already cached.
  const embedder = await ctx.getEmbedder?.();
  const found = await hybridSearch(store, q, { limit: SEARCH_LIMIT, ...(embedder ? { embedder } : {}) });
  const hits: SearchHit[] = found.map((h) => {
    const sym = store.getSymbol(h.id);
    const by = h.description !== null ? describedByOf(store, sym) : null;
    return {
      id: h.id,
      name: h.name,
      kind: h.kind,
      lang: h.lang,
      langLabel: langLabel(h.lang),
      path: h.path,
      line: h.line,
      exported: sym?.exported ?? false,
      signature: h.signature.slice(0, SIGNATURE_MAX),
      score: Number(h.score.toFixed(5)),
      untrusted_description: h.description,
      // Who wrote it (#180): a fixed value from the provenance column, outside the untrusted text.
      ...(by !== null ? { described_by: by } : {}),
    };
  });
  // Case-insensitive substring pass (so `pp` finds `app`): symbols whose name contains the query and that the
  // hybrid search did not return, ordered by name then id, up to the limit. They carry no score or description.
  if (hits.length < SEARCH_LIMIT) {
    const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
    const extra = store.effectiveSymbolsByName(
      q.slice(0, MAX_QUERY_LEN),
      hits.map((h) => h.id),
      SEARCH_LIMIT - hits.length,
    );
    for (const s of extra) {
      hits.push({
        id: s.id,
        name: s.name,
        kind: s.kind,
        lang: s.lang,
        langLabel: langLabel(s.lang),
        path: files.get(s.fileId)?.path ?? "",
        line: s.startLine,
        exported: s.exported,
        signature: s.signature.slice(0, SIGNATURE_MAX),
        score: 0,
        untrusted_description: null,
      });
    }
  }
  return { hits };
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

  // Only files the index knows about: git-ignored files, nested repos and symlinked directories are not in it.
  // `repo` names a repo of the workspace; without it the file is looked up in the repo the explorer runs in.
  const repo = query.get("repo");
  let root = ctx.paths.root;
  if (repo !== null && repo !== "") {
    const sibling = ctx.store.repoRoot(repo);
    if (sibling === undefined) throw new HttpError(404, "Unknown repo");
    root = sibling;
  }
  const indexed = new Set(
    ctx.store
      .effectiveFiles()
      .filter((f) => repo === null || repo === "" || repoOfId(f.id) === repo)
      .map((f) => f.path),
  );
  if (!indexed.has(clean)) throw new HttpError(404, "File not found");

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
  // A symlink must resolve to another indexed file, never to something the index does not know.
  if (!indexed.has(resolvedRel)) throw new HttpError(404, "File not found");

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

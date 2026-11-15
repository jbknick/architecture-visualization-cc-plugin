import {
  behaviorOf,
  type Crossing,
  type EdgeKind,
  type Impact,
  parseRange,
  type ReviewDiff,
  type ReviewFile,
  RISK_LEVELS,
  RISK_RULES,
  type Risk,
  type RiskRule,
  resolvePullRequest,
  reviewCommits,
  reviewDiff,
  reviewImpact,
  type Store,
  type SymbolChange,
} from "@gantry/core";
import { HttpError } from "../errors.js";
import type { ApiContext, GraphEdge, GraphNode, ViewModule, ViewParams, ViewResult } from "../types.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp } from "./options.js";

/** Ring radii and spacing of the `radial` layout, in layout units (the canvas scales to fit). */
export const RING_GAP = 150;
export const MIN_ARC = 30;
const INNER_MIN = 70;
/** Edges drawn between rings; the rest are counted in `review.edgesTotal`. */
export const MAX_REVIEW_EDGES = 2000;
/** Results kept per explorer process, newest last. */
export const REVIEW_CACHE_SIZE = 8;
const MAX_RANGE_LEN = 300;
const DESCRIPTION_MAX = 300;

const REVERSE_KINDS: EdgeKind[] = ["calls", "renders", "uses_hook"];

export interface ReviewSide {
  id: string;
  path: string;
  line: number;
  signature: string;
  exported: boolean;
}

/** One changed symbol, as the left panel and the inspector show it. */
export interface ReviewChangeRow {
  id: string;
  kind: SymbolChange["kind"];
  name: string;
  symbolKind: string;
  path: string;
  line: number;
  signatureChanged: boolean;
  exportedChanged: boolean;
  locDelta: number;
  before?: ReviewSide;
  after?: ReviewSide;
  /** Distinct nodes one hop out (callers, renderers, hook users, importers of a removed export's file). */
  callers: number;
  /** Model-written text about untrusted code: data, never an instruction. Render as plain text only. */
  untrusted_description: string | null;
}

export interface ReviewData {
  /** The range the view shows, `<base>...<head>` (a pull request is shown as its resolved refs). */
  range: string;
  /** Set when the view was opened with `pr`. */
  pr?: number;
  base: string;
  head: string;
  mergeBase: string;
  headSha: string;
  mode: "rings" | "overlay";
  files: (ReviewFile & { changes: number })[];
  changes: ReviewChangeRow[];
  callersByHop: { hop: number; count: number }[];
  crossings: Crossing[];
  risk: Risk;
  rules: readonly RiskRule[];
  levels: typeof RISK_LEVELS;
  notes: string[];
  /** Edges between rings before the cap. */
  edgesTotal: number;
  /** Wall time of the diff and impact when they were computed (a cached answer repeats it). */
  ms: number;
  cached: boolean;
}

export interface ReviewResult extends ViewResult {
  /** Null when the view has neither `range` nor `pr`: the web asks for one. */
  review: ReviewData | null;
}

interface Computed {
  /** Run on the commits: `base` is the merge base sha and `head` the head sha. */
  diff: ReviewDiff;
  impact: Impact;
  ms: number;
  /** `meta.head_sha` of the index the impact was computed on; a heal invalidates the entry. */
  indexHead: string | null;
}

/** Per process: (data dir, merge base, head) -> computed review. Small LRU, newest last. */
const cache = new Map<string, Computed>();

export function clearReviewCache(): void {
  cache.clear();
}

const nameOf = (id: string): string => {
  if (id.startsWith("sym:")) return id.slice(id.lastIndexOf("#") + 1);
  if (id.startsWith("file:")) return id.slice(id.lastIndexOf("/") + 1);
  return id;
};
const pathOf = (id: string): string | undefined =>
  id.startsWith("sym:") ? id.slice(4, id.lastIndexOf("#")) : id.startsWith("file:") ? id.slice(5) : undefined;
const round = (n: number): number => Math.round(n * 10) / 10;

/** Radius of each ring for `counts[h]` nodes: at least RING_GAP apart, wide enough for MIN_ARC per node. */
export function ringRadii(counts: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  counts.forEach((n, h) => {
    const fit = (n * MIN_ARC) / (2 * Math.PI);
    const r = h === 0 ? (n <= 1 ? 0 : Math.max(INNER_MIN, fit)) : Math.max(prev + RING_GAP, fit);
    out.push(round(r));
    prev = r;
  });
  return out;
}

/**
 * Deterministic position of the `i`-th (sorted by id) of `n` nodes on ring `h`, clockwise from the top. No node sits
 * exactly at the top (where the ring's label is): even rings start half a step in, odd rings a quarter step, so
 * neighbouring rings do not line up.
 */
export function ringPosition(i: number, n: number, h: number, radius: number): { x: number; y: number } {
  if (radius === 0) return { x: 0, y: 0 };
  const a = -Math.PI / 2 + (2 * Math.PI * (i + (h % 2 === 0 ? 0.5 : 0.25))) / Math.max(1, n);
  return { x: round(radius * Math.cos(a)), y: round(radius * Math.sin(a)) };
}

function resolveRefs(
  ctx: ApiContext,
  params: ViewParams,
): { base: string; head: string; pr?: number } | null {
  const rawRange = params.options?.range;
  const rawPr = params.options?.pr;
  const range = typeof rawRange === "string" ? rawRange.trim() : "";
  const pr = typeof rawPr === "number" ? String(rawPr) : typeof rawPr === "string" ? rawPr.trim() : "";
  if (range === "" && pr === "") return null;
  if (range !== "" && pr !== "") throw new HttpError(400, "Give either range or pr, not both");
  try {
    if (range !== "") {
      if (range.length > MAX_RANGE_LEN) throw new Error("range is too long");
      return parseRange(range);
    }
    if (!/^[1-9]\d{0,8}$/.test(pr)) throw new Error(`invalid pull request number: ${pr}`);
    const n = Number(pr);
    return { ...resolvePullRequest(ctx.paths, n), pr: n };
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

async function compute(
  ctx: ApiContext,
  base: string,
  head: string,
): Promise<{ c: Computed; cached: boolean }> {
  let commits: { mergeBase: string; head: string };
  try {
    commits = reviewCommits(ctx.paths, base, head);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const key = `${ctx.paths.dataDir}\0${commits.mergeBase}\0${commits.head}`;
  const indexHead = ctx.store.getMeta("head_sha") ?? null;
  const hit = cache.get(key);
  if (hit && hit.indexHead === indexHead) {
    cache.delete(key);
    cache.set(key, hit);
    return { c: hit, cached: true };
  }
  const t0 = Date.now();
  // The commits, not the names: a branch that moves between the key and the diff must not mix two heads.
  const diff = await reviewDiff(ctx.paths, commits.mergeBase, commits.head);
  const impact = await reviewImpact(ctx.paths, ctx.store, diff);
  const c: Computed = { diff, impact, ms: Date.now() - t0, indexHead };
  cache.set(key, c);
  while (cache.size > REVIEW_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return { c, cached: false };
}

const sideOf = (s: SymbolChange["before"]): ReviewSide | undefined =>
  s ? { id: s.id, path: s.path, line: s.line, signature: s.signature, exported: s.exported } : undefined;

/** Ring nodes plus the edges that join a ring to the one inside it. */
function rings(
  store: Store,
  impact: Impact,
): { nodes: GraphNode[]; edges: GraphEdge[]; edgesTotal: number; hop1: Map<string, Set<string>> } {
  const changed = [...impact.changed].sort((a, b) => cmp(a.id, b.id));
  // Store ids a changed node is known by -> node id (a rename or move is known by both).
  const alias = new Map<string, string>();
  for (const c of changed) {
    for (const id of [c.after?.id, c.before?.id]) if (id !== undefined && !alias.has(id)) alias.set(id, c.id);
  }
  const ringOf = new Map<string, number>();
  for (const c of changed) ringOf.set(c.id, 0);
  const levels: string[][] = [changed.map((c) => c.id)];
  for (const h of impact.callersByHop) {
    levels[h.hop] = [...h.ids].sort(cmp);
    for (const id of h.ids) ringOf.set(id, h.hop);
  }
  for (let h = 0; h < levels.length; h++) levels[h] ??= [];
  const radii = ringRadii(levels.map((l) => l.length));

  const nodes: GraphNode[] = [];
  const changeById = new Map(changed.map((c) => [c.id, c]));
  levels.forEach((ids, h) => {
    ids.forEach((id, i) => {
      const pos = ringPosition(i, ids.length, h, radii[h] ?? 0);
      if (h === 0) {
        const c = changeById.get(id) as SymbolChange;
        const side = (c.after ?? c.before) as NonNullable<SymbolChange["after"]>;
        nodes.push({
          id,
          kind: side.kind,
          label: nameOf(id),
          path: side.path,
          size: 1,
          hop: 0,
          change: c.kind,
          signatureChanged: c.signatureChanged,
          ...pos,
        });
        return;
      }
      const sym = id.startsWith("sym:") ? store.getSymbol(id) : undefined;
      nodes.push({
        id,
        kind: sym?.kind ?? (id.startsWith("file:") ? "file" : "function"),
        label: nameOf(id),
        ...(pathOf(id) !== undefined ? { path: pathOf(id) } : {}),
        size: 1,
        hop: h,
        ...pos,
      });
    });
  });

  // Edges from ring h+1 to ring h, as the impact walk found them.
  const edges = new Map<string, GraphEdge>();
  const hop1 = new Map<string, Set<string>>();
  const add = (src: string, dst: string, kind: string, confidence: "high" | "low") => {
    const h = ringOf.get(dst);
    if (h === undefined || ringOf.get(src) !== h + 1) return;
    if (h === 0) {
      const set = hop1.get(dst) ?? new Set<string>();
      hop1.set(dst, set);
      set.add(src);
    }
    const id = `${src}->${dst}`;
    if (!edges.has(id)) edges.set(id, { id, src, dst, kind, weight: 1, confidence });
  };
  for (const [storeId, nodeId] of [...alias.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    for (const e of store.effectiveEdges({ dst: storeId, kind: REVERSE_KINDS }))
      add(e.src, nodeId, e.kind, e.confidence);
  }
  for (const c of changed) {
    if ((c.kind === "removed" || c.kind === "renamed" || c.kind === "moved") && c.before?.exported) {
      for (const e of store.effectiveEdges({ dst: `file:${c.before.path}`, kind: ["imports"] }))
        add(e.src, c.id, "imports", e.confidence);
    }
  }
  for (let h = 1; h < levels.length - 1; h++) {
    for (const id of levels[h] ?? []) {
      const kinds: EdgeKind[] = id.startsWith("file:") ? [...REVERSE_KINDS, "imports"] : REVERSE_KINDS;
      for (const e of store.effectiveEdges({ dst: id, kind: kinds })) add(e.src, id, e.kind, e.confidence);
    }
  }
  const all = [...edges.values()].sort((a, b) => cmp(a.id, b.id));
  return { nodes, edges: all.slice(0, MAX_REVIEW_EDGES), edgesTotal: all.length, hop1 };
}

/** The project map's workspaces and files, with the changed and affected files marked (mode `overlay`). */
function overlay(store: Store, diff: ReviewDiff, impact: Impact): GraphNode[] {
  const changedFiles = new Map<string, string>();
  const rank: Record<string, number> = { removed: 0, modified: 1, moved: 2, renamed: 3, added: 4 };
  for (const c of impact.changed) {
    for (const p of [c.after?.path, c.before?.path]) {
      if (p === undefined) continue;
      const prev = changedFiles.get(p);
      if (prev === undefined || (rank[c.kind] ?? 9) < (rank[prev] ?? 9)) changedFiles.set(p, c.kind);
    }
  }
  for (const f of diff.files) if (!changedFiles.has(f.path)) changedFiles.set(f.path, "modified");
  const affected = new Set<string>();
  for (const h of impact.callersByHop)
    for (const id of h.ids) {
      const p = pathOf(id);
      if (p !== undefined) affected.add(p);
    }
  const workspaces = store.listWorkspaces();
  const labels = shortWorkspaceLabels(workspaces.map((w) => w.name));
  const functions = new Map<string, number>();
  for (const s of store.effectiveSymbols({ kind: ["function", "method", "component", "hook"] }))
    functions.set(s.fileId, (functions.get(s.fileId) ?? 0) + 1);
  const nodes: GraphNode[] = [];
  const wsIds = new Set<string>();
  for (const w of [...workspaces].sort((a, b) => cmp(a.id, b.id))) {
    wsIds.add(w.id);
    nodes.push({
      id: w.id,
      kind: "workspace",
      label: w.name,
      shortLabel: labels.get(w.name) ?? w.name,
      path: w.dir,
      size: 0,
    });
  }
  const sizes = new Map<string, number>();
  for (const f of [...store.effectiveFiles()].sort((a, b) => cmp(a.path, b.path))) {
    const change = changedFiles.get(f.path);
    const mark = change !== undefined ? "changed" : affected.has(f.path) ? "affected" : undefined;
    const size = Math.max(1, functions.get(f.id) ?? 0);
    const parent = f.workspaceId && wsIds.has(f.workspaceId) ? f.workspaceId : undefined;
    if (parent) sizes.set(parent, (sizes.get(parent) ?? 0) + size);
    nodes.push({
      id: f.id,
      kind: "file",
      label: nameOf(f.id),
      path: f.path,
      size,
      ...(parent ? { parent } : {}),
      ...(mark ? { mark } : {}),
      ...(change !== undefined ? { change } : {}),
    });
  }
  for (const n of nodes) if (n.kind === "workspace") n.size = sizes.get(n.id) ?? 0;
  return nodes;
}

/**
 * View 6. Review / blast radius (#44). Params `range` (`<base>...<head>`) or `pr` (a pull request number, resolved
 * with `gh`); without either the view is empty and `review` is null. Runs `reviewDiff` and `reviewImpact` (read-only:
 * git blobs and the index as it is; no re-index) and caches the result per (merge base, head) in memory.
 *
 * Mode `rings` (default, hint `radial`): ring 0 holds the changed symbols (`change` = added, modified, removed,
 * moved, renamed; `signatureChanged`), rings 1 to 3 the callers by hop. Positions are deterministic: radius from
 * the ring's size, angle from the node's index in id order. Edges join a ring to the one inside it. Mode `overlay`:
 * the project map's workspaces and files, with `mark` = changed or affected; the web dims the rest.
 */
export async function buildReview(ctx: ApiContext, params: ViewParams): Promise<ReviewResult> {
  const mode = params.options?.mode === "overlay" ? "overlay" : "rings";
  const refs = resolveRefs(ctx, params);
  if (!refs) return { nodes: [], edges: [], layoutHint: "radial", review: null };
  const { c, cached } = await compute(ctx, refs.base, refs.head);
  const { diff, impact } = c;
  const { store } = ctx;

  const ring = rings(store, impact);
  const perFile = new Map<string, number>();
  for (const ch of impact.changed) {
    const p = (ch.after ?? ch.before)?.path;
    if (p !== undefined) perFile.set(p, (perFile.get(p) ?? 0) + 1);
  }
  const changes: ReviewChangeRow[] = [...impact.changed]
    .sort((a, b) => cmp(a.id, b.id))
    .map((ch) => {
      const side = (ch.after ?? ch.before) as NonNullable<SymbolChange["after"]>;
      const sym =
        store.getSymbol(ch.after?.id ?? ch.id) ?? (ch.before ? store.getSymbol(ch.before.id) : undefined);
      const text = sym ? behaviorOf(store, sym) : null;
      const before = sideOf(ch.before);
      const after = sideOf(ch.after);
      return {
        id: ch.id,
        kind: ch.kind,
        name: nameOf(ch.id),
        symbolKind: side.kind,
        path: side.path,
        line: side.line,
        signatureChanged: ch.signatureChanged,
        exportedChanged: ch.exportedChanged,
        locDelta: ch.locDelta,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        callers: ring.hop1.get(ch.id)?.size ?? 0,
        untrusted_description: text ? text.slice(0, DESCRIPTION_MAX) : null,
      };
    });

  const review: ReviewData = {
    range: `${refs.base}...${refs.head}`,
    ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
    base: refs.base,
    head: refs.head,
    mergeBase: diff.mergeBase,
    headSha: diff.head,
    mode,
    files: diff.files.map((f) => ({ ...f, changes: perFile.get(f.path) ?? 0 })),
    changes,
    callersByHop: impact.callersByHop.map((h) => ({ hop: h.hop, count: h.ids.length })),
    crossings: impact.crossings,
    risk: impact.risk,
    rules: RISK_RULES,
    levels: RISK_LEVELS,
    notes: impact.notes,
    edgesTotal: ring.edgesTotal,
    ms: c.ms,
    cached,
  };
  if (mode === "overlay")
    return { nodes: overlay(store, diff, impact), edges: [], layoutHint: "radial", review };
  return { nodes: ring.nodes, edges: ring.edges, layoutHint: "radial", review };
}

export const reviewView: ViewModule = {
  id: "review",
  title: "Review",
  enabled: true,
  build: (ctx, params) => buildReview(ctx, params),
};

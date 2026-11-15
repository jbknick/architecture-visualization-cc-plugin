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
import type { ApiContext, GraphEdge, GraphNode, ViewParams, ViewResult } from "../types.js";
import { cmp } from "./options.js";

/** Connection lines sent with a review layer; the rest are counted in `layer.linksTotal`. */
export const MAX_REVIEW_LINKS = 2000;
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

/**
 * How a node of the map looks in the review layer. `signature` is a modified symbol whose signature changed; `moved`
 * covers renamed and moved symbols.
 */
export type ReviewMarkKind = "added" | "modified" | "signature" | "moved" | "removed";
/** When several changes land on one node (a file, a folder), the first kind in this list wins. */
export const MARK_ORDER: readonly ReviewMarkKind[] = ["removed", "signature", "moved", "modified", "added"];

export interface ReviewMark {
  /** A node id of the map in the same response. */
  id: string;
  /** Set when the node holds a changed symbol (or is a changed file): the strongest kind under it. */
  change?: ReviewMarkKind;
  /** Changed symbols shown by this node. */
  changes?: number;
  /** Set on nodes without a change that hold a caller: the nearest hop (1 to 3). */
  hop?: number;
}

export interface ReviewLink {
  id: string;
  /** The caller's node, on this map. */
  src: string;
  /** The changed symbol's node, on this map. */
  dst: string;
  /** The change the line points to (its colour). */
  change: ReviewMarkKind;
  /** Direct call, render, hook or import edges between the two nodes. */
  weight: number;
}

/**
 * The review as a layer over a map response: marks by node id and connection lines between the changed symbols'
 * nodes and their direct callers' nodes, both lifted to the map's level (function to function, file to file, folder
 * to folder). The map's own nodes and edges are untouched, so the positions stay the plain map's.
 */
export interface ReviewLayer {
  marks: ReviewMark[];
  links: ReviewLink[];
  /** Links before the cap. */
  linksTotal: number;
  /** Changed symbol ids and changed file ids (`file:<path>`) -> the node that shows them on this map. */
  placed: [string, string][];
  /** Changed symbols with no node on this map (removed with their file, or filtered out): listed only. */
  unplaced: string[];
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
  /** `map` (default): the review as a layer on the project map; `rings`: changed code in the centre, callers by hop. */
  mode: "map" | "rings";
  /** Which map the review view draws on: the 2D project map (default) or the 3D map. */
  map: "2d" | "3d";
  /** Rings mode: edges between rings before the cap. */
  edgesTotal?: number;
  files: (ReviewFile & { changes: number })[];
  changes: ReviewChangeRow[];
  callersByHop: { hop: number; count: number }[];
  crossings: Crossing[];
  risk: Risk;
  rules: readonly RiskRule[];
  levels: typeof RISK_LEVELS;
  notes: string[];
  /** The review drawn on the map this response holds. */
  layer: ReviewLayer;
  /** Wall time of the diff and impact when they were computed (a cached answer repeats it). */
  ms: number;
  cached: boolean;
}

export interface ReviewResult extends ViewResult {
  /** Null when the view has neither `range` nor `pr`: the web asks for one. */
  review: ReviewData | null;
}

/** One direct edge into a changed symbol: `src` is a store id, `dst` the change's id. */
interface DirectEdge {
  src: string;
  dst: string;
}

interface Computed {
  /** Run on the commits: `base` is the merge base sha and `head` the head sha. */
  diff: ReviewDiff;
  impact: Impact;
  /** Direct edges into the changed symbols, sorted (see `directEdges`). */
  direct: DirectEdge[];
  ms: number;
  /** The index state the impact was computed on (see `indexMarker`); any index write invalidates the entry. */
  marker: string;
}

/** Per process: (data dir, merge base, head) -> computed review. Small LRU, newest last. */
const cache = new Map<string, Computed>();

/** `pr` -> resolved refs, so a view request does not run `gh pr view` (and maybe `git fetch`) every time. */
const prCache = new Map<string, { refs: { base: string; head: string }; at: number }>();
/** How long a resolved pull request is reused. A push to the PR shows after this long, or after Refresh. */
export const PR_CACHE_MS = 60_000;

export function clearReviewCache(): void {
  cache.clear();
  prCache.clear();
}

/**
 * Changes whenever the index changes: `head_sha` (heal) plus `store.generation()`, which counts graph writes made
 * through this store and moves with SQLite's `data_version` on every commit by another connection (the hooks and the
 * MCP server re-index working edits from other processes). A write that does not touch the graph only costs a
 * recompute.
 */
function indexMarker(store: ApiContext["store"]): string {
  return `${store.getMeta("head_sha") ?? ""}\0${store.generation()}`;
}

/**
 * Resolves `pr` through `gh`, reusing an answer younger than PR_CACHE_MS. `resolvePullRequest` is synchronous, so
 * two requests can never run a lookup at the same time in this single-threaded server: one lookup per PR at a time.
 */
function resolvePr(ctx: ApiContext, n: number): { base: string; head: string } {
  const key = `${ctx.paths.dataDir}\0${n}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < PR_CACHE_MS) return hit.refs;
  const refs = resolvePullRequest(ctx.paths, n);
  prCache.set(key, { refs, at: Date.now() });
  return refs;
}

const nameOf = (id: string): string => {
  if (id.startsWith("sym:")) return id.slice(id.lastIndexOf("#") + 1);
  if (id.startsWith("file:")) return id.slice(id.lastIndexOf("/") + 1);
  return id;
};
const pathOf = (id: string): string | undefined =>
  id.startsWith("sym:") ? id.slice(4, id.lastIndexOf("#")) : id.startsWith("file:") ? id.slice(5) : undefined;

/** True when the view options ask for a review (`range` or `pr`). */
export function wantsReview(params: ViewParams): boolean {
  const r = params.options?.range;
  const p = params.options?.pr;
  if (typeof r === "string" && r.trim() !== "") return true;
  return typeof p === "number" || (typeof p === "string" && p.trim() !== "");
}

/** `map=3d` in the view options. */
export function reviewMapOf(params: ViewParams): "2d" | "3d" {
  return params.options?.map === "3d" ? "3d" : "2d";
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
    return { ...resolvePr(ctx, n), pr: n };
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

/** Store ids a changed symbol is known by (a rename or move is known by both), mapped to the change's id. */
function aliases(impact: Impact): [string, string][] {
  const alias = new Map<string, string>();
  for (const c of [...impact.changed].sort((a, b) => cmp(a.id, b.id))) {
    for (const id of [c.after?.id, c.before?.id]) if (id !== undefined && !alias.has(id)) alias.set(id, c.id);
  }
  return [...alias.entries()].sort((a, b) => cmp(a[0], b[0]));
}

/**
 * The direct edges into every changed symbol, as the impact walk's first hop sees them: calls, renders and hook uses
 * of either id of the change, and imports of a removed (or renamed, or moved) export's file. Sorted and unique.
 */
function directEdges(store: Store, impact: Impact): DirectEdge[] {
  const out = new Map<string, DirectEdge>();
  const add = (src: string, dst: string) => {
    if (src === dst) return;
    const key = `${src}\0${dst}`;
    if (!out.has(key)) out.set(key, { src, dst });
  };
  for (const [storeId, changeId] of aliases(impact)) {
    for (const e of store.effectiveEdges({ dst: storeId, kind: REVERSE_KINDS })) add(e.src, changeId);
  }
  for (const c of impact.changed) {
    if ((c.kind === "removed" || c.kind === "renamed" || c.kind === "moved") && c.before?.exported) {
      for (const e of store.effectiveEdges({ dst: `file:${c.before.path}`, kind: ["imports"] }))
        add(e.src, c.id);
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst));
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
  const marker = indexMarker(ctx.store);
  const hit = cache.get(key);
  if (hit && hit.marker === marker) {
    cache.delete(key);
    cache.set(key, hit);
    return { c: hit, cached: true };
  }
  const t0 = Date.now();
  // The commits, not the names: a branch that moves between the key and the diff must not mix two heads.
  const diff = await reviewDiff(ctx.paths, commits.mergeBase, commits.head);
  const impact = await reviewImpact(ctx.paths, ctx.store, diff);
  const c: Computed = { diff, impact, direct: directEdges(ctx.store, impact), ms: Date.now() - t0, marker };
  cache.set(key, c);
  while (cache.size > REVIEW_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return { c, cached: false };
}

const sideOf = (s: SymbolChange["before"]): ReviewSide | undefined =>
  s ? { id: s.id, path: s.path, line: s.line, signature: s.signature, exported: s.exported } : undefined;

/** The layer colour of one change. */
export function markKindOf(c: Pick<SymbolChange, "kind" | "signatureChanged">): ReviewMarkKind {
  if (c.kind === "added" || c.kind === "removed") return c.kind;
  if (c.kind === "renamed" || c.kind === "moved") return "moved";
  return c.signatureChanged ? "signature" : "modified";
}

const FILE_MARK: Record<ReviewFile["status"], ReviewMarkKind> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "moved",
};

const stronger = (a: ReviewMarkKind | undefined, b: ReviewMarkKind): ReviewMarkKind =>
  a === undefined || MARK_ORDER.indexOf(b) < MARK_ORDER.indexOf(a) ? b : a;

/** Where a map puts store ids: the deepest node of the response that shows `id`, and the containment between nodes. */
export interface MapPlacement {
  rep(id: string): string | undefined;
  /** True when node `a` contains node `b` (a folder holds a file). Links between such nodes are not drawn. */
  contains(a: string, b: string): boolean;
}

/** The node that shows a changed symbol: either side's id, else either side's file (a removed symbol's file). */
function placeChange(c: SymbolChange, place: MapPlacement): string | undefined {
  for (const id of [c.after?.id, c.before?.id, c.id]) {
    const r = id === undefined ? undefined : place.rep(id);
    if (r !== undefined) return r;
  }
  for (const p of [c.after?.path, c.before?.path]) {
    const r = p === undefined ? undefined : place.rep(`file:${p}`);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * The review layer of a map: every changed symbol and changed file marked on the node that shows it (the strongest
 * kind wins on a shared node), callers marked by their nearest hop where nothing changed, and one line per pair of
 * nodes joined by a direct edge into a changed symbol. Deterministic: everything is sorted by id.
 */
function buildLayer(c: Computed, place: MapPlacement): ReviewLayer {
  const { diff, impact } = c;
  const marks = new Map<string, ReviewMark>();
  const markOf = (id: string): ReviewMark => {
    let m = marks.get(id);
    if (!m) {
      m = { id };
      marks.set(id, m);
    }
    return m;
  };
  const placed = new Map<string, string>();
  const unplaced: string[] = [];
  const kindOfChange = new Map<string, ReviewMarkKind>();
  const nodeOfChange = new Map<string, string>();
  for (const ch of [...impact.changed].sort((a, b) => cmp(a.id, b.id))) {
    const k = markKindOf(ch);
    kindOfChange.set(ch.id, k);
    const node = placeChange(ch, place);
    if (node === undefined) {
      unplaced.push(ch.id);
      continue;
    }
    nodeOfChange.set(ch.id, node);
    placed.set(ch.id, node);
    const m = markOf(node);
    m.change = stronger(m.change, k);
    m.changes = (m.changes ?? 0) + 1;
  }
  for (const f of diff.files) {
    const id = `file:${f.path}`;
    const node = place.rep(id);
    if (node === undefined) continue;
    if (!placed.has(id)) placed.set(id, node);
    // A file with only non-symbol edits (imports, top-level code) still counts as changed.
    const m = markOf(node);
    if (m.change === undefined) m.change = FILE_MARK[f.status];
  }
  for (const h of impact.callersByHop) {
    for (const id of h.ids) {
      const node = place.rep(id) ?? (pathOf(id) !== undefined ? place.rep(`file:${pathOf(id)}`) : undefined);
      if (node === undefined) continue;
      const m = markOf(node);
      if (m.change !== undefined) continue;
      m.hop = Math.min(m.hop ?? h.hop, h.hop);
    }
  }

  const links = new Map<string, ReviewLink>();
  for (const e of c.direct) {
    const dst = nodeOfChange.get(e.dst);
    const kind = kindOfChange.get(e.dst);
    const src =
      place.rep(e.src) ?? (pathOf(e.src) !== undefined ? place.rep(`file:${pathOf(e.src)}`) : undefined);
    if (dst === undefined || src === undefined || kind === undefined || src === dst) continue;
    if (place.contains(src, dst) || place.contains(dst, src)) continue;
    const id = `${src}->${dst}`;
    const l = links.get(id);
    if (l) {
      l.weight += 1;
      l.change = stronger(l.change, kind);
    } else links.set(id, { id, src, dst, change: kind, weight: 1 });
  }
  const allLinks = [...links.values()].sort((a, b) => cmp(a.id, b.id));
  return {
    marks: [...marks.values()].sort((a, b) => cmp(a.id, b.id)),
    links: allLinks.slice(0, MAX_REVIEW_LINKS),
    linksTotal: allLinks.length,
    placed: [...placed.entries()].sort((a, b) => cmp(a[0], b[0])),
    unplaced,
  };
}

/**
 * The review of `range` or `pr` drawn on a map: the diff, impact and risk for the left panel and the inspector, plus
 * the layer placed with `place`. Null when the options name neither. Runs `reviewDiff` and `reviewImpact` (read-only:
 * git blobs and the index as it is; no re-index) and caches the result per (merge base, head) in memory.
 */
export async function reviewFor(
  ctx: ApiContext,
  params: ViewParams,
  place: MapPlacement,
): Promise<ReviewData | null> {
  const refs = resolveRefs(ctx, params);
  if (!refs) return null;
  const { c, cached } = await compute(ctx, refs.base, refs.head);
  return dataOf(ctx, params, refs, c, cached, place, "map");
}

/**
 * Mode `rings`: the changed symbols in the centre and their callers on rings by hop, grouped by file on each ring
 * (see `ringLayout`), with the review data. Null when the options name neither `range` nor `pr`.
 */
export async function reviewRings(
  ctx: ApiContext,
  params: ViewParams,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; review: ReviewData } | null> {
  const refs = resolveRefs(ctx, params);
  if (!refs) return null;
  const { c, cached } = await compute(ctx, refs.base, refs.head);
  const ring = ringLayout(ctx.store, c);
  const ids = new Set(ring.nodes.map((n) => n.id));
  const place: MapPlacement = { rep: (id) => (ids.has(id) ? id : undefined), contains: () => false };
  const review = dataOf(ctx, params, refs, c, cached, place, "rings");
  review.edgesTotal = ring.edgesTotal;
  return { nodes: ring.nodes, edges: ring.edges, review };
}

// ---- Rings -------------------------------------------------------------------------------------------------------

/** Ring spacing in layout units (the canvas scales to fit). */
export const RING_GAP = 150;
/** Room per node along a ring (an empty slot separates two file groups). */
export const MIN_ARC = 30;
const INNER_MIN = 70;
/** Edges drawn between rings; the rest are counted in `review.edgesTotal`. */
export const MAX_RING_EDGES = 2000;
const round = (n: number): number => Math.round(n * 10) / 10;

/** Radius of each ring for `slots[h]` slots: at least RING_GAP apart, wide enough for MIN_ARC per slot. */
export function ringRadii(slots: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  slots.forEach((n, h) => {
    const fit = (n * MIN_ARC) / (2 * Math.PI);
    const r = h === 0 ? (n <= 1 ? 0 : Math.max(INNER_MIN, fit)) : Math.max(prev + RING_GAP, fit);
    out.push(round(r));
    prev = r;
  });
  return out;
}

/**
 * Deterministic position of slot `i` of `n` on ring `h`, clockwise from the top. No node sits exactly at the top
 * (where the ring's label is): even rings start half a step in, odd rings a quarter step.
 */
export function ringPosition(i: number, n: number, h: number, radius: number): { x: number; y: number } {
  if (radius === 0) return { x: 0, y: 0 };
  const a = -Math.PI / 2 + (2 * Math.PI * (i + (h % 2 === 0 ? 0.5 : 0.25))) / Math.max(1, n);
  return { x: round(radius * Math.cos(a)), y: round(radius * Math.sin(a)) };
}

/**
 * Slots of one ring: the ids grouped by file (`group`), groups in path order, ids in id order inside a group, and
 * one empty slot between two groups so a group reads as a cluster.
 */
export function ringSlots(items: readonly { id: string; group: string }[]): {
  slots: number;
  at: Map<string, number>;
} {
  const sorted = [...items].sort((a, b) => cmp(a.group, b.group) || cmp(a.id, b.id));
  const at = new Map<string, number>();
  let slot = 0;
  let last: string | undefined;
  for (const it of sorted) {
    if (last !== undefined && it.group !== last) slot += 1;
    at.set(it.id, slot);
    slot += 1;
    last = it.group;
  }
  const groups = new Set(sorted.map((x) => x.group)).size;
  // The gap after the last group closes the circle (only when there are two groups or more).
  return { slots: slot + (groups > 1 ? 1 : 0), at };
}

/** Ring nodes (`hop`, `group` = file path, `change` on ring 0) and the edges from ring h + 1 to ring h. */
function ringLayout(
  store: Store,
  c: Computed,
): { nodes: GraphNode[]; edges: GraphEdge[]; edgesTotal: number } {
  const { impact } = c;
  const changed = [...impact.changed].sort((a, b) => cmp(a.id, b.id));
  const ringOf = new Map<string, number>();
  for (const ch of changed) ringOf.set(ch.id, 0);
  const levels: string[][] = [changed.map((ch) => ch.id)];
  for (const h of impact.callersByHop) {
    levels[h.hop] = [...h.ids].sort(cmp);
    for (const id of h.ids) ringOf.set(id, h.hop);
  }
  for (let h = 0; h < levels.length; h++) levels[h] ??= [];
  const changeById = new Map(changed.map((ch) => [ch.id, ch]));
  const groupOf = (id: string): string => {
    const ch = changeById.get(id);
    if (ch) return (ch.after ?? ch.before)?.path ?? "";
    return pathOf(id) ?? "";
  };
  const layouts = levels.map((ids) => ringSlots(ids.map((id) => ({ id, group: groupOf(id) }))));
  const radii = ringRadii(layouts.map((l) => l.slots));

  const nodes: GraphNode[] = [];
  levels.forEach((ids, h) => {
    const lay = layouts[h] as ReturnType<typeof ringSlots>;
    for (const id of ids) {
      const pos = ringPosition(lay.at.get(id) ?? 0, lay.slots, h, radii[h] ?? 0);
      const ch = changeById.get(id);
      if (ch) {
        const side = (ch.after ?? ch.before) as NonNullable<SymbolChange["after"]>;
        nodes.push({
          id,
          kind: side.kind,
          label: nameOf(id),
          path: side.path,
          group: side.path,
          size: 1,
          hop: 0,
          change: ch.kind,
          signatureChanged: ch.signatureChanged,
          ...pos,
        });
        continue;
      }
      const sym = id.startsWith("sym:") ? store.getSymbol(id) : undefined;
      const path = pathOf(id);
      nodes.push({
        id,
        kind: sym?.kind ?? (id.startsWith("file:") ? "file" : "function"),
        label: nameOf(id),
        ...(path !== undefined ? { path, group: path } : {}),
        size: 1,
        hop: h,
        ...pos,
      });
    }
  });
  nodes.sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0) || cmp(a.id, b.id));

  // Edges from ring h + 1 (the caller) to ring h (the code it calls), as the impact walk found them.
  const edges = new Map<string, GraphEdge>();
  const add = (src: string, dst: string, kind: string, confidence: "high" | "low") => {
    const h = ringOf.get(dst);
    if (h === undefined || ringOf.get(src) !== h + 1) return;
    const id = `${src}->${dst}`;
    if (!edges.has(id)) edges.set(id, { id, src, dst, kind, weight: 1, confidence });
  };
  for (const e of c.direct) add(e.src, e.dst, "calls", "high");
  for (let h = 1; h < levels.length - 1; h++) {
    for (const id of levels[h] ?? []) {
      const kinds: EdgeKind[] = id.startsWith("file:") ? [...REVERSE_KINDS, "imports"] : REVERSE_KINDS;
      for (const e of store.effectiveEdges({ dst: id, kind: kinds })) add(e.src, id, e.kind, e.confidence);
    }
  }
  const all = [...edges.values()].sort((a, b) => cmp(a.id, b.id));
  return { nodes, edges: all.slice(0, MAX_RING_EDGES), edgesTotal: all.length };
}

function dataOf(
  ctx: ApiContext,
  params: ViewParams,
  refs: { base: string; head: string; pr?: number },
  c: Computed,
  cached: boolean,
  place: MapPlacement,
  mode: "map" | "rings",
): ReviewData {
  const { diff, impact } = c;
  const { store } = ctx;

  const direct = new Map<string, Set<string>>();
  for (const e of c.direct) {
    const set = direct.get(e.dst) ?? new Set<string>();
    direct.set(e.dst, set);
    set.add(e.src);
  }
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
        callers: direct.get(ch.id)?.size ?? 0,
        untrusted_description: text ? text.slice(0, DESCRIPTION_MAX) : null,
      };
    });

  return {
    range: `${refs.base}...${refs.head}`,
    ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
    base: refs.base,
    head: refs.head,
    mergeBase: diff.mergeBase,
    headSha: diff.head,
    mode,
    map: reviewMapOf(params),
    files: diff.files.map((f) => ({ ...f, changes: perFile.get(f.path) ?? 0 })),
    changes,
    callersByHop: impact.callersByHop.map((h) => ({ hop: h.hop, count: h.ids.length })),
    crossings: impact.crossings,
    risk: impact.risk,
    rules: RISK_RULES,
    levels: RISK_LEVELS,
    notes: impact.notes,
    layer: buildLayer(c, place),
    ms: c.ms,
    cached,
  };
}

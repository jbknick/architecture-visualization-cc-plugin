import { isFileId, isSymId, fileId as makeFileId, parseId, pathOfFileId, pathOfId } from "../ids.js";
import type { Store } from "../store/index.js";
import type { EdgeKind, WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import type { SymbolChange } from "./diff.js";
import { type DirectUse, type ReachRow, walkToEnd } from "./reachable.js";

/**
 * Consumers of a review's changes (#169): for every changed symbol and changed file, everything that uses it.
 * "Directly affected" are the hop-1 consumers (they use the changed item itself); "potentially affected" are the
 * consumers of those, out to hop 3, each with the direct consumer it reaches the change through. A third tier,
 * "reachable" (#293), holds everything further out up to a node cap, ranked by hop, path confidence and fan-in.
 * Read-only and deterministic; `computeImpact` builds on the same walk, so the CLI, the MCP tool and the explorer agree.
 */

/** How a consumer uses what it points at: the edge kind, or `imports` for a file that imports the changed file. */
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

/** Edge kinds that make their source a consumer of their target (route edges where an adapter indexed them). */
export const CONSUMER_KINDS: readonly EdgeKind[] = [
  "calls",
  "renders",
  "uses_hook",
  "extends",
  "implements",
  "references_type",
  "serves",
  "handles",
  "requests",
];

/** Entries kept per tier and change; `directTotal` and `potentialTotal` count them all. */
export const MAX_CONSUMERS = 200;
/** The walk behind one change's potential consumers stops after this many nodes. */
export const MAX_CONSUMER_WALK = 500;
/** The walk to the end stops at this many nodes (all hops counted). Fitted by `docs/spikes/blast-depth.md`, "Decisions" (`node_cap`). */
export const REACHABLE_NODE_CAP = 2500;
/** Inside a hop and a path confidence, the node with more consumers ranks first. `docs/spikes/blast-depth.md`, "Decisions" (`fan_in_order`). */
export const FAN_IN_ORDER: "desc" | "asc" = "desc";
/** The reachable tier starts after the hops of the directly and potentially affected tiers. */
export const REACHABLE_FIRST_HOP = 4;

export type CrossingKind = "workspace" | "app" | "client_server";

export interface Consumer {
  /** Store id: `sym:...`, `file:...` or an adapter node such as `route:...`. */
  id: string;
  name: string;
  /** Symbol kind, `file`, or the adapter node's kind (`route`). */
  kind: string;
  path: string;
  /** Start line of a symbol; null for a file or an adapter node. */
  line: number | null;
  /** Workspace name, or null outside every workspace. */
  workspace: string | null;
  /** 1 for a direct consumer, 2 or 3 for a potential one. */
  hop: number;
  /** Edge kinds from this consumer to the changed item (direct) or to `next` (potential), sorted. */
  uses: UseKind[];
  /** Boundaries between this consumer and the changed item, sorted (the crossing rules of `computeImpact`). */
  crosses: CrossingKind[];
  /** Potential only: the direct consumer it reaches the change through. */
  via?: string;
  /** Potential and reachable only: the node it uses, one step nearer the change. */
  next?: string;
  /** Reachable only: `high` when some path of hop-many edges to the change has only `high` edges, else `low`. */
  pathConfidence?: "high" | "low";
  /** Reachable only: the number of distinct nodes that use this one. */
  fanIn?: number;
}

export interface ChangeConsumers {
  /** The change's id (a symbol change) or `file:<path>` (a changed file). */
  id: string;
  target: "symbol" | "file";
  /** Directly affected: hop-1 consumers, sorted by workspace, path, name, id; at most MAX_CONSUMERS. */
  direct: Consumer[];
  directTotal: number;
  /** Potentially affected: hops 2 to 3 out from the direct ones, same order and cap. */
  potential: Consumer[];
  potentialTotal: number;
  /**
   * Reachable (#293): everything else the change can reach, hop 4 and later, ranked by `compareReachable`; at most
   * `MAX_CONSUMERS` per hop, so a wide hop cannot hide the hops after it. `reachableTotal` counts them all, up to
   * the node cap (`REACHABLE_NODE_CAP`).
   */
  reachable: Consumer[];
  reachableTotal: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const RENAMED_OR_GONE = new Set(["removed", "renamed", "moved"]);

export interface Neighbour {
  src: string;
  kind: UseKind;
  fileId: string;
  confidence: "high" | "low";
}

/** Memoised graph reads for one review: every lookup is asked at most once per call of `computeImpact`. */
export class ConsumerGraph {
  private readonly incomingCache = new Map<string, Neighbour[]>();
  private readonly infoCache = new Map<string, Omit<Consumer, "hop" | "uses" | "crosses">>();
  private readonly pathCache = new Map<string, string>();
  private readonly fanInCache = new Map<string, number>();
  private readonly workspaces: WorkspaceRecord[];
  /** Every consumer edge by destination, once `preload` has read them (one store query for the whole walk). */
  private adjacency: Map<string, Neighbour[]> | undefined;

  constructor(readonly store: Store) {
    this.workspaces = store.listWorkspaces();
  }

  /**
   * Reads every consumer edge (`CONSUMER_KINDS`, and `imports` into a file node) with one store query, so that
   * `incoming` answers from memory. A per-node `effectiveEdges` call rebuilds the effective-files view each time
   * (79 ms on a 25,000-file repo), which makes a walk over thousands of nodes take minutes. The answers are the same
   * ones, in the same order (source, then kind), as the per-node query gives.
   */
  preload(): void {
    if (this.adjacency) return;
    const byDst = new Map<string, Neighbour[]>();
    for (const e of this.store.effectiveEdges({ kind: [...CONSUMER_KINDS, "imports"] })) {
      if (e.src.startsWith("ext:") || e.src === e.dst) continue;
      if (e.kind === "imports" && !isFileId(e.dst)) continue;
      const n: Neighbour = {
        src: e.src,
        kind: e.kind as UseKind,
        fileId: e.fileId,
        confidence: e.confidence,
      };
      const list = byDst.get(e.dst);
      if (list) list.push(n);
      else byDst.set(e.dst, [n]);
    }
    this.adjacency = byDst;
  }

  /** Sources of incoming consumer edges (and `imports` for a file node), without externals and self-loops. */
  incoming(node: string): Neighbour[] {
    let hit = this.incomingCache.get(node);
    if (hit) return hit;
    if (this.adjacency) hit = this.adjacency.get(node) ?? [];
    else {
      const kinds: EdgeKind[] = isFileId(node) ? [...CONSUMER_KINDS, "imports"] : [...CONSUMER_KINDS];
      hit = this.store
        .effectiveEdges({ dst: node, kind: kinds })
        .filter((e) => !e.src.startsWith("ext:") && e.src !== node)
        .map((e) => ({ src: e.src, kind: e.kind as UseKind, fileId: e.fileId, confidence: e.confidence }));
    }
    for (const n of hit) if (!this.pathCache.has(n.src)) this.pathCache.set(n.src, pathOfFileId(n.fileId));
    this.incomingCache.set(node, hit);
    return hit;
  }

  /** The number of distinct nodes that use `node` (the sources of `incoming`). */
  fanIn(node: string): number {
    let hit = this.fanInCache.get(node);
    if (hit === undefined) {
      hit = new Set(this.incoming(node).map((n) => n.src)).size;
      this.fanInCache.set(node, hit);
    }
    return hit;
  }

  /** The file path of a node id (a symbol's file, a file, or the file an adapter node was found in). */
  pathOf(id: string): string {
    const own = pathOfId(id);
    if (own !== undefined) return own;
    return this.pathCache.get(id) ?? "";
  }

  /** The id of the file at repo-relative `path`. */
  fileId(path: string): string {
    return makeFileId(this.store.repo(), path);
  }

  workspaceOf(path: string): WorkspaceRecord | undefined {
    return this.workspaces.length > 0 && path !== "" ? workspaceForPath(this.workspaces, path) : undefined;
  }

  isClient(path: string): boolean {
    return this.store.effectiveFile(this.fileId(path))?.directives?.includes("use client") ?? false;
  }

  /** Crossing kinds between a consumer at `consumerPath` and the changed item at `changedPath`. */
  crossings(changedPath: string, consumerPath: string): CrossingKind[] {
    if (changedPath === consumerPath || changedPath === "" || consumerPath === "") return [];
    const out: CrossingKind[] = [];
    const sw = this.workspaceOf(changedPath);
    const cw = this.workspaceOf(consumerPath);
    if (sw && cw && sw.id !== cw.id)
      out.push(cw.kind === "app" && sw.kind === "package" ? "app" : "workspace");
    if (this.isClient(changedPath) !== this.isClient(consumerPath)) out.push("client_server");
    return out.sort(cmp);
  }

  info(id: string): Omit<Consumer, "hop" | "uses" | "crosses"> {
    let hit = this.infoCache.get(id);
    if (hit) return hit;
    const path = this.pathOf(id);
    const ws = this.workspaceOf(path)?.name ?? null;
    if (isSymId(id)) {
      const s = this.store.getSymbol(id);
      hit = {
        id,
        name: s?.name ?? id.slice(id.lastIndexOf("#") + 1),
        kind: s?.kind ?? "function",
        path,
        line: s?.startLine ?? null,
        workspace: ws,
      };
    } else if (isFileId(id)) {
      hit = {
        id,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: "file",
        path,
        line: null,
        workspace: ws,
      };
    } else {
      const colon = id.indexOf(":");
      const parsed = parseId(id);
      const label = (parsed?.ws !== undefined ? parsed.rest : "") || id;
      hit = {
        id,
        name: label,
        kind: colon > 0 ? id.slice(0, colon) : "node",
        path,
        line: null,
        workspace: ws,
      };
    }
    this.infoCache.set(id, hit);
    return hit;
  }
}

/** Sort order of both tiers: workspace (none last), path, name, id. */
export function compareConsumers(
  a: Pick<Consumer, "workspace" | "path" | "name" | "id">,
  b: Pick<Consumer, "workspace" | "path" | "name" | "id">,
): number {
  const wa = a.workspace ?? "￿";
  const wb = b.workspace ?? "￿";
  return cmp(wa, wb) || cmp(a.path, b.path) || cmp(a.name, b.name) || cmp(a.id, b.id);
}

/** Direct consumers of one changed symbol: id -> use kinds and whether some edge to the change is `high`. */
function directDetailOfSymbol(g: ConsumerGraph, c: SymbolChange): Map<string, DirectUse> {
  const ids = [c.after?.id, c.before?.id].filter((x): x is string => x !== undefined);
  const own = new Set(ids);
  const out = new Map<string, DirectUse>();
  const add = (n: Neighbour, kind: UseKind) => {
    if (own.has(n.src)) return;
    const use = out.get(n.src) ?? { uses: new Set<UseKind>(), high: false };
    use.uses.add(kind);
    if (n.confidence === "high" || kind === "imports") use.high = true;
    out.set(n.src, use);
  };
  for (const id of ids) for (const n of g.incoming(id)) add(n, n.kind);
  // A file that imports the file of an exported change uses it too, unless one of its symbols already does (then
  // the index can tell which code uses it). A removed, renamed or moved export breaks every such importer.
  const gone = RENAMED_OR_GONE.has(c.kind);
  const file = gone ? c.before?.path : c.after?.path;
  const exported = gone
    ? (c.before?.exported ?? false)
    : (c.after?.exported ?? false) || (c.before?.exported ?? false);
  if (c.kind !== "added" && exported && file !== undefined) {
    const usedFrom = new Set([...out.keys()].map((id) => g.pathOf(id)));
    for (const n of g.incoming(g.fileId(file))) {
      if (n.kind !== "imports" || !isFileId(n.src) || usedFrom.has(g.pathOf(n.src))) continue;
      add(n, "imports");
    }
  }
  return out;
}

/** Direct consumers of a changed file: the files that import it. */
function directDetailOfFile(g: ConsumerGraph, path: string): Map<string, DirectUse> {
  const out = new Map<string, DirectUse>();
  for (const n of g.incoming(g.fileId(path))) {
    if (n.kind !== "imports") continue;
    out.set(n.src, { uses: new Set<UseKind>(["imports"]), high: true });
  }
  return out;
}

const kindsOf = (m: Map<string, DirectUse>): Map<string, Set<UseKind>> =>
  new Map([...m].map(([id, d]) => [id, d.uses]));

/**
 * Breadth-first from the direct consumers, hops 2 to `maxHops`, over the consumer edge kinds (a file also through
 * the files that import it). Each node is kept at its first hop with the first `next` (sorted) that reached it.
 */
function potentialFrom(
  g: ConsumerGraph,
  direct: string[],
  exclude: Set<string>,
  maxHops: number,
): { rows: { id: string; hop: number; next: string; via: string; uses: Set<UseKind> }[]; stopped: boolean } {
  const via = new Map<string, string>(direct.map((d) => [d, d]));
  const seen = new Set<string>([...exclude, ...direct]);
  const out: { id: string; hop: number; next: string; via: string; uses: Set<UseKind> }[] = [];
  const byId = new Map<string, (typeof out)[number]>();
  let frontier = [...direct].sort(cmp);
  for (let hop = 2; hop <= maxHops && frontier.length > 0; hop++) {
    const found: string[] = [];
    for (const node of frontier) {
      for (const n of g.incoming(node)) {
        const prior = byId.get(n.src);
        if (prior && prior.hop === hop && prior.next === node) {
          prior.uses.add(n.kind);
          continue;
        }
        if (seen.has(n.src)) continue;
        if (seen.size >= MAX_CONSUMER_WALK + exclude.size + direct.length)
          return { rows: out, stopped: true };
        seen.add(n.src);
        const entry = { id: n.src, hop, next: node, via: via.get(node) ?? node, uses: new Set([n.kind]) };
        via.set(n.src, entry.via);
        byId.set(n.src, entry);
        out.push(entry);
        found.push(n.src);
      }
    }
    frontier = found.sort(cmp);
  }
  return { rows: out, stopped: false };
}

function tierOf(
  g: ConsumerGraph,
  changedPath: string,
  rows: { id: string; hop: number; uses: Set<UseKind>; via?: string; next?: string }[],
): { list: Consumer[]; total: number } {
  const all = rows
    .map((r): Consumer => {
      const info = g.info(r.id);
      return {
        ...info,
        hop: r.hop,
        uses: [...r.uses].sort(cmp),
        crosses: g.crossings(changedPath, info.path),
        ...(r.via !== undefined ? { via: r.via } : {}),
        ...(r.next !== undefined ? { next: r.next } : {}),
      };
    })
    .sort(compareConsumers);
  return { list: all.slice(0, MAX_CONSUMERS), total: all.length };
}

/** Rank inside the reachable tier: hop, `high` path confidence first, fan-in (`FAN_IN_ORDER`), then `compareConsumers`. */
export function compareReachable(a: Consumer, b: Consumer): number {
  if (a.hop !== b.hop) return a.hop - b.hop;
  if (a.pathConfidence !== b.pathConfidence) return a.pathConfidence === "high" ? -1 : 1;
  const fa = a.fanIn ?? 0;
  const fb = b.fanIn ?? 0;
  if (fa !== fb) return FAN_IN_ORDER === "desc" ? fb - fa : fa - fb;
  return compareConsumers(a, b);
}

/** The reachable tier of one walk (hop 4 and later), ranked, at most `MAX_CONSUMERS` per hop; `total` counts all. */
export function reachableTier(
  g: ConsumerGraph,
  changedPath: string,
  rows: readonly ReachRow[],
): { list: Consumer[]; total: number } {
  const ranked = rows
    .filter((r) => r.hop >= REACHABLE_FIRST_HOP)
    .map((r): Consumer => {
      const info = g.info(r.id);
      return {
        ...info,
        hop: r.hop,
        uses: [...r.uses].sort(cmp),
        crosses: g.crossings(changedPath, info.path),
        via: r.via,
        next: r.next,
        pathConfidence: r.high ? "high" : "low",
        fanIn: g.fanIn(r.id),
      };
    })
    .sort(compareReachable);
  const perHop = new Map<number, number>();
  const list = ranked.filter((c) => {
    const n = perHop.get(c.hop) ?? 0;
    perHop.set(c.hop, n + 1);
    return n < MAX_CONSUMERS;
  });
  return { list, total: ranked.length };
}

function build(
  g: ConsumerGraph,
  id: string,
  target: ChangeConsumers["target"],
  changedPath: string,
  own: string[],
  detail: Map<string, DirectUse>,
  maxHops: number,
  reachableCap: number | null,
): ChangeConsumers {
  const direct = kindsOf(detail);
  const directIds = [...direct.keys()].sort(cmp);
  const d = tierOf(
    g,
    changedPath,
    directIds.map((x) => ({ id: x, hop: 1, uses: direct.get(x) ?? new Set() })),
  );
  const pot = potentialFrom(g, directIds, new Set(own), maxHops);
  const p = tierOf(g, changedPath, pot.rows);
  // Past hop 3 the walk goes on unless the 500-node stop of the potential tier was hit.
  const r =
    reachableCap !== null && !pot.stopped
      ? reachableTier(g, changedPath, walkToEnd(g, detail, new Set(own), reachableCap).rows)
      : { list: [], total: 0 };
  return {
    id,
    target,
    direct: d.list,
    directTotal: d.total,
    potential: p.list,
    potentialTotal: p.total,
    reachable: r.list,
    reachableTotal: r.total,
  };
}

/** The full direct consumer map of a changed symbol (uncapped), for the impact walk and the risk facts. */
export function directConsumers(g: ConsumerGraph, c: SymbolChange): Map<string, Set<UseKind>> {
  return kindsOf(directDetailOfSymbol(g, c));
}

/** `directConsumers` with whether some edge into the change is `high`, which starts the path confidence. */
export function directConsumerUses(g: ConsumerGraph, c: SymbolChange): Map<string, DirectUse> {
  return directDetailOfSymbol(g, c);
}

/**
 * The tiers for every changed symbol (added ones too: code that already uses a new name is rare but real) and every
 * changed file, symbols first (by id), then files (by path). `reachableCap` null leaves the reachable tier empty and
 * every read per node, as before the tier existed.
 */
export function computeConsumers(
  g: ConsumerGraph,
  changes: SymbolChange[],
  files: string[],
  maxHops: number,
  reachableCap: number | null = REACHABLE_NODE_CAP,
): ChangeConsumers[] {
  const out: ChangeConsumers[] = [];
  for (const c of [...changes].sort((a, b) => cmp(a.id, b.id))) {
    const own = [c.after?.id, c.before?.id, c.id].filter((x): x is string => x !== undefined);
    const path = (c.after ?? c.before)?.path ?? g.pathOf(c.id);
    out.push(build(g, c.id, "symbol", path, own, directDetailOfSymbol(g, c), maxHops, reachableCap));
  }
  for (const p of [...new Set(files)].sort(cmp)) {
    out.push(
      build(g, g.fileId(p), "file", p, [g.fileId(p)], directDetailOfFile(g, p), maxHops, reachableCap),
    );
  }
  return out;
}

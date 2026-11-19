import { isFileId, isSymId, fileId as makeFileId, parseId, pathOfFileId, pathOfId } from "../ids.js";
import type { Store } from "../store/index.js";
import type { EdgeKind, WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import type { SymbolChange } from "./diff.js";

/**
 * Consumers of a review's changes (#169): for every changed symbol and changed file, everything that uses it.
 * "Directly affected" are the hop-1 consumers (they use the changed item itself); "potentially affected" are the
 * consumers of those, out to hop 3, each with the direct consumer it reaches the change through. Read-only and
 * deterministic; `computeImpact` builds on the same walk, so the CLI, the MCP tool and the explorer agree.
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
  /** Potential only: the node it uses, one step nearer the change. */
  next?: string;
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
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const RENAMED_OR_GONE = new Set(["removed", "renamed", "moved"]);

interface Neighbour {
  src: string;
  kind: UseKind;
  fileId: string;
}

/** Memoised graph reads for one review: every lookup is asked at most once per call of `computeImpact`. */
export class ConsumerGraph {
  private readonly incomingCache = new Map<string, Neighbour[]>();
  private readonly infoCache = new Map<string, Omit<Consumer, "hop" | "uses" | "crosses">>();
  private readonly pathCache = new Map<string, string>();
  private readonly workspaces: WorkspaceRecord[];

  constructor(readonly store: Store) {
    this.workspaces = store.listWorkspaces();
  }

  /** Sources of incoming consumer edges (and `imports` for a file node), without externals and self-loops. */
  incoming(node: string): Neighbour[] {
    let hit = this.incomingCache.get(node);
    if (hit) return hit;
    const kinds: EdgeKind[] = isFileId(node) ? [...CONSUMER_KINDS, "imports"] : [...CONSUMER_KINDS];
    hit = this.store
      .effectiveEdges({ dst: node, kind: kinds })
      .filter((e) => !e.src.startsWith("ext:") && e.src !== node)
      .map((e) => ({ src: e.src, kind: e.kind as UseKind, fileId: e.fileId }));
    for (const n of hit) if (!this.pathCache.has(n.src)) this.pathCache.set(n.src, pathOfFileId(n.fileId));
    this.incomingCache.set(node, hit);
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
export function compareConsumers(a: Consumer, b: Consumer): number {
  const wa = a.workspace ?? "￿";
  const wb = b.workspace ?? "￿";
  return cmp(wa, wb) || cmp(a.path, b.path) || cmp(a.name, b.name) || cmp(a.id, b.id);
}

/** Direct consumers of one changed symbol: id -> use kinds. */
function directOfSymbol(g: ConsumerGraph, c: SymbolChange): Map<string, Set<UseKind>> {
  const ids = [c.after?.id, c.before?.id].filter((x): x is string => x !== undefined);
  const own = new Set(ids);
  const out = new Map<string, Set<UseKind>>();
  const add = (src: string, kind: UseKind) => {
    if (own.has(src)) return;
    const set = out.get(src) ?? new Set<UseKind>();
    set.add(kind);
    out.set(src, set);
  };
  for (const id of ids) for (const n of g.incoming(id)) add(n.src, n.kind);
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
      add(n.src, "imports");
    }
  }
  return out;
}

/** Direct consumers of a changed file: the files that import it. */
function directOfFile(g: ConsumerGraph, path: string): Map<string, Set<UseKind>> {
  const out = new Map<string, Set<UseKind>>();
  for (const n of g.incoming(g.fileId(path))) {
    if (n.kind !== "imports") continue;
    const set = out.get(n.src) ?? new Set<UseKind>();
    set.add("imports");
    out.set(n.src, set);
  }
  return out;
}

/**
 * Breadth-first from the direct consumers, hops 2 to `maxHops`, over the consumer edge kinds (a file also through
 * the files that import it). Each node is kept at its first hop with the first `next` (sorted) that reached it.
 */
function potentialFrom(
  g: ConsumerGraph,
  direct: string[],
  exclude: Set<string>,
  maxHops: number,
): { id: string; hop: number; next: string; via: string; uses: Set<UseKind> }[] {
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
        if (seen.size >= MAX_CONSUMER_WALK + exclude.size + direct.length) return out;
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
  return out;
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

function build(
  g: ConsumerGraph,
  id: string,
  target: ChangeConsumers["target"],
  changedPath: string,
  own: string[],
  direct: Map<string, Set<UseKind>>,
  maxHops: number,
): ChangeConsumers {
  const directIds = [...direct.keys()].sort(cmp);
  const d = tierOf(
    g,
    changedPath,
    directIds.map((x) => ({ id: x, hop: 1, uses: direct.get(x) ?? new Set() })),
  );
  const p = tierOf(g, changedPath, potentialFrom(g, directIds, new Set(own), maxHops));
  return { id, target, direct: d.list, directTotal: d.total, potential: p.list, potentialTotal: p.total };
}

/** The full direct consumer map of a changed symbol (uncapped), for the impact walk and the risk facts. */
export function directConsumers(g: ConsumerGraph, c: SymbolChange): Map<string, Set<UseKind>> {
  return directOfSymbol(g, c);
}

/**
 * Both tiers for every changed symbol (added ones too: code that already uses a new name is rare but real) and every
 * changed file, symbols first (by id), then files (by path).
 */
export function computeConsumers(
  g: ConsumerGraph,
  changes: SymbolChange[],
  files: string[],
  maxHops: number,
): ChangeConsumers[] {
  const out: ChangeConsumers[] = [];
  for (const c of [...changes].sort((a, b) => cmp(a.id, b.id))) {
    const own = [c.after?.id, c.before?.id, c.id].filter((x): x is string => x !== undefined);
    const path = (c.after ?? c.before)?.path ?? g.pathOf(c.id);
    out.push(build(g, c.id, "symbol", path, own, directOfSymbol(g, c), maxHops));
  }
  for (const p of [...new Set(files)].sort(cmp)) {
    out.push(build(g, g.fileId(p), "file", p, [g.fileId(p)], directOfFile(g, p), maxHops));
  }
  return out;
}

import type { FileRecord } from "@gantry/core";
import type { ApiContext, GraphEdge, GraphNode, ViewModule, ViewParams, ViewResult } from "../types.js";
import { cmp, isTestPath, optBool } from "./options.js";

export const MAP3D_LEVELS = ["workspaces", "dirs", "files"] as const;
export type Map3dLevel = (typeof MAP3D_LEVELS)[number];
export const DEFAULT_LEVEL: Map3dLevel = "dirs";
/** The `files` level draws at most this many file nodes; the rest fold into one "+N files" node per directory. */
export const MAX_FILE_NODES = 3000;

const FUNCTION_LIKE = new Set(["function", "method", "component", "hook"]);
const NO_WORKSPACE = "ws:(none)";

const GENERATED_RE =
  /(^|\/)(generated|__generated__|\.next|\.turbo)\/|\.(generated|gen|min)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

export function isGeneratedPath(p: string): boolean {
  return GENERATED_RE.test(p);
}

interface Options {
  level: Map3dLevel;
  hideTests: boolean;
  hideGenerated: boolean;
  maxFileNodes: number;
}

/**
 * `level` comes from `ViewParams.level` (absent or unknown falls back to `dirs`); `hideTests` and
 * `hideGenerated` (both default true) come from the shared view options, like the project map's.
 */
export function readOptions(params: ViewParams, maxFileNodes = MAX_FILE_NODES): Options {
  const raw = params.level ?? DEFAULT_LEVEL;
  const level = (MAP3D_LEVELS as readonly string[]).includes(raw) ? (raw as Map3dLevel) : DEFAULT_LEVEL;
  return {
    level,
    hideTests: optBool(params, "hideTests", true),
    hideGenerated: optBool(params, "hideGenerated", true),
    maxFileNodes,
  };
}

const joinPath = (base: string, dir: string): string =>
  base === "." ? dir : dir === "." ? base : `${base}/${dir}`;

interface FileInfo {
  rec: FileRecord;
  wsId: string;
  fns: number;
  /** Directory key inside the workspace: up to two segments, "." for the workspace root. */
  dir: string;
}

class EdgeSum {
  private readonly m = new Map<string, GraphEdge>();
  add(src: string, dst: string, kind: string, weight: number, confidence: "high" | "low"): void {
    if (src === dst) return;
    const id = `${src}|${kind}|${dst}`;
    const e = this.m.get(id);
    if (e) {
      e.weight += weight;
      if (confidence === "high") e.confidence = "high";
    } else this.m.set(id, { id, src, dst, kind, weight, confidence });
  }
  list(): GraphEdge[] {
    return [...this.m.values()].sort((a, b) => cmp(a.id, b.id));
  }
}

export function buildMap3d(
  { store }: ApiContext,
  params: ViewParams,
  maxFileNodes = MAX_FILE_NODES,
): ViewResult {
  const opts = readOptions(params, maxFileNodes);
  const workspaces = store.listWorkspaces();
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const wsDir = (id: string): string => wsById.get(id)?.dir ?? ".";

  // Function-like symbol counts per file.
  const fnByFile = new Map<string, number>();
  for (const s of store.effectiveSymbols()) {
    if (FUNCTION_LIKE.has(s.kind)) fnByFile.set(s.fileId, (fnByFile.get(s.fileId) ?? 0) + 1);
  }

  const files = new Map<string, FileInfo>();
  for (const rec of store.effectiveFiles()) {
    if (rec.deleted) continue;
    if (opts.hideTests && isTestPath(rec.path)) continue;
    if (opts.hideGenerated && isGeneratedPath(rec.path)) continue;
    const wsId = rec.workspaceId ?? NO_WORKSPACE;
    const base = wsDir(wsId);
    const rel = base !== "." && rec.path.startsWith(`${base}/`) ? rec.path.slice(base.length + 1) : rec.path;
    const segs = rel.split("/").slice(0, -1).slice(0, 2);
    files.set(rec.id, { rec, wsId, fns: fnByFile.get(rec.id) ?? 0, dir: segs.length ? segs.join("/") : "." });
  }

  // Workspace totals (visible files only).
  const wsFiles = new Map<string, number>();
  const wsFns = new Map<string, number>();
  for (const f of files.values()) {
    wsFiles.set(f.wsId, (wsFiles.get(f.wsId) ?? 0) + 1);
    wsFns.set(f.wsId, (wsFns.get(f.wsId) ?? 0) + f.fns);
  }
  const wsNodes: GraphNode[] = workspaces
    .filter((w) => wsFiles.has(w.id)) // empty workspaces (e.g. a bare root package) would be empty islands
    .map((w) => ({
      id: w.id,
      kind: "workspace",
      label: w.name,
      size: wsFns.get(w.id) ?? 0,
      path: w.dir,
      stats: { files: wsFiles.get(w.id) ?? 0, functions: wsFns.get(w.id) ?? 0 },
      badges: [w.kind, `${wsFiles.get(w.id) ?? 0} files`, `${wsFns.get(w.id) ?? 0} functions`],
    }));
  if (wsFiles.has(NO_WORKSPACE)) {
    wsNodes.push({
      id: NO_WORKSPACE,
      kind: "workspace",
      label: "(no workspace)",
      size: wsFns.get(NO_WORKSPACE) ?? 0,
      stats: { files: wsFiles.get(NO_WORKSPACE) ?? 0, functions: wsFns.get(NO_WORKSPACE) ?? 0 },
      badges: ["package", `${wsFiles.get(NO_WORKSPACE)} files`, `${wsFns.get(NO_WORKSPACE)} functions`],
    });
  }

  // Maps a file id to the node that represents it at this level (null: not drawn).
  const nodes: GraphNode[] = [...wsNodes];
  const nodeOf = new Map<string, string>();

  if (opts.level === "workspaces") {
    for (const f of files.values()) nodeOf.set(f.rec.id, f.wsId);
  } else if (opts.level === "dirs") {
    const dirs = new Map<string, { wsId: string; dir: string; files: number; fns: number }>();
    for (const f of files.values()) {
      const id = `dir:${f.wsId}:${f.dir}`;
      const d = dirs.get(id) ?? { wsId: f.wsId, dir: f.dir, files: 0, fns: 0 };
      d.files += 1;
      d.fns += f.fns;
      dirs.set(id, d);
      nodeOf.set(f.rec.id, id);
    }
    for (const [id, d] of dirs) {
      nodes.push({
        id,
        kind: "dir",
        label: d.dir === "." ? "(root)" : d.dir,
        parent: d.wsId,
        size: d.fns,
        path: joinPath(wsDir(d.wsId), d.dir),
        stats: { files: d.files, functions: d.fns },
        badges: [`${d.files} files`, `${d.fns} functions`],
      });
    }
  } else {
    const ranked = [...files.values()].sort((a, b) => b.fns - a.fns || cmp(a.rec.path, b.rec.path));
    const kept = ranked.slice(0, opts.maxFileNodes);
    const folded = new Map<string, { wsId: string; dir: string; files: number; fns: number }>();
    for (const f of kept) {
      nodeOf.set(f.rec.id, f.rec.id);
      nodes.push({
        id: f.rec.id,
        kind: "file",
        label: f.rec.path.slice(f.rec.path.lastIndexOf("/") + 1),
        parent: f.wsId,
        size: f.fns,
        path: f.rec.path,
        stats: { functions: f.fns },
        badges: [`${f.fns} functions`],
      });
    }
    for (const f of ranked.slice(opts.maxFileNodes)) {
      const id = `more:${f.wsId}:${f.dir}`;
      const d = folded.get(id) ?? { wsId: f.wsId, dir: f.dir, files: 0, fns: 0 };
      d.files += 1;
      d.fns += f.fns;
      folded.set(id, d);
      nodeOf.set(f.rec.id, id);
    }
    for (const [id, d] of folded) {
      nodes.push({
        id,
        kind: "folded",
        label: `+${d.files} files`,
        parent: d.wsId,
        size: d.fns,
        path: joinPath(wsDir(d.wsId), d.dir),
        stats: { files: d.files, functions: d.fns },
        badges: [`${d.files} files`, `${d.fns} functions`, d.dir === "." ? "(root)" : d.dir],
      });
    }
  }

  // Edges: file imports lifted to the level's nodes, plus workspace depends_on.
  const sum = new EdgeSum();
  for (const e of store.effectiveEdges({ kind: ["imports"] })) {
    const a = nodeOf.get(e.src);
    const b = nodeOf.get(e.dst);
    if (a && b) sum.add(a, b, "imports", e.count, e.confidence);
  }
  const wsIds = new Set(wsNodes.map((n) => n.id));
  for (const e of store.effectiveEdges({ kind: ["depends_on"] })) {
    if (wsIds.has(e.src) && wsIds.has(e.dst)) sum.add(e.src, e.dst, "depends_on", e.count, e.confidence);
  }

  nodes.sort((a, b) => cmp(a.id, b.id));
  return { nodes, edges: sum.list(), layoutHint: "force-3d" };
}

export const map3dView: ViewModule = {
  id: "map-3d",
  title: "3D map",
  enabled: true,
  build: (ctx, params) => buildMap3d(ctx, params),
};

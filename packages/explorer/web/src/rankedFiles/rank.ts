// "Largest files": the ranking shared by the 2D project map and the 3D map (list in the left panel, numbered markers
// on the canvas). Pure and deterministic: it only reads the file nodes of the view response.
import type { GraphNode } from "../api.ts";

/** How many files are ranked. */
export const RANK_COUNT = 15;

export interface RankedFile {
  /** 1-based position in the ranking. */
  rank: number;
  id: string;
  /** File name, e.g. `orderService.ts`. */
  name: string;
  functions: number;
  /** Repo-relative path. */
  path: string;
  /** Id and short name of the workspace the file belongs to. */
  workspaceId: string;
  workspace: string;
  /** Folder inside the workspace without a leading `src/` (empty for a file at the workspace root). */
  folder: string;
}

export interface RankOptions {
  /** Leave out test and spec files (the "Hide tests" filter). Default true. */
  hideTests?: boolean;
  /** Only files of this workspace id; null or undefined for all visible workspaces. */
  workspace?: string | null;
  limit?: number;
}

const TEST_DIRS = new Set(["__tests__", "e2e", "tests", "test"]);

/** Same rule as the server's `isTestPath`: `*.test.*`, `*.spec.*` or a file below a test folder. */
export function isTestPath(path: string): boolean {
  const segs = path.split("/");
  const base = segs[segs.length - 1] ?? "";
  return /\.(?:test|spec)\./.test(base) || segs.slice(0, -1).some((s) => TEST_DIRS.has(s));
}

/** The workspace node above `node`, following `parent` links (3D: the direct parent; 2D: through the folders). */
function workspaceOf(node: GraphNode, byId: Map<string, GraphNode>): GraphNode | null {
  let cur: GraphNode | undefined = node;
  for (let i = 0; cur && i < 64; i++) {
    if (cur.kind === "workspace") return cur;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return null;
}

/** `apps/api/src/routes/x.ts` in workspace `apps/api` -> `routes`. */
export function folderIn(path: string, wsPath: string | undefined): string {
  let rel = path;
  const base = wsPath && wsPath !== "." ? wsPath.replace(/\/$/, "") : "";
  if (base && rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  return dir.replace(/^src(\/|$)/, "");
}

const byCountThenPath = (a: RankedFile, b: RankedFile): number =>
  b.functions - a.functions || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1);

/** The workspaces that own at least one file, by short name: the choices of the "Top files in" menu. */
export function workspacesWithFiles(nodes: readonly GraphNode[]): { id: string; label: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const ws = workspaceOf(n, byId);
    if (ws) seen.set(ws.id, ws.shortLabel ?? ws.label);
  }
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** The largest files by function count (ties: by path), numbered from 1. */
export function rankFiles(nodes: readonly GraphNode[], opts: RankOptions = {}): RankedFile[] {
  const hideTests = opts.hideTests ?? true;
  const limit = opts.limit ?? RANK_COUNT;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const files: RankedFile[] = [];
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const path = n.path ?? n.id.replace(/^file:/, "");
    if (hideTests && isTestPath(path)) continue;
    const ws = workspaceOf(n, byId);
    if (opts.workspace && ws?.id !== opts.workspace) continue;
    files.push({
      rank: 0,
      id: n.id,
      name: n.label,
      functions: n.stats?.functions ?? 0,
      path,
      workspaceId: ws?.id ?? "",
      workspace: ws ? (ws.shortLabel ?? ws.label) : "",
      folder: folderIn(path, ws?.path),
    });
  }
  files.sort(byCountThenPath);
  return files.slice(0, limit).map((f, i) => ({ ...f, rank: i + 1 }));
}

/** The second line of a list row: `api › routes/v1` (just the workspace for a file at its root). */
export function whereLine(f: RankedFile): string {
  return f.folder ? `${f.workspace} › ${f.folder}` : f.workspace;
}

import { isFileId, isSymId, qualifyId, repoOfId } from "../ids.js";
import { type Store, safeRepo } from "../store/index.js";
import type { FileRecord, SymbolRecord } from "../types.js";

export interface NodeInfo {
  /** The repo the node is in. */
  repo: string;
  node: SymbolRecord | FileRecord;
  /** Distinct nodes with a non-`contains` edge into this one. */
  fanIn: number;
  /** Distinct nodes this one has a non-`contains` edge to. */
  fanOut: number;
  /** Neighbor ids grouped by edge kind. Outgoing edges use the kind as key, incoming `<kind>:in`. */
  neighbors: Record<string, string[]>;
}

/** Symbol of `fileId` containing `line` with the smallest span (the innermost one). */
function innermost(store: Store, fileId: string, line: number): SymbolRecord | undefined {
  let best: SymbolRecord | undefined;
  for (const s of store.effectiveSymbols({ fileId })) {
    if (line < s.startLine || line > s.endLine) continue;
    if (!best) {
      best = s;
      continue;
    }
    const span = s.endLine - s.startLine;
    const bestSpan = best.endLine - best.startLine;
    if (span < bestSpan || (span === bestSpan && s.startLine > best.startLine)) best = s;
  }
  return best;
}

/**
 * Looks up a symbol or file by id (`sym:...`, `file:...`), by `path:line` (the innermost symbol containing
 * the line), or by bare `path` (the file). Returns null when nothing matches.
 */
export function nodeInfo(store: Store, target: string): NodeInfo | null {
  const t = target.trim();
  const repo = safeRepo(store);
  // Files sorted by repo name; a path that exists in several repos means the file of the repo the command runs in.
  const files = store
    .effectiveFiles()
    .filter((f) => !f.deleted)
    .sort((a, b) => (repoOfId(a.id) ?? "").localeCompare(repoOfId(b.id) ?? ""));
  const byPath = new Map<string, FileRecord>();
  for (const f of files) {
    const known = byPath.get(f.path);
    if (!known || (repoOfId(f.id) === repo && repoOfId(known.id) !== repo)) byPath.set(f.path, f);
  }
  let node: SymbolRecord | FileRecord | undefined;

  const long = repo === undefined ? undefined : qualifyId(repo, t);
  if (isSymId(t)) node = store.getSymbol(t) ?? (long ? store.getSymbol(long) : undefined);
  else if (isFileId(t)) node = files.find((f) => f.id === t || f.id === long);
  else {
    const m = /^(.*):(\d+)$/.exec(t);
    const file = m ? byPath.get(m[1] as string) : undefined;
    if (m && file) node = innermost(store, file.id, Number(m[2]));
    else node = byPath.get(t);
  }
  if (!node) return null;

  const neighbors: Record<string, string[]> = {};
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const add = (key: string, id: string) => {
    const list = neighbors[key] ?? [];
    if (!list.includes(id)) list.push(id);
    neighbors[key] = list;
  };
  for (const e of store.effectiveEdges({ src: node.id })) {
    add(e.kind, e.dst);
    if (e.kind !== "contains") outgoing.add(e.dst);
  }
  for (const e of store.effectiveEdges({ dst: node.id })) {
    add(`${e.kind}:in`, e.src);
    if (e.kind !== "contains") incoming.add(e.src);
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(neighbors).sort()) sorted[k] = (neighbors[k] as string[]).sort();
  return {
    repo: repoOfId(node.id) ?? "",
    node,
    fanIn: incoming.size,
    fanOut: outgoing.size,
    neighbors: sorted,
  };
}

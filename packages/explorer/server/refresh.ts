import { type GantryPaths, heal, healPending, refreshWorking, type Store, staleFiles } from "@gantry/core";

// The explorer is not live (spec section 11 (c)): no watcher, no push. Every API request checks what changed since
// the index was last brought up to date (cheap: git status plus mtime), and `POST /api/refresh` brings it up to date.

export interface StaleInfo {
  files: number;
}

export interface RefreshResult {
  /** Counts, as in the spec: files re-indexed or dropped, and functions added, changed or removed. */
  changed: { files: number; functions: number };
  ms: number;
  /** True when `HEAD` had moved and the main layer was healed first. */
  healed: boolean;
  /** Ids of the files that changed (`file:<path>`), sorted. */
  files: string[];
  /** Ids of the symbols that were added, whose code changed, or that are gone, each sorted. */
  functions: { added: string[]; changed: string[]; removed: string[] };
}

/** `{ files }` for view responses: how many files changed since the last refresh. Never throws. */
export function staleInfo(paths: GantryPaths, store: Store): StaleInfo {
  try {
    return { files: staleFiles(paths, store).files.length };
  } catch {
    return { files: 0 }; // not a git repo, or git is missing: nothing to compare with
  }
}

/** Effective symbol id -> exact hash (the code), and file ids, in one query each. */
function snapshot(store: Store): { symbols: Map<string, string>; files: Map<string, string> } {
  const eff = `eff_files AS (
    SELECT id, layer, content_hash, deleted FROM files WHERE layer = 'working'
    UNION ALL
    SELECT m.id, m.layer, m.content_hash, m.deleted FROM files m WHERE m.layer = 'main'
      AND NOT EXISTS (SELECT 1 FROM files w WHERE w.id = m.id AND w.layer = 'working'))`;
  const syms = store.db
    .prepare(
      `WITH ${eff} SELECT s.id AS id, s.exact_hash AS h FROM symbols s
       JOIN eff_files f ON f.id = s.file_id AND f.layer = s.layer WHERE f.deleted = 0`,
    )
    .all() as { id: string; h: string }[];
  const files = store.db
    .prepare(`WITH ${eff} SELECT id, content_hash AS h FROM eff_files WHERE deleted = 0`)
    .all() as {
    id: string;
    h: string;
  }[];
  return { symbols: new Map(syms.map((r) => [r.id, r.h])), files: new Map(files.map((r) => [r.id, r.h])) };
}

function diffMaps(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, h] of after) {
    const old = before.get(id);
    if (old === undefined) added.push(id);
    else if (old !== h) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Heal (only when `HEAD` moved) plus the working-layer re-index of the changed files; the same steps as the MCP
 * server's lazy refresh. Never calls a model and writes nothing into the repository. `store` is the explorer's own
 * connection, used to read the before and after state; the writes go through core's own connections.
 */
export async function runRefresh(paths: GantryPaths, store: Store): Promise<RefreshResult> {
  const t0 = performance.now();
  const before = snapshot(store);
  const head = healPending(paths, store);
  if (head) await heal(paths);
  await refreshWorking(paths);
  const after = snapshot(store);
  const fns = diffMaps(before.symbols, after.symbols);
  const fileDiff = diffMaps(before.files, after.files);
  const files = [...fileDiff.added, ...fileDiff.changed, ...fileDiff.removed].sort();
  return {
    changed: { files: files.length, functions: fns.added.length + fns.changed.length + fns.removed.length },
    ms: Math.round(performance.now() - t0),
    healed: head,
    files,
    functions: fns,
  };
}

/** One refresh at a time per server: a second request while one runs gets the same result. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  };
}

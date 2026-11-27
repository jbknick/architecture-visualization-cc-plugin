import {
  cacheAgeSeconds,
  fileIdOfSymId,
  isFileId,
  isSymId,
  openTeamCache,
  readCacheRepo,
  readChangeSetDetails,
  type Store,
} from "@gantry/core";
import type { ApiContext, TeamChangeSet, TeamLayerResponse } from "./types.js";

/** Caps per change set; the totals are uncut. */
export const TEAM_NODES_CAP = 200;
export const TEAM_RADIUS_CAP = 500;

const EMPTY: TeamLayerResponse = { available: false, age_s: null, change_sets: [], people: [] };

/** The workspace of a changed node (a file's, or its symbol's file's), or undefined when the index does not know it. */
function workspaceOfNode(store: Store, id: string): string | undefined {
  let fileId: string | undefined;
  if (isFileId(id)) fileId = id;
  else if (isSymId(id)) fileId = store.getSymbol(id)?.fileId;
  if (fileId === undefined) return undefined;
  return store.effectiveFile(fileId)?.workspaceId ?? undefined;
}

/**
 * The directly affected entries that use a changed node, by the local graph. An entry `E` uses changed node `N` when the
 * index has an edge from `E` (a symbol or file) or from `E`'s file to `N`. An entry with no such edge, because the local
 * index differs from the one the change set was built on, is left out.
 */
function directUses(
  store: Store,
  nodes: readonly string[],
  radius: TeamChangeSet["radius"],
): TeamChangeSet["direct_uses"] {
  const changed = new Set(nodes);
  const direct = radius.filter(
    (r) => r.tier === "direct" && r.hop === 1 && (isFileId(r.id) || isSymId(r.id)),
  );
  const files = new Set<string>();
  for (const r of direct) {
    const file = isFileId(r.id) ? r.id : fileIdOfSymId(r.id);
    if (file !== undefined) files.add(file);
  }
  if (files.size === 0 || changed.size === 0) return [];
  const dsts = new Map<string, Set<string>>();
  for (const e of store.effectiveEdgesOfFiles([...files])) {
    if (!changed.has(e.dst)) continue;
    const set = dsts.get(e.src) ?? new Set<string>();
    set.add(e.dst);
    dsts.set(e.src, set);
  }
  const out: TeamChangeSet["direct_uses"] = [];
  for (const r of direct) {
    const file = isFileId(r.id) ? r.id : fileIdOfSymId(r.id);
    const used = new Set([...(dsts.get(r.id) ?? []), ...(file === undefined ? [] : (dsts.get(file) ?? []))]);
    used.delete(r.id);
    if (used.size > 0) out.push({ id: r.id, changed: [...used].sort() });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * `GET /api/team/layer`. Reads `team-cache.db` through the cache readers only (read-only, no network, no server):
 * the explorer never talks to a team server. A missing cache, or one pulled for another repo, is `available: false`.
 */
export function teamLayer(ctx: ApiContext): TeamLayerResponse {
  const cache = openTeamCache(ctx.paths, { readonly: true });
  if (cache === undefined) return EMPTY;
  try {
    if (readCacheRepo(cache) !== ctx.paths.repo) return EMPTY;
    const workspaceCache = new Map<string, string | undefined>();
    const workspaceOf = (id: string): string | undefined => {
      if (!workspaceCache.has(id)) workspaceCache.set(id, workspaceOfNode(ctx.store, id));
      return workspaceCache.get(id);
    };
    const change_sets: TeamChangeSet[] = readChangeSetDetails(cache).map((cs) => {
      const mapNodes = new Set<string>();
      for (const id of cs.nodes) {
        const ws = workspaceOf(id);
        if (ws !== undefined) mapNodes.add(ws);
      }
      return {
        id: cs.id,
        source: cs.source,
        state: cs.state,
        owner: cs.owner,
        ...(cs.title === undefined ? {} : { title: cs.title }),
        ...(cs.pr === undefined ? {} : { pr: cs.pr }),
        nodes: cs.nodes.slice(0, TEAM_NODES_CAP),
        radius: cs.radius.slice(0, TEAM_RADIUS_CAP),
        nodes_total: cs.nodes.length,
        radius_total: cs.radius.length,
        map_nodes: [...mapNodes].sort(),
        direct_uses: directUses(ctx.store, cs.nodes, cs.radius),
      };
    });
    return {
      available: true,
      age_s: cacheAgeSeconds(cache) ?? null,
      change_sets,
      people: [...new Set(change_sets.map((c) => c.owner))].sort(),
    };
  } finally {
    cache.close();
  }
}

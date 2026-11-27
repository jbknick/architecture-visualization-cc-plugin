import { readOverlay } from "../overlay/repo.js";
import type { Group, SavedView } from "../overlay/types.js";
import type { Store } from "../store/index.js";
import { readTeamGroups, readTeamSetting, readTeamViews, type TeamCache } from "./cache.js";

// Shared views and groups (spec sections 7 and 11). The first three functions are readers: synchronous, no network,
// and safe for a hook to import. The four `publish`/`unpublish` functions call a server and are used by
// `gantry team publish` only; no hook imports them (`team.guard.test.ts` and `cache.guard.test.ts` check).

export type Origin = "team" | "local";
export type MergedGroup = Group & { origin: Origin; shadowed?: true };
export type MergedView = SavedView & { origin: Origin; shadowed?: true };

/** Team items, then local ones; a local item whose id a team item holds is kept, marked `shadowed`. Sorted by id. */
function merge<T extends { id: string }>(team: T[], local: T[]): (T & { origin: Origin; shadowed?: true })[] {
  const taken = new Set(team.map((t) => t.id));
  const out: (T & { origin: Origin; shadowed?: true })[] = [
    ...team.map((t) => ({ ...t, origin: "team" as const })),
    ...local.map((l) =>
      taken.has(l.id)
        ? { ...l, origin: "local" as const, shadowed: true as const }
        : { ...l, origin: "local" as const },
    ),
  ];
  return out.sort((a, b) =>
    a.id === b.id ? (a.origin === b.origin ? 0 : a.origin === "team" ? -1 : 1) : a.id < b.id ? -1 : 1,
  );
}

/**
 * The team groups of the cache plus the local groups (the ones stored in the overlay, not the computed defaults). On an
 * id clash the team group wins and the local one is returned with `shadowed: true` and `origin: "local"`. A cache row
 * that does not parse with `GroupSchema` is skipped (the reader does that). Sorted by id, team before local.
 */
export function mergedGroups(store: Store, cache: TeamCache | undefined): MergedGroup[] {
  return merge(readTeamGroups(cache), readOverlay(store).groups);
}

/** The same rule for saved views, with `SavedViewSchema`. */
export function mergedViews(store: Store, cache: TeamCache | undefined): MergedView[] {
  return merge(readTeamViews(cache), readOverlay(store).views);
}

/** The id the server names as the team's default view (`settings.default_view`), when a cached view has that id. */
export function defaultViewId(cache: TeamCache | undefined): string | undefined {
  const id = readTeamSetting(cache, "default_view");
  if (id === undefined) return undefined;
  return readTeamViews(cache).some((v) => v.id === id) ? id : undefined;
}

// ---- writers: the server decides who may publish; a refusal comes back as the client's `GantryError`

/** The four write calls of the team client (the team client has them); a structural type keeps this file free of the client. */
export interface TeamViewsWriter {
  putGroup(repo: string, id: string, body: unknown): Promise<unknown>;
  deleteGroup(repo: string, id: string): Promise<{ deleted: boolean }>;
  putView(repo: string, id: string, body: unknown): Promise<unknown>;
  deleteView(repo: string, id: string): Promise<{ deleted: boolean }>;
}

/** What a cache pull answers: the status and, for `failed`, the error. */
export interface RefreshResult {
  status: string;
  error?: string;
}

/** Pulls the team cache; the caller passes the cache pull bound to its paths and config. */
export type RefreshTeamCache = () => Promise<RefreshResult>;

/** `PUT`s a local view to the team, then refreshes the cache so the change shows at once. Throws the server's refusal. */
export async function publishView(
  client: TeamViewsWriter,
  repo: string,
  view: SavedView,
  refresh: RefreshTeamCache,
): Promise<RefreshResult> {
  await client.putView(repo, view.id, view);
  return refresh();
}

/** `PUT`s a local group to the team, then refreshes the cache. Throws the server's refusal. */
export async function publishGroup(
  client: TeamViewsWriter,
  repo: string,
  group: Group,
  refresh: RefreshTeamCache,
): Promise<RefreshResult> {
  await client.putGroup(repo, group.id, group);
  return refresh();
}

/** `DELETE`s a team view, then refreshes the cache. `deleted` is false when the team had no such view. */
export async function unpublishView(
  client: TeamViewsWriter,
  repo: string,
  id: string,
  refresh: RefreshTeamCache,
): Promise<{ deleted: boolean; refresh: RefreshResult }> {
  const { deleted } = await client.deleteView(repo, id);
  return { deleted, refresh: await refresh() };
}

/** `DELETE`s a team group, then refreshes the cache. `deleted` is false when the team had no such group. */
export async function unpublishGroup(
  client: TeamViewsWriter,
  repo: string,
  id: string,
  refresh: RefreshTeamCache,
): Promise<{ deleted: boolean; refresh: RefreshResult }> {
  const { deleted } = await client.deleteGroup(repo, id);
  return { deleted, refresh: await refresh() };
}

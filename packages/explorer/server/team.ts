import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheAgeSeconds,
  defaultViewId,
  fileIdOfSymId,
  GantryError,
  isFileId,
  isSymId,
  mergedGroups,
  mergedViews,
  type OverlayState,
  openTeamCache,
  publishGroup,
  publishView,
  pullTeamCache,
  readCacheRepo,
  readChangeSetDetails,
  readOverlay,
  type Store,
  teamClient,
  unpublishGroup,
  unpublishView,
} from "@gantry/core";
import { HttpError } from "./errors.js";
import type { ApiContext, TeamChangeSet, TeamLayerResponse, TeamViewsResponse } from "./types.js";

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

const NO_VIEWS: TeamViewsResponse = {
  available: false,
  age_s: null,
  views: [],
  groups: [],
  default_view: null,
  last_view: null,
};

/** The same string whatever the order of a value's keys, for comparing a local item with the team's copy. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

type Marked<T> = T & { origin: "team" | "local"; shadowed?: true; published?: true; own?: true };

/**
 * Marks what the person published. A local item is `published` when a team item has its id and equal content (every field
 * but the markers); that team item is then `own`, the person's own item as the team holds it. A team item with the same
 * id and other content is someone else's: the local one stays `shadowed` and neither is marked.
 */
function markPublished<T extends { id: string }>(items: Marked<T>[]): Marked<T>[] {
  const team = new Map(items.filter((i) => i.origin === "team").map((i) => [i.id, i]));
  const body = ({ origin: _o, shadowed: _s, published: _p, own: _w, ...rest }: Marked<T>) => canonical(rest);
  for (const item of items) {
    const twin = item.origin === "local" ? team.get(item.id) : undefined;
    if (twin !== undefined && body(twin) === body(item)) {
      item.published = true;
      twin.own = true;
    }
  }
  return items;
}

const LAST_VIEW = /^[a-z0-9][a-z0-9-]{0,62}$/;
const lastViewFile = (ctx: ApiContext): string => join(ctx.paths.dataDir, "last-view.json");

/** The saved view this person last picked for this repo, from `<dataDir>/last-view.json` (by repo), or null. */
function readLastView(ctx: ApiContext): string | null {
  try {
    const all = JSON.parse(readFileSync(lastViewFile(ctx), "utf8")) as Record<string, unknown>;
    const id = all[ctx.paths.repo];
    return typeof id === "string" && LAST_VIEW.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** `PUT /api/team/last-view` with `{ id }`: remembers the pick in `<dataDir>/last-view.json`. A local file write only. */
export function putLastView(ctx: ApiContext, body: unknown): { id: string } {
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !LAST_VIEW.test(id)) throw new HttpError(400, "id: not a saved view id");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(lastViewFile(ctx), "utf8")) as Record<string, unknown>;
  } catch {
    // none yet, or unreadable: start again
  }
  mkdirSync(ctx.paths.dataDir, { recursive: true });
  const tmp = `${lastViewFile(ctx)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...all, [ctx.paths.repo]: id }));
  renameSync(tmp, lastViewFile(ctx));
  return { id };
}

export const isLastViewWrite = (method: string, pathname: string): boolean =>
  method === "PUT" && pathname === "/api/team/last-view";

/**
 * `GET /api/team/views`. The saved views and groups of the team cache merged with the local ones, and the team's default
 * view, read through the cache readers only (read-only, no network). A missing cache, or one pulled for another repo,
 * is `available: false`. Names come from teammates: the web app renders them as text.
 */
export function teamViews(ctx: ApiContext): TeamViewsResponse {
  const cache = openTeamCache(ctx.paths, { readonly: true });
  if (cache === undefined) return NO_VIEWS;
  try {
    if (readCacheRepo(cache) !== ctx.paths.repo) return NO_VIEWS;
    return {
      available: true,
      age_s: cacheAgeSeconds(cache) ?? null,
      views: markPublished(mergedViews(ctx.store, cache)),
      groups: markPublished(mergedGroups(ctx.store, cache)),
      default_view: defaultViewId(cache) ?? null,
      last_view: readLastView(ctx),
    };
  } finally {
    cache.close();
  }
}

/**
 * The overlay a view is built with: with a team cache for this repo, the team's groups and views join the local ones (a
 * team item beats a local one with the same id, as in `mergedGroups`), so a team view opens and its groups apply. With
 * no cache the overlay is returned as it is.
 */
export function teamOverlay(ctx: ApiContext, state: OverlayState): OverlayState {
  // A context with no data directory (a view test's placeholder paths) has no cache to look in.
  if (typeof ctx.paths.dataDir !== "string") return state;
  const cache = openTeamCache(ctx.paths, { readonly: true });
  if (cache === undefined) return state;
  try {
    if (readCacheRepo(cache) !== ctx.paths.repo) return state;
    return {
      ...state,
      groups: mergedGroups(ctx.store, cache)
        .filter((g) => g.shadowed !== true)
        .map(({ origin: _origin, shadowed: _shadowed, ...group }) => group),
      views: mergedViews(ctx.store, cache)
        .filter((v) => v.shadowed !== true)
        .map(({ origin: _origin, shadowed: _shadowed, ...view }) => view),
    };
  } finally {
    cache.close();
  }
}

/** Largest body a publish route reads: none is needed. */
export const MAX_TEAM_BODY_BYTES = 1024;
const PUBLISH_ROUTE = /^\/api\/team\/(views|groups)\/([^/]+)\/publish$/;

/** Whether `method pathname` is one of the four publish routes (`POST` publishes, `DELETE` removes). */
export function isTeamPublish(method: string, pathname: string): boolean {
  return (method === "POST" || method === "DELETE") && PUBLISH_ROUTE.test(pathname);
}

/** The status a team server's refusal is shown with: 403 and 404 as the server said, anything else 502. */
function refusal(err: GantryError): HttpError {
  const status = err.code === "team_forbidden" ? 403 : err.answer?.status === 404 ? 404 : 502;
  return new HttpError(status, err.message);
}

/**
 * `POST|DELETE /api/team/views/:id/publish` and `/api/team/groups/:id/publish`. The only explorer routes that reach a
 * team server, and only on a click: they call the core publish functions with the client built from the local
 * config and credentials, which refresh the team cache after the server accepts. The server decides who may do what;
 * its message comes back unchanged. Publishing sends the local view or group with that id and nothing else.
 */
export async function teamPublish(
  ctx: ApiContext,
  method: string,
  pathname: string,
): Promise<{ published: boolean }> {
  const m = PUBLISH_ROUTE.exec(pathname);
  if (!m) throw new HttpError(404, "Unknown API route");
  const kind = m[1] === "views" ? "view" : "group";
  let id: string;
  try {
    id = decodeURIComponent(m[2] as string);
  } catch {
    throw new HttpError(400, "Malformed id");
  }
  try {
    const client = teamClient(ctx.paths, ctx.config);
    if (!client.hasToken || client.org === undefined)
      throw new HttpError(502, "Not linked to a team: run gantry team login, then gantry team link.");
    const repo = ctx.paths.repo;
    const refresh = () => pullTeamCache(ctx.paths, ctx.config);
    if (method === "POST") {
      const overlay = readOverlay(ctx.store);
      if (kind === "view") {
        const local = overlay.views.find((x) => x.id === id);
        if (local === undefined) throw new HttpError(404, `No local view with the id ${id}.`);
        await publishView(client, repo, local, refresh);
      } else {
        const local = overlay.groups.find((x) => x.id === id);
        if (local === undefined) throw new HttpError(404, `No local group with the id ${id}.`);
        await publishGroup(client, repo, local, refresh);
      }
      return { published: true };
    }
    const { deleted } =
      kind === "view"
        ? await unpublishView(client, repo, id, refresh)
        : await unpublishGroup(client, repo, id, refresh);
    if (!deleted) throw new HttpError(404, `The team has no ${kind} ${id}.`);
    return { published: false };
  } catch (err) {
    if (err instanceof GantryError) throw refusal(err);
    throw err;
  }
}

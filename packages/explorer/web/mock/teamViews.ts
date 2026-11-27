// Mock team views: `#/project-map?scenario=team` serves three team views (one the default) and two team groups for the
// mock's synthetic pnpm-turbo-like map, next to whatever the person saved in the mock overlay. The names are made up for
// the mock. Publishing copies a local view or group to the team list and removing takes it out, in memory, like the real
// routes (`POST` and `DELETE /api/team/<views|groups>/<id>/publish`). Without the scenario the mock answers like a repo
// with no team cache (`available: false`), so every other mock view is unchanged.
import type { Group, SavedView, TeamGroup, TeamView, TeamViewsData } from "../src/api.ts";
import { mockOverlay } from "./overlay.ts";

const spec = (view: string, level: "workspaces" | "dirs" | "files"): SavedView["spec"] => ({
  view,
  level,
  hidden: [],
  groups: [],
  filters: {},
});

const initialViews = (): SavedView[] => [
  { id: "ownership-map", name: "Ownership map", spec: spec("project-map", "workspaces") },
  { id: "public-api-surface", name: "Public API surface", spec: spec("project-map", "files") },
  { id: "data-layer", name: "Data layer", spec: spec("project-map", "dirs") },
];
const initialGroups = (): Group[] => [
  { id: "frontend", name: "Frontend", selectors: [{ type: "glob", glob: "apps/web/**" }], mayUse: null },
  {
    id: "data-access",
    name: "Data access",
    selectors: [{ type: "glob", glob: "packages/db/**" }],
    mayUse: [],
  },
];

let team = { views: initialViews(), groups: initialGroups() };
let lastView: string | null = null;
const DEFAULT_VIEW = "ownership-map";

/** Back to the three views and two groups (component tests call this between tests). */
export function resetMockTeamViews(): void {
  team = { views: initialViews(), groups: initialGroups() };
  lastView = null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Marks what the person published: a local item with an equal team copy is `published`, and the copy is `own`. */
function mark<T extends { id: string; origin: "team" | "local"; published?: true; own?: true }>(
  items: T[],
): T[] {
  const strip = ({ origin: _o, shadowed: _s, published: _p, own: _w, ...rest }: T & { shadowed?: true }) =>
    rest;
  for (const item of items) {
    const twin =
      item.origin === "local" ? items.find((t) => t.origin === "team" && t.id === item.id) : undefined;
    if (twin && same(strip(twin), strip(item))) {
      item.published = true;
      twin.own = true;
    }
  }
  return items;
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : 1);

/** `/api/team/views` for the mock. */
export function mockTeamViews(scenario: string | null): TeamViewsData {
  if (scenario !== "team")
    return { available: false, age_s: null, views: [], groups: [], default_view: null, last_view: null };
  const local = mockOverlay();
  const teamViewIds = new Set(team.views.map((v) => v.id));
  const teamGroupIds = new Set(team.groups.map((g) => g.id));
  const views: TeamView[] = [
    ...team.views.map((v) => ({ ...v, origin: "team" as const })),
    ...local.views.map((v) => ({
      ...v,
      origin: "local" as const,
      ...(teamViewIds.has(v.id) ? { shadowed: true as const } : {}),
    })),
  ].sort((a, b) => byId(a, b) || (a.origin === b.origin ? 0 : a.origin === "team" ? -1 : 1));
  const groups: TeamGroup[] = [
    ...team.groups.map((g) => ({ ...g, origin: "team" as const })),
    ...local.groups.map((g) => ({
      ...g,
      origin: "local" as const,
      ...(teamGroupIds.has(g.id) ? { shadowed: true as const } : {}),
    })),
  ].sort(byId);
  return {
    available: true,
    age_s: 12 * 60,
    views: mark(views),
    groups: mark(groups),
    default_view: DEFAULT_VIEW,
    last_view: lastView,
  };
}

const PUBLISH_ROUTE = /^\/api\/team\/(views|groups)\/([^/]+)\/publish$/;

export function isMockTeamWrite(pathname: string): boolean {
  return PUBLISH_ROUTE.test(pathname) || pathname === "/api/team/last-view";
}

interface MockResponse {
  status: number;
  body: unknown;
}

/** The mock's publish routes. The person is a member: removing the admins' group is refused, as a real team may. */
export function handleMockTeamWrite(method: string, pathname: string, body?: unknown): MockResponse | null {
  if (pathname === "/api/team/last-view" && method === "PUT") {
    lastView = (body as { id: string }).id;
    return { status: 200, body: { id: lastView } };
  }
  const m = PUBLISH_ROUTE.exec(pathname);
  if (!m) return null;
  const kind = m[1] === "views" ? "view" : "group";
  const id = decodeURIComponent(m[2] as string);
  if (method === "POST") {
    const local = mockOverlay();
    const item = (kind === "view" ? local.views : local.groups).find((x) => x.id === id);
    if (!item) return { status: 404, body: { error: `No local ${kind} with the id ${id}.` } };
    if (kind === "view")
      team.views = [...team.views.filter((v) => v.id !== id), item as SavedView].sort(byId);
    else team.groups = [...team.groups.filter((g) => g.id !== id), item as Group].sort(byId);
    return { status: 200, body: { published: true } };
  }
  if (method !== "DELETE") return null;
  if (kind === "group") {
    // The person is a member: the group the admins own is refused, any other the team holds can be removed.
    if (id === "frontend") return { status: 403, body: { error: "Removing a team group needs an admin." } };
    if (!team.groups.some((g) => g.id === id))
      return { status: 404, body: { error: `The team has no group ${id}.` } };
    team.groups = team.groups.filter((g) => g.id !== id);
    return { status: 200, body: { published: false } };
  }
  if (!team.views.some((v) => v.id === id))
    return { status: 404, body: { error: `The team has no view ${id}.` } };
  team.views = team.views.filter((v) => v.id !== id);
  return { status: 200, body: { published: false } };
}

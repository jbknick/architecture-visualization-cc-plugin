// Mock Team layer: `#/project-map?scenario=team` serves three open pull requests by two invented people (ines and
// tomas) on the mock's synthetic pnpm-turbo-like map. Titles, numbers and names are made up for the mock. Without the
// scenario the mock answers like a repo with no team cache (`available: false`), so every other mock view is unchanged.
import type { TeamChangeSet, TeamLayerData } from "../src/api.ts";

type Tier = TeamChangeSet["radius"][number]["tier"];

const symbolId = (path: string, name: string) => `sym:pnpm-turbo:${path}#${name}`;
const fileId = (path: string) => `file:pnpm-turbo:${path}`;

const ROUTER_FILE = fileId("apps/api/src/router.ts");
const QUERIES_FILE = fileId("packages/db/src/queries.ts");
const SLUG_FILE = fileId("packages/utils/src/slug.ts");
const DATE_FILE = fileId("packages/utils/src/date.ts");
const BUTTON_FILE = fileId("packages/ui/src/button.tsx");
const CARD_FILE = fileId("packages/ui/src/card.tsx");

const createRouter = symbolId("apps/api/src/router.ts", "createRouter");
const listPosts = symbolId("packages/db/src/queries.ts", "listPosts");
const slugify = symbolId("packages/utils/src/slug.ts", "slugify");
const formatDate = symbolId("packages/utils/src/date.ts", "formatRelativeDate");
const button = symbolId("packages/ui/src/button.tsx", "Button");
const card = symbolId("packages/ui/src/card.tsx", "Card");
const postList = symbolId("apps/web/src/components/PostList.tsx", "PostList");
const debounce = symbolId("apps/web/src/hooks/useDebounce.ts", "useDebounce");

const at = (id: string, hop: number, tier: Tier, via_hub = false) => ({ id, hop, tier, via_hub });

/** `count` more users that the mock map does not draw (route components), so the counts look like a real repo's. */
function routeUsers(tag: string, count: number, hop: number, tier: Tier, throughHub = 0) {
  return Array.from({ length: count }, (_, k) =>
    at(symbolId(`apps/web/src/routes/${tag}${k}.tsx`, `Page${tag}${k}`), hop, tier, k < throughHub),
  );
}

const byHopThenId = (a: { hop: number; id: string }, b: { hop: number; id: string }) =>
  a.hop - b.hop || (a.id < b.id ? -1 : 1);

function build(
  set: Omit<TeamChangeSet, "radius_total" | "nodes_total" | "radius"> & { radius: TeamChangeSet["radius"] },
) {
  const radius = [...set.radius].sort(byHopThenId);
  return {
    ...set,
    nodes: [...set.nodes].sort(),
    radius,
    nodes_total: set.nodes.length,
    radius_total: radius.length,
  };
}

const SETS: TeamChangeSet[] = [
  build({
    id: "cs:pr:acme/pnpm-turbo#214",
    source: "pr",
    state: "in_review",
    owner: "tomas",
    title: "Cap listPosts to one page of rows",
    pr: 214,
    nodes: [ROUTER_FILE, createRouter, QUERIES_FILE, listPosts],
    radius: [
      at(postList, 1, "direct"),
      at(debounce, 1, "direct"),
      ...routeUsers("a", 2, 1, "direct"),
      // Card is the one hop-3 entry that is not through a hub, so the hop-4 hub entry below can be named after it.
      at(card, 3, "potential"),
      // Button is reached through a hub too, but two entries sit one hop nearer, so its hub is not named.
      at(button, 3, "potential", true),
      ...routeUsers("b", 5, 2, "potential"),
      at(formatDate, 4, "reachable"),
      at(slugify, 4, "reachable", true),
      ...routeUsers("c", 10, 4, "reachable", 3).map((r, k) => ({ ...r, hop: 4 + (k % 3) })),
    ],
    map_nodes: ["ws:@acme/api", "ws:@acme/db"],
    direct_uses: [
      { id: postList, changed: [createRouter].sort() },
      { id: debounce, changed: [listPosts] },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  }),
  build({
    id: "cs:pr:acme/pnpm-turbo#221",
    source: "pr",
    state: "in_review",
    owner: "ines",
    title: "Fold the web slug copy into utils",
    pr: 221,
    nodes: [SLUG_FILE, slugify, DATE_FILE, formatDate],
    radius: [
      at(postList, 1, "direct"),
      at(createRouter, 1, "direct"),
      ...routeUsers("d", 3, 1, "direct"),
      at(button, 2, "potential"),
      ...routeUsers("e", 8, 2, "potential"),
      ...routeUsers("f", 14, 4, "reachable", 4).map((r, k) => ({ ...r, hop: 4 + (k % 3) })),
    ],
    map_nodes: ["ws:@acme/utils"],
    direct_uses: [
      { id: createRouter, changed: [slugify] },
      { id: postList, changed: [formatDate] },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  }),
  build({
    id: "cs:pr:acme/pnpm-turbo#226",
    source: "pr",
    state: "proposed",
    owner: "ines",
    title: "Show a busy state on Button while saving",
    pr: 226,
    nodes: [BUTTON_FILE, button, CARD_FILE, card],
    radius: [
      at(postList, 1, "direct"),
      ...routeUsers("g", 2, 1, "direct"),
      at(debounce, 2, "potential"),
      ...routeUsers("h", 5, 2, "potential"),
      ...routeUsers("i", 18, 4, "reachable", 5).map((r, k) => ({ ...r, hop: 4 + (k % 3) })),
    ],
    map_nodes: ["ws:@acme/ui"],
    direct_uses: [{ id: postList, changed: [button, card].sort() }],
  }),
];

/** `/api/team/layer` for the mock: the three pull requests with `scenario=team`, else no cache. */
export function mockTeamLayer(scenario: string | null): TeamLayerData {
  if (scenario !== "team") return { available: false, age_s: null, change_sets: [], people: [] };
  return {
    available: true,
    age_s: 12 * 60,
    change_sets: SETS,
    people: [...new Set(SETS.map((c) => c.owner))].sort(),
  };
}

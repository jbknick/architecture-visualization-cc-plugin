// Mock review (#44, on the map since #167) on the synthetic pnpm-turbo-like fixture: Button's props gain `size`,
// formatRelativeDate is renamed to formatTimeAgo, slugify is removed. The layer is placed on the mock project map the
// same way the server places it (the deepest node of the response that shows an id). Nothing here comes from a
// private project.
import type {
  GraphEdge,
  GraphNode,
  ReviewConsumer,
  ReviewConsumers,
  ReviewData,
  ReviewLayer,
  ReviewLink,
  ReviewMark,
  ReviewMarkKind,
} from "../src/api.ts";

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const DATE = "sym:packages/utils/src/date.ts#formatTimeAgo";
const DATE_BEFORE = "sym:packages/utils/src/date.ts#formatRelativeDate";
const SLUG = "sym:packages/utils/src/slug.ts#slugify";
const CARD = "sym:packages/ui/src/card.tsx#Card";
const POSTLIST = "sym:apps/web/src/components/PostList.tsx#PostList";
const HOME = "sym:apps/web/src/routes/index.tsx#HomePage";
const ROUTER = "sym:apps/api/src/router.ts#createRouter";

/** Where a map puts ids, and whether one node holds another. */
export interface MockPlacement {
  rep(id: string): string | undefined;
  contains(a: string, b: string): boolean;
}

const ORDER: ReviewMarkKind[] = ["removed", "signature", "moved", "modified", "added"];
const stronger = (a: ReviewMarkKind | undefined, b: ReviewMarkKind) =>
  a === undefined || ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a;

const changesOf: { id: string; ids: string[]; path: string; kind: ReviewMarkKind }[] = [
  { id: BUTTON, ids: [BUTTON], path: "packages/ui/src/button.tsx", kind: "signature" },
  { id: DATE, ids: [DATE, DATE_BEFORE], path: "packages/utils/src/date.ts", kind: "moved" },
  { id: SLUG, ids: [SLUG], path: "packages/utils/src/slug.ts", kind: "removed" },
];
/** Direct callers (store ids) of each change. HOME is not in the mock index: it has no node, like a filtered file. */
const direct: [string, string][] = [
  [CARD, BUTTON],
  [HOME, BUTTON],
  [POSTLIST, DATE],
  [ROUTER, SLUG],
];
const hops: [string, number][] = [
  [CARD, 1],
  [HOME, 1],
  [POSTLIST, 1],
  [ROUTER, 1],
  ["sym:apps/web/src/hooks/useDebounce.ts#useDebounce", 2],
];

const USE_DEBOUNCE = "sym:apps/web/src/hooks/useDebounce.ts#useDebounce";
const pathOfId = (id: string) =>
  id.startsWith("sym:") ? id.slice(4, id.lastIndexOf("#")) : id.startsWith("file:") ? id.slice(5) : "";
const WS: Record<string, string> = { apps: "@acme/web", packages: "@acme/ui" };

/** A consumer of the mock review, as the server sends it (names and paths only). */
function consumer(
  id: string,
  kind: string,
  hop: number,
  uses: ReviewConsumer["uses"],
  crosses: ReviewConsumer["crosses"],
  line: number | null,
  path = pathOfId(id),
  link?: { via: string; next: string },
): ReviewConsumer {
  const name = id.startsWith("sym:")
    ? id.slice(id.lastIndexOf("#") + 1)
    : id.startsWith("file:")
      ? path.slice(path.lastIndexOf("/") + 1)
      : id.split(":").slice(2).join(":");
  return {
    id,
    name,
    kind,
    path,
    line,
    workspace: WS[path.split("/")[0] ?? ""] ?? null,
    hop,
    uses,
    crosses,
    ...(link ?? {}),
  };
}

/** Directly and potentially affected consumers of each change and changed file (synthetic, like the rest). */
const CONSUMERS: Record<string, { direct: ReviewConsumer[]; potential: ReviewConsumer[] }> = {
  [BUTTON]: {
    direct: [
      consumer(CARD, "component", 1, ["renders"], [], 3),
      consumer(HOME, "component", 1, ["renders"], ["app"], 7),
    ],
    potential: [
      consumer("route:@acme/web:/", "route", 2, ["serves"], ["app"], null, "apps/web/src/routes/index.tsx", {
        via: HOME,
        next: HOME,
      }),
    ],
  },
  [DATE]: {
    direct: [consumer(POSTLIST, "component", 1, ["calls"], ["app"], 4)],
    potential: [
      consumer(USE_DEBOUNCE, "hook", 2, ["calls"], ["app"], 1, undefined, { via: POSTLIST, next: POSTLIST }),
    ],
  },
  [SLUG]: { direct: [consumer(ROUTER, "function", 1, ["calls"], ["app"], 5)], potential: [] },
  "file:packages/ui/src/button.tsx": {
    direct: [
      consumer("file:packages/ui/src/index.ts", "file", 1, ["imports"], [], null),
      consumer("file:apps/web/src/routes/index.tsx", "file", 1, ["imports"], ["app"], null),
    ],
    potential: [],
  },
};

/** The consumers of `id` with the nodes that show them on this map (itself, else its file). */
function consumersOn(id: string, place: MockPlacement): ReviewConsumers {
  const c = CONSUMERS[id] ?? { direct: [], potential: [] };
  const nodeOf = (x: string, path: string) => place.rep(x) ?? (path ? place.rep(`file:${path}`) : undefined);
  const all = [...c.direct, ...c.potential];
  const row = (x: ReviewConsumer): ReviewConsumer => {
    const node = nodeOf(x.id, x.path);
    const next = x.next ? all.find((y) => y.id === x.next) : undefined;
    const nextNode = x.next ? nodeOf(x.next, next?.path ?? pathOfId(x.next)) : undefined;
    return { ...x, ...(node ? { node } : {}), ...(nextNode ? { nextNode } : {}) };
  };
  return {
    direct: c.direct.map(row),
    directTotal: c.direct.length,
    potential: c.potential.map(row),
    potentialTotal: c.potential.length,
  };
}

export function reviewLayer(place: MockPlacement): ReviewLayer {
  const marks = new Map<string, ReviewMark>();
  const markOf = (id: string) => {
    const m = marks.get(id) ?? { id };
    marks.set(id, m);
    return m;
  };
  const placed = new Map<string, string>();
  const nodeOf = new Map<string, string>();
  const unplaced: string[] = [];
  for (const c of changesOf) {
    const node = [...c.ids, `file:${c.path}`].map((id) => place.rep(id)).find((x) => x !== undefined);
    if (!node) {
      unplaced.push(c.id);
      continue;
    }
    placed.set(c.id, node);
    nodeOf.set(c.id, node);
    const m = markOf(node);
    m.change = stronger(m.change, c.kind);
    m.changes = (m.changes ?? 0) + 1;
  }
  for (const c of changesOf) {
    const node = place.rep(`file:${c.path}`);
    if (node && !placed.has(`file:${c.path}`)) placed.set(`file:${c.path}`, node);
    if (node) {
      const m = markOf(node);
      if (!m.change) m.change = "modified";
    }
  }
  for (const key of Object.keys(CONSUMERS).sort()) {
    const c = consumersOn(key, place);
    for (const x of [...c.direct, ...c.potential]) if (x.node && !placed.has(x.id)) placed.set(x.id, x.node);
  }
  for (const [id, hop] of hops) {
    const node = place.rep(id);
    if (!node) continue;
    const m = markOf(node);
    if (m.change) continue;
    m.hop = Math.min(m.hop ?? hop, hop);
  }
  const links = new Map<string, ReviewLink>();
  for (const [src0, dst0] of direct) {
    const src = place.rep(src0);
    const dst = nodeOf.get(dst0);
    const kind = changesOf.find((c) => c.id === dst0)?.kind;
    if (!src || !dst || !kind || src === dst || place.contains(src, dst) || place.contains(dst, src))
      continue;
    const id = `${src}->${dst}`;
    const l = links.get(id);
    if (l) {
      l.weight += 1;
      l.change = stronger(l.change, kind);
    } else links.set(id, { id, src, dst, change: kind, weight: 1 });
  }
  const sorted = [...links.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    marks: [...marks.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    links: sorted,
    linksTotal: sorted.length,
    placed: [...placed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    unplaced,
  };
}

/** A range the mock accepts, or the server's message for one it does not. */
export function checkRange(range: string): string | null {
  return range.includes("...") || range.includes("..") ? null : `expected <base>...<head>, got "${range}"`;
}

export function reviewData(
  range: string,
  map: "2d" | "3d",
  place: MockPlacement,
  mode: "map" | "rings" = "map",
): ReviewData {
  return {
    range,
    base: range.split("...")[0] ?? "main",
    head: range.split("...")[1] ?? "feature",
    mergeBase: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    headSha: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678",
    mode,
    map,
    files: [
      {
        path: "packages/ui/src/button.tsx",
        status: "M",
        changes: 1,
        consumers: consumersOn("file:packages/ui/src/button.tsx", place),
      },
      {
        path: "packages/utils/src/date.ts",
        status: "M",
        changes: 1,
        consumers: consumersOn("file:packages/utils/src/date.ts", place),
      },
      {
        path: "packages/utils/src/slug.ts",
        status: "D",
        changes: 1,
        consumers: consumersOn("file:packages/utils/src/slug.ts", place),
      },
    ],
    changes: [
      {
        id: BUTTON,
        kind: "modified",
        name: "Button",
        symbolKind: "component",
        path: "packages/ui/src/button.tsx",
        line: 1,
        signatureChanged: true,
        exportedChanged: false,
        locDelta: 0,
        before: {
          id: BUTTON,
          path: "packages/ui/src/button.tsx",
          line: 1,
          signature: "function Button({ label, onClick }: { label: string; onClick?: () => void })",
          exported: true,
        },
        after: {
          id: BUTTON,
          path: "packages/ui/src/button.tsx",
          line: 1,
          signature:
            "function Button({ label, onClick, size }: { label: string; onClick?: () => void; size?: number })",
          exported: true,
        },
        callers: 2,
        consumers: consumersOn(BUTTON, place),
        untrusted_description: "Renders a labelled button.",
      },
      {
        id: DATE,
        kind: "renamed",
        name: "formatTimeAgo",
        symbolKind: "function",
        path: "packages/utils/src/date.ts",
        line: 1,
        signatureChanged: true,
        exportedChanged: false,
        locDelta: 0,
        before: {
          id: DATE_BEFORE,
          path: "packages/utils/src/date.ts",
          line: 1,
          signature: "function formatRelativeDate(d: Date): string",
          exported: true,
        },
        after: {
          id: DATE,
          path: "packages/utils/src/date.ts",
          line: 1,
          signature: "function formatTimeAgo(d: Date): string",
          exported: true,
        },
        callers: 1,
        consumers: consumersOn(DATE, place),
        untrusted_description: null,
      },
      {
        id: SLUG,
        kind: "removed",
        name: "slugify",
        symbolKind: "function",
        path: "packages/utils/src/slug.ts",
        line: 1,
        signatureChanged: false,
        exportedChanged: false,
        locDelta: -4,
        before: {
          id: SLUG,
          path: "packages/utils/src/slug.ts",
          line: 1,
          signature: "function slugify(s: string): string",
          exported: true,
        },
        callers: 1,
        consumers: consumersOn(SLUG, place),
        untrusted_description: null,
      },
    ],
    callersByHop: [
      { hop: 1, count: 4 },
      { hop: 2, count: 1 },
    ],
    crossings: [
      { from: BUTTON, to: HOME, kind: "app" },
      { from: DATE, to: POSTLIST, kind: "app" },
    ],
    risk: {
      score: 56,
      level: "medium",
      reasons: [
        "+30 signature changed on an exported symbol",
        "+6 3 direct callers",
        "+10 2 boundary crossings",
        "+10 changed function in a file no test imports",
      ],
    },
    rules: [],
    levels: { medium: 30, high: 60 },
    notes: ['New undeclared import "left-pad" in packages/utils/src/date.ts:1.'],
    layer: reviewLayer(place),
    ms: 42,
    cached: false,
  };
}

// ---- Rings mode: positions follow the server's rule (files grouped, one empty slot between files). ----

const ringPos = (i: number, n: number, h: number, r: number) => {
  if (r === 0) return { x: 0, y: 0 };
  const a = -Math.PI / 2 + (2 * Math.PI * (i + (h % 2 === 0 ? 0.5 : 0.25))) / n;
  return { x: Math.round(r * Math.cos(a) * 10) / 10, y: Math.round(r * Math.sin(a) * 10) / 10 };
};
const pathOf = (id: string) => id.slice(4, id.lastIndexOf("#"));
const nameOf = (id: string) => id.slice(id.lastIndexOf("#") + 1);
const RING0: { id: string; kind: string; change: "modified" | "renamed" | "removed"; sig: boolean }[] = [
  { id: BUTTON, kind: "component", change: "modified", sig: true },
  { id: DATE, kind: "function", change: "renamed", sig: true },
  { id: SLUG, kind: "function", change: "removed", sig: false },
];
const RING1 = [CARD, HOME, POSTLIST, ROUTER];
const RING2 = ["sym:apps/web/src/hooks/useDebounce.ts#useDebounce"];

function slotsOf(ids: string[]): { n: number; at: Map<string, number> } {
  const sorted = [...ids].sort((a, b) =>
    pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : a < b ? -1 : 1,
  );
  const at = new Map<string, number>();
  let slot = 0;
  let last: string | undefined;
  for (const id of sorted) {
    if (last !== undefined && pathOf(id) !== last) slot += 1;
    at.set(id, slot++);
    last = pathOf(id);
  }
  return { n: slot + (new Set(sorted.map(pathOf)).size > 1 ? 1 : 0), at };
}

export function ringNodes(): GraphNode[] {
  const nodes: GraphNode[] = [];
  const s0 = slotsOf(RING0.map((c) => c.id));
  for (const c of RING0)
    nodes.push({
      id: c.id,
      kind: c.kind,
      label: nameOf(c.id),
      path: pathOf(c.id),
      group: pathOf(c.id),
      size: 1,
      hop: 0,
      change: c.change,
      signatureChanged: c.sig,
      ...ringPos(s0.at.get(c.id) ?? 0, s0.n, 0, 70),
    });
  for (const [h, ring] of [
    [1, RING1],
    [2, RING2],
  ] as const) {
    const s = slotsOf([...ring]);
    for (const id of ring)
      nodes.push({
        id,
        kind: "component",
        label: nameOf(id),
        path: pathOf(id),
        group: pathOf(id),
        size: 1,
        hop: h,
        ...ringPos(s.at.get(id) ?? 0, s.n, h, 70 + 150 * h),
      });
  }
  return nodes;
}

const edge = (src: string, dst: string, kind = "renders"): GraphEdge => ({
  id: `${src}->${dst}`,
  src,
  dst,
  kind,
  weight: 1,
  confidence: "high",
});

export const ringEdges: GraphEdge[] = [
  edge(CARD, BUTTON),
  edge(HOME, BUTTON),
  edge(POSTLIST, DATE, "calls"),
  edge(ROUTER, SLUG, "calls"),
  edge("sym:apps/web/src/hooks/useDebounce.ts#useDebounce", POSTLIST, "calls"),
];

/** Rings mode of the mock review view: the ring nodes are the layer's nodes. */
export function ringsView(range: string) {
  const nodes = ringNodes();
  const ids = new Set(nodes.map((n) => n.id));
  const review = reviewData(
    range,
    "2d",
    { rep: (id) => (ids.has(id) ? id : undefined), contains: () => false },
    "rings",
  );
  return {
    nodes,
    edges: ringEdges,
    layoutHint: "review",
    review: { ...review, edgesTotal: ringEdges.length },
  };
}

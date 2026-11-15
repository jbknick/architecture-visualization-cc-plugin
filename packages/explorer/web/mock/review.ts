// Mock answer of the review view (#44) on the synthetic pnpm-turbo-like fixture: Button's props gain `size`,
// formatRelativeDate is renamed, slugify is removed. Positions follow the server's ring rule (radius by ring, angle by
// id order). Nothing here comes from a private project.
import type { GraphEdge, GraphNode, ReviewData, ViewData } from "../src/api.ts";

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const DATE = "sym:packages/utils/src/date.ts#formatTimeAgo";
const SLUG = "sym:packages/utils/src/slug.ts#slugify";
const CARD = "sym:packages/ui/src/card.tsx#Card";
const POSTLIST = "sym:apps/web/src/components/PostList.tsx#PostList";
const HOME = "sym:apps/web/src/routes/index.tsx#HomePage";
const ABOUT = "sym:apps/web/src/routes/about.tsx#AboutPage";
const ROOT = "sym:apps/web/src/routes/__root.tsx#RootLayout";

const pos = (i: number, n: number, h: number, r: number) => {
  if (r === 0) return { x: 0, y: 0 };
  const a = -Math.PI / 2 + (2 * Math.PI * (i + (h % 2 === 0 ? 0.5 : 0.25))) / n;
  return { x: Math.round(r * Math.cos(a) * 10) / 10, y: Math.round(r * Math.sin(a) * 10) / 10 };
};

const ring0: { id: string; kind: string; change: string; sig: boolean; path: string }[] = [
  { id: BUTTON, kind: "component", change: "modified", sig: true, path: "packages/ui/src/button.tsx" },
  { id: DATE, kind: "function", change: "renamed", sig: true, path: "packages/utils/src/date.ts" },
  { id: SLUG, kind: "function", change: "removed", sig: false, path: "packages/utils/src/slug.ts" },
];
const ring1 = [CARD, HOME, POSTLIST];
const ring2 = [ABOUT, ROOT];

export function reviewNodes(): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const [i, c] of ring0.entries()) {
    nodes.push({
      id: c.id,
      kind: c.kind,
      label: c.id.slice(c.id.lastIndexOf("#") + 1),
      path: c.path,
      size: 1,
      hop: 0,
      change: c.change,
      signatureChanged: c.sig,
      ...pos(i, ring0.length, 0, 70),
    });
  }
  for (const [h, ring] of [
    [1, ring1],
    [2, ring2],
  ] as const) {
    for (const [i, id] of ring.entries()) {
      nodes.push({
        id,
        kind: "component",
        label: id.slice(id.lastIndexOf("#") + 1),
        path: id.slice(4, id.lastIndexOf("#")),
        size: 1,
        hop: h,
        ...pos(i, ring.length, h, 70 + 150 * h),
      });
    }
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

export const reviewEdges: GraphEdge[] = [
  edge(CARD, BUTTON),
  edge(HOME, BUTTON),
  edge(POSTLIST, DATE, "calls"),
  edge(ABOUT, CARD),
  edge(ROOT, HOME),
];

export function reviewData(range: string, mode: "rings" | "overlay"): ReviewData {
  return {
    range,
    base: range.split("...")[0] ?? "main",
    head: range.split("...")[1] ?? "feature",
    mergeBase: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    headSha: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678",
    mode,
    files: [
      { path: "packages/ui/src/button.tsx", status: "M", changes: 1 },
      { path: "packages/utils/src/date.ts", status: "M", changes: 1 },
      { path: "packages/utils/src/slug.ts", status: "D", changes: 1 },
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
          id: "sym:packages/utils/src/date.ts#formatRelativeDate",
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
        callers: 0,
        untrusted_description: null,
      },
    ],
    callersByHop: [
      { hop: 1, count: ring1.length },
      { hop: 2, count: ring2.length },
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
    edgesTotal: reviewEdges.length,
    ms: 42,
    cached: false,
  };
}

/** Workspaces and files of the overlay mode, with the changed and affected files marked. */
export function overlayNodes(): GraphNode[] {
  const ws = (id: string, label: string): GraphNode => ({ id, kind: "workspace", label, size: 0 });
  const file = (
    path: string,
    parent: string,
    size: number,
    mark?: "changed" | "affected",
    change?: string,
  ) => ({
    id: `file:${path}`,
    kind: "file",
    label: path.slice(path.lastIndexOf("/") + 1),
    path,
    parent,
    size,
    ...(mark ? { mark } : {}),
    ...(change ? { change } : {}),
  });
  return [
    ws("ws:@acme/api", "@acme/api"),
    ws("ws:@acme/web", "@acme/web"),
    ws("ws:@acme/db", "@acme/db"),
    ws("ws:@acme/ui", "@acme/ui"),
    ws("ws:@acme/utils", "@acme/utils"),
    file("apps/api/src/router.ts", "ws:@acme/api", 3),
    file("apps/web/src/components/PostList.tsx", "ws:@acme/web", 2, "affected"),
    file("apps/web/src/routes/index.tsx", "ws:@acme/web", 2, "affected"),
    file("apps/web/src/routes/about.tsx", "ws:@acme/web", 1, "affected"),
    file("apps/web/src/hooks/useDebounce.ts", "ws:@acme/web", 1),
    file("packages/db/src/queries.ts", "ws:@acme/db", 2),
    file("packages/ui/src/button.tsx", "ws:@acme/ui", 1, "changed", "modified"),
    file("packages/ui/src/card.tsx", "ws:@acme/ui", 1, "affected"),
    file("packages/utils/src/date.ts", "ws:@acme/utils", 1, "changed", "renamed"),
  ];
}

export function reviewView(
  options: Record<string, unknown>,
): { status: number; error: string } | (ViewData & { review: ReviewData | null }) {
  const range = typeof options.range === "string" ? options.range : "";
  if (!range) return { nodes: [], edges: [], layoutHint: "radial", review: null };
  if (!range.includes("...") && !range.includes(".."))
    return { status: 400, error: `expected <base>...<head>, got "${range}"` };
  const mode = options.mode === "overlay" ? "overlay" : "rings";
  return mode === "overlay"
    ? { nodes: overlayNodes(), edges: [], layoutHint: "radial", review: reviewData(range, mode) }
    : { nodes: reviewNodes(), edges: reviewEdges, layoutHint: "radial", review: reviewData(range, mode) };
}

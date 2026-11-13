// Tiny pnpm-turbo-like graph served by the mock API (component tests and the Playwright smoke test).
// Shapes follow the #33 server contract. The content is synthetic.
import type { GraphEdge, GraphNode, Meta, NodeDetail, SearchHit } from "../src/api.ts";

export const meta: Meta = {
  repo: "pnpm-turbo",
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  counts: { files: 24, symbols: 61, edges: 148, backlog: 12, workingFiles: 2 },
  views: [
    { id: "debug", title: "Debug", enabled: true },
    { id: "architecture", title: "Architecture", enabled: false },
    { id: "flow", title: "Request flow", enabled: false },
    { id: "reuse", title: "Reuse", enabled: false },
    { id: "review", title: "Review", enabled: false },
  ],
};

const ws = (name: string, size = 6): GraphNode => ({
  id: `ws:${name}`,
  kind: "workspace",
  label: name,
  size,
});

export const workspaces: GraphNode[] = [
  ws("@acme/web", 14),
  ws("@acme/api", 10),
  ws("@acme/ui", 8),
  ws("@acme/utils", 7),
  ws("@acme/db", 6),
];

const dep = (src: string, dst: string): GraphEdge => ({
  id: `${src}>depends_on>${dst}`,
  src: `ws:${src}`,
  dst: `ws:${dst}`,
  kind: "depends_on",
  weight: 1,
  confidence: "high",
});

export const dependsOn: GraphEdge[] = [
  dep("@acme/web", "@acme/ui"),
  dep("@acme/web", "@acme/utils"),
  dep("@acme/api", "@acme/db"),
  dep("@acme/api", "@acme/utils"),
  dep("@acme/ui", "@acme/utils"),
];

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const CARD = "sym:packages/ui/src/card.tsx#Card";
const DATE = "sym:packages/utils/src/date.ts#formatRelativeDate";
const POSTLIST = "sym:apps/web/src/components/PostList.tsx#PostList";

export const symbols: SearchHit[] = [
  {
    id: BUTTON,
    name: "Button",
    kind: "component",
    path: "packages/ui/src/button.tsx",
    line: 1,
    exported: true,
  },
  { id: CARD, name: "Card", kind: "component", path: "packages/ui/src/card.tsx", line: 1, exported: true },
  {
    id: DATE,
    name: "formatRelativeDate",
    kind: "function",
    path: "packages/utils/src/date.ts",
    line: 1,
    exported: true,
  },
  {
    id: POSTLIST,
    name: "PostList",
    kind: "component",
    path: "apps/web/src/components/PostList.tsx",
    line: 1,
    exported: true,
  },
];

export const sources: Record<string, string> = {
  "packages/ui/src/button.tsx": `// Primary action button
export function Button({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  );
}
`,
  "packages/ui/src/card.tsx": `export function Card({ title }: { title: string }) {
  return <div className="card">{title}</div>;
}
`,
  "packages/utils/src/date.ts": `export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days > 0) return \`\${days}d ago\`;
  return "just now";
}
`,
  "apps/web/src/components/PostList.tsx": `export function PostList() {
  return <ul />;
}
`,
};

function detail(
  hit: SearchHit,
  signature: string,
  description: string | null,
  neighbors: NodeDetail["neighbors"],
  fan: [number, number],
): NodeDetail {
  return {
    node: { id: hit.id, kind: hit.kind, label: hit.name, size: 1 },
    signature,
    fan_in: fan[0],
    fan_out: fan[1],
    neighbors,
    untrusted_description: description,
    provenance: description ? { source: "model", model: "claude-haiku" } : undefined,
    path: hit.path,
    line: hit.line,
    end_line: hit.line + (sources[hit.path]?.split("\n").length ?? 1) - 2,
  };
}

const [button, card, date, postList] = symbols as [SearchHit, SearchHit, SearchHit, SearchHit];

export const nodeDetails: Record<string, NodeDetail> = {
  [BUTTON]: detail(
    button,
    "function Button({ label, onClick }: { label: string; onClick?: () => void }): JSX.Element",
    "Renders a clickable button with the given label.",
    { renders: [], contains: ["file:packages/ui/src/button.tsx"], imports: [], references_type: [] },
    [3, 0],
  ),
  [CARD]: detail(card, "function Card({ title }: { title: string }): JSX.Element", null, {}, [1, 0]),
  [DATE]: detail(
    date,
    "function formatRelativeDate(date: Date, now?: Date): string",
    "Formats a date as a short relative phrase such as 3d ago.",
    { calls: [], contains: ["file:packages/utils/src/date.ts"] },
    [2, 0],
  ),
  [POSTLIST]: detail(
    postList,
    "function PostList(): JSX.Element",
    "Lists posts.",
    { renders: [BUTTON, CARD], uses_hook: [], contains: ["file:apps/web/src/components/PostList.tsx"] },
    [0, 2],
  ),
};

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Pure request handler shared by the node:http mock server and the in-process fetch mock. */
export function handleMockApi(url: URL): MockResponse | null {
  const path = url.pathname;
  if (path === "/api/meta") return { status: 200, body: meta };

  if (path.startsWith("/api/view/")) {
    const focus = url.searchParams.get("focus");
    const nodes = [...workspaces];
    const edges = [...dependsOn];
    const focusHit = symbols.find((s) => s.id === focus);
    if (focusHit) nodes.push({ id: focusHit.id, kind: focusHit.kind, label: focusHit.name, size: 1 });
    return { status: 200, body: { nodes, edges, layoutHint: "list" } };
  }

  if (path.startsWith("/api/node/")) {
    const found = nodeDetails[decodeURIComponent(path.slice("/api/node/".length))];
    return found ? { status: 200, body: found } : { status: 404, body: { error: "not found" } };
  }

  if (path === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const hits = q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : [];
    return { status: 200, body: { hits } };
  }

  if (path === "/api/source") {
    const text = sources[url.searchParams.get("path") ?? ""];
    if (text === undefined) return { status: 404, body: { error: "not found" } };
    const start = Number(url.searchParams.get("start") ?? 1);
    const end = Number(url.searchParams.get("end") ?? start + 39);
    const lines = text
      .replace(/\n$/, "")
      .split("\n")
      .slice(start - 1, end);
    return { status: 200, body: { start, lines } };
  }

  return null;
}

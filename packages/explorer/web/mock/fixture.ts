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
    { id: "map-3d", title: "3D map", enabled: true },
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

// ---- map-3d dataset: 5 workspaces, 60 files, weighted cross-workspace imports (synthetic) ----------------------

const M3_WS: { name: string; kind: "app" | "package"; dirs: string[]; files: string[] }[] = [
  {
    name: "@acme/web",
    kind: "app",
    dirs: ["src/routes", "src/components", "src/hooks", "src/lib"],
    files: [
      "src/routes/index.tsx",
      "src/routes/__root.tsx",
      "src/routes/posts.tsx",
      "src/routes/post.tsx",
      "src/routes/settings.tsx",
      "src/routes/profile.tsx",
      "src/routes/login.tsx",
      "src/routes/feed.tsx",
      "src/components/PostList.tsx",
      "src/components/Header.tsx",
      "src/components/Footer.tsx",
      "src/components/Sidebar.tsx",
      "src/components/Avatar.tsx",
      "src/components/Toast.tsx",
      "src/hooks/useDebounce.ts",
      "src/hooks/useAuth.ts",
      "src/hooks/usePosts.ts",
      "src/hooks/useTheme.ts",
      "src/lib/slug.ts",
      "src/lib/client.ts",
      "src/lib/format.ts",
      "src/lib/session.ts",
    ],
  },
  {
    name: "@acme/api",
    kind: "app",
    dirs: ["src/routes", "src/services", "src/middleware"],
    files: [
      "src/index.ts",
      "src/app.ts",
      "src/routes/posts.ts",
      "src/routes/users.ts",
      "src/routes/auth.ts",
      "src/services/postService.ts",
      "src/services/userService.ts",
      "src/services/mailer.ts",
      "src/middleware/auth.ts",
      "src/middleware/logging.ts",
      "src/middleware/errors.ts",
      "src/router.ts",
    ],
  },
  {
    name: "@acme/ui",
    kind: "package",
    dirs: ["src"],
    files: [
      "src/index.ts",
      "src/button.tsx",
      "src/card.tsx",
      "src/input.tsx",
      "src/modal.tsx",
      "src/select.tsx",
      "src/tabs.tsx",
      "src/tooltip.tsx",
      "src/internal.ts",
      "src/theme.ts",
    ],
  },
  {
    name: "@acme/utils",
    kind: "package",
    dirs: ["src"],
    files: [
      "src/index.ts",
      "src/date.ts",
      "src/slug.ts",
      "src/time.ts",
      "src/array.ts",
      "src/string.ts",
      "src/math.ts",
      "src/validate.ts",
    ],
  },
  {
    name: "@acme/db",
    kind: "package",
    dirs: ["src"],
    files: [
      "src/index.ts",
      "src/schema.ts",
      "src/queries.ts",
      "src/client.ts",
      "src/migrate.ts",
      "src/seed.ts",
      "src/types.ts",
      "src/pool.ts",
    ],
  },
];

const m3hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const WS_DIR: Record<string, string> = {
  "@acme/web": "apps/web",
  "@acme/api": "apps/api",
  "@acme/ui": "packages/ui",
  "@acme/utils": "packages/utils",
  "@acme/db": "packages/db",
};

interface M3File {
  id: string;
  path: string;
  ws: string;
  dir: string;
  fns: number;
}

const m3Files: M3File[] = M3_WS.flatMap((w) =>
  w.files.map((f) => {
    const path = `${WS_DIR[w.name]}/${f}`;
    const segs = f.split("/");
    return {
      id: `file:${path}`,
      path,
      ws: `ws:${w.name}`,
      dir: segs.length > 1 ? segs.slice(0, -1).join("/") : ".",
      fns: 1 + (m3hash(path) % 11) + (f.includes("routes") || f.includes("services") ? 6 : 0),
    };
  }),
);

/** Deterministic imports: heavy web -> ui/utils, api -> db/utils, ui -> utils, db -> utils, plus local ones. */
const m3Imports: { src: string; dst: string; w: number }[] = (() => {
  const out = new Map<string, number>();
  const byWs = new Map<string, M3File[]>();
  for (const f of m3Files) byWs.set(f.ws, [...(byWs.get(f.ws) ?? []), f]);
  const pick = (ws: string, seed: string): M3File => {
    const list = byWs.get(ws) as M3File[];
    return list[m3hash(seed) % list.length] as M3File;
  };
  const rules: [string, string, number][] = [
    ["ws:@acme/web", "ws:@acme/ui", 2],
    ["ws:@acme/web", "ws:@acme/utils", 1],
    ["ws:@acme/web", "ws:@acme/api", 1],
    ["ws:@acme/api", "ws:@acme/db", 2],
    ["ws:@acme/api", "ws:@acme/utils", 1],
    ["ws:@acme/ui", "ws:@acme/utils", 1],
    ["ws:@acme/db", "ws:@acme/utils", 1],
  ];
  for (const f of m3Files) {
    for (const [from, to, n] of rules) {
      if (f.ws !== from) continue;
      for (let k = 0; k < n; k++) {
        const t = pick(to, `${f.id}>${to}>${k}`);
        if (m3hash(`${f.id}${to}${k}`) % 3 !== 0)
          out.set(`${f.id}|${t.id}`, 1 + (m3hash(`${f.id}${t.id}`) % 4));
      }
    }
    // a couple of local imports per file
    const mates = byWs.get(f.ws) as M3File[];
    for (let k = 0; k < 2; k++) {
      const t = mates[m3hash(`${f.id}local${k}`) % mates.length] as M3File;
      if (t.id !== f.id) out.set(`${f.id}|${t.id}`, 1 + (m3hash(`${f.id}${t.id}x`) % 3));
    }
  }
  return [...out].map(([k, w]) => {
    const [src, dst] = k.split("|") as [string, string];
    return { src, dst, w };
  });
})();

export function map3dView(level: string): { nodes: GraphNode[]; edges: GraphEdge[]; layoutHint: string } {
  const wsNodes: GraphNode[] = M3_WS.map((w) => {
    const fs = m3Files.filter((f) => f.ws === `ws:${w.name}`);
    const fns = fs.reduce((a, f) => a + f.fns, 0);
    return {
      id: `ws:${w.name}`,
      kind: "workspace",
      label: w.name,
      size: fns,
      badges: [w.kind, `${fs.length} files`, `${fns} functions`],
    };
  });
  const nodeOf = new Map<string, string>();
  const nodes: GraphNode[] = [...wsNodes];
  if (level === "workspaces") {
    for (const f of m3Files) nodeOf.set(f.id, f.ws);
  } else if (level === "files") {
    for (const f of m3Files) {
      nodeOf.set(f.id, f.id);
      nodes.push({
        id: f.id,
        kind: "file",
        label: f.path.slice(f.path.lastIndexOf("/") + 1),
        parent: f.ws,
        size: f.fns,
        badges: [`${f.fns} functions`],
      });
    }
  } else {
    const dirs = new Map<string, GraphNode>();
    for (const f of m3Files) {
      const id = `dir:${f.ws}:${f.dir}`;
      nodeOf.set(f.id, id);
      const d = dirs.get(id) ?? { id, kind: "dir", label: f.dir, parent: f.ws, size: 0, badges: [] };
      d.size += f.fns;
      dirs.set(id, d);
    }
    nodes.push(...dirs.values());
  }
  const sum = new Map<string, GraphEdge>();
  for (const e of m3Imports) {
    const a = nodeOf.get(e.src);
    const b = nodeOf.get(e.dst);
    if (!a || !b || a === b) continue;
    const id = `${a}|imports|${b}`;
    const cur = sum.get(id);
    if (cur) cur.weight += e.w;
    else sum.set(id, { id, src: a, dst: b, kind: "imports", weight: e.w, confidence: "high" });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...sum.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { nodes, edges, layoutHint: "force-3d" };
}

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Pure request handler shared by the node:http mock server and the in-process fetch mock. */
export function handleMockApi(url: URL): MockResponse | null {
  const path = url.pathname;
  if (path === "/api/meta") return { status: 200, body: meta };

  if (path === "/api/view/map-3d") {
    // The shell sends level (like every filter) inside the `filters` param.
    const filters = new URLSearchParams(url.searchParams.get("filters") ?? "");
    return { status: 200, body: map3dView(url.searchParams.get("level") ?? filters.get("level") ?? "dirs") };
  }

  if (path.startsWith("/api/view/")) {
    const focus = url.searchParams.get("focus");
    const nodes = [...workspaces];
    const edges = [...dependsOn];
    const focusHit = symbols.find((s) => s.id === focus);
    if (focusHit) nodes.push({ id: focusHit.id, kind: focusHit.kind, label: focusHit.name, size: 1 });
    return { status: 200, body: { nodes, edges, layoutHint: "list" } };
  }

  if (path.startsWith("/api/node/")) {
    const nodeId = decodeURIComponent(path.slice("/api/node/".length));
    const wsNode = nodeId.startsWith("ws:")
      ? map3dView("workspaces").nodes.find((n) => n.id === nodeId)
      : undefined;
    if (wsNode) {
      const detail: NodeDetail = {
        node: wsNode,
        signature: "",
        fan_in: 0,
        fan_out: 0,
        neighbors: {},
        untrusted_description: null,
        path: WS_DIR[wsNode.label],
      };
      return { status: 200, body: detail };
    }
    const found = nodeDetails[nodeId];
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

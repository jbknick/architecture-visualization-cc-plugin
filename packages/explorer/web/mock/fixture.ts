// A tiny pnpm-turbo-like repo served by the mock API (component tests and the mock dev server).
// Response shapes mirror the real server (packages/explorer/server/{api,types}.ts and views/*): if one
// changes there, change it here too. The content is synthetic. The real-server end-to-end test lives in e2e/.
import type {
  GraphEdge,
  GraphNode,
  Meta,
  NeighborRef,
  NodeDetail,
  SearchHit,
  ViewData,
  ViewLevel,
} from "../src/api.ts";
import { generateSynthetic } from "../src/canvas/synthetic.ts";
import { buildHierarchy } from "./hierarchy.ts";
import { egoHub, hubNode } from "./hubEgo.ts";
import { largeMapNode, projectMapLarge } from "./largeMap.ts";

export const meta: Meta = {
  repo: "pnpm-turbo",
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  counts: { workspaces: 5, files: 9, symbols: 9, edges: 31 },
  views: [
    { id: "debug", title: "Debug: workspaces", enabled: true },
    { id: "project-map", title: "Project map", enabled: true },
    { id: "ego", title: "Function ego graph", enabled: true },
    { id: "map-3d", title: "3D map", enabled: true },
  ],
};

interface MockWorkspace {
  name: string;
  dir: string;
  kind: "app" | "package";
}
interface MockSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  endLine: number;
}
interface MockFile {
  path: string;
  ws: string;
  symbols: MockSymbol[];
  source: string;
}

const WORKSPACES: MockWorkspace[] = [
  { name: "@acme/api", dir: "apps/api", kind: "app" },
  { name: "@acme/db", dir: "packages/db", kind: "package" },
  { name: "@acme/ui", dir: "packages/ui", kind: "package" },
  { name: "@acme/utils", dir: "packages/utils", kind: "package" },
  { name: "@acme/web", dir: "apps/web", kind: "app" },
];

const sym = (name: string, kind: string, line: number, endLine: number, exported = true): MockSymbol => ({
  name,
  kind,
  exported,
  line,
  endLine,
});

const FILES: MockFile[] = [
  {
    path: "apps/api/src/router.ts",
    ws: "@acme/api",
    symbols: [sym("createRouter", "function", 1, 4)],
    source: `export function createRouter() {
  return listPosts();
}
`,
  },
  {
    path: "apps/web/src/components/PostList.tsx",
    ws: "@acme/web",
    symbols: [sym("PostList", "component", 1, 8)],
    source: `export function PostList() {
  return (
    <ul>
      <Card title={formatRelativeDate(new Date())} />
      <Button label="More" />
    </ul>
  );
}
`,
  },
  {
    path: "apps/web/src/hooks/useDebounce.ts",
    ws: "@acme/web",
    symbols: [sym("useDebounce", "hook", 1, 3)],
    source: `export function useDebounce<T>(value: T): T {
  return value;
}
`,
  },
  {
    path: "packages/db/src/queries.ts",
    ws: "@acme/db",
    symbols: [sym("listPosts", "function", 1, 3)],
    source: `export function listPosts() {
  return [];
}
`,
  },
  {
    path: "packages/ui/src/button.tsx",
    ws: "@acme/ui",
    symbols: [sym("Button", "component", 2, 8)],
    source: `// Primary action button
export function Button({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  );
}
`,
  },
  {
    path: "packages/ui/src/button.test.tsx",
    ws: "@acme/ui",
    symbols: [sym("buttonTest", "function", 1, 3, false)],
    source: `export function buttonTest() {
  return Button;
}
`,
  },
  {
    path: "packages/ui/src/card.tsx",
    ws: "@acme/ui",
    symbols: [sym("Card", "component", 1, 3)],
    source: `export function Card({ title }: { title: string }) {
  return <div className="card">{title}</div>;
}
`,
  },
  {
    path: "packages/utils/src/date.ts",
    ws: "@acme/utils",
    symbols: [sym("formatRelativeDate", "function", 1, 6)],
    source: `export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days > 0) return \`\${days}d ago\`;
  return "just now";
}
`,
  },
  {
    path: "packages/utils/src/slug.ts",
    ws: "@acme/utils",
    symbols: [sym("slugify", "function", 1, 3)],
    source: `export function slugify(text: string): string {
  return text.toLowerCase().replace(/\\s+/g, "-");
}
`,
  },
];

const wsId = (name: string) => `ws:${name}`;
const fileId = (path: string) => `file:${path}`;
const symId = (path: string, name: string) => `sym:${path}#${name}`;
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isTest = (path: string) => /\.(test|spec)\./.test(path);

export const ids = {
  button: symId("packages/ui/src/button.tsx", "Button"),
  card: symId("packages/ui/src/card.tsx", "Card"),
  date: symId("packages/utils/src/date.ts", "formatRelativeDate"),
  postList: symId("apps/web/src/components/PostList.tsx", "PostList"),
  useDebounce: symId("apps/web/src/hooks/useDebounce.ts", "useDebounce"),
  createRouter: symId("apps/api/src/router.ts", "createRouter"),
  listPosts: symId("packages/db/src/queries.ts", "listPosts"),
  buttonFile: fileId("packages/ui/src/button.tsx"),
  uiWs: wsId("@acme/ui"),
  uiSrcDir: "dir:packages/ui/src",
};

interface MockEdge {
  src: string;
  dst: string;
  kind: string;
  confidence?: "high" | "low";
}

const edgeList: MockEdge[] = [
  ...(
    ["@acme/web>@acme/ui", "@acme/web>@acme/utils", "@acme/api>@acme/db", "@acme/ui>@acme/utils"] as const
  ).map((p): MockEdge => {
    const [a, b] = p.split(">") as [string, string];
    return { src: wsId(a), dst: wsId(b), kind: "depends_on" };
  }),
  {
    src: fileId("apps/web/src/components/PostList.tsx"),
    dst: fileId("packages/ui/src/button.tsx"),
    kind: "imports",
  },
  {
    src: fileId("apps/web/src/components/PostList.tsx"),
    dst: fileId("packages/ui/src/card.tsx"),
    kind: "imports",
  },
  {
    src: fileId("apps/web/src/components/PostList.tsx"),
    dst: fileId("packages/utils/src/date.ts"),
    kind: "imports",
  },
  { src: fileId("apps/api/src/router.ts"), dst: fileId("packages/db/src/queries.ts"), kind: "imports" },
  { src: ids.postList, dst: ids.button, kind: "renders" },
  { src: ids.postList, dst: ids.card, kind: "renders" },
  { src: ids.postList, dst: ids.date, kind: "calls" },
  { src: ids.postList, dst: ids.useDebounce, kind: "uses_hook", confidence: "low" },
  { src: ids.createRouter, dst: ids.listPosts, kind: "calls" },
  { src: symId("packages/ui/src/button.test.tsx", "buttonTest"), dst: ids.button, kind: "renders" },
];
for (const f of FILES) {
  edgeList.push({ src: wsId(f.ws), dst: fileId(f.path), kind: "contains" });
  for (const s of f.symbols)
    edgeList.push({ src: fileId(f.path), dst: symId(f.path, s.name), kind: "contains" });
}

const fileById = new Map(FILES.map((f) => [fileId(f.path), f]));
const symbolById = new Map<string, { file: MockFile; sym: MockSymbol }>();
for (const f of FILES) for (const s of f.symbols) symbolById.set(symId(f.path, s.name), { file: f, sym: s });

export const symbols: SearchHit[] = [...symbolById].map(([id, { file, sym: s }]) => ({
  id,
  name: s.name,
  kind: s.kind,
  path: file.path,
  line: s.line,
  exported: s.exported,
}));

export const sources: Record<string, string> = Object.fromEntries(FILES.map((f) => [f.path, f.source]));

// ---------- request options, parsed the way the real server does ----------

interface ParsedQuery {
  focus: string | null;
  level: ViewLevel | null;
  hops: number | null;
  options: Record<string, string | boolean>;
}

function parseQuery(url: URL): ParsedQuery {
  const p = url.searchParams;
  const options: Record<string, string | boolean> = {};
  const raw = p.get("filters") ?? "";
  if (raw.startsWith("{")) Object.assign(options, JSON.parse(raw) as Record<string, string>);
  const hops = p.get("hops") ?? p.get("depth");
  return {
    focus: p.get("focus"),
    level: (p.get("level") as ViewLevel | null) ?? null,
    hops: hops === null ? null : Number(hops),
    options,
  };
}

const optBool = (o: ParsedQuery["options"], key: string, dflt: boolean): boolean => {
  const v = o[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return !(v === "false" || v === "0" || v === "");
  return dflt;
};
const optList = (o: ParsedQuery["options"], key: string): string[] | undefined => {
  const v = o[key];
  return typeof v === "string" ? v.split(/[|,]/).filter(Boolean) : undefined;
};

// ---------- view: debug ----------

function debugView(): ViewData {
  const nodes: GraphNode[] = WORKSPACES.map((w) => ({
    id: wsId(w.name),
    kind: "workspace",
    label: w.name,
    size: FILES.filter((f) => f.ws === w.name).length,
    badges: [w.kind],
  }));
  return { nodes, edges: edges("depends_on"), layoutHint: "force" };
}

function edges(kind: string): GraphEdge[] {
  return edgeList
    .filter((e) => e.kind === kind)
    .map((e) => ({
      id: `${e.src}|${e.kind}|${e.dst}`,
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      weight: 1,
      confidence: e.confidence ?? "high",
    }));
}

// ---------- view: project-map ----------

const TIER = { workspace: 0, dir: 1, file: 2, symbol: 3 } as const;
const LEVEL_TIER: Record<ViewLevel, number> = { workspaces: 0, dirs: 1, files: 2, symbols: 3 };
const FUNCTION_LIKE = ["function", "method", "component", "hook"];

function projectMap(q: ParsedQuery): ViewData | { error: string; status: number } {
  // Mock-only flag, like the 3D map's: `#/project-map?scenario=large` serves the 11-workspace monorepo.
  if (q.options.scenario === "large") return projectMapLarge(q);
  const hideTests = optBool(q.options, "hideTests", true);
  const exportedOnly = optBool(q.options, "exportedOnly", false);
  const wsAllowed = optList(q.options, "workspaces");
  const kinds = new Set(optList(q.options, "kinds") ?? FUNCTION_LIKE);

  const nodes = new Map<string, GraphNode & { tier: number }>();
  const add = (n: GraphNode, tier: number) => nodes.set(n.id, { ...n, tier });
  const files = FILES.filter(
    (f) => !(hideTests && isTest(f.path)) && (!wsAllowed || wsAllowed.includes(wsId(f.ws))),
  );
  for (const w of WORKSPACES) {
    if (wsAllowed && !wsAllowed.includes(wsId(w.name))) continue;
    add(
      {
        id: wsId(w.name),
        kind: "workspace",
        label: w.name,
        shortLabel: shortLabels(WORKSPACES.map((x) => x.name)).get(w.name) ?? w.name,
        size: 1,
        path: w.dir,
        badges: [w.kind, "react"],
      },
      TIER.workspace,
    );
  }
  for (const f of files) {
    const w = WORKSPACES.find((x) => x.name === f.ws) as MockWorkspace;
    const dir = dirOf(f.path);
    const dirNodeId = `dir:${dir}`;
    if (!nodes.has(dirNodeId)) {
      add(
        {
          id: dirNodeId,
          kind: "dir",
          label: dir.slice(w.dir.length + 1) || dir,
          size: 1,
          path: dir,
          parent: wsId(f.ws),
        },
        TIER.dir,
      );
    }
    const syms = f.symbols.filter((s) => kinds.has(s.kind) && (!exportedOnly || s.exported));
    add(
      {
        id: fileId(f.path),
        kind: "file",
        label: baseName(f.path),
        size: 1,
        path: f.path,
        parent: dirNodeId,
        stats: { files: 1, functions: syms.length, loc: syms.length * 5 },
      },
      TIER.file,
    );
    for (const s of syms) {
      add(
        {
          id: symId(f.path, s.name),
          kind: s.kind,
          label: s.name,
          size: 1,
          path: f.path,
          parent: fileId(f.path),
          stats: { functions: 1, loc: 5 },
          ...(s.exported ? { badges: ["exported"] } : {}),
        },
        TIER.symbol,
      );
    }
  }
  // Roll counts up into folders and workspaces.
  for (const n of [...nodes.values()].filter((x) => x.tier === TIER.file)) {
    for (
      let p = n.parent ? nodes.get(n.parent) : undefined;
      p;
      p = p.parent ? nodes.get(p.parent) : undefined
    ) {
      const s = p.stats ?? { files: 0, functions: 0, loc: 0 };
      p.stats = {
        files: (s.files ?? 0) + 1,
        functions: (s.functions ?? 0) + (n.stats?.functions ?? 0),
        loc: (s.loc ?? 0) + (n.stats?.loc ?? 0),
      };
    }
  }

  const maxTier = LEVEL_TIER[q.level ?? "files"];
  const returned = new Set<string>();
  if (q.focus) {
    const focus = nodes.get(q.focus);
    if (!focus) return { status: 404, error: `Unknown focus: ${q.focus}` };
    for (
      let a = focus.parent ? nodes.get(focus.parent) : undefined;
      a;
      a = a.parent ? nodes.get(a.parent) : undefined
    )
      returned.add(a.id);
    returned.add(focus.id);
    const under = (n: GraphNode & { tier: number }): boolean => {
      for (let p: GraphNode | undefined = n; p; p = p.parent ? nodes.get(p.parent) : undefined)
        if (p.id === focus.id) return true;
      return false;
    };
    for (const n of nodes.values()) {
      if (n.id === focus.id || !under(n)) continue;
      const within = q.level ? n.tier <= maxTier : n.parent === focus.id;
      if (within) returned.add(n.id);
    }
  } else {
    for (const n of nodes.values()) if (n.tier <= maxTier) returned.add(n.id);
  }

  const rep = (id: string): string | undefined => {
    const f = id.startsWith("sym:") ? fileId(symbolById.get(id)?.file.path ?? "") : id;
    for (let n = nodes.get(id) ?? nodes.get(f); n; n = n.parent ? nodes.get(n.parent) : undefined)
      if (returned.has(n.id)) return n.id;
    return undefined;
  };
  const agg = new Map<string, GraphEdge>();
  for (const e of edgeList) {
    if (e.kind === "contains") continue;
    const src = rep(e.src);
    const dst = rep(e.dst);
    if (!src || !dst || src === dst) continue;
    const kind = e.kind === "depends_on" ? "depends_on" : e.kind === "imports" ? "imports" : "uses";
    const id = `${src}|${kind}|${dst}`;
    const cur = agg.get(id);
    if (cur) cur.weight += 1;
    else agg.set(id, { id, src, dst, kind, weight: 1, confidence: e.confidence ?? "high" });
  }
  return {
    nodes: [...returned].sort().map((id) => {
      const { tier: _tier, ...node } = nodes.get(id) as GraphNode & { tier: number };
      return node;
    }),
    edges: [...agg.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    layoutHint: "nested-elk",
  };
}

// ---------- view: ego ----------

function ego(q: ParsedQuery): ViewData | { error: string; status: number } {
  if (!q.focus) return { status: 400, error: "ego requires focus=<symbol or file id>" };
  // Mock-only flag: `#/ego?focus=<hubFocus>&scenario=hub` serves the 221-caller hub (mock/hubEgo.ts).
  if (q.options.scenario === "hub") return egoHub(optList(q.options, "expand") ?? []);
  if (!symbolById.has(q.focus) && !fileById.has(q.focus))
    return { status: 404, error: `Unknown focus: ${q.focus}` };
  const hops = q.hops ?? 2;
  if (!Number.isInteger(hops) || hops < 1 || hops > 4)
    return { status: 400, error: "hops must be an integer 1-4" };
  const kinds = new Set(optList(q.options, "edgeKinds") ?? ["calls", "renders", "uses_hook"]);
  const highOnly = optBool(q.options, "highConfidence", false);
  const links = edgeList.filter(
    (e) =>
      kinds.has(e.kind) &&
      !(highOnly && e.confidence === "low") &&
      symbolById.has(e.src) &&
      symbolById.has(e.dst),
  );
  const walk = (forward: boolean): Map<string, number> => {
    const dist = new Map([[q.focus as string, 0]]);
    let frontier = [q.focus as string];
    for (let h = 1; h <= hops; h++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const l of links) {
          const [from, to] = forward ? [l.src, l.dst] : [l.dst, l.src];
          if (from === id && !dist.has(to)) {
            dist.set(to, h);
            next.push(to);
          }
        }
      frontier = next;
    }
    return dist;
  };
  const out = walk(true);
  const inn = walk(false);
  const nodes = new Map<string, GraphNode>();
  const put = (id: string, side: "in" | "out" | "focus", hop: number) => {
    const s = symbolById.get(id);
    if (!s) return;
    nodes.set(id, {
      id,
      kind: s.sym.kind,
      label: s.sym.name,
      size: 1,
      path: s.file.path,
      stats: { functions: 1, loc: 5 },
      ...(s.sym.exported ? { badges: ["exported"] } : {}),
      workspace: wsId(s.file.ws),
      side,
      hop,
    });
  };
  put(q.focus, "focus", 0);
  for (const [id, h] of out) if (id !== q.focus) put(id, "out", h);
  for (const [id, h] of inn) if (id !== q.focus && !nodes.has(id)) put(id, "in", h);
  const edgeOut = links
    .filter((l) => nodes.has(l.src) && nodes.has(l.dst))
    .map((l) => ({
      id: `${l.src}|${l.kind}|${l.dst}`,
      src: l.src,
      dst: l.dst,
      kind: l.kind,
      weight: 1,
      confidence: l.confidence ?? ("high" as const),
    }));
  return { nodes: [...nodes.values()], edges: edgeOut, layoutHint: "bowtie" };
}

// ---------- /api/node ----------

function labelOf(id: string): string {
  const s = symbolById.get(id);
  if (s) return s.sym.name;
  if (id.startsWith("file:")) return id.slice(5);
  if (id.startsWith("ws:")) return id.slice(3);
  return id;
}

function neighborsOf(id: string): Record<string, NeighborRef[]> {
  const out: Record<string, NeighborRef[]> = {};
  const push = (kind: string, ref: NeighborRef) => {
    let list = out[kind];
    if (!list) out[kind] = list = [];
    list.push(ref);
  };
  for (const e of edgeList) {
    if (e.src === id)
      push(e.kind, {
        id: e.dst,
        direction: "out",
        kind: e.kind,
        label: labelOf(e.dst),
        confidence: e.confidence ?? "high",
        count: 1,
      });
    if (e.dst === id)
      push(e.kind, {
        id: e.src,
        direction: "in",
        kind: e.kind,
        label: labelOf(e.src),
        confidence: e.confidence ?? "high",
        count: 1,
      });
  }
  return out;
}

const DESCRIBED = new Set([ids.button, ids.date]);

function nodeDetail(id: string): NodeDetail | null {
  let node: NodeDetail["node"] | undefined;
  let signature: string | null = null;
  const s = symbolById.get(id);
  if (s) {
    signature = `function ${s.sym.name}(…)`;
    node = {
      id,
      kind: s.sym.kind,
      name: s.sym.name,
      path: s.file.path,
      workspaceId: wsId(s.file.ws),
      line: s.sym.line,
      endLine: s.sym.endLine,
      exported: s.sym.exported,
      loc: s.sym.endLine - s.sym.line + 1,
      complexity: 1,
    };
  } else if (fileById.has(id)) {
    const f = fileById.get(id) as MockFile;
    node = { id, kind: "file", name: f.path, path: f.path, workspaceId: wsId(f.ws) };
  } else {
    const w = WORKSPACES.find((x) => wsId(x.name) === id);
    if (w) node = { id, kind: "workspace", name: w.name, path: w.dir, workspaceKind: w.kind };
  }
  if (!node) return null;
  const nb = neighborsOf(id);
  const fanIn = new Set(
    Object.values(nb)
      .flat()
      .filter((r) => r.direction === "in" && r.kind !== "contains")
      .map((r) => r.id),
  );
  const fanOut = new Set(
    Object.values(nb)
      .flat()
      .filter((r) => r.direction === "out" && r.kind !== "contains")
      .map((r) => r.id),
  );
  return {
    node,
    signature,
    fan_in: fanIn.size,
    fan_out: fanOut.size,
    neighbors: nb,
    untrusted_description: DESCRIBED.has(id) ? "Renders a clickable button with the given label." : null,
  };
}

export const nodeDetails: Record<string, NodeDetail> = Object.fromEntries(
  [...symbolById.keys(), ...fileById.keys(), ...WORKSPACES.map((w) => wsId(w.name))].map((id) => [
    id,
    nodeDetail(id) as NodeDetail,
  ]),
);

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

// ---- map-3d "large" scenario: shaped like a real 11-workspace monorepo (3 huge, 8 tiny, long scoped names) ------
// Mock-only: pick it with `#/map-3d?scenario=large` (the hash flag travels as a filter).

interface M3Ws {
  id: string;
  name: string;
  kind: "app" | "package";
  /** Workspace directory (the real server sends it as `path`). */
  dir: string;
}
interface M3Data {
  ws: M3Ws[];
  files: M3File[];
  imports: { src: string; dst: string; w: number }[];
  /** package.json dependency pairs (workspace ids), drawn as `depends_on` edges. */
  declared: [string, string][];
}

const M3_SMALL: M3Data = {
  ws: M3_WS.map((w) => ({ id: `ws:${w.name}`, name: w.name, kind: w.kind, dir: WS_DIR[w.name] ?? "." })),
  files: m3Files,
  imports: m3Imports,
  declared: [],
};

const SCOPE = "@acme-platform-monorepo";
/** A 31-character unscoped repo-root workspace name: labels must wrap or middle-ellipsize it. */
const ROOT_PKG = "acme-platform-monorepo-root-app";
const LARGE_SPEC: {
  name: string;
  kind: "app" | "package";
  dir: string;
  files: number;
  fns: number;
  dirs: string[];
}[] = [
  {
    name: `${SCOPE}/api`,
    kind: "app",
    dir: "apps/api",
    files: 100,
    fns: 1700,
    dirs: [
      "src/routes",
      "src/services",
      "src/middleware",
      "src/jobs",
      "src/models",
      "src/lib",
      "src/graphql",
    ],
  },
  {
    name: `${SCOPE}/web`,
    kind: "app",
    dir: "apps/web",
    files: 90,
    fns: 980,
    dirs: ["src/routes", "src/components", "src/hooks", "src/lib", "src/state", "src/forms"],
  },
  {
    name: `${SCOPE}/core`,
    kind: "package",
    dir: "packages/core",
    files: 84,
    fns: 960,
    dirs: ["src/domain", "src/auth", "src/billing", "src/events", "src/utils"],
  },
  { name: `${SCOPE}/types`, kind: "package", dir: "packages/types", files: 3, fns: 32, dirs: ["src"] },
  { name: `${SCOPE}/logger`, kind: "package", dir: "packages/logger", files: 3, fns: 24, dirs: ["src"] },
  { name: `${SCOPE}/config`, kind: "package", dir: "packages/config", files: 2, fns: 18, dirs: ["src"] },
  { name: `${SCOPE}/ui-kit`, kind: "package", dir: "packages/ui-kit", files: 5, fns: 12, dirs: ["src"] },
  { name: `${SCOPE}/db-client`, kind: "package", dir: "packages/db-client", files: 4, fns: 9, dirs: ["src"] },
  { name: `${SCOPE}/testing`, kind: "package", dir: "packages/testing", files: 2, fns: 6, dirs: ["src"] },
  { name: ROOT_PKG, kind: "package", dir: "tooling", files: 1, fns: 3, dirs: ["."] },
  { name: "scripts", kind: "app", dir: "scripts", files: 1, fns: 1, dirs: ["."] },
];
const WORDS = [
  "user",
  "order",
  "invoice",
  "session",
  "token",
  "account",
  "report",
  "search",
  "upload",
  "email",
  "queue",
  "cache",
  "plan",
  "team",
  "audit",
  "export",
  "import",
  "sync",
  "hook",
  "event",
  "rate",
  "feed",
  "tag",
  "role",
  "badge",
  "alert",
  "form",
  "table",
  "chart",
  "menu",
];
const SUFFIX = [
  "Service",
  "Handler",
  "Controller",
  "Store",
  "View",
  "Repo",
  "Policy",
  "Mapper",
  "Client",
  "Utils",
];

const M3_LARGE: M3Data = (() => {
  const ws: M3Ws[] = LARGE_SPEC.map((w) => ({ id: `ws:${w.name}`, name: w.name, kind: w.kind, dir: w.dir }));
  const files: M3File[] = [];
  for (const w of LARGE_SPEC) {
    const wsid = `ws:${w.name}`;
    const used = new Set<string>();
    const mine: M3File[] = [];
    for (let i = 0; i < w.files; i++) {
      const dir = w.dirs[i % w.dirs.length] as string;
      const h = m3hash(`${w.name}#${i}`);
      let base = `${WORDS[h % WORDS.length]}${SUFFIX[(h >>> 8) % SUFFIX.length]}`;
      if (w.files <= 5) base = ["index", "types", "client", "util", "schema"][i] as string;
      if (used.has(`${dir}/${base}`)) base = `${base}${i}`;
      used.add(`${dir}/${base}`);
      const rel = dir === "." ? `${base}.ts` : `${dir}/${base}.ts`;
      const path = `${w.dir}/${rel}`;
      mine.push({
        id: `file:${path}`,
        path,
        ws: wsid,
        dir: dir === "." ? "." : dir.split("/").slice(0, 2).join("/"),
        fns: 0,
      });
    }
    // Heavy-tailed weights scaled to the workspace total (every file keeps at least one function).
    const weights = mine.map((f) => (1 + (m3hash(f.path) % 9)) ** 2);
    const sum = weights.reduce((a, x) => a + x, 0);
    let left = w.fns;
    mine.forEach((f, i) => {
      f.fns = Math.max(1, Math.floor((w.fns * (weights[i] as number)) / sum));
      left -= f.fns;
    });
    for (let i = 0; left !== 0; i = (i + 1) % mine.length) {
      const f = mine[i] as M3File;
      if (left > 0) {
        f.fns += 1;
        left -= 1;
      } else if (f.fns > 1) {
        f.fns -= 1;
        left += 1;
      }
    }
    files.push(...mine);
  }
  const id = (n: string): string => `ws:${n}`;
  const wsName = (n: string): string => (n === ROOT_PKG || n === "scripts" ? n : `${SCOPE}/${n}`);
  const rules: [string, string, number][] = [
    ["api", "core", 2],
    ["api", "types", 1],
    ["api", "logger", 1],
    ["api", "config", 1],
    ["api", "db-client", 1],
    ["web", "core", 2],
    ["web", "ui-kit", 2],
    ["web", "types", 1],
    ["web", "api", 1],
    ["web", "config", 1],
    ["core", "types", 1],
    ["core", "logger", 1],
    ["ui-kit", "types", 1],
    ["db-client", "types", 1],
    ["testing", "core", 1],
    ["scripts", "core", 1],
    [ROOT_PKG, "config", 1],
  ].map(([a, b, n]) => [id(wsName(a as string)), id(wsName(b as string)), n as number]);
  const byWs = new Map<string, M3File[]>();
  for (const f of files) byWs.set(f.ws, [...(byWs.get(f.ws) ?? []), f]);
  const out = new Map<string, number>();
  for (const f of files) {
    for (const [from, to, n] of rules) {
      if (f.ws !== from) continue;
      const pool = byWs.get(to) as M3File[];
      for (let k = 0; k < n; k++) {
        const t = pool[m3hash(`${f.id}>${to}>${k}`) % pool.length] as M3File;
        if (m3hash(`${f.id}${to}${k}`) % 3 !== 0)
          out.set(`${f.id}|${t.id}`, 1 + (m3hash(`${f.id}${t.id}`) % 3));
      }
    }
    const mates = byWs.get(f.ws) as M3File[];
    for (let k = 0; k < 2 && mates.length > 1; k++) {
      const t = mates[m3hash(`${f.id}local${k}`) % mates.length] as M3File;
      if (t.id !== f.id) out.set(`${f.id}|${t.id}`, 1 + (m3hash(`${f.id}${t.id}x`) % 3));
    }
  }
  const imports = [...out].map(([k, w]) => {
    const [src, dst] = k.split("|") as [string, string];
    return { src, dst, w };
  });
  const dec = (a: string, b: string): [string, string] => [id(wsName(a)), id(wsName(b))];
  const declared: [string, string][] = [
    dec("api", "testing"),
    dec("web", "testing"),
    dec("core", "config"),
    dec("logger", "config"),
    dec("ui-kit", "config"),
    dec("db-client", "config"),
    dec("db-client", "logger"),
    dec("testing", "types"),
    dec("testing", "logger"),
    dec("scripts", ROOT_PKG),
    dec("scripts", "config"),
    dec(ROOT_PKG, "types"),
    dec("api", "ui-kit"),
    dec("config", "types"),
    dec("ui-kit", "logger"),
  ];
  return { ws, files, imports, declared };
})();

/** Same rule as server/views/labels.ts: strip the npm scope shared by most scoped workspaces. */
function shortLabels(names: string[]): Map<string, string> {
  const scopeOf = (n: string): string | null => /^(@[^/]+)\//.exec(n)?.[1] ?? null;
  const counts = new Map<string, number>();
  let scoped = 0;
  for (const n of names) {
    const sc = scopeOf(n);
    if (sc) {
      scoped += 1;
      counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
  }
  const [shared, best] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const strip = shared !== null && best >= 2 && best * 2 > scoped;
  const out = new Map(
    names.map((n) => [n, strip && scopeOf(n) === shared ? n.slice((shared as string).length + 1) : n]),
  );
  const seen = new Map<string, number>();
  for (const v of out.values()) seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const n of names) if ((seen.get(out.get(n) as string) ?? 0) > 1) out.set(n, n);
  return out;
}

/**
 * Mirrors server/views/map3d.ts: `level` from the param (unknown or `symbols` -> dirs); the synthetic data has no
 * test files. The mock-only filter `scenario=large` switches to the 11-workspace dataset above.
 */
export function map3dView(q: ParsedQuery | string): ViewData {
  const level = typeof q === "string" ? q : (q.level ?? "dirs");
  const data = typeof q !== "string" && q.options.scenario === "large" ? M3_LARGE : M3_SMALL;
  const short = shortLabels(data.ws.map((w) => w.name));
  const wsNodes: GraphNode[] = data.ws.map((w) => {
    const fs = data.files.filter((f) => f.ws === w.id);
    const fns = fs.reduce((a, f) => a + f.fns, 0);
    return {
      id: w.id,
      kind: "workspace",
      label: w.name,
      shortLabel: short.get(w.name) ?? w.name,
      size: fns,
      path: w.dir,
      stats: { files: fs.length, functions: fns },
      badges: [w.kind, `${fs.length} files`, `${fns} functions`],
    };
  });
  const nodeOf = new Map<string, string>();
  const nodes: GraphNode[] = [...wsNodes];
  const wsDirOf = (id: string): string => data.ws.find((w) => w.id === id)?.dir ?? ".";
  if (level === "workspaces") {
    for (const f of data.files) nodeOf.set(f.id, f.ws);
  } else if (level === "files") {
    for (const f of data.files) {
      nodeOf.set(f.id, f.id);
      nodes.push({
        id: f.id,
        kind: "file",
        label: f.path.slice(f.path.lastIndexOf("/") + 1),
        parent: f.ws,
        size: f.fns,
        path: f.path,
        stats: { functions: f.fns },
        badges: [`${f.fns} functions`],
      });
    }
  } else {
    const dirs = new Map<string, GraphNode>();
    for (const f of data.files) {
      const id = `dir:${f.ws}:${f.dir}`;
      nodeOf.set(f.id, id);
      const d = dirs.get(id) ?? {
        id,
        kind: "dir",
        label: f.dir === "." ? "(root)" : f.dir,
        parent: f.ws,
        size: 0,
        path: f.dir === "." ? wsDirOf(f.ws) : `${wsDirOf(f.ws)}/${f.dir}`,
        badges: [],
      };
      d.size += f.fns;
      d.stats = { files: (d.stats?.files ?? 0) + 1, functions: d.size };
      d.badges = [`${d.stats.files} files`, `${d.size} functions`];
      dirs.set(id, d);
    }
    nodes.push(...dirs.values());
  }
  const sum = new Map<string, GraphEdge>();
  for (const e of data.imports) {
    const a = nodeOf.get(e.src);
    const b = nodeOf.get(e.dst);
    if (!a || !b || a === b) continue;
    const id = `${a}|imports|${b}`;
    const cur = sum.get(id);
    if (cur) cur.weight += e.w;
    else sum.set(id, { id, src: a, dst: b, kind: "imports", weight: e.w, confidence: "high" });
  }
  for (const [a, b] of data.declared) {
    const id = `${a}|depends_on|${b}`;
    sum.set(id, { id, src: a, dst: b, kind: "depends_on", weight: 1, confidence: "high" });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...sum.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { nodes, edges, layoutHint: "force-3d" };
}

function map3dDetail(id: string): NodeDetail | null {
  for (const q of ["files", "dirs"] as const) {
    for (const scenario of [undefined, "large"]) {
      const n = map3dView({
        focus: null,
        level: q,
        hops: null,
        options: scenario ? { scenario } : {},
      }).nodes.find((x) => x.id === id);
      if (!n) continue;
      const file = [...M3_SMALL.files, ...M3_LARGE.files].find((x) => x.id === id);
      return {
        node: { id, kind: n.kind, name: n.label, path: file?.path ?? null, workspaceId: n.parent ?? null },
        signature: null,
        fan_in: 0,
        fan_out: 0,
        neighbors: {},
        untrusted_description: null,
      };
    }
  }
  return null;
}

/** Saved canvas positions per view; the mock server's PUT /api/layout/:view writes here. */
export const mockLayouts = new Map<string, Record<string, [number, number]>>();

let hierarchy: ReturnType<typeof buildHierarchy> | undefined;
let synthetic: ReturnType<typeof generateSynthetic> | undefined;

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Pure request handler shared by the node:http mock server and the in-process fetch mock. */
export function handleMockApi(url: URL): MockResponse | null {
  const path = url.pathname;
  if (path === "/api/meta") return { status: 200, body: meta };

  if (path.startsWith("/api/layout/")) {
    const view = decodeURIComponent(path.slice("/api/layout/".length));
    return { status: 200, body: { positions: mockLayouts.get(view) ?? {} } };
  }

  if (path === "/api/view/canvas-demo") {
    hierarchy ??= buildHierarchy();
    return { status: 200, body: { ...hierarchy, layoutHint: "nested-elk" } };
  }
  if (path === "/api/view/flat") {
    hierarchy ??= buildHierarchy();
    const keep = new Set(
      hierarchy.nodes
        .filter((n) => n.kind !== "workspace" && n.kind !== "directory" && n.kind !== "file")
        .slice(0, 90)
        .map((n) => n.id),
    );
    const nodes = hierarchy.nodes.filter((n) => keep.has(n.id)).map(({ parent: _p, ...rest }) => rest);
    const edges = hierarchy.edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
    return { status: 200, body: { nodes, edges, layoutHint: "force" } };
  }
  if (path === "/api/view/perf") {
    synthetic ??= generateSynthetic();
    return { status: 200, body: { ...synthetic, layoutHint: "nested-elk" } };
  }

  if (path.startsWith("/api/view/")) {
    const id = decodeURIComponent(path.slice("/api/view/".length));
    const q = parseQuery(url);
    const result =
      id === "debug"
        ? debugView()
        : id === "project-map"
          ? projectMap(q)
          : id === "ego"
            ? ego(q)
            : id === "map-3d"
              ? map3dView(q)
              : null;
    if (!result) return { status: 404, body: { error: `Unknown view: ${id}` } };
    if ("error" in result) return { status: result.status, body: { error: result.error } };
    return { status: 200, body: result };
  }

  if (path.startsWith("/api/node/")) {
    const id = decodeURIComponent(path.slice("/api/node/".length));
    const found = nodeDetail(id) ?? map3dDetail(id) ?? hubNode(id);
    if (found) return { status: 200, body: found };
    const large = largeMapNode(id);
    if (large)
      return {
        status: 200,
        body: {
          node: large,
          signature: null,
          fan_in: 0,
          fan_out: 0,
          neighbors: {},
          untrusted_description: null,
        } satisfies NodeDetail,
      };
    hierarchy ??= buildHierarchy();
    const node = hierarchy.nodes.find((n) => n.id === id);
    if (!node) return { status: 404, body: { error: "Unknown node" } };
    const degree = hierarchy.edges.filter((e) => e.src === id || e.dst === id);
    const detail: NodeDetail = {
      node: { id: node.id, kind: node.kind, name: node.label, path: null },
      signature: "",
      fan_in: degree.filter((e) => e.dst === id).length,
      fan_out: degree.filter((e) => e.src === id).length,
      neighbors: {},
      untrusted_description: null,
    };
    return { status: 200, body: detail };
  }

  if (path === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const hits = q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : [];
    return { status: 200, body: { hits } };
  }

  if (path === "/api/source") {
    const text = sources[url.searchParams.get("path") ?? ""];
    if (text === undefined) return { status: 404, body: { error: "File not found" } };
    const start = Number(url.searchParams.get("start") ?? 1);
    const all = text.replace(/\n$/, "").split("\n");
    const end = Math.min(Number(url.searchParams.get("end") ?? start + 399), start + 399);
    const lines = all.slice(start - 1, end);
    return {
      status: 200,
      body: {
        path: url.searchParams.get("path"),
        start,
        end: start + lines.length - 1,
        total: all.length,
        lines,
      },
    };
  }

  return null;
}

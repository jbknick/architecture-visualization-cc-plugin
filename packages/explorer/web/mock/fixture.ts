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

export const meta: Meta = {
  repo: "pnpm-turbo",
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  counts: { workspaces: 5, files: 9, symbols: 9, edges: 31 },
  views: [
    { id: "debug", title: "Debug: workspaces", enabled: true },
    { id: "project-map", title: "Project map", enabled: true },
    { id: "ego", title: "Function ego graph", enabled: true },
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
      { id: wsId(w.name), kind: "workspace", label: w.name, size: 1, path: w.dir, badges: [w.kind, "react"] },
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
  return { nodes: [...nodes.values()], edges: edgeOut, layoutHint: "radial" };
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

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Pure request handler shared by the node:http mock server and the in-process fetch mock. */
export function handleMockApi(url: URL): MockResponse | null {
  const path = url.pathname;
  if (path === "/api/meta") return { status: 200, body: meta };

  if (path.startsWith("/api/view/")) {
    const id = decodeURIComponent(path.slice("/api/view/".length));
    const q = parseQuery(url);
    const result =
      id === "debug" ? debugView() : id === "project-map" ? projectMap(q) : id === "ego" ? ego(q) : null;
    if (!result) return { status: 404, body: { error: `Unknown view: ${id}` } };
    if ("error" in result) return { status: result.status, body: { error: result.error } };
    return { status: 200, body: result };
  }

  if (path.startsWith("/api/node/")) {
    const found = nodeDetail(decodeURIComponent(path.slice("/api/node/".length)));
    return found ? { status: 200, body: found } : { status: 404, body: { error: "Unknown node" } };
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

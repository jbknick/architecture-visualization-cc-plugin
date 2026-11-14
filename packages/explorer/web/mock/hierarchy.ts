// A hierarchical pnpm-turbo-like dataset for the graph canvas: 5 workspaces, directories, files, symbols and
// weighted import edges. Synthetic and deterministic; the names are made up.
import type { GraphEdge, GraphNode } from "../src/api.ts";
import { hashString, mulberry32 } from "../src/canvas/prng.ts";

interface WorkspaceSpec {
  name: string;
  kind: "app" | "package";
  dirs: Record<string, string[]>;
}

const SPECS: WorkspaceSpec[] = [
  {
    name: "@acme/web",
    kind: "app",
    dirs: {
      "src/pages": ["Home", "Dashboard", "Settings", "Login", "Posts", "Profile"],
      "src/components": ["PostList", "Header", "Footer", "Sidebar", "Modal", "Toast"],
      "src/hooks": ["useAuth", "usePosts", "useTheme"],
      "src/lib": ["client", "routes", "session"],
    },
  },
  {
    name: "@acme/api",
    kind: "app",
    dirs: {
      "src/routes": ["posts", "users", "auth", "health"],
      "src/services": ["postService", "userService", "authService"],
      "src/middleware": ["auth", "logging", "errors"],
    },
  },
  {
    name: "@acme/ui",
    kind: "package",
    dirs: { src: ["Button", "Card", "Input", "Dialog", "Tabs", "Tooltip", "Badge"] },
  },
  {
    name: "@acme/utils",
    kind: "package",
    dirs: { src: ["date", "string", "array", "validation", "logger"] },
  },
  {
    name: "@acme/db",
    kind: "package",
    dirs: {
      "src/models": ["post", "user", "comment"],
      "src/queries": ["posts", "users"],
      src: ["client", "migrate"],
    },
  },
];

/** Workspace dependencies: [from, to, number of import edges]. */
const DEPENDENCIES: [string, string, number][] = [
  ["@acme/web", "@acme/ui", 38],
  ["@acme/web", "@acme/utils", 21],
  ["@acme/web", "@acme/api", 12],
  ["@acme/api", "@acme/db", 29],
  ["@acme/api", "@acme/utils", 17],
  ["@acme/ui", "@acme/utils", 9],
  ["@acme/db", "@acme/utils", 6],
];

const HELPERS = ["Props", "helper", "format", "validate", "parse", "handle", "render", "init", "normalize"];

function kindFor(dir: string, base: string, k: number): string {
  if (k > 0) return k % 3 === 0 ? "type" : "function";
  if (dir.endsWith("hooks")) return "hook";
  if (dir.endsWith("models")) return "class";
  if (/^[A-Z]/.test(base) && !dir.includes("api")) return "component";
  return "function";
}

export function buildHierarchy(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const symbolsByWs = new Map<string, string[]>();
  for (const ws of SPECS) {
    const wsId = `ws:${ws.name}`;
    const symbols: string[] = [];
    let count = 0;
    const wsNode: GraphNode = { id: wsId, kind: "workspace", label: ws.name, size: 0, badges: [ws.kind] };
    nodes.push(wsNode);
    for (const [dir, files] of Object.entries(ws.dirs)) {
      const dirId = `dir:${ws.name}/${dir}`;
      nodes.push({ id: dirId, kind: "directory", label: dir, parent: wsId, size: 0 });
      for (const base of files) {
        const path = `${ws.name.replace("@acme/", "packages/")}/${dir}/${base}.ts`;
        const fileId = `file:${path}`;
        nodes.push({ id: fileId, kind: "file", label: `${base}.ts`, parent: dirId, size: 0 });
        const n = 3 + (hashString(path) % 5);
        for (let k = 0; k < n; k++) {
          const name =
            k === 0 ? base : `${HELPERS[(hashString(path) + k) % HELPERS.length]}${k > 3 ? k : ""}`;
          const id = `sym:${path}#${name}`;
          nodes.push({ id, kind: kindFor(dir, base, k), label: name, parent: fileId, size: 1 });
          symbols.push(id);
          count++;
        }
      }
    }
    wsNode.size = count;
    symbolsByWs.set(wsId, symbols);
  }
  const rand = mulberry32(36);
  const seen = new Set<string>();
  const pick = (list: string[]): string => list[Math.floor(rand() * list.length)] as string;
  for (const [from, to, total] of DEPENDENCIES) {
    const a = symbolsByWs.get(`ws:${from}`) as string[];
    const b = symbolsByWs.get(`ws:${to}`) as string[];
    for (let made = 0, guard = 0; made < total && guard < total * 20; guard++) {
      const src = pick(a);
      const dst = pick(b);
      const id = `${src}>${dst}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, src, dst, kind: "imports", weight: 1, confidence: "high" });
      made++;
    }
  }
  // A few calls inside workspaces so near zoom has symbol-to-symbol arrows.
  for (const symbols of symbolsByWs.values()) {
    for (let k = 0; k < 14; k++) {
      const src = pick(symbols);
      const dst = pick(symbols);
      const id = `${src}>${dst}`;
      if (src === dst || seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, src, dst, kind: "imports", weight: 1, confidence: "high" });
    }
  }
  return { nodes, edges };
}

// Mock-only "large" project-map scenario, shaped like a real 11-workspace monorepo: three big workspaces
// (about 1,700 / 980 / 960 functions in 260 / 220 / 350 files) and eight tiny ones (1 to 32 functions), long
// scoped names, nested folders, weighted imports (1 to 640 file links per workspace pair) and many declared-only
// package.json dependencies. Selected with the hash flag `scenario=large`; entirely synthetic and deterministic.
import type { GraphEdge, GraphNode, ViewData, ViewLevel } from "../src/api.ts";

const SCOPE = "@acme-platform-monorepo";

interface Spec {
  name: string;
  kind: "app" | "package";
  dir: string;
  files: number;
  fns: number;
  /** Folders relative to the workspace dir, parents before children. Files live in the ones with a weight. */
  dirs: [string, number][];
  /** Config files that sit directly in the workspace dir next to its folders (names, one function each or so). */
  rootFiles?: { names: string[]; fns: number };
}

/** The repo-root workspace (`ws:.`) is named like the repository: 31 characters, no npm scope. */
const ROOT_NAME = "acme-platform-monorepo-root-app";
const wsId = (name: string): string => (name === ROOT_NAME ? "ws:." : `ws:${name}`);

const SPECS: Spec[] = [
  {
    name: ROOT_NAME,
    kind: "app",
    dir: ".",
    files: 6,
    fns: 14,
    dirs: [
      ["src", 0],
      ["src/lib", 5],
      ["src/commands", 4],
    ],
    rootFiles: { names: ["eslint.config.js", "release.config.ts", "turbo.config.ts"], fns: 1 },
  },
  {
    name: `${SCOPE}/api`,
    kind: "app",
    dir: "apps/api",
    files: 260,
    fns: 1700,
    dirs: [
      ["src", 0],
      ["src/routes", 3],
      ["src/routes/v1", 4],
      ["src/routes/v2", 3],
      ["src/services", 6],
      ["src/middleware", 2],
      ["src/jobs", 3],
      ["src/models", 4],
      ["src/lib", 2],
      ["src/graphql", 3],
    ],
  },
  {
    name: `${SCOPE}/web`,
    kind: "app",
    dir: "apps/web",
    files: 220,
    fns: 980,
    dirs: [
      ["src", 0],
      ["src/routes", 4],
      ["src/components", 7],
      ["src/components/forms", 3],
      ["src/hooks", 3],
      ["src/lib", 2],
      ["src/state", 2],
      ["src/pages", 4],
      ["src/styles", 1],
    ],
    rootFiles: { names: ["vite.config.ts", "tailwind.config.ts", "playwright.config.ts"], fns: 2 },
  },
  {
    name: `${SCOPE}/core`,
    kind: "package",
    dir: "packages/core",
    files: 350,
    fns: 960,
    dirs: [
      ["src", 0],
      ["src/domain", 5],
      ["src/domain/orders", 4],
      ["src/auth", 3],
      ["src/billing", 4],
      ["src/events", 2],
      ["src/utils", 3],
      ["src/validation", 3],
      ["src/db", 2],
    ],
    rootFiles: { names: ["tsup.config.ts", "vitest.config.ts"], fns: 2 },
  },
  { name: `${SCOPE}/types`, kind: "package", dir: "packages/types", files: 3, fns: 32, dirs: [["src", 1]] },
  { name: `${SCOPE}/logger`, kind: "package", dir: "packages/logger", files: 3, fns: 24, dirs: [["src", 1]] },
  { name: `${SCOPE}/config`, kind: "package", dir: "packages/config", files: 2, fns: 18, dirs: [["src", 1]] },
  { name: `${SCOPE}/ui-kit`, kind: "package", dir: "packages/ui-kit", files: 5, fns: 12, dirs: [["src", 1]] },
  { name: `${SCOPE}/db-client`, kind: "package", dir: "packages/db-client", files: 4, fns: 9, dirs: [] },
  { name: `${SCOPE}/testing`, kind: "package", dir: "packages/testing", files: 2, fns: 6, dirs: [] },
  { name: "scripts", kind: "app", dir: "scripts", files: 1, fns: 1, dirs: [] },
];

/** Workspace order used for the dependency direction: earlier depends on later. */
const ORDER = [
  "scripts",
  "root",
  "web",
  "api",
  "testing",
  "ui-kit",
  "db-client",
  "core",
  "logger",
  "config",
  "types",
];
const fullName = (short: string): string =>
  short === "root" ? ROOT_NAME : short === "scripts" ? short : `${SCOPE}/${short}`;

/** [from, to, number of file-to-file import links]. */
const IMPORT_RULES: [string, string, number][] = [
  ["api", "core", 640],
  ["web", "core", 410],
  ["web", "api", 150],
  ["core", "types", 120],
  ["api", "types", 96],
  ["web", "ui-kit", 87],
  ["api", "logger", 58],
  ["core", "logger", 44],
  ["web", "types", 33],
  ["api", "config", 21],
  ["core", "config", 17],
  ["api", "db-client", 14],
  ["web", "config", 9],
  ["ui-kit", "types", 6],
  ["web", "logger", 5],
  ["db-client", "types", 4],
  ["testing", "core", 3],
  ["scripts", "core", 2],
  ["root", "config", 1],
  ["logger", "types", 1],
  ["db-client", "logger", 1],
  ["ui-kit", "logger", 1],
];

const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

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
const VERBS = [
  "get",
  "list",
  "create",
  "update",
  "remove",
  "parse",
  "format",
  "validate",
  "build",
  "load",
  "resolve",
  "sync",
];

interface LNode extends GraphNode {
  tier: number;
}

interface Data {
  nodes: Map<string, LNode>;
  children: Map<string, string[]>;
  fileImports: [string, string][];
  calls: [string, string][];
  declared: [string, string][];
  imported: [string, string][];
}

function build(): Data {
  const nodes = new Map<string, LNode>();
  const children = new Map<string, string[]>();
  const add = (n: LNode): void => {
    nodes.set(n.id, n);
    if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
  };
  const filesOfWs = new Map<string, string[]>();
  const shorts = shortLabels(SPECS.map((s) => s.name));

  for (const spec of SPECS) {
    const id = wsId(spec.name);
    const prefix = spec.dir === "." ? "" : `${spec.dir}/`;
    add({
      id,
      kind: "workspace",
      label: spec.name,
      shortLabel: shorts.get(spec.name) ?? spec.name,
      size: 1,
      path: spec.dir,
      badges: [spec.kind],
      tier: 0,
    });
    for (const [rel] of spec.dirs) {
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
      add({
        id: `dir:${prefix}${rel}`,
        kind: "dir",
        label: parentRel ? rel.slice(parentRel.length + 1) : rel,
        size: 1,
        path: `${prefix}${rel}`,
        parent: parentRel ? `dir:${prefix}${parentRel}` : id,
        tier: 1,
      });
    }
    // Files: spread over the folders that hold files (or the workspace root), heavy-tailed function counts.
    const holders = spec.dirs.filter(([, w]) => w > 0);
    const totalW = holders.reduce((s, [, w]) => s + w, 0);
    const weights: number[] = [];
    const paths: { rel: string; dir: string | null }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < spec.files; i++) {
      let dir: string | null = null;
      if (holders.length > 0) {
        let pick = hash(`${spec.name}:dir:${i}`) % totalW;
        for (const [rel, w] of holders) {
          if (pick < w) {
            dir = rel;
            break;
          }
          pick -= w;
        }
      }
      const h = hash(`${spec.name}#${i}`);
      let base =
        spec.files <= 5
          ? (["index", "types", "client", "util", "schema"][i] ?? `file${i}`)
          : `${WORDS[h % WORDS.length]}${SUFFIX[(h >>> 8) % SUFFIX.length]}`;
      if (used.has(`${dir}/${base}`)) base = `${base}${i}`;
      used.add(`${dir}/${base}`);
      paths.push({ rel: dir ? `${dir}/${base}.ts` : `${base}.ts`, dir });
      // About 4% of the files in big workspaces hold no functions (type-only, barrels).
      weights.push(spec.files > 20 && h % 25 === 0 ? 0 : (1 + (h % 9)) ** 2);
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    const fns = weights.map((w) => Math.floor((spec.fns * w) / sum));
    let left = spec.fns - fns.reduce((a, b) => a + b, 0);
    const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length) {
      const idx = (order[k] as readonly [number, number])[1];
      if ((weights[idx] as number) === 0) continue;
      fns[idx] = (fns[idx] as number) + 1;
      left--;
    }
    // Config files next to the workspace's folders (one small file each).
    for (const name of spec.rootFiles?.names ?? []) {
      paths.push({ rel: name, dir: null });
      fns.push(spec.rootFiles?.fns ?? 1);
    }
    const ids: string[] = [];
    paths.forEach((p, i) => {
      const path = `${prefix}${p.rel}`;
      const fileId = `file:${path}`;
      ids.push(fileId);
      const n = fns[i] as number;
      add({
        id: fileId,
        kind: "file",
        label: p.rel.slice(p.rel.lastIndexOf("/") + 1),
        size: 1,
        path,
        parent: p.dir ? `dir:${prefix}${p.dir}` : id,
        stats: { files: 1, functions: n, loc: n * 14 },
        tier: 2,
      });
      const base = p.rel.slice(p.rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
      for (let k = 0; k < n; k++) {
        const name =
          k === 0
            ? base
            : `${VERBS[(hash(path) + k) % VERBS.length]}${base[0]?.toUpperCase()}${base.slice(1)}${k > 11 ? k : ""}`;
        const kind =
          spec.name.endsWith("/web") && k % 5 === 0
            ? "component"
            : spec.name.endsWith("/web") && k % 7 === 3
              ? "hook"
              : k % 6 === 4
                ? "method"
                : "function";
        add({
          id: `sym:${path}#${name}`,
          kind,
          label: name,
          size: 1,
          path,
          parent: fileId,
          stats: { functions: 1, loc: 8 + ((k * 7) % 30) },
          tier: 3,
        });
      }
    });
    filesOfWs.set(id, ids);
  }

  // Roll counts up (children before parents).
  const roll = (id: string): { files: number; functions: number; loc: number } => {
    const n = nodes.get(id) as LNode;
    if (n.tier >= 3) return { files: 0, functions: 1, loc: n.stats?.loc ?? 0 };
    if (n.tier === 2) return { files: 1, functions: n.stats?.functions ?? 0, loc: n.stats?.loc ?? 0 };
    const sum = { files: 0, functions: 0, loc: 0 };
    for (const c of children.get(id) ?? []) {
      const r = roll(c);
      sum.files += r.files;
      sum.functions += r.functions;
      sum.loc += r.loc;
    }
    n.stats = sum;
    n.size = Math.max(1, sum.functions);
    return sum;
  };
  for (const spec of SPECS) roll(wsId(spec.name));

  // File-to-file imports: cross-workspace by rule, plus two local imports per file.
  const links = new Set<string>();
  const fileImports: [string, string][] = [];
  const link = (a: string, b: string): boolean => {
    if (a === b || links.has(`${a}>${b}`)) return false;
    links.add(`${a}>${b}`);
    fileImports.push([a, b]);
    return true;
  };
  const imported: [string, string][] = [];
  for (const [from, to, count] of IMPORT_RULES) {
    const a = filesOfWs.get(wsId(fullName(from))) as string[];
    const b = filesOfWs.get(wsId(fullName(to))) as string[];
    imported.push([wsId(fullName(from)), wsId(fullName(to))]);
    const cap = Math.min(count, a.length * b.length);
    for (let made = 0, k = 0; made < cap && k < cap * 40; k++) {
      const src = a[hash(`${from}>${to}:a${k}`) % a.length] as string;
      const dst = b[hash(`${from}>${to}:b${k}`) % b.length] as string;
      if (link(src, dst)) made++;
    }
  }
  for (const ids of filesOfWs.values()) {
    if (ids.length < 2) continue;
    for (const id of ids)
      for (let k = 0; k < 2; k++) link(id, ids[hash(`${id}:local${k}`) % ids.length] as string);
  }

  // A few hundred function-to-function calls across files, so a selected function has arrows.
  const calls: [string, string][] = [];
  const importedPairs0 = new Set(imported.map(([a, b]) => `${a}>${b}`));
  const rootOfNode = (n: LNode): string => {
    let cur = n;
    while (cur.parent) cur = nodes.get(cur.parent) as LNode;
    return cur.id;
  };
  const syms = [...nodes.values()].filter((n) => n.tier === 3);
  for (let k = 0; k < 900; k++) {
    const a = syms[hash(`call:a${k}`) % syms.length] as LNode;
    const b = syms[hash(`call:b${k}`) % syms.length] as LNode;
    if (a.parent === b.parent) continue;
    // Calls follow imports: inside a workspace, or along a workspace link, never against the dependency order.
    const wa = rootOfNode(a);
    const wb = rootOfNode(b);
    if (wa === wb || importedPairs0.has(`${wa}>${wb}`)) calls.push([a.id, b.id]);
  }

  // Declared-only package.json dependencies: pairs that follow ORDER and have no imports (31 of them).
  const importedPairs = new Set(imported.map(([a, b]) => `${a}>${b}`));
  const candidates: [string, string][] = [];
  for (let i = 0; i < ORDER.length; i++)
    for (let j = i + 1; j < ORDER.length; j++) {
      const pair: [string, string] = [wsId(fullName(ORDER[i] as string)), wsId(fullName(ORDER[j] as string))];
      if (!importedPairs.has(`${pair[0]}>${pair[1]}`)) candidates.push(pair);
    }
  candidates.sort((p, q) => hash(p.join()) - hash(q.join()));
  const declared = candidates.slice(0, 31);
  return { nodes, children, fileImports, calls, declared, imported };
}

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
  return new Map(
    names.map((n) => [n, strip && scopeOf(n) === shared ? n.slice((shared as string).length + 1) : n]),
  );
}

let cache: Data | undefined;

const LEVEL_TIER: Record<ViewLevel, number> = { workspaces: 0, dirs: 1, files: 2, symbols: 3 };

export interface LargeQuery {
  focus: string | null;
  level: ViewLevel | null;
  options: Record<string, string | boolean>;
}

/** Inspector data for a node of the large dataset (null when the id is not one of its nodes). */
export function largeMapNode(id: string): {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  workspaceId: string | null;
} | null {
  cache ??= build();
  const n = cache.nodes.get(id);
  if (!n) return null;
  let root = n;
  while (root.parent) root = cache.nodes.get(root.parent) as LNode;
  return { id: n.id, kind: n.kind, name: n.label, path: n.path ?? null, workspaceId: root.id };
}

/** Mirrors server/views/projectMap.ts for the large dataset (levels, focus, workspace filter, weighted edges). */
export function projectMapLarge(q: LargeQuery): ViewData | { error: string; status: number } {
  cache ??= build();
  const data = cache;
  const wsRaw = q.options.workspaces;
  const wsAllowed = typeof wsRaw === "string" && wsRaw ? new Set(wsRaw.split(/[|,]/)) : null;
  const rootOf = (id: string): string => {
    let n = data.nodes.get(id) as LNode;
    while (n.parent) n = data.nodes.get(n.parent) as LNode;
    return n.id;
  };
  const alive = (id: string): boolean => !wsAllowed || wsAllowed.has(rootOf(id));
  const levelGiven = q.level !== null;
  const maxTier = LEVEL_TIER[q.level ?? "files"];
  const returned = new Set<string>();
  const focusing = Boolean(q.focus);
  const walk = (id: string, depthLeft: number): void => {
    returned.add(id);
    if (depthLeft <= 0) return;
    for (const c of data.children.get(id) ?? []) {
      const n = data.nodes.get(c) as LNode;
      if (n.tier <= maxTier || (!levelGiven && focusing)) walk(c, depthLeft - 1);
    }
  };
  if (q.focus) {
    const f = data.nodes.get(q.focus);
    if (!f) return { status: 404, error: `Unknown focus: ${q.focus}` };
    for (
      let a = f.parent ? data.nodes.get(f.parent) : undefined;
      a;
      a = a.parent ? data.nodes.get(a.parent) : undefined
    )
      returned.add(a.id);
    walk(f.id, levelGiven ? Number.POSITIVE_INFINITY : 1);
  } else {
    for (const n of data.nodes.values()) if (n.tier <= maxTier && alive(n.id)) returned.add(n.id);
  }

  const rep = (id: string): string | undefined => {
    for (let n = data.nodes.get(id); n; n = n.parent ? data.nodes.get(n.parent) : undefined)
      if (returned.has(n.id)) return n.id;
    return undefined;
  };
  const contains = (a: string, b: string): boolean => {
    for (let n = data.nodes.get(b)?.parent; n; n = data.nodes.get(n)?.parent) if (n === a) return true;
    return false;
  };
  const agg = new Map<string, { src: string; dst: string; imports: number; uses: number }>();
  const bump = (src: string | undefined, dst: string | undefined, field: "imports" | "uses"): void => {
    if (!src || !dst || src === dst || contains(src, dst) || contains(dst, src)) return;
    const key = `${src}\0${dst}`;
    const a = agg.get(key) ?? { src, dst, imports: 0, uses: 0 };
    a[field] += 1;
    agg.set(key, a);
  };
  const wsLevel = !focusing && maxTier > 0;
  for (const [a, b] of data.fileImports) {
    if (!alive(a) || !alive(b)) continue;
    bump(rep(a), rep(b), "imports");
    if (wsLevel) bump(rootOf(a), rootOf(b), "imports");
  }
  if (maxTier >= 3 || focusing)
    for (const [a, b] of data.calls) {
      if (!alive(a) || !alive(b)) continue;
      bump(rep(a), rep(b), "uses");
    }

  const edges: GraphEdge[] = [];
  for (const a of agg.values()) {
    const kind = a.imports > 0 ? "imports" : "uses";
    const edge: GraphEdge = {
      id: `${a.src}|${kind}|${a.dst}`,
      src: a.src,
      dst: a.dst,
      kind,
      weight: a.imports > 0 ? a.imports : a.uses,
      confidence: "high",
    };
    if (a.uses > 0) edge.uses = a.uses;
    edges.push(edge);
  }
  for (const [a, b] of [...data.declared, ...data.imported.filter(([x, y]) => hash(x + y) % 3 === 0)]) {
    if (!returned.has(a) || !returned.has(b)) continue;
    edges.push({
      id: `${a}|depends_on|${b}`,
      src: a,
      dst: b,
      kind: "depends_on",
      weight: 1,
      confidence: "high",
    });
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  const nodes = [...returned].sort().map((id) => {
    const { tier: _tier, ...node } = data.nodes.get(id) as LNode;
    return node;
  });
  return { nodes, edges, layoutHint: "nested-elk" };
}

// Synthetic monorepo generator for the performance check and tests. Fully seeded; the names are made up.
import type { GraphEdge, GraphNode } from "../api.ts";
import { mulberry32 } from "./prng.ts";

export interface SyntheticOptions {
  workspaces: number;
  files: number;
  symbols: number;
  /** Symbol-to-symbol edges. */
  edges: number;
  seed: number;
}

export const SYNTHETIC_30K: SyntheticOptions = {
  workspaces: 11,
  files: 1500,
  symbols: 30_000,
  edges: 60_000,
  seed: 36,
};

const DIRS = ["src", "components", "hooks", "utils", "lib", "services", "routes", "models", "api", "state"];
const NAMES = [
  "Button",
  "Card",
  "parse",
  "format",
  "load",
  "save",
  "render",
  "use",
  "build",
  "check",
  "merge",
  "sync",
];
const KINDS = ["function", "function", "function", "component", "hook", "class", "type"];

export function generateSynthetic(opts: SyntheticOptions = SYNTHETIC_30K): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const rand = mulberry32(opts.seed);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;

  const wsIds: string[] = [];
  for (let w = 0; w < opts.workspaces; w++) {
    const kind = w < Math.ceil(opts.workspaces / 3) ? "app" : "package";
    const name = `@acme/${kind === "app" ? "app" : "pkg"}-${String.fromCharCode(97 + w)}`;
    const id = `ws:${name}`;
    wsIds.push(id);
    nodes.push({ id, kind: "workspace", label: name, size: 0, badges: [kind] });
  }
  const dirIds = new Map<string, string[]>();
  const fileIds: { id: string; ws: string }[] = [];
  for (let f = 0; f < opts.files; f++) {
    const ws = wsIds[f % wsIds.length] as string;
    const dirName = pick(DIRS);
    const dirId = `dir:${ws.slice(3)}/${dirName}`;
    if (!dirIds.has(dirId)) {
      dirIds.set(dirId, []);
      nodes.push({ id: dirId, kind: "directory", label: dirName, parent: ws, size: 0 });
    }
    const id = `file:${ws.slice(3)}/${dirName}/f${f}.ts`;
    (dirIds.get(dirId) as string[]).push(id);
    fileIds.push({ id, ws });
    nodes.push({ id, kind: "file", label: `f${f}.ts`, parent: dirId, size: 0 });
  }
  const symIds: string[] = [];
  const perFile = opts.symbols / opts.files;
  for (let s = 0; s < opts.symbols; s++) {
    const file = fileIds[Math.min(fileIds.length - 1, Math.floor(s / perFile))] as { id: string; ws: string };
    const id = `sym:${file.id.slice(5)}#s${s}`;
    symIds.push(id);
    nodes.push({ id, kind: pick(KINDS), label: `${pick(NAMES)}${s}`, parent: file.id, size: 1 });
  }
  const seen = new Set<string>();
  while (edges.length < opts.edges) {
    const a = Math.floor(rand() * symIds.length);
    // Mostly local calls (nearby symbols), some far ones.
    const b =
      rand() < 0.8
        ? Math.max(0, Math.min(symIds.length - 1, a + Math.floor((rand() - 0.5) * 400)))
        : Math.floor(rand() * symIds.length);
    if (a === b) continue;
    const key = `${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: key,
      src: symIds[a] as string,
      dst: symIds[b] as string,
      kind: "calls",
      weight: 1,
      confidence: "high",
    });
  }
  return { nodes, edges };
}

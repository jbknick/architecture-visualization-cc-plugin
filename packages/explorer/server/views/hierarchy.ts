import type { FileRecord, SymbolRecord, WorkspaceRecord } from "@gantry/core";
import type { GraphNode } from "../types.js";
import { cmp, getOrInit } from "./options.js";

/** Hierarchy tiers, shallowest first. `ext:*` nodes sit outside the hierarchy. */
export const TIER = { workspace: 0, dir: 1, file: 2, symbol: 3 } as const;

export interface HNode {
  node: GraphNode;
  tier: number;
  parent?: HNode;
  children: HNode[];
}

export interface Hierarchy {
  byId: Map<string, HNode>;
  /** Top-level nodes: workspaces, plus any directories/files that belong to no known workspace. */
  roots: HNode[];
}

interface DirTmp {
  path: string;
  dirs: Map<string, DirTmp>;
  files: FileRecord[];
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function makeNode(byId: Map<string, HNode>, node: GraphNode, tier: number, parent: HNode | undefined): HNode {
  const h: HNode = { node, tier, parent, children: [] };
  if (parent) {
    parent.children.push(h);
    node.parent = parent.node.id;
  }
  byId.set(node.id, h);
  return h;
}

/**
 * Workspace -> directory -> file -> symbol. A directory with no files of its own and exactly one
 * child directory is merged into that child (`src/features/auth` is one node).
 * Sizes and stats are summed from the symbols passed in, so callers pre-filter them.
 */
export function buildHierarchy(
  workspaces: WorkspaceRecord[],
  files: FileRecord[],
  symbolsByFile: Map<string, SymbolRecord[]>,
): Hierarchy {
  const byId = new Map<string, HNode>();
  const roots: HNode[] = [];
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const groups = new Map<string | null, FileRecord[]>();
  for (const f of [...files].sort((a, b) => cmp(a.path, b.path))) {
    const key = f.workspaceId && wsById.has(f.workspaceId) ? f.workspaceId : null;
    const g = getOrInit(groups, key, () => [] as FileRecord[]);
    g.push(f);
  }

  const addFile = (f: FileRecord, parent: HNode | undefined): void => {
    const syms = symbolsByFile.get(f.id) ?? [];
    const fileNode = makeNode(
      byId,
      {
        id: f.id,
        kind: "file",
        label: baseName(f.path),
        size: 1,
        path: f.path,
        stats: { files: 1, functions: syms.length, loc: syms.reduce((n, s) => n + s.loc, 0) },
      },
      TIER.file,
      parent,
    );
    if (!parent) roots.push(fileNode);
    for (const s of syms) {
      makeNode(
        byId,
        {
          id: s.id,
          kind: s.kind,
          label: s.name,
          size: 1,
          path: f.path,
          stats: { functions: 1, loc: s.loc },
          ...(s.exported ? { badges: ["exported"] } : {}),
        },
        TIER.symbol,
        fileNode,
      );
    }
  };

  const addDir = (tmp: DirTmp, label: string, parent: HNode | undefined): void => {
    let t = tmp;
    let name = label;
    while (t.files.length === 0 && t.dirs.size === 1) {
      const [seg, child] = [...t.dirs][0] as [string, DirTmp];
      name = `${name}/${seg}`;
      t = child;
    }
    const dirNode = makeNode(
      byId,
      { id: `dir:${t.path}`, kind: "dir", label: name, size: 1, path: t.path },
      TIER.dir,
      parent,
    );
    if (!parent) roots.push(dirNode);
    fill(t, dirNode);
  };

  const fill = (t: DirTmp, parent: HNode | undefined): void => {
    for (const [seg, child] of [...t.dirs].sort((a, b) => cmp(a[0], b[0]))) addDir(child, seg, parent);
    for (const f of t.files) addFile(f, parent);
  };

  for (const [wsId, group] of [...groups].sort((a, b) => cmp(a[0] ?? "￿", b[0] ?? "￿"))) {
    const ws = wsId ? wsById.get(wsId) : undefined;
    const base = ws && ws.dir !== "." ? `${ws.dir}/` : "";
    const root: DirTmp = { path: ws?.dir ?? ".", dirs: new Map(), files: [] };
    for (const f of group) {
      const rel = base && f.path.startsWith(base) ? f.path.slice(base.length) : f.path;
      const segs = rel.split("/").slice(0, -1);
      let cur = root;
      for (const seg of segs) {
        let next = cur.dirs.get(seg);
        if (!next) {
          next = { path: cur === root ? `${base}${seg}` : `${cur.path}/${seg}`, dirs: new Map(), files: [] };
          cur.dirs.set(seg, next);
        }
        cur = next;
      }
      cur.files.push(f);
    }
    let parent: HNode | undefined;
    if (ws) {
      parent = makeNode(
        byId,
        {
          id: ws.id,
          kind: "workspace",
          label: ws.name,
          size: 1,
          path: ws.dir,
          badges: [ws.kind, ...ws.frameworks],
        },
        TIER.workspace,
        undefined,
      );
      roots.push(parent);
    }
    fill(root, parent);
  }

  // Roll sizes and stats up (children before parents).
  const roll = (h: HNode): void => {
    if (h.tier === TIER.symbol) return;
    let files = 0;
    let functions = 0;
    let loc = 0;
    for (const c of h.children) {
      roll(c);
      files += c.node.stats?.files ?? 0;
      functions += c.node.stats?.functions ?? 0;
      loc += c.node.stats?.loc ?? 0;
    }
    if (h.tier !== TIER.file) h.node.stats = { files, functions, loc };
    h.node.size = Math.max(1, h.node.stats?.functions ?? 0);
  };
  for (const r of roots) roll(r);
  return { byId, roots };
}

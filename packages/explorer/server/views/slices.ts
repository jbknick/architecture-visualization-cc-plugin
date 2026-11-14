import {
  type AdapterNodeRecord,
  dirGlobMatcher,
  type EdgeRecord,
  type FileRecord,
  type SymbolKind,
  type SymbolRecord,
} from "@gantry/core";
import type { GraphEdge, GraphNode, ViewLevel, ViewModule, ViewResult } from "../types.js";
import { ImportAggregator } from "./aggregate.js";
import { buildBadgeIndex, symbolBadges } from "./badges.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, getOrInit, isTestPath, optBool, optList } from "./options.js";

/** Spec section 5 default for `views.slices`; used when the server runs without a loaded config. */
export const DEFAULT_SLICE_GLOBS = ["apps/*/src/features/*", "apps/*/src/modules/*", "packages/*"];
const FUNCTION_LIKE: SymbolKind[] = ["function", "method", "component", "hook"];
const SYMBOL_KINDS = new Set<string>([...FUNCTION_LIKE, "class", "type", "interface", "enum", "const"]);
const SOURCE_RE = /\.(?:tsx?|mts|cts)$/;
const USE_KINDS = ["calls", "renders", "uses_hook"];
const SHARED_MAX = 200;
const LEVEL_TIER: Partial<Record<ViewLevel, number>> = { workspaces: 0, dirs: 1, files: 1, symbols: 2 };

/** A symbol that code in at least two other slices uses. */
export interface SharedSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  /** The slice the symbol lives in. */
  slice: string;
  usedBy: { id: string; label: string }[];
}

export interface SlicesResult extends ViewResult {
  shared: SharedSymbol[];
  /** Apps (workspace ids) that had no file in any `views.slices` glob and so use first-level route segments as slices. */
  routeFallback: string[];
}

interface SliceDef {
  id: string;
  label: string;
  path?: string;
  workspace?: string;
  files: FileRecord[];
}

/**
 * View 5. Feature slices: slice -> file -> function via `parent`, laid out as nested boxes (hint `nested-elk`).
 * Slices are the directories matching the `views.slices` globs (config; default `apps/*\/src/features/*`,
 * `apps/*\/src/modules/*`, `packages/*`); a file belongs to its deepest matching directory. An app with no file in
 * any slice falls back to one slice per first-level route segment (`/posts` holds `posts.$postId.tsx`; `/` holds
 * the index and root routes), so the view still has slices for it. Files outside every slice are left out.
 *
 * Edges: file-level `imports` edges whose ends are in different slices (`cross: true`; weight = distinct file
 * imports, `bindings` = imported names), plus the same summed per slice pair when files are shown. Imports inside a
 * slice are hidden unless `intra=true`. `shared` lists the functions used (called, rendered, hooked) from at least
 * two other slices, most users first.
 *
 * Params: `level` (workspaces = slices only, dirs/files = + files, symbols = + functions; default files), `kinds`,
 * `hideTests` (default true), `intra` (default false).
 */
export const slicesView: ViewModule = {
  id: "slices",
  title: "Feature slices",
  enabled: true,
  build({ store, config }, params): SlicesResult {
    const hideTests = optBool(params, "hideTests", true);
    const intra = optBool(params, "intra", false);
    const kindList = optList(params, "kinds");
    const kinds = new Set<string>(kindList?.filter((k) => SYMBOL_KINDS.has(k)) ?? FUNCTION_LIKE);
    const maxTier = LEVEL_TIER[params.level ?? "files"] ?? 1;
    const globs = config.views?.slices ?? DEFAULT_SLICE_GLOBS;
    const match = dirGlobMatcher(globs);

    const workspaces = store.listWorkspaces();
    const files = store
      .effectiveFiles()
      .filter((f) => SOURCE_RE.test(f.path) && !(hideTests && isTestPath(f.path)));
    const dirsOf = (p: string): string[] => {
      const segs = p.split("/").slice(0, -1);
      const out: string[] = [];
      for (let i = segs.length; i >= 1; i--) out.push(segs.slice(0, i).join("/"));
      return out;
    };

    // 1. Glob slices: a file belongs to its deepest matching directory.
    const slices = new Map<string, SliceDef>();
    const sliceOfFile = new Map<string, string>();
    const withMatch = new Set<string>();
    for (const f of files) {
      const dir = dirsOf(f.path).find(match);
      if (dir === undefined) continue;
      const id = `slice:${dir}`;
      const s = getOrInit(slices, id, () => ({
        id,
        label: dir,
        path: dir,
        ...(f.workspaceId ? { workspace: f.workspaceId } : {}),
        files: [] as FileRecord[],
      }));
      s.files.push(f);
      sliceOfFile.set(f.id, id);
      if (f.workspaceId) withMatch.add(f.workspaceId);
    }

    // 2. Route fallback for apps with routes but no glob match.
    const routeFallback: string[] = [];
    const shortNames = shortWorkspaceLabels(workspaces.map((w) => w.name));
    const filesById = new Map(files.map((f) => [f.id, f]));
    const routesByWs = new Map<string, AdapterNodeRecord[]>();
    for (const r of store.effectiveAdapterNodes({ kind: "route" })) {
      if (r.ws) getOrInit(routesByWs, r.ws, () => []).push(r);
    }
    for (const w of workspaces) {
      const routes = routesByWs.get(w.id);
      if (!routes || withMatch.has(w.id)) continue;
      routeFallback.push(w.id);
      for (const r of routes) {
        const f = filesById.get(r.fileId);
        if (!f) continue;
        const urlPath = typeof r.data.urlPath === "string" ? r.data.urlPath : "/";
        const first = urlPath.split("/")[1] ?? "";
        const key = first === "" ? "/" : `/${first}`;
        const id = `slice:${w.dir}#${key}`;
        const s = getOrInit(slices, id, () => ({
          id,
          label: `${shortNames.get(w.name) ?? w.name} ${key}`,
          path: w.dir,
          workspace: w.id,
          files: [] as FileRecord[],
        }));
        s.files.push(f);
        sliceOfFile.set(f.id, id);
      }
    }

    // 3. Nodes.
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const sliceOfSym = new Map<string, string>();
    const symById = new Map<string, SymbolRecord>();
    for (const s of store.effectiveSymbols()) {
      symById.set(s.id, s);
      const sl = sliceOfFile.get(s.fileId);
      if (sl) sliceOfSym.set(s.id, sl);
      if (sl && kinds.has(s.kind)) getOrInit(symbolsByFile, s.fileId, () => [] as SymbolRecord[]).push(s);
    }
    const badgeIndex = buildBadgeIndex(store);
    const nodes: GraphNode[] = [];
    for (const s of [...slices.values()].sort((a, b) => cmp(a.id, b.id))) {
      let fns = 0;
      let loc = 0;
      const fileNodes: GraphNode[] = [];
      const symNodes: GraphNode[] = [];
      for (const f of [...s.files].sort((a, b) => cmp(a.path, b.path))) {
        const syms = symbolsByFile.get(f.id) ?? [];
        fns += syms.length;
        const fLoc = syms.reduce((n, x) => n + x.loc, 0);
        loc += fLoc;
        fileNodes.push({
          id: f.id,
          kind: "file",
          label: f.path.slice(f.path.lastIndexOf("/") + 1),
          size: 1,
          path: f.path,
          parent: s.id,
          stats: { files: 1, functions: syms.length, loc: fLoc },
          ...(s.workspace ? { workspace: s.workspace } : {}),
        });
        if (maxTier >= 2) {
          for (const x of syms) {
            symNodes.push({
              id: x.id,
              kind: x.kind,
              label: x.name,
              size: 1,
              path: f.path,
              parent: f.id,
              stats: { functions: 1, loc: x.loc },
              ...symbolBadges(x, badgeIndex),
              ...(s.workspace ? { workspace: s.workspace } : {}),
            });
          }
        }
      }
      nodes.push({
        id: s.id,
        kind: "slice",
        label: s.label,
        size: Math.max(1, fns),
        ...(s.path ? { path: s.path } : {}),
        ...(s.workspace ? { workspace: s.workspace } : {}),
        stats: { files: s.files.length, functions: fns, loc },
      });
      if (maxTier >= 1) nodes.push(...fileNodes, ...symNodes);
    }

    // 4. Import edges between slices.
    const agg = new ImportAggregator(); // file level (or slice level when files are not shown)
    const sliceAgg = new ImportAggregator(); // slice level, summed for the zoomed-out picture
    const crossKeys = new Set<string>();
    const rep = (fileId: string): string => (maxTier >= 1 ? fileId : (sliceOfFile.get(fileId) as string));
    for (const e of store.effectiveEdges({ kind: ["imports"] })) {
      const a = sliceOfFile.get(e.src);
      const b = sliceOfFile.get(e.dst);
      if (!a || !b) continue;
      if (a === b) {
        if (intra && maxTier >= 1) agg.add(e.src, e.dst, e);
        continue;
      }
      agg.add(rep(e.src), rep(e.dst), e);
      crossKeys.add(`${rep(e.src)}|imports|${rep(e.dst)}`);
      if (maxTier >= 1) sliceAgg.add(a, b, e);
    }
    const edgeList: GraphEdge[] = agg.edges().map((e) => ({ ...e, cross: crossKeys.has(e.id) }));
    for (const e of sliceAgg.edges()) edgeList.push({ ...e, cross: true });

    // 5. Functions used from at least two other slices.
    const users = new Map<string, Set<string>>();
    const sliceLabel = (id: string): string => slices.get(id)?.label ?? id;
    for (const e of store.effectiveEdges({ kind: USE_KINDS as EdgeRecord["kind"][] })) {
      const dstSlice = sliceOfSym.get(e.dst);
      const srcSlice = sliceOfSym.get(e.src) ?? sliceOfFile.get(e.src);
      if (!dstSlice || !srcSlice || dstSlice === srcSlice) continue;
      getOrInit(users, e.dst, () => new Set<string>()).add(srcSlice);
    }
    const shared: SharedSymbol[] = [];
    for (const [id, from] of users) {
      if (from.size < 2) continue;
      const s = symById.get(id) as SymbolRecord;
      shared.push({
        id,
        name: s.name,
        kind: s.kind,
        path: filesById.get(s.fileId)?.path ?? "",
        slice: sliceOfSym.get(id) as string,
        usedBy: [...from].sort(cmp).map((x) => ({ id: x, label: sliceLabel(x) })),
      });
    }
    shared.sort((a, b) => b.usedBy.length - a.usedBy.length || cmp(a.id, b.id));

    return {
      nodes: nodes.sort((a, b) => cmp(a.id, b.id)),
      edges: edgeList.sort((a, b) => cmp(a.id, b.id)),
      layoutHint: "nested-elk",
      shared: shared.slice(0, SHARED_MAX),
      routeFallback,
    };
  },
};

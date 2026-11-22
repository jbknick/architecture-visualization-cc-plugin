import {
  type EdgeRecord,
  isFileId,
  repoOfId,
  type Store,
  type SymbolKind,
  type SymbolRecord,
  type WorkspaceRecord,
} from "@gantry/core";
import { HttpError } from "../errors.js";
import type { GraphEdge, GraphNode, ViewLevel, ViewModule, ViewParams, ViewResult } from "../types.js";
import { addImportEdge, type ImportTally, importGraphEdge, newImportTally } from "./aggregate.js";
import { buildBadgeIndex } from "./badges.js";
import { addRepoTier, buildHierarchy, type HNode, TIER } from "./hierarchy.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, getOrInit, isTestPath, optBool, optList } from "./options.js";
import { type MapPlacement, reviewFor, wantsReview } from "./review.js";

const LEVEL_TIER: Record<ViewLevel, number> = {
  repos: TIER.repo,
  workspaces: TIER.workspace,
  dirs: 1,
  files: 2,
  symbols: 3,
};
const FUNCTION_LIKE: SymbolKind[] = ["function", "method", "component", "hook"];
const SYMBOL_KINDS = new Set<string>([
  "function",
  "method",
  "component",
  "hook",
  "class",
  "type",
  "interface",
  "enum",
  "const",
]);
const USE_KINDS = new Set(["calls", "renders", "uses_hook"]);

interface Agg {
  /** Distinct file-level imports edges under the pair; see aggregate.ts. */
  tally: ImportTally;
  uses: number;
  low: boolean;
}

/**
 * View 1. Hierarchy workspace -> directory -> file -> symbol via `parent`, plus aggregated meta-edges.
 * Params: `level` (repos|workspaces|dirs|files|symbols, default files); `focus=<node id>` returns that subtree
 * plus its ancestors (direct children only, unless `level` is also given); filters `repos`, `workspaces`, `kinds`,
 * `exportedOnly`, `hideTests` (default true), `showExternal` (default false).
 *
 * A store of several repos adds a top tier `repo:<name>` above the workspaces and the `repos` level. An edge whose
 * ends are in different repos carries `crossRepo: true`; an import of a package that a workspace of another repo
 * publishes links the two workspaces (and, at the `repos` level, the two repos). A store of one repo has none of this.
 *
 * Edges: each underlying edge is moved to the deepest returned node containing each end, then summed per
 * node pair. Pairs where one node contains the other, and pairs with an end outside the response, are
 * dropped. `imports` edges weigh file-level import edges; call/render/hook edges between the same pair go
 * into `uses` (and form their own `uses` edge when there is no import).
 */
export const projectMapView: ViewModule = {
  id: "project-map",
  title: "Project map",
  enabled: true,
  build(ctx, params: ViewParams) {
    const { result, place } = buildProjectMap(ctx.store, params);
    if (!wantsReview(params)) return result;
    // A `range` or `pr` adds the review layer (#167); the nodes and edges stay exactly the plain map's.
    return reviewFor(ctx, params, place).then((review) => ({ ...result, review }));
  },
};

/** The project map, plus where it puts any store id (for the review layer). */
export function buildProjectMap(
  store: Store,
  params: ViewParams,
): { result: ViewResult; place: MapPlacement } {
  const hideTests = optBool(params, "hideTests", true);
  const exportedOnly = optBool(params, "exportedOnly", false);
  const showExternal = optBool(params, "showExternal", false);
  const wsFilter = optList(params, "workspaces");
  const repoFilter = optList(params, "repos");
  const kindList = optList(params, "kinds");
  const kinds = new Set<string>(kindList?.filter((k) => SYMBOL_KINDS.has(k)) ?? FUNCTION_LIKE);

  const workspaces = store.listWorkspaces();
  const multiRepo = store.listRepos().length > 1;
  const wsAllowed = wsFilter ? new Set(wsFilter) : undefined;
  const repoAllowed = repoFilter ? new Set(repoFilter) : undefined;
  const files = store.effectiveFiles().filter((f) => {
    if (hideTests && isTestPath(f.path)) return false;
    if (repoAllowed && !repoAllowed.has(repoOfId(f.id) as string)) return false;
    if (wsAllowed && !(f.workspaceId && wsAllowed.has(f.workspaceId))) return false;
    return true;
  });
  const fileIds = new Set(files.map((f) => f.id));
  const fileOfSym = new Map<string, string>();
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const s of store.effectiveSymbols()) {
    fileOfSym.set(s.id, s.fileId);
    if (!fileIds.has(s.fileId) || !kinds.has(s.kind) || (exportedOnly && !s.exported)) continue;
    getOrInit(symbolsByFile, s.fileId, () => [] as SymbolRecord[]).push(s);
  }
  const hierarchy = buildHierarchy(
    wsAllowed ? workspaces.filter((w) => wsAllowed.has(w.id)) : workspaces,
    files,
    symbolsByFile,
    buildBadgeIndex(store),
  );
  if (multiRepo) addRepoTier(hierarchy);
  const { byId } = hierarchy;

  // Which nodes are returned.
  const levelGiven = params.level !== undefined;
  const maxTier = LEVEL_TIER[params.level ?? "files"];
  const returned = new Set<string>();
  const repable = new Set<string>(); // returned nodes edges may attach to (not bare ancestors of the focus)
  const walk = (h: HNode, depthLeft: number): void => {
    returned.add(h.node.id);
    repable.add(h.node.id);
    if (depthLeft <= 0) return;
    for (const c of h.children)
      if (c.tier <= maxTier || (!levelGiven && params.focus)) walk(c, depthLeft - 1);
  };
  const focusing = Boolean(params.focus);
  if (params.focus) {
    const f = byId.get(params.focus);
    if (!f) throw new HttpError(404, `Unknown focus: ${params.focus}`);
    for (let a = f.parent; a; a = a.parent) returned.add(a.node.id);
    walk(f, levelGiven ? Number.POSITIVE_INFINITY : 1);
    if (levelGiven && f.tier > maxTier) repable.add(f.node.id);
  } else {
    for (const h of byId.values()) {
      if (h.tier <= maxTier) {
        returned.add(h.node.id);
        repable.add(h.node.id);
      }
    }
  }

  const edges = store.effectiveEdges();
  const nodes = new Map<string, GraphNode>();
  for (const id of returned) nodes.set(id, (byId.get(id) as HNode).node);
  // Same short names as the 3D map, computed over every workspace so a filter never changes them.
  const shortLabels = shortWorkspaceLabels(workspaces.map((w) => w.name));
  for (const n of nodes.values()) {
    if (n.kind === "workspace") n.shortLabel = shortLabels.get(n.label) ?? n.label;
  }

  // External packages: only in the unfocused map.
  const externalFiles = new Map<string, Set<string>>();
  if (showExternal && !focusing) {
    for (const e of edges) {
      if (e.kind === "imports" && e.dst.startsWith("ext:") && fileIds.has(e.src)) {
        getOrInit(externalFiles, e.dst, () => new Set<string>()).add(e.src);
      }
    }
    for (const [id, importers] of externalFiles) {
      nodes.set(id, { id, kind: "external", label: id.slice(4), size: importers.size });
      repable.add(id);
    }
  }

  // Deepest repable node containing a file / symbol.
  const repFileCache = new Map<string, string | undefined>();
  const repFile = (fileId: string): string | undefined => {
    if (repFileCache.has(fileId)) return repFileCache.get(fileId);
    let rep: string | undefined;
    for (let h = byId.get(fileId); h; h = h.parent) {
      if (repable.has(h.node.id)) {
        rep = h.node.id;
        break;
      }
    }
    repFileCache.set(fileId, rep);
    return rep;
  };
  const repSym = (id: string): string | undefined => {
    if (repable.has(id) && byId.has(id)) return id;
    if (isFileId(id)) return repFile(id);
    const fid = fileOfSym.get(id);
    return fid ? repFile(fid) : undefined;
  };
  const contains = (a: string, b: string): boolean => {
    for (let h = byId.get(b)?.parent; h; h = h.parent) if (h.node.id === a) return true;
    return false;
  };

  const agg = new Map<string, Agg & { src: string; dst: string }>();
  const add = (
    src: string | undefined,
    dst: string | undefined,
    e: EdgeRecord,
    field: "imports" | "uses",
  ): void => {
    if (!src || !dst || src === dst || contains(src, dst) || contains(dst, src)) return;
    const key = `${src}\0${dst}`;
    const a = getOrInit(agg, key, () => ({ src, dst, tally: newImportTally(), uses: 0, low: false }));
    if (field === "imports") addImportEdge(a.tally, e);
    else {
      a.uses += 1;
      if (e.confidence === "low") a.low = true;
    }
  };
  const wsOf = (fileId: string): string | undefined => {
    for (let h = byId.get(fileId); h; h = h.parent) if (h.tier === TIER.workspace) return h.node.id;
    return undefined;
  };
  const wsLevel = !focusing && maxTier > TIER.workspace;
  // A package that a workspace of another repo publishes: an import of it links the two workspaces.
  const published = new Map<string, WorkspaceRecord[]>();
  if (multiRepo)
    for (const w of workspaces) getOrInit(published, w.name, () => [] as WorkspaceRecord[]).push(w);
  const siblingOf = (specifier: string, fromRepo: string | undefined): WorkspaceRecord | undefined => {
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : (specifier.split("/")[0] as string);
    return published.get(name)?.find((w) => repoOfId(w.id) !== fromRepo && byId.has(w.id));
  };
  /** The returned node standing for `id`: itself, or the nearest ancestor that is returned. */
  const shownAs = (id: string): string | undefined => {
    for (let h = byId.get(id); h; h = h.parent) if (repable.has(h.node.id)) return h.node.id;
    return undefined;
  };

  const dependsOn = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (e.kind === "imports") {
      if (!fileIds.has(e.src)) continue;
      const dst = e.dst.startsWith("ext:")
        ? nodes.has(e.dst)
          ? e.dst
          : undefined
        : fileIds.has(e.dst)
          ? repFile(e.dst)
          : undefined;
      add(repFile(e.src), dst, e, "imports");
      if (multiRepo && e.dst.startsWith("ext:")) {
        const sibling = siblingOf(e.dst.slice(4), repoOfId(e.src));
        const from = wsOf(e.src);
        if (sibling && from) add(shownAs(from), shownAs(sibling.id), e, "imports");
      }
      if (wsLevel && fileIds.has(e.dst)) add(wsOf(e.src), wsOf(e.dst), e, "imports");
    } else if (USE_KINDS.has(e.kind)) {
      const sf = fileOfSym.get(e.src) ?? (isFileId(e.src) ? e.src : undefined);
      const df = fileOfSym.get(e.dst) ?? (isFileId(e.dst) ? e.dst : undefined);
      if (!sf || !df || !fileIds.has(sf) || !fileIds.has(df)) continue;
      add(repSym(e.src), repSym(e.dst), e, "uses");
      if (wsLevel) add(wsOf(sf), wsOf(df), e, "uses");
    } else if (e.kind === "depends_on" && repable.has(e.src) && repable.has(e.dst) && e.src !== e.dst) {
      const id = `${e.src}|depends_on|${e.dst}`;
      dependsOn.set(id, {
        id,
        src: e.src,
        dst: e.dst,
        kind: "depends_on",
        weight: e.count,
        confidence: e.confidence,
      });
    }
  }

  const out: GraphEdge[] = [...dependsOn.values()];
  for (const a of agg.values()) {
    const edge: GraphEdge =
      a.tally.imports > 0
        ? importGraphEdge(a.src, a.dst, a.tally)
        : {
            id: `${a.src}|uses|${a.dst}`,
            src: a.src,
            dst: a.dst,
            kind: "uses",
            weight: a.uses,
            confidence: a.low ? "low" : "high",
          };
    if (a.uses > 0) edge.uses = a.uses;
    out.push(edge);
  }
  if (multiRepo) {
    const repoOfNode = (id: string): string | undefined => {
      for (let h = byId.get(id); h; h = h.parent) if (h.tier === TIER.repo) return h.node.label;
      return undefined;
    };
    for (const e of out) {
      const a = repoOfNode(e.src);
      const b = repoOfNode(e.dst);
      if (a !== undefined && b !== undefined && a !== b) e.crossRepo = true;
    }
  }
  out.sort((a, b) => cmp(a.id, b.id));
  return {
    result: {
      nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
      edges: out,
      layoutHint: "nested-elk",
    },
    place: { rep: repSym, contains },
  };
}

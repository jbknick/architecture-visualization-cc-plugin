import type { EdgeRecord, SymbolKind, SymbolRecord } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { GraphEdge, GraphNode, ViewLevel, ViewModule, ViewParams } from "../types.js";
import { buildHierarchy, type HNode, TIER } from "./hierarchy.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, getOrInit, isTestPath, optBool, optList } from "./options.js";

const LEVEL_TIER: Record<ViewLevel, number> = { workspaces: 0, dirs: 1, files: 2, symbols: 3 };
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
  imports: number;
  uses: number;
  low: boolean;
}

/**
 * View 1. Hierarchy workspace -> directory -> file -> symbol via `parent`, plus aggregated meta-edges.
 * Params: `level` (workspaces|dirs|files|symbols, default files); `focus=<node id>` returns that subtree
 * plus its ancestors (direct children only, unless `level` is also given); filters `workspaces`, `kinds`,
 * `exportedOnly`, `hideTests` (default true), `showExternal` (default false).
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
  build({ store }, params: ViewParams) {
    const hideTests = optBool(params, "hideTests", true);
    const exportedOnly = optBool(params, "exportedOnly", false);
    const showExternal = optBool(params, "showExternal", false);
    const wsFilter = optList(params, "workspaces");
    const kindList = optList(params, "kinds");
    const kinds = new Set<string>(kindList?.filter((k) => SYMBOL_KINDS.has(k)) ?? FUNCTION_LIKE);

    const workspaces = store.listWorkspaces();
    const wsAllowed = wsFilter ? new Set(wsFilter) : undefined;
    const files = store.effectiveFiles().filter((f) => {
      if (hideTests && isTestPath(f.path)) return false;
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
    const { byId } = buildHierarchy(
      wsAllowed ? workspaces.filter((w) => wsAllowed.has(w.id)) : workspaces,
      files,
      symbolsByFile,
    );

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
      if (id.startsWith("file:")) return repFile(id);
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
      const a = getOrInit(agg, key, () => ({ src, dst, imports: 0, uses: 0, low: false }));
      a[field] += 1;
      if (e.confidence === "low") a.low = true;
    };
    const wsOf = (fileId: string): string | undefined => {
      for (let h = byId.get(fileId); h; h = h.parent) if (h.tier === TIER.workspace) return h.node.id;
      return undefined;
    };
    const wsLevel = !focusing && maxTier > TIER.workspace;

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
        if (wsLevel && fileIds.has(e.dst)) add(wsOf(e.src), wsOf(e.dst), e, "imports");
      } else if (USE_KINDS.has(e.kind)) {
        const sf = fileOfSym.get(e.src) ?? (e.src.startsWith("file:") ? e.src : undefined);
        const df = fileOfSym.get(e.dst) ?? (e.dst.startsWith("file:") ? e.dst : undefined);
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
      const kind = a.imports > 0 ? "imports" : "uses";
      const edge: GraphEdge = {
        id: `${a.src}|${kind}|${a.dst}`,
        src: a.src,
        dst: a.dst,
        kind,
        weight: a.imports > 0 ? a.imports : a.uses,
        confidence: a.low ? "low" : "high",
      };
      if (a.uses > 0) edge.uses = a.uses;
      out.push(edge);
    }
    out.sort((a, b) => cmp(a.id, b.id));
    return {
      nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
      edges: out,
      layoutHint: "nested-elk",
    };
  },
};

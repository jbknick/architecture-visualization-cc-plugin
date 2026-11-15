import type { AdapterNodeRecord, EdgeRecord, FileRecord, SymbolRecord } from "@gantry/core";
import { HttpError } from "../errors.js";
import type { GraphEdge, GraphNode, ViewModule, ViewResult } from "../types.js";
import { buildBadgeIndex, symbolBadges } from "./badges.js";
import { shortWorkspaceLabels } from "./labels.js";
import { cmp, getOrInit, optInt, optList } from "./options.js";

export const PAGES_DEPTH_DEFAULT = 2;
export const PAGES_DEPTH_MAX = 4;

/** An app that has routes, for the filter panel (always listed, whatever the `app` filter says). */
export interface PagesApp {
  id: string;
  name: string;
  shortLabel: string;
  routes: number;
}

export interface PagesResult extends ViewResult {
  apps: PagesApp[];
}

interface Link {
  src: string;
  dst: string;
  kind: "renders" | "uses_hook";
  count: number;
  low: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `/settings/` -> `/settings`; the empty string and `/` are the whole tree. */
function normalizePrefix(raw: string | undefined): string {
  if (!raw) return "";
  const p = `/${raw.trim().replace(/^\/+|\/+$/g, "")}`;
  return p === "/" ? "" : p;
}

const underPrefix = (urlPath: string, prefix: string): boolean =>
  prefix === "" || urlPath === prefix || urlPath.startsWith(`${prefix}/`);

function routeBadges(r: AdapterNodeRecord): string[] {
  const d = r.data;
  const out: string[] = [];
  if (d.root === true) out.push("root layout");
  else if (d.pathless === true) out.push("layout");
  else if (d.index === true) out.push("index");
  if (str(d.loader)) out.push("loader");
  if (str(d.beforeLoad)) out.push("beforeLoad");
  if (Array.isArray(d.options) && d.options.includes("server")) out.push("server");
  return out;
}

/**
 * View 4. Pages: the TanStack Router file routes of each app as a tree, left to right (layout hint `tree-lr`).
 * A route node has the id `route:<package>:<route id>` (kind `route`, label = its URL path); `contains` edges
 * join a route to its child routes and `serves` edges a route to its component. From each component the view follows
 * `renders` and `uses_hook` edges for `hops` steps (option `hops`, 1-4, default 2; `depth` is accepted as an alias).
 * A component or hook reached from several places is one node with several incoming edges.
 *
 * Filters: `app` (workspace id or package name; `|` separates several), `prefix` (a route URL prefix such as
 * `/settings`; the matching routes and their ancestors are kept). The response also lists every app with routes
 * (`apps`) so a panel can offer them all whatever the filter is.
 */
export const pagesView: ViewModule = {
  id: "pages",
  title: "Pages",
  enabled: true,
  build({ store }, params): PagesResult {
    const hops = optInt(params, "hops") ?? params.depth ?? PAGES_DEPTH_DEFAULT;
    if (!Number.isInteger(hops) || hops < 1 || hops > PAGES_DEPTH_MAX)
      throw new HttpError(400, `hops must be an integer 1-${PAGES_DEPTH_MAX}`);
    const appFilter = optList(params, "app");
    const rawPrefix = params.options?.prefix;
    const prefix = normalizePrefix(typeof rawPrefix === "string" ? rawPrefix : undefined);

    const workspaces = store.listWorkspaces();
    const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
    const shortNames = shortWorkspaceLabels(workspaces.map((w) => w.name));
    const allRoutes = store.effectiveAdapterNodes({ kind: "route" });
    const perApp = new Map<string, number>();
    for (const r of allRoutes) if (r.ws) perApp.set(r.ws, (perApp.get(r.ws) ?? 0) + 1);
    const apps: PagesApp[] = [...perApp]
      .map(([id, routes]) => {
        const name = wsName.get(id) ?? id;
        return { id, name, shortLabel: shortNames.get(name) ?? name, routes };
      })
      .sort((a, b) => cmp(a.id, b.id));

    // Routes of the chosen apps; with a prefix, the matching routes and every ancestor of them.
    const appOk = (ws: string | null): boolean =>
      !appFilter || (ws !== null && (appFilter.includes(ws) || appFilter.includes(wsName.get(ws) ?? "")));
    const inApp = allRoutes.filter((r) => appOk(r.ws));
    const contains = store.effectiveEdges({ kind: ["contains"] });
    const parentOf = new Map<string, string>();
    for (const e of contains) if (e.src.startsWith("route:")) parentOf.set(e.dst, e.src);
    const kept = new Set<string>();
    for (const r of inApp) {
      if (r.data.root === true || !underPrefix(str(r.data.urlPath) ?? "/", prefix)) continue;
      for (let id: string | undefined = r.id; id && !kept.has(id); id = parentOf.get(id)) kept.add(id);
    }
    const routes = inApp.filter((r) => kept.has(r.id));

    const files = new Map<string, FileRecord>(store.effectiveFiles().map((f) => [f.id, f]));
    const symbols = new Map<string, SymbolRecord>(store.effectiveSymbols().map((s) => [s.id, s]));
    const badgeIndex = buildBadgeIndex(store);
    const wsOfFile = (fileId: string): string | undefined => files.get(fileId)?.workspaceId ?? undefined;

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const addEdge = (e: EdgeRecord | Link, kind: string): void => {
      const id = `${e.src}|${kind}|${e.dst}`;
      const cur = edges.get(id);
      const weight = "count" in e ? e.count : 1;
      const low = "low" in e ? e.low : e.confidence === "low";
      if (cur) {
        cur.weight += weight;
        if (low) cur.confidence = "low";
      } else edges.set(id, { id, src: e.src, dst: e.dst, kind, weight, confidence: low ? "low" : "high" });
    };

    for (const r of routes) {
      const badges = routeBadges(r);
      nodes.set(r.id, {
        id: r.id,
        kind: "route",
        label: r.label,
        size: 1,
        path: str(r.data.path),
        ...(r.ws ? { workspace: r.ws } : {}),
        ...(badges.length > 0 ? { badges } : {}),
      });
    }
    for (const e of contains) if (nodes.has(e.src) && nodes.has(e.dst)) addEdge(e, "contains");

    // Components: where `serves` leads, then `renders` / `uses_hook` descendants up to `hops` steps.
    const symNode = (s: SymbolRecord): GraphNode => {
      const ws = wsOfFile(s.fileId);
      return {
        id: s.id,
        kind: s.kind,
        label: s.name,
        size: 1,
        path: files.get(s.fileId)?.path,
        stats: { functions: 1, loc: s.loc },
        ...symbolBadges(s, badgeIndex),
        ...(ws ? { workspace: ws } : {}),
      };
    };
    const hop = new Map<string, number>();
    let frontier: string[] = [];
    for (const e of store.effectiveEdges({ kind: ["serves"] })) {
      const s = symbols.get(e.dst);
      if (!nodes.has(e.src) || !s) continue;
      addEdge(e, "serves");
      if (!hop.has(s.id)) {
        hop.set(s.id, 0);
        nodes.set(s.id, symNode(s));
        frontier.push(s.id);
      }
    }
    // A route file's own `Route` constant (`Route.useParams()`) is plumbing, not a page part.
    const isRouteConst = (s: SymbolRecord): boolean => s.name === "Route" && s.kind === "const";
    const out = new Map<string, Link[]>();
    for (const e of store.effectiveEdges({ kind: ["renders", "uses_hook"] })) {
      const dst = symbols.get(e.dst);
      if (!symbols.has(e.src) || !dst || isRouteConst(dst)) continue;
      getOrInit(out, e.src, () => [] as Link[]).push({
        src: e.src,
        dst: e.dst,
        kind: e.kind as Link["kind"],
        count: e.count,
        low: e.confidence === "low",
      });
    }
    for (let h = 0; h < hops && frontier.length > 0; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const l of out.get(id) ?? []) {
          const dst = symbols.get(l.dst) as SymbolRecord;
          if (!hop.has(l.dst)) {
            hop.set(l.dst, h + 1);
            nodes.set(l.dst, symNode(dst));
            next.push(l.dst);
          }
          addEdge(l, l.kind);
        }
      }
      frontier = next;
    }

    // "shared": reached from more than one place (several routes, or a route and a component).
    const incoming = new Map<string, Set<string>>();
    for (const e of edges.values()) {
      if (e.kind === "contains") continue;
      getOrInit(incoming, e.dst, () => new Set<string>()).add(e.src);
    }
    for (const [id, from] of incoming) {
      const n = nodes.get(id);
      if (n && from.size >= 2) n.badges = [...(n.badges ?? []), `shared by ${from.size}`];
    }

    return {
      nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
      edges: [...edges.values()].sort((a, b) => cmp(a.id, b.id)),
      layoutHint: "tree-lr",
      apps,
    };
  },
};

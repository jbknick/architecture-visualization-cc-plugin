import { parseSync } from "oxc-parser";
import { routeId as makeRouteId } from "../ids.js";
import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { ParsedFile } from "../parse/index.js";
import {
  mapRouteFile,
  type OptionRead,
  parentRouteId,
  ROUTE_ROOT_ID,
  type RouteFileMapping,
  readOptions,
  routesDirectoryFor,
  urlPathOfRouteId,
} from "../recipe/helpers/fs-routes.js";
import type { Resolver } from "../resolve/index.js";
import type { AdapterNodeRecord, EdgeRecord, WorkspaceRecord } from "../types.js";
import type { Adapter, AdapterNode } from "./framework.js";

export {
  mapRouteFile,
  parentRouteId,
  ROUTE_ROOT_ID,
  type RouteFileMapping,
  routesDirectoryFor,
  urlPathOfRouteId,
} from "../recipe/helpers/fs-routes.js";

/**
 * TanStack Router file-route detection (route detection only; server functions are M6). The file naming rules live in
 * `recipe/helpers/fs-routes.ts`, where the recipe adapter reads them too; this built-in adapter stays until agent-written
 * recipes are measured.
 */

const FRAMEWORKS = ["@tanstack/react-router", "@tanstack/react-start"];

export function isRouterWorkspace(ws: WorkspaceRecord): boolean {
  return ws.kind === "app" && ws.frameworks.some((f) => FRAMEWORKS.includes(f));
}

// ---------------------------------------------------------------------------------------------------------
// Detection

export interface RouteSourceFile {
  /** Repo-relative posix path. */
  path: string;
  id: string;
  workspaceId: string;
  source: string;
}

export interface DetectRoutesInput {
  root: string;
  repo: string;
  workspaces: WorkspaceRecord[];
  files: RouteSourceFile[];
  parsed: { get(fileId: string): ParsedFile | undefined };
  resolver: Pick<Resolver, "resolveSpecifier" | "resolveSymbol">;
}

export interface DetectedRoutes {
  nodes: AdapterNodeRecord[];
  edges: EdgeRecord[];
}

export interface RouteCall {
  /** The literal argument of `createFileRoute("...")`; absent for the root route or a call without one. */
  idArg?: string;
  root: boolean;
  options: OptionRead;
}

export interface RouteCallNode {
  idArg?: string;
  root: boolean;
  /** The options argument (`{ component, loader, ... }`) as an AST node, when there is one. */
  options: unknown;
}

/** First `createFileRoute(...)(...)` / `createRootRoute(...)` / `createRootRouteWithContext()(...)` call among the statements. */
export function findRouteCall(body: Node[]): RouteCallNode | null {
  let found: RouteCallNode | null = null;
  visit(body, (n) => {
    if (found) return false;
    if (n.type !== "CallExpression") return undefined;
    const callee = unwrap(n.callee);
    if (!isNode(callee)) return undefined;
    const args = Array.isArray(n.arguments) ? (n.arguments as unknown[]) : [];
    if (callee.type === "Identifier" && callee.name === "createRootRoute") {
      found = { root: true, options: args[0] };
      return false;
    }
    if (callee.type === "CallExpression") {
      const inner = unwrap(callee.callee);
      if (!isNode(inner) || inner.type !== "Identifier") return undefined;
      if (inner.name === "createRootRouteWithContext") {
        found = { root: true, options: args[0] };
        return false;
      }
      if (inner.name === "createFileRoute") {
        const a0 = Array.isArray(callee.arguments) ? unwrap((callee.arguments as unknown[])[0]) : undefined;
        const idArg =
          isNode(a0) && a0.type === "Literal" && typeof a0.value === "string" ? a0.value : undefined;
        found = { ...(idArg !== undefined ? { idArg } : {}), root: false, options: args[0] };
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/** First route call in the file (see `findRouteCall`), with its options read. */
export function readRouteCall(fileName: string, source: string): RouteCall | null {
  let body: Node[];
  try {
    const lang = fileName.endsWith("x") ? "tsx" : "ts";
    const r = parseSync(fileName, source, { sourceType: "module", lang, preserveParens: false });
    body = nodeArray((r.program as unknown as { body?: unknown }).body);
  } catch {
    return null;
  }
  const c = findRouteCall(body);
  if (!c) return null;
  return {
    ...(c.idArg !== undefined ? { idArg: c.idArg } : {}),
    root: c.root,
    options: readOptions(c.options),
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The component symbol a route names: a symbol of the route file, or an imported one followed through the resolver. */
function componentSymbol(
  pf: ParsedFile | undefined,
  fileId: string,
  name: string,
  resolver: DetectRoutesInput["resolver"],
): string | null {
  if (!pf || name === "inline" || name === "expression") return null;
  const local = pf.symbols.find((s) => s.name === name);
  if (local) return local.id;
  const imp = pf.imports.find((i) => i.local === name && i.local !== "");
  if (!imp || imp.imported === "*") return null;
  const target = resolver.resolveSpecifier(fileId, imp.specifier);
  return target.kind === "file" ? resolver.resolveSymbol(target.fileId, imp.imported) : null;
}

/**
 * Finds the routes of every app workspace that uses TanStack Router and returns their nodes (`kind: "route"`,
 * id `route:<package name>:<route id>`) and the `contains` (parent route -> child route, stored on the child's
 * file) and `serves` (route -> component symbol, stored on the route's file) edges. Sorted and deterministic.
 */
export function detectTanstackRoutes(input: DetectRoutesInput): DetectedRoutes {
  const nodes: AdapterNodeRecord[] = [];
  const edges: EdgeRecord[] = [];
  interface Found {
    file: RouteSourceFile;
    map: RouteFileMapping;
    routeId: string;
    call: RouteCall;
  }
  for (const ws of [...input.workspaces].sort((a, b) => cmp(a.id, b.id))) {
    if (!isRouterWorkspace(ws)) continue;
    const dir = `${routesDirectoryFor(input.root, ws)}/`;
    const wsName = ws.id.startsWith("ws:") ? ws.id.slice(3) : ws.id;
    const byId = new Map<string, Found>();
    const files = input.files
      .filter((f) => f.workspaceId === ws.id && f.path.startsWith(dir))
      .sort((a, b) => cmp(a.path, b.path));
    for (const file of files) {
      const map = mapRouteFile(file.path.slice(dir.length));
      if (!map) continue;
      const call = readRouteCall(file.path, file.source);
      if (!call || call.root !== map.root) continue;
      // The literal argument is TanStack's own id; the file name only decides when there is none.
      const routeId = map.root ? ROUTE_ROOT_ID : (call.idArg ?? map.routeId);
      if (!byId.has(routeId)) byId.set(routeId, { file, map, routeId, call });
    }
    const ids = new Set(byId.keys());
    const nodeId = (routeId: string): string => makeRouteId(input.repo, wsName, routeId);
    for (const f of [...byId.values()].sort((a, b) => cmp(a.routeId, b.routeId))) {
      const urlPath = f.call.idArg !== undefined ? urlPathOfRouteId(f.routeId) : f.map.urlPath;
      const pathless = f.map.pathless;
      const data: Record<string, unknown> = {
        routeId: f.routeId,
        urlPath,
        path: f.file.path,
        options: f.call.options.keys,
        ...(f.map.root ? { root: true } : {}),
        ...(f.map.index ? { index: true } : {}),
        ...(pathless ? { pathless: true } : {}),
        ...(f.call.options.component ? { component: f.call.options.component } : {}),
        ...(f.call.options.loader ? { loader: f.call.options.loader } : {}),
        ...(f.call.options.beforeLoad ? { beforeLoad: f.call.options.beforeLoad } : {}),
      };
      nodes.push({
        id: nodeId(f.routeId),
        kind: "route",
        ws: ws.id,
        label: f.map.root ? "__root" : pathless ? f.routeId : urlPath,
        fileId: f.file.id,
        data,
      });
      const parent = parentRouteId(f.routeId, ids);
      if (parent !== undefined) {
        edges.push({
          src: nodeId(parent),
          dst: nodeId(f.routeId),
          kind: "contains",
          confidence: "high",
          count: 1,
          evidence: [f.file.path],
          fileId: f.file.id,
        });
      }
      const comp = f.call.options.component;
      const sym = comp ? componentSymbol(input.parsed.get(f.file.id), f.file.id, comp, input.resolver) : null;
      if (sym) {
        edges.push({
          src: nodeId(f.routeId),
          dst: sym,
          kind: "serves",
          confidence: "high",
          count: 1,
          evidence: [f.file.path],
          fileId: f.file.id,
        });
      }
    }
  }
  return { nodes, edges };
}

/** TanStack Router file routes as a framework adapter (`link` only: parents and children come from the whole routes folder). */
export const tanstackRoutesAdapter: Adapter = {
  id: "tanstack-router",
  appliesTo: isRouterWorkspace,
  includeTests: true,
  link(ctx) {
    const found = detectTanstackRoutes({
      root: ctx.root,
      repo: ctx.repo,
      workspaces: ctx.workspaces,
      files: ctx.files.map(({ file }) => ({
        path: file.path,
        id: file.fileId,
        workspaceId: file.ws.id,
        source: file.source,
      })),
      parsed: ctx.parsed,
      resolver: ctx.resolver,
    });
    return { nodes: found.nodes as AdapterNode[], edges: found.edges };
  },
};

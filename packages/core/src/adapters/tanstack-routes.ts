import fs from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { routeId as makeRouteId } from "../ids.js";
import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { ParsedFile } from "../parse/index.js";
import type { Resolver } from "../resolve/index.js";
import type { AdapterNodeRecord, EdgeRecord, WorkspaceRecord } from "../types.js";
import type { Adapter, AdapterNode } from "./framework.js";

/**
 * TanStack Router file-route detection (route detection only; server functions are M6).
 *
 * File naming follows https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions
 * (checked 2026-11): `__root` is the root layout; `.` and folders nest; `index` is the index route of its parent; a
 * `route` file stands for its folder; `$name` is a param and a bare `$` a splat; a leading `_` makes a pathless
 * layout; a trailing `_` takes the route out of its parent's nesting; `(group)` folders stay out of the URL; a `-`
 * prefix on any file or folder name excludes it; `[x]` makes `x` literal; `.lazy` files only carry lazy parts and
 * are skipped. The unit test (`tanstack-routes.test.ts`) is the table of record.
 */

export const ROUTE_ROOT_ID = "__root__";
const FRAMEWORKS = ["@tanstack/react-router", "@tanstack/react-start"];
const DEFAULT_ROUTES_DIR = "src/routes";
const ROUTE_EXT_RE = /\.(?:tsx|ts|mts|cts)$/;
const GROUP_RE = /^\(.*\)$/;

export interface RouteFileMapping {
  /** TanStack's route id: the string `createFileRoute` takes (`/_app/posts/`), or `__root__`. Pathless and group segments stay in it. */
  routeId: string;
  /** The URL path (`/posts/$postId`): pathless layouts, groups and trailing `_` removed. */
  urlPath: string;
  root: boolean;
  index: boolean;
  /** A layout with no URL segment of its own (`_app`, `(group)`). */
  pathless: boolean;
}

/** Splits on `.` except inside `[...]`. */
function splitDots(name: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of name) {
    if (ch === "[") depth++;
    else if (ch === "]" && depth > 0) depth--;
    if (ch === "." && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.filter((t) => t !== "");
}

const unescapeToken = (t: string): string => t.replace(/\[([^\]]*)\]/g, "$1");
const isEscaped = (t: string): boolean => t.includes("[");

/**
 * Maps a file path relative to the routes directory (posix, with extension) to its route, or null when the file
 * is not a route file by name (ignored with `-`, `.lazy`, not a script).
 */
export function mapRouteFile(rel: string): RouteFileMapping | null {
  if (!ROUTE_EXT_RE.test(rel) || rel.endsWith(".d.ts")) return null;
  const parts = rel.replace(ROUTE_EXT_RE, "").split("/");
  if (parts.some((p) => p.startsWith("-"))) return null;
  const raw: string[] = [];
  for (const p of parts) raw.push(...splitDots(p));
  if (raw[raw.length - 1] === "lazy") return null;
  if (raw.length === 1 && raw[0] === "__root") {
    return { routeId: ROUTE_ROOT_ID, urlPath: "/", root: true, index: false, pathless: false };
  }
  let index = false;
  const last = raw[raw.length - 1];
  if (last === "route") raw.pop();
  else if (last === "index") {
    raw.pop();
    index = true;
  }
  const routeId = `/${raw.map(unescapeToken).join("/")}${index && raw.length > 0 ? "/" : ""}`;
  const url: string[] = [];
  for (const t of raw) {
    if (!isEscaped(t)) {
      if (t.startsWith("_")) continue; // pathless layout
      if (GROUP_RE.test(t)) continue; // route group
    }
    const v = unescapeToken(t);
    url.push(!isEscaped(t) && v.length > 1 && v.endsWith("_") ? v.slice(0, -1) : v);
  }
  const lastRaw = raw[raw.length - 1];
  const pathless =
    !index &&
    lastRaw !== undefined &&
    !isEscaped(lastRaw) &&
    (lastRaw.startsWith("_") || GROUP_RE.test(lastRaw));
  return { routeId, urlPath: `/${url.join("/")}`, root: false, index, pathless };
}

/** URL path of a route id read from `createFileRoute("...")`: the same rules, applied to the id. */
export function urlPathOfRouteId(routeId: string): string {
  if (routeId === ROUTE_ROOT_ID) return "/";
  const body = routeId.replace(/^\//, "");
  const asFile = routeId.endsWith("/") ? `${body}index.tsx` : `${body}.tsx`;
  return mapRouteFile(asFile)?.urlPath ?? routeId;
}

/**
 * The parent of a route among `ids`: the longest proper prefix that is a route, else the root route (when there
 * is one). A trailing-`_` segment never matches its stem, so it falls back to the root, as TanStack nests it.
 */
export function parentRouteId(routeId: string, ids: ReadonlySet<string>): string | undefined {
  if (routeId === ROUTE_ROOT_ID) return undefined;
  const index = routeId.endsWith("/") && routeId !== "/";
  const segs = routeId.split("/").filter(Boolean);
  for (let k = index ? segs.length : segs.length - 1; k >= 1; k--) {
    const cand = `/${segs.slice(0, k).join("/")}`;
    if (ids.has(cand)) return cand;
  }
  return ids.has(ROUTE_ROOT_ID) ? ROUTE_ROOT_ID : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Routes directory

const CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "app.config.ts",
  "app.config.js",
];
const ROUTES_DIR_RE = /routesDirectory\s*:\s*["'`]([^"'`]+)["'`]/;

/** Routes directory of a workspace, relative to the repo root: `tsr.config.json`, then a plugin option (text match), else `src/routes`. */
export function routesDirectoryFor(root: string, ws: WorkspaceRecord): string {
  const abs = ws.dir === "." ? root : path.join(root, ws.dir);
  let dir: string | undefined;
  try {
    const j: unknown = JSON.parse(fs.readFileSync(path.join(abs, "tsr.config.json"), "utf8"));
    const v = (j as { routesDirectory?: unknown } | null)?.routesDirectory;
    if (typeof v === "string" && v) dir = v;
  } catch {
    // no (valid) tsr.config.json
  }
  if (!dir) {
    for (const f of CONFIG_FILES) {
      try {
        const m = ROUTES_DIR_RE.exec(fs.readFileSync(path.join(abs, f), "utf8"));
        if (m?.[1]) {
          dir = m[1];
          break;
        }
      } catch {
        // file absent
      }
    }
  }
  const rel = path.posix
    .normalize((dir ?? DEFAULT_ROUTES_DIR).replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  return ws.dir === "." ? rel : path.posix.join(ws.dir, rel);
}

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

interface OptionRead {
  /** Identifier name, `inline` for a function, `expression` for anything else. */
  component?: string;
  loader?: string;
  beforeLoad?: string;
  keys: string[];
}

const propName = (p: Node): string | undefined => {
  const k = p.key;
  if (!isNode(k)) return undefined;
  if (k.type === "Identifier" && p.computed !== true) return k.name as string;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return undefined;
};

function describeValue(v: unknown): string {
  const n = unwrap(v);
  if (!isNode(n)) return "expression";
  if (n.type === "Identifier") return n.name as string;
  if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") return "inline";
  return "expression";
}

function readOptions(obj: unknown): OptionRead {
  const out: OptionRead = { keys: [] };
  const o = unwrap(obj);
  if (!isNode(o) || o.type !== "ObjectExpression") return out;
  for (const p of nodeArray(o.properties)) {
    if (p.type !== "Property") continue;
    const name = propName(p);
    if (!name) continue;
    out.keys.push(name);
    if (name === "component" || name === "loader" || name === "beforeLoad") {
      out[name] = p.method === true ? "inline" : describeValue(p.value);
    }
  }
  out.keys.sort();
  return out;
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

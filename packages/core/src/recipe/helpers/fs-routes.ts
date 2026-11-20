import fs from "node:fs";
import path from "node:path";
import {
  type AdapterFileContext,
  type AdapterNode,
  type AdapterResolver,
  cmp,
  symbolForName,
  wsName,
} from "../../adapters/framework.js";
import { routeId as makeRouteId } from "../../ids.js";
import { isNode, type Node, nodeArray, unwrap } from "../../parse/ast.js";
import type { ParsedFile } from "../../parse/index.js";
import type { EdgeRecord, WorkspaceRecord } from "../../types.js";
import type { FsConvention } from "../schema.js";

/**
 * Helper `fs-routes`: file-system routing. A route's id and URL path come from the file's place in the routes
 * folder, by the `convention` the rule names. The conventions are the only place stack naming rules live; a recipe
 * says which one applies. This issue adds `tanstack-router`; other stacks add theirs.
 *
 * TanStack Router file naming follows https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions
 * (checked 2026-11): `__root` is the root layout; `.` and folders nest; `index` is the index route of its parent; a
 * `route` file stands for its folder; `$name` is a param and a bare `$` a splat; a leading `_` makes a pathless
 * layout; a trailing `_` takes the route out of its parent's nesting; `(group)` folders stay out of the URL; a `-`
 * prefix on any file or folder name excludes it; `[x]` makes `x` literal; `.lazy` files only carry lazy parts and
 * are skipped. `helpers/fs-routes.test.ts` is the table of record.
 */

export const ROUTE_ROOT_ID = "__root__";
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

// ---------------------------------------------------------------------------------------------------------
// Route options

export interface OptionRead {
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

export function readOptions(obj: unknown): OptionRead {
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

// ---------------------------------------------------------------------------------------------------------
// Route nodes

/** One route declaration found by a `route` or `fileRoute` rule. */
export interface RouteFact {
  file: AdapterFileContext;
  /** The id the declaration names (`createFileRoute("/posts/$postId")`); absent for the root route or a call without one. */
  idArg?: string;
  root: boolean;
  options: OptionRead;
  /** The `data.adapter` label of the rule, if it has one. */
  adapter?: string;
}

/** The component symbol a route names: a symbol of the route file, or an imported one followed through the resolver. */
function componentSymbol(
  pf: ParsedFile | undefined,
  fileId: string,
  name: string,
  resolver: AdapterResolver,
): string | null {
  if (!pf || name === "inline" || name === "expression") return null;
  return symbolForName(pf, fileId, name, resolver);
}

export interface FileRoutesInput {
  root: string;
  repo: string;
  convention: FsConvention;
  workspaces: readonly WorkspaceRecord[];
  facts: readonly RouteFact[];
  parsed: { get(fileId: string): ParsedFile | undefined };
  resolver: AdapterResolver;
}

/**
 * Route nodes (`route:<package name>:<route id>`) of the workspaces that have route files, with the `contains`
 * (parent route -> child route, stored on the child's file) and `serves` (route -> component symbol, stored on the
 * route's file) edges. Sorted and deterministic.
 */
export function composeFileRoutes(input: FileRoutesInput): { nodes: AdapterNode[]; edges: EdgeRecord[] } {
  const nodes: AdapterNode[] = [];
  const edges: EdgeRecord[] = [];
  interface Found {
    fact: RouteFact;
    map: RouteFileMapping;
    routeId: string;
  }
  for (const ws of [...input.workspaces].sort((a, b) => cmp(a.id, b.id))) {
    const dir = `${routesDirectoryFor(input.root, ws)}/`;
    const name = wsName(ws.id);
    const byId = new Map<string, Found>();
    const facts = input.facts
      .filter((f) => f.file.ws.id === ws.id && f.file.path.startsWith(dir))
      .sort((a, b) => cmp(a.file.path, b.file.path));
    for (const fact of facts) {
      const map = mapRouteFile(fact.file.path.slice(dir.length));
      if (!map || fact.root !== map.root) continue;
      // The literal argument is TanStack's own id; the file name only decides when there is none.
      const routeId = map.root ? ROUTE_ROOT_ID : (fact.idArg ?? map.routeId);
      if (!byId.has(routeId)) byId.set(routeId, { fact, map, routeId });
    }
    const ids = new Set(byId.keys());
    const nodeId = (routeId: string): string => makeRouteId(input.repo, name, routeId);
    for (const f of [...byId.values()].sort((a, b) => cmp(a.routeId, b.routeId))) {
      const { fact, map } = f;
      const file = fact.file;
      const urlPath = fact.idArg !== undefined ? urlPathOfRouteId(f.routeId) : map.urlPath;
      const opts = fact.options;
      const data: Record<string, unknown> = {
        ...(fact.adapter ? { adapter: fact.adapter } : {}),
        routeId: f.routeId,
        urlPath,
        path: file.path,
        options: opts.keys,
        ...(map.root ? { root: true } : {}),
        ...(map.index ? { index: true } : {}),
        ...(map.pathless ? { pathless: true } : {}),
        ...(opts.component ? { component: opts.component } : {}),
        ...(opts.loader ? { loader: opts.loader } : {}),
        ...(opts.beforeLoad ? { beforeLoad: opts.beforeLoad } : {}),
      };
      nodes.push({
        id: nodeId(f.routeId),
        kind: "route",
        ws: ws.id,
        label: map.root ? "__root" : map.pathless ? f.routeId : urlPath,
        fileId: file.fileId,
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
          evidence: [file.path],
          fileId: file.fileId,
        });
      }
      const sym = opts.component
        ? componentSymbol(input.parsed.get(file.fileId), file.fileId, opts.component, input.resolver)
        : null;
      if (sym) {
        edges.push({
          src: nodeId(f.routeId),
          dst: sym,
          kind: "serves",
          confidence: "high",
          count: 1,
          evidence: [file.path],
          fileId: file.fileId,
        });
      }
    }
  }
  return { nodes, edges };
}

import {
  type AdapterFileContext,
  type AdapterNode,
  cmp,
  IdAllocator,
  wsName,
} from "../../adapters/framework.js";
import { endpointId, middlewareId } from "../../ids.js";
import type { EdgeRecord } from "../../types.js";
import type { PathExpr } from "./const-strings.js";

/**
 * Helper `mount-graph`: routers, mounts and base paths composed into every full path. A registration counts only if
 * its receiver resolved to a router the recipe declared, which is how `db.select().all()` and `map.get(k)` stay out.
 * One router mounted under three prefixes gives three paths. The workspace of a node is the one of the router at the
 * top of the mount chain, because that router serves the URL.
 */

export interface AppDecl {
  key: string;
  /** Base paths written in the declaration chain (`.basePath("/v1")`), in order. */
  base: PathExpr[];
  file: AdapterFileContext;
  /** A function parameter used as a router: it counts only when something mounts it or passes a router into it. */
  scope?: boolean;
}

interface Site {
  app: string;
  /** Registered through a reference to the router (not in its declaration chain), so its own base path applies. */
  ref: boolean;
  /** Pieces joined left to right: chain bases, then the path. */
  pieces: PathExpr[];
  line: number;
  file: AdapterFileContext;
  /** The label written into `data.adapter`. */
  adapter?: string;
}

export interface Registration extends Site {
  methods: string[];
  handler: string;
  handlerSymbol: string | null;
  handlerSpan?: { start: number; end: number };
  middleware: string[];
}
export interface Mount extends Site {
  child: string;
}
export interface MiddlewareSite extends Site {
  label: string;
}

/** Joins path pieces the way a router merges a base path, a mount prefix and a route path. */
export function mergePaths(pieces: readonly string[]): string {
  let out = "";
  for (const raw of pieces) {
    if (raw === "" || raw === "/") continue;
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    out = out.replace(/\/+$/, "") + p;
  }
  return out === "" ? "/" : out.replace(/(.)\/+$/, "$1");
}

/** Does a middleware path pattern (`*`, `/api/*`, `/posts/:id`) cover an endpoint path? */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  let re = "";
  const p = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
  for (const seg of p.split("/").filter(Boolean)) {
    if (seg === "*") re += "/[^/]*";
    else if (seg.startsWith(":")) re += "/[^/]+";
    else re += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}`;
  }
  const tail = pattern.endsWith("/*") ? "(?:/.*)?" : "/?";
  return new RegExp(`^${re}${tail}$`).test(path);
}

export interface MountGraphInput {
  repo: string;
  apps: ReadonlyMap<string, AppDecl>;
  registrations: readonly Registration[];
  mounts: readonly Mount[];
  middleware: readonly MiddlewareSite[];
  read: (pieces: readonly PathExpr[]) => { values: string[]; reason?: string };
}

export function composeMountGraph(input: MountGraphInput): { nodes: AdapterNode[]; edges: EdgeRecord[] } {
  const { repo, apps, read } = input;
  const parents = new Map<string, Mount[]>();
  for (const m of input.mounts) parents.set(m.child, [...(parents.get(m.child) ?? []), m]);

  /** A site's own path pieces, behind its router's base path when it was registered through a reference. */
  const own = (f: Site): { values: string[]; reason?: string } =>
    read(f.ref ? [...(apps.get(f.app)?.base ?? []), ...f.pieces] : f.pieces);

  /** Every way a router is reached: the router at the top, the prefix, and the chain of router keys from the top down. */
  interface Reach {
    root: string;
    prefix: string[];
    chain: string[];
    reason?: string;
  }
  const memo = new Map<string, Reach[]>();
  const reach = (key: string, stack: string[]): Reach[] => {
    const hit = memo.get(key);
    if (hit) return hit;
    const ups = (parents.get(key) ?? []).filter((m) => apps.has(m.app) && !stack.includes(m.app));
    let out: Reach[];
    if (ups.length === 0) out = apps.get(key)?.scope ? [] : [{ root: key, prefix: [], chain: [key] }];
    else {
      out = [];
      for (const m of ups) {
        const o = own(m);
        for (const r of reach(m.app, [...stack, key])) {
          const reason = r.reason ?? o.reason;
          out.push({
            root: r.root,
            prefix: [...r.prefix, ...o.values],
            chain: [...r.chain, key],
            ...(reason ? { reason } : {}),
          });
        }
      }
    }
    if (stack.length === 0) memo.set(key, out);
    return out;
  };

  const nodes: AdapterNode[] = [];
  const edges: EdgeRecord[] = [];
  const ids = new Map<string, IdAllocator>();
  const alloc = (ws: string): IdAllocator => {
    let a = ids.get(ws);
    if (!a) {
      a = new IdAllocator();
      ids.set(ws, a);
    }
    return a;
  };
  const wsOfRoot = (root: string, fallback: AdapterFileContext): string =>
    (apps.get(root)?.file ?? fallback).ws.id;

  interface Ep {
    id: string;
    path: string;
    chain: string[];
    low: boolean;
  }
  const eps: Ep[] = [];
  for (const r of input.registrations) {
    if (!apps.has(r.app)) continue;
    const file = r.file;
    for (const rc of reach(r.app, [])) {
      const ws = wsOfRoot(rc.root, file);
      const local = own(r);
      const reason = rc.reason ?? local.reason;
      const full = mergePaths([...rc.prefix, ...local.values]);
      for (const method of r.methods) {
        const id = alloc(ws).take(endpointId(repo, wsName(ws), `${method} ${full}`));
        nodes.push({
          id,
          kind: "endpoint",
          ws,
          label: `${method} ${full}`,
          fileId: file.fileId,
          data: {
            ...(r.adapter ? { adapter: r.adapter } : {}),
            method,
            path: full,
            routePath: mergePaths(local.values),
            app: r.app,
            handler: r.handler,
            ...(r.handlerSpan ? { handlerSpan: r.handlerSpan } : {}),
            ...(r.middleware.length > 0 ? { middleware: r.middleware } : {}),
            file: file.path,
            line: r.line,
            ...(reason ? { reason } : {}),
          },
        });
        eps.push({ id, path: full, chain: rc.chain, low: reason !== undefined });
        if (r.handlerSymbol) {
          edges.push({
            src: id,
            dst: r.handlerSymbol,
            kind: "handles",
            confidence: reason ? "low" : "high",
            count: 1,
            evidence: [`${file.path}:${r.line}`],
            fileId: file.fileId,
          });
        }
      }
    }
  }

  for (const m of input.middleware) {
    if (!apps.has(m.app)) continue;
    const file = m.file;
    for (const rc of reach(m.app, [])) {
      const ws = wsOfRoot(rc.root, file);
      const local = own(m);
      const reason = rc.reason ?? local.reason;
      const pattern = mergePaths([...rc.prefix, ...local.values]);
      const id = alloc(ws).take(middlewareId(repo, wsName(ws), `${pattern} ${m.label}`));
      nodes.push({
        id,
        kind: "middleware",
        ws,
        label: `${m.label} ${pattern}`,
        fileId: file.fileId,
        data: {
          ...(m.adapter ? { adapter: m.adapter } : {}),
          path: pattern,
          name: m.label,
          app: m.app,
          file: file.path,
          line: m.line,
          ...(reason ? { reason } : {}),
        },
      });
      const prefixLen = rc.chain.length;
      for (const ep of eps) {
        if (ep.chain.length < prefixLen) continue;
        if (rc.chain.some((k, i) => ep.chain[i] !== k)) continue;
        if (!patternMatches(pattern, ep.path)) continue;
        edges.push({
          src: id,
          dst: ep.id,
          kind: "serves",
          confidence: reason || ep.low ? "low" : "high",
          count: 1,
          evidence: [`${file.path}:${m.line}`],
          fileId: file.fileId,
        });
      }
    }
  }
  nodes.sort((a, b) => cmp(a.id, b.id));
  return { nodes, edges };
}

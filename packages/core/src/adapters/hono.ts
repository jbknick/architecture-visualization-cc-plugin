import {
  endpointId,
  fileIdOfSymId,
  isSymId,
  middlewareId,
  nameOfSymId,
  pathOfFileId,
  symKey,
  symKeyOfId,
} from "../ids.js";
import { chainName, isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import { mergePaths, patternMatches } from "../recipe/helpers/mount-graph.js";
import type { EdgeRecord } from "../types.js";
import {
  type Adapter,
  type AdapterFileContext,
  type AdapterNode,
  type ChainCall,
  cmp,
  enclosingSymbol,
  flattenChain,
  hasDependency,
  IdAllocator,
  lineOf,
  spanOf,
  stringConstants,
  stringValue,
  symbolForName,
  wsName,
} from "./framework.js";

/**
 * Hono routes (https://hono.dev/docs/api/routing, checked 2026-11).
 *
 * Read per file: apps (`const x = new Hono()`, optionally `.basePath('/p')`, in any scope, or an unassigned
 * `new Hono()...` chain), route registrations (`x.get|post|put|patch|delete|options|all(path, ...handlers)`,
 * `x.on(method | methods, path | paths, ...handlers)`, chained `x.get('/a', h).post(h2)` reusing the previous path),
 * mounts (`x.route('/prefix', sub)`) and middleware (`x.use([path,] ...mw)`). The receiver must be an app declared
 * in the file or an import that resolves to one, so `db.select().all()` and `map.get(k)` are never routes. Paths
 * may be string literals, templates or `const` strings (of the file, or imported). Linked across files: a sub-app's
 * routes get every prefix it is mounted under, by following `.route()` mounts through imports.
 *
 * Nodes: `ep:<ws>:<METHOD> <fullPath>` (kind `endpoint`) and `mw:<ws>:<fullPath> <name>` (kind `middleware`), where
 * `<ws>` is the package of the app at the top of the mount chain (the one that serves the URL). Edges: endpoint
 * `handles` the code of its last handler (a named handler's symbol; for an inline handler, the symbol whose body
 * holds it, or the file for module-level code, which is where the call graph puts its calls), and middleware
 * `serves` every endpoint of its app (and the apps mounted below it) whose path its pattern matches.
 */

export { mergePaths, patternMatches };

const HONO_MODULES = new Set(["hono", "hono/tiny", "hono/quick"]);
const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "all"]);
const CHAIN_METHODS = /\.(?:get|post|put|patch|delete|options|all|on|use|route|basePath)\(/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const chainCallRe = (name: string): RegExp =>
  new RegExp(
    `(?<![\\w$.])${escapeRe(name)}\\s*\\.(?:get|post|put|patch|delete|options|all|on|use|route|basePath)\\(`,
  );

/** A piece of a path: literal text, or a `const` string to read (here or, through `sym`, from the file that defines it). */
type PathPart = string | { name: string; sym?: string };
type PathExpr = PathPart[];

interface Registration {
  app: string;
  /** Registered through a reference to the app (not in its declaration chain), so the app's own base path applies. */
  ref: boolean;
  methods: string[];
  /** Pieces joined left to right (chain base, then the route path). */
  pieces: PathExpr[];
  handler: string;
  handlerSymbol: string | null;
  /** Lines of an inline handler (`handles` then points at the code that encloses it, siblings included). */
  handlerSpan?: { start: number; end: number };
  middleware: string[];
  line: number;
}
interface Mount {
  parent: string;
  ref: boolean;
  child: string;
  pieces: PathExpr[];
  line: number;
}
interface Middleware {
  app: string;
  ref: boolean;
  pieces: PathExpr[];
  label: string;
  line: number;
}
interface AppDecl {
  key: string;
  base: PathExpr[];
}
export interface HonoFacts {
  apps: AppDecl[];
  routes: Registration[];
  mounts: Mount[];
  middleware: Middleware[];
}

const isFn = (n: unknown): boolean => {
  const v = unwrap(n);
  return isNode(v) && (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression");
};

function label(n: unknown): string {
  const v = unwrap(n);
  if (isFn(v)) return "inline";
  if (isNode(v) && v.type === "CallExpression") return chainName(v.callee) ?? "expression";
  return chainName(v) ?? "expression";
}

class FileReader {
  readonly facts: HonoFacts = { apps: [], routes: [], mounts: [], middleware: [] };
  private readonly honoLocals = new Set<string>();
  private readonly declared = new Set<string>();
  private readonly consts: Map<string, string>;

  constructor(
    private readonly ctx: AdapterFileContext,
    private readonly program: Node[],
  ) {
    for (const i of ctx.parsed?.imports ?? []) {
      if (i.imported === "Hono" && HONO_MODULES.has(i.specifier) && i.local) this.honoLocals.add(i.local);
    }
    this.consts = stringConstants(program);
  }

  private isNewHono(n: unknown): boolean {
    const v = unwrap(n);
    if (!isNode(v) || v.type !== "NewExpression") return false;
    const c = unwrap(v.callee);
    return isNode(c) && c.type === "Identifier" && this.honoLocals.has(c.name as string);
  }

  private key(name: string): string {
    return symKey(this.ctx.path, name);
  }

  /** App key of an identifier: an app declared in this file, or an import resolving to a top-level symbol. */
  private refOf(name: string): string | null {
    if (this.declared.has(name)) return this.key(name);
    const imp = this.ctx.parsed?.imports.find((i) => i.local === name);
    if (!imp || imp.imported === "*") return null;
    const sym = symbolForName(this.ctx.parsed, this.ctx.fileId, name, this.ctx.resolver);
    if (sym && isSymId(sym)) return symKeyOfId(sym) ?? null;
    const t = this.ctx.resolver.resolveSpecifier(this.ctx.fileId, imp.specifier);
    return t.kind === "file" ? symKey(pathOfFileId(t.fileId), imp.imported) : null;
  }

  /** Reference to a string constant named `name`, or null when it is not one. */
  private constRef(name: string): PathPart | null {
    const local = this.consts.get(name);
    if (local !== undefined) return local;
    const imp = this.ctx.parsed?.imports.find((i) => i.local === name);
    if (!imp) return null;
    const sym = symbolForName(this.ctx.parsed, this.ctx.fileId, name, this.ctx.resolver);
    const s = this.ctx.parsed?.symbols.find((x) => x.id === sym);
    if (s && s.kind !== "const") return null;
    return sym ? { name, sym } : { name };
  }

  /** The path an argument stands for; null when the argument is not a path (a handler). */
  private pathOf(arg: unknown, more: boolean): PathExpr | null {
    const v = unwrap(arg);
    const lit = stringValue(v);
    if (lit !== null) return [lit];
    if (!isNode(v)) return null;
    if (v.type === "TemplateLiteral") {
      const out: PathExpr = [];
      const qs = nodeArray(v.quasis);
      const es = nodeArray(v.expressions);
      qs.forEach((q, i) => {
        const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
        if (typeof cooked === "string" && cooked) out.push(cooked);
        const e = unwrap(es[i]);
        if (!isNode(e)) return;
        const ref = e.type === "Identifier" ? this.constRef(e.name as string) : null;
        out.push(ref ?? `{${chainName(e) ?? "expr"}}`);
      });
      return out;
    }
    if (v.type === "Identifier") {
      const name = v.name as string;
      const ref = this.constRef(name);
      if (ref !== null) return [ref];
      // An unknown identifier before more arguments is a path we cannot read (kept as a placeholder).
      const sym = symbolForName(this.ctx.parsed, this.ctx.fileId, name, this.ctx.resolver);
      if (more && !sym) return [`{${name}}`];
    }
    return null;
  }

  private paths(arg: unknown): PathExpr[] {
    const v = unwrap(arg);
    if (isNode(v) && v.type === "ArrayExpression") {
      return nodeArray(v.elements)
        .map((e) => this.pathOf(e, true))
        .filter((p): p is PathExpr => p !== null);
    }
    const p = this.pathOf(v, true);
    return p ? [p] : [];
  }

  private handlerOf(n: unknown): {
    handler: string;
    handlerSymbol: string | null;
    handlerSpan?: { start: number; end: number };
  } {
    const v = unwrap(n);
    const handler = label(v);
    if (isFn(v) && isNode(v)) {
      return {
        handler,
        handlerSymbol: enclosingSymbol(this.ctx.parsed, this.ctx.fileId, v.start),
        handlerSpan: spanOf(this.ctx.source, v),
      };
    }
    if (isNode(v) && v.type === "Identifier") {
      return {
        handler,
        handlerSymbol: symbolForName(this.ctx.parsed, this.ctx.fileId, v.name as string, this.ctx.resolver),
      };
    }
    return { handler, handlerSymbol: null };
  }

  /** Records the calls of a chain on app `app`, starting from path pieces `base`; returns the base at the end. */
  private chain(app: string, ref: boolean, calls: ChainCall[]): PathExpr[] {
    const base: PathExpr[] = [];
    let cur = base;
    let last: PathExpr | null = null;
    for (const c of calls) {
      const line = lineOf(this.ctx.source, c.node.start);
      if (c.name === "basePath") {
        const p = this.pathOf(c.args[0], true);
        if (p) cur = [...cur, p];
        continue;
      }
      if (METHODS.has(c.name) || c.name === "on") {
        let methods: string[];
        let rest = c.args;
        if (c.name === "on") {
          const m = unwrap(c.args[0]);
          methods = (isNode(m) && m.type === "ArrayExpression" ? nodeArray(m.elements) : [m])
            .map((x) => stringValue(x))
            .filter((x): x is string => x !== null)
            .map((x) => x.toUpperCase());
          rest = c.args.slice(1);
        } else methods = [c.name.toUpperCase()];
        let paths = rest.length > 1 ? this.paths(rest[0]) : [];
        if (paths.length === 0 && rest.length === 1) {
          const p = this.pathOf(rest[0], false);
          if (p) paths = [p];
        }
        let handlers = rest;
        if (paths.length > 0) handlers = rest.slice(1);
        else if (last) paths = [last];
        if (paths.length === 0 || handlers.length === 0 || methods.length === 0) continue;
        last = paths[paths.length - 1] ?? null;
        const { handler, handlerSymbol, handlerSpan } = this.handlerOf(handlers[handlers.length - 1]);
        const middleware = handlers.slice(0, -1).map(label);
        for (const p of paths) {
          this.facts.routes.push({
            app,
            ref,
            methods,
            pieces: [...cur, p],
            handler,
            handlerSymbol,
            ...(handlerSpan ? { handlerSpan } : {}),
            middleware,
            line,
          });
        }
        continue;
      }
      if (c.name === "route") {
        const p = this.pathOf(c.args[0], true);
        const child = this.childRef(c.args[1]);
        if (p && child) this.facts.mounts.push({ parent: app, ref, child, pieces: [...cur, p], line });
        continue;
      }
      if (c.name === "use") {
        let path: PathExpr[] = [["*"]];
        let handlers = c.args;
        const first = c.args.length > 0 ? this.pathOf(c.args[0], c.args.length > 1) : null;
        if (first) {
          path = [first];
          handlers = c.args.slice(1);
        }
        for (const h of handlers) {
          for (const p of path)
            this.facts.middleware.push({ app, ref, pieces: [...cur, p], label: label(h), line });
        }
      }
    }
    return cur;
  }

  private childRef(arg: unknown): string | null {
    const v = unwrap(arg);
    if (!isNode(v)) return null;
    if (v.type === "Identifier") return this.refOf(v.name as string);
    const { base, calls } = flattenChain(v);
    if (calls.length > 0 && this.isNewHono(base)) return this.key(`@${v.start}`);
    return null;
  }

  read(): HonoFacts {
    // Pass 1: every name bound to a `new Hono()` chain, in any scope.
    visit(this.program, (n) => {
      if (n.type !== "VariableDeclarator") return undefined;
      const id = unwrap(n.id);
      if (!isNode(id) || id.type !== "Identifier") return undefined;
      const init = unwrap(n.init);
      const { base } = flattenChain(init);
      if (this.isNewHono(init) || this.isNewHono(base)) this.declared.add(id.name as string);
      return undefined;
    });
    // Pass 2: chains, in source order.
    const onNode = (n: Node): boolean | undefined => {
      if (n.type === "VariableDeclarator") {
        const id = unwrap(n.id);
        const init = unwrap(n.init);
        if (isNode(id) && id.type === "Identifier" && this.declared.has(id.name as string)) {
          const name = id.name as string;
          const calls = this.isNewHono(init) ? [] : flattenChain(init).calls;
          const base = this.chain(this.key(name), false, calls);
          this.facts.apps.push({ key: this.key(name), base });
          this.visitArgs(calls, onNode);
          return false;
        }
        return undefined;
      }
      if (n.type === "ExportDefaultDeclaration") {
        const d = unwrap(n.declaration);
        const { base, calls } = flattenChain(d);
        if (this.isNewHono(d) || (calls.length > 0 && this.isNewHono(base))) {
          const b = this.chain(this.key("default"), false, calls);
          this.facts.apps.push({ key: this.key("default"), base: b });
          this.visitArgs(calls, onNode);
          return false;
        }
        return undefined;
      }
      if (n.type !== "CallExpression") return undefined;
      const { base, calls } = flattenChain(n);
      if (calls.length === 0) return undefined;
      let app: string | null = null;
      if (isNode(base) && base.type === "Identifier") {
        app = this.refOf(base.name as string);
      } else if (this.isNewHono(base)) {
        app = this.key(`@${n.start}`);
        const b = this.chain(app, false, calls);
        this.facts.apps.push({ key: app, base: b });
        this.visitArgs(calls, onNode);
        return false;
      }
      if (!app) return undefined;
      this.chain(app, true, calls);
      this.visitArgs(calls, onNode);
      return false;
    };
    visit(this.program, onNode);
    return this.facts;
  }

  private visitArgs(calls: ChainCall[], cb: (n: Node) => boolean | undefined): void {
    for (const c of calls) visit(c.args, cb);
  }
}

export const honoAdapter: Adapter<HonoFacts> = {
  id: "hono",
  appliesTo: (ws) => hasDependency(ws, ["hono"]),
  // A file that imports hono, or calls a route method on an imported binding (routes added to an app from another file).
  mayMatch: (file) => {
    const imports = file.parsed?.imports ?? [];
    if (imports.some((i) => HONO_MODULES.has(i.specifier))) return true;
    if (!CHAIN_METHODS.test(file.source)) return false;
    return imports.some(
      (i) =>
        i.local !== "" &&
        !i.typeOnly &&
        file.source.includes(`${i.local}.`) &&
        chainCallRe(i.local).test(file.source),
    );
  },
  extract(ctx) {
    const program = ctx.program();
    if (!program) return {};
    return { facts: new FileReader(ctx, program).read() };
  },
  link(ctx) {
    const fileOfKey = new Map<string, AdapterFileContext>();
    const apps = new Map<string, AppDecl>();
    const routes: { r: Registration; file: AdapterFileContext }[] = [];
    const mws: { m: Middleware; file: AdapterFileContext }[] = [];
    const parents = new Map<string, Mount[]>();
    for (const { file, facts } of ctx.files) {
      if (!facts) continue;
      for (const a of facts.apps) {
        if (apps.has(a.key)) continue;
        apps.set(a.key, a);
        fileOfKey.set(a.key, file);
      }
      for (const r of facts.routes) routes.push({ r, file });
      for (const m of facts.middleware) mws.push({ m, file });
      for (const m of facts.mounts) parents.set(m.child, [...(parents.get(m.child) ?? []), m]);
    }

    const constCache = new Map<string, Map<string, string>>();
    const readPart = (p: PathPart): string => {
      if (typeof p === "string") return p;
      if (p.sym) {
        const fileId = fileIdOfSymId(p.sym) ?? p.sym;
        let consts = constCache.get(fileId);
        if (!consts) {
          consts = stringConstants(ctx.file(fileId)?.program() ?? null);
          constCache.set(fileId, consts);
        }
        const v = consts.get(nameOfSymId(p.sym) ?? "");
        if (v !== undefined) return v;
      }
      return `{${p.name}}`;
    };
    const readPieces = (pieces: PathExpr[]): string[] => pieces.map((e) => e.map(readPart).join(""));
    /** A fact's own path pieces, behind its app's base path when it was registered through a reference. */
    const own = (f: { app: string; ref: boolean; pieces: PathExpr[] }): string[] =>
      readPieces(f.ref ? [...(apps.get(f.app)?.base ?? []), ...f.pieces] : f.pieces);

    /** Every way an app is reached: the app at the top, the prefix, and the chain of app keys from the top down. */
    interface Reach {
      root: string;
      prefix: string[];
      chain: string[];
    }
    const memo = new Map<string, Reach[]>();
    const reach = (key: string, stack: string[]): Reach[] => {
      const hit = memo.get(key);
      if (hit) return hit;
      const ups = (parents.get(key) ?? []).filter((m) => apps.has(m.parent) && !stack.includes(m.parent));
      let out: Reach[];
      if (ups.length === 0) out = [{ root: key, prefix: [], chain: [key] }];
      else {
        out = [];
        for (const m of ups) {
          for (const r of reach(m.parent, [...stack, key])) {
            out.push({
              root: r.root,
              prefix: [...r.prefix, ...own({ app: m.parent, ref: m.ref, pieces: m.pieces })],
              chain: [...r.chain, key],
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
      (fileOfKey.get(root) ?? fallback).ws.id;

    interface Ep {
      id: string;
      path: string;
      chain: string[];
    }
    const eps: Ep[] = [];
    for (const { r, file } of routes) {
      if (!apps.has(r.app)) continue;
      for (const rc of reach(r.app, [])) {
        const ws = wsOfRoot(rc.root, file);
        const local = own(r);
        const full = mergePaths([...rc.prefix, ...local]);
        for (const method of r.methods) {
          const id = alloc(ws).take(endpointId(ctx.repo, wsName(ws), `${method} ${full}`));
          nodes.push({
            id,
            kind: "endpoint",
            ws,
            label: `${method} ${full}`,
            fileId: file.fileId,
            data: {
              adapter: "hono",
              method,
              path: full,
              routePath: mergePaths(local),
              app: r.app,
              handler: r.handler,
              ...(r.handlerSpan ? { handlerSpan: r.handlerSpan } : {}),
              ...(r.middleware.length > 0 ? { middleware: r.middleware } : {}),
              file: file.path,
              line: r.line,
            },
          });
          eps.push({ id, path: full, chain: rc.chain });
          if (r.handlerSymbol) {
            edges.push({
              src: id,
              dst: r.handlerSymbol,
              kind: "handles",
              confidence: "high",
              count: 1,
              evidence: [`${file.path}:${r.line}`],
              fileId: file.fileId,
            });
          }
        }
      }
    }

    for (const { m, file } of mws) {
      if (!apps.has(m.app)) continue;
      for (const rc of reach(m.app, [])) {
        const ws = wsOfRoot(rc.root, file);
        const pattern = mergePaths([...rc.prefix, ...own(m)]);
        const id = alloc(ws).take(middlewareId(ctx.repo, wsName(ws), `${pattern} ${m.label}`));
        nodes.push({
          id,
          kind: "middleware",
          ws,
          label: `${m.label} ${pattern}`,
          fileId: file.fileId,
          data: { adapter: "hono", path: pattern, name: m.label, app: m.app, file: file.path, line: m.line },
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
            confidence: "high",
            count: 1,
            evidence: [`${file.path}:${m.line}`],
            fileId: file.fileId,
          });
        }
      }
    }
    nodes.sort((a, b) => cmp(a.id, b.id));
    return { nodes, edges };
  },
};

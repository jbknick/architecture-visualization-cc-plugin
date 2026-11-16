import { chainName, isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
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
  stringValue,
  symbolForName,
  wsName,
} from "./framework.js";

/**
 * oRPC procedures (https://orpc.dev/docs/router, /docs/procedure, /docs/contract-first/implement-contract,
 * /docs/adapters/hono; checked 2026-11).
 *
 * | Pattern                                                   | Read as                                           |
 * | --------------------------------------------------------- | ------------------------------------------------- |
 * | `import { os } from "@orpc/server"`                       | the base builder                                  |
 * | `const b = os.$context<C>()`, `b.use(mw)`, `.errors(...)`  | a builder (top-level `const`, followed across files) |
 * | `const b = implement(contract)`                           | a builder (contract first; `b.posts.list.handler`) |
 * | `<builder>...handler(fn)`                                 | a procedure; `.input`, `.output`, `.use`, `.route` read |
 * | `{ a: proc, b: { c: proc }, d: subRouter, ...spread }`     | a router (plain object, nested, any file)         |
 * | `<builder>.router({...})`                                 | a router                                          |
 * | `os.lazy(() => import("./x"))`, `lazy(() => import(...))`  | the default export of `./x`                       |
 * | `new RPCHandler(router)`, `new OpenAPIHandler(router)`    | a handler serving `router`                        |
 * | `app.use|all|get|...(path, fn)` whose `fn` uses a handler | a Hono mount: `data.mountedAt`                    |
 *
 * Linked across files: router objects are followed through imports (`posts: postsRouter`), so a procedure's path is
 * the dotted key path from a root router (one no other router nests). Node `ep:<ws>:rpc <a.b.c>` (kind `endpoint`,
 * `<ws>` the package of the root router's file), stored with the file that defines the procedure. `handles` points
 * at the code that holds the handler: a named handler's symbol, or for an inline one the symbol whose body contains
 * it (the procedure's or router's `const`). A router served by an `RPCHandler`/`OpenAPIHandler` inside a Hono
 * registration gets `mountedAt` (the handler's `prefix` option when it is a literal, else the Hono path without a
 * trailing `/*`) and `honoPath` (the full Hono pattern of that registration).
 */

const ORPC_SERVER = "@orpc/server";
const HANDLER_CLASSES = new Set(["RPCHandler", "OpenAPIHandler"]);
const MOUNT_METHODS = new Set(["use", "all", "get", "post", "put", "patch", "delete", "options", "on"]);

/** A reference to a top-level binding: `<repo path>#<name>` (`#default` for a default export); `os` for the base builder. */
type Key = string;

interface ProcFact {
  /** Builder the chain starts on (`os`, or the key of a builder binding); checked in `link`. */
  root: Key | null;
  handler: string;
  handlerSymbol: string | null;
  /** Lines of an inline handler (`handles` then points at the code that encloses it, siblings included). */
  handlerSpan?: { start: number; end: number };
  input: boolean;
  output: boolean;
  middleware: string[];
  route?: { method?: string; path?: string };
  line: number;
}
type Leaf = { t: "proc"; proc: ProcFact } | { t: "tree"; entries: Entry[] } | { t: "ref"; key: Key | null };
/** One property of a router object; `name` null for a spread (`...other`). */
interface Entry {
  name: string | null;
  leaf: Leaf;
}
interface Def {
  key: Key;
  leaf: Leaf;
}
interface MountFact {
  /** The router served, when the handler is constructed in the registration. */
  router: Key | null;
  /** The handler binding used, when it is declared elsewhere (`rpc.handle(...)`). */
  handler: Key | null;
  protocol: "rpc" | "openapi" | null;
  prefix: string | null;
  line: number;
}
interface HandlerDef {
  key: Key;
  router: Key | null;
  protocol: "rpc" | "openapi";
}
export interface OrpcFacts {
  builders: { key: Key; root: Key | null }[];
  defs: Def[];
  handlers: HandlerDef[];
  mounts: MountFact[];
}

const isFn = (n: unknown): n is Node => {
  const v = unwrap(n);
  return isNode(v) && (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression");
};

const label = (n: unknown): string => {
  const v = unwrap(n);
  if (isFn(v)) return "inline";
  if (isNode(v) && v.type === "CallExpression") return chainName(v.callee) ?? "expression";
  return chainName(v) ?? "expression";
};

const propName = (p: Node): string | null => {
  const k = unwrap(p.key);
  if (p.computed === true) return stringValue(k);
  if (isNode(k) && k.type === "Identifier") return k.name as string;
  return stringValue(k);
};

class FileReader {
  readonly facts: OrpcFacts = { builders: [], defs: [], handlers: [], mounts: [] };
  private readonly osLocals = new Set<string>();
  private readonly implementLocals = new Set<string>();
  private readonly lazyLocals = new Set<string>();
  private readonly handlerLocals = new Map<string, "rpc" | "openapi">();
  private readonly topLevel = new Set<string>();
  private readonly factories = new Map<string, Node>();
  private depth = 0;

  constructor(
    private readonly ctx: AdapterFileContext,
    private readonly program: Node[],
  ) {
    for (const i of ctx.parsed?.imports ?? []) {
      if (!i.local || i.typeOnly) continue;
      if (i.specifier === ORPC_SERVER) {
        if (i.imported === "os") this.osLocals.add(i.local);
        if (i.imported === "implement") this.implementLocals.add(i.local);
        if (i.imported === "lazy") this.lazyLocals.add(i.local);
      }
      if (i.specifier.startsWith("@orpc/") && HANDLER_CLASSES.has(i.imported)) {
        this.handlerLocals.set(i.local, i.imported === "RPCHandler" ? "rpc" : "openapi");
      }
    }
    for (const st of program) {
      const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
      if (!isNode(decl)) continue;
      if (decl.type === "FunctionDeclaration") {
        const id = unwrap(decl.id);
        if (isNode(id) && id.type === "Identifier") this.factories.set(id.name as string, decl);
        continue;
      }
      if (decl.type !== "VariableDeclaration") continue;
      for (const d of nodeArray(decl.declarations)) {
        const id = unwrap(d.id);
        if (!isNode(id) || id.type !== "Identifier") continue;
        this.topLevel.add(id.name as string);
        const init = unwrap(d.init);
        if (isFn(init)) this.factories.set(id.name as string, init);
      }
    }
  }

  /** The object a router factory of this file returns (`const makeRouter = (deps) => ({ ... })`), if any. */
  private factoryObject(name: string): Node | null {
    const fn = this.factories.get(name);
    if (!fn) return null;
    const body = unwrap(fn.body);
    if (isNode(body) && body.type === "ObjectExpression") return body;
    if (!isNode(body) || body.type !== "BlockStatement") return null;
    const ret = nodeArray(body.body).find((s) => s.type === "ReturnStatement");
    const arg = unwrap(ret?.argument);
    return isNode(arg) && arg.type === "ObjectExpression" ? arg : null;
  }

  private key(name: string): Key {
    return `${this.ctx.path}#${name}`;
  }

  /** Key of an identifier: a top-level binding of this file, or an import followed through the resolver. */
  private refOf(name: string): Key | null {
    if (this.osLocals.has(name)) return "os";
    if (this.topLevel.has(name)) return this.key(name);
    const imp = this.ctx.parsed?.imports.find((i) => i.local === name);
    if (!imp || imp.imported === "*") return null;
    const sym = symbolForName(this.ctx.parsed, this.ctx.fileId, name, this.ctx.resolver);
    if (sym?.startsWith("sym:")) return sym.slice(4);
    const t = this.ctx.resolver.resolveSpecifier(this.ctx.fileId, imp.specifier);
    return t.kind === "file" ? `${t.fileId.slice(5)}#${imp.imported}` : null;
  }

  /** The builder a chain starts on, and its calls (null when the chain does not start on a known binding). */
  private chainRoot(expr: unknown): { root: Key | null; calls: ChainCall[] } | null {
    const { base, calls } = flattenChain(expr);
    if (calls.length === 0) return null;
    if (base === undefined) {
      const first = calls[0];
      if (first && this.implementLocals.has(first.name)) return { root: "os", calls: calls.slice(1) };
      return null;
    }
    // `os.x`, or contract first `impl.posts.list`: the identifier at the bottom of the member chain.
    let cur: unknown = base;
    for (let i = 0; i < 32; i++) {
      const v = unwrap(cur);
      if (isNode(v) && v.type === "MemberExpression" && v.computed !== true) cur = v.object;
      else break;
    }
    const id = unwrap(cur);
    if (!isNode(id) || id.type !== "Identifier") return null;
    return { root: this.refOf(id.name as string), calls };
  }

  /** `lazy(() => import("./x"))` or `<builder>.lazy(...)`: the key of the imported module's default export. */
  private lazyTarget(call: ChainCall): Key | null {
    const fn = unwrap(call.args[0]);
    if (!isFn(fn)) return null;
    let spec: string | null = null;
    visit(fn.body, (n) => {
      if (spec === null && n.type === "ImportExpression") spec = stringValue(n.source);
      return undefined;
    });
    if (spec === null) return null;
    const t = this.ctx.resolver.resolveSpecifier(this.ctx.fileId, spec);
    return t.kind === "file" ? `${t.fileId.slice(5)}#default` : null;
  }

  private proc(root: Key | null, calls: ChainCall[], handlerCall: ChainCall): ProcFact {
    const h = handlerCall.args[handlerCall.args.length - 1];
    const handler = label(h);
    let handlerSymbol: string | null = null;
    let handlerSpan: ProcFact["handlerSpan"];
    const hn = unwrap(h);
    if (isFn(hn)) {
      handlerSymbol = enclosingSymbol(this.ctx.parsed, this.ctx.fileId, hn.start);
      handlerSpan = spanOf(this.ctx.source, hn);
    } else if (isNode(hn) && hn.type === "Identifier") {
      handlerSymbol = symbolForName(this.ctx.parsed, this.ctx.fileId, hn.name as string, this.ctx.resolver);
    }
    const middleware: string[] = [];
    let route: ProcFact["route"];
    for (const c of calls) {
      if (c === handlerCall) break;
      if (c.name === "use") for (const a of c.args.slice(0, 1)) middleware.push(label(a));
      if (c.name === "route") {
        const o = unwrap(c.args[0]);
        if (isNode(o) && o.type === "ObjectExpression") {
          route = {};
          for (const p of nodeArray(o.properties)) {
            const k = p.type === "Property" ? propName(p) : null;
            const v = p.type === "Property" ? stringValue(p.value) : null;
            if (k === "method" && v) route.method = v.toUpperCase();
            if (k === "path" && v) route.path = v;
          }
        }
      }
    }
    return {
      root,
      handler,
      handlerSymbol,
      ...(handlerSpan ? { handlerSpan } : {}),
      input: calls.some((c) => c.name === "input"),
      output: calls.some((c) => c.name === "output"),
      middleware,
      ...(route ? { route } : {}),
      line: lineOf(this.ctx.source, handlerCall.node.start),
    };
  }

  /** What a router value is: a procedure, a nested router, or a reference to one. */
  private leaf(expr: unknown): Leaf | null {
    const v = unwrap(expr);
    if (!isNode(v)) return null;
    if (v.type === "ObjectExpression") return { t: "tree", entries: this.entries(v) };
    if (v.type === "Identifier") {
      const key = this.refOf(v.name as string);
      return key && key !== "os" ? { t: "ref", key } : null;
    }
    if (v.type !== "CallExpression") return null;
    const callee = unwrap(v.callee);
    if (isNode(callee) && callee.type === "Identifier" && this.depth < 8) {
      const obj = this.factoryObject(callee.name as string);
      if (obj) {
        this.depth++;
        const entries = this.entries(obj);
        this.depth--;
        return { t: "tree", entries };
      }
    }
    if (isNode(callee) && callee.type === "Identifier" && this.lazyLocals.has(callee.name as string)) {
      return { t: "ref", key: this.lazyTarget({ name: "lazy", args: v.arguments as unknown[], node: v }) };
    }
    const r = this.chainRoot(v);
    if (!r) return null;
    const handlerCall = [...r.calls].reverse().find((c) => c.name === "handler");
    if (handlerCall) return { t: "proc", proc: this.proc(r.root, r.calls, handlerCall) };
    const last = r.calls[r.calls.length - 1];
    if (last?.name === "router") {
      const o = unwrap(last.args[0]);
      if (isNode(o) && o.type === "ObjectExpression") return { t: "tree", entries: this.entries(o) };
      return this.leaf(o);
    }
    if (last?.name === "lazy") return { t: "ref", key: this.lazyTarget(last) };
    return null;
  }

  private entries(obj: Node): Entry[] {
    const out: Entry[] = [];
    for (const p of nodeArray(obj.properties)) {
      if (p.type === "SpreadElement") {
        const l = this.leaf(p.argument);
        if (l) out.push({ name: null, leaf: l });
        continue;
      }
      if (p.type !== "Property") continue;
      const name = propName(p);
      const l = name !== null ? this.leaf(p.value) : null;
      if (name !== null && l) out.push({ name, leaf: l });
    }
    return out;
  }

  private handlerClass(n: unknown): { router: Key | null; protocol: "rpc" | "openapi" } | null {
    const v = unwrap(n);
    if (!isNode(v) || v.type !== "NewExpression") return null;
    const c = unwrap(v.callee);
    if (!isNode(c) || c.type !== "Identifier") return null;
    const protocol = this.handlerLocals.get(c.name as string);
    if (!protocol) return null;
    const arg = unwrap(nodeArray(v.arguments)[0]);
    const router = isNode(arg) && arg.type === "Identifier" ? this.refOf(arg.name as string) : null;
    return { router, protocol };
  }

  /** The handler used inside a registration callback: constructed there, or a binding declared elsewhere. */
  private mountIn(fns: Node[], line: number): void {
    let found: MountFact | null = null;
    const localHandlers = new Map<string, { router: Key | null; protocol: "rpc" | "openapi" }>();
    for (const fn of fns) {
      visit(fn.body, (n) => {
        if (n.type === "VariableDeclarator") {
          const id = unwrap(n.id);
          const h = this.handlerClass(n.init);
          if (h && isNode(id) && id.type === "Identifier") localHandlers.set(id.name as string, h);
        }
        if (found || n.type !== "CallExpression") return undefined;
        const callee = unwrap(n.callee);
        if (!isNode(callee) || callee.type !== "MemberExpression" || callee.computed === true)
          return undefined;
        const prop = callee.property;
        if (!isNode(prop) || prop.name !== "handle") return undefined;
        const obj = unwrap(callee.object);
        let prefix: string | null = null;
        const opts = unwrap(nodeArray(n.arguments)[1]);
        if (isNode(opts) && opts.type === "ObjectExpression") {
          for (const p of nodeArray(opts.properties)) {
            if (p.type === "Property" && propName(p) === "prefix") prefix = stringValue(p.value);
          }
        }
        const inline = this.handlerClass(obj);
        if (inline) {
          found = { router: inline.router, handler: null, protocol: inline.protocol, prefix, line };
        } else if (isNode(obj) && obj.type === "Identifier") {
          const name = obj.name as string;
          const local = localHandlers.get(name);
          if (local) found = { router: local.router, handler: null, protocol: local.protocol, prefix, line };
          else {
            const key = this.refOf(name);
            if (key && key !== "os") found = { router: null, handler: key, protocol: null, prefix, line };
          }
        }
        return undefined;
      });
    }
    if (found) this.facts.mounts.push(found);
  }

  read(): OrpcFacts {
    for (const st of this.program) {
      if (st.type === "ExportDefaultDeclaration") {
        const l = this.leaf(st.declaration);
        if (l && l.t !== "ref") this.facts.defs.push({ key: this.key("default"), leaf: l });
        continue;
      }
      const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
      if (!isNode(decl) || decl.type !== "VariableDeclaration") continue;
      for (const d of nodeArray(decl.declarations)) {
        const id = unwrap(d.id);
        if (!isNode(id) || id.type !== "Identifier") continue;
        const key = this.key(id.name as string);
        const h = this.handlerClass(d.init);
        if (h) {
          this.facts.handlers.push({ key, ...h });
          continue;
        }
        const l = this.leaf(d.init);
        if (l) {
          this.facts.defs.push({ key, leaf: l });
          // `export const publicProcedure = o`: an alias may name a builder as well as a router.
          if (l.t === "ref" && l.key) this.facts.builders.push({ key, root: l.key });
          continue;
        }
        // Anything else chained on a builder (`os.$context<C>()`, `pub.use(auth)`, `implement(contract)`) is a builder.
        const r = this.chainRoot(d.init);
        if (r?.root) this.facts.builders.push({ key, root: r.root });
        else {
          const v = unwrap(d.init);
          if (isNode(v) && v.type === "Identifier" && this.osLocals.has(v.name as string)) {
            this.facts.builders.push({ key, root: "os" });
          }
        }
      }
    }
    // A handler used inside a registration callback, in any scope (`app.use("/rpc/*", async (c, next) => ...)`).
    if (this.handlerLocals.size > 0 || this.ctx.source.includes(".handle(")) {
      visit(this.program, (n) => {
        if (n.type !== "CallExpression") return undefined;
        const callee = unwrap(n.callee);
        if (!isNode(callee) || callee.type !== "MemberExpression" || callee.computed === true)
          return undefined;
        const prop = callee.property;
        if (!isNode(prop) || !MOUNT_METHODS.has(prop.name as string)) return undefined;
        const fns = nodeArray(n.arguments).filter(isFn);
        if (fns.length > 0) this.mountIn(fns, lineOf(this.ctx.source, n.start));
        return undefined;
      });
    }
    return this.facts;
  }
}

/** `/rpc/*` → `/rpc`, `/*` and `*` → `/`. */
const stripWildcard = (p: string): string => {
  const s = p.replace(/\/?\*$/, "");
  return s === "" ? "/" : s;
};

export const orpcAdapter: Adapter<OrpcFacts> = {
  id: "orpc",
  appliesTo: (ws) => hasDependency(ws, [ORPC_SERVER]),
  mayMatch: (file) =>
    (file.parsed?.imports ?? []).some((i) => i.specifier.startsWith("@orpc/")) ||
    file.source.includes(".handler(") ||
    file.source.includes(".handle(") ||
    // A plain router object that only nests imported routers (`export const appRouter = { posts: postsRouter }`).
    ((file.parsed?.imports ?? []).length > 0 && /(?:=|export default)\s*\{/.test(file.source)),
  extract(ctx) {
    const program = ctx.program();
    if (!program) return {};
    return { facts: new FileReader(ctx, program).read() };
  },
  link(ctx) {
    const defs = new Map<Key, { def: Def; file: AdapterFileContext }>();
    const builderRoots = new Map<Key, Key | null>();
    const handlers = new Map<Key, HandlerDef>();
    const mounts: { m: MountFact; file: AdapterFileContext }[] = [];
    for (const { file, facts } of ctx.files) {
      if (!facts) continue;
      for (const d of facts.defs) if (!defs.has(d.key)) defs.set(d.key, { def: d, file });
      for (const b of facts.builders) if (!builderRoots.has(b.key)) builderRoots.set(b.key, b.root);
      for (const h of facts.handlers) if (!handlers.has(h.key)) handlers.set(h.key, h);
      for (const m of facts.mounts) mounts.push({ m, file });
    }
    const builderMemo = new Map<Key, boolean>();
    const isBuilder = (key: Key | null, depth = 0): boolean => {
      if (key === null || depth > 32) return false;
      if (key === "os") return true;
      const hit = builderMemo.get(key);
      if (hit !== undefined) return hit;
      const root = builderRoots.get(key);
      const out = root !== undefined && isBuilder(root, depth + 1);
      builderMemo.set(key, out);
      return out;
    };

    /** Does a leaf hold at least one procedure (following references)? */
    const holdsMemo = new Map<Key, boolean>();
    const holds = (leaf: Leaf, stack: Set<Key>): boolean => {
      if (leaf.t === "proc") return isBuilder(leaf.proc.root);
      if (leaf.t === "tree") return leaf.entries.some((e) => holds(e.leaf, stack));
      if (!leaf.key || stack.has(leaf.key)) return false;
      const hit = holdsMemo.get(leaf.key);
      if (hit !== undefined) return hit;
      const d = defs.get(leaf.key);
      const out = d ? holds(d.def.leaf, new Set([...stack, leaf.key])) : false;
      holdsMemo.set(leaf.key, out);
      return out;
    };

    // Roots: routers (trees holding a procedure) that no other such router nests.
    const nested = new Set<Key>();
    const collectRefs = (leaf: Leaf): void => {
      if (leaf.t === "ref" && leaf.key) nested.add(leaf.key);
      if (leaf.t === "tree") for (const e of leaf.entries) collectRefs(e.leaf);
    };
    for (const { def } of defs.values())
      if (def.leaf.t === "tree" && holds(def.leaf, new Set())) collectRefs(def.leaf);
    const roots = [...defs.values()]
      .filter(({ def }) => def.leaf.t === "tree" && !nested.has(def.key) && holds(def.leaf, new Set()))
      .sort((a, b) => cmp(a.file.path, b.file.path) || cmp(a.def.key, b.def.key));

    // Mounts: the router each handler serves, and where (from the Hono node registered on the same line).
    const mountOf = new Map<Key, { mountedAt?: string; honoPath?: string; protocol?: string }>();
    for (const { m, file } of mounts) {
      const h = m.handler ? handlers.get(m.handler) : undefined;
      const router = m.router ?? h?.router ?? null;
      if (!router || mountOf.has(router)) continue;
      const hono = ctx.nodes
        .filter(
          (n) =>
            n.fileId === file.fileId &&
            n.data.adapter === "hono" &&
            n.data.line === m.line &&
            typeof n.data.path === "string",
        )
        .map((n) => n.data.path as string)
        .sort(cmp)[0];
      const mountedAt = m.prefix ?? (hono !== undefined ? stripWildcard(hono) : undefined);
      mountOf.set(router, {
        ...(mountedAt !== undefined ? { mountedAt } : {}),
        ...(hono !== undefined ? { honoPath: hono } : {}),
        ...((m.protocol ?? h?.protocol) ? { protocol: (m.protocol ?? h?.protocol) as string } : {}),
      });
    }

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
    for (const { def, file: rootFile } of roots) {
      const ws = rootFile.ws.id;
      const mount = mountOf.get(def.key);
      const walk = (leaf: Leaf, path: string[], file: AdapterFileContext, stack: Set<Key>): void => {
        if (leaf.t === "tree") {
          for (const e of leaf.entries) walk(e.leaf, e.name === null ? path : [...path, e.name], file, stack);
          return;
        }
        if (leaf.t === "ref") {
          if (!leaf.key || stack.has(leaf.key)) return;
          const d = defs.get(leaf.key);
          if (d) walk(d.def.leaf, path, d.file, new Set([...stack, leaf.key]));
          return;
        }
        const p = leaf.proc;
        if (!isBuilder(p.root) || path.length === 0) return;
        const dotted = path.join(".");
        const id = alloc(ws).take(`ep:${wsName(ws)}:rpc ${dotted}`);
        nodes.push({
          id,
          kind: "endpoint",
          ws,
          label: `rpc ${dotted}`,
          fileId: file.fileId,
          data: {
            adapter: "orpc",
            path: dotted,
            router: def.key,
            handler: p.handler,
            ...(p.handlerSpan ? { handlerSpan: p.handlerSpan } : {}),
            input: p.input,
            output: p.output,
            middleware: p.middleware,
            ...(p.route ? { route: p.route } : {}),
            ...(mount ?? {}),
            file: file.path,
            line: p.line,
          },
        });
        if (p.handlerSymbol) {
          edges.push({
            src: id,
            dst: p.handlerSymbol,
            kind: "handles",
            confidence: "high",
            count: 1,
            evidence: [`${file.path}:${p.line}`],
            fileId: file.fileId,
          });
        }
      };
      walk(def.leaf, [], rootFile, new Set([def.key]));
    }
    nodes.sort((a, b) => cmp(a.id, b.id));
    return { nodes, edges };
  },
};

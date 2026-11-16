import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { EdgeRecord, WorkspaceRecord } from "../types.js";
import {
  type Adapter,
  type AdapterFileContext,
  type AdapterNode,
  cmp,
  enclosingSymbol,
  hasDependency,
  IdAllocator,
  stringValue,
  symbolForName,
  wsName,
} from "./framework.js";
import { START_PACKAGES } from "./tanstack-start.js";

/**
 * Client calls matched to the endpoints they request (spec section 9, #47). Registered last, so its `link` sees the
 * endpoints of every other adapter. Edge `requests` from the code holding the call (its symbol, or the file for
 * module-level code) to the endpoint, evidence `path:line` per call, stored with the caller's file.
 *
 * | Rule | Call                                                                       | Endpoint                        | Confidence     |
 * | ---- | -------------------------------------------------------------------------- | ------------------------------- | -------------- |
 * | 1    | `getPosts(...)`, `useServerFn(getPosts)` resolving to a server fn's const   | `ep:<ws>:fn getPosts`           | high           |
 * | 2    | `orpc.posts.list.queryOptions()`, `client.posts.list()` on an oRPC client   | `ep:*:rpc posts.list`           | high if unique |
 * | 3    | `client.api.posts[":id"].$get()` on a Hono `hc()` client                    | `ep:*:GET /api/posts/:id`       | high if unique |
 * | 4    | `fetch("/api/posts/${id}")`, `ky.post(...)`, `axios.get(...)` (literal URL)  | Hono path, `${x}` as a `:param` | low            |
 *
 * An oRPC client is a top-level `const` initialised by `createORPCClient`, `createTanstackQueryUtils` (or the other
 * `@orpc/*-query` utils), or by a function of the same file that returns one of those calls
 * (`const make = () => createORPCClient(link); export const client = make()`); a Hono client likewise by `hc` from
 * `hono/client`. Uses are followed through imports. Rule 2 strips one trailing helper (`queryOptions`,
 * `mutationOptions`, `key`, `call`, ...); a path that is a router prefix (`orpc.posts.key()`) is a cache helper,
 * not a request, and is skipped. Several candidates (the same path in two workspaces) narrow to the ones in the
 * caller's workspace or its dependencies; when more than one is left each gets a `low` edge.
 *
 * A client call that matches nothing (rule 2 or 3 without an endpoint, a fetch URL that is not a literal or
 * template or matches no route, `useServerFn` of something that is no server function) is not guessed: it becomes a
 * `client_call` node `call:<ws>:<label>` with `{ adapter: "clients", rule, reason, label, caller, file, line }`,
 * which `trace` reports as a gap. Calls in the definition of a route (`Route`'s loader) are left to the route's own
 * `requests` edge (TanStack Start adapter).
 */

const ORPC_FACTORIES = new Set([
  "createORPCClient",
  "createTanstackQueryUtils",
  "createRouterUtils",
  "createORPCReactQueryUtils",
  "createORPCVueQueryUtils",
  "createORPCSolidQueryUtils",
  "createORPCSvelteQueryUtils",
  "createSWRUtils",
]);
const HONO_CLIENT = "hono/client";
/** Trailing members of an oRPC client chain that are helpers, not path keys. */
const ORPC_HELPERS = new Set([
  "queryOptions",
  "mutationOptions",
  "infiniteOptions",
  "streamedOptions",
  "liveOptions",
  "queryKey",
  "mutationKey",
  "infiniteKey",
  "key",
  "call",
]);
const HONO_METHODS: Record<string, string> = {
  $get: "GET",
  $post: "POST",
  $put: "PUT",
  $patch: "PATCH",
  $delete: "DELETE",
  $options: "OPTIONS",
};
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const CLIENT_DEPS = [
  "@orpc/client",
  "@orpc/tanstack-query",
  "@orpc/react-query",
  "@orpc/vue-query",
  "@orpc/solid-query",
  "@orpc/svelte-query",
  ...START_PACKAGES,
  "hono",
  "ky",
  "axios",
];
const FETCH_CALLEES = new Set(["fetch", "window.fetch", "globalThis.fetch", "self.fetch"]);

export type ClientRule = "server-fn" | "orpc" | "hono" | "fetch";

/** A client binding: its kind, and for a sub-client alias the keys it starts with. */
interface Client {
  kind: "orpc" | "hono";
  prefix: string[];
  sym: string;
}

/** `[export] const name[: Type] = root.a.b;` on one line. */
const ALIAS_RE =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\s*;?[ \t]*$/gm;

const localKey = (fileId: string, name: string): string => `local:${fileId}#${name}`;

const lineOfIndex = (source: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
};

interface ClientDecl {
  symbol: string;
  kind: "orpc" | "hono";
}
export interface ClientFacts {
  /** Top-level client bindings declared in this file. */
  decls: ClientDecl[];
  /** Top-level `const x = <name>.a.b` member aliases (a sub-client when `<name>` is a client), read from the text. */
  aliases: { key: string; caller: string; name: string; root: string; keys: string[]; line: number }[];
  /** Local names that root a member call (`orpc.posts.list(...)`): the cheap filter before the AST walk. */
  roots: string[];
  /** Plain identifier calls (`getPosts(...)`), for rule 1. */
  idCalls: { name: string; from: string; line: number }[];
  /** The file calls fetch, ky or axios, or `useServerFn`, or a `$get`-style Hono client method. */
  fetchLike: boolean;
  useServerFn: boolean;
  dollar: boolean;
}

/** 1-based line of an offset, by binary search over line starts. */
function lineTable(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Local names imported from one of `modules` under one of `names`. */
function importedLocals(ctx: AdapterFileContext, modules: (s: string) => boolean, names: Set<string>) {
  const out = new Map<string, string>();
  for (const i of ctx.parsed?.imports ?? []) {
    if (!i.local || i.typeOnly || !modules(i.specifier)) continue;
    if (names.has(i.imported)) out.set(i.local, i.imported);
  }
  return out;
}

/** Client bindings of a file: top-level consts initialised by a client factory, directly or through a local function. */
function readDecls(ctx: AdapterFileContext): ClientDecl[] {
  const orpc = importedLocals(ctx, (s) => s.startsWith("@orpc/"), ORPC_FACTORIES);
  const hono = importedLocals(ctx, (s) => s === HONO_CLIENT, new Set(["hc"]));
  if (orpc.size === 0 && hono.size === 0) return [];
  const program = ctx.program();
  if (!program) return [];
  const factoryKind = (call: unknown): "orpc" | "hono" | null => {
    const c = unwrap(call);
    if (!isNode(c) || c.type !== "CallExpression") return null;
    const callee = unwrap(c.callee);
    if (!isNode(callee) || callee.type !== "Identifier") return null;
    const name = callee.name as string;
    return orpc.has(name) ? "orpc" : hono.has(name) ? "hono" : null;
  };
  // Local functions returning a factory call: `const make = () => createORPCClient(link)`.
  const wrappers = new Map<string, "orpc" | "hono">();
  const returned = (fn: Node): "orpc" | "hono" | null => {
    const body = unwrap(fn.body);
    if (!isNode(body)) return null;
    if (body.type !== "BlockStatement") return factoryKind(body);
    for (const st of nodeArray(body.body)) {
      if (st.type === "ReturnStatement") return factoryKind(st.argument);
    }
    return null;
  };
  const decls: { name: string; init: unknown }[] = [];
  for (const st of program) {
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl)) continue;
    if (decl.type === "FunctionDeclaration" && isNode(decl.id)) {
      const k = returned(decl);
      if (k) wrappers.set(decl.id.name as string, k);
      continue;
    }
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of nodeArray(decl.declarations)) {
      const id = unwrap(d.id);
      if (!isNode(id) || id.type !== "Identifier") continue;
      const init = unwrap(d.init);
      if (isNode(init) && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
        const k = returned(init);
        if (k) wrappers.set(id.name as string, k);
        continue;
      }
      decls.push({ name: id.name as string, init });
    }
  }
  const out: ClientDecl[] = [];
  for (const d of decls) {
    let kind = factoryKind(d.init);
    if (!kind) {
      const c = unwrap(d.init);
      const callee = isNode(c) && c.type === "CallExpression" ? unwrap(c.callee) : null;
      if (isNode(callee) && callee.type === "Identifier") kind = wrappers.get(callee.name as string) ?? null;
    }
    const symbol = ctx.parsed?.symbols.find((s) => s.name === d.name)?.id;
    if (kind && symbol) out.push({ symbol, kind });
  }
  return out;
}

/** A member chain `root.a["b"].c` as its root identifier and keys (computed keys only when string literals). */
function memberChain(expr: unknown): { root: string; keys: string[]; computed: boolean } | null {
  const keys: string[] = [];
  let computed = false;
  let cur = unwrap(expr);
  for (let i = 0; i < 32 && isNode(cur); i++) {
    if (cur.type === "Identifier") return { root: cur.name as string, keys: keys.reverse(), computed };
    if (cur.type !== "MemberExpression") return null;
    const p = unwrap(cur.property);
    if (cur.computed === true) {
      const k = stringValue(p);
      if (k === null) return null;
      keys.push(k);
      computed = true;
    } else if (isNode(p) && p.type === "Identifier") keys.push(p.name as string);
    else return null;
    cur = unwrap(cur.object);
  }
  return null;
}

/**
 * A URL argument as a path: literal or template (`${x}` becomes `:param`, a leading `${base}` is dropped), query
 * and hash dropped. An absolute URL (`https://host/...`) is returned whole; anything else is null.
 */
export function urlPath(arg: unknown): string | null {
  const v = unwrap(arg);
  if (!isNode(v)) return null;
  let raw: string | null = null;
  if (v.type === "Literal" && typeof v.value === "string") raw = v.value;
  else if (v.type === "TemplateLiteral") {
    const quasis = nodeArray(v.quasis).map((q) => {
      const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
      return typeof cooked === "string" ? cooked : "";
    });
    let s = "";
    for (let i = 0; i < quasis.length; i++) {
      const q = quasis[i] as string;
      // A leading `${base}` before a path is the base URL, not a path parameter: skip it and its empty quasi.
      if (i === 0 && q === "" && quasis.length > 1 && (quasis[1] as string).startsWith("/")) continue;
      s += q;
      if (i < quasis.length - 1) s += ":param";
    }
    raw = s;
  }
  if (raw === null) return null;
  // An absolute URL names another origin: kept whole, so it is reported as external and never matched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw.replace(/[?#].*$/, "");
  let p = raw;
  p = p.replace(/[?#].*$/, "");
  if (!p.startsWith("/")) return null;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

/** How a call path matches a Hono endpoint path: null for no match, else the number of parameter segments used. */
export function pathScore(call: string, endpoint: string): number | null {
  const a = call.split("/");
  const b = endpoint.split("/");
  if (a.length !== b.length) return null;
  let params = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (y.startsWith(":") || (y.startsWith("{") && y.endsWith("}"))) {
      params++;
      continue;
    }
    if (x !== y) return null;
  }
  return params;
}

/** The method of a fetch-like call: the `method` option (literal), the member name (`ky.post`), else GET. */
function methodOf(opts: unknown, member: string | null): string {
  if (member && HTTP_VERBS.has(member)) return member.toUpperCase();
  const o = unwrap(opts);
  if (isNode(o) && o.type === "ObjectExpression") {
    for (const p of nodeArray(o.properties)) {
      const k = unwrap(p.key);
      if (p.type === "Property" && isNode(k) && (k.name === "method" || k.value === "method")) {
        const m = stringValue(p.value);
        if (m) return m.toUpperCase();
      }
    }
  }
  return "GET";
}

interface Hit {
  rule: ClientRule;
  from: string;
  line: number;
  label: string;
  /** Candidate endpoint ids (empty when unmatched). */
  dsts: string[];
  confidence: "high" | "low";
  reason?: "no_endpoint" | "dynamic_url" | "external_url" | "not_a_server_fn" | "client_alias";
}

export const clientsAdapter: Adapter<ClientFacts> = {
  id: "clients",
  // Apps, and packages that use a client library or a framework whose functions are called from the client.
  appliesTo: (ws) => ws.kind === "app" || hasDependency(ws, CLIENT_DEPS),
  extract(ctx) {
    const pf = ctx.parsed;
    if (!pf) return {};
    const roots = new Set<string>();
    const idCalls: ClientFacts["idCalls"] = [];
    let fetchLike = false;
    const httpLibs = new Set(
      pf.imports
        .filter((i) => i.local && (i.specifier === "ky" || i.specifier === "axios"))
        .map((i) => i.local),
    );
    for (const s of pf.sites) {
      if (s.kind !== "calls" && s.kind !== "uses_hook") continue;
      const dot = s.callee.indexOf(".");
      const root = dot < 0 ? s.callee : s.callee.slice(0, dot);
      if (FETCH_CALLEES.has(s.callee) || httpLibs.has(root)) fetchLike = true;
      if (dot < 0) idCalls.push({ name: s.callee, from: s.fromSymbol, line: s.line });
      else roots.add(root);
    }
    const useServerFn = ctx.source.includes("useServerFn");
    const dollar = /\.\$(?:get|post|put|patch|delete|options)\s*\(/.test(ctx.source);
    const decls = readDecls(ctx);
    const aliases: ClientFacts["aliases"] = [];
    for (const m of ctx.source.matchAll(ALIAS_RE)) {
      const name = m[1] as string;
      // A const initialised by a member chain is not always a symbol of the parser: then it is keyed by file and name.
      const symbol = pf.symbols.find((s) => s.name === name)?.id;
      aliases.push({
        key: symbol ?? localKey(ctx.fileId, name),
        caller: symbol ?? ctx.fileId,
        name,
        root: m[2] as string,
        keys: (m[3] as string).split(".").filter((k) => k !== ""),
        line: lineOfIndex(ctx.source, m.index),
      });
    }
    if (
      decls.length === 0 &&
      aliases.length === 0 &&
      roots.size === 0 &&
      idCalls.length === 0 &&
      !fetchLike &&
      !useServerFn &&
      !dollar
    )
      return {};
    return {
      facts: { decls, aliases, roots: [...roots].sort(cmp), idCalls, fetchLike, useServerFn, dollar },
    };
  },
  link(ctx) {
    const clients = new Map<string, Client>();
    for (const { facts } of ctx.files) {
      for (const d of facts?.decls ?? []) clients.set(d.symbol, { kind: d.kind, prefix: [], sym: d.symbol });
    }
    // Sub-client aliases (`const posts = client.posts`), aliases of aliases included.
    const aliasList = ctx.files.flatMap(({ file, facts }) =>
      (facts?.aliases ?? []).map((a) => ({ a, file })),
    );
    const aliasNames = new Set(aliasList.map(({ a, file }) => localKey(file.fileId, a.name)));
    /** What a name of a file refers to: a symbol (through imports), else a non-symbol alias const by file and name. */
    const refOf = (file: AdapterFileContext, name: string): string | null => {
      const sym = symbolForName(file.parsed, file.fileId, name, ctx.resolver);
      if (sym) return sym;
      if (aliasNames.has(localKey(file.fileId, name))) return localKey(file.fileId, name);
      const imp = file.parsed?.imports.find((i) => i.local === name);
      if (!imp || imp.imported === "*" || imp.imported === "default") return null;
      const t = ctx.resolver.resolveSpecifier(file.fileId, imp.specifier);
      return t.kind === "file" ? localKey(t.fileId, imp.imported) : null;
    };
    for (let pass = 0; pass < 4; pass++) {
      let added = false;
      for (const { a, file } of aliasList) {
        if (clients.has(a.key)) continue;
        const ref = refOf(file, a.root);
        const base = ref ? clients.get(ref) : undefined;
        if (!base) continue;
        clients.set(a.key, { kind: base.kind, prefix: [...base.prefix, ...a.keys], sym: a.key });
        added = true;
      }
      if (!added) break;
    }
    /** Aliases some call went through; the others are reported, since their calls happen out of sight. */
    const usedAliases = new Set<string>();

    // Endpoints by what a client call names.
    const fnBySym = new Map<string, string>();
    const fnByName = new Map<string, string[]>();
    const fnByLocal = new Map<string, string>();
    const rpcByPath = new Map<string, AdapterNode[]>();
    const rpcPrefixes = new Set<string>();
    const hono: AdapterNode[] = [];
    for (const n of ctx.nodes) {
      if (n.kind !== "endpoint") continue;
      const d = n.data;
      if (d.adapter === "tanstack-start" && typeof d.name === "string" && typeof d.file === "string") {
        const fileId = `file:${d.file}`;
        const sym = d.exported === true ? ctx.resolver.resolveSymbol(fileId, d.name) : null;
        fnBySym.set(sym ?? `sym:${d.file}#${d.name}`, n.id);
        // A const that is no symbol of its file (a non-exported `createServerFn()` chain) is found by name there.
        fnByLocal.set(`${fileId}\0${d.name}`, n.id);
        const key = `${n.ws}\0${d.name}`;
        fnByName.set(key, [...(fnByName.get(key) ?? []), n.id]);
      } else if (d.adapter === "orpc" && typeof d.path === "string") {
        rpcByPath.set(d.path, [...(rpcByPath.get(d.path) ?? []), n]);
        const parts = d.path.split(".");
        for (let i = 1; i < parts.length; i++) rpcPrefixes.add(parts.slice(0, i).join("."));
      } else if (d.adapter === "hono" && typeof d.path === "string") hono.push(n);
    }
    const wsByName = new Map(ctx.workspaces.map((w) => [w.id, w]));
    /** Narrows several candidates to the caller's workspace and its dependencies. */
    const narrow = (
      cands: AdapterNode[],
      ws: WorkspaceRecord,
    ): { dsts: string[]; confidence: "high" | "low" } => {
      if (cands.length <= 1) return { dsts: cands.map((c) => c.id), confidence: "high" };
      const near = cands.filter((c) => {
        const w = c.ws ? wsByName.get(c.ws) : undefined;
        return c.ws === ws.id || (w !== undefined && ws.deps.includes(w.name));
      });
      if (near.length === 1) return { dsts: [(near[0] as AdapterNode).id], confidence: "high" };
      const use = near.length > 0 ? near : cands;
      return { dsts: use.map((c) => c.id).sort(cmp), confidence: "low" };
    };

    const routeFiles = new Set(ctx.nodes.filter((n) => n.kind === "route").map((n) => n.fileId));
    const hits: { file: AdapterFileContext; hit: Hit }[] = [];
    for (const { file, facts } of ctx.files) {
      if (!facts) continue;
      const pf = file.parsed;
      // The route definition's own calls (its loader) are the route's `requests` edge already.
      const isRouteDef = (from: string): boolean => from.endsWith("#Route") && routeFiles.has(file.fileId);

      // Rule 1: a call of a server function (resolved through imports, or one of this file).
      for (const c of facts.idCalls) {
        const sym = symbolForName(pf, file.fileId, c.name, ctx.resolver);
        let dst = sym ? fnBySym.get(sym) : undefined;
        let confidence: "high" | "low" = "high";
        const imp = pf?.imports.find((i) => i.local === c.name);
        if (!dst && !sym && !imp) dst = fnByLocal.get(`${file.fileId}\0${c.name}`);
        if (!dst && !sym && imp) {
          // Imported but not resolved: a unique server function of that name in the caller's workspace.
          const cands = fnByName.get(`${file.ws.id}\0${imp.imported}`) ?? [];
          if (cands.length === 1) {
            dst = cands[0] as string;
            confidence = "low";
          }
        }
        if (!dst || isRouteDef(c.from) || c.from === sym) continue;
        hits.push({
          file,
          hit: { rule: "server-fn", from: c.from, line: c.line, label: c.name, dsts: [dst], confidence },
        });
      }

      // Rules 2-4 and useServerFn need the call's arguments or full member chain.
      const rootKinds = new Map<string, Client>();
      for (const r of facts.roots) {
        const ref = refOf(file, r);
        const k = ref ? clients.get(ref) : undefined;
        if (k) rootKinds.set(r, k);
      }
      if (facts.dollar) {
        // A Hono client chain with a computed key (`client.posts[":id"].$get`) is no call site of the parser.
        const names = [...(pf?.imports ?? []).map((i) => i.local), ...(pf?.symbols ?? []).map((x) => x.name)];
        for (const name of names) {
          if (!name || rootKinds.has(name)) continue;
          const sym = symbolForName(pf, file.fileId, name, ctx.resolver);
          const k = sym ? clients.get(sym) : undefined;
          if (k?.kind === "hono") rootKinds.set(name, k);
        }
      }
      if (rootKinds.size === 0 && !facts.fetchLike && !facts.useServerFn) continue;
      const program = file.program();
      if (!program) continue;
      const line = lineTable(file.source);
      const httpLibs = new Set(
        (pf?.imports ?? [])
          .filter((i) => i.local && (i.specifier === "ky" || i.specifier === "axios"))
          .map((i) => i.local),
      );
      const useServerFnLocals = importedLocals(
        file,
        (s) => START_PACKAGES.includes(s),
        new Set(["useServerFn"]),
      );
      visit(program, (n) => {
        if (n.type !== "CallExpression") return undefined;
        const args = Array.isArray(n.arguments) ? (n.arguments as unknown[]) : [];
        const chain = memberChain(n.callee);
        if (!chain) return undefined;
        const from = enclosingSymbol(pf, file.fileId, n.start);
        const at = line(n.start);
        const push = (h: Omit<Hit, "from" | "line">) => hits.push({ file, hit: { ...h, from, line: at } });

        // useServerFn(getPosts)
        if (chain.keys.length === 0 && useServerFnLocals.has(chain.root)) {
          const a = unwrap(args[0]);
          if (!isNode(a) || a.type !== "Identifier") return undefined;
          const sym = symbolForName(pf, file.fileId, a.name as string, ctx.resolver);
          const dst = sym ? fnBySym.get(sym) : undefined;
          if (dst) push({ rule: "server-fn", label: a.name as string, dsts: [dst], confidence: "high" });
          else
            push({
              rule: "server-fn",
              label: `useServerFn(${a.name as string})`,
              dsts: [],
              confidence: "low",
              reason: "not_a_server_fn",
            });
          return undefined;
        }

        // fetch / ky / axios
        const dotted = [chain.root, ...chain.keys].join(".");
        const isFetch = FETCH_CALLEES.has(dotted);
        const lib = httpLibs.has(chain.root) && chain.keys.length <= 1 ? chain.root : null;
        if (isFetch || lib) {
          const member = lib ? (chain.keys[0] ?? null) : null;
          if (member !== null && !HTTP_VERBS.has(member) && member !== "request") return undefined;
          let urlArg = args[0];
          let opts = args[1];
          const first = unwrap(args[0]);
          if (isNode(first) && first.type === "ObjectExpression") {
            // axios({ url, method })
            opts = first;
            urlArg = nodeArray(first.properties).find((p) => {
              const k = unwrap(p.key);
              return p.type === "Property" && isNode(k) && k.name === "url";
            })?.value;
          }
          const method = methodOf(opts, member);
          const path = urlPath(urlArg);
          if (path === null) {
            push({
              rule: "fetch",
              label: `${method} <dynamic>`,
              dsts: [],
              confidence: "low",
              reason: "dynamic_url",
            });
            return undefined;
          }
          if (!path.startsWith("/")) {
            push({
              rule: "fetch",
              label: `${method} ${path}`,
              dsts: [],
              confidence: "low",
              reason: "external_url",
            });
            return undefined;
          }
          let best: number | null = null;
          let cands: AdapterNode[] = [];
          for (const ep of hono) {
            const m = ep.data.method as string;
            if (m !== method && m !== "ALL") continue;
            const s = pathScore(path, ep.data.path as string);
            if (s === null) continue;
            if (best === null || s < best) {
              best = s;
              cands = [ep];
            } else if (s === best) cands.push(ep);
          }
          const label = `${method} ${path}`;
          if (cands.length === 0)
            push({ rule: "fetch", label, dsts: [], confidence: "low", reason: "no_endpoint" });
          else push({ rule: "fetch", label, dsts: narrow(cands, file.ws).dsts, confidence: "low" });
          return undefined;
        }

        const client = rootKinds.get(chain.root);
        if (client && client.prefix.length > 0) usedAliases.add(client.sym);
        const kind = client?.kind;
        const allKeys = [...(client?.prefix ?? []), ...chain.keys];
        if (kind === "orpc" && !chain.computed) {
          const keys = allKeys;
          if (keys.length > 0 && ORPC_HELPERS.has(keys[keys.length - 1] as string)) keys.pop();
          if (keys.length === 0) return undefined;
          const path = keys.join(".");
          const cands = rpcByPath.get(path) ?? [];
          if (cands.length === 0) {
            if (!rpcPrefixes.has(path)) {
              push({
                rule: "orpc",
                label: `rpc ${path}`,
                dsts: [],
                confidence: "low",
                reason: "no_endpoint",
              });
            }
            return undefined;
          }
          push({ rule: "orpc", label: `rpc ${path}`, ...narrow(cands, file.ws) });
          return undefined;
        }
        if (kind === "hono") {
          const last = allKeys[allKeys.length - 1];
          const method = last ? HONO_METHODS[last] : undefined;
          if (!method) return undefined;
          const segs = allKeys.slice(0, -1).filter((k) => k !== "index" && k !== "");
          const path = `/${segs.join("/")}`;
          const cands = hono.filter(
            (ep) => (ep.data.method === method || ep.data.method === "ALL") && ep.data.path === path,
          );
          const label = `${method} ${path}`;
          if (cands.length === 0)
            push({ rule: "hono", label, dsts: [], confidence: "low", reason: "no_endpoint" });
          else push({ rule: "hono", label, ...narrow(cands, file.ws) });
        }
        return undefined;
      });
    }

    // A sub-client alias that no call went through is passed around (a default parameter, a constructor argument),
    // so its calls cannot be followed: reported, so a trace says where it stops.
    for (const { a, file } of aliasList) {
      const c = clients.get(a.key);
      if (!c || usedAliases.has(a.key)) continue;
      const label = c.kind === "orpc" ? `rpc ${c.prefix.join(".")}.*` : `${c.prefix.join(".")}.*`;
      hits.push({
        file,
        hit: {
          rule: c.kind,
          from: a.caller,
          line: a.line,
          label,
          dsts: [],
          confidence: "low",
          reason: "client_alias",
        },
      });
    }

    // Edges per (caller file, caller, endpoint); unmatched calls as nodes per (caller, label).
    const edges = new Map<string, EdgeRecord & { lines: Set<number>; path: string }>();
    const unmatched = new Map<string, { file: AdapterFileContext; hit: Hit; lines: number[] }>();
    for (const { file, hit } of hits) {
      if (hit.dsts.length === 0) {
        const k = `${file.path}\0${hit.from}\0${hit.label}`;
        const u = unmatched.get(k);
        if (u) u.lines.push(hit.line);
        else unmatched.set(k, { file, hit, lines: [hit.line] });
        continue;
      }
      for (const dst of hit.dsts) {
        const k = `${file.fileId}\0${hit.from}\0${dst}`;
        let e = edges.get(k);
        if (!e) {
          e = {
            src: hit.from,
            dst,
            kind: "requests",
            confidence: hit.confidence,
            count: 0,
            evidence: [],
            fileId: file.fileId,
            lines: new Set(),
            path: file.path,
          };
          edges.set(k, e);
        }
        if (hit.confidence === "high") e.confidence = "high";
        e.count++;
        e.lines.add(hit.line);
      }
    }
    const outEdges: EdgeRecord[] = [...edges.values()].map(({ lines, path, ...e }) => ({
      ...e,
      evidence: [...lines].sort((a, b) => a - b).map((l) => `${path}:${l}`),
    }));
    const nodes: AdapterNode[] = [];
    const alloc = new Map<string, IdAllocator>();
    const sorted = [...unmatched.values()].sort(
      (a, b) =>
        cmp(a.file.path, b.file.path) ||
        (a.lines[0] as number) - (b.lines[0] as number) ||
        cmp(a.hit.label, b.hit.label),
    );
    for (const { file, hit, lines } of sorted) {
      const ws = file.ws.id;
      const a = alloc.get(ws) ?? new IdAllocator();
      alloc.set(ws, a);
      nodes.push({
        id: a.take(`call:${wsName(ws)}:${hit.label}`),
        kind: "client_call",
        ws,
        label: hit.label,
        fileId: file.fileId,
        data: {
          adapter: "clients",
          rule: hit.rule,
          reason: hit.reason ?? "no_endpoint",
          label: hit.label,
          caller: hit.from,
          file: file.path,
          line: lines[0],
          ...(lines.length > 1 ? { lines: [...new Set(lines)].sort((x, y) => x - y) } : {}),
        },
      });
    }
    return { nodes, edges: outEdges };
  },
};

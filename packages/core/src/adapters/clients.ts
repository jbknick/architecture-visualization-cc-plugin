import { callId, fileId as makeFileId, parseId, repoOfId, symId } from "../ids.js";
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
import {
  altText,
  type Binding,
  evalUrl,
  localScope,
  type ModuleScope,
  moduleScope,
  type UrlScope,
} from "./urlEval.js";

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
 * | 4    | `fetch("/api/posts/${id}")`, `ky.post(...)`, `axios.get(...)` (a URL the evaluator reads)  | endpoint path, a run-time value as `:param` | high if unique |
 * | 4b   | `rel.get("/users")` on an `axios.create` / `ky.create` / `ky.extend` instance, or on `axios` with `axios.defaults.baseURL` set | endpoint path of the joined URL | high if unique |
 *
 * | 4c   | `relFetch("/users")` where `relFetch(path, init)` is a client wrapper (inferred, or listed in the recipe)  | endpoint path of the substituted URL | high if unique |
 *
 * Every URL argument (fetch-like calls, instance bases, wrapper arguments) goes through `evalUrl` (`urlEval.ts`),
 * which gives one or more alternatives (consts, enums, `as const` members, `??`, `||`, `+`, `new URL`, conditionals).
 * An alternative that does not start with text (an environment member, a value that is not known, a parameter) is
 * dropped; none left is a `dynamic_url` gap. Per alternative the candidates are the endpoints of the method whose path
 * fits segment by segment (a call literal fits an endpoint parameter, a call parameter does not fit an endpoint
 * literal), those with the fewest parameter segments, narrowed to the caller's workspace and its dependencies, then
 * to the caller's repo. In a workspace of several repos the endpoints of every repo are candidates (the other repos'
 * come from the store, `AdapterLinkContext.external`), so a call links to a handler in another repo when no
 * nearer one fits, and the same method and path in two other repos is an `ambiguous` gap. The call links, `high`, when the alternatives that fit agree on one endpoint and each is fully evaluated (no
 * environment member and no unknown part inside it); otherwise it is an `ambiguous` gap whose `data.candidates` are
 * the sorted endpoint ids, and gets no edge.
 *
 * A wrapper is a top-level function (declaration, or arrow / function expression bound to a `const`) with a client
 * call (fetch, an instance, `axios` / `ky`) or a call of another wrapper in which a parameter flows unchanged into the
 * start of the request path, or into the method (the method argument, or `init.method` of an `init` argument). A
 * parameter that only fills a later segment (`/users/${id}`) makes an ordinary call; after fixed text ending in a
 * slash (`/api/${path}`) the calls decide: a wrapper when one passes an argument with a slash in it. A leading base
 * (`${API_URL}`) is skipped. Qualifying calls that disagree make each call of the function a gap. Inference runs to a
 * fixpoint (8 passes), so a wrapper of a wrapper is one. Each call of a wrapper substitutes its arguments into the URL
 * template and the method; an argument that fills only a segment becomes `:param`, one that fills the start is a
 * `dynamic_url` gap. The client calls in a wrapper's body are not requests: each wrapper has one `client_call` node
 * with reason `wrapper_body` and `data.wrapper` its symbol id. The recipe's `clientWrappers` list wrappers by symbol
 * where inference does not see the flow (every client call of such a body is then `wrapper_body`).
 *
 * An instance is a top-level `const` initialised by `<axios>.create({ baseURL })`, `<ky>.create({ prefixUrl })` or
 * `<kyInstance>.extend({ prefixUrl? })` (`extend` without `prefixUrl` keeps the parent's base). Calls on it are
 * followed through imports and re-exports. The URL is joined by the library's own rule (`joinUrl`): axios puts the
 * base and the request path together with one `/`, an absolute request URL replaces the base; ky puts `prefixUrl`,
 * `/` and an input without a leading slash together. A base the evaluator does not read as a path or absolute URL
 * makes the call a gap (`dynamic_url`). Calls on the default `axios` import use the one `axios.defaults.baseURL` assigned at the top level
 * of a file of the same workspace; two different assignments in a workspace make them gaps (`ambiguous`).
 *
 * An oRPC client is a top-level `const` initialised by `createORPCClient`, `createTanstackQueryUtils` (or the other
 * `@orpc/*-query` utils), or by a function of the same file that returns one of those calls
 * (`const make = () => createORPCClient(link); export const client = make()`); a Hono client likewise by `hc` from
 * `hono/client`. Uses are followed through imports. Rule 2 strips one trailing helper (`queryOptions`,
 * `mutationOptions`, `key`, `call`, ...); a path that is a router prefix (`orpc.posts.key()`) is a cache helper,
 * not a request, and is skipped. Several candidates (the same path in two workspaces) narrow to the ones in the
 * caller's workspace or its dependencies; when more than one is left each gets a `low` edge (a fetch-like call is an
 * `ambiguous` gap instead).
 *
 * A client call that matches nothing (rule 2 or 3 without an endpoint, a fetch URL the evaluator cannot read or that
 * matches no route, `useServerFn` of something that is no server function) is not guessed: it becomes a
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

export type ClientRule = "server-fn" | "orpc" | "hono" | "fetch" | "instance" | "wrapper";

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
/**
 * An `axios.create` / `ky.create` / `ky.extend` instance. `base` is the offset of the expression that gives its base
 * URL (the options argument when that is no object literal), null for none; with `inherits` (an `extend` without
 * `prefixUrl`) the base is that of `parent`, the local name of the instance extended, or of no instance when
 * `parent` is null.
 */
interface InstanceDecl {
  symbol: string;
  /** Null for an `extend` of an instance of another file, whose library is the parent's. */
  lib: "axios" | "ky" | null;
  base: number | null;
  inherits: boolean;
  parent: string | null;
}

/** A piece of request text: literal text, a parameter of the enclosing function (its index), or anything else (null). */
type Piece = string | number | null;
/** An argument of a call: its text (null for an object literal), or for an object literal its `url` and `method`. */
interface ArgFact {
  text: Piece[] | null;
  obj?: { url?: Piece[] | null; method?: Piece[] | null };
}
/** A call in the body of a function, with arguments that mention one of its parameters. */
interface ParamCall {
  /** Dotted callee (`fetch`, `rel.get`, `relFetch`). */
  callee: string;
  start: number;
  args: ArgFact[];
}
interface WrapperFact {
  symbol: string;
  calls: ParamCall[];
}
export interface ClientFacts {
  /** Top-level client bindings declared in this file. */
  decls: ClientDecl[];
  /** Top-level `const x = <name>.a.b` member aliases (a sub-client when `<name>` is a client), read from the text. */
  aliases: { key: string; caller: string; name: string; root: string; keys: string[]; line: number }[];
  /** Top-level `axios.create` / `ky.create` / `ky.extend` instances declared in this file. */
  instances?: InstanceDecl[];
  /** Top-level `<axios>.defaults.baseURL = <expr>` assignments of this file (`base` is the offset of `<expr>`). */
  defaults?: { base: number }[];
  /** Top-level functions with calls whose arguments mention a parameter: the wrapper candidates. */
  wrappers?: WrapperFact[];
  /** Plain calls with an argument whose text contains a slash. */
  slashCalls?: { callee: string; slash: number[] }[];
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

/** The value of property `name` of an object expression (undefined when absent or computed away). */
function propOf(obj: unknown, name: string): unknown {
  const o = unwrap(obj);
  if (!isNode(o) || o.type !== "ObjectExpression") return undefined;
  for (const p of nodeArray(o.properties)) {
    const k = unwrap(p.key);
    if (p.type === "Property" && p.computed !== true && isNode(k) && (k.name === name || k.value === name))
      return p.value;
  }
  return undefined;
}

/**
 * Instances and default-instance base URLs of a file: top-level `const x = <axios>.create({ baseURL })`,
 * `<ky>.create({ prefixUrl })`, `<ky | kyInstance>.extend({ prefixUrl? })`, and `<axios>.defaults.baseURL = <expr>`.
 */
function readInstances(ctx: AdapterFileContext): Pick<ClientFacts, "instances" | "defaults"> {
  const libs = new Map<string, "axios" | "ky">();
  for (const i of ctx.parsed?.imports ?? []) {
    if (!i.local || i.typeOnly || i.imported !== "default") continue;
    if (i.specifier === "axios" || i.specifier === "ky") libs.set(i.local, i.specifier);
  }
  const program = libs.size > 0 || ctx.source.includes("extend(") ? ctx.program() : null;
  if (!program) return {};
  const local = (name: string) => ctx.parsed?.symbols.find((s) => s.name === name)?.id;
  const instances: InstanceDecl[] = [];
  const defaults: { base: number }[] = [];
  const names = new Map<string, "axios" | "ky">();
  for (const st of program) {
    if (st.type === "ExpressionStatement") {
      const e = unwrap(st.expression);
      if (!isNode(e) || e.type !== "AssignmentExpression" || e.operator !== "=") continue;
      const left = memberChain(e.left);
      if (left?.keys.join(".") !== "defaults.baseURL" || libs.get(left.root) !== "axios") continue;
      if (isNode(e.right)) defaults.push({ base: e.right.start });
      continue;
    }
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl) || decl.type !== "VariableDeclaration") continue;
    for (const d of nodeArray(decl.declarations)) {
      const id = unwrap(d.id);
      const init = unwrap(d.init);
      if (!isNode(id) || id.type !== "Identifier" || !isNode(init) || init.type !== "CallExpression")
        continue;
      const chain = memberChain(init.callee);
      const verb = chain?.keys[0];
      if (!chain || chain.keys.length !== 1 || (verb !== "create" && verb !== "extend")) continue;
      const symbol = local(id.name as string);
      const rootLib = libs.get(chain.root);
      if (!symbol || (verb === "create" && rootLib === undefined)) continue;
      if (rootLib === "axios" && verb === "extend") continue;
      const lib = rootLib ?? names.get(chain.root) ?? null;
      const opts = unwrap((Array.isArray(init.arguments) ? init.arguments : [])[0]);
      const isObject = isNode(opts) && opts.type === "ObjectExpression";
      const own = propOf(opts, lib === "axios" ? "baseURL" : "prefixUrl");
      const inherits = verb === "extend" && isObject && own === undefined;
      const baseNode = inherits ? undefined : isObject ? own : opts;
      instances.push({
        symbol,
        lib,
        base: isNode(baseNode) ? baseNode.start : null,
        inherits,
        parent: rootLib === undefined ? chain.root : null,
      });
      if (lib) names.set(id.name as string, lib);
    }
  }
  return {
    ...(instances.length > 0 ? { instances } : {}),
    ...(defaults.length > 0 ? { defaults } : {}),
  };
}

const joinPieces = (pieces: Piece[]): Piece[] => {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else if (p !== "") out.push(p);
  }
  return out;
};

/** A string, template or `+` concatenation as pieces; a parameter by its index, anything else null. */
function textPieces(expr: unknown, params: Map<string, number>): Piece[] {
  const v = unwrap(expr);
  if (!isNode(v)) return [null];
  if (v.type === "Literal" && typeof v.value === "string") return [v.value];
  if (v.type === "Identifier") return [params.get(v.name as string) ?? null];
  if (v.type === "BinaryExpression" && v.operator === "+")
    return joinPieces([...textPieces(v.left, params), ...textPieces(v.right, params)]);
  if (v.type !== "TemplateLiteral") return [null];
  const exprs = Array.isArray(v.expressions) ? v.expressions : [];
  const out: Piece[] = [];
  nodeArray(v.quasis).forEach((q, i) => {
    const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
    out.push(typeof cooked === "string" ? cooked : null);
    if (i < exprs.length) out.push(...textPieces(exprs[i], params));
  });
  return joinPieces(out);
}

function argFact(expr: unknown, params: Map<string, number>): ArgFact {
  const v = unwrap(expr);
  if (isNode(v) && v.type === "ObjectExpression") {
    const url = propOf(v, "url");
    const method = propOf(v, "method");
    return {
      text: null,
      obj: {
        ...(url !== undefined ? { url: textPieces(url, params) } : {}),
        ...(method !== undefined ? { method: textPieces(method, params) } : {}),
      },
    };
  }
  return { text: textPieces(v, params) };
}

const usesParam = (a: ArgFact): boolean =>
  [a.text, a.obj?.url, a.obj?.method].some((p) => p?.some((x) => typeof x === "number"));

/** Top-level functions with their parameters, and the calls in their bodies that pass a parameter on. */
function readWrapperFacts(ctx: AdapterFileContext): WrapperFact[] {
  const program = ctx.parsed ? ctx.program() : null;
  if (!program) return [];
  const out: WrapperFact[] = [];
  const fns: { name: string; fn: Node }[] = [];
  for (const st of program) {
    if (st.type === "ExportDefaultDeclaration") {
      // `export default function name() {}` is the symbol `name`; an anonymous function or arrow is `default`.
      const d = unwrap(st.declaration);
      if (
        isNode(d) &&
        (d.type === "FunctionDeclaration" ||
          d.type === "FunctionExpression" ||
          d.type === "ArrowFunctionExpression")
      )
        fns.push({ name: isNode(d.id) ? (d.id.name as string) : "default", fn: d });
      continue;
    }
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl)) continue;
    if (decl.type === "FunctionDeclaration" && isNode(decl.id))
      fns.push({ name: decl.id.name as string, fn: decl });
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of nodeArray(decl.declarations)) {
      const id = unwrap(d.id);
      const init = unwrap(d.init);
      if (
        isNode(id) &&
        id.type === "Identifier" &&
        isNode(init) &&
        (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")
      )
        fns.push({ name: id.name as string, fn: init });
    }
  }
  for (const { name, fn } of fns) {
    const symbol = ctx.parsed?.symbols.find((s) => s.name === name)?.id;
    const params = new Map<string, number>();
    nodeArray(fn.params).forEach((p, i) => {
      const id = p.type === "AssignmentPattern" ? unwrap(p.left) : p;
      if (isNode(id) && id.type === "Identifier") params.set(id.name as string, i);
    });
    if (!symbol || params.size === 0) continue;
    const calls: ParamCall[] = [];
    visit(fn.body, (n) => {
      if (n.type !== "CallExpression") return undefined;
      const chain = memberChain(n.callee);
      if (!chain || chain.computed) return undefined;
      const args = (Array.isArray(n.arguments) ? (n.arguments as unknown[]) : []).map((a) =>
        argFact(a, params),
      );
      if (args.some(usesParam))
        calls.push({ callee: [chain.root, ...chain.keys].join("."), start: n.start, args });
      return undefined;
    });
    if (calls.length > 0) out.push({ symbol, calls });
  }
  return out;
}

/**
 * Plain calls (`api("users/1")`) with an argument whose static text contains a slash: the call sites that tell a
 * function with fixed text ending in a slash before its parameter (`/api/${path}`) from one that fills a segment.
 */
function readSlashCalls(ctx: AdapterFileContext): { callee: string; slash: number[] }[] {
  const program = ctx.parsed && ctx.source.includes("/") ? ctx.program() : null;
  if (!program) return [];
  const out: { callee: string; slash: number[] }[] = [];
  visit(program, (n) => {
    if (n.type !== "CallExpression") return undefined;
    const callee = unwrap(n.callee);
    if (!isNode(callee) || callee.type !== "Identifier") return undefined;
    const slash: number[] = [];
    (Array.isArray(n.arguments) ? (n.arguments as unknown[]) : []).forEach((a, i) => {
      if (argFact(a, NO_PARAMS).text?.some((p) => typeof p === "string" && p.includes("/"))) slash.push(i);
    });
    if (slash.length > 0) out.push({ callee: callee.name as string, slash });
    return undefined;
  });
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

const stripQuery = (u: string): string => {
  const p = u.replace(/[?#].*$/, "");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

/** A URL text that no instance joins: an absolute URL whole, a path with query and hash dropped, else null. */
function plainPath(raw: string): string | null {
  // An absolute URL names another origin: kept whole, so it is reported as external and never matched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw.replace(/[?#].*$/, "");
  if (!raw.replace(/[?#].*$/, "").startsWith("/")) return null;
  return stripQuery(raw);
}

/**
 * The URL a call on an instance requests, by the library's join rule, query and hash dropped; null when the library
 * refuses it (ky with a leading slash on a prefixed input). axios: base and path with one `/` between, an absolute
 * (or protocol-relative) request URL replaces the base. ky: `prefixUrl`, `/`, then the input, which has no leading
 * slash. An empty base is no base. The result is a path, or an absolute URL for another origin.
 */
export function joinUrl(lib: "axios" | "ky", base: string, input: string): string | null {
  if (lib === "axios") {
    if (/^([a-z][a-z\d+\-.]*:)?\/\//i.test(input) || base === "") return stripQuery(input);
    return stripQuery(input === "" ? base : `${base.replace(/\/?\/$/, "")}/${input.replace(/^\/+/, "")}`);
  }
  if (base === "") return stripQuery(input);
  if (input.startsWith("/")) return null;
  return stripQuery(`${base.replace(/\/+$/, "")}/${input}`);
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

const NO_PARAMS = new Map<string, number>();

interface Hit {
  rule: ClientRule;
  from: string;
  line: number;
  label: string;
  /** Candidate endpoint ids (empty when unmatched). */
  dsts: string[];
  confidence: "high" | "low";
  reason?:
    | "no_endpoint"
    | "dynamic_url"
    | "external_url"
    | "not_a_server_fn"
    | "client_alias"
    | "ambiguous"
    | "wrapper_body";
  /** The wrapper whose body holds the call (reason `wrapper_body`). */
  wrapper?: string;
  /** The endpoints a call may reach (reason `ambiguous` of a fetch-like call), sorted. */
  candidates?: string[];
}

/** A URL alternative as text (`:param` for a value known at run time), and whether nothing in it is unknown. */
interface UrlText {
  text: string;
  full: boolean;
}

type MethodSrc = { fixed: string } | { param: number } | { init: number } | { unknown: true };
interface Via {
  lib: "axios" | "ky";
  /** The alternatives of the base URL; none when it is not static. */
  bases: UrlText[];
}
/** A client wrapper: the request its body makes, with the function's parameters as slots. */
interface Wrapper {
  symbol: string;
  name: string;
  /** URL template: literal text and parameter indexes. */
  url: Piece[];
  method: MethodSrc;
  via: Via | null;
  /** Listed in the recipe: every client call of its body is the wrapper's own. */
  all: boolean;
  /** Start offsets of the calls of its body that pass a parameter on. */
  starts: Set<number>;
  /** The request its first qualifying call makes, to compare with the others. */
  sig: string;
  /** Its qualifying calls disagree on URL, method or client: each call of it is a gap. */
  conflict: boolean;
}
const GET: MethodSrc = { fixed: "GET" };
const MAX_WRAPPER_PASSES = 8;

const methodOfPieces = (p: Piece[] | null | undefined): MethodSrc => {
  if (p === undefined) return GET;
  if (p === null) return { unknown: true };
  if (p.length === 1 && typeof p[0] === "number") return { param: p[0] };
  const text = p.every((x) => typeof x === "string") ? (p as string[]).join("") : "";
  return text === "" ? { unknown: true } : { fixed: text.toUpperCase() };
};
/** The method an argument that is the method itself stands for. */
const methodOfArg = (a: ArgFact | undefined): MethodSrc =>
  !a ? GET : a.obj ? { unknown: true } : methodOfPieces(a.text);
/** The method an `init` argument stands for: its `method` property, or itself when it is a parameter passed on. */
const methodOfInit = (a: ArgFact | undefined): MethodSrc => {
  if (!a) return GET;
  if (a.obj) return methodOfPieces(a.obj.method);
  return a.text?.length === 1 && typeof a.text[0] === "number" ? { init: a.text[0] } : { unknown: true };
};
/** A wrapper's method seen from a call: the argument it names. */
const methodAt = (m: MethodSrc, args: ArgFact[]): MethodSrc =>
  "param" in m ? methodOfArg(args[m.param]) : "init" in m ? methodOfInit(args[m.init]) : m;
/**
 * A wrapper's URL template with the arguments of a call in place of its parameters. An argument that starts with a
 * slash after template text that ends in one loses it (`/api/` and `/users` make `/api/users`).
 */
const substitute = (url: Piece[], args: ArgFact[]): Piece[] =>
  joinPieces(
    url.flatMap((p, i): Piece[] => {
      if (typeof p !== "number") return [p];
      const text = args[p]?.text ?? [null];
      const before = url[i - 1];
      const first = text[0];
      if (
        typeof before === "string" &&
        before.endsWith("/") &&
        typeof first === "string" &&
        first.startsWith("/")
      )
        return [first.replace(/^\/+/, ""), ...text.slice(1)];
      return text;
    }),
  );

/**
 * The parameter that supplies the start of the path, after leading base parts (`${BASE}`). Fixed text before it
 * must be empty, only slashes, or not end in a slash (`/api${path}`); text that ends in a slash (`/api/${path}`,
 * `/users/${id}`) is `ambiguous`: the parameter fills a segment unless a call passes it more than one.
 */
function leadSlot(url: Piece[]): { slot: number; ambiguous: boolean } | null {
  let i = 0;
  while (url[i] === null) i++;
  let prefix = "";
  for (; i < url.length; i++) {
    const p = url[i] as Piece;
    if (typeof p === "string") prefix += p;
    else if (typeof p === "number")
      return { slot: p, ambiguous: !(/^\/*$/.test(prefix) || !prefix.endsWith("/")) };
    else return null;
  }
  return null;
}

/** The outermost node of a program that starts at `start`. */
function nodeAt(program: Node[] | null, start: number): Node | null {
  const found: { node: Node | null } = { node: null };
  visit(program, (n) => {
    if (found.node || n.end <= start || n.start > start) return false;
    if (n.start === start) {
      found.node = n;
      return false;
    }
    return undefined;
  });
  return found.node;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const MAX_URL_COMBINATIONS = 16;

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
    const { instances, defaults } = readInstances(ctx);
    const wrappers = readWrapperFacts(ctx);
    const slashCalls = readSlashCalls(ctx);
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
      !instances &&
      !defaults &&
      wrappers.length === 0 &&
      slashCalls.length === 0 &&
      aliases.length === 0 &&
      roots.size === 0 &&
      idCalls.length === 0 &&
      !fetchLike &&
      !useServerFn &&
      !dollar
    )
      return {};
    return {
      facts: {
        decls,
        ...(instances ? { instances } : {}),
        ...(defaults ? { defaults } : {}),
        ...(wrappers.length > 0 ? { wrappers } : {}),
        ...(slashCalls.length > 0 ? { slashCalls } : {}),
        aliases,
        roots: [...roots].sort(cmp),
        idCalls,
        fetchLike,
        useServerFn,
        dollar,
      },
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

    // Constant evaluation (urlEval.ts): a file's top level with its imports followed, and the functions around a call.
    const moduleScopes = new Map<string, ModuleScope>();
    function moduleScopeOf(file: AdapterFileContext): ModuleScope | null {
      const known = moduleScopes.get(file.fileId);
      if (known) return known;
      const program = file.program();
      if (!program) return null;
      const scope = moduleScope(program, (name) => importBinding(file, name));
      moduleScopes.set(file.fileId, scope);
      return scope;
    }
    /** A const or enum another file exports, found through the import (and its re-exports) of `name`. */
    function importBinding(file: AdapterFileContext, name: string): Binding | null {
      const sym = symbolForName(file.parsed, file.fileId, name, ctx.resolver);
      const id = sym ? parseId(sym) : undefined;
      if (!id || id.kind !== "sym") return null;
      const target = ctx.file(makeFileId(ctx.repo, id.path as string));
      if (!target || target.fileId === file.fileId) return null;
      return moduleScopeOf(target)?.own((id.name as string).replace(/~\d+$/, "")) ?? null;
    }
    const functionsOf = new Map<string, Node[]>();
    const localScopes = new Map<Node, { parent: UrlScope; scope: UrlScope }>();
    /** The scope at an offset of a file: its top level, then each function around the offset, outermost first. */
    const scopeAt = (file: AdapterFileContext, offset: number): UrlScope | null => {
      let scope: UrlScope | null = moduleScopeOf(file);
      if (!scope) return null;
      let fns = functionsOf.get(file.fileId);
      if (!fns) {
        const list: Node[] = [];
        visit(file.program(), (n) => {
          if (FUNCTION_TYPES.has(n.type)) list.push(n);
          return undefined;
        });
        fns = list;
        functionsOf.set(file.fileId, list);
      }
      for (const fn of fns) {
        if (fn.start > offset || offset >= fn.end) continue;
        let local = localScopes.get(fn);
        if (!local || local.parent !== scope) {
          local = { parent: scope, scope: localScope(scope, fn) };
          localScopes.set(fn, local);
        }
        scope = local.scope;
      }
      return scope;
    };
    /** The alternatives of a URL expression as text; none when it is not an expression or no alternative starts with text. */
    const urlTexts = (scope: UrlScope | null, expr: unknown): UrlText[] => {
      const out: UrlText[] = [];
      for (const alt of (scope ? evalUrl(expr, scope) : null) ?? []) {
        const t = altText(alt);
        if (t && !out.some((o) => o.text === t.text && o.full === t.full)) out.push(t);
      }
      return out;
    };
    /** The alternatives of an instance's base URL (written at `at`, or none): a path, an absolute URL or empty. */
    const baseTexts = (file: AdapterFileContext, at: number | null): UrlText[] => {
      if (at === null) return [{ text: "", full: true }];
      const scope = moduleScopeOf(file);
      const out: UrlText[] = [];
      for (const t of urlTexts(scope, nodeAt(file.program(), at))) {
        const text = stripQuery(t.text);
        if (text !== "" && !text.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) continue;
        if (!out.some((o) => o.text === text && o.full === t.full)) out.push({ text, full: t.full });
      }
      return out;
    };

    // Instances, `extend` of an instance of another file resolved through the imports.
    const instances = new Map<string, Via>();
    const instList = ctx.files.flatMap(({ file, facts }) =>
      (facts?.instances ?? []).map((i) => ({ i, file })),
    );
    for (const { i, file } of instList) {
      if (i.lib && !i.inherits) instances.set(i.symbol, { lib: i.lib, bases: baseTexts(file, i.base) });
    }
    for (let pass = 0; pass < 4; pass++) {
      let added = false;
      for (const { i, file } of instList) {
        if (instances.has(i.symbol)) continue;
        // An `extend` of the `ky` import itself has no instance to inherit from: no base.
        const ref = i.parent ? refOf(file, i.parent) : null;
        const parent = ref ? instances.get(ref) : undefined;
        if (i.parent && !parent) continue;
        const lib = i.lib ?? parent?.lib;
        if (!lib) continue;
        instances.set(i.symbol, {
          lib,
          bases: i.inherits ? (parent ? parent.bases : baseTexts(file, null)) : baseTexts(file, i.base),
        });
        added = true;
      }
      if (!added) break;
    }
    // The base set on the default `axios` of each workspace: the distinct assignments of its files.
    const defaultBases = new Map<string, Map<string, UrlText[]>>();
    for (const { file, facts } of ctx.files) {
      for (const d of facts?.defaults ?? []) {
        const bases = baseTexts(file, d.base);
        const set = defaultBases.get(file.ws.id) ?? new Map<string, UrlText[]>();
        set.set(JSON.stringify(bases), bases);
        defaultBases.set(file.ws.id, set);
      }
    }

    const libCache = new Map<string, { http: Set<string>; axios: Set<string> }>();
    /** The local names a file imports `ky` / `axios` under, and the `axios` ones alone. */
    const libsOf = (file: AdapterFileContext) => {
      let l = libCache.get(file.fileId);
      if (!l) {
        const imps = (file.parsed?.imports ?? []).filter(
          (i) => i.local && (i.specifier === "ky" || i.specifier === "axios"),
        );
        l = {
          http: new Set(imps.map((i) => i.local)),
          axios: new Set(
            imps.filter((i) => i.specifier === "axios" && i.imported === "default").map((i) => i.local),
          ),
        };
        libCache.set(file.fileId, l);
      }
      return l;
    };
    const instOf = (file: AdapterFileContext, name: string): Via | undefined => {
      const ref = instances.size > 0 ? refOf(file, name) : null;
      return ref ? instances.get(ref) : undefined;
    };
    /**
     * The client a callee (`fetch`, `rel.get`, `axios.post`) is: the instance or default-`axios` base it goes through
     * (null for none), the verb or `request` it is called by, and whether two default bases make it ambiguous. Null
     * when the callee is no client.
     */
    const clientCall = (file: AdapterFileContext, callee: string[]) => {
      const [root = "", ...keys] = callee;
      const inst = instOf(file, root);
      const libs = libsOf(file);
      const isFetch = FETCH_CALLEES.has(callee.join("."));
      const isLib = (inst !== undefined || libs.http.has(root)) && keys.length <= 1;
      if (!isFetch && !isLib) return null;
      const member = isLib ? (keys[0] ?? null) : null;
      if (member !== null && !HTTP_VERBS.has(member) && member !== "request") return null;
      let via: Via | null = inst ?? null;
      let ambiguous = false;
      if (!via && libs.axios.has(root)) {
        const bases = defaultBases.get(file.ws.id);
        if (bases && bases.size > 1) ambiguous = true;
        else if (bases) via = { lib: "axios", bases: [...bases.values()][0] as UrlText[] };
      }
      return { via, member, ambiguous };
    };

    // Client wrappers: those the recipe lists, then the inferred ones, to a fixpoint.
    const wrappers = new Map<string, Wrapper>();
    const nameOf = (symbol: string) => symbol.slice(symbol.lastIndexOf("#") + 1);
    for (const w of ctx.recipe?.recipe?.clientWrappers ?? []) {
      wrappers.set(w.symbol, {
        symbol: w.symbol,
        name: nameOf(w.symbol),
        url: w.prefix ? [w.prefix, w.pathArg] : [w.pathArg],
        method: w.methodArg === undefined ? GET : { param: w.methodArg },
        via: null,
        all: true,
        starts: new Set(),
        sig: "",
        conflict: false,
      });
    }
    const candidates = ctx.files.flatMap(({ file, facts }) =>
      (facts?.wrappers ?? []).map((w) => ({ file, w })),
    );
    /** What a call of a function's body requests, in the function's parameters: null when it is no request. */
    const requestOfCall = (file: AdapterFileContext, own: string, c: ParamCall) => {
      const callee = c.callee.split(".");
      const client = clientCall(file, callee);
      if (client) {
        if (client.ambiguous) return null;
        const first = c.args[0];
        const opts = first?.obj ? first : c.args[1];
        const verb = client.member !== null && HTTP_VERBS.has(client.member);
        const m = verb ? { fixed: (client.member as string).toUpperCase() } : methodOfInit(opts);
        let url = (first?.obj ? first.obj.url : first?.text) ?? [null];
        // Without an instance a leading base is dropped, as for rule 4.
        if (client.via === null) while (url.length > 1 && url[0] === null) url = url.slice(1);
        return {
          url,
          // An unreadable method is GET, as for a call outside a wrapper.
          method: "unknown" in m ? GET : m,
          via: client.via,
        };
      }
      const sym =
        callee.length === 1 ? symbolForName(file.parsed, file.fileId, c.callee, ctx.resolver) : null;
      const callee2 = sym && sym !== own ? wrappers.get(sym) : undefined;
      if (!callee2 || callee2.conflict) return null;
      return {
        url: substitute(callee2.url, c.args),
        method: methodAt(callee2.method, c.args),
        via: callee2.via,
      };
    };
    // Calls that pass a slash on, by the function they call: what decides `/api/${path}` against `/users/${id}`.
    const slashSlots = new Map<string, Set<number>>();
    for (const { file, facts } of ctx.files) {
      for (const c of facts?.slashCalls ?? []) {
        const sym = symbolForName(file.parsed, file.fileId, c.callee, ctx.resolver);
        if (!sym) continue;
        const set = slashSlots.get(sym) ?? new Set<number>();
        for (const i of c.slash) set.add(i);
        slashSlots.set(sym, set);
      }
    }
    for (let pass = 0; pass < MAX_WRAPPER_PASSES; pass++) {
      let added = false;
      for (const { file, w } of candidates) {
        if (wrappers.get(w.symbol)?.all) continue;
        for (const c of w.calls) {
          const req = requestOfCall(file, w.symbol, c);
          if (!req) continue;
          const lead = leadSlot(req.url);
          const leads =
            lead !== null && (!lead.ambiguous || slashSlots.get(w.symbol)?.has(lead.slot) === true);
          if (!leads && !("param" in req.method) && !("init" in req.method)) continue;
          const sig = JSON.stringify([req.url, req.method, req.via]);
          let found = wrappers.get(w.symbol);
          if (!found) {
            found = {
              symbol: w.symbol,
              name: nameOf(w.symbol),
              ...req,
              all: false,
              starts: new Set(),
              sig,
              conflict: false,
            };
            wrappers.set(w.symbol, found);
            added = true;
          } else if (found.sig !== sig && !found.all) found.conflict = true;
          found.starts.add(c.start);
        }
      }
      if (!added) break;
    }

    // Endpoints by what a client call names.
    const fnBySym = new Map<string, string>();
    const fnByName = new Map<string, string[]>();
    const fnByLocal = new Map<string, string>();
    const rpcByPath = new Map<string, AdapterNode[]>();
    const rpcPrefixes = new Set<string>();
    /** Endpoints with a method and a path, whatever made them. */
    const http: AdapterNode[] = [];
    /** The endpoints a Hono app made (rule 3 reads these only). */
    const hono: AdapterNode[] = [];
    // The endpoints of the other repos of the workspace are candidates like the repo's own.
    for (const n of [...ctx.nodes, ...ctx.external.nodes]) {
      if (n.kind !== "endpoint") continue;
      const d = n.data;
      if (d.adapter === "tanstack-start" && typeof d.name === "string" && typeof d.file === "string") {
        const fileId = makeFileId(repoOfId(n.fileId) ?? ctx.repo, d.file);
        const sym = d.exported === true ? ctx.resolver.resolveSymbol(fileId, d.name) : null;
        fnBySym.set(sym ?? symId(repoOfId(n.fileId) ?? ctx.repo, d.file, d.name), n.id);
        // A const that is no symbol of its file (a non-exported `createServerFn()` chain) is found by name there.
        fnByLocal.set(`${fileId}\0${d.name}`, n.id);
        const key = `${n.ws}\0${d.name}`;
        fnByName.set(key, [...(fnByName.get(key) ?? []), n.id]);
      } else if (d.adapter === "orpc" && typeof d.path === "string") {
        rpcByPath.set(d.path, [...(rpcByPath.get(d.path) ?? []), n]);
        const parts = d.path.split(".");
        for (let i = 1; i < parts.length; i++) rpcPrefixes.add(parts.slice(0, i).join("."));
      } else if (typeof d.method === "string" && typeof d.path === "string") {
        http.push(n);
        if (d.adapter === "hono") hono.push(n);
      }
    }
    const wsByName = new Map([...ctx.workspaces, ...ctx.external.workspaces].map((w) => [w.id, w]));
    /**
     * Narrows several candidates to the caller's workspace and its dependencies, then to the caller's repo. Several
     * left (the same endpoint in two repos, or two workspaces) stay candidates.
     */
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
      const own = cands.filter((c) => repoOfId(c.id) === ctx.repo);
      const use = near.length > 0 ? near : own.length > 0 ? own : cands;
      return { dsts: use.map((c) => c.id).sort(cmp), confidence: "low" };
    };

    const hasServerFns = fnBySym.size > 0 || fnByName.size > 0 || fnByLocal.size > 0;
    const routeFiles = new Set(ctx.nodes.filter((n) => n.kind === "route").map((n) => n.fileId));
    const hits: { file: AdapterFileContext; hit: Hit }[] = [];
    for (const { file, facts } of ctx.files) {
      if (!facts) continue;
      const pf = file.parsed;
      // The route definition's own calls (its loader) are the route's `requests` edge already.
      const isRouteDef = (from: string): boolean => from.endsWith("#Route") && routeFiles.has(file.fileId);

      // Rule 1: a call of a server function (resolved through imports, or one of this file).
      // Without a server function in the repository no such call can name one, so none is resolved.
      for (const c of hasServerFns ? facts.idCalls : []) {
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
      // Calls on an instance (`rel.get(...)`, `rel({ ... })`), through imports and re-exports, and of wrappers.
      const roots = new Set([...facts.roots, ...facts.idCalls.map((c) => c.name)]);
      const hasInstance = [...roots].some((r) => instOf(file, r) !== undefined);
      const wrapperCalls = new Map<string, Wrapper>();
      for (const c of facts.idCalls) {
        const sym = symbolForName(pf, file.fileId, c.name, ctx.resolver);
        const w = sym ? wrappers.get(sym) : undefined;
        if (w) wrapperCalls.set(c.name, w);
      }
      if (
        rootKinds.size === 0 &&
        !hasInstance &&
        wrapperCalls.size === 0 &&
        !facts.fetchLike &&
        !facts.useServerFn
      )
        continue;
      const program = file.program();
      if (!program) continue;
      const line = lineTable(file.source);
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

        // The body of a wrapper makes the request its callers make: no edge of its own.
        const own = wrappers.get(from);
        const inBody = own !== undefined && (own.all || own.starts.has(n.start));
        const bodyHit = (): Omit<Hit, "from" | "line"> => ({
          rule: "wrapper",
          label: `wrapper ${(own as Wrapper).name}`,
          dsts: [],
          confidence: "low",
          reason: "wrapper_body",
          wrapper: (own as Wrapper).symbol,
        });

        /**
         * Matches a method and the alternatives of a URL to the endpoints. Per alternative the candidates are the
         * endpoints of that method whose path fits with the fewest parameter segments; the call links, at `high`,
         * when the alternatives that fit agree on one endpoint and every one of them is fully evaluated, else it is an
         * `ambiguous` gap with the candidates.
         */
        const finish = (rule: ClientRule, via: Via | null, method: string, urls: UrlText[]) => {
          const gap = (label: string, reason: NonNullable<Hit["reason"]>) =>
            push({ rule, label, dsts: [], confidence: "low", reason });
          /** Each path the call may request, and whether it is fully evaluated. */
          const paths = new Map<string, boolean>();
          let refused: string | null = null;
          for (const u of urls) {
            for (const b of via ? via.bases : [null]) {
              const path = via && b ? joinUrl(via.lib, b.text, u.text) : plainPath(u.text);
              if (path === null) {
                if (via) refused ??= u.text;
                continue;
              }
              paths.set(path, (paths.get(path) ?? true) && u.full && (b?.full ?? true));
            }
          }
          if (paths.size === 0) {
            if (refused !== null) gap(`${method} ${refused}`, "no_endpoint");
            else gap(`${method} <dynamic>`, "dynamic_url");
            return;
          }
          const matchable = [...paths].filter(([path]) => path.startsWith("/"));
          if (matchable.length === 0) {
            const [path] = [...paths.keys()] as [string];
            gap(
              `${method} ${path}`,
              via && !/^([a-z][a-z\d+\-.]*:)?\/\//i.test(path) ? "no_endpoint" : "external_url",
            );
            return;
          }
          const found = new Set<string>();
          let matched: string | null = null;
          let full = true;
          for (const [path, isFull] of matchable) {
            let best: number | null = null;
            let cands: AdapterNode[] = [];
            for (const ep of http) {
              const m = ep.data.method as string;
              if (m !== method && m !== "ALL") continue;
              const s = pathScore(path, ep.data.path as string);
              if (s === null) continue;
              if (best === null || s < best) {
                best = s;
                cands = [ep];
              } else if (s === best) cands.push(ep);
            }
            if (cands.length === 0) continue;
            for (const d of narrow(cands, file.ws).dsts) found.add(d);
            matched ??= path;
            full &&= isFull;
          }
          if (matched === null) {
            gap(`${method} ${(matchable[0] as [string, boolean])[0]}`, "no_endpoint");
            return;
          }
          const label = `${method} ${matched}`;
          const [only] = [...found];
          if (found.size === 1 && full && only) push({ rule, label, dsts: [only], confidence: "high" });
          else
            push({
              rule,
              label,
              dsts: [],
              confidence: "low",
              reason: "ambiguous",
              candidates: [...found].sort(cmp),
            });
        };

        // A call of a wrapper: its arguments go into the wrapper's URL template and method.
        const wrapper = chain.keys.length === 0 ? wrapperCalls.get(chain.root) : undefined;
        if (wrapper && wrapper.symbol !== from) {
          if (inBody) {
            push(bodyHit());
            return undefined;
          }
          const dynamic = (label: string) =>
            push({ rule: "wrapper", label, dsts: [], confidence: "low", reason: "dynamic_url" });
          if (wrapper.conflict) {
            dynamic(`${wrapper.name} <dynamic>`);
            return undefined;
          }
          const given = args.map((a) => argFact(a, NO_PARAMS));
          const method = methodAt(wrapper.method, given);
          const dynamicLabel = "fixed" in method ? `${method.fixed} <dynamic>` : "<dynamic>";
          if (!("fixed" in method)) {
            dynamic(dynamicLabel);
            return undefined;
          }
          // Each argument that fills a slot of the URL template stands for its alternatives.
          const scope = scopeAt(file, n.start);
          let combos: { given: ArgFact[]; full: boolean }[] = [{ given, full: true }];
          for (const slot of new Set(wrapper.url.filter((p): p is number => typeof p === "number"))) {
            const alts = (scope ? evalUrl(args[slot], scope) : null) ?? [];
            const options = alts.map((alt) => ({
              text: joinPieces(alt.parts.map((p): Piece => (typeof p === "string" ? p : null))),
              full: alt.parts.every((p) => typeof p === "string" || "param" in p),
            }));
            if (options.length === 0) options.push({ text: [null], full: false });
            combos = combos.flatMap((c) =>
              options.map((o) => {
                const next = [...c.given];
                next[slot] = { text: o.text };
                return { given: next, full: c.full && o.full };
              }),
            );
            if (combos.length > MAX_URL_COMBINATIONS) {
              combos = [];
              break;
            }
          }
          const lead = leadSlot(wrapper.url);
          const urls: UrlText[] = [];
          for (const c of combos) {
            const url = substitute(wrapper.url, c.given);
            if (url[0] === null || (lead !== null && (c.given[lead.slot]?.text?.[0] ?? null) === null))
              continue;
            const text = url.map((p) => p ?? ":param").join("");
            if (!urls.some((u) => u.text === text && u.full === c.full)) urls.push({ text, full: c.full });
          }
          if (urls.length === 0) {
            dynamic(dynamicLabel);
            return undefined;
          }
          finish("wrapper", wrapper.via, method.fixed, urls);
          return undefined;
        }

        // fetch / ky / axios, and calls on instances
        const cc = clientCall(file, [chain.root, ...chain.keys]);
        if (cc) {
          if (inBody) {
            push(bodyHit());
            return undefined;
          }
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
          const method = methodOf(opts, cc.member);
          if (cc.ambiguous) {
            push({
              rule: "instance",
              label: `${method} <default axios>`,
              dsts: [],
              confidence: "low",
              reason: "ambiguous",
            });
            return undefined;
          }
          // The base the call is made with: its instance, or the default `axios` of a workspace that sets one.
          const via = cc.via;
          finish(via ? "instance" : "fetch", via, method, urlTexts(scopeAt(file, n.start), urlArg));
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
        id: a.take(callId(ctx.repo, wsName(ws), hit.label)),
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
          ...(hit.wrapper ? { wrapper: hit.wrapper } : {}),
          ...(hit.candidates ? { candidates: hit.candidates } : {}),
        },
      });
    }
    return { nodes, edges: outEdges };
  },
};

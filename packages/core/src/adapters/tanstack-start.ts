import { chainName, isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { EdgeRecord } from "../types.js";
import {
  type Adapter,
  type AdapterNode,
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
import { findRouteCall } from "./tanstack-routes.js";

/**
 * TanStack Start server functions (https://tanstack.com/start/latest/docs/framework/react/guide/server-functions,
 * checked 2026-11): `export const name = createServerFn({ method? })` followed by any of `.validator(...)`,
 * `.inputValidator(...)` (the newer name), `.middleware([...])` and finally `.handler(fn)`. The method defaults to GET.
 *
 * Node `ep:<ws>:fn <exportName>` (kind `endpoint`), `handles` to the code of the handler, and `requests` from a
 * route whose `loader` or `beforeLoad` calls the server function.
 */

export const START_PACKAGES = ["@tanstack/react-start", "@tanstack/solid-start", "@tanstack/start"];
const VALIDATORS = new Set(["validator", "inputValidator"]);

export interface ServerFnFact {
  /** Binding name in the file. */
  name: string;
  /** Name it is exported under (the binding name when it is not exported). */
  exportName: string;
  exported: boolean;
  method: string;
  validator: boolean;
  middleware: string[];
  /** `inline` for a function written in `.handler(...)`, else the identifier passed. */
  handler: string;
  /** Symbol holding the handler's code: the resolved handler, or for an inline handler the const itself (its calls are attributed there). */
  handlerSymbol: string | null;
  /** Lines of an inline handler. */
  handlerSpan?: { start: number; end: number };
  /** The const's own symbol id (what an importer of the server function resolves to). */
  symbol: string | null;
  line: number;
}

const describeArg = (v: unknown): string => {
  const n = unwrap(v);
  if (isNode(n) && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression")) return "inline";
  return chainName(n) ?? "expression";
};

function readServerFns(
  program: Node[],
  locals: ReadonlySet<string>,
  ctx: Parameters<NonNullable<Adapter["extract"]>>[0],
): ServerFnFact[] {
  const out: ServerFnFact[] = [];
  const pf = ctx.parsed;
  for (const st of program) {
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl) || decl.type !== "VariableDeclaration") continue;
    for (const d of nodeArray(decl.declarations)) {
      const id = unwrap(d.id);
      if (!isNode(id) || id.type !== "Identifier") continue;
      const { base, calls } = flattenChain(d.init);
      const first = calls[0];
      if (base !== undefined || !first || !locals.has(first.name)) continue;
      let handlerCall: (typeof calls)[number] | undefined;
      for (const c of calls) if (c.name === "handler") handlerCall = c;
      if (!handlerCall || handlerCall === first) continue;
      const name = id.name as string;
      let method = "GET";
      const opts = unwrap(first.args[0]);
      if (isNode(opts) && opts.type === "ObjectExpression") {
        for (const p of nodeArray(opts.properties)) {
          const k = unwrap(p.key);
          if (p.type === "Property" && isNode(k) && k.type === "Identifier" && k.name === "method") {
            const v = stringValue(p.value);
            if (v) method = v.toUpperCase();
          }
        }
      }
      const middleware: string[] = [];
      for (const c of calls) {
        if (c.name !== "middleware") continue;
        const arr = unwrap(c.args[0]);
        if (isNode(arr) && arr.type === "ArrayExpression") {
          for (const el of nodeArray(arr.elements)) middleware.push(describeArg(el));
        } else if (c.args[0] !== undefined) middleware.push(describeArg(c.args[0]));
      }
      const own = pf?.symbols.find((s) => s.name === name)?.id ?? null;
      const h = handlerCall.args[handlerCall.args.length - 1];
      const handler = describeArg(h);
      // An inline handler's calls are attributed to the symbol whose body holds it (the const, when it is one).
      let handlerSymbol: string | null = isNode(unwrap(h))
        ? (own ?? enclosingSymbol(pf, ctx.fileId, (unwrap(h) as Node).start))
        : null;
      if (handler !== "inline") {
        const hn = unwrap(h);
        handlerSymbol =
          isNode(hn) && hn.type === "Identifier"
            ? symbolForName(pf, ctx.fileId, hn.name as string, ctx.resolver)
            : null;
      }
      const hu = unwrap(h);
      const handlerSpan = handler === "inline" && isNode(hu) ? spanOf(ctx.source, hu) : undefined;
      const exp = pf?.exports.find((e) => e.local === name && e.fromSpecifier === undefined && !e.star);
      const exported = st.type === "ExportNamedDeclaration" || exp !== undefined;
      out.push({
        name,
        exportName: st.type === "ExportNamedDeclaration" ? name : (exp?.exported ?? name),
        exported,
        method,
        validator: calls.some((c) => VALIDATORS.has(c.name)),
        middleware,
        handler,
        handlerSymbol,
        ...(handlerSpan ? { handlerSpan } : {}),
        symbol: own,
        line: lineOf(ctx.source, d.start),
      });
    }
  }
  return out;
}

/** Function bodies a route option names: an inline function, or a top-level function or const of the file. */
function optionBodies(program: Node[], value: unknown): unknown[] {
  const v = unwrap(value);
  if (!isNode(v)) return [];
  if (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression") return [v];
  if (v.type !== "Identifier") return [];
  const name = v.name as string;
  for (const st of program) {
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl)) continue;
    if (decl.type === "FunctionDeclaration" && isNode(decl.id) && decl.id.name === name) return [decl];
    if (decl.type === "VariableDeclaration") {
      for (const d of nodeArray(decl.declarations)) {
        const id = unwrap(d.id);
        if (isNode(id) && id.type === "Identifier" && id.name === name) return [d.init];
      }
    }
  }
  return [];
}

/** Identifiers called directly (`fn(...)`, `await fn(...)`) in `loader` / `beforeLoad` of the file's route, with their offsets. */
function loaderCalls(program: Node[]): { name: string; start: number }[] {
  const call = findRouteCall(program);
  const opts = unwrap(call?.options);
  if (!isNode(opts) || opts.type !== "ObjectExpression") return [];
  const out: { name: string; start: number }[] = [];
  for (const p of nodeArray(opts.properties)) {
    if (p.type !== "Property") continue;
    const k = unwrap(p.key);
    const key = isNode(k) && k.type === "Identifier" ? (k.name as string) : stringValue(k);
    if (key !== "loader" && key !== "beforeLoad") continue;
    for (const body of optionBodies(program, p.value)) {
      visit(body, (n) => {
        if (n.type !== "CallExpression") return undefined;
        const callee = unwrap(n.callee);
        if (isNode(callee) && callee.type === "Identifier")
          out.push({ name: callee.name as string, start: n.start });
        return undefined;
      });
    }
  }
  return out;
}

export const tanstackStartAdapter: Adapter<ServerFnFact[]> = {
  id: "tanstack-start",
  appliesTo: (ws) => hasDependency(ws, START_PACKAGES),
  mayMatch: (file) => file.source.includes("createServerFn"),
  extract(ctx) {
    const program = ctx.program();
    if (!program) return {};
    const locals = new Set(["createServerFn"]);
    for (const i of ctx.parsed?.imports ?? []) {
      if (i.imported === "createServerFn" && START_PACKAGES.includes(i.specifier) && i.local)
        locals.add(i.local);
    }
    return { facts: readServerFns(program, locals, ctx) };
  },
  link(ctx) {
    const nodes: AdapterNode[] = [];
    const edges: EdgeRecord[] = [];
    const ids = new Map<string, IdAllocator>();
    /** Server function const symbol -> endpoint id; and per workspace, export name -> endpoint ids. */
    const bySymbol = new Map<string, string>();
    /** `<file id>\0<binding name>` -> endpoint id, for a route file that defines its own server function. */
    const byLocal = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const { file, facts } of ctx.files) {
      for (const fn of facts ?? []) {
        const ws = file.ws.id;
        const alloc = ids.get(ws) ?? new IdAllocator();
        ids.set(ws, alloc);
        const id = alloc.take(`ep:${wsName(ws)}:fn ${fn.exportName}`);
        nodes.push({
          id,
          kind: "endpoint",
          ws,
          label: `fn ${fn.exportName}`,
          fileId: file.fileId,
          data: {
            adapter: "tanstack-start",
            name: fn.exportName,
            method: fn.method,
            validator: fn.validator,
            middleware: fn.middleware,
            handler: fn.handler,
            ...(fn.handlerSpan ? { handlerSpan: fn.handlerSpan } : {}),
            exported: fn.exported,
            file: file.path,
            line: fn.line,
          },
        });
        if (fn.handlerSymbol) {
          edges.push({
            src: id,
            dst: fn.handlerSymbol,
            kind: "handles",
            confidence: "high",
            count: 1,
            evidence: [`${file.path}:${fn.line}`],
            fileId: file.fileId,
          });
        }
        if (fn.symbol) bySymbol.set(fn.symbol, id);
        byLocal.set(`${file.fileId}\0${fn.name}`, id);
        const key = `${ws}\0${fn.exportName}`;
        byName.set(key, [...(byName.get(key) ?? []), id]);
      }
    }
    if (nodes.length === 0) return { nodes, edges };

    // Route loaders and beforeLoad hooks that call a server function.
    for (const route of ctx.nodes) {
      if (route.kind !== "route") continue;
      const file = ctx.file(route.fileId);
      const program = file?.program();
      if (!file || !program) continue;
      const counts = new Map<
        string,
        { dst: string; confidence: "high" | "low"; count: number; line: number }
      >();
      for (const c of loaderCalls(program)) {
        const sym = symbolForName(file.parsed, file.fileId, c.name, ctx.resolver);
        const imp = file.parsed?.imports.find((i) => i.local === c.name);
        let dst = sym ? bySymbol.get(sym) : imp ? undefined : byLocal.get(`${file.fileId}\0${c.name}`);
        let confidence: "high" | "low" = "high";
        if (!dst) {
          // Imported but not resolved to a server function: a unique export name in the route's workspace.
          const cands = imp && !sym ? (byName.get(`${route.ws}\0${imp.imported}`) ?? []) : [];
          if (cands.length !== 1) continue;
          dst = cands[0] as string;
          confidence = "low";
        }
        const prev = counts.get(dst);
        if (prev) prev.count++;
        else counts.set(dst, { dst, confidence, count: 1, line: lineOf(file.source, c.start) });
      }
      for (const e of [...counts.values()].sort((a, b) => cmp(a.dst, b.dst))) {
        edges.push({
          src: route.id,
          dst: e.dst,
          kind: "requests",
          confidence: e.confidence,
          count: e.count,
          evidence: [`${file.path}:${e.line}`],
          fileId: file.fileId,
        });
      }
    }
    return { nodes, edges };
  },
};

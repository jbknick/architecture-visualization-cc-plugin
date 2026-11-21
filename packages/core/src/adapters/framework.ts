import { parseSync } from "oxc-parser";
import { isTestPath } from "../dup/filters.js";
import { isNode, type Node, nodeArray, unwrap } from "../parse/ast.js";
import type { ParsedFile } from "../parse/index.js";
import type { LoadedRecipe } from "../recipe/load.js";
import type { Resolver } from "../resolve/index.js";
import type { AdapterNodeRecord, EdgeRecord, WorkspaceRecord } from "../types.js";

/**
 * The adapter framework (spec section 9a): framework patterns become adapter nodes (`adapter_nodes`) and edges.
 *
 * Every index run (main and working, full or targeted) calls `runAdapters` over the whole read set, so an adapter
 * always sees every file of its workspaces. An adapter works in two stages:
 *
 * 1. `extract`, once per file of a workspace it `appliesTo` (and whose text passes `mayMatch`): what the file alone
 *    says, as nodes, edges and adapter-private `facts`.
 * 2. `link` (optional), once per run: cross-file work (Hono mounts across imports, a route loader calling a server
 *    function, later oRPC router nesting and client-call matching) from every file's facts plus the nodes every
 *    earlier adapter returned.
 *
 * Every node and edge names the `fileId` it belongs to; the indexer stores it with that file (replaced per file,
 * like symbols). Output is sorted (nodes by id, edges by file, src, dst, kind) and duplicate node ids or
 * (src, dst, kind) edges keep the first one in that order, so runs are deterministic.
 */

export type AdapterNodeKind = "route" | "endpoint" | "middleware" | "table" | "procedure" | "client_call";

export interface AdapterNode extends AdapterNodeRecord {
  kind: AdapterNodeKind;
  /** Workspace id (`ws:<package name>`). */
  ws: string;
}

export interface AdapterOutput {
  nodes: AdapterNode[];
  edges: EdgeRecord[];
}

export interface AdapterFile {
  /** Repo-relative posix path. */
  path: string;
  id: string;
  workspaceId: string;
  source: string;
}

export type AdapterResolver = Pick<
  Resolver,
  "resolveSpecifier" | "resolveSymbol" | "targetAt" | "typeNameAt"
>;

/** What `extract` gets for one file. */
export interface AdapterFileContext {
  /** The repo name in every id (`GantryPaths.repo`). */
  repo: string;
  fileId: string;
  path: string;
  ws: WorkspaceRecord;
  /** Every workspace of the repository (a rule may apply through the workspaces its own depends on). */
  workspaces: readonly WorkspaceRecord[];
  source: string;
  parsed: ParsedFile | undefined;
  resolver: AdapterResolver;
  /** The recipe of the tree being indexed (spec section 5); null when there is none. */
  recipe: LoadedRecipe | null;
  /** The file's top-level statements (oxc ESTree), parsed once per run and shared by all adapters; null on a parse failure. */
  program(): Node[] | null;
}

export interface AdapterExtract<F> extends Partial<AdapterOutput> {
  /** Adapter-private per-file data for `link`. */
  facts?: F;
}

export interface AdapterLinkContext<F> {
  root: string;
  repo: string;
  workspaces: WorkspaceRecord[];
  /** The recipe of the tree being indexed; null when there is none. */
  recipe: LoadedRecipe | null;
  /** Every file this adapter extracted, in path order, with its facts (files without facts included). */
  files: { file: AdapterFileContext; facts: F | undefined }[];
  /** Nodes returned so far by every adapter (extract stage of all adapters, then earlier links), sorted by id. */
  nodes: readonly AdapterNode[];
  resolver: AdapterResolver;
  parsed: { get(fileId: string): ParsedFile | undefined };
  /** Any read file by id (also files outside this adapter's workspaces), e.g. to read a constant another file exports. */
  file(fileId: string): AdapterFileContext | undefined;
}

export interface Adapter<F = unknown> {
  id: string;
  appliesTo(ws: WorkspaceRecord, run: AdapterRunContext): boolean;
  /** Cheap check before `extract` (text or imports, never the AST; for example the framework's import name). Default: every file. */
  mayMatch?(file: AdapterFileContext): boolean;
  /** Test files (`*.test.*`, `*.spec.*`, `__tests__/`) are skipped unless this is true: test harness apps are not endpoints. */
  includeTests?: boolean;
  /** The languages whose files the adapter reads; default TypeScript only (Go files are the recipe adapter's alone). */
  languages?: readonly ("typescript" | "go")[];
  extract?(ctx: AdapterFileContext): AdapterExtract<F>;
  link?(ctx: AdapterLinkContext<F>): Partial<AdapterOutput>;
}

export interface AdapterRunContext {
  root: string;
  repo: string;
  workspaces: WorkspaceRecord[];
  files: AdapterFile[];
  parsed: { get(fileId: string): ParsedFile | undefined };
  resolver: AdapterResolver;
  /** The recipe of the tree being indexed (loaded by the indexer for the layer it indexes); null when there is none. */
  recipe?: LoadedRecipe | null;
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Workspace package name used inside node ids (spec section 6): the workspace id without `ws:`. */
export const wsName = (wsId: string): string => (wsId.startsWith("ws:") ? wsId.slice(3) : wsId);

export function hasDependency(ws: WorkspaceRecord, names: readonly string[]): boolean {
  return names.some((n) => ws.deps.includes(n) || ws.frameworks.includes(n));
}

function parseProgram(path: string, source: string): Node[] | null {
  try {
    const lang = path.endsWith("x") ? "tsx" : "ts";
    const r = parseSync(path, source, { sourceType: "module", lang, preserveParens: false });
    return nodeArray((r.program as unknown as { body?: unknown }).body);
  } catch {
    return null;
  }
}

/** Assigns `~2`, `~3` to repeated ids, in call order (the spec section 6 rule for symbols). */
export class IdAllocator {
  private readonly seen = new Map<string, number>();
  take(id: string): string {
    const n = (this.seen.get(id) ?? 0) + 1;
    this.seen.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  }
}

/** String value of a literal or an expression-free template literal; null otherwise. */
export function stringValue(n: unknown): string | null {
  const v = unwrap(n);
  if (!isNode(v)) return null;
  if (v.type === "Literal" && typeof v.value === "string") return v.value;
  if (v.type === "TemplateLiteral" && nodeArray(v.expressions).length === 0) {
    const q = nodeArray(v.quasis)[0];
    const cooked = (q?.value as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

/** Top-level `const NAME = "literal"` declarations of a program (exported or not). */
export function stringConstants(program: Node[] | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of program ?? []) {
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl) || decl.type !== "VariableDeclaration" || decl.kind !== "const") continue;
    for (const d of nodeArray(decl.declarations)) {
      const id = unwrap(d.id);
      const val = stringValue(d.init);
      if (isNode(id) && id.type === "Identifier" && val !== null) out.set(id.name as string, val);
    }
  }
  return out;
}

/** The symbol a local name refers to in a file: a symbol of the file, else an import followed through the resolver. */
export function symbolForName(
  pf: ParsedFile | undefined,
  fileId: string,
  name: string,
  resolver: AdapterResolver,
): string | null {
  if (!pf) return null;
  const local = pf.symbols.find((s) => s.name === name);
  if (local) return local.id;
  const imp = pf.imports.find((i) => i.local === name && i.local !== "");
  if (!imp || imp.imported === "*") return null;
  const target = resolver.resolveSpecifier(fileId, imp.specifier);
  return target.kind === "file" ? resolver.resolveSymbol(target.fileId, imp.imported) : null;
}

/** The innermost symbol whose body contains `offset`, else the file id (module-level code). */
export function enclosingSymbol(pf: ParsedFile | undefined, fileId: string, offset: number): string {
  let best: { id: string; size: number } | null = null;
  for (const [id, r] of pf?.bodies ?? []) {
    if (r.start <= offset && offset < r.end && (!best || r.end - r.start < best.size)) {
      best = { id, size: r.end - r.start };
    }
  }
  return best?.id ?? fileId;
}

export interface ChainCall {
  /** Method name (`handler`, `get`), or the callee identifier for the chain's first call (`createServerFn`). */
  name: string;
  args: unknown[];
  node: Node;
}

/**
 * Flattens a call chain `root(...).a(...).b(...)` (or `obj.a(...).b(...)`) into its calls, first call first.
 * `base` is what the chain starts on: the identifier or expression before the first member call (for
 * `app.get(...)` it is the `app` identifier, for `createServerFn().handler()` it is undefined and the first call is
 * `createServerFn`). Computed members end the chain.
 */
export function flattenChain(expr: unknown): { base: Node | undefined; calls: ChainCall[] } {
  const calls: ChainCall[] = [];
  let cur = unwrap(expr);
  for (let i = 0; i < 64 && isNode(cur); i++) {
    if (cur.type === "AwaitExpression") {
      cur = unwrap(cur.argument);
      continue;
    }
    if (cur.type !== "CallExpression") return { base: cur, calls: calls.reverse() };
    const args = Array.isArray(cur.arguments) ? (cur.arguments as unknown[]) : [];
    const callee = unwrap(cur.callee);
    if (!isNode(callee)) break;
    if (callee.type === "Identifier") {
      calls.push({ name: callee.name as string, args, node: cur });
      return { base: undefined, calls: calls.reverse() };
    }
    if (callee.type === "MemberExpression" && callee.computed !== true) {
      const p = callee.property;
      if (!isNode(p) || p.type !== "Identifier") break;
      calls.push({ name: p.name as string, args, node: cur });
      cur = unwrap(callee.object);
      continue;
    }
    break;
  }
  return { base: undefined, calls: [] };
}

/** 1-based line of a string offset. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** First and last line (1-based) of a node: the span of an inline handler (`data.handlerSpan` on endpoints). */
export function spanOf(source: string, n: Node): { start: number; end: number } {
  const start = lineOf(source, n.start);
  let end = start;
  for (let i = n.start; i < n.end - 1 && i < source.length; i++) if (source.charCodeAt(i) === 10) end++;
  return { start, end };
}

const edgeKeyOf = (e: EdgeRecord): string => `${e.src}\0${e.dst}\0${e.kind}`;

/** Runs the given adapters, in order, over the files and returns their nodes and edges, sorted and de-duplicated (see above). */
export function runAdapterList(ctx: AdapterRunContext, adapters: readonly Adapter<unknown>[]): AdapterOutput {
  const wsById = new Map(ctx.workspaces.map((w) => [w.id, w]));
  const files = [...ctx.files].sort((a, b) => cmp(a.path, b.path));
  const programs = new Map<string, Node[] | null>();
  const contexts = new Map<string, AdapterFileContext>();
  const contextOf = (f: AdapterFile): AdapterFileContext | undefined => {
    const ws = wsById.get(f.workspaceId);
    if (!ws) return undefined;
    let c = contexts.get(f.id);
    if (!c) {
      c = {
        repo: ctx.repo,
        fileId: f.id,
        path: f.path,
        ws,
        workspaces: ctx.workspaces,
        source: f.source,
        parsed: ctx.parsed.get(f.id),
        resolver: ctx.resolver,
        recipe: ctx.recipe ?? null,
        program: () => {
          if (!programs.has(f.id)) programs.set(f.id, parseProgram(f.path, f.source));
          return programs.get(f.id) ?? null;
        },
      };
      contexts.set(f.id, c);
    }
    return c;
  };
  const byId = new Map(files.map((f) => [f.id, f]));

  const nodes: AdapterNode[] = [];
  const edges: EdgeRecord[] = [];
  const perAdapter: { adapter: Adapter<unknown>; files: { file: AdapterFileContext; facts: unknown }[] }[] =
    [];
  for (const raw of adapters) {
    const adapter = raw as Adapter<unknown>;
    const wsIds = new Set(ctx.workspaces.filter((w) => adapter.appliesTo(w, ctx)).map((w) => w.id));
    const mine: { file: AdapterFileContext; facts: unknown }[] = [];
    if (wsIds.size > 0) {
      for (const f of files) {
        if (!wsIds.has(f.workspaceId)) continue;
        if (!(adapter.languages ?? ["typescript"]).includes(f.path.endsWith(".go") ? "go" : "typescript"))
          continue;
        if (!adapter.includeTests && isTestPath(f.path)) continue;
        const fc = contextOf(f);
        if (!fc) continue;
        if (adapter.mayMatch && !adapter.mayMatch(fc)) continue;
        const out = adapter.extract ? adapter.extract(fc) : {};
        nodes.push(...(out.nodes ?? []));
        edges.push(...(out.edges ?? []));
        mine.push({ file: fc, facts: out.facts });
      }
    }
    perAdapter.push({ adapter, files: mine });
  }
  for (const { adapter, files: mine } of perAdapter) {
    if (!adapter.link) continue;
    if (!ctx.workspaces.some((w) => adapter.appliesTo(w, ctx))) continue;
    // Sorted, and a node two adapters both found (the recipe and a built-in adapter) is seen once, as it is stored.
    const sorted: AdapterNode[] = [];
    for (const n of [...nodes].sort((a, b) => cmp(a.id, b.id) || cmp(a.fileId, b.fileId))) {
      if (sorted[sorted.length - 1]?.id !== n.id) sorted.push(n);
    }
    const out = adapter.link({
      root: ctx.root,
      repo: ctx.repo,
      workspaces: ctx.workspaces,
      recipe: ctx.recipe ?? null,
      files: mine,
      nodes: sorted,
      resolver: ctx.resolver,
      parsed: ctx.parsed,
      file: (id) => {
        const f = byId.get(id);
        return f ? contextOf(f) : undefined;
      },
    });
    nodes.push(...(out.nodes ?? []));
    edges.push(...(out.edges ?? []));
  }

  const seenNodes = new Set<string>();
  const outNodes: AdapterNode[] = [];
  for (const n of nodes.sort((a, b) => cmp(a.id, b.id) || cmp(a.fileId, b.fileId))) {
    if (seenNodes.has(n.id)) continue;
    seenNodes.add(n.id);
    outNodes.push(n);
  }
  const seenEdges = new Set<string>();
  const outEdges: EdgeRecord[] = [];
  for (const e of edges.sort(
    (a, b) => cmp(a.fileId, b.fileId) || cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind),
  )) {
    const k = edgeKeyOf(e);
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    outEdges.push(e);
  }
  return { nodes: outNodes, edges: outEdges };
}

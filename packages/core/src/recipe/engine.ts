import { Lang, parse, type SgNode } from "@ast-grep/napi";
import picomatch from "picomatch";
import {
  type AdapterFileContext,
  type AdapterNode,
  type AdapterOutput,
  enclosingSymbol,
  hasDependency,
  spanOf,
  stringValue,
  symbolForName,
} from "../adapters/framework.js";
import { fileIdOfSymId, routeId as makeRouteId, nameOfSymId, symKey } from "../ids.js";
import { isNode, type Node, nodeArray } from "../parse/ast.js";
import type { ParsedFile } from "../parse/index.js";
import type { WorkspaceRecord } from "../types.js";
import { callReturnKey, type ModelLike } from "./helpers/call-return.js";
import {
  makeReader,
  type PathContext,
  type PathExpr,
  pathContext,
  pathOf,
  pathsOf,
} from "./helpers/const-strings.js";
import { composeFileRoutes, ROUTE_ROOT_ID, type RouteFact, readOptions } from "./helpers/fs-routes.js";
import {
  type AppDecl,
  composeMountGraph,
  type MiddlewareSite,
  type Mount,
  type Registration,
} from "./helpers/mount-graph.js";
import { flowLinks, type ScopeParam, scopeParamOf } from "./helpers/param-flow.js";
import {
  enclosingParameter,
  functionName,
  isFunctionNode,
  parameterKey,
  parameterNames,
  parametersOf,
  routerKeyOfName,
} from "./helpers/resolve-names.js";
import { handlerLabel, isFnNode, parseExpr } from "./helpers/snippet.js";
import type { LoadedRecipe } from "./load.js";
import { isTsRule, type Recipe, type RecipeRule } from "./schema.js";

/**
 * The recipe engine (spec section 5). Rules are ast-grep rules, passed to `findAll` unchanged; each match is turned
 * into an emit (a router, a mount, an endpoint, a middleware, a route) and the generic helpers compose the emits into
 * full paths across files. Output is sorted and depends only on the recipe and the tree.
 */

// ---------------------------------------------------------------------------------------------------------
// Matching

const roots = new WeakMap<AdapterFileContext, SgNode | null>();

export const astLang = (path: string): Lang => (path.endsWith("x") ? Lang.Tsx : Lang.TypeScript);

/** The ast-grep root of a file (parsed once per file context); null when it does not parse. */
export function rootOf(file: AdapterFileContext): SgNode | null {
  if (!roots.has(file)) {
    try {
      roots.set(file, parse(astLang(file.path), file.source).root());
    } catch {
      roots.set(file, null);
    }
  }
  return roots.get(file) ?? null;
}

export interface RuleMatch {
  rule: RecipeRule;
  node: SgNode;
}

/**
 * A workspace passes a rule's `when`: it declares one of the dependencies, or (`viaWorkspaces`) depends on a
 * workspace of the repository that does.
 */
export function whenApplies(
  when: RecipeRule["when"],
  ws: WorkspaceRecord,
  workspaces: readonly WorkspaceRecord[],
): boolean {
  const deps = when?.dependency;
  if (!deps) return true;
  if (hasDependency(ws, deps)) return true;
  return (
    when.viaWorkspaces === true && workspaces.some((w) => ws.deps.includes(w.name) && hasDependency(w, deps))
  );
}

/** The rules that apply to a file: its workspace passes the rule's `when` (or the rule has none) and `files` match. */
export function rulesFor(
  recipe: Recipe,
  ws: WorkspaceRecord,
  path: string,
  workspaces: readonly WorkspaceRecord[] = [ws],
): RecipeRule[] {
  return recipe.rules.filter(isTsRule).filter((r) => {
    if (!whenApplies(r.when, ws, workspaces)) return false;
    return !r.files || picomatch.isMatch(path, r.files, { dot: true });
  });
}

/** Runs one rule over a tree; `error` is set when ast-grep rejects the rule. */
export function findRule(
  rule: Pick<RecipeRule, "rule" | "constraints">,
  root: SgNode,
): { nodes: SgNode[]; error?: string } {
  try {
    return { nodes: root.findAll({ rule: rule.rule, constraints: rule.constraints } as never) };
  } catch (err) {
    return { nodes: [], error: (err as Error).message.split("\n")[0] ?? "invalid rule" };
  }
}

export function matchRules(rules: readonly RecipeRule[], root: SgNode): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const rule of rules) for (const node of findRule(rule, root).nodes) out.push({ rule, node });
  return out;
}

export interface ExampleResult {
  passed: number;
  failed: string[];
  error?: string;
}

/** Checks a rule's examples: each `match` snippet gives at least one match, each `noMatch` snippet none. */
export function runExamples(rule: RecipeRule): ExampleResult {
  const res: ExampleResult = { passed: 0, failed: [] };
  const count = (snippet: string): number => {
    let best = 0;
    for (const lang of [Lang.TypeScript, Lang.Tsx]) {
      try {
        const r = findRule(rule, parse(lang, snippet).root());
        if (r.error) res.error ??= r.error;
        best = Math.max(best, r.nodes.length);
      } catch {
        // a snippet that does not parse in this language
      }
    }
    return best;
  };
  for (const s of rule.examples.match) {
    if (count(s) > 0) res.passed++;
    else res.failed.push(`match: no match in ${JSON.stringify(s)}`);
  }
  for (const s of rule.examples.noMatch) {
    if (count(s) === 0) res.passed++;
    else res.failed.push(`noMatch: matched ${JSON.stringify(s)}`);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// Per-file model

/** What `extract` keeps for a file: the tree and the matches of the rules that apply to it. */
export interface FileFacts extends ModelLike {
  matches: RuleMatch[];
}

export function matchFile(file: AdapterFileContext, recipe: LoadedRecipe | null): FileFacts | undefined {
  if (!recipe?.recipe) return undefined;
  const rules = rulesFor(recipe.recipe, file.ws, file.path, file.workspaces);
  if (rules.length === 0) return undefined;
  const root = rootOf(file);
  if (!root) return undefined;
  const matches = matchRules(rules, root);
  return matches.length > 0 ? { file, root, matches } : undefined;
}

const rk = (n: SgNode): string => {
  const r = n.range();
  return `${r.start.index}:${r.end.index}`;
};
const named = (n: SgNode): SgNode[] =>
  n.children().filter((c) => c.isNamed() && String(c.kind()) !== "comment");
const kindOf = (n: SgNode): string => String(n.kind());

function unparen(n: SgNode): SgNode {
  let x = n;
  while (kindOf(x) === "parenthesized_expression" || kindOf(x) === "non_null_expression") {
    const k = named(x)[0];
    if (!k) break;
    x = k;
  }
  return x;
}

/** `obj.method(...)`: the object, the method name, and the arguments; null for anything else. */
function memberCall(n: SgNode): { obj: SgNode; method: string; args: SgNode[] } | null {
  if (kindOf(n) !== "call_expression") return null;
  const fn = n.field("function");
  if (!fn || kindOf(fn) !== "member_expression") return null;
  const obj = fn.field("object");
  const prop = fn.field("property");
  if (!obj || !prop) return null;
  const a = n.field("arguments");
  return { obj, method: prop.text(), args: a ? named(a) : [] };
}

interface RouterSite {
  key: string;
  base?: PathExpr;
  node: SgNode;
  adapter?: string;
}

interface Analysis {
  sites: Map<string, RouterSite>;
  /** Name to router key for every router bound to a name in the file (any scope). */
  declared: Map<string, string>;
}

// ---------------------------------------------------------------------------------------------------------
// Applying a recipe

interface Env {
  recipe: Recipe;
  passthrough: ReadonlySet<string>;
  callReturn: boolean;
  paramFlow: boolean;
  /** Parameters used as a router by a registration or a mount: scope functions, found by `param-flow`. */
  scopeUses: Map<string, ScopeParam>;
  models: Map<string, FileFacts>;
  analyses: Map<string, Analysis>;
  fileOf: (fileId: string) => AdapterFileContext | undefined;
}

export const captureNodes = (m: RuleMatch, c: string | undefined): SgNode[] => {
  if (!c || c.startsWith("=")) return [];
  if (c.startsWith("$$$"))
    return m.node.getMultipleMatches(c.slice(3)).filter((x) => x.isNamed() && kindOf(x) !== "comment");
  const x = m.node.getMatch(c.slice(1));
  return x ? [x] : [];
};
export const captureNode = (m: RuleMatch, c: string | undefined): SgNode | undefined => captureNodes(m, c)[0];

function pathCtx(model: FileFacts, node: SgNode): PathContext {
  return pathContext(model.file, parameterNames(node));
}

function pathOfCapture(model: FileFacts, node: SgNode | undefined, more: boolean): PathExpr | null {
  if (!node) return null;
  const e = parseExpr(node.text());
  return e ? pathOf(pathCtx(model, node), e, more) : null;
}

function pathsOfCapture(model: FileFacts, node: SgNode | undefined): PathExpr[] {
  if (!node) return [];
  const e = parseExpr(node.text());
  return e ? pathsOf(pathCtx(model, node), e) : [];
}

/** Climbs chain calls whose method returns the same router, to the expression the router is bound to. */
function chainTop(env: Env, node: SgNode): SgNode {
  let n = node;
  for (let i = 0; i < 64; i++) {
    const p = n.parent();
    const gp = p?.parent();
    if (p && gp && kindOf(p) === "member_expression" && kindOf(gp) === "call_expression") {
      const obj = p.field("object");
      const callee = gp.field("function");
      const prop = p.field("property");
      if (
        obj &&
        callee &&
        prop &&
        rk(obj) === rk(n) &&
        rk(callee) === rk(p) &&
        env.passthrough.has(prop.text())
      ) {
        n = gp;
        continue;
      }
    }
    break;
  }
  return n;
}

function analysis(env: Env, model: FileFacts): Analysis {
  const hit = env.analyses.get(model.file.fileId);
  if (hit) return hit;
  const an: Analysis = { sites: new Map(), declared: new Map() };
  env.analyses.set(model.file.fileId, an);
  const path = model.file.path;
  for (const m of model.matches) {
    if (m.rule.emit.kind !== "router") continue;
    const top = chainTop(env, m.node);
    const parent = top.parent();
    let key: string | undefined;
    if (parent && kindOf(parent) === "variable_declarator") {
      const v = parent.field("value");
      const id = parent.field("name");
      if (v && id && kindOf(id) === "identifier" && rk(unparen(v)) === rk(top)) {
        key = symKey(path, id.text());
        an.declared.set(id.text(), key);
      }
    }
    if (
      !key &&
      parent &&
      kindOf(parent) === "export_statement" &&
      /^export\s+default\b/.test(parent.text())
    ) {
      key = symKey(path, "default");
    }
    key ??= symKey(path, `@${top.range().start.index}`);
    const emit = m.rule.emit;
    const base = emit.base ? (pathOfCapture(model, captureNode(m, emit.base), true) ?? undefined) : undefined;
    const prev = an.sites.get(rk(m.node));
    an.sites.set(rk(m.node), {
      key,
      node: m.node,
      ...(base ? { base } : prev?.base ? { base: prev.base } : {}),
      ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
    });
  }
  return an;
}

interface Receiver {
  key: string;
  /** Reached through a name, not through the constructor in the declaration chain. */
  ref: boolean;
  /** Base paths written in the chain between the router and the call, in order. */
  bases: PathExpr[];
}

function receiver(env: Env, model: FileFacts, node: SgNode, depth = 0): Receiver | null {
  if (depth > 6) return null;
  const an = analysis(env, model);
  let n = unparen(node);
  const bases: PathExpr[] = [];
  for (let i = 0; i < 64; i++) {
    const site = an.sites.get(rk(n));
    if (site?.base) bases.push(site.base);
    const mc = memberCall(n);
    if (mc && env.passthrough.has(mc.method)) {
      n = unparen(mc.obj);
      continue;
    }
    break;
  }
  bases.reverse();
  const site = an.sites.get(rk(n));
  if (site) return { key: site.key, ref: false, bases };
  const k = kindOf(n);
  if (k === "identifier") {
    const name = n.text();
    let key = routerKeyOfName(model.file, an.declared, name);
    if (!key && env.paramFlow) {
      // A parameter of the enclosing function: a router only when something mounts or passes one into it.
      const ep = enclosingParameter(n, name);
      const fnName = ep ? functionName(ep.fn) : undefined;
      if (ep && fnName) {
        key = parameterKey(model.file.path, ep.fn, ep.param);
        env.scopeUses.set(key, { key, fileId: model.file.fileId, fnName, index: ep.index });
      }
    }
    return key ? { key, ref: true, bases } : null;
  }
  if (k === "call_expression" && env.callReturn) {
    const key = callReturnKey(
      model,
      n,
      (id) => modelFor(env, id),
      (m, e) => receiver(env, m as FileFacts, e, depth + 1)?.key ?? null,
    );
    return key ? { key, ref: true, bases } : null;
  }
  return null;
}

function methodsOf(m: RuleMatch, c: string): string[] {
  if (c.startsWith("=")) return [c.slice(1).toUpperCase()];
  const n = captureNode(m, c);
  if (!n) return [];
  const e = parseExpr(n.text());
  const list =
    isNode(e) && e.type === "ArrayExpression"
      ? nodeArray(e.elements)
          .map((x) => stringValue(x))
          .filter((x): x is string => x !== null)
      : [stringValue(e) ?? n.text()];
  return list.map((x) => x.toUpperCase()).filter((x) => /^[A-Z]+$/.test(x));
}

interface HandlerInfo {
  handler: string;
  handlerSymbol: string | null;
  handlerSpan?: { start: number; end: number };
}

function handlerInfo(model: FileFacts, n: SgNode): HandlerInfo {
  const e = parseExpr(n.text());
  const handler = handlerLabel(e);
  if (isFnNode(e)) {
    const r = n.range();
    return {
      handler,
      handlerSymbol: enclosingSymbol(model.file.parsed, model.file.fileId, r.start.index),
      handlerSpan: spanOf(model.file.source, { type: "x", start: r.start.index, end: r.end.index } as Node),
    };
  }
  if (isNode(e) && e.type === "Identifier") {
    return {
      handler,
      handlerSymbol: symbolForName(
        model.file.parsed,
        model.file.fileId,
        e.name as string,
        model.file.resolver,
      ),
    };
  }
  return { handler, handlerSymbol: null };
}

export function applyRecipe(args: {
  root: string;
  repo: string;
  workspaces: readonly WorkspaceRecord[];
  recipe: LoadedRecipe | null;
  files: readonly { file: AdapterFileContext; facts: FileFacts | undefined }[];
  parsed: { get(fileId: string): ParsedFile | undefined };
  resolver: AdapterFileContext["resolver"];
  fileOf: (fileId: string) => AdapterFileContext | undefined;
}): AdapterOutput {
  const recipe = args.recipe?.recipe;
  if (!recipe) return { nodes: [], edges: [] };
  const models = new Map<string, FileFacts>();
  for (const f of args.files) if (f.facts) models.set(f.file.fileId, f.facts);
  const env: Env = {
    recipe,
    passthrough: new Set(recipe.passthrough ?? []),
    callReturn: recipe.helpers.includes("call-return"),
    paramFlow: recipe.helpers.includes("param-flow"),
    scopeUses: new Map(),
    models,
    analyses: new Map(),
    fileOf: args.fileOf,
  };
  const ordered = [...models.values()];

  const apps = new Map<string, AppDecl>();
  const registrations: Registration[] = [];
  const mounts: Mount[] = [];
  const middleware: MiddlewareSite[] = [];
  const routeFacts: RouteFact[] = [];
  const genericRoutes: { fact: RouteFact; routeId: string }[] = [];
  const scopes = new Map<string, ScopeParam>();

  const declareScope = (file: AdapterFileContext, key: string, sp?: ScopeParam): void => {
    if (!apps.has(key)) apps.set(key, { key, base: [], file, scope: true });
    if (sp) scopes.set(key, sp);
  };

  // Routers, in file order; the first declaration of a key keeps it.
  const declared = new Set<string>();
  for (const model of ordered) {
    const an = analysis(env, model);
    const mine = new Map<string, { base: [number, PathExpr][] }>();
    for (const s of an.sites.values()) {
      const e = mine.get(s.key) ?? { base: [] };
      if (s.base) e.base.push([s.node.range().end.index, s.base]);
      mine.set(s.key, e);
    }
    for (const [key, e] of mine) {
      if (declared.has(key)) continue;
      declared.add(key);
      apps.set(key, {
        key,
        base: e.base.sort((a, b) => a[0] - b[0]).map((b) => b[1]),
        file: model.file,
      });
    }
  }

  for (const model of ordered) {
    const claimed = new Set<string>();
    const lastPath = new Map<string, PathExpr>();
    // Source order, inner calls of a chain first; the recipe's rule order decides which rule claims a call two match.
    const sorted = [...model.matches];
    const ruleIndex = new Map(recipe.rules.map((r, i) => [r.id, i]));
    sorted.sort((a, b) => {
      const ra = a.node.range();
      const rb = b.node.range();
      return (
        ra.start.index - rb.start.index ||
        ra.end.index - rb.end.index ||
        (ruleIndex.get(a.rule.id) ?? 0) - (ruleIndex.get(b.rule.id) ?? 0)
      );
    });
    for (const m of sorted) {
      const emit = m.rule.emit;
      const line = m.node.range().start.line + 1;
      if (emit.kind === "mount") {
        if (claimed.has(`m${rk(m.node)}`)) continue;
        const parent = captureNode(m, emit.parent);
        const childNodes = captureNodes(m, emit.child);
        if (!parent || childNodes.length === 0) continue;
        const p = receiver(env, model, parent);
        if (!p) continue;
        let prefix: PathExpr | null = null;
        if (emit.prefix) {
          prefix = pathOfCapture(model, captureNode(m, emit.prefix), true);
          if (!prefix) continue;
        }
        for (const childNode of childNodes) {
          let child: string | null = null;
          if (emit.childIsScope) {
            const c = unparen(childNode);
            if (isFunctionNode(c)) {
              const prm = parametersOf(c)[0];
              if (prm) {
                child = parameterKey(model.file.path, c, prm);
                declareScope(model.file, child);
              }
            } else if (kindOf(c) === "identifier") {
              const sym = symbolForName(model.file.parsed, model.file.fileId, c.text(), model.file.resolver);
              const fileId = sym ? fileIdOfSymId(sym) : undefined;
              const name = sym ? nameOfSymId(sym) : undefined;
              const sp = fileId && name ? scopeParamOf((id) => modelFor(env, id), fileId, name) : null;
              if (sp) {
                child = sp.key;
                declareScope(args.fileOf(sp.fileId) ?? model.file, child, sp);
              }
            }
          } else {
            child = receiver(env, model, childNode)?.key ?? null;
          }
          if (!child) continue;
          claimed.add(`m${rk(m.node)}`);
          mounts.push({
            app: p.key,
            ref: p.ref,
            child,
            pieces: [...p.bases, ...(prefix ? [prefix] : [])],
            line,
            file: model.file,
          });
        }
      } else if (emit.kind === "endpoint") {
        if (claimed.has(`e${rk(m.node)}`)) continue;
        const recvNode = captureNode(m, emit.receiver);
        if (!recvNode) continue;
        const recv = receiver(env, model, recvNode);
        if (!recv) continue;
        const methods = methodsOf(m, emit.method);
        let handlers = captureNodes(m, emit.handler);
        const pathNode = captureNode(m, emit.path);
        let paths = pathNode ? pathsOfCapture(model, pathNode) : [];
        if (paths.length === 0 && emit.pathFromChain) {
          let prev: PathExpr | undefined;
          for (let n: SgNode | undefined = unparen(recvNode), i = 0; n && i < 64; i++) {
            prev = lastPath.get(rk(n));
            if (prev) break;
            const mc = memberCall(n);
            n = mc && env.passthrough.has(mc.method) ? unparen(mc.obj) : undefined;
          }
          if (prev) {
            paths = [prev];
            if (pathNode) handlers = [pathNode, ...handlers];
          }
        }
        if (paths.length === 0 || handlers.length === 0 || methods.length === 0) continue;
        const last = handlers[handlers.length - 1] as SgNode;
        const h = handlerInfo(model, last);
        const mws = handlers.slice(0, -1).map((x) => handlerLabel(parseExpr(x.text())));
        claimed.add(`e${rk(m.node)}`);
        lastPath.set(rk(m.node), paths[paths.length - 1] as PathExpr);
        for (const p of paths) {
          registrations.push({
            app: recv.key,
            ref: recv.ref,
            methods,
            pieces: [...recv.bases, p],
            ...h,
            middleware: mws,
            line,
            file: model.file,
            ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
          });
        }
      } else if (emit.kind === "middleware") {
        if (claimed.has(`w${rk(m.node)}`)) continue;
        const recvNode = captureNode(m, emit.receiver);
        if (!recvNode) continue;
        const recv = receiver(env, model, recvNode);
        if (!recv) continue;
        const handlers = captureNodes(m, emit.handler);
        const pathNode = captureNode(m, emit.path);
        const path: PathExpr | null = pathNode ? pathOfCapture(model, pathNode, handlers.length > 0) : ["*"];
        if (!path || handlers.length === 0) continue;
        claimed.add(`w${rk(m.node)}`);
        for (const hn of handlers) {
          middleware.push({
            app: recv.key,
            ref: recv.ref,
            pieces: [...recv.bases, path],
            label: handlerLabel(parseExpr(hn.text())),
            line,
            file: model.file,
            ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
          });
        }
      } else if (emit.kind === "route" || emit.kind === "fileRoute") {
        const idNode = captureNode(m, emit.id);
        const idExpr = idNode ? parseExpr(idNode.text()) : null;
        const idArg = idExpr ? (stringValue(idExpr) ?? undefined) : undefined;
        const optNode = captureNode(m, emit.options);
        const fact: RouteFact = {
          file: model.file,
          ...(idArg !== undefined ? { idArg } : {}),
          root: emit.root === true,
          options: readOptions(optNode ? parseExpr(optNode.text()) : null),
          ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
        };
        // The first route declaration of a file is the file's route.
        if (
          routeFacts.some((r) => r.file === model.file) ||
          genericRoutes.some((r) => r.fact.file === model.file)
        )
          continue;
        if (emit.kind === "fileRoute") routeFacts.push(fact);
        else if (idArg !== undefined || emit.root)
          genericRoutes.push({ fact, routeId: emit.root ? ROUTE_ROOT_ID : (idArg as string) });
      }
    }
  }

  // Parameters that receive a router through a call.
  if (env.paramFlow) {
    for (const [key, sp] of env.scopeUses) {
      const file = args.fileOf(sp.fileId);
      if (file) declareScope(file, key, sp);
    }
    const found = new Map<string, ScopeParam>(scopes);
    const flows = flowLinks(
      [...found.values()],
      ordered,
      (m, e) => receiver(env, m as FileFacts, e)?.key ?? null,
    );
    for (const f of flows) {
      mounts.push({ app: f.from, ref: true, child: f.to, pieces: [], line: f.line, file: f.file });
    }
  }

  const read = makeReader(args.fileOf);
  const out = composeMountGraph({ repo: args.repo, apps, registrations, mounts, middleware, read });
  const nodes: AdapterNode[] = [...out.nodes];
  const edges = [...out.edges];

  if (routeFacts.length > 0) {
    const r = composeFileRoutes({
      root: args.root,
      repo: args.repo,
      convention: "tanstack-router",
      workspaces: args.workspaces,
      facts: routeFacts,
      parsed: args.parsed,
      resolver: args.resolver,
    });
    nodes.push(...r.nodes);
    edges.push(...r.edges);
  }
  for (const { fact, routeId } of genericRoutes) {
    const wsn = fact.file.ws.id.startsWith("ws:") ? fact.file.ws.id.slice(3) : fact.file.ws.id;
    nodes.push({
      id: makeRouteId(args.repo, wsn, routeId),
      kind: "route",
      ws: fact.file.ws.id,
      label: routeId,
      fileId: fact.file.fileId,
      data: {
        ...(fact.adapter ? { adapter: fact.adapter } : {}),
        routeId,
        urlPath: routeId,
        path: fact.file.path,
        options: fact.options.keys,
        ...(fact.root ? { root: true } : {}),
        ...(fact.options.component ? { component: fact.options.component } : {}),
        ...(fact.options.loader ? { loader: fact.options.loader } : {}),
        ...(fact.options.beforeLoad ? { beforeLoad: fact.options.beforeLoad } : {}),
      },
    });
  }
  return { nodes, edges };
}

/** The model of a file; a file no rule matched in gets a model with no matches (its functions can still be read). */
function modelFor(env: Env, id: string): FileFacts | undefined {
  const hit = env.models.get(id);
  if (hit) return hit;
  const file = env.fileOf(id);
  const root = file ? rootOf(file) : null;
  return file && root ? { file, root, matches: [] } : undefined;
}

import type { SgNode } from "@ast-grep/napi";
import {
  type AdapterFileContext,
  type AdapterNode,
  type AdapterOutput,
  enclosingSymbol,
  spanOf,
} from "../adapters/framework.js";
import { fileIdOfSymId, nameOfSymId, symKey } from "../ids.js";
import type { Node } from "../parse/ast.js";
import {
  concatOperands,
  declsNamed,
  findGoDecl,
  type GoFacts,
  type GoRuleMatch,
  goParams,
  goRootOf,
  goStringValue,
  isGoFunction,
  isStringLiteral,
  kindOf,
  named,
  rangeKey,
  returnedExpressions,
  topLevelValues,
  unparen,
} from "./go.js";
import { makeReader, type PathExpr } from "./helpers/const-strings.js";
import {
  type AppDecl,
  composeMountGraph,
  type MiddlewareSite,
  type Mount,
  type Registration,
} from "./helpers/mount-graph.js";
import type { Recipe } from "./schema.js";

/**
 * Go routers, mounts, endpoints and middleware from a recipe (spec section 5). The same model as the TypeScript
 * rules: a `router` or a self-mounting `mount` match is a router, a name or an expression stands for the router it is
 * bound to, `mount` links a child router under a parent at a prefix, `endpoint` registers a handler on a router, and
 * `mount-graph` composes the prefix chain into full paths. No router, framework or driver name appears here.
 *
 * What a receiver can be: the matched expression itself, a variable declared with one (`r := ...`), an alias of a
 * router, a call chain through the recipe's `passthrough` methods, a call of a function that returns a router
 * (`call-return`), and a parameter that something mounts or passes a router into (`param-flow`, or a function that a
 * `childIsScope` mount names or writes inline).
 */

interface Site {
  key: string;
  base?: PathExpr;
  adapter?: string;
}

interface ScopeUse {
  key: string;
  fileId: string;
  /** Symbol id of the function declaration the parameter belongs to. */
  fnSym: string;
  index: number;
}

interface Receiver {
  key: string;
  ref: boolean;
  bases: PathExpr[];
}

export interface GoRoutesArgs {
  repo: string;
  recipe: Recipe | null;
  files: readonly { file: AdapterFileContext; facts: GoFacts | undefined }[];
  resolver: AdapterFileContext["resolver"];
  fileOf: (fileId: string) => AdapterFileContext | undefined;
}

const identKey = (file: AdapterFileContext, n: SgNode): string => `${file.fileId}\0${n.range().start.index}`;
const paramKeyOf = (file: AdapterFileContext, n: SgNode): string =>
  symKey(file.path, `@p${n.range().start.index}`);
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export function applyGoRoutes(args: GoRoutesArgs): AdapterOutput {
  const recipe = args.recipe;
  if (!recipe) return { nodes: [], edges: [] };
  const hasRouting = args.files.some((f) =>
    f.facts?.matches.some((m) => ["router", "mount", "endpoint", "middleware"].includes(m.rule.emit.kind)),
  );
  if (!hasRouting) return { nodes: [], edges: [] };
  return new GoRoutes(args, recipe).run();
}

class GoRoutes {
  private readonly passthrough: ReadonlySet<string>;
  private readonly callReturn: boolean;
  private readonly paramFlow: boolean;
  private readonly sites = new Map<string, Site>();
  private readonly models = new Map<string, GoFacts>();
  /** Parameters that a `childIsScope` mount opens (a function literal or a named function): `identKey` to key. */
  private readonly scopeParams = new Map<string, string>();
  private readonly scopeUses = new Map<string, ScopeUse>();
  /** Names of the functions with a router parameter that some call in the read files names. */
  private readonly calledNames = new Set<string>();
  private readonly consts = new Map<string, Map<string, SgNode>>();
  private readonly byDir = new Map<string, AdapterFileContext[]>();
  private readonly apps = new Map<string, AppDecl>();

  constructor(
    private readonly a: GoRoutesArgs,
    private readonly recipe: Recipe,
  ) {
    this.passthrough = new Set(recipe.passthrough ?? []);
    this.callReturn = recipe.helpers.includes("call-return");
    this.paramFlow = recipe.helpers.includes("param-flow");
    for (const { file, facts } of a.files) {
      if (facts) this.models.set(file.fileId, facts);
      const list = this.byDir.get(dirOf(file.path)) ?? [];
      list.push(file);
      this.byDir.set(dirOf(file.path), list);
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Captures

  private captureNodes(m: GoRuleMatch, c: string | undefined): SgNode[] {
    if (!c || c.startsWith("=")) return [];
    if (c.startsWith("$$$")) return m.node.getMultipleMatches(c.slice(3)).filter((x) => x.isNamed());
    const x = m.node.getMatch(c.slice(1));
    return x ? [x] : [];
  }
  private captureNode(m: GoRuleMatch, c: string | undefined): SgNode | undefined {
    return this.captureNodes(m, c)[0];
  }

  private siteAt(file: AdapterFileContext, n: SgNode): Site | undefined {
    return this.sites.get(`${file.fileId}\0${rangeKey(n)}`);
  }

  // ------------------------------------------------------------------------------------------------------
  // Constants and paths

  private rootOf(file: AdapterFileContext): SgNode | null {
    return goRootOf(file);
  }

  private constsOf(file: AdapterFileContext): Map<string, SgNode> {
    let c = this.consts.get(file.fileId);
    if (!c) {
      const root = this.rootOf(file);
      c = root ? topLevelValues(root) : new Map();
      this.consts.set(file.fileId, c);
    }
    return c;
  }

  /** The string a constant name stands for in this file or in another file of the same directory (the same package). */
  private constText(file: AdapterFileContext, node: SgNode, depth = 0): string | null {
    if (depth > 4) return null;
    let out = "";
    for (const op of concatOperands(node)) {
      if (isStringLiteral(op)) {
        out += goStringValue(op) ?? "";
        continue;
      }
      if (kindOf(op) !== "identifier") return null;
      let v: string | null = null;
      for (const f of [file, ...(this.byDir.get(dirOf(file.path)) ?? [])]) {
        const n = this.constsOf(f).get(op.text());
        if (n) {
          v = this.constText(f, n, depth + 1);
          break;
        }
      }
      if (v === null) return null;
      out += v;
    }
    return out;
  }

  private pathOf(file: AdapterFileContext, node: SgNode | undefined, more: boolean): PathExpr | null {
    if (!node) return null;
    const ops = concatOperands(node);
    const out: PathExpr = [];
    for (const op of ops) {
      const k = kindOf(op);
      if (isStringLiteral(op)) {
        out.push(goStringValue(op) ?? "");
        continue;
      }
      if (k === "identifier") {
        const v = this.constText(file, op);
        if (v !== null) {
          out.push(v);
          continue;
        }
        if (!more && ops.length === 1) return null;
        out.push({ name: op.text(), ...(findGoDecl(op, op.text())?.param ? { param: true as const } : {}) });
        continue;
      }
      if (k === "selector_expression" && (more || ops.length > 1)) {
        out.push({ name: op.text() });
        continue;
      }
      return null;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------------
  // Routers

  private selectorCall(n: SgNode): { operand: SgNode; name: string; args: SgNode[] } | null {
    if (kindOf(n) !== "call_expression") return null;
    const fn = n.field("function");
    if (!fn || kindOf(fn) !== "selector_expression") return null;
    const operand = fn.field("operand");
    const name = fn.field("field")?.text();
    if (!operand || !name) return null;
    const args = n.field("arguments");
    return { operand, name, args: args ? named(args) : [] };
  }

  private receiver(file: AdapterFileContext, node: SgNode, depth = 0): Receiver | null {
    if (depth > 6) return null;
    let n = unparen(node);
    const bases: PathExpr[] = [];
    for (let i = 0; i < 64; i++) {
      const site = this.siteAt(file, n);
      if (site) {
        if (site.base) bases.push(site.base);
        break;
      }
      const mc = this.selectorCall(n);
      if (mc && this.passthrough.has(mc.name)) {
        n = unparen(mc.operand);
        continue;
      }
      break;
    }
    bases.reverse();
    const site = this.siteAt(file, n);
    if (site) return { key: site.key, ref: false, bases };
    const k = kindOf(n);
    if (k === "identifier") {
      const key = this.keyOfIdentifier(file, n, depth);
      return key ? { key, ref: true, bases } : null;
    }
    if (k === "call_expression" && this.callReturn) {
      const key = this.keyOfCall(file, n, depth);
      return key ? { key, ref: true, bases } : null;
    }
    return null;
  }

  private keyOfIdentifier(file: AdapterFileContext, id: SgNode, depth: number): string | null {
    const decl = findGoDecl(id, id.text());
    if (!decl) return null;
    if (decl.param) {
      const pk = identKey(file, decl.ident);
      const key = paramKeyOf(file, decl.ident);
      const fn = decl.param.fn;
      if (this.scopeParams.has(pk)) return this.scopeParams.get(pk) as string;
      if (!this.paramFlow) return null;
      if (kindOf(fn) === "func_literal") return key;
      const fnSym = enclosingSymbol(file.parsed, file.fileId, fn.range().start.index);
      this.scopeUses.set(key, { key, fileId: file.fileId, fnSym, index: decl.param.index });
      return key;
    }
    if (!decl.value) return null;
    return this.receiver(file, decl.value, depth + 1)?.key ?? null;
  }

  /** The router a call of a function returns (`call-return`): the target is found by the Go resolver. */
  private keyOfCall(file: AdapterFileContext, call: SgNode, depth: number): string | null {
    const r = call.range();
    const sym = file.resolver.targetAt?.(file.fileId, r.start.index, r.end.index);
    if (!sym) return null;
    const target = this.declOf(sym);
    if (!target) return null;
    for (const e of returnedExpressions(target.decl)) {
      const rec = this.receiver(target.file, e, depth + 1);
      if (rec) return rec.key;
    }
    return null;
  }

  /** The declaration node of a function or method symbol, with the file it is in. */
  private declOf(sym: string): { file: AdapterFileContext; decl: SgNode } | null {
    const fileId = fileIdOfSymId(sym);
    const name = nameOfSymId(sym);
    const file = fileId ? this.a.fileOf(fileId) : undefined;
    const root = file ? this.rootOf(file) : null;
    if (!file || !root || !name) return null;
    const dot = name.indexOf(".");
    const bare = (dot >= 0 ? name.slice(dot + 1) : name).replace(/~\d+$/, "");
    const cands = declsNamed(root, bare);
    if (cands.length <= 1 || dot < 0) return cands[0] ? { file, decl: cands[0] } : null;
    const recvType = name.slice(0, dot);
    const hit = cands.find((d) => {
      const rt = d.field("receiver")?.text() ?? "";
      return new RegExp(`\\b${recvType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rt);
    });
    return hit ? { file, decl: hit } : null;
  }

  // ------------------------------------------------------------------------------------------------------
  // Handlers and methods

  private handlerInfo(
    file: AdapterFileContext,
    n: SgNode,
  ): { handler: string; handlerSymbol: string | null; handlerSpan?: { start: number; end: number } } {
    const x = unparen(n);
    const k = kindOf(x);
    const r = x.range();
    if (k === "func_literal") {
      return {
        handler: "inline",
        handlerSymbol: enclosingSymbol(file.parsed, file.fileId, r.start.index),
        handlerSpan: spanOf(file.source, { start: r.start.index, end: r.end.index } as Node),
      };
    }
    const sym =
      k === "call_expression" || k === "identifier" || k === "selector_expression"
        ? (file.resolver.targetAt?.(file.fileId, r.start.index, r.end.index) ?? null)
        : null;
    const label = k === "call_expression" ? (x.field("function")?.text() ?? x.text()) : x.text();
    return { handler: label.length > 80 ? "expression" : label, handlerSymbol: sym };
  }

  private methodOf(file: AdapterFileContext, m: GoRuleMatch, c: string): string | null {
    if (c.startsWith("=")) return c.slice(1).toUpperCase();
    const n = this.captureNode(m, c);
    if (!n) return null;
    const text = isStringLiteral(n) ? (goStringValue(n) ?? "") : n.text();
    // `pkg.MethodGet`: the constant's own name, without the package and the `Method` prefix.
    const last = text.replace(/^.*\./, "").replace(/^Method(?=[A-Z])/, "");
    const up = last.toUpperCase();
    return /^[A-Z]+$/.test(up) ? up : null;
  }

  // ------------------------------------------------------------------------------------------------------
  // Run

  run(): AdapterOutput {
    const { recipe } = this;
    const files = [...this.models.values()];
    const matchesOf = (kind: string): { facts: GoFacts; m: GoRuleMatch }[] => {
      const out: { facts: GoFacts; m: GoRuleMatch }[] = [];
      for (const facts of files)
        for (const m of facts.matches) if (m.rule.emit.kind === kind) out.push({ facts, m });
      return out;
    };
    const order = new Map(recipe.rules.map((r, i) => [r.id, i]));

    // 1. Router sites: a `router` match, and a `mount` match with no `child` (the match is the mounted router).
    for (const facts of files) {
      for (const m of facts.matches) {
        const emit = m.rule.emit;
        const self = emit.kind === "mount" && !emit.child;
        if (emit.kind !== "router" && !self) continue;
        const key = `${facts.file.fileId}\0${rangeKey(m.node)}`;
        const prev = this.sites.get(key);
        const base =
          emit.kind === "router" && emit.base
            ? (this.pathOf(facts.file, this.captureNode(m, emit.base), true) ?? undefined)
            : undefined;
        const site: Site = {
          key: symKey(facts.file.path, `@${m.node.range().start.index}`),
          ...(base ? { base } : prev?.base ? { base: prev.base } : {}),
          ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
        };
        this.sites.set(key, site);
        if (emit.kind === "router" && !this.apps.has(site.key)) {
          this.apps.set(site.key, { key: site.key, base: site.base ? [site.base] : [], file: facts.file });
        }
      }
    }

    // 2. Parameters that a scope mount opens.
    for (const { facts, m } of matchesOf("mount")) {
      const emit = m.rule.emit;
      if (emit.kind !== "mount" || !emit.childIsScope) continue;
      for (const c of this.captureNodes(m, emit.child)) {
        const scope = this.scopeOf(facts.file, c);
        if (scope) this.scopeParams.set(scope.pk, scope.key);
      }
    }

    // 3. Mounts, endpoints and middleware, in source order.
    const registrations: Registration[] = [];
    const mounts: Mount[] = [];
    const middleware: MiddlewareSite[] = [];
    for (const facts of files) {
      const file = facts.file;
      const sorted = [...facts.matches].sort(
        (x, y) =>
          x.node.range().start.index - y.node.range().start.index ||
          x.node.range().end.index - y.node.range().end.index ||
          (order.get(x.rule.id) ?? 0) - (order.get(y.rule.id) ?? 0),
      );
      const claimed = new Set<string>();
      for (const m of sorted) {
        const emit = m.rule.emit;
        const line = m.node.range().start.line + 1;
        const claim = `${emit.kind}${rangeKey(m.node)}`;
        if (emit.kind === "mount") {
          if (claimed.has(claim)) continue;
          const parentNode = this.captureNode(m, emit.parent);
          const p = parentNode ? this.receiver(file, parentNode) : null;
          if (!p) continue;
          let prefix: PathExpr | null = null;
          if (emit.prefix) {
            prefix = this.pathOf(file, this.captureNode(m, emit.prefix), true);
            if (!prefix) continue;
          }
          const children: string[] = [];
          if (!emit.child) {
            const site = this.siteAt(file, m.node);
            if (site) {
              children.push(site.key);
              if (!this.apps.has(site.key))
                this.apps.set(site.key, { key: site.key, base: [], file, scope: true });
            }
          } else {
            for (const c of this.captureNodes(m, emit.child)) {
              if (emit.childIsScope) {
                const scope = this.scopeOf(file, c);
                if (scope) {
                  this.apps.set(scope.key, { key: scope.key, base: [], file: scope.file, scope: true });
                  children.push(scope.key);
                }
              } else {
                const key = this.receiver(file, c)?.key;
                if (key) children.push(key);
              }
            }
          }
          for (const child of children) {
            claimed.add(claim);
            mounts.push({
              app: p.key,
              ref: p.ref,
              child,
              pieces: [...p.bases, ...(prefix ? [prefix] : [])],
              line,
              file,
            });
          }
        } else if (emit.kind === "endpoint") {
          if (claimed.has(claim)) continue;
          const recvNode = this.captureNode(m, emit.receiver);
          const recv = recvNode ? this.receiver(file, recvNode) : null;
          if (!recv) continue;
          const handlers = this.captureNodes(m, emit.handler);
          let path = this.pathOf(file, this.captureNode(m, emit.path), true);
          if (!path || handlers.length === 0) continue;
          let method = emit.method ? this.methodOf(file, m, emit.method) : null;
          if (emit.methodInPath) {
            const first = path[0];
            const mm = typeof first === "string" ? /^([A-Za-z]+)\s+(\S[\s\S]*)$/.exec(first) : null;
            if (mm) {
              method = (mm[1] as string).toUpperCase();
              path = [mm[2] as string, ...path.slice(1)];
            }
            method ??= "ALL";
          }
          if (!method) continue;
          const last = handlers[handlers.length - 1] as SgNode;
          const h = this.handlerInfo(file, last);
          claimed.add(claim);
          registrations.push({
            app: recv.key,
            ref: recv.ref,
            methods: [method],
            pieces: [...recv.bases, path],
            ...h,
            middleware: handlers.slice(0, -1).map((x) => this.handlerInfo(file, x).handler),
            line,
            file,
            ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
          });
        } else if (emit.kind === "middleware") {
          if (claimed.has(claim)) continue;
          const recvNode = this.captureNode(m, emit.receiver);
          const recv = recvNode ? this.receiver(file, recvNode) : null;
          if (!recv) continue;
          const handlers = this.captureNodes(m, emit.handler);
          const pathNode = this.captureNode(m, emit.path);
          const path: PathExpr | null = pathNode ? this.pathOf(file, pathNode, handlers.length > 0) : ["*"];
          if (!path || handlers.length === 0) continue;
          claimed.add(claim);
          for (const hn of handlers) {
            middleware.push({
              app: recv.key,
              ref: recv.ref,
              pieces: [...recv.bases, path],
              label: this.handlerInfo(file, hn).handler,
              line,
              file,
              ...(emit.data?.adapter ? { adapter: emit.data.adapter } : {}),
            });
          }
        }
      }
    }

    // 4. A router passed as an argument flows into the parameter of the function that takes it (`param-flow`). A
    // function that takes a router and is called nowhere in the read files registers at the paths it writes.
    if (this.paramFlow) {
      this.flows(mounts);
      for (const u of this.scopeUses.values()) {
        const name = (nameOfSymId(u.fnSym) ?? "").replace(/^.*\./, "").replace(/~\d+$/, "");
        if (this.calledNames.has(name) || mounts.some((m) => m.child === u.key)) continue;
        const home = this.a.fileOf(u.fileId);
        if (home) this.apps.set(u.key, { key: u.key, base: [], file: home });
      }
    }

    const out = composeMountGraph({
      repo: this.a.repo,
      apps: this.apps,
      registrations,
      mounts,
      middleware,
      read: makeReader(this.a.fileOf),
    });
    const nodes: AdapterNode[] = [...out.nodes];
    return { nodes, edges: [...out.edges] };
  }

  /** The first parameter that a function (a literal, or a named function) opens as a router. */
  private scopeOf(
    file: AdapterFileContext,
    c: SgNode,
  ): { pk: string; key: string; file: AdapterFileContext } | null {
    const x = unparen(c);
    let fnFile = file;
    let fn: SgNode | undefined;
    if (kindOf(x) === "func_literal") fn = x;
    else if (kindOf(x) === "identifier" || kindOf(x) === "selector_expression") {
      const r = x.range();
      const sym = file.resolver.targetAt?.(file.fileId, r.start.index, r.end.index);
      const target = sym ? this.declOf(sym) : null;
      if (target) {
        fn = target.decl;
        fnFile = target.file;
      }
    }
    const p = fn && isGoFunction(fn) ? goParams(fn)[0] : undefined;
    if (!p || kindOf(p) !== "identifier") return null;
    return { pk: identKey(fnFile, p), key: paramKeyOf(fnFile, p), file: fnFile };
  }

  private flows(mounts: Mount[]): void {
    const known = new Set<string>();
    for (let round = 0; round < 4; round++) {
      const before = this.scopeUses.size;
      const byName = new Map<string, ScopeUse[]>();
      for (const u of this.scopeUses.values()) {
        const name = (nameOfSymId(u.fnSym) ?? "").replace(/^.*\./, "").replace(/~\d+$/, "");
        byName.set(name, [...(byName.get(name) ?? []), u]);
      }
      if (byName.size === 0) return;
      for (const { file } of this.a.files) {
        const root = this.rootOf(file);
        if (!root) continue;
        for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
          const fn = call.field("function");
          const callee = fn
            ? kindOf(fn) === "identifier"
              ? fn.text()
              : kindOf(fn) === "selector_expression"
                ? fn.field("field")?.text()
                : undefined
            : undefined;
          const uses = callee ? byName.get(callee) : undefined;
          if (!uses) continue;
          if (callee) this.calledNames.add(callee);
          const r = call.range();
          const target = file.resolver.targetAt?.(file.fileId, r.start.index, r.end.index);
          if (!target) continue;
          const args = call.field("arguments");
          const list = args ? named(args) : [];
          for (const u of uses) {
            if (u.fnSym !== target) continue;
            const arg = list[u.index];
            const rec = arg ? this.receiver(file, arg) : null;
            if (!rec || rec.key === u.key) continue;
            const id = `${rec.key}\0${u.key}\0${file.fileId}\0${r.start.index}`;
            if (known.has(id)) continue;
            known.add(id);
            if (!this.apps.has(u.key)) {
              const home = this.a.fileOf(u.fileId) ?? file;
              this.apps.set(u.key, { key: u.key, base: [], file: home, scope: true });
            }
            mounts.push({
              app: rec.key,
              ref: rec.ref,
              child: u.key,
              pieces: [...rec.bases],
              line: r.start.line + 1,
              file,
            });
          }
        }
      }
      if (this.scopeUses.size === before) return;
    }
  }
}

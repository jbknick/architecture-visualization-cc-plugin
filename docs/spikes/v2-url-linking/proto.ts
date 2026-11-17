// Spike prototype (not production code): M11-style client-call to endpoint matching.
// Reads frontend files with oxc, evaluates each request call's URL to parts (literal text, a base URL, a
// parameter), maps the base to a repo through config, then matches method plus path segments against endpoints.
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";

type Node = { type: string; start: number; end: number } & Record<string, unknown>;
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
const kids = (n: Node): Node[] => {
  const out: Node[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === "parent") continue;
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) out.push(v);
  }
  return out;
};
const unwrapTs = (v: unknown): unknown => {
  let n = v;
  while (
    isNode(n) &&
    (n.type === "TSAsExpression" ||
      n.type === "TSNonNullExpression" ||
      n.type === "TSSatisfiesExpression" ||
      n.type === "ParenthesizedExpression" ||
      n.type === "AwaitExpression")
  )
    n = n.type === "AwaitExpression" ? n.argument : n.expression;
  return n;
};

/** A URL as parts: literal text, a base URL key (`env:NAME`, `url:<origin>`), a dynamic piece, or a wrapper parameter. */
export type Part = { lit: string } | { base: string; fallback?: string } | { param: true } | { ref: number };
export interface Endpoint {
  method: string;
  path: string;
  repo: string;
}
export interface BaseTarget {
  repo: string;
  /** Path prefix carried by the base URL value (`http://host/api` -> `/api`). */
  prefix?: string;
}
export interface LinkConfig {
  /** `env:VITE_API_URL`, `url:http://localhost:4000`, or `path:/api` (same-origin prefix, e.g. a dev proxy). */
  bases: Record<string, BaseTarget>;
  /** Infer wrapper functions (a function whose parameter flows into a request URL). */
  inferWrappers: boolean;
  /** Evaluate both branches of `cond ? a : b` URLs; link when the branches that match agree. */
  conditionals: boolean;
}
export interface CallResult {
  file: string;
  line: number;
  kind: string;
  method: string;
  url: string;
  dsts: string[];
  reason?:
    | "dynamic_url"
    | "external_url"
    | "unmapped_base"
    | "no_endpoint"
    | "ambiguous"
    | "wrapper_body"
    | "no_base";
  candidates?: string[];
}

interface Instance {
  lib: "axios" | "ky";
  base: Part[];
}
interface Wrapper {
  /** URL template with `{ref}` for the wrapper's own parameters. */
  url: Part[];
  /** Fixed method, or the index of a parameter holding the method, or the index of a fetch `init` parameter. */
  method: string | { arg: number } | { init: number };
  lib: "fetch" | "axios" | "ky";
}

type Value =
  | { k: "parts"; parts: Part[]; alts?: Part[][] }
  | { k: "obj"; props: Map<string, Value> }
  | { k: "instance"; inst: Instance }
  | { k: "wrapper"; w: Wrapper };

interface FileInfo {
  abs: string;
  rel: string;
  source: string;
  body: Node[];
  /** Top-level names: declarations of this file. */
  decls: Map<string, Node>;
  /** Imported local name -> [specifier, imported name]. */
  imports: Map<string, [string, string]>;
  /** Exported name -> local name, or a re-export [specifier, imported]. */
  exports: Map<string, string | [string, string]>;
  starFrom: string[];
  lines: number[];
}

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function linkCalls(files: { abs: string; rel: string }[], endpoints: Endpoint[], cfg: LinkConfig) {
  const resolver = new ResolverFactory({
    conditionNames: ["import", "types", "default"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js"],
    tsconfig: "auto",
    builtinModules: true,
  });
  const infos = new Map<string, FileInfo>();
  for (const f of files) infos.set(f.abs, readInfo(f.abs, f.rel));

  const resolveFile = (from: string, spec: string): string | null => {
    const r = resolver.resolveFileSync(from, spec);
    return r.path && infos.has(r.path) ? r.path : null;
  };
  /** The top-level declaration a name of a file refers to, following imports and re-exports. */
  const lookup = (abs: string, name: string, depth = 0): [FileInfo, Node] | null => {
    const fi = infos.get(abs);
    if (!fi || depth > 8) return null;
    const d = fi.decls.get(name);
    if (d) return [fi, d];
    const imp = fi.imports.get(name);
    if (imp) {
      const t = resolveFile(abs, imp[0]);
      return t ? lookupExport(t, imp[1], depth + 1) : null;
    }
    return null;
  };
  const lookupExport = (abs: string, name: string, depth: number): [FileInfo, Node] | null => {
    const fi = infos.get(abs);
    if (!fi || depth > 8) return null;
    const e = fi.exports.get(name);
    if (typeof e === "string") return lookup(abs, e, depth + 1);
    if (Array.isArray(e)) {
      const t = resolveFile(abs, e[0]);
      return t ? lookupExport(t, e[1], depth + 1) : null;
    }
    for (const s of fi.starFrom) {
      const t = resolveFile(abs, s);
      const r = t ? lookupExport(t, name, depth + 1) : null;
      if (r) return r;
    }
    return null;
  };

  const importedFrom = (fi: FileInfo, name: string, mod: string): boolean =>
    fi.imports.get(name)?.[0] === mod;
  const wrappers = new Map<Node, Wrapper>();
  const memo = new Map<Node, Value | null>();

  /** Value of a top-level declaration (const string, object, enum, client instance, wrapper function). */
  const declValue = (fi: FileInfo, d: Node): Value | null => {
    if (memo.has(d)) return memo.get(d) ?? null;
    memo.set(d, null);
    let v: Value | null = null;
    if (d.type === "TSEnumDeclaration") {
      const props = new Map<string, Value>();
      const members = (isNode(d.body) ? d.body.members : d.members) as Node[] | undefined;
      for (const m of members ?? []) {
        const id = m.id as Node;
        const key = (id.name ?? id.value) as string;
        const init = unwrapTs(m.initializer);
        if (isNode(init) && init.type === "Literal" && typeof init.value === "string")
          props.set(key, { k: "parts", parts: [{ lit: init.value }] });
      }
      v = { k: "obj", props };
    } else if (d.type === "VariableDeclarator") {
      const init = unwrapTs(d.init);
      if (isNode(init) && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
        const w = wrappers.get(init);
        v = w ? { k: "wrapper", w } : null;
      } else v = evalValue(fi, init, null);
    } else if (d.type === "FunctionDeclaration") {
      const w = wrappers.get(d);
      v = w ? { k: "wrapper", w } : null;
    }
    memo.set(d, v);
    return v;
  };

  interface Scope {
    params: Map<string, number>;
    locals: Map<string, unknown>;
    parent: Scope | null;
    /** The top-level function owning this scope chain (wrapper candidate). */
    top: Node;
  }
  const findLocal = (
    s: Scope | null,
    name: string,
  ): { param?: number; init?: unknown; top?: boolean } | null => {
    for (let c = s; c; c = c.parent) {
      if (c.locals.has(name)) return { init: c.locals.get(name) };
      if (c.params.has(name)) return c.parent === null ? { param: c.params.get(name), top: true } : {};
    }
    return null;
  };

  const evalValue = (fi: FileInfo, raw: unknown, scope: Scope | null): Value | null => {
    const n = unwrapTs(raw);
    if (!isNode(n)) return null;
    switch (n.type) {
      case "Literal":
        return typeof n.value === "string" ? { k: "parts", parts: [{ lit: n.value }] } : null;
      case "TemplateLiteral": {
        const quasis = n.quasis as Node[];
        const exprs = n.expressions as Node[];
        const parts: Part[] = [];
        quasis.forEach((q, i) => {
          const cooked = (q.value as { cooked?: string }).cooked ?? "";
          if (cooked) parts.push({ lit: cooked });
          if (i < exprs.length) {
            const v = evalValue(fi, exprs[i], scope);
            if (v?.k === "parts") parts.push(...v.parts);
            else parts.push({ param: true });
          }
        });
        return { k: "parts", parts };
      }
      case "BinaryExpression": {
        if (n.operator !== "+") return null;
        const a = evalValue(fi, n.left, scope);
        const b = evalValue(fi, n.right, scope);
        const pa = a?.k === "parts" ? a.parts : [{ param: true } as Part];
        const pb = b?.k === "parts" ? b.parts : [{ param: true } as Part];
        return { k: "parts", parts: [...pa, ...pb] };
      }
      case "ConditionalExpression": {
        if (!cfg.conditionals) return null;
        const a = evalValue(fi, n.consequent, scope);
        const b = evalValue(fi, n.alternate, scope);
        if (a?.k !== "parts" || b?.k !== "parts") return null;
        return { k: "parts", parts: a.parts, alts: [b.parts, ...(a.alts ?? []), ...(b.alts ?? [])] };
      }
      case "LogicalExpression": {
        const a = evalValue(fi, n.left, scope);
        if (a?.k === "parts" && a.parts.length === 1 && "base" in (a.parts[0] as Part)) {
          const b = evalValue(fi, n.right, scope);
          const lit =
            b?.k === "parts" && b.parts.length === 1 ? (b.parts[0] as { lit?: string }).lit : undefined;
          return lit ? { k: "parts", parts: [{ ...(a.parts[0] as { base: string }), fallback: lit }] } : a;
        }
        return a ?? evalValue(fi, n.right, scope);
      }
      case "MemberExpression": {
        const env = envName(n);
        if (env) return { k: "parts", parts: [{ base: `env:${env}` }] };
        if (n.computed === true) return null;
        const obj = evalValue(fi, n.object, scope);
        const key = (n.property as Node).name as string;
        return obj?.k === "obj" ? (obj.props.get(key) ?? null) : null;
      }
      case "ObjectExpression": {
        const props = new Map<string, Value>();
        for (const p of n.properties as Node[]) {
          if (p.type !== "Property" || p.computed === true) continue;
          const k = p.key as Node;
          const key = (k.name ?? k.value) as string;
          const v = evalValue(fi, p.value, scope);
          if (v) props.set(key, v);
        }
        return { k: "obj", props };
      }
      case "NewExpression": {
        // new URL(path, base): an absolute path drops the base's own path (URL resolution rules).
        const callee = n.callee as Node;
        if (callee.type !== "Identifier" || callee.name !== "URL") return null;
        const [p, b] = n.arguments as Node[];
        const pv = evalValue(fi, p, scope);
        if (pv?.k !== "parts") return null;
        if (!b) return pv;
        const bv = evalValue(fi, b, scope);
        if (bv?.k !== "parts") return null;
        const first = pv.parts[0] as { lit?: string } | undefined;
        if (first?.lit?.startsWith("/")) return { k: "parts", parts: [originOnly(bv.parts), ...pv.parts] };
        return { k: "parts", parts: [...bv.parts, { lit: "/" }, ...pv.parts] };
      }
      case "CallExpression": {
        const callee = unwrapTs(n.callee);
        if (!isNode(callee) || callee.type !== "MemberExpression") return null;
        const obj = unwrapTs(callee.object);
        const m = (callee.property as Node).name as string;
        if (!isNode(obj) || obj.type !== "Identifier") return null;
        const lib = fi.imports.get(obj.name as string)?.[0];
        const opts = evalValue(fi, (n.arguments as Node[])[0], scope);
        const props = opts?.k === "obj" ? opts.props : new Map<string, Value>();
        if (lib === "axios" && m === "create") {
          const b = props.get("baseURL");
          return { k: "instance", inst: { lib: "axios", base: b?.k === "parts" ? b.parts : [] } };
        }
        if (lib === "ky" && (m === "create" || m === "extend")) {
          const b = props.get("prefixUrl") ?? props.get("prefix");
          return { k: "instance", inst: { lib: "ky", base: b?.k === "parts" ? b.parts : [] } };
        }
        return null;
      }
      case "Identifier": {
        const name = n.name as string;
        const loc = findLocal(scope, name);
        if (loc) {
          if (loc.param !== undefined) return { k: "parts", parts: [{ ref: loc.param }] };
          if (loc.init !== undefined) return evalValue(fi, loc.init, scope);
          return null;
        }
        const hit = lookup(fi.abs, name);
        return hit ? declValue(hit[0], hit[1]) : null;
      }
    }
    return null;
  };

  // --- request calls ---------------------------------------------------------------------------
  interface Req {
    lib: "fetch" | "axios" | "ky" | "wrapper";
    url: Part[] | null;
    alts?: Part[][];
    method: string | { arg: number } | { init: number };
    inst?: Instance;
    wrapper?: Wrapper;
  }

  const methodFromOpts = (fi: FileInfo, raw: unknown, scope: Scope): string | { init: number } => {
    const n = unwrapTs(raw);
    if (isNode(n) && n.type === "Identifier") {
      const loc = findLocal(scope, n.name as string);
      if (loc?.param !== undefined) return { init: loc.param };
    }
    const v = evalValue(fi, raw, scope);
    const m = v?.k === "obj" ? v.props.get("method") : undefined;
    const lit = m?.k === "parts" && m.parts.length === 1 ? (m.parts[0] as { lit?: string }).lit : undefined;
    return lit ? lit.toUpperCase() : "GET";
  };
  /** `{ url, method }` config object (axios). */
  const fromConfig = (fi: FileInfo, raw: unknown, scope: Scope): Pick<Req, "url" | "method"> => {
    const o = unwrapTs(raw);
    let url: Part[] | null = null;
    let method: Req["method"] = "GET";
    if (isNode(o) && o.type === "ObjectExpression") {
      for (const p of o.properties as Node[]) {
        if (p.type !== "Property") continue;
        const key = ((p.key as Node).name ?? (p.key as Node).value) as string;
        const valNode = p.shorthand === true ? p.key : p.value;
        if (key === "url") {
          const v = evalValue(fi, valNode, scope);
          url = v?.k === "parts" ? v.parts : null;
        } else if (key === "method") {
          const v = evalValue(fi, valNode, scope);
          const part = v?.k === "parts" && v.parts.length === 1 ? v.parts[0] : undefined;
          if (part && "lit" in part) method = part.lit.toUpperCase();
          else if (part && "ref" in part) method = { arg: part.ref };
        }
      }
    }
    return { url, method };
  };

  const asParts = (fi: FileInfo, raw: unknown, scope: Scope): Part[] | null => {
    const v = evalValue(fi, raw, scope);
    return v?.k === "parts" ? v.parts : null;
  };
  const urlArg = (fi: FileInfo, raw: unknown, scope: Scope): Pick<Req, "url" | "alts"> => {
    const v = evalValue(fi, raw, scope);
    return v?.k === "parts" ? { url: v.parts, ...(v.alts ? { alts: v.alts } : {}) } : { url: null };
  };

  const requestOf = (fi: FileInfo, call: Node, scope: Scope): Req | null => {
    const callee = unwrapTs(call.callee);
    const args = call.arguments as Node[];
    if (!isNode(callee)) return null;
    if (callee.type === "Identifier") {
      const name = callee.name as string;
      if (name === "fetch" && !findLocal(scope, name)) {
        return { lib: "fetch", ...urlArg(fi, args[0], scope), method: methodFromOpts(fi, args[1], scope) };
      }
      if (importedFrom(fi, name, "axios")) return { lib: "axios", ...fromConfig(fi, args[0], scope) };
      const v = evalValue(fi, callee, scope);
      if (v?.k === "instance") return { lib: v.inst.lib, inst: v.inst, ...fromConfig(fi, args[0], scope) };
      if (v?.k === "wrapper") return { lib: "wrapper", wrapper: v.w, url: null, method: "GET" };
      return null;
    }
    if (callee.type !== "MemberExpression" || callee.computed === true) return null;
    const m = (callee.property as Node).name as string;
    const obj = unwrapTs(callee.object);
    if (!isNode(obj)) return null;
    let inst: Instance | undefined;
    let lib: Req["lib"] | null = null;
    if (
      obj.type === "Identifier" &&
      ["window", "globalThis", "self"].includes(obj.name as string) &&
      m === "fetch"
    )
      return { lib: "fetch", ...urlArg(fi, args[0], scope), method: methodFromOpts(fi, args[1], scope) };
    if (obj.type === "Identifier" && importedFrom(fi, obj.name as string, "axios")) lib = "axios";
    else if (obj.type === "Identifier" && importedFrom(fi, obj.name as string, "ky")) lib = "ky";
    else {
      const v = evalValue(fi, obj, scope);
      if (v?.k === "instance") {
        inst = v.inst;
        lib = v.inst.lib;
      }
    }
    if (!lib) return null;
    if (HTTP_VERBS.has(m)) return { lib, inst, ...urlArg(fi, args[0], scope), method: m.toUpperCase() };
    if (m === "request") return { lib, inst, ...fromConfig(fi, args[0], scope) };
    return null;
  };

  /** Full URL parts of a request: the instance base joined the way the library joins it. */
  const fullUrl = (r: Req, url: Part[] | null = r.url): Part[] | null => {
    if (!url) return null;
    if (!r.inst || r.inst.base.length === 0) return url;
    const first = url[0] as { lit?: string } | undefined;
    if (first?.lit && /^[a-z][a-z0-9+.-]*:\/\//i.test(first.lit)) return url;
    // axios combineURLs and ky prefixUrl both join base + "/" + relative input.
    return [...r.inst.base, { lit: "/" }, ...url];
  };

  const results: CallResult[] = [];
  const pending: { fi: FileInfo; call: Node; scope: Scope; req: Req }[] = [];

  const walkFile = (fi: FileInfo, collect: boolean) => {
    const visit = (n: Node, scope: Scope | null) => {
      let s = scope;
      if (
        n.type === "FunctionDeclaration" ||
        n.type === "ArrowFunctionExpression" ||
        n.type === "FunctionExpression"
      ) {
        const params = new Map<string, number>();
        (n.params as Node[]).forEach((p, i) => {
          const id = p.type === "AssignmentPattern" ? (p.left as Node) : p;
          if (id.type === "Identifier") params.set(id.name as string, i);
        });
        s = { params, locals: new Map(), parent: scope, top: scope ? scope.top : n };
      }
      if (n.type === "VariableDeclarator" && s && isNode(n.id) && n.id.type === "Identifier")
        s.locals.set(n.id.name as string, n.init);
      if (n.type === "CallExpression" && s) {
        const req = requestOf(fi, n, s);
        if (req) {
          if (req.lib !== "wrapper") {
            const url = fullUrl(req);
            const usesRef = leadsWithRef(url);
            const m = req.method;
            if (cfg.inferWrappers && url && (usesRef || typeof m !== "string")) {
              if (!wrappers.has(s.top)) {
                wrappers.set(s.top, { url, method: m, lib: req.lib });
                memo.clear();
              }
            }
          }
          if (collect) pending.push({ fi, call: n, scope: s, req });
        }
      }
      for (const c of kids(n)) visit(c, s);
    };
    for (const st of fi.body) visit(st, null);
  };
  // Wrapper inference to a fixpoint (wrappers of wrappers), then the collecting pass.
  for (let i = 0; i < 4; i++) for (const fi of infos.values()) walkFile(fi, false);
  for (const fi of infos.values()) walkFile(fi, true);

  for (const { fi, call, scope, req } of pending) {
    const line = lineOf(fi, call.start);
    const kind = req.lib === "wrapper" ? "wrapper" : req.inst ? `${req.lib}-instance` : req.lib;
    let url: Part[] | null;
    let method: string;
    if (req.lib === "wrapper" && req.wrapper) {
      const w = req.wrapper;
      const args = call.arguments as Node[];
      const argParts = (i: number): Part[] => asParts(fi, args[i], scope) ?? [{ param: true }];
      url = [];
      for (const p of w.url) {
        if ("ref" in p) url.push(...argParts(p.ref));
        else url.push(p);
      }
      if (typeof w.method === "string") method = w.method;
      else if ("arg" in w.method) {
        const a = argParts(w.method.arg)[0] as { lit?: string };
        method = a?.lit?.toUpperCase() ?? "GET";
      } else {
        const mm = methodFromOpts(fi, args[w.method.init], scope);
        method = typeof mm === "string" ? mm : "GET";
      }
    } else {
      url = fullUrl(req);
      method = typeof req.method === "string" ? req.method : "?";
      if (leadsWithRef(url) || typeof req.method !== "string") {
        if (cfg.inferWrappers && wrappers.has(scope.top)) {
          results.push({
            file: fi.rel,
            line,
            kind,
            method,
            url: show(url),
            dsts: [],
            reason: "wrapper_body",
          });
          continue;
        }
      }
    }
    const branches = [url, ...(req.lib === "wrapper" ? [] : (req.alts ?? []).map((a) => fullUrl(req, a)))];
    const matched = branches.map((b) => match(b, method, endpoints, cfg));
    const linked = [...new Set(matched.flatMap((m) => (m.dsts.length === 1 ? m.dsts : [])))];
    const first = matched[0] as ReturnType<typeof match>;
    if (branches.length > 1 && linked.length === 1) {
      results.push({
        file: fi.rel,
        line,
        kind,
        method,
        url: matched.map((m) => m.url).join(" | "),
        dsts: linked,
      });
    } else if (linked.length > 1) {
      results.push({
        file: fi.rel,
        line,
        kind,
        method,
        url: first.url,
        dsts: [],
        reason: "ambiguous",
        candidates: linked,
      });
    } else results.push({ file: fi.rel, line, kind, method, ...first });
  }
  return results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * A function is a wrapper when one of its parameters supplies the path itself (the first piece after the base URL)
 * or the method. A parameter that only fills a segment (`/users/${id}`) makes an ordinary call with a `:param`.
 */
function leadsWithRef(url: Part[] | null): boolean {
  for (const p of url ?? []) {
    if ("base" in p) continue;
    if ("lit" in p) {
      if (/^\/*$/.test(p.lit)) continue;
      return false;
    }
    return "ref" in p;
  }
  return false;
}

function envName(n: Node): string | null {
  // process.env.X, import.meta.env.X
  if (n.type !== "MemberExpression" || n.computed === true) return null;
  const obj = n.object as Node;
  if (obj.type !== "MemberExpression") return null;
  const envKey = (obj.property as Node).name;
  if (envKey !== "env") return null;
  const root = obj.object as Node;
  const isProcess = root.type === "Identifier" && root.name === "process";
  const isMeta = root.type === "MetaProperty";
  return isProcess || isMeta ? ((n.property as Node).name as string) : null;
}

function originOnly(parts: Part[]): Part {
  const first = parts[0];
  if (first && "base" in first)
    return {
      base: first.base,
      ...(first.fallback ? { fallback: first.fallback } : {}),
      origin: true,
    } as Part;
  if (first && "lit" in first) {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(first.lit);
    if (m) return { lit: m[1] as string };
  }
  return { param: true };
}

const show = (parts: Part[] | null): string =>
  parts === null
    ? "<dynamic>"
    : parts
        .map((p) => ("lit" in p ? p.lit : "base" in p ? `{${p.base}}` : "ref" in p ? `{arg${p.ref}}` : "{*}"))
        .join("");

const DYN = "\u0000";
function match(
  url: Part[] | null,
  method: string,
  endpoints: Endpoint[],
  cfg: LinkConfig,
): Omit<CallResult, "file" | "line" | "kind" | "method"> {
  const label = show(url);
  if (!url || url.length === 0) return { url: label, dsts: [], reason: "dynamic_url" };
  const first = url[0] as Part;
  let repo: string | null = null;
  let rest: Part[] = url;
  let prefix = "";
  if ("base" in first) {
    const t = cfg.bases[first.base] ?? (first.fallback ? baseForUrl(first.fallback, cfg) : undefined);
    if (!t) return { url: label, dsts: [], reason: "unmapped_base" };
    repo = t.repo;
    prefix = (first as { origin?: boolean }).origin ? "" : (t.prefix ?? "");
    rest = url.slice(1);
  } else if ("lit" in first && /^[a-z][a-z0-9+.-]*:\/\//i.test(first.lit)) {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i.exec(first.lit) as RegExpExecArray;
    const t = baseForUrl(m[1] as string, cfg);
    if (!t) return { url: label, dsts: [], reason: "external_url" };
    repo = t.repo;
    prefix = t.prefix ?? "";
    rest = [{ lit: m[2] as string }, ...url.slice(1)];
  } else if (!("lit" in first)) return { url: label, dsts: [], reason: "dynamic_url" };
  let path = prefix;
  for (const p of rest) path += "lit" in p ? p.lit : DYN;
  path = path.replace(/[?#].*$/, "").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/$/, "");
  if (repo === null) {
    // Same-origin relative path: a `path:` prefix in config names the repo (dev proxy), else every repo is a candidate.
    const hit = Object.entries(cfg.bases)
      .filter(([k]) => k.startsWith("path:") && path.startsWith(k.slice(5)))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) repo = hit[1].repo;
  }
  const segs = path.split("/");
  let best = Number.POSITIVE_INFINITY;
  let cands: Endpoint[] = [];
  for (const ep of endpoints) {
    if (repo !== null && ep.repo !== repo) continue;
    if (ep.method !== method && ep.method !== "ALL") continue;
    const es = ep.path.split("/");
    if (es.length !== segs.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < es.length; i++) {
      const e = es[i] as string;
      const c = segs[i] as string;
      const wild = /^[:$]|^\{.*\}$|^\[.*\]$/.test(e);
      if (c === DYN) score += wild ? 1 : 100;
      else if (wild) score += 1;
      else if (c !== e) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (score < best) {
      best = score;
      cands = [ep];
    } else if (score === best) cands.push(ep);
  }
  const shown = path.replaceAll(DYN, ":*");
  const ids = cands.map((c) => `${c.method} ${c.path} @${c.repo}`).sort();
  if (cands.length === 0) return { url: shown, dsts: [], reason: "no_endpoint" };
  if (best >= 100 || cands.length > 1) return { url: shown, dsts: [], reason: "ambiguous", candidates: ids };
  return { url: shown, dsts: ids, ...(repo === null ? { reason: "no_base" as const } : {}) };
}

function baseForUrl(u: string, cfg: LinkConfig): BaseTarget | undefined {
  const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(u)?.[1];
  return origin ? cfg.bases[`url:${origin}`] : undefined;
}

function lineOf(fi: FileInfo, offset: number): number {
  let lo = 0;
  let hi = fi.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((fi.lines[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function readInfo(abs: string, rel: string): FileInfo {
  const source = readFileSync(abs, "utf8");
  const r = parseSync(abs, source, { sourceType: "module", lang: abs.endsWith("x") ? "tsx" : "ts" });
  const body = ((r.program as unknown as { body: unknown[] }).body ?? []).filter(isNode);
  const fi: FileInfo = {
    abs,
    rel,
    source,
    body,
    decls: new Map(),
    imports: new Map(),
    exports: new Map(),
    starFrom: [],
    lines: [0],
  };
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) fi.lines.push(i + 1);
  const declare = (d: unknown, exported: boolean) => {
    if (!isNode(d)) return;
    const names: [string, Node][] = [];
    if (d.type === "VariableDeclaration") {
      for (const v of d.declarations as Node[]) {
        const id = v.id as Node;
        if (id.type === "Identifier") names.push([id.name as string, v]);
      }
    } else if (
      (d.type === "FunctionDeclaration" || d.type === "TSEnumDeclaration" || d.type === "ClassDeclaration") &&
      isNode(d.id)
    ) {
      names.push([d.id.name as string, d]);
    }
    for (const [n, node] of names) {
      fi.decls.set(n, node);
      if (exported) fi.exports.set(n, n);
    }
  };
  for (const st of body) {
    if (st.type === "ImportDeclaration") {
      const spec = (st.source as Node).value as string;
      for (const s of (st.specifiers as Node[]) ?? []) {
        const local = (s.local as Node).name as string;
        const imported =
          s.type === "ImportDefaultSpecifier"
            ? "default"
            : s.type === "ImportNamespaceSpecifier"
              ? "*"
              : (((s.imported as Node).name ?? (s.imported as Node).value) as string);
        fi.imports.set(local, [spec, imported]);
      }
    } else if (st.type === "ExportNamedDeclaration") {
      if (st.declaration) declare(st.declaration, true);
      const from = isNode(st.source) ? (st.source.value as string) : null;
      for (const s of (st.specifiers as Node[]) ?? []) {
        const local = ((s.local as Node).name ?? (s.local as Node).value) as string;
        const exported = ((s.exported as Node).name ?? (s.exported as Node).value) as string;
        fi.exports.set(exported, from ? [from, local] : local);
      }
    } else if (st.type === "ExportAllDeclaration" && !st.exported) {
      fi.starFrom.push((st.source as Node).value as string);
    } else if (st.type === "ExportDefaultDeclaration") {
      const d = st.declaration as Node;
      if (d.type === "Identifier") fi.exports.set("default", d.name as string);
      else {
        declare(d, false);
        if (isNode(d.id)) fi.exports.set("default", d.id.name as string);
      }
    } else declare(st, false);
  }
  return fi;
}

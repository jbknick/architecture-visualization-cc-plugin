// Spike v2-go-calls: call edges from syntax alone (tree-sitter Go via ast-grep) vs go/packages type-checked truth.
// Usage: pnpm tsx docs/spikes/v2-go/calls.ts <repo-root> <truth.json>
//
// Resolution is what an indexer can do with no Go toolchain: package-level indexes per directory, import paths
// mapped through go.mod, and a small local type inference (receiver, parameters, `x := T{}`, `&T{}`, `new(T)`,
// `x := NewT()` with a declared result type, `var x T`, `x.(T)`, struct field chains with embedding). Local
// scopes are flattened per top-level function: the nearest preceding declaration of a name wins.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { classify, listGoFiles, parseGo, readModule } from "./lib.js";

const [root, truthPath] = process.argv.slice(2);
if (!root || !truthPath) throw new Error("usage: calls.ts <repo-root> <truth.json>");

const BUILTINS = new Set(
  "append cap clear close complex copy delete imag len make max min new panic print println real recover".split(
    " ",
  ),
);
const PREDECLARED_TYPES = new Set(
  "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr".split(
    " ",
  ),
);

interface TypeRef {
  pkg: string;
  name: string;
}
interface TypeNode {
  node: SgNode;
  ctx: FileCtx;
}
interface TypeInfo {
  kind: "struct" | "interface" | "alias" | "other";
  ctx: FileCtx;
  fields: Map<string, SgNode>;
  embedded: SgNode[];
  ifaceMethods: Map<string, SgNode | null>;
  ifaceEmbeds: SgNode[];
  target?: SgNode;
}
interface FuncInfo {
  results: TypeNode[];
}
interface Pkg {
  path: string;
  name: string;
  funcs: Map<string, FuncInfo>;
  types: Map<string, TypeInfo>;
  methods: Map<string, FuncInfo>;
  vars: Map<string, { type: SgNode | null; value: SgNode | null; ctx: FileCtx }>;
}
interface FileCtx {
  file: string;
  root: SgNode;
  imports: Map<string, string>;
  pkg: Pkg;
}

const module = readModule(root);
const files = classify(listGoFiles(root)).sources;
// Nested modules (another go.mod below the root) are separate modules: skip them, as go/packages does.
const nested = execFileSync("git", ["ls-files", "*go.mod"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith("/go.mod"))
  .map((f) => f.slice(0, -"/go.mod".length));
const inNested = (f: string): boolean => nested.some((d) => f.startsWith(`${d}/`));

const dirOf = (f: string): string => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");
const pkgPathOf = (dir: string): string => (dir === "." ? module : `${module}/${dir}`);
const isRepoPath = (p: string): boolean => p === module || p.startsWith(`${module}/`);

const pkgs = new Map<string, Pkg>();
const ctxs: FileCtx[] = [];
const tParse0 = performance.now();
for (const f of files) {
  if (inNested(f)) continue;
  const src = readFileSync(join(root, f), "utf8");
  const tree = parseGo(src);
  const name =
    tree.find({ rule: { kind: "package_identifier", inside: { kind: "package_clause" } } })?.text() ?? "?";
  const path = pkgPathOf(dirOf(f));
  let pkg = pkgs.get(path);
  if (!pkg) {
    pkg = { path, name, funcs: new Map(), types: new Map(), methods: new Map(), vars: new Map() };
    pkgs.set(path, pkg);
  }
  ctxs.push({ file: f, root: tree, imports: new Map(), pkg });
}
const parseMs = performance.now() - tParse0;

const t0 = performance.now();
// Default import names: in-repo from the package clause of the target dir, external from the path.
function defaultName(path: string): string {
  const p = pkgs.get(path);
  if (p) return p.name;
  const parts = path.split("/");
  let last = parts[parts.length - 1] as string;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] as string;
  last = last
    .replace(/\.v\d+$/, "")
    .replace(/^go-/, "")
    .replace(/-go$/, "")
    .replace(/[.-]/g, "_");
  return last;
}

const resultsOf = (decl: SgNode, ctx: FileCtx): TypeNode[] => {
  const r = decl.field("result" as never);
  if (!r) return [];
  if (r.kind() !== "parameter_list") return [{ node: r, ctx }];
  const out: TypeNode[] = [];
  for (const p of r.namedChildren()) {
    const t = p.field("type" as never);
    if (!t) continue;
    const names = p.fieldChildren("name" as never).filter((n) => n.kind() === "identifier").length;
    for (let i = 0; i < Math.max(1, names); i++) out.push({ node: t, ctx });
  }
  return out;
};

const specsOf = (n: SgNode, kinds: Set<string>, into: SgNode[] = []): SgNode[] => {
  for (const c of n.namedChildren()) {
    if (kinds.has(c.kind())) into.push(c);
    else if (c.kind().endsWith("_list")) specsOf(c, kinds, into);
  }
  return into;
};

function baseOfType(n: SgNode | null): SgNode | null {
  let cur = n;
  while (cur) {
    const k = cur.kind();
    if (k === "pointer_type" || k === "parenthesized_type") cur = cur.namedChildren()[0] ?? null;
    else if (k === "generic_type") cur = cur.field("type" as never);
    else return cur;
  }
  return null;
}

for (const ctx of ctxs) {
  for (const d of ctx.root.namedChildren()) {
    const k = d.kind();
    if (k === "import_declaration") {
      for (const s of specsOf(d, new Set(["import_spec"]))) {
        const path =
          s
            .field("path" as never)
            ?.text()
            .replace(/^["`]|["`]$/g, "") ?? "";
        const alias = s.field("name" as never)?.text();
        if (alias === "_" || alias === ".") continue;
        ctx.imports.set(alias ?? "", path);
      }
    } else if (k === "function_declaration") {
      const n = d.field("name" as never)?.text();
      if (n) ctx.pkg.funcs.set(n, { results: resultsOf(d, ctx) });
    } else if (k === "method_declaration") {
      const n = d.field("name" as never)?.text();
      const p = d.field("receiver" as never)?.namedChildren()[0];
      const recv = baseOfType(p?.field("type" as never) ?? null)?.text();
      if (n && recv) ctx.pkg.methods.set(`${recv}.${n}`, { results: resultsOf(d, ctx) });
    } else if (k === "type_declaration") {
      for (const s of specsOf(d, new Set(["type_spec", "type_alias"]))) {
        const n = s.field("name" as never)?.text();
        const t = s.field("type" as never);
        if (!n || !t) continue;
        const info: TypeInfo = {
          kind: s.kind() === "type_alias" ? "alias" : "other",
          ctx,
          fields: new Map(),
          embedded: [],
          ifaceMethods: new Map(),
          ifaceEmbeds: [],
          target: t,
        };
        if (info.kind !== "alias" && t.kind() === "struct_type") {
          info.kind = "struct";
          for (const fd of t.findAll({ rule: { kind: "field_declaration" } })) {
            if (fd.parent()?.parent()?.id() !== t.id()) continue;
            const ft = fd.field("type" as never);
            const names = fd.fieldChildren("name" as never).filter((x) => x.kind() === "field_identifier");
            if (!ft) continue;
            if (names.length === 0) info.embedded.push(ft);
            for (const nm of names) info.fields.set(nm.text(), ft);
          }
        } else if (info.kind !== "alias" && t.kind() === "interface_type") {
          info.kind = "interface";
          for (const c of t.namedChildren()) {
            if (c.kind() === "method_elem") {
              const nm = c.field("name" as never)?.text();
              if (nm) info.ifaceMethods.set(nm, c.field("result" as never));
            } else if (c.kind() === "type_elem") {
              const e = c.namedChildren()[0];
              if (e) info.ifaceEmbeds.push(e);
            }
          }
        }
        ctx.pkg.types.set(n, info);
      }
    } else if (k === "var_declaration") {
      for (const s of specsOf(d, new Set(["var_spec"]))) {
        const names = s.fieldChildren("name" as never).filter((x) => x.kind() === "identifier");
        const values = s.field("value" as never)?.namedChildren() ?? [];
        names.forEach((nm, i) => {
          ctx.pkg.vars.set(nm.text(), {
            type: s.field("type" as never),
            value: values.length === names.length ? (values[i] ?? null) : null,
            ctx,
          });
        });
      }
    }
  }
  for (const [alias, path] of [...ctx.imports]) {
    if (alias === "") {
      ctx.imports.delete("");
      ctx.imports.set(defaultName(path), path);
    }
  }
}
// Re-add unaliased imports whose default name needed every package to be read first.
for (const ctx of ctxs) {
  const fixed = new Map<string, string>();
  for (const d of ctx.root.namedChildren()) {
    if (d.kind() !== "import_declaration") continue;
    for (const s of specsOf(d, new Set(["import_spec"]))) {
      const path =
        s
          .field("path" as never)
          ?.text()
          .replace(/^["`]|["`]$/g, "") ?? "";
      const alias = s.field("name" as never)?.text();
      if (alias === "_" || alias === ".") continue;
      fixed.set(alias ?? defaultName(path), path);
    }
  }
  ctx.imports = fixed;
}

// --- types ------------------------------------------------------------------------------------

function resolveType(t: TypeNode | null, depth = 0): TypeRef | null {
  if (!t || depth > 8) return null;
  const b = baseOfType(t.node);
  if (!b) return null;
  if (b.kind() === "type_identifier") {
    const name = b.text();
    if (!t.ctx.pkg.types.has(name) && PREDECLARED_TYPES.has(name)) return null;
    return { pkg: t.ctx.pkg.path, name };
  }
  if (b.kind() === "qualified_type") {
    const alias = b.field("package" as never)?.text() ?? "";
    const name = b.field("name" as never)?.text() ?? "";
    const path = t.ctx.imports.get(alias);
    return path ? { pkg: path, name } : null;
  }
  return null;
}

interface Local {
  pos: number;
  thunk: () => TypeRef | null;
}
type Scope = Map<string, Local[]>;

function lookupLocal(scope: Scope, name: string, pos: number): Local | null {
  let best: Local | null = null;
  for (const l of scope.get(name) ?? []) if (l.pos <= pos && (!best || l.pos > best.pos)) best = l;
  return best;
}

const typeInfo = (r: TypeRef): TypeInfo | undefined => pkgs.get(r.pkg)?.types.get(r.name);

/** Follow aliases (`type A = B`) to the named type. */
function canon(r: TypeRef | null, depth = 0): TypeRef | null {
  if (!r || depth > 8) return r;
  const ti = typeInfo(r);
  if (ti?.kind === "alias" && ti.target)
    return canon(resolveType({ node: ti.target, ctx: ti.ctx }), depth + 1);
  return r;
}

function fieldType(r: TypeRef, name: string, depth = 0): TypeRef | null {
  const c = canon(r);
  if (!c || depth > 4) return null;
  const ti = typeInfo(c);
  if (ti?.kind !== "struct") return null;
  const f = ti.fields.get(name);
  if (f) return resolveType({ node: f, ctx: ti.ctx });
  for (const e of ti.embedded) {
    const er = resolveType({ node: e, ctx: ti.ctx });
    if (er && baseName(er) === name) return er;
    const sub = er ? fieldType(er, name, depth + 1) : null;
    if (sub) return sub;
  }
  return null;
}
const baseName = (r: TypeRef): string => r.name;

interface MethodHit {
  kind: "method" | "interface-method" | "func-field";
  key: string;
  results: TypeNode[];
}

function lookupMethod(r: TypeRef, m: string, depth = 0, viaStruct = false): MethodHit | null {
  const c = canon(r);
  if (!c || depth > 5) return null;
  const pkg = pkgs.get(c.pkg);
  if (!pkg) return null;
  const own = pkg.methods.get(`${c.name}.${m}`);
  if (own) return { kind: "method", key: `${c.pkg}.${c.name}.${m}`, results: own.results };
  const ti = pkg.types.get(c.name);
  if (!ti) return null;
  if (ti.kind === "interface") {
    const hit = ifaceHas(c, m, 0);
    // Through a struct embedding, go/types reports the promoted method on the declaring interface.
    // go/types keys a direct interface call by the receiver's interface, and a call promoted through a struct
    // embedding by the interface that declares the method.
    if (hit && viaStruct) return { kind: "method", key: hit.key, results: hit.results };
    if (hit) return { kind: "interface-method", key: `${c.pkg}.${c.name}.${m}`, results: hit.results };
    return null;
  }
  if (ti.kind === "struct") {
    if (ti.fields.has(m)) return { kind: "func-field", key: "", results: [] };
    for (const e of ti.embedded) {
      const er = resolveType({ node: e, ctx: ti.ctx });
      const sub = er ? lookupMethod(er, m, depth + 1, true) : null;
      if (sub) return sub;
    }
  }
  return null;
}

/** Interface method lookup; the key names the interface that declares the method (embedded ones included). */
function ifaceHas(r: TypeRef, m: string, depth: number): { key: string; results: TypeNode[] } | null {
  const c = canon(r);
  if (!c || depth > 5) return null;
  const ti = typeInfo(c);
  if (ti?.kind !== "interface") return null;
  if (ti.ifaceMethods.has(m)) {
    const res = ti.ifaceMethods.get(m);
    return {
      key: `${c.pkg}.${c.name}.${m}`,
      results: res && res.kind() !== "parameter_list" ? [{ node: res, ctx: ti.ctx }] : [],
    };
  }
  for (const e of ti.ifaceEmbeds) {
    const hit = ifaceHas(resolveType({ node: e, ctx: ti.ctx }) ?? { pkg: "", name: "" }, m, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// --- expressions ------------------------------------------------------------------------------

interface Env {
  ctx: FileCtx;
  scope: Scope;
}

const unparen = (n: SgNode | null): SgNode | null => {
  let cur = n;
  while (cur && cur.kind() === "parenthesized_expression") cur = cur.namedChildren()[0] ?? null;
  return cur;
};

function typeOf(e: SgNode | null, env: Env, idx = 0, depth = 0): TypeRef | null {
  const x = unparen(e);
  if (!x || depth > 12) return null;
  switch (x.kind()) {
    case "identifier": {
      const l = lookupLocal(env.scope, x.text(), x.range().start.index);
      if (l) return l.thunk();
      const v = env.ctx.pkg.vars.get(x.text());
      if (!v) return null;
      if (v.type) return resolveType({ node: v.type, ctx: v.ctx });
      return v.value ? typeOf(v.value, { ctx: v.ctx, scope: new Map() }, 0, depth + 1) : null;
    }
    case "unary_expression": {
      const op = x.field("operator" as never)?.text();
      if (op === "&" || op === "*") return typeOf(x.field("operand" as never), env, 0, depth + 1);
      return null;
    }
    case "composite_literal":
      return resolveType({ node: x.field("type" as never) as SgNode, ctx: env.ctx });
    case "type_assertion_expression":
      return resolveType({ node: x.field("type" as never) as SgNode, ctx: env.ctx });
    case "selector_expression": {
      const op = unparen(x.field("operand" as never));
      const f = x.field("field" as never)?.text() ?? "";
      if (op?.kind() === "identifier" && !lookupLocal(env.scope, op.text(), op.range().start.index)) {
        const path = env.ctx.imports.get(op.text());
        if (path) {
          const v = pkgs.get(path)?.vars.get(f);
          if (!v) return null;
          if (v.type) return resolveType({ node: v.type, ctx: v.ctx });
          return v.value ? typeOf(v.value, { ctx: v.ctx, scope: new Map() }, 0, depth + 1) : null;
        }
      }
      const t = typeOf(op, env, 0, depth + 1);
      return t ? fieldType(t, f) : null;
    }
    case "call_expression": {
      const fn = unparen(x.field("function" as never));
      if (fn?.kind() === "identifier" && (fn.text() === "new" || fn.text() === "make")) {
        const a = x.field("arguments" as never)?.namedChildren()[0];
        return a ? resolveType({ node: a, ctx: env.ctx }) : null;
      }
      const r = resolveCall(x, env, depth + 1);
      const res = r.results[idx];
      return res ? resolveType(res) : r.conversion ? r.conversion : null;
    }
    case "type_conversion_expression": {
      const r = resolveCall(x, env, depth + 1);
      const res = r.results[idx];
      return res ? resolveType(res) : resolveType({ node: x.field("type" as never) as SgNode, ctx: env.ctx });
    }
  }
  return null;
}

interface Resolved {
  kind: string;
  key: string;
  inRepo: boolean;
  results: TypeNode[];
  conversion?: TypeRef | null;
  name: string;
  line: number;
}

function resolveCall(call: SgNode, env: Env, depth = 0): Resolved {
  let fn = unparen(
    call.kind() === "type_conversion_expression"
      ? call.field("type" as never)
      : call.field("function" as never),
  );
  while (fn && (fn.kind() === "index_expression" || fn.kind() === "generic_type")) {
    fn = unparen(fn.kind() === "index_expression" ? fn.field("operand" as never) : fn.field("type" as never));
  }
  const base = { key: "", inRepo: false, results: [] as TypeNode[] };
  if (!fn) return { ...base, kind: "other", name: "", line: call.range().start.line + 1 };
  const line = fn.range().start.line + 1;
  if (fn.kind() === "identifier" || fn.kind() === "type_identifier") {
    const name = fn.text();
    const at = { name, line: fn.range().start.line + 1 };
    if (lookupLocal(env.scope, name, fn.range().start.index)) return { ...base, ...at, kind: "local" };
    const f = env.ctx.pkg.funcs.get(name);
    if (f)
      return {
        kind: "same-package",
        key: `${env.ctx.pkg.path}.${name}`,
        inRepo: true,
        results: f.results,
        ...at,
      };
    if (env.ctx.pkg.types.has(name))
      return { ...base, ...at, kind: "conversion", conversion: { pkg: env.ctx.pkg.path, name } };
    if (BUILTINS.has(name)) return { ...base, ...at, kind: "builtin" };
    return { ...base, ...at, kind: PREDECLARED_TYPES.has(name) ? "conversion" : "unresolved" };
  }
  if (fn.kind() === "selector_expression" || fn.kind() === "qualified_type") {
    const isQ = fn.kind() === "qualified_type";
    const op = unparen(isQ ? fn.field("package" as never) : fn.field("operand" as never));
    const nameNode = isQ ? fn.field("name" as never) : fn.field("field" as never);
    const name = nameNode?.text() ?? "";
    const at = { name, line: (nameNode ?? fn).range().start.line + 1 };
    if (
      op &&
      (op.kind() === "identifier" || op.kind() === "package_identifier") &&
      !lookupLocal(env.scope, op.text(), op.range().start.index)
    ) {
      const path = env.ctx.imports.get(op.text());
      if (path) {
        const p = pkgs.get(path);
        if (!p) return { ...base, ...at, kind: "external-func", key: `${path}.${name}` };
        if (p.types.has(name)) return { ...base, ...at, kind: "conversion", conversion: { pkg: path, name } };
        const f = p.funcs.get(name);
        if (f)
          return { kind: "pkg-qualified", key: `${path}.${name}`, inRepo: true, results: f.results, ...at };
        return { ...base, ...at, kind: "unresolved" };
      }
    }
    const t = canon(typeOf(op, env, 0, depth + 1));
    if (!t) return { ...base, ...at, kind: "unresolved-receiver" };
    if (!isRepoPath(t.pkg)) return { ...base, ...at, kind: "external-method" };
    const hit = lookupMethod(t, name);
    if (!hit) return { ...base, ...at, kind: "unresolved-method" };
    if (hit.kind === "func-field") return { ...base, ...at, kind: "func-field" };
    return { kind: hit.kind, key: hit.key, inRepo: true, results: hit.results, ...at };
  }
  return { ...base, kind: "other", name: "", line };
}

// --- per-function scopes ----------------------------------------------------------------------

const DECL_KINDS = [
  "parameter_declaration",
  "variadic_parameter_declaration",
  "short_var_declaration",
  "var_spec",
  "const_spec",
  "range_clause",
  "receive_statement",
  "type_switch_statement",
];

function buildScope(fd: SgNode, ctx: FileCtx): Scope {
  const scope: Scope = new Map();
  const env: Env = { ctx, scope };
  const add = (name: string, pos: number, thunk: () => TypeRef | null): void => {
    if (name === "_") return;
    let memo: TypeRef | null | undefined;
    let busy = false;
    const l: Local = {
      pos,
      thunk: () => {
        if (memo !== undefined) return memo;
        if (busy) return null;
        busy = true;
        memo = thunk();
        busy = false;
        return memo;
      },
    };
    const list = scope.get(name) ?? [];
    list.push(l);
    scope.set(name, list);
  };
  const ids = (n: SgNode | null): SgNode[] =>
    n ? n.namedChildren().filter((c) => c.kind() === "identifier") : [];
  for (const d of fd.findAll({ rule: { any: DECL_KINDS.map((kind) => ({ kind })) } })) {
    const k = d.kind();
    const pos = d.range().start.index;
    if (k === "parameter_declaration") {
      const t = d.field("type" as never);
      for (const n of d.fieldChildren("name" as never)) {
        if (n.kind() === "identifier") add(n.text(), pos, () => (t ? resolveType({ node: t, ctx }) : null));
      }
    } else if (k === "variadic_parameter_declaration") {
      for (const n of d.fieldChildren("name" as never)) add(n.text(), pos, () => null);
    } else if (k === "short_var_declaration" || k === "var_spec" || k === "const_spec") {
      const left =
        k === "short_var_declaration"
          ? ids(d.field("left" as never))
          : d.fieldChildren("name" as never).filter((n) => n.kind() === "identifier");
      const t = k === "short_var_declaration" ? null : d.field("type" as never);
      const rightNode = k === "short_var_declaration" ? d.field("right" as never) : d.field("value" as never);
      const right = rightNode?.namedChildren() ?? [];
      left.forEach((n, i) => {
        add(n.text(), pos, () => {
          if (t) return resolveType({ node: t, ctx });
          if (right.length === left.length) return typeOf(right[i] ?? null, env, 0);
          if (right.length === 1) return typeOf(right[0] ?? null, env, i);
          return null;
        });
      });
    } else if (k === "range_clause" || k === "receive_statement") {
      for (const n of ids(d.field("left" as never))) add(n.text(), pos, () => null);
    } else if (k === "type_switch_statement") {
      for (const n of ids(d.field("alias" as never))) add(n.text(), pos, () => null);
    }
  }
  return scope;
}

// --- run --------------------------------------------------------------------------------------

interface TruthCall {
  file: string;
  line: number;
  name: string;
  caller: string;
  kind: string;
  callee?: string;
  inRepo: boolean;
}
interface Truth {
  calls: TruthCall[];
  callFiles: string[];
  implementers: Record<string, string[]>;
}
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
const callFiles = new Set(truth.callFiles);

interface SynCall extends Resolved {
  file: string;
  caller: string;
}
const syn: SynCall[] = [];
for (const ctx of ctxs) {
  if (!callFiles.has(ctx.file)) continue;
  for (const fd of ctx.root.namedChildren()) {
    if (fd.kind() !== "function_declaration" && fd.kind() !== "method_declaration") continue;
    const body = fd.field("body" as never);
    if (!body) continue;
    let caller = fd.field("name" as never)?.text() ?? "?";
    if (fd.kind() === "method_declaration") {
      const p = fd.field("receiver" as never)?.namedChildren()[0];
      caller = `${baseOfType(p?.field("type" as never) ?? null)?.text() ?? "?"}.${caller}`;
    }
    const env: Env = { ctx, scope: buildScope(fd, ctx) };
    const calls = body.findAll({
      rule: {
        any: [
          { kind: "call_expression" },
          { kind: "type_conversion_expression", has: { field: "type", kind: "generic_type" } },
        ],
      },
    });
    for (const c of calls) syn.push({ ...resolveCall(c, env), file: ctx.file, caller });
  }
}
const resolveMs = performance.now() - t0;

// Pair sites by file, line and callee name, in order.
const siteKey = (c: { file: string; line: number; name: string }): string => `${c.file}|${c.line}|${c.name}`;
const synBySite = new Map<string, SynCall[]>();
for (const s of syn) {
  const list = synBySite.get(siteKey(s)) ?? [];
  list.push(s);
  synBySite.set(siteKey(s), list);
}
const used = new Map<string, number>();
type Row = { n: number; correct: number; wrongKey: number; missed: number; unmatchedSite: number };
const byKind: Record<string, Row> = {};
const missReasons: Record<string, Record<string, number>> = {};
const missSamples: string[] = [];
let predicted = 0;
let predictedCorrect = 0;
const fpByTruthKind: Record<string, number> = {};
const truthEdges = new Set<string>();
const synEdges = new Set<string>();
const ifaceSites = { n: 0, implEdges: 0, noImpl: 0 };
for (const t of truth.calls) {
  if (!callFiles.has(t.file)) continue;
  const k = siteKey(t);
  const i = used.get(k) ?? 0;
  used.set(k, i + 1);
  const s = synBySite.get(k)?.[i];
  const inScope = t.inRepo && !!t.callee;
  const kind = t.kind === "method-promoted" ? "method-promoted" : t.kind;
  if (inScope) {
    const row = byKind[kind] ?? { n: 0, correct: 0, wrongKey: 0, missed: 0, unmatchedSite: 0 };
    byKind[kind] = row;
    row.n++;
    truthEdges.add(`${t.file.slice(0, t.file.lastIndexOf("/") + 1)}|${t.caller}|${t.callee}`);
    if (!s) row.unmatchedSite++;
    else if (s.inRepo && s.key === t.callee) row.correct++;
    else if (s.inRepo && s.key) row.wrongKey++;
    else {
      row.missed++;
      const mr = missReasons[kind] ?? {};
      missReasons[kind] = mr;
      mr[s.kind] = (mr[s.kind] ?? 0) + 1;
      if (missSamples.length < 400) missSamples.push(`${t.file}:${t.line} ${t.name} ${kind} -> ${s.kind}`);
    }
    if (t.kind === "interface-method") {
      ifaceSites.n++;
      const iface = t.callee.slice(0, t.callee.lastIndexOf("."));
      const impls = truth.implementers[iface] ?? [];
      ifaceSites.implEdges += impls.length;
      if (impls.length === 0) ifaceSites.noImpl++;
    }
  }
  if (s?.inRepo && s.key) {
    predicted++;
    synEdges.add(`${s.file.slice(0, s.file.lastIndexOf("/") + 1)}|${s.caller}|${s.key}`);
    if (inScope && s.key === t.callee) predictedCorrect++;
    else
      fpByTruthKind[t.kind + (t.inRepo ? "" : " (not in repo)")] =
        (fpByTruthKind[t.kind + (t.inRepo ? "" : " (not in repo)")] ?? 0) + 1;
  }
}
// Interface satisfaction by method names only (no signatures): does it approximate go/types Implements?
function ifaceNames(r: TypeRef, depth = 0): Set<string> | null {
  const c = canon(r);
  const ti = c ? typeInfo(c) : undefined;
  if (!c || !ti || ti.kind !== "interface" || depth > 5) return null;
  const out = new Set(ti.ifaceMethods.keys());
  for (const e of ti.ifaceEmbeds) {
    const er = resolveType({ node: e, ctx: ti.ctx });
    const sub = er ? ifaceNames(er, depth + 1) : null;
    if (!sub) return null; // embeds an interface outside the repo (or a constraint): names unknown
    for (const n of sub) out.add(n);
  }
  return out;
}
function methodNames(r: TypeRef, depth = 0): Set<string> {
  const out = new Set<string>();
  const c = canon(r);
  const pkg = c ? pkgs.get(c.pkg) : undefined;
  if (!c || !pkg || depth > 5) return out;
  for (const k of pkg.methods.keys()) if (k.startsWith(`${c.name}.`)) out.add(k.slice(c.name.length + 1));
  const ti = pkg.types.get(c.name);
  if (ti?.kind === "struct") {
    for (const e of ti.embedded) {
      const er = resolveType({ node: e, ctx: ti.ctx });
      if (!er) continue;
      const sub =
        typeInfo(er)?.kind === "interface"
          ? (ifaceNames(er) ?? new Set<string>())
          : methodNames(er, depth + 1);
      for (const n of sub) out.add(n);
    }
  }
  return out;
}
const sat = { truthPairs: 0, predPairs: 0, tp: 0, ifaces: 0, ifacesUnknown: 0 };
{
  const concretes: TypeRef[] = [];
  for (const p of pkgs.values()) {
    for (const [name, ti] of p.types)
      if (ti.kind !== "interface" && ti.kind !== "alias") concretes.push({ pkg: p.path, name });
  }
  const names = new Map(concretes.map((c) => [`${c.pkg}.${c.name}`, methodNames(c)]));
  for (const [iface, impls] of Object.entries(truth.implementers)) {
    sat.ifaces++;
    sat.truthPairs += impls.length;
    const dot = iface.lastIndexOf(".");
    const want = ifaceNames({ pkg: iface.slice(0, dot), name: iface.slice(dot + 1) });
    if (!want) {
      sat.ifacesUnknown++;
      continue;
    }
    const truthSet = new Set(impls);
    for (const [k, have] of names) {
      if (want.size > 0 && [...want].every((m) => have.has(m))) {
        sat.predPairs++;
        if (truthSet.has(k)) sat.tp++;
      }
    }
  }
}
let edgeTp = 0;
for (const e of synEdges) if (truthEdges.has(e)) edgeTp++;
const synKinds: Record<string, number> = {};
for (const s of syn) synKinds[s.kind] = (synKinds[s.kind] ?? 0) + 1;
const truthKinds: Record<string, number> = {};
for (const t of truth.calls) {
  if (!callFiles.has(t.file)) continue;
  const k = `${t.kind}${t.inRepo ? " in-repo" : ""}`;
  truthKinds[k] = (truthKinds[k] ?? 0) + 1;
}
const totals = Object.values(byKind).reduce((a, r) => ({ n: a.n + r.n, correct: a.correct + r.correct }), {
  n: 0,
  correct: 0,
});
const pct = (a: number, b: number): number => +((100 * a) / Math.max(1, b)).toFixed(1);
console.log(
  JSON.stringify(
    {
      module,
      files: ctxs.length,
      callFiles: callFiles.size,
      timings: { parseMs: Math.round(parseMs), indexAndResolveMs: Math.round(resolveMs) },
      sites: { truth: truth.calls.length, syntax: syn.length },
      truthKinds,
      syntaxKinds: synKinds,
      inRepoByKind: Object.fromEntries(
        Object.entries(byKind).map(([k, r]) => [k, { ...r, recallPct: pct(r.correct, r.n) }]),
      ),
      missReasons,
      siteRecallPct: pct(totals.correct, totals.n),
      sitePrecisionPct: pct(predictedCorrect, predicted),
      predicted,
      falsePositivesByTruthKind: fpByTruthKind,
      edges: {
        truth: truthEdges.size,
        syntax: synEdges.size,
        tp: edgeTp,
        recallPct: pct(edgeTp, truthEdges.size),
        precisionPct: pct(edgeTp, synEdges.size),
      },
      interfaceDispatch: ifaceSites,
      satisfactionByNames: {
        ...sat,
        recallPct: pct(sat.tp, sat.truthPairs),
        precisionPct: pct(sat.tp, sat.predPairs),
      },
      missSamples: process.argv.includes("--samples") ? missSamples : missSamples.length,
    },
    null,
    2,
  ),
);

import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";

/**
 * The constant evaluator for request URLs (spec section 9). It turns the expression a client call passes as its URL
 * into the alternatives it can stand for, each a list of parts: literal text, a value that is only known at run time
 * (`{ param }`, a parameter or variable), an environment member (`{ env }`) or anything the evaluator does not read
 * (`{ unknown }`).
 *
 * Forms: string literals and templates, `+`, a local, top-level or imported `const`, a TypeScript `enum` member, a
 * member of an object literal bound to a `const` written `as const` (`ROUTES.me`), `process.env.X` and
 * `import.meta.env.X`, `a ?? b` and `a || b` (both alternatives), `c ? a : b` (both alternatives) and
 * `new URL(path, base)` (an absolute `path` replaces the path of `base`, a relative one joins it). Nesting stops at
 * depth 8 and at 16 alternatives, where the result is `{ unknown }`.
 */

export type UrlPart = string | { param: string } | { env: string } | { unknown: true };
export interface UrlAlt {
  parts: UrlPart[];
}

/** What a name stands for. */
export type Binding =
  | { kind: "const"; init: unknown; scope: UrlScope }
  | { kind: "enum"; node: Node; scope: UrlScope }
  /** A parameter, a variable or anything assigned more than once: a value known only at run time. */
  | { kind: "param" };

export interface UrlScope {
  /** The binding of a name, or null for a name nothing here declares (a global, an import that does not resolve). */
  lookup(name: string): Binding | null;
}
export interface ModuleScope extends UrlScope {
  /** A top-level declaration of this module only (what an importing module sees). */
  own(name: string): Binding | null;
}

const MAX_DEPTH = 8;
const MAX_ALTS = 16;
const UNKNOWN: UrlPart = { unknown: true };

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The names a binding pattern declares. */
function patternNames(p: unknown, out: string[]): void {
  const v = unwrap(p);
  if (!isNode(v)) return;
  switch (v.type) {
    case "Identifier":
      out.push(v.name as string);
      return;
    case "AssignmentPattern":
      patternNames(v.left, out);
      return;
    case "RestElement":
      patternNames(v.argument, out);
      return;
    case "ArrayPattern":
      for (const e of Array.isArray(v.elements) ? v.elements : []) patternNames(e, out);
      return;
    case "ObjectPattern":
      for (const prop of nodeArray(v.properties))
        patternNames(prop.type === "Property" ? prop.value : prop, out);
      return;
    default:
  }
}

/** The top-level declarations of a program as bindings; `imports` answers for a name the module does not declare. */
export function moduleScope(program: Node[], imports?: (name: string) => Binding | null): ModuleScope {
  const own = new Map<string, Binding>();
  const declare = (name: string, b: Binding) => own.set(name, own.has(name) ? { kind: "param" } : b);
  const self: ModuleScope = {
    own: (name) => own.get(name) ?? null,
    lookup: (name) => own.get(name) ?? imports?.(name) ?? null,
  };
  for (const st of program) {
    const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
    if (!isNode(decl)) continue;
    if (decl.type === "TSEnumDeclaration" && isNode(decl.id)) {
      declare(decl.id.name as string, { kind: "enum", node: decl, scope: self });
    } else if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
      if (isNode(decl.id)) declare(decl.id.name as string, { kind: "param" });
    } else if (decl.type === "VariableDeclaration") {
      for (const d of nodeArray(decl.declarations)) {
        const id = unwrap(d.id);
        if (decl.kind === "const" && isNode(id) && id.type === "Identifier" && d.init)
          declare(id.name as string, { kind: "const", init: d.init, scope: self });
        else {
          const names: string[] = [];
          patternNames(id, names);
          for (const n of names) declare(n, { kind: "param" });
        }
      }
    }
  }
  return self;
}

/** The scope inside a function: its parameters and the declarations of its body (nested functions have their own). */
export function localScope(parent: UrlScope, fn: Node): UrlScope {
  const own = new Map<string, Binding>();
  const declare = (name: string, b: Binding) => own.set(name, own.has(name) ? { kind: "param" } : b);
  const self: UrlScope = { lookup: (name) => own.get(name) ?? parent.lookup(name) };
  const names: string[] = [];
  for (const p of nodeArray(fn.params)) patternNames(p, names);
  for (const n of names) declare(n, { kind: "param" });
  visit(fn.body, (n) => {
    if (FN_TYPES.has(n.type)) {
      if (n.type === "FunctionDeclaration" && isNode(n.id)) declare(n.id.name as string, { kind: "param" });
      return false;
    }
    if (n.type !== "VariableDeclaration") return undefined;
    for (const d of nodeArray(n.declarations)) {
      const id = unwrap(d.id);
      if (n.kind === "const" && isNode(id) && id.type === "Identifier" && d.init)
        declare(id.name as string, { kind: "const", init: d.init, scope: self });
      else {
        const ns: string[] = [];
        patternNames(id, ns);
        for (const x of ns) declare(x, { kind: "param" });
      }
    }
    return undefined;
  });
  return self;
}

type Alts = UrlPart[][];

const same = (a: UrlPart[], b: UrlPart[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Adjacent text merged, empty text removed. */
function normalize(parts: UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else if (typeof p === "object" && "unknown" in p && typeof last === "object" && "unknown" in last)
      continue;
    else if (p !== "") out.push(p);
  }
  return out;
}

function union(...lists: Alts[]): Alts {
  const out: Alts = [];
  for (const l of lists) for (const a of l) if (!out.some((o) => same(o, a))) out.push(a);
  return out.length > MAX_ALTS ? [[UNKNOWN]] : out;
}

function cross(a: Alts, b: Alts): Alts {
  if (a.length * b.length > MAX_ALTS) return [[UNKNOWN]];
  return union(a.flatMap((x) => b.map((y) => normalize([...x, ...y]))));
}

/** The keys of a member chain `root.a["b"].c`, and its root expression. */
function memberKeys(expr: Node): { root: unknown; keys: string[] } | null {
  const keys: string[] = [];
  let cur: unknown = expr;
  for (let i = 0; i < 32; i++) {
    cur = unwrap(cur);
    if (!isNode(cur) || cur.type !== "MemberExpression") return { root: cur, keys: keys.reverse() };
    const p = unwrap(cur.property);
    if (cur.computed === true) {
      if (!isNode(p) || p.type !== "Literal" || typeof p.value !== "string") return null;
      keys.push(p.value);
    } else if (isNode(p) && p.type === "Identifier") keys.push(p.name as string);
    else return null;
    cur = cur.object;
  }
  return null;
}

/** `process.env.X` / `import.meta.env.X` as the name `X`. */
function envName(root: unknown, keys: string[]): string | null {
  if (keys.length !== 2 || keys[0] !== "env" || !isNode(root)) return null;
  if (root.type === "Identifier" && root.name === "process") return keys[1] as string;
  if (root.type === "MetaProperty") {
    const meta = root.meta as Node | undefined;
    const prop = root.property as Node | undefined;
    if (meta?.name === "import" && prop?.name === "meta") return keys[1] as string;
  }
  return null;
}

/** The property `key` of an object literal. */
function objectMember(obj: Node, key: string): unknown {
  for (const p of nodeArray(obj.properties)) {
    const k = unwrap(p.key);
    if (p.type === "Property" && p.computed !== true && isNode(k) && (k.name === key || k.value === key))
      return p.value;
    if (p.type === "Property" && p.computed === true && isNode(k) && k.value === key) return p.value;
  }
  return undefined;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** `new URL(path, base)` for one alternative of each: the path an absolute `path` names, or `path` joined to `base`. */
function resolveUrl(path: UrlPart[], base: UrlPart[]): UrlPart[] {
  const first = path[0];
  if (typeof first !== "string") return [UNKNOWN];
  if (ABSOLUTE.test(first)) return path;
  if (first.startsWith("/")) {
    // The origin of the base is not part of the path; it is kept when the base writes one out, and a leading
    // environment member or parameter is kept too (the origin is a configured one: the alternative is dropped).
    const b0 = base[0];
    const origin = typeof b0 === "string" ? (ORIGIN.exec(b0)?.[0] ?? "") : b0 && !("unknown" in b0) ? b0 : "";
    return normalize([origin, ...path]);
  }
  const last = base[base.length - 1];
  if (typeof last !== "string") return [UNKNOWN];
  // `https://host` alone has the path `/`; otherwise the last segment of the base is replaced.
  const dir = ORIGIN.exec(last)?.[0] === last ? `${last}/` : last.slice(0, last.lastIndexOf("/") + 1);
  return normalize([...base.slice(0, -1), dir, ...path]);
}

function ev(expr: unknown, scope: UrlScope, depth: number): Alts {
  const v = unwrap(expr);
  if (!isNode(v) || depth > MAX_DEPTH) return [[UNKNOWN]];
  switch (v.type) {
    case "Literal":
      return typeof v.value === "string" ? [normalize([v.value])] : [[UNKNOWN]];
    case "TemplateLiteral": {
      const exprs = Array.isArray(v.expressions) ? v.expressions : [];
      let out: Alts = [[]];
      nodeArray(v.quasis).forEach((q, i) => {
        const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
        out = cross(out, [typeof cooked === "string" ? normalize([cooked]) : [UNKNOWN]]);
        if (i < exprs.length) out = cross(out, ev(exprs[i], scope, depth + 1));
      });
      return out;
    }
    case "BinaryExpression":
      return v.operator === "+"
        ? cross(ev(v.left, scope, depth + 1), ev(v.right, scope, depth + 1))
        : [[UNKNOWN]];
    case "LogicalExpression":
      return v.operator === "??" || v.operator === "||"
        ? union(ev(v.left, scope, depth + 1), ev(v.right, scope, depth + 1))
        : [[UNKNOWN]];
    case "ConditionalExpression":
      return union(ev(v.consequent, scope, depth + 1), ev(v.alternate, scope, depth + 1));
    case "Identifier": {
      const name = v.name as string;
      const b = scope.lookup(name);
      if (!b) return [[UNKNOWN]];
      if (b.kind === "param") return [[{ param: name }]];
      if (b.kind === "enum") return [[UNKNOWN]];
      return ev(b.init, b.scope, depth + 1);
    }
    case "MemberExpression": {
      const chain = memberKeys(v);
      if (!chain) return [[UNKNOWN]];
      const env = envName(chain.root, chain.keys);
      if (env !== null) return [[{ env }]];
      const root = unwrap(chain.root);
      if (!isNode(root) || root.type !== "Identifier" || chain.keys.length === 0) return [[UNKNOWN]];
      const b = scope.lookup(root.name as string);
      if (!b) return [[UNKNOWN]];
      if (b.kind === "param") return [[{ param: chain.keys[chain.keys.length - 1] as string }]];
      if (b.kind === "enum") {
        if (chain.keys.length !== 1) return [[UNKNOWN]];
        const body = b.node.body as { members?: unknown } | undefined;
        const member = nodeArray(body?.members).find((m) => {
          const id = unwrap(m.id);
          return isNode(id) && (id.name === chain.keys[0] || id.value === chain.keys[0]);
        });
        return member?.initializer ? ev(member.initializer, b.scope, depth + 1) : [[UNKNOWN]];
      }
      return evMember(b.init, chain.keys, b.scope, depth + 1, false);
    }
    case "NewExpression": {
      const callee = unwrap(v.callee);
      if (!isNode(callee) || callee.type !== "Identifier" || callee.name !== "URL") return [[UNKNOWN]];
      const args = Array.isArray(v.arguments) ? v.arguments : [];
      if (args.length === 0) return [[UNKNOWN]];
      const paths = ev(args[0], scope, depth + 1);
      if (args.length === 1) return paths;
      const bases = ev(args[1], scope, depth + 1);
      return union(paths.flatMap((p) => bases.map((b) => resolveUrl(p, b))));
    }
    default:
      return [[UNKNOWN]];
  }
}

/** `expr as const`: an object that cannot be changed, so its members are what the literal says. */
function isAsConst(expr: unknown): boolean {
  if (!isNode(expr) || expr.type !== "TSAsExpression") return false;
  const t = expr.typeAnnotation as { typeName?: { name?: unknown } } | undefined;
  return t?.typeName?.name === "const";
}

/** The member `keys` of an object literal written `as const` (or a const naming one); any other object is a run-time value. */
function evMember(init: unknown, keys: string[], scope: UrlScope, depth: number, frozen: boolean): Alts {
  const v = unwrap(init);
  if (!isNode(v) || depth > MAX_DEPTH) return [[UNKNOWN]];
  if (keys.length === 0) return ev(v, scope, depth + 1);
  if (v.type === "ObjectExpression") {
    if (!frozen && !isAsConst(init)) return [[{ param: keys[keys.length - 1] as string }]];
    const value = objectMember(v, keys[0] as string);
    return value === undefined ? [[UNKNOWN]] : evMember(value, keys.slice(1), scope, depth + 1, true);
  }
  if (v.type === "Identifier") {
    const b = scope.lookup(v.name as string);
    return b?.kind === "const" ? evMember(b.init, keys, b.scope, depth + 1, false) : [[UNKNOWN]];
  }
  return [[UNKNOWN]];
}

/**
 * The alternatives a URL expression can stand for; null when `expr` is no expression. Each alternative has its text
 * and parts merged (no two texts in a row).
 */
export function evalUrl(expr: unknown, scope: UrlScope): UrlAlt[] | null {
  if (!isNode(expr)) return null;
  return ev(expr, scope, 0).map((parts) => ({ parts }));
}

/**
 * An alternative as the text a call requests: a part that is not text stands for `:param`. Null when the alternative
 * does not start with text (a base or origin that is not known, a bare parameter): it names no path. `full` is
 * false when the text has an environment member or an unknown part, which no `:param` stands for.
 */
export function altText(alt: UrlAlt): { text: string; full: boolean } | null {
  const first = alt.parts[0];
  if (alt.parts.length > 0 && typeof first !== "string") return null;
  let text = "";
  let full = true;
  for (const p of alt.parts) {
    if (typeof p === "string") text += p;
    else {
      text += ":param";
      if (!("param" in p)) full = false;
    }
  }
  return { text, full };
}

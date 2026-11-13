import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { isNode, type Node } from "../parse/ast.js";

/**
 * Structural fingerprints per function (spec section 7).
 *
 * One pass over the AST of the symbol's source range produces:
 * - the exact token stream: node types, flags, operators and literal values in source order, with
 *   local identifiers (declared inside the symbol) renamed `$1, $2…` in first-appearance order;
 * - the shape token stream: node types only, identifiers/strings/numbers/templates collapsed;
 * - text edits that turn the source slice into the embedding text.
 * Comments and whitespace never reach the AST, so they cannot influence any output.
 */

type Lang = "ts" | "tsx";
interface Range {
  start: number;
  end: number;
}

const EMPTY_SLOT = 0xffffffff;
export const MINHASH_PERMUTATIONS = 64;
const SHINGLE_SIZE = 5;
const FNV_PRIME = 0x01000193;
const FNV_BASIS = 0x811c9dc5;

// --- parsing & range location ----------------------------------------------------------------

interface Parsed {
  source: string;
  body: Node[];
  comments: Range[];
  errors: number;
}

let parseCache: { source: string; lang: Lang; parsed: Parsed } | null = null;

function parseProgram(source: string, lang: Lang): Parsed {
  if (parseCache && parseCache.lang === lang && parseCache.source === source) return parseCache.parsed;
  const r = parseSync(lang === "tsx" ? "x.tsx" : "x.ts", source, {
    sourceType: "module",
    lang,
    preserveParens: false,
  });
  const program = r.program as unknown as { body?: unknown[] };
  const parsed: Parsed = {
    source,
    body: (program.body ?? []).filter(isNode),
    comments: (r.comments as unknown as Range[]).map((c) => ({ start: c.start, end: c.end })),
    errors: r.errors.length,
  };
  parseCache = { source, lang, parsed };
  return parsed;
}

/** Child nodes of `node` in source order (stable for equal starts). */
function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Outermost nodes fully inside the range. */
function findRoots(nodes: Node[], range: Range, out: Node[] = []): Node[] {
  for (const n of nodes) {
    if (n.end <= range.start || n.start >= range.end) continue;
    if (n.start >= range.start && n.end <= range.end) out.push(n);
    else findRoots(childNodes(n), range, out);
  }
  return out;
}

/** `export function f` hashes the same as `function f`: export-ness is not behavior. */
function unwrapExport(n: Node): Node {
  if (
    (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") &&
    isNode(n.declaration)
  ) {
    return n.declaration;
  }
  return n;
}

interface Located {
  source: string;
  roots: Node[];
  comments: Range[];
}

function locate(source: string, range: Range, lang: Lang): Located | null {
  const rs = Math.max(0, range.start);
  const re = Math.min(source.length, range.end);
  if (re <= rs) return null;
  const whole = parseProgram(source, lang);
  const roots = findRoots(whole.body, { start: rs, end: re });
  if (roots.length > 0) return { source, roots: roots.map(unwrapExport), comments: whole.comments };
  // The file did not parse as a whole (oxc returns an empty program on fatal errors): try the slice
  // alone, then wrapped in a class so that methods parse.
  const slice = source.slice(rs, re);
  for (const [prefix, suffix] of [
    ["", ""],
    ["class $C {\n", "\n}"],
  ] as const) {
    const text = prefix + slice + suffix;
    const p = parseProgram(text, lang);
    if (p.errors > 0) continue;
    const r = findRoots(p.body, { start: prefix.length, end: prefix.length + slice.length });
    if (r.length > 0) return { source: text, roots: r.map(unwrapExport), comments: p.comments };
  }
  return null;
}

// --- scope tracking ---------------------------------------------------------------------------

interface Binding {
  /** 1-based index in first-appearance order; 0 until first seen. */
  n: number;
}

class Scope {
  readonly names = new Map<string, Binding>();
  constructor(readonly parent: Scope | null) {}
  declare(name: string): void {
    if (!this.names.has(name)) this.names.set(name, { n: 0 });
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);
const OTHER_SCOPE_TYPES = new Set([
  "BlockStatement",
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "CatchClause",
  "SwitchStatement",
  "ClassDeclaration",
  "ClassExpression",
]);

function bindingNames(p: unknown, into: string[] = []): string[] {
  if (!isNode(p)) return into;
  switch (p.type) {
    case "Identifier":
      if (p.name !== "this") into.push(p.name as string);
      break;
    case "ObjectPattern":
      for (const prop of Array.isArray(p.properties) ? p.properties : []) {
        if (!isNode(prop)) continue;
        bindingNames(prop.type === "RestElement" ? prop.argument : prop.value, into);
      }
      break;
    case "ArrayPattern":
      for (const el of Array.isArray(p.elements) ? p.elements : []) bindingNames(el, into);
      break;
    case "RestElement":
      bindingNames(p.argument, into);
      break;
    case "AssignmentPattern":
      bindingNames(p.left, into);
      break;
    case "TSParameterProperty":
      bindingNames(p.parameter, into);
      break;
  }
  return into;
}

function declareDeclarators(decl: Node, scope: Scope, onlyKind?: "var" | "lexical"): void {
  const isVar = decl.kind === "var";
  if (onlyKind === "var" && !isVar) return;
  if (onlyKind === "lexical" && isVar) return;
  for (const d of Array.isArray(decl.declarations) ? decl.declarations : []) {
    if (isNode(d)) for (const n of bindingNames(d.id)) scope.declare(n);
  }
}

/** Block-level declarations of a statement list: let/const/class/function/enum/namespace. */
function declareLexical(stmts: unknown, scope: Scope): void {
  for (const s of Array.isArray(stmts) ? stmts : []) {
    if (!isNode(s)) continue;
    switch (s.type) {
      case "VariableDeclaration":
        declareDeclarators(s, scope, "lexical");
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration":
      case "TSDeclareFunction":
        if (isNode(s.id) && typeof s.id.name === "string") scope.declare(s.id.name);
        break;
    }
  }
}

/** `var` declarations anywhere below `root`, not crossing function boundaries. */
function hoistVars(root: unknown, scope: Scope): void {
  if (Array.isArray(root)) {
    for (const r of root) hoistVars(r, scope);
    return;
  }
  if (!isNode(root)) return;
  if (FUNCTION_TYPES.has(root.type) || root.type === "StaticBlock") return;
  if (root.type === "VariableDeclaration") declareDeclarators(root, scope, "var");
  for (const c of childNodes(root)) hoistVars(c, scope);
}

// --- the walk ---------------------------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Analysis {
  /** Exact token stream (local identifiers renamed). */
  tokens: string[];
  /** Shape token stream (pre-order node types). */
  shape: string[];
  edits: Edit[];
}

const SKIP_KEYS = new Set(["type", "start", "end", "range", "parent", "raw", "shorthand"]);
const PRIVATE_NAME_TYPES = new Set(["Identifier", "JSXIdentifier", "PrivateIdentifier"]);

function jsxTagIsReference(name: string): boolean {
  const c = name.charAt(0);
  return c !== "" && c === c.toUpperCase() && c !== c.toLowerCase();
}

/** JSX text semantics: lines are trimmed and joined, whitespace-only multi-line text vanishes. */
function normalizeJsxText(v: string): string {
  if (!v.includes("\n")) return v;
  const lines = v.split(/\r\n|\r|\n/);
  const kept: string[] = [];
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i > 0) l = l.replace(/^ +/, "");
    if (i < lines.length - 1) l = l.replace(/ +$/, "");
    if (l !== "") kept.push(l);
  });
  return kept.join(" ");
}

class Walker {
  readonly tokens: string[] = [];
  readonly shape: string[] = [];
  readonly edits: Edit[] = [];
  private scope: Scope | null = null;
  private counter = 0;
  private shapeMute = 0;
  /** Identifier nodes that stand for both key and value of a shorthand property. */
  private readonly shorthandValues = new Set<Node>();

  private pushShape(s: string): void {
    if (this.shapeMute === 0) this.shape.push(s);
  }

  private lookup(name: string): Binding | null {
    for (let s = this.scope; s; s = s.parent) {
      const b = s.names.get(name);
      if (b) return b;
    }
    return null;
  }

  /** Opens a scope for scoping nodes and pre-declares their bindings. Returns whether one was opened. */
  private enter(node: Node): boolean {
    const tp = node.typeParameters;
    const typeParams = isNode(tp) && Array.isArray(tp.params) ? tp.params : null;
    const isFn = FUNCTION_TYPES.has(node.type);
    if (!isFn && !typeParams && !OTHER_SCOPE_TYPES.has(node.type)) return false;
    const scope = new Scope(this.scope);
    this.scope = scope;
    for (const p of typeParams ?? []) {
      if (isNode(p) && isNode(p.name) && typeof p.name.name === "string") scope.declare(p.name.name);
      else if (isNode(p) && typeof p.name === "string") scope.declare(p.name);
    }
    switch (node.type) {
      case "FunctionExpression":
      case "FunctionDeclaration":
      case "ArrowFunctionExpression":
      case "TSDeclareFunction":
      case "TSEmptyBodyFunctionExpression":
        if (node.type === "FunctionExpression" && isNode(node.id) && typeof node.id.name === "string") {
          scope.declare(node.id.name);
        }
        for (const p of Array.isArray(node.params) ? node.params : []) {
          for (const n of bindingNames(p)) scope.declare(n);
        }
        hoistVars(node.body, scope);
        break;
      case "BlockStatement":
      case "StaticBlock":
        declareLexical(node.body, scope);
        break;
      case "ForStatement":
        if (isNode(node.init) && node.init.type === "VariableDeclaration") {
          declareDeclarators(node.init, scope, "lexical");
        }
        break;
      case "ForInStatement":
      case "ForOfStatement":
        if (isNode(node.left) && node.left.type === "VariableDeclaration") {
          declareDeclarators(node.left, scope, "lexical");
        }
        break;
      case "CatchClause":
        for (const n of bindingNames(node.param)) scope.declare(n);
        break;
      case "SwitchStatement":
        for (const c of Array.isArray(node.cases) ? node.cases : []) {
          if (isNode(c)) declareLexical(c.consequent, scope);
        }
        break;
      case "ClassExpression":
        if (isNode(node.id) && typeof node.id.name === "string") scope.declare(node.id.name);
        break;
    }
    return true;
  }

  walkRoot(root: Node): void {
    this.walk(root, null, "");
  }

  private walk(node: Node, parent: Node | null, key: string): void {
    const opened = this.enter(node);
    this.visitNode(node, parent, key);
    if (opened && this.scope) this.scope = this.scope.parent;
  }

  private visitNode(node: Node, parent: Node | null, key: string): void {
    const t = node.type;
    if (PRIVATE_NAME_TYPES.has(t)) {
      this.identifier(node, parent, key);
      this.walkChildren(node);
      return;
    }
    if (t === "Literal") {
      this.literal(node);
      return;
    }
    if (t === "JSXText") {
      const text = normalizeJsxText(String(node.value ?? ""));
      if (text === "" && String(node.value ?? "").includes("\n")) return;
      this.tokens.push("JSXText", `JT:${JSON.stringify(text)}`);
      this.pushShape("JSXText");
      return;
    }
    if (t === "TemplateElement") {
      const v = node.value as { raw?: string } | undefined;
      this.tokens.push("TemplateElement", `Q:${JSON.stringify(v?.raw ?? "")}`);
      return;
    }
    if (t === "Property" && node.shorthand === true) {
      const v = node.value;
      if (isNode(v)) {
        if (v.type === "Identifier") this.shorthandValues.add(v);
        else if (v.type === "AssignmentPattern" && isNode(v.left)) this.shorthandValues.add(v.left);
      }
    }

    let shapeToken = t;
    this.tokens.push(t);
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (typeof v === "string") {
        if (v !== "") this.tokens.push(`${k}=${v}`);
        if (k === "operator") shapeToken += `:${v}`;
      } else if (typeof v === "number" || v === true) {
        this.tokens.push(`${k}=${String(v)}`);
      }
    }
    const isTemplate = t === "TemplateLiteral";
    if (isTemplate) {
      shapeToken = "TPL";
      this.pushShape(shapeToken);
      this.shapeMute++;
    } else {
      this.pushShape(shapeToken);
    }
    this.walkChildren(node);
    if (isTemplate) this.shapeMute--;
  }

  private walkChildren(node: Node): void {
    if ((node.type === "ArrayExpression" || node.type === "ArrayPattern") && Array.isArray(node.elements)) {
      for (const el of node.elements) {
        if (isNode(el)) this.walk(el, node, "elements");
        else this.tokens.push("HOLE");
      }
      for (const c of childNodes(node)) {
        if (!(node.elements as unknown[]).includes(c)) this.walk(c, node, "");
      }
      return;
    }
    for (const c of childNodes(node)) {
      // Locate which key the child lives under; needed to tell property names from references.
      this.walk(c, node, keyOf(node, c));
    }
  }

  private isPropertyName(node: Node, parent: Node | null, key: string): boolean {
    if (!parent) return false;
    const pt = parent.type;
    if (
      key === "property" &&
      (pt === "JSXMemberExpression" || (pt === "MemberExpression" && parent.computed !== true))
    ) {
      return true;
    }
    if (key === "key" && parent.computed !== true) return true;
    if (pt === "TSQualifiedName" && key === "right") return true;
    if (
      key === "label" &&
      (pt === "LabeledStatement" || pt === "BreakStatement" || pt === "ContinueStatement")
    ) {
      return true;
    }
    if (pt === "MetaProperty") return true;
    if (pt === "TSEnumMember" && key === "id") return true;
    if (pt === "JSXAttribute" && key === "name") return true;
    if (pt === "JSXNamespacedName") return true;
    if (pt === "TSNamedTupleMember" && key === "label") return true;
    if ((pt === "JSXOpeningElement" || pt === "JSXClosingElement") && key === "name") {
      return !jsxTagIsReference(node.name as string);
    }
    return false;
  }

  private identifier(node: Node, parent: Node | null, key: string): void {
    const name = node.name as string;
    this.pushShape("ID");
    if (node.type === "PrivateIdentifier") {
      this.tokens.push(`#${name}`);
      return;
    }
    if (this.isPropertyName(node, parent, key)) {
      this.tokens.push(`P:${name}`);
      return;
    }
    const b = this.lookup(name);
    if (!b) {
      this.tokens.push(`I:${name}`);
      return;
    }
    if (b.n === 0) b.n = ++this.counter;
    const renamed = `$${b.n}`;
    this.tokens.push(renamed);
    this.edits.push({
      start: node.start,
      end: node.start + name.length,
      text: this.shorthandValues.has(node) ? `${name}: ${renamed}` : renamed,
    });
  }

  private literal(node: Node): void {
    const v = node.value;
    this.tokens.push("Literal");
    if (typeof v === "string") {
      this.tokens.push(`S:${JSON.stringify(v)}`);
      this.pushShape("STR");
      this.edits.push({ start: node.start, end: node.end, text: '"s"' });
    } else if (typeof v === "number") {
      this.tokens.push(`N:${String(v)}`);
      this.pushShape("NUM");
    } else if (typeof node.bigint === "string") {
      this.tokens.push(`B:${node.bigint}`);
      this.pushShape("NUM");
    } else if (isNode(node.regex) || (typeof node.regex === "object" && node.regex !== null)) {
      const r = node.regex as { pattern?: string; flags?: string };
      this.tokens.push(`R:/${r.pattern ?? ""}/${r.flags ?? ""}`);
      this.pushShape("Literal");
    } else {
      this.tokens.push(`L:${String(v)}`);
      this.pushShape("Literal");
    }
  }
}

/** The property of `node` that holds `child` (by identity). */
function keyOf(node: Node, child: Node): string {
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v === child) return k;
    if (Array.isArray(v) && v.includes(child)) return k;
  }
  return "";
}

function fallbackTokens(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

function analyze(source: string, range: Range, lang: Lang): { a: Analysis; located: Located | null } {
  const located = locate(source, range, lang);
  if (!located) {
    const toks = fallbackTokens(source.slice(Math.max(0, range.start), Math.max(0, range.end)));
    return { a: { tokens: toks, shape: toks, edits: [] }, located: null };
  }
  const w = new Walker();
  for (const r of located.roots) w.walkRoot(r);
  return { a: { tokens: w.tokens, shape: w.shape, edits: w.edits }, located };
}

// --- outputs ----------------------------------------------------------------------------------

function sha32(tokens: string[]): string {
  return createHash("sha256").update(tokens.join("\n")).digest("hex").slice(0, 32);
}

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Per-permutation FNV-1a offset bases; seeds are 1…64 and fixed. */
const BASES: number[] = Array.from(
  { length: MINHASH_PERMUTATIONS },
  (_, i) => (FNV_BASIS ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
);

function computeMinhash(shape: string[]): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMUTATIONS).fill(EMPTY_SLOT);
  if (shape.length === 0) return sig;
  const count = Math.max(1, shape.length - SHINGLE_SIZE + 1);
  const width = Math.min(SHINGLE_SIZE, shape.length);
  for (let s = 0; s < count; s++) {
    const bytes = Buffer.from(shape.slice(s, s + width).join("\u001f"), "utf8");
    for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
      let h = BASES[i] as number;
      for (let j = 0; j < bytes.length; j++) {
        h ^= bytes[j] as number;
        h = Math.imul(h, FNV_PRIME) >>> 0;
      }
      h = fmix32(h);
      if (h < (sig[i] as number)) sig[i] = h;
    }
  }
  return sig;
}

/**
 * exactHash / shapeHash / minhash of the code in `range`. `range` is a symbol body range from the
 * parser (UTF-16 offsets into `source`).
 */
export function hashSymbol(
  source: string,
  range: { start: number; end: number },
  lang: "ts" | "tsx",
): { exactHash: string; shapeHash: string; minhash: Uint32Array } {
  const { a } = analyze(source, range, lang);
  return { exactHash: sha32(a.tokens), shapeHash: sha32(a.shape), minhash: computeMinhash(a.shape) };
}

/** Fraction of equal MinHash slots: an estimate of the Jaccard similarity of the shingle sets. */
export function minhashJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) throw new RangeError(`minhash length mismatch: ${a.length} vs ${b.length}`);
  if (a.length === 0) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

/**
 * Code text for the embedding tier: comments and layout dropped, local identifiers renamed as in
 * `exactHash`, string literals replaced by `"s"`.
 */
export function normalizeForEmbedding(
  source: string,
  range: { start: number; end: number },
  lang: "ts" | "tsx",
): string {
  const { a, located } = analyze(source, range, lang);
  if (!located) return a.tokens.join(" ");
  const parts: string[] = [];
  for (const root of located.roots) {
    const edits: Edit[] = a.edits.filter((e) => e.start >= root.start && e.end <= root.end);
    for (const c of located.comments) {
      if (c.start >= root.start && c.end <= root.end) edits.push({ start: c.start, end: c.end, text: " " });
    }
    edits.sort((x, y) => x.start - y.start);
    let out = "";
    let pos = root.start;
    for (const e of edits) {
      if (e.start < pos) continue;
      out += located.source.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    out += located.source.slice(pos, root.end);
    parts.push(out.replace(/\s+/g, " ").trim());
  }
  return parts.join("\n");
}

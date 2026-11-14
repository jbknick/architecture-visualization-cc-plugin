import { parseSync } from "oxc-parser";
import type { ParsedSymbol, SymbolKind } from "../types.js";
import {
  chainName,
  isNode,
  jsxName,
  LineTable,
  type Node,
  nodeArray,
  patternNames,
  typeName,
  unwrap,
  visit,
} from "./ast.js";

export interface ParsedImport {
  /** Local binding name. Empty string for side-effect and dynamic imports. */
  local: string;
  /** Imported name, "default" for the default export, "*" for a namespace (or a whole-module import). */
  imported: string | "default" | "*";
  specifier: string;
  typeOnly: boolean;
  line: number;
}

export interface ParsedExport {
  exported: string;
  /** Local binding (or, with `fromSpecifier`, the name in the source module). */
  local?: string;
  fromSpecifier?: string;
  /** True only for a plain `export * from "x"`. */
  star?: boolean;
}

export type SiteKind = "calls" | "renders" | "uses_hook" | "extends" | "implements" | "references_type";

export interface ParsedSite {
  /** Symbol id, or the file id for module-level code. */
  fromSymbol: string;
  kind: SiteKind;
  /** Identifier or `a.b.c` member chain. */
  callee: string;
  line: number;
}

export interface ParsedFile {
  fileId: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  sites: ParsedSite[];
  /** Source range per symbol id as UTF-16 string offsets: `source.slice(start, end)` is the body. */
  bodies: Map<string, { start: number; end: number }>;
  errors: string[];
  /** Leading directive prologue strings, e.g. `["use client"]`. Absent on results cached before v2. */
  directives?: string[];
}

interface Draft {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** Top-level declarations only: the local binding that `export { x }` can refer to. */
  topLevel: boolean;
  range: { start: number; end: number };
  signature: string;
  complexityRoot: unknown;
  stmtRoot: unknown;
  /** Arrow function with an expression body counts as one (implicit return) statement. */
  exprBody: boolean;
  callRoots: unknown[];
  typeRoots: unknown[];
  scopeRoots: unknown[];
  heritage: { kind: "extends" | "implements"; callee: string; line: number }[];
}

const SIGNATURE_MAX = 200;
const HOOK_RE = /^use[A-Z]/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef", "React.memo", "React.forwardRef"]);
const STATEMENT_TYPES = new Set([
  "ExpressionStatement",
  "VariableDeclaration",
  "ReturnStatement",
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
  "ThrowStatement",
  "BreakStatement",
  "ContinueStatement",
  "LabeledStatement",
  "WithStatement",
  "DebuggerStatement",
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
]);
const COMPLEXITY_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

type Lang = "ts" | "tsx" | "js" | "jsx" | "dts";

function langOf(path: string): Lang {
  const p = path.toLowerCase();
  if (p.endsWith(".d.ts") || p.endsWith(".d.mts") || p.endsWith(".d.cts")) return "dts";
  if (p.endsWith(".tsx")) return "tsx";
  if (p.endsWith(".jsx")) return "jsx";
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "js";
  return "ts";
}

interface OxcError {
  message: string;
  labels?: { start: number }[];
}

function runOxc(path: string, source: string, lang: Lang): { body: Node[]; errors: OxcError[] } {
  const r = parseSync(path, source, { sourceType: "module", lang, preserveParens: false });
  const program = r.program as unknown as { body?: unknown };
  return { body: nodeArray(program.body), errors: r.errors as unknown as OxcError[] };
}

/** Start offset of the last line before `before` that begins a top-level statement. */
function lastStatementStart(source: string, before: number): number {
  let i = Math.min(before, source.length);
  while (i > 0) {
    const nl = source.lastIndexOf("\n", i - 1);
    const lineStart = nl + 1;
    if (lineStart < i && /^[A-Za-z_$@]/.test(source.charAt(lineStart))) return lineStart;
    if (nl < 0) return 0;
    i = nl;
  }
  return 0;
}

/**
 * oxc returns an empty program for fatal syntax errors. Recover the declarations that precede the
 * error by re-parsing a prefix cut at a top-level statement boundary before the error offset.
 */
function parseRecovering(
  path: string,
  source: string,
  lang: Lang,
  lines: LineTable,
): { body: Node[]; errors: string[] } {
  const first = runOxc(path, source, lang);
  const fmt = (e: OxcError): string => {
    const start = e.labels?.[0]?.start;
    return start === undefined ? e.message : `line ${lines.lineOf(start)}: ${e.message}`;
  };
  const errors = first.errors.map(fmt);
  if (first.errors.length === 0 || first.body.length > 0) return { body: first.body, errors };
  let cut = first.errors[0]?.labels?.[0]?.start ?? source.length;
  for (let attempt = 0; attempt < 25; attempt++) {
    cut = lastStatementStart(source, cut);
    if (cut <= 0) break;
    const retry = runOxc(path, source.slice(0, cut), lang);
    if (retry.errors.length === 0 || retry.body.length > 0) return { body: retry.body, errors };
  }
  return { body: [], errors };
}

function collapse(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SIGNATURE_MAX ? `${t.slice(0, SIGNATURE_MAX - 1)}…` : t;
}

function fnSignature(fn: Node, source: string): string {
  const tp = isNode(fn.typeParameters) ? source.slice(fn.typeParameters.start, fn.typeParameters.end) : "";
  const params = nodeArray(fn.params);
  const first = params[0];
  const last = params[params.length - 1];
  const ptext = first && last ? source.slice(first.start, last.end) : "";
  const rt =
    isNode(fn.returnType) && isNode(fn.returnType.typeAnnotation) ? fn.returnType.typeAnnotation : null;
  const ret = rt ? `: ${source.slice(rt.start, rt.end)}` : "";
  return collapse(`${tp}(${ptext})${ret}`);
}

function isFunctionNode(n: unknown): n is Node {
  return (
    isNode(n) &&
    (n.type === "ArrowFunctionExpression" ||
      n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration" ||
      n.type === "TSEmptyBodyFunctionExpression")
  );
}

/** The function behind `() => …`, `function () {}`, or `memo(forwardRef(() => …))`. */
function functionOf(expr: unknown, depth = 0): Node | null {
  const e = unwrap(expr);
  if (isFunctionNode(e)) return e;
  if (depth < 4 && isNode(e) && e.type === "CallExpression") {
    const name = chainName(e.callee);
    const arg = nodeArray(e.arguments)[0];
    if (name && COMPONENT_WRAPPERS.has(name) && arg) return functionOf(arg, depth + 1);
  }
  return null;
}

function containsJsx(root: unknown): boolean {
  let found = false;
  visit(root, (n) => {
    if (found) return false;
    if (n.type === "JSXElement" || n.type === "JSXFragment") {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function measure(
  complexityRoot: unknown,
  stmtRoot: unknown,
  exprBody: boolean,
): { complexity: number; stmtCount: number } {
  let complexity = 1;
  visit(complexityRoot, (n) => {
    if (COMPLEXITY_TYPES.has(n.type)) complexity++;
    else if (n.type === "LogicalExpression") {
      if (n.operator === "&&" || n.operator === "||" || n.operator === "??") complexity++;
    } else if (n.type === "SwitchCase" && n.test !== null && n.test !== undefined) complexity++;
    return undefined;
  });
  let stmtCount = exprBody ? 1 : 0;
  visit(stmtRoot, (n) => {
    if (n !== stmtRoot && STATEMENT_TYPES.has(n.type)) stmtCount++;
    return undefined;
  });
  return { complexity, stmtCount };
}

function functionKind(name: string, body: unknown): SymbolKind {
  if (HOOK_RE.test(name)) return "hook";
  if ((PASCAL_RE.test(name) || name === "default") && containsJsx(body)) return "component";
  return "function";
}

function memberKeyName(member: Node): string | null {
  if (member.computed === true) return null;
  const k = member.key;
  if (!isNode(k)) return null;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "PrivateIdentifier") return `#${k.name as string}`;
  if (k.type === "Literal" && (typeof k.value === "string" || typeof k.value === "number"))
    return String(k.value);
  return null;
}

class Extractor {
  readonly drafts: Draft[] = [];
  readonly imports: ParsedImport[] = [];
  readonly exports: ParsedExport[] = [];
  private readonly exportedLocals = new Set<string>();
  private readonly fileRoots: unknown[] = [];

  constructor(
    private readonly source: string,
    private readonly lines: LineTable,
  ) {}

  run(body: Node[]): void {
    for (const stmt of body) this.statement(stmt);
    for (const d of this.drafts) if (d.topLevel && this.exportedLocals.has(d.name)) d.exported = true;
  }

  get moduleRoots(): unknown[] {
    return this.fileRoots;
  }

  private statement(stmt: Node): void {
    switch (stmt.type) {
      case "ImportDeclaration":
        this.importDecl(stmt);
        break;
      case "TSImportEqualsDeclaration":
        this.importEquals(stmt);
        break;
      case "ExportAllDeclaration":
        this.exportAll(stmt);
        break;
      case "ExportNamedDeclaration":
        if (isNode(stmt.declaration)) this.declaration(stmt.declaration, true, false);
        else this.exportSpecifiers(stmt);
        break;
      case "ExportDefaultDeclaration":
        this.declaration(stmt.declaration, true, true);
        break;
      default:
        this.declaration(stmt, false, false);
    }
  }

  // ---- imports / exports -------------------------------------------------------------------

  private importDecl(decl: Node): void {
    const specifier = literalString(decl.source);
    if (specifier === null) return;
    const line = this.lines.lineOf(decl.start);
    const declTypeOnly = decl.importKind === "type";
    const specs = nodeArray(decl.specifiers);
    if (specs.length === 0) {
      this.imports.push({ local: "", imported: "*", specifier, typeOnly: declTypeOnly, line });
      return;
    }
    for (const s of specs) {
      const local = isNode(s.local) ? (s.local.name as string) : "";
      let imported: string;
      if (s.type === "ImportDefaultSpecifier") imported = "default";
      else if (s.type === "ImportNamespaceSpecifier") imported = "*";
      else imported = moduleExportName(s.imported) ?? local;
      this.imports.push({
        local,
        imported,
        specifier,
        typeOnly: declTypeOnly || s.importKind === "type",
        line,
      });
    }
  }

  private importEquals(decl: Node): void {
    const ref = decl.moduleReference;
    if (!isNode(ref) || ref.type !== "TSExternalModuleReference") return;
    const specifier = literalString(ref.expression);
    const local = isNode(decl.id) ? (decl.id.name as string) : "";
    if (specifier === null) return;
    this.imports.push({
      local,
      imported: "*",
      specifier,
      typeOnly: decl.importKind === "type",
      line: this.lines.lineOf(decl.start),
    });
  }

  private exportAll(decl: Node): void {
    const fromSpecifier = literalString(decl.source);
    if (fromSpecifier === null) return;
    const ns = moduleExportName(decl.exported);
    if (ns) this.exports.push({ exported: ns, local: "*", fromSpecifier });
    else this.exports.push({ exported: "*", fromSpecifier, star: true });
  }

  private exportSpecifiers(decl: Node): void {
    const fromSpecifier = literalString(decl.source) ?? undefined;
    for (const s of nodeArray(decl.specifiers)) {
      const local = moduleExportName(s.local);
      const exported = moduleExportName(s.exported) ?? local;
      if (!exported) continue;
      const entry: ParsedExport = { exported };
      if (local) entry.local = local;
      if (fromSpecifier !== undefined) entry.fromSpecifier = fromSpecifier;
      else if (local) this.exportedLocals.add(local);
      this.exports.push(entry);
    }
  }

  // ---- declarations ------------------------------------------------------------------------

  private declaration(decl: unknown, exported: boolean, isDefault: boolean): void {
    if (!isNode(decl)) return;
    switch (decl.type) {
      case "FunctionDeclaration": {
        const name = idName(decl) ?? (isDefault ? "default" : null);
        if (name === null) {
          this.fileRoots.push(decl);
          return;
        }
        this.noteExport(name, exported, isDefault);
        this.drafts.push(this.functionDraft(name, decl, decl, exported, true));
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const name = idName(decl) ?? (isDefault ? "default" : null);
        if (name === null) {
          this.fileRoots.push(decl);
          return;
        }
        this.noteExport(name, exported, isDefault);
        this.classDrafts(name, decl, exported);
        return;
      }
      case "TSInterfaceDeclaration": {
        const name = idName(decl);
        if (name === null) return;
        this.noteExport(name, exported, isDefault);
        this.interfaceDraft(name, decl, exported);
        return;
      }
      case "TSTypeAliasDeclaration": {
        const name = idName(decl);
        if (name === null) return;
        this.noteExport(name, exported, isDefault);
        this.typeDraft(name, "type", decl, [decl.typeParameters, decl.typeAnnotation], exported);
        return;
      }
      case "TSEnumDeclaration": {
        const name = idName(decl);
        if (name === null) return;
        this.noteExport(name, exported, isDefault);
        this.typeDraft(name, "enum", decl, [], exported);
        return;
      }
      case "VariableDeclaration":
        this.variableDecl(decl, exported);
        return;
      case "TSDeclareFunction":
      case "TSModuleDeclaration":
      case "TSNamespaceExportDeclaration":
      case "TSExportAssignment":
        return;
      default:
        if (isDefault) this.defaultExpression(decl);
        else this.fileRoots.push(decl);
    }
  }

  private noteExport(name: string, exported: boolean, isDefault: boolean): void {
    if (!exported) return;
    this.exports.push({ exported: isDefault ? "default" : name, local: name });
  }

  private defaultExpression(expr: Node): void {
    const e = unwrap(expr);
    if (!isNode(e)) return;
    if (e.type === "Identifier") {
      this.exports.push({ exported: "default", local: e.name as string });
      this.exportedLocals.add(e.name as string);
      return;
    }
    this.exports.push({ exported: "default", local: "default" });
    const fn = functionOf(e);
    if (fn) {
      this.drafts.push(this.functionDraft("default", fn, expr, true, true, e === fn ? undefined : [e]));
      return;
    }
    this.drafts.push({
      name: "default",
      kind: "const",
      exported: true,
      topLevel: true,
      range: { start: expr.start, end: expr.end },
      signature: "",
      complexityRoot: e,
      stmtRoot: e,
      exprBody: false,
      callRoots: [e],
      typeRoots: [],
      scopeRoots: [],
      heritage: [],
    });
  }

  private variableDecl(decl: Node, exported: boolean): void {
    if (decl.declare === true) return;
    const declarators = nodeArray(decl.declarations);
    for (const d of declarators) {
      const id = d.id;
      if (!isNode(id)) continue;
      if (id.type !== "Identifier") {
        if (exported) for (const n of patternNames(id)) this.exports.push({ exported: n, local: n });
        this.fileRoots.push(d.init);
        continue;
      }
      const name = id.name as string;
      const range = declarators.length === 1 ? decl : d;
      const fn = functionOf(d.init);
      const annotation = isNode(id.typeAnnotation) ? id.typeAnnotation : null;
      if (exported) this.exports.push({ exported: name, local: name });
      if (fn) {
        const wrapped = unwrap(d.init) === fn ? undefined : [d.init];
        this.drafts.push(this.functionDraft(name, fn, range, exported, true, wrapped, annotation));
      } else if (exported) {
        this.drafts.push({
          name,
          kind: "const",
          exported: true,
          topLevel: true,
          range: { start: range.start, end: range.end },
          signature:
            annotation && isNode(annotation.typeAnnotation)
              ? collapse(this.slice(annotation.typeAnnotation))
              : "",
          complexityRoot: d.init,
          stmtRoot: d.init,
          exprBody: false,
          callRoots: [d.init],
          typeRoots: [annotation],
          scopeRoots: [],
          heritage: [],
        });
      } else {
        this.fileRoots.push(d.init);
      }
    }
  }

  private slice(n: Node): string {
    return this.source.slice(n.start, n.end);
  }

  private functionDraft(
    name: string,
    fn: Node,
    range: { start: number; end: number },
    exported: boolean,
    topLevel: boolean,
    wrapperRoots?: unknown[],
    idAnnotation?: Node | null,
    member?: Node,
    classNode?: Node,
  ): Draft {
    const body = fn.body;
    const isMember = member !== undefined;
    return {
      name,
      kind: isMember ? "method" : functionKind(name, body),
      exported,
      topLevel,
      range: { start: range.start, end: range.end },
      signature: fnSignature(fn, this.source),
      complexityRoot: fn,
      stmtRoot: body,
      exprBody: isNode(body) && body.type !== "BlockStatement",
      callRoots: wrapperRoots ?? [member?.decorators, fn.params, body],
      typeRoots: [fn.typeParameters, fn.params, fn.returnType, idAnnotation],
      scopeRoots: [fn, classNode],
      heritage: [],
    };
  }

  private classDrafts(name: string, cls: Node, exported: boolean): void {
    const members = nodeArray(isNode(cls.body) ? cls.body.body : []);
    const heritage: Draft["heritage"] = [];
    const superName = chainName(cls.superClass);
    if (superName)
      heritage.push({
        kind: "extends",
        callee: superName,
        line: this.lines.lineOf((cls.superClass as Node).start),
      });
    for (const impl of nodeArray(cls.implements)) {
      const n = chainName(impl.expression);
      if (n) heritage.push({ kind: "implements", callee: n, line: this.lines.lineOf(impl.start) });
    }
    const methodDrafts: Draft[] = [];
    const plain: Node[] = [];
    for (const m of members) {
      const isMethod = m.type === "MethodDefinition" || m.type === "TSAbstractMethodDefinition";
      const key = memberKeyName(m);
      if (isMethod) {
        const fn = m.value;
        if (!isNode(fn) || key === null) continue;
        if (m.type === "MethodDefinition" && fn.type === "TSEmptyBodyFunctionExpression") continue; // overload signature
        const visible =
          m.accessibility !== "private" && m.accessibility !== "protected" && !key.startsWith("#");
        methodDrafts.push(
          this.functionDraft(`${name}.${key}`, fn, m, exported && visible, false, undefined, null, m, cls),
        );
        continue;
      }
      const fn = m.type === "PropertyDefinition" ? functionOf(m.value) : null;
      if (fn && key !== null) {
        const visible =
          m.accessibility !== "private" && m.accessibility !== "protected" && !key.startsWith("#");
        const d = this.functionDraft(
          `${name}.${key}`,
          fn,
          m,
          exported && visible,
          false,
          undefined,
          null,
          m,
          cls,
        );
        d.typeRoots.push(m.typeAnnotation);
        methodDrafts.push(d);
        continue;
      }
      plain.push(m);
    }
    this.drafts.push({
      name,
      kind: "class",
      exported,
      topLevel: true,
      range: { start: cls.start, end: cls.end },
      signature: "",
      complexityRoot: cls,
      stmtRoot: cls,
      exprBody: false,
      callRoots: [cls.decorators, cls.superClass, plain],
      typeRoots: [cls.typeParameters, cls.superTypeArguments, cls.implements, plain],
      scopeRoots: [cls],
      heritage,
    });
    this.drafts.push(...methodDrafts);
  }

  private interfaceDraft(name: string, decl: Node, exported: boolean): void {
    const heritage: Draft["heritage"] = [];
    for (const h of nodeArray(decl.extends)) {
      const n = chainName(h.expression);
      if (n) heritage.push({ kind: "extends", callee: n, line: this.lines.lineOf(h.start) });
    }
    this.typeDraft(
      name,
      "interface",
      decl,
      [decl.typeParameters, decl.extends, decl.body],
      exported,
      heritage,
    );
  }

  private typeDraft(
    name: string,
    kind: SymbolKind,
    decl: Node,
    typeRoots: unknown[],
    exported: boolean,
    heritage: Draft["heritage"] = [],
  ): void {
    this.drafts.push({
      name,
      kind,
      exported,
      topLevel: true,
      range: { start: decl.start, end: decl.end },
      signature: "",
      complexityRoot: null,
      stmtRoot: null,
      exprBody: false,
      callRoots: [],
      typeRoots,
      scopeRoots: [decl],
      heritage,
    });
  }
}

function idName(n: Node): string | null {
  return isNode(n.id) && typeof n.id.name === "string" ? n.id.name : null;
}

function literalString(n: unknown): string | null {
  return isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : null;
}

/** Name of an import/export specifier side: an Identifier or a string Literal. */
function moduleExportName(n: unknown): string | null {
  if (!isNode(n)) return null;
  if (n.type === "Identifier") return n.name as string;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  return null;
}

function collectCallSites(roots: unknown[], fromSymbol: string, lines: LineTable, out: ParsedSite[]): void {
  visit(roots, (n) => {
    if (n.type === "CallExpression" || n.type === "NewExpression") {
      const callee = chainName(n.callee);
      if (callee && callee !== "super") {
        const last = callee.slice(callee.lastIndexOf(".") + 1);
        const kind: SiteKind = n.type === "CallExpression" && HOOK_RE.test(last) ? "uses_hook" : "calls";
        out.push({ fromSymbol, kind, callee, line: lines.lineOf(n.start) });
      }
    } else if (n.type === "JSXOpeningElement") {
      const name = jsxName(n.name);
      if (name && /^[A-Z]/.test(name))
        out.push({ fromSymbol, kind: "renders", callee: name, line: lines.lineOf(n.start) });
    }
    return undefined;
  });
}

function collectTypeSites(
  roots: unknown[],
  scopeRoots: unknown[],
  fromSymbol: string,
  lines: LineTable,
  out: ParsedSite[],
): void {
  const typeParams = new Set<string>();
  visit(scopeRoots, (n) => {
    if (n.type === "TSTypeParameter" && isNode(n.name) && typeof n.name.name === "string")
      typeParams.add(n.name.name);
    return undefined;
  });
  visit(roots, (n) => {
    if (n.type === "TSTypeQuery" || n.type === "TSImportType") return false;
    if (n.type === "TSTypeReference") {
      const name = typeName(n.typeName);
      if (name && !typeParams.has(name.split(".")[0] as string)) {
        out.push({ fromSymbol, kind: "references_type", callee: name, line: lines.lineOf(n.start) });
      }
    }
    return undefined;
  });
}

function collectDynamicImports(roots: unknown[], lines: LineTable, out: ParsedImport[]): void {
  visit(roots, (n) => {
    if (n.type === "ImportExpression") {
      const specifier = literalString(n.source);
      if (specifier !== null) {
        out.push({ local: "", imported: "*", specifier, typeOnly: false, line: lines.lineOf(n.start) });
      }
    }
    return undefined;
  });
}

function compareSites(a: ParsedSite, b: ParsedSite): number {
  return a.line - b.line || cmp(a.fromSymbol, b.fromSymbol) || cmp(a.kind, b.kind) || cmp(a.callee, b.callee);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse one file's source text into symbols and unresolved syntax facts. Never reads from disk and
 * never throws: failures are reported in `errors`.
 *
 * Offsets in `bodies` are UTF-16 string offsets (what `String.prototype.slice` takes), because that
 * is what oxc reports for JS strings. Module-level code (top-level calls such as `app.get(...)`)
 * is attributed to the file id in `sites[].fromSymbol`.
 */
export function parseSource(repoRelPath: string, source: string): ParsedFile {
  const fileId = `file:${repoRelPath}`;
  const result: ParsedFile = {
    fileId,
    symbols: [],
    imports: [],
    exports: [],
    sites: [],
    bodies: new Map(),
    errors: [],
  };
  try {
    const lines = new LineTable(source);
    const parsed = parseRecovering(repoRelPath, source, langOf(repoRelPath), lines);
    result.errors = parsed.errors;
    const directives: string[] = [];
    for (const st of parsed.body) {
      if (st.type !== "ExpressionStatement" || typeof st.directive !== "string") break;
      directives.push(st.directive);
    }
    if (directives.length > 0) result.directives = directives;
    const ex = new Extractor(source, lines);
    ex.run(parsed.body);
    result.imports.push(...ex.imports);
    result.exports.push(...ex.exports);

    const seen = new Map<string, number>();
    const sites: ParsedSite[] = [];
    for (const d of ex.drafts) {
      const base = `sym:${repoRelPath}#${d.name}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}~${n}`;
      const m = measure(d.complexityRoot, d.stmtRoot, d.exprBody);
      const startLine = lines.lineOf(d.range.start);
      const endLine = lines.lineOf(Math.max(d.range.start, d.range.end - 1));
      result.symbols.push({
        id,
        fileId,
        name: d.name,
        kind: d.kind,
        exported: d.exported,
        signature: d.signature,
        startLine,
        endLine,
        loc: endLine - startLine + 1,
        complexity: m.complexity,
        stmtCount: m.stmtCount,
      });
      result.bodies.set(id, { start: d.range.start, end: d.range.end });
      collectCallSites(d.callRoots, id, lines, sites);
      collectTypeSites(d.typeRoots, d.scopeRoots, id, lines, sites);
      for (const h of d.heritage)
        sites.push({ fromSymbol: id, kind: h.kind, callee: h.callee, line: h.line });
      collectDynamicImports(d.callRoots, lines, result.imports);
    }
    collectCallSites(ex.moduleRoots, fileId, lines, sites);
    collectDynamicImports(ex.moduleRoots, lines, result.imports);
    result.imports.sort((a, b) => a.line - b.line);
    result.sites = sites.sort(compareSites);
  } catch (err) {
    result.errors.push(`parser failure: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

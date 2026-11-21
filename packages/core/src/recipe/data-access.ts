import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import picomatch from "picomatch";
import {
  type AdapterFileContext,
  type AdapterNode,
  cmp,
  enclosingSymbol,
  IdAllocator,
  stringConstants,
  stringValue,
  symbolForName,
} from "../adapters/framework.js";
import { fileIdOfSymId, nameOfSymId, tableId } from "../ids.js";
import { isNode, nodeArray, unwrap } from "../parse/ast.js";
import type { EdgeRecord, WorkspaceRecord } from "../types.js";
import { workspaceForPath } from "../workspace/index.js";
import { captureNode, captureNodes, type FileFacts, type RuleMatch, rootOf, whenApplies } from "./engine.js";
import { RegexRunner } from "./helpers/bounded-regex.js";
import { findFunction, returnedExpressions } from "./helpers/call-return.js";
import { classifyMethod } from "./helpers/method-classes.js";
import { type ModelNaming, normalizeModel, tableCandidates } from "./helpers/model-naming.js";
import { enclosingParameter } from "./helpers/resolve-names.js";
import { parseExpr } from "./helpers/snippet.js";
import {
  lineInText,
  looksLikeSql,
  placeholder,
  refTarget,
  type SqlRef,
  scanSql,
} from "./helpers/sql-text.js";
import {
  groupValue,
  matchText,
  runFailure,
  type TextMatch,
  type TextRun,
  textRuleMatches,
} from "./helpers/text-rules.js";
import { isTextRule, MAX_TEXT_FILES, type Recipe, type RecipeRule, type TextRecipeRule } from "./schema.js";

/**
 * Tables, and the code that reads and writes them, from a recipe (spec sections 5 and 9). The rules, the four
 * data-access helpers (`sql-text`, `text-rules`, `model-naming`, `method-classes`) and the generic `resolve-names`
 * and `const-strings` find them; no ORM or driver name appears here, every such word is in a recipe.
 *
 * - A `table` emit (or a text rule, or `CREATE TABLE` in SQL text) declares a table node `table:<repo>:<name>`.
 * - A `read` or `write` emit (or SQL text) adds an edge from the symbol holding the code (the file for module-level
 *   code) to the table: `high` when the table was resolved through a binding, a model or a declared name, `low` when
 *   only a name matched, or when several tables fit.
 * - A table named only at run time is a table node `{<expression>}` with `data.reason`, and its edges are `low`.
 *   It is never guessed.
 */

const kindOf = (n: SgNode): string => String(n.kind());
const named = (n: SgNode): SgNode[] => n.children().filter((c) => c.isNamed() && kindOf(c) !== "comment");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function unparen(n: SgNode): SgNode {
  let x = n;
  while (kindOf(x) === "parenthesized_expression" || kindOf(x) === "non_null_expression") {
    const k = named(x)[0];
    if (!k) break;
    x = k;
  }
  return x;
}

// ---------------------------------------------------------------------------------------------------------
// Text files

const MAX_TEXT_BYTES = 1 << 20;

/** Tracked and untracked-but-not-ignored files of the repo that match the globs, with their text, in path order. */
export function listTextFiles(root: string, globs: readonly string[]): { path: string; text: string }[] {
  if (globs.length === 0) return [];
  let listed: string[];
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  for (const p of [...new Set(listed)].sort(cmp)) {
    if (out.length >= MAX_TEXT_FILES) break;
    if (!picomatch.isMatch(p, [...globs], { dot: true })) continue;
    try {
      const abs = join(root, p);
      // A symbolic link, or a path that resolves outside the repo (a linked directory), is never read.
      if (lstatSync(abs).isSymbolicLink()) continue;
      const real = realpathSync(abs);
      if (!real.startsWith(realRoot + sep)) continue;
      const text = readFileSync(real, "utf8");
      if (text.length <= MAX_TEXT_BYTES) out.push({ path: p, text });
    } catch {
      // deleted since it was listed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Model

interface TableNode {
  id: string;
  name: string;
  runtime: boolean;
  reason?: string;
  file: AdapterFileContext;
  data: Record<string, unknown>;
}

interface Hit {
  table: TableNode;
  conf: "high" | "low";
}

interface Access {
  kind: "reads" | "writes";
  file: AdapterFileContext;
  src: string;
  line: number;
  table: TableNode;
  conf: "high" | "low";
}

export interface DataAccessArgs {
  repo: string;
  root: string;
  workspaces: readonly WorkspaceRecord[];
  recipe: Recipe | null;
  files: readonly { file: AdapterFileContext; facts: FileFacts | undefined }[];
  resolver: AdapterFileContext["resolver"];
  fileOf: (fileId: string) => AdapterFileContext | undefined;
}

/** True when the recipe declares anything this pass does. */
export function hasDataAccess(recipe: Recipe | null): boolean {
  if (!recipe) return false;
  return (
    recipe.rules.some((r) => isTextRule(r) || ["table", "read", "write"].includes(r.emit.kind)) ||
    recipe.helpers.includes("sql-text")
  );
}

/** Whether `sql-text` should look at a file (the glob checks and a cheap text test, never the syntax tree). */
export function sqlApplies(recipe: Recipe, path: string, source: string): boolean {
  if (!recipe.helpers.includes("sql-text")) return false;
  const sql = recipe.sql;
  if (sql?.files && !picomatch.isMatch(path, sql.files, { dot: true })) return false;
  if (sql?.exclude && picomatch.isMatch(path, sql.exclude, { dot: true })) return false;
  if (looksLikeSql(source)) return true;
  return (sql?.tags ?? []).some((t) => source.includes(t));
}

export function applyDataAccess(args: DataAccessArgs): { nodes: AdapterNode[]; edges: EdgeRecord[] } {
  const recipe = args.recipe;
  if (!recipe || !hasDataAccess(recipe)) return { nodes: [], edges: [] };
  return new DataAccess(args, recipe).run();
}

class DataAccess {
  private readonly nodes: TableNode[] = [];
  private readonly byName = new Map<string, TableNode>();
  private readonly bySym = new Map<string, TableNode>();
  private readonly byExport = new Map<string, TableNode[]>();
  private readonly byModel = new Map<string, TableNode[]>();
  private readonly alloc = new IdAllocator();
  private readonly accesses: Access[] = [];
  private readonly consts = new Map<string, Map<string, string>>();
  private readonly runner = new RegexRunner();
  /** Rules skipped for the rest of the run (a recipe regex that timed out or did not compile). */
  private readonly skipped = new Set<string>();
  private readonly naming: ModelNaming | undefined;
  private readonly passthrough: ReadonlySet<string>;

  constructor(
    private readonly a: DataAccessArgs,
    private readonly recipe: Recipe,
  ) {
    this.naming = recipe.models;
    this.passthrough = new Set(recipe.tablePassthrough ?? []);
  }

  run(): { nodes: AdapterNode[]; edges: EdgeRecord[] } {
    try {
      const sqlRefs = this.sqlCandidates();
      this.tablesFromRules();
      this.tablesFromText();
      this.tablesFromSqlFiles();
      for (const c of sqlRefs) for (const r of c.refs) if (r.kind === "create") this.tableFromSql(c, r);
      this.accessesFromRules();
      for (const c of sqlRefs) for (const r of c.refs) if (r.kind !== "create") this.accessFromSql(c, r);
      return { nodes: this.buildNodes(), edges: this.buildEdges() };
    } finally {
      this.runner.close();
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Tables

  /** Adds a table; a table of the same name that is not a binding is the same table. */
  private addTable(
    name: string,
    file: AdapterFileContext,
    data: Record<string, unknown>,
    opts: {
      model?: string | undefined;
      exportName?: string | undefined;
      sym?: string | null;
      binding?: boolean;
    },
  ): TableNode {
    const key = name.toLowerCase();
    let t = opts.binding ? undefined : this.byName.get(key);
    if (!t) {
      t = {
        id: this.alloc.take(tableId(this.a.repo, name)),
        name,
        runtime: false,
        file,
        data,
      };
      this.nodes.push(t);
      if (!this.byName.has(key)) this.byName.set(key, t);
    }
    if (opts.sym) this.bySym.set(opts.sym, t);
    if (opts.exportName) push(this.byExport, opts.exportName, t);
    for (const m of [opts.model, opts.exportName]) if (m) push(this.byModel, normalizeModel(m), t);
    return t;
  }

  private runtimeTable(expr: string, reason: string, file: AdapterFileContext, line: number): TableNode {
    const name = `{${expr}}`;
    const hit = this.byName.get(name.toLowerCase());
    if (hit) return hit;
    const t: TableNode = {
      id: this.alloc.take(tableId(this.a.repo, name)),
      name,
      runtime: true,
      reason,
      file,
      data: { name, reason, file: file.path, line },
    };
    this.nodes.push(t);
    this.byName.set(name.toLowerCase(), t);
    return t;
  }

  private tablesFromRules(): void {
    for (const { file, facts } of this.a.files) {
      if (!facts) continue;
      const order = new Map(this.recipe.rules.map((r, i) => [r.id, i]));
      const ms = facts.matches
        .filter((m) => m.rule.emit.kind === "table")
        .sort(
          (x, y) =>
            x.node.range().start.index - y.node.range().start.index ||
            (order.get(x.rule.id) ?? 0) - (order.get(y.rule.id) ?? 0),
        );
      for (const m of ms) {
        if (m.rule.emit.kind !== "table") continue;
        this.tableFromMatch(file, m, m.rule.emit);
      }
    }
  }

  private tableFromMatch(
    file: AdapterFileContext,
    m: RuleMatch,
    emit: Extract<RecipeRule["emit"], { kind: "table" }>,
  ): void {
    const line = m.node.range().start.line + 1;
    const names = Array.isArray(emit.name) ? emit.name : [emit.name];
    let name: string | null = null;
    let runtimeExpr: SgNode | undefined;
    for (const c of names) {
      const t = this.textOf(file, m, c);
      if (t !== null) {
        name = t;
        break;
      }
      runtimeExpr ??= captureNode(m, c);
    }
    if (name === null) {
      if (runtimeExpr) this.runtimeTable(runtimeExpr.text(), runtimeReason(runtimeExpr), file, line);
      return;
    }
    const model = emit.model ? (this.textOf(file, m, emit.model, true) ?? undefined) : undefined;
    const decl = emit.binding ? declaredIdent(m.node) : null;
    const local = decl?.text();
    const pf = file.parsed;
    const exportName = local ? exportNameOf(m.node, local, pf) : undefined;
    const sym = local ? (pf?.symbols.find((s) => s.name === local)?.id ?? null) : null;
    const declLine = decl ? (decl.parent()?.range().start.line ?? line - 1) + 1 : line;
    const ctx: FieldContext = {
      name,
      file: file.path,
      line: declLine,
      exportName: exportName ?? null,
      symbol: sym,
      className: classOfDecorator(m.node),
      capture: (c) => this.captureValue(file, m, c),
      keys: (c) => objectKeys(captureNode(m, c)),
    };
    const data = tableData(emit.data, ctx);
    this.addTable(name, file, data, { model, exportName, sym, binding: emit.binding === true });
  }

  private tablesFromText(): void {
    const rules = this.recipe.rules.filter(isTextRule);
    // A text rule is its own request for the helper: listing `text-rules` is not required (#367).
    if (rules.length === 0) return;
    const files = listTextFiles(this.a.root, [...new Set(rules.flatMap((r) => r.files))]);
    const anchors = this.anchors();
    for (const rule of rules) {
      for (const f of files) {
        if (this.skipped.has(rule.id)) break;
        if (!textRuleMatches(rule, f.path)) continue;
        const ws = workspaceForPath([...this.a.workspaces], f.path);
        if (!whenApplies(rule.when, ws, this.a.workspaces)) continue;
        const anchor = anchors.get(ws.id);
        if (!anchor) continue;
        // The regex is the recipe's: it runs in the runner's worker under a time budget.
        const r = matchText(this.runner, rule, f.text);
        if (!r.ok) {
          this.skipRule(rule.id, r);
          break;
        }
        for (const m of r.matches) this.tableFromText(anchor, rule, f.path, m);
      }
    }
  }

  /** Skips a rule for the rest of the run, with one stderr line (never stdout: hooks print JSON there). */
  private skipRule(id: string, r: Extract<TextRun, { ok: false }>): void {
    if (this.skipped.has(id)) return;
    this.skipped.add(id);
    process.stderr.write(`Gantry: recipe rule ${id} skipped: ${runFailure(r, this.runner)}\n`);
  }

  /** The first extracted file of each workspace: a table declared in a text file belongs to it. */
  private anchors(): Map<string, AdapterFileContext> {
    const out = new Map<string, AdapterFileContext>();
    for (const { file } of this.a.files) if (!out.has(file.ws.id)) out.set(file.ws.id, file);
    return out;
  }

  /** `CREATE TABLE` in the `.sql` files the recipe names. */
  private tablesFromSqlFiles(): void {
    const globs = this.recipe.sql?.sqlFiles;
    if (!globs?.length || !this.recipe.helpers.includes("sql-text")) return;
    const anchors = this.anchors();
    for (const f of listTextFiles(this.a.root, globs)) {
      const anchor = anchors.get(workspaceForPath([...this.a.workspaces], f.path).id);
      if (!anchor) continue;
      for (const r of scanSql(f.text)) {
        const t = r.kind === "create" ? refTarget(r.ref) : null;
        if (!t || !("name" in t)) continue;
        const line = 1 + lineInText(f.text, r.offset);
        this.addTable(t.name, anchor, { name: t.name, file: f.path, line }, {});
      }
    }
  }

  private tableFromText(anchor: AdapterFileContext, rule: TextRecipeRule, path: string, m: TextMatch): void {
    const names = Array.isArray(rule.emit.name) ? rule.emit.name : [rule.emit.name];
    const name = names.map((r) => groupValue(r, m)).find((x) => x !== "");
    if (!name) return;
    const model = rule.emit.model ? groupValue(rule.emit.model, m) || undefined : undefined;
    const ctx: FieldContext = {
      name,
      file: path,
      line: m.line,
      exportName: null,
      symbol: null,
      className: null,
      capture: (c) => (c.startsWith("$") ? groupValue(c, m) : c),
      keys: () => [],
    };
    this.addTable(name, anchor, tableData(rule.emit.data, ctx), { model });
  }

  // ------------------------------------------------------------------------------------------------------
  // Names

  /** The text a capture stands for: a literal, a string's value, a constant's value, or the text of an identifier when `ident`. */
  private textOf(file: AdapterFileContext, m: RuleMatch, c: string, ident = false): string | null {
    if (c.startsWith("=")) return c.slice(1);
    if (c === "@class") return classOfDecorator(m.node);
    const n = captureNode(m, c);
    if (!n) return null;
    const s = this.constText(file, n);
    if (s !== null) return s;
    return ident && kindOf(n).endsWith("identifier") ? n.text() : null;
  }

  private captureValue(file: AdapterFileContext, m: RuleMatch, c: string): unknown {
    if (c.startsWith("$")) {
      const n = captureNode(m, c);
      if (!n) return null;
      return this.constText(file, n) ?? n.text();
    }
    return c.startsWith("=") ? c.slice(1) : c;
  }

  private constsOf(file: AdapterFileContext): Map<string, string> {
    let c = this.consts.get(file.fileId);
    if (!c) {
      c = stringConstants(file.program());
      this.consts.set(file.fileId, c);
    }
    return c;
  }

  /** A string literal, a template without substitutions, or a name (also `ns.name`) bound to a constant string. */
  private constText(file: AdapterFileContext, node: SgNode, depth = 0): string | null {
    const n = unparen(node);
    const k = kindOf(n);
    if (k === "string" || k === "template_string") {
      const e = parseExpr(n.text());
      return e ? stringValue(e) : null;
    }
    if (depth > 3) return null;
    if (k === "identifier") {
      const local = this.constsOf(file).get(n.text());
      if (local !== undefined) return local;
      const sym = symbolForName(file.parsed, file.fileId, n.text(), file.resolver);
      const fileId = sym ? fileIdOfSymId(sym) : undefined;
      const target = fileId ? this.a.fileOf(fileId) : undefined;
      return target ? (this.constsOf(target).get(nameOfSymId(sym as string) ?? "") ?? null) : null;
    }
    if (k === "member_expression") {
      const hit = this.namespaceMember(file, n);
      if (!hit) return null;
      return this.constsOf(hit.file).get(hit.name) ?? null;
    }
    return null;
  }

  /** `ns.member` where `ns` is a namespace import: the file it points to and the member name. */
  private namespaceMember(
    file: AdapterFileContext,
    n: SgNode,
  ): { file: AdapterFileContext; name: string; sym: string | null } | null {
    const obj = n.field("object");
    const prop = n.field("property");
    if (!obj || !prop || kindOf(obj) !== "identifier") return null;
    const ns = file.parsed?.imports.find((i) => i.local === obj.text() && i.imported === "*");
    if (!ns) return null;
    const target = file.resolver.resolveSpecifier(file.fileId, ns.specifier);
    if (target.kind !== "file") return null;
    const tf = this.a.fileOf(target.fileId);
    if (!tf) return null;
    return { file: tf, name: prop.text(), sym: file.resolver.resolveSymbol(target.fileId, prop.text()) };
  }

  // ------------------------------------------------------------------------------------------------------
  // Resolving a table

  /** The tables a model (entity, class, collection, export) name stands for. */
  private resolveModel(model: string): TableNode[] {
    const viaModel = this.byModel.get(normalizeModel(model));
    if (viaModel) return viaModel;
    for (const c of tableCandidates(model, this.naming)) {
      const t = this.byName.get(c.toLowerCase());
      if (t && !t.runtime) return [t];
    }
    return [];
  }

  private resolveTableName(name: string): TableNode[] {
    const direct = this.resolveModel(name);
    if (direct.length > 0) return direct;
    // `users as u`, `users u`: the first word is the table.
    const first = /^\s*([A-Za-z_][\w.$]*)\s+(?:as\s+)?\w+\s*$/i.exec(name)?.[1];
    return first ? this.resolveModel(first) : [];
  }

  private hitsOf(tables: TableNode[], conf: "high" | "low" = "high"): Hit[] {
    return tables.map((table) => ({ table, conf: tables.length > 1 ? "low" : conf }));
  }

  /** A table expression: a string, a bound identifier, `ns.member`, a passthrough call, or a name built at run time. */
  private tablesOfExpr(file: AdapterFileContext, node: SgNode, depth = 0): Hit[] {
    const n = unparen(node);
    if (depth > 4) return [];
    const k = kindOf(n);
    const line = n.range().start.line + 1;
    if (k === "string") {
      const s = this.constText(file, n);
      return s === null ? [] : this.hitsOf(this.resolveTableName(s));
    }
    if (k === "template_string") {
      const s = this.constText(file, n);
      if (s !== null) return this.hitsOf(this.resolveTableName(s));
      return [
        { table: this.runtimeTable(n.text(), "table name is built at runtime", file, line), conf: "low" },
      ];
    }
    if (k === "call_expression") {
      const fn = n.field("function");
      if (!fn || !this.passthrough.has(fn.text())) return [];
      const first = n.field("arguments") ? named(n.field("arguments") as SgNode)[0] : undefined;
      return first ? this.tablesOfExpr(file, first, depth + 1) : [];
    }
    if (k === "identifier") {
      const name = n.text();
      const aliased = this.localPassthrough(file, name);
      if (aliased) return this.tablesOfExpr(file, aliased, depth + 1);
      const sym = symbolForName(file.parsed, file.fileId, name, file.resolver);
      if (sym) {
        const t = this.bySym.get(sym);
        return t ? [{ table: t, conf: "high" }] : [];
      }
      const imp = file.parsed?.imports.find((i) => i.local === name && i.imported !== "*");
      if (imp)
        return (this.byExport.get(imp.imported) ?? []).map((table) => ({ table, conf: "low" as const }));
      const param = enclosingParameter(n, name);
      if (param)
        return [
          { table: this.runtimeTable(name, "table name is a function parameter", file, line), conf: "low" },
        ];
      // `const { User } = await import("./model")`: a binding with no static import. Only a name that is exactly a
      // table binding's export name counts, and only in a file that imports dynamically.
      if (file.source.includes("import("))
        return (this.byExport.get(name) ?? []).map((table) => ({ table, conf: "low" as const }));
      return [];
    }
    if (k === "member_expression") {
      const hit = this.namespaceMember(file, n);
      if (!hit) return [];
      const t = hit.sym ? this.bySym.get(hit.sym) : undefined;
      if (t) return [{ table: t, conf: "high" }];
      return (this.byExport.get(hit.name) ?? []).map((table) => ({ table, conf: "low" as const }));
    }
    return [];
  }

  /** `const a = alias(users, "a")`: the call a constant of this file holds when its function is a passthrough. */
  private localPassthrough(file: AdapterFileContext, name: string): SgNode | null {
    if (this.passthrough.size === 0) return null;
    const root = rootOf(file);
    const decl = root?.find({
      rule: { kind: "variable_declarator", has: { field: "name", regex: `^${escapeRe(name)}$` } },
    });
    const v = decl?.field("value");
    if (!v) return null;
    const c = unparen(v);
    const fn = kindOf(c) === "call_expression" ? c.field("function") : null;
    return fn && this.passthrough.has(fn.text()) ? c : null;
  }

  // ------------------------------------------------------------------------------------------------------
  // Reads and writes from rules

  private accessesFromRules(): void {
    const order = new Map(this.recipe.rules.map((r, i) => [r.id, i]));
    for (const { file, facts } of this.a.files) {
      if (!facts) continue;
      const ms = facts.matches
        .filter((m) => m.rule.emit.kind === "read" || m.rule.emit.kind === "write")
        .sort(
          (x, y) =>
            x.node.range().start.index - y.node.range().start.index ||
            (order.get(x.rule.id) ?? 0) - (order.get(y.rule.id) ?? 0),
        );
      for (const m of ms) this.accessFromMatch(file, m);
    }
  }

  private accessFromMatch(file: AdapterFileContext, m: RuleMatch): void {
    const emit = m.rule.emit;
    if (emit.kind !== "read" && emit.kind !== "write") return;
    if (this.skipped.has(m.rule.id)) return;
    if (emit.method) {
      const method = this.textOf(file, m, emit.method, true);
      if (!method || classifyMethod(method, this.recipe.methods) !== emit.kind) return;
    }
    const hits: Hit[] = [];
    if (emit.table) for (const t of captureNodes(m, emit.table)) hits.push(...this.tablesOfExpr(file, t));
    if (emit.model) {
      for (const n of captureNodes(m, emit.model))
        hits.push(...this.hitsOf(this.resolveModel(this.constText(file, n) ?? n.text())));
    }
    if (hits.length === 0 && emit.receiver && emit.receiverDecl) {
      const recv = captureNode(m, emit.receiver);
      const decl = recv ? this.receiverDecl(file, recv) : null;
      if (decl) {
        for (const tpl of emit.receiverDecl) {
          // The pattern is the recipe's: it runs in the runner's worker under a time budget.
          const r = this.runner.run(tpl.replaceAll("{prop}", escapeRe(decl.prop)), "s", decl.text, true);
          if (!r.ok) {
            this.skipRule(m.rule.id, r);
            return;
          }
          const model = r.matches[0]?.groups[1];
          const tables = model ? this.resolveModel(model) : [];
          if (tables.length > 0) {
            hits.push(...this.hitsOf(tables));
            break;
          }
        }
      }
    }
    // The line of a call is the line of its method name, so a chain `db\n.select()\n.from(t)` reports the `.from`.
    const callee = kindOf(m.node) === "call_expression" ? m.node.field("function") : null;
    const at = callee && kindOf(callee) === "member_expression" ? callee.field("property") : null;
    const line = (at ?? m.node).range().start.line + 1;
    const src = enclosingSymbol(file.parsed, file.fileId, m.node.range().start.index);
    for (const h of hits)
      this.accesses.push({
        kind: emit.kind === "read" ? "reads" : "writes",
        file,
        src,
        line,
        table: h.table,
        conf: h.conf,
      });
  }

  /** The declaration text and member name of a receiver: `this.p` (the enclosing class), `x.p` or `x`. */
  private receiverDecl(file: AdapterFileContext, recv: SgNode): { text: string; prop: string } | null {
    const r = unparen(recv);
    if (kindOf(r) === "member_expression") {
      const obj = r.field("object");
      const prop = r.field("property")?.text();
      if (!obj || !prop) return null;
      if (kindOf(obj) === "this") {
        const text = enclosingClassText(r);
        return text ? { text, prop } : null;
      }
      if (kindOf(obj) === "identifier") {
        const text = this.declText(file, obj, obj.text());
        return text ? { text, prop } : null;
      }
      return null;
    }
    if (kindOf(r) === "identifier") {
      const text = this.declText(file, r, r.text());
      return text ? { text, prop: r.text() } : null;
    }
    return null;
  }

  /** The text of the statement or parameter that declares `name` nearest before `use`, else of its imported declaration. */
  private declText(file: AdapterFileContext, use: SgNode, name: string, depth = 0): string | null {
    const root = rootOf(file);
    if (!root || depth > 2) return null;
    const re = `^${escapeRe(name)}$`;
    const found = root.findAll({
      rule: {
        any: [
          { kind: "required_parameter", has: { field: "pattern", regex: re } },
          { kind: "optional_parameter", has: { field: "pattern", regex: re } },
          { kind: "variable_declarator", has: { field: "name", regex: re } },
        ],
      },
    });
    const at = use.range().start.index;
    let best: SgNode | undefined;
    for (const d of found) if (d.range().start.index <= at) best = d;
    if (!best && found[0]) best = found[0];
    if (best) {
      const p = best.parent();
      return kindOf(best) === "variable_declarator" && p ? p.text() : best.text();
    }
    const sym = symbolForName(file.parsed, file.fileId, name, file.resolver);
    const fileId = sym ? fileIdOfSymId(sym) : undefined;
    const tf = fileId ? this.a.fileOf(fileId) : undefined;
    return tf && tf !== file ? this.declText(tf, use, nameOfSymId(sym as string) ?? name, depth + 1) : null;
  }

  // ------------------------------------------------------------------------------------------------------
  // SQL text

  private sqlCandidates(): SqlCand[] {
    const recipe = this.recipe;
    if (!recipe.helpers.includes("sql-text")) return [];
    const tags = new Set(recipe.sql?.tags ?? []);
    const out: SqlCand[] = [];
    for (const { file } of this.a.files) {
      if (!sqlApplies(recipe, file.path, file.source)) continue;
      const root = rootOf(file);
      if (!root) continue;
      for (const n of root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } })) {
        let text = "";
        const exprs: SgNode[] = [];
        if (kindOf(n) === "template_string") {
          for (const c of n.children()) {
            const ck = kindOf(c);
            if (ck === "template_substitution") {
              const e = named(c)[0];
              if (!e) continue;
              exprs.push(e);
              text += placeholder(exprs.length - 1);
            } else if (ck !== "`") text += c.text();
          }
        } else text = n.text().slice(1, -1);
        const p = n.parent();
        const tagged =
          kindOf(n) === "template_string" &&
          p !== null &&
          kindOf(p) === "call_expression" &&
          tags.has(p.field("function")?.text().replace(/^.*\./, "") ?? "");
        if (!tagged && !looksLikeSql(text)) continue;
        const refs = scanSql(text);
        if (refs.length === 0) continue;
        out.push({ file, node: n, text, exprs, line: n.range().start.line + 1, refs });
      }
    }
    return out;
  }

  /** The value of a substitution: a constant, or the string a function returns (its own substitutions become `#`). */
  private substValue(file: AdapterFileContext, expr: SgNode): string | null {
    const c = this.constText(file, expr);
    if (c !== null) return c;
    if (kindOf(expr) !== "call_expression" || !this.recipe.helpers.includes("call-return")) return null;
    const fn = expr.field("function");
    let target: { file: AdapterFileContext; name: string } | null = null;
    if (fn && kindOf(fn) === "identifier") {
      const sym = symbolForName(file.parsed, file.fileId, fn.text(), file.resolver);
      const fileId = sym ? fileIdOfSymId(sym) : undefined;
      const tf = fileId ? this.a.fileOf(fileId) : undefined;
      if (tf && sym) target = { file: tf, name: nameOfSymId(sym) ?? "" };
    } else if (fn && kindOf(fn) === "member_expression") {
      const hit = this.namespaceMember(file, fn);
      if (hit) target = { file: hit.file, name: hit.name };
    }
    const root = target ? rootOf(target.file) : null;
    const f = target && root ? findFunction(root, target.name) : null;
    const ret = f ? returnedExpressions(f)[0] : undefined;
    if (!target || !ret) return null;
    const r = unparen(ret);
    if (kindOf(r) === "string") return this.constText(target.file, r);
    if (kindOf(r) !== "template_string") return null;
    return r
      .children()
      .map((c) => {
        const ck = kindOf(c);
        if (ck === "`") return "";
        if (ck !== "template_substitution") return c.text();
        const e = named(c)[0];
        return (e ? this.constText(target.file, e) : null) ?? "#";
      })
      .join("");
  }

  private nameOfSqlRef(c: SqlCand, ref: SqlRef): { name: string } | { expr: SgNode } | null {
    const t = refTarget(ref.ref);
    if (!t) return null;
    if ("name" in t) return { name: t.name };
    const expr = c.exprs[t.placeholder];
    if (!expr) return null;
    const v = this.substValue(c.file, expr);
    return v ? { name: v.replace(/^.*\./, "") } : { expr };
  }

  private tableFromSql(c: SqlCand, ref: SqlRef): void {
    const n = this.nameOfSqlRef(c, ref);
    if (!n || !("name" in n) || n.name === "#" || n.name === "") return;
    const line = c.line + lineInText(c.text, ref.offset);
    this.addTable(n.name, c.file, { name: n.name, file: c.file.path, line }, {});
  }

  private accessFromSql(c: SqlCand, ref: SqlRef): void {
    const n = this.nameOfSqlRef(c, ref);
    if (!n) return;
    const line = c.line + lineInText(c.text, ref.offset);
    const src = enclosingSymbol(c.file.parsed, c.file.fileId, c.node.range().start.index);
    const kind = ref.kind === "read" ? "reads" : "writes";
    if ("expr" in n) {
      const t = this.runtimeTable(n.expr.text(), runtimeReason(n.expr), c.file, line);
      this.accesses.push({ kind, file: c.file, src, line, table: t, conf: "low" });
      return;
    }
    // Only a table that is declared somewhere is a table: catalogs and names with no declaration are skipped.
    const t = this.byName.get(n.name.toLowerCase());
    if (!t || t.runtime) return;
    this.accesses.push({ kind, file: c.file, src, line, table: t, conf: "high" });
  }

  // ------------------------------------------------------------------------------------------------------
  // Output

  private buildNodes(): AdapterNode[] {
    return this.nodes
      .map((t) => ({
        id: t.id,
        kind: "table" as const,
        ws: t.file.ws.id,
        label: t.name,
        fileId: t.file.fileId,
        data: t.data,
      }))
      .sort((x, y) => cmp(x.id, y.id));
  }

  private buildEdges(): EdgeRecord[] {
    const acc = new Map<string, EdgeRecord & { lines: Set<number>; path: string }>();
    for (const u of this.accesses) {
      const k = `${u.file.fileId}\0${u.src}\0${u.table.id}\0${u.kind}`;
      let e = acc.get(k);
      if (!e) {
        e = {
          src: u.src,
          dst: u.table.id,
          kind: u.kind,
          confidence: u.conf,
          count: 0,
          evidence: [],
          fileId: u.file.fileId,
          lines: new Set(),
          path: u.file.path,
        };
        acc.set(k, e);
      }
      if (u.conf === "high") e.confidence = "high";
      e.lines.add(u.line);
      e.count++;
    }
    const edges: EdgeRecord[] = [...acc.values()].map(({ lines, path, ...e }) => ({
      ...e,
      evidence: [...lines].sort((x, y) => x - y).map((l) => `${path}:${l}`),
    }));
    edges.sort(
      (x, y) => cmp(x.fileId, y.fileId) || cmp(x.src, y.src) || cmp(x.dst, y.dst) || cmp(x.kind, y.kind),
    );
    return edges;
  }
}

interface SqlCand {
  file: AdapterFileContext;
  node: SgNode;
  text: string;
  exprs: SgNode[];
  line: number;
  refs: SqlRef[];
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) {
    if (!l.includes(v)) l.push(v);
  } else m.set(k, [v]);
}

// ---------------------------------------------------------------------------------------------------------
// Syntax facts

/** Why an expression cannot name a table before run time. */
function runtimeReason(n: SgNode): string {
  return kindOf(n) === "identifier" && enclosingParameter(n, n.text())
    ? "table name is a function parameter"
    : "table name is built at runtime";
}

function declaredIdent(n: SgNode): SgNode | null {
  const p = n.parent();
  return p &&
    kindOf(p) === "variable_declarator" &&
    p.field("value")?.range().start.index === n.range().start.index
    ? p.field("name")
    : null;
}

/** The name `local` is exported under: itself in `export const x`, else the matching export of the file. */
function exportNameOf(n: SgNode, local: string, pf: AdapterFileContext["parsed"]): string {
  const decl = n.parent()?.parent();
  const st = decl?.parent();
  if (st && kindOf(st) === "export_statement" && !/^export\s+default\b/.test(st.text())) return local;
  const exp = pf?.exports.find((e) => e.local === local && e.fromSpecifier === undefined && !e.star);
  return exp?.exported ?? local;
}

function classOfDecorator(n: SgNode): string | null {
  const p = n.parent();
  const cls = p && kindOf(p) === "export_statement" ? p.field("declaration") : p;
  if (cls && (kindOf(cls) === "class_declaration" || kindOf(cls) === "abstract_class_declaration"))
    return cls.field("name")?.text() ?? null;
  return null;
}

function enclosingClassText(n: SgNode): string | null {
  for (let a = n.parent(); a; a = a.parent()) {
    const k = kindOf(a);
    if (k === "class_declaration" || k === "class" || k === "abstract_class_declaration") return a.text();
  }
  return null;
}

/** Property names of an object literal, or of the one a function returns (`(t) => ({ id: t.text() })`). */
function objectKeys(n: SgNode | undefined): string[] {
  if (!n) return [];
  let v: unknown = unwrap(parseExpr(n.text()));
  if (isNode(v) && (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression")) {
    let body = unwrap(v.body);
    if (isNode(body) && body.type === "BlockStatement") {
      const ret = nodeArray(body.body).find((s) => s.type === "ReturnStatement");
      body = unwrap(ret?.argument);
    }
    v = body;
  }
  if (!isNode(v) || v.type !== "ObjectExpression") return [];
  const out: string[] = [];
  for (const p of nodeArray(v.properties)) {
    if (p.type !== "Property") continue;
    const k = unwrap(p.key);
    const name =
      isNode(k) && k.type === "Identifier" && p.computed !== true ? (k.name as string) : stringValue(k);
    if (name !== null) out.push(name);
  }
  return out;
}

interface FieldContext {
  name: string;
  file: string;
  line: number;
  exportName: string | null;
  symbol: string | null;
  className: string | null;
  capture: (c: string) => unknown;
  keys: (c: string) => string[];
}

/** The node data of a table: `data` fields in the recipe's order, with `name` first unless the recipe places it. */
function tableData(
  spec: Record<string, string | { keysOf: string }> | undefined,
  ctx: FieldContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(spec ?? {});
  if (!entries.some(([k]) => k === "name")) out.name = ctx.name;
  for (const [k, v] of entries) {
    if (typeof v !== "string") out[k] = ctx.keys(v.keysOf);
    else if (v === "@name") out[k] = ctx.name;
    else if (v === "@exportName") out[k] = ctx.exportName;
    else if (v === "@symbol") out[k] = ctx.symbol;
    else if (v === "@file") out[k] = ctx.file;
    else if (v === "@line") out[k] = ctx.line;
    else if (v === "@class") out[k] = ctx.className;
    else if (v.startsWith("$")) out[k] = ctx.capture(v);
    else out[k] = v.startsWith("=") ? v.slice(1) : v;
  }
  if (entries.length === 0) {
    out.file = ctx.file;
    out.line = ctx.line;
  }
  return out;
}

// Spike engine (data access): a copy of the route spike's engine (since removed) extended with four generic
// helpers (SQL text, text rules, model naming, method classes) and the `table` and `access` emits. It runs a recipe
// over a repo and returns tables, reads and writes (and, as before, routes and endpoints). It holds no ORM name:
// every ORM word lives in a recipe. Not production code; see ../v2-data-access.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import go from "@ast-grep/lang-go";
import { Lang, parse, type Rule, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

registerDynamicLanguage({ go });

export type Language = "typescript" | "go";
/** A capture: `$NAME` (a metavariable of the rule) or `=text` (a literal). */
export type Capture = string;

export type Emit =
  /** A router instance (the match is its constructor expression); `base` is a base path of its own. */
  | { kind: "router"; base?: Capture }
  /** `child` is reachable under `parent` at `prefix`. `childIsScope`: the child is a function whose first parameter is the router. */
  | { kind: "mount"; parent: Capture; child: Capture; prefix?: Capture; childIsScope?: boolean }
  /** A handler registration. `pathFromChain`: no path argument, reuse the previous call's path in the same chain. */
  | {
      kind: "endpoint";
      receiver: Capture;
      method: Capture;
      path?: Capture;
      handler: Capture;
      pathFromChain?: boolean;
    }
  | { kind: "middleware"; receiver: Capture; path?: Capture; handler: Capture }
  /** A page route; `id` is the framework's route id, `options` an object literal read with `component`. */
  | { kind: "route"; id?: Capture; options?: Capture; root?: boolean }
  /**
   * A table (or collection). `name`: the first capture that reads as text (`$X`, `=literal`, `@class` = the class a
   * matched decorator decorates). `model`: the model, entity or struct name the code uses for it. `binding`: the
   * declared identifier (`export const t = pgTable("x")`) stands for the table in later code. `ident`: an identifier
   * capture is taken as its own text.
   */
  | { kind: "table"; name: Capture | Capture[]; model?: Capture; binding?: boolean; ident?: boolean }
  /**
   * A read or a write of a table. The table comes from `target` (a string, an identifier or `ns.member` bound to a
   * table, or a call named in `tablePassthrough`), from `model` (a model name, possibly several with `$$$`), or from
   * the declaration of `receiver` (`modelFromReceiverDecl`). Read or write comes from `as`, else from the method
   * classes of the recipe applied to `method`.
   */
  | {
      kind: "access";
      target?: Capture;
      model?: Capture;
      method?: Capture;
      as?: "read" | "write";
      receiver?: Capture;
      /** Regexes over the declaration text of the receiver (`{prop}` = its member or own name); group 1 is the model. */
      modelFromReceiverDecl?: string[];
    };

export interface RecipeRule {
  id: string;
  language: Language;
  /** Repo-relative globs (`**` and `*` only). Default: every source file of the language. */
  files?: string[];
  rule: Rule;
  constraints?: Record<string, Rule>;
  emit: Emit;
}

/** Named helpers a recipe may ask for. Each is generic (no framework names inside) except `tanstack-file-routes`. */
export type Helper =
  | "resolve-names" // identifiers to declarations: scopes, parameters, imports and re-exports (TS), package scope (Go)
  | "const-strings" // a path argument that is an identifier reads the const string it names
  | "mount-graph" // routers, mounts and base paths composed into full paths; receivers must be routers
  | "call-return" // a mounted `f()` or `T{}.M()` is the router that function returns
  | "param-flow" // a router passed as an argument flows into the callee's parameter
  | "tanstack-file-routes" // built-in TanStack helper: file name to route id, URL path, parent route
  | "sql-text" // table names and reads or writes from SQL in strings, templates, tagged templates and .sql files
  | "text-rules" // regex rules over files with no syntax tree (schema.prisma, migrations)
  | "model-naming" // a model, entity or struct name to its table: explicit map, snake_case, plural
  | "method-classes"; // which methods of a client, repository or query builder read and which write

/** A regex rule over a text file. `$1`... in `emit` are the regex groups. */
export interface TextRule {
  id: string;
  files: string[];
  regex: string;
  flags?: string;
  emit:
    | { kind: "table"; name: string[]; model?: string }
    | { kind: "model-table"; model: string; table: string }
    | { kind: "access"; as: "read" | "write"; table?: string; model?: string };
}

export interface Recipe {
  name: string;
  /** Languages scanned when no rule names one (SQL strings in Go or TypeScript files). */
  languages?: Language[];
  /** Scan test files too (`*_test.go`, `*.test.ts`). */
  includeTests?: boolean;
  /** Repo-relative globs left out of every scan. */
  exclude?: string[];
  /** Model naming. `map`: explicit model to table. `derive`: steps applied to a model name that has no table of its own. */
  naming?: { map?: Record<string, string>; derive?: ("snake" | "plural" | "lower")[] };
  /** Method classes: methods that read and methods that write. */
  methods?: { read: string[]; write: string[] };
  /** Calls that stand for their first argument when read as a table (`alias(T, "a")`). */
  tablePassthrough?: string[];
  /** SQL text: scan strings of the recipe's languages and `.sql` files. */
  sql?: {
    /** Tagged-template tags (or call names) whose template is SQL even without a leading verb. */
    tags?: string[];
    /** Where reads and writes are taken from (default: everywhere). */
    accessFiles?: string[];
    /** Where CREATE TABLE is taken from (default: everywhere). */
    declFiles?: string[];
    /** Keep a read or write only when its table is declared somewhere in the repo. */
    knownTablesOnly?: boolean;
    /** Read `.sql` files. */
    sqlFiles?: boolean;
  };
  textRules?: TextRule[];
  frameworks?: { name: string; evidence: string }[];
  /** Files qualify only in packages that declare one of `dependency` (TS), or files importing one of `imports`. */
  when?: { dependency?: string[]; imports?: string[]; viaWorkspaces?: boolean };
  /** Chain calls that return the same router (`r.With(mw).Get`, `app.get().post()`). */
  passthrough?: string[];
  helpers: Helper[];
  rules: RecipeRule[];
}

export interface Endpoint {
  id: string;
  ws: string;
  method: string;
  path: string;
  handler: string;
  handlerSymbol: string | null;
  file: string;
  line: number;
  rule: string;
}
export interface Middleware {
  id: string;
  path: string;
  name: string;
  file: string;
  line: number;
}
export interface Route {
  id: string;
  routeId: string;
  urlPath: string;
  component?: string;
  componentSymbol: string | null;
  parent?: string;
  file: string;
}
export interface TableOut {
  name: string;
  model?: string;
  exportName?: string;
  file: string;
  line: number;
  rule: string;
}
/** One call site (or SQL statement) that reads or writes a table. */
export interface AccessOut {
  kind: "read" | "write";
  table: string;
  file: string;
  line: number;
  /** Symbol that holds the code (`sym:<file>#<name>`), or `file:<path>`. */
  src: string;
  rule: string;
  confidence: "high" | "low";
}
export interface RecipeOutput {
  tables: TableOut[];
  accesses: AccessOut[];
  /** Tables named only at runtime or not declared: kept visible as low-confidence, with the reason. */
  lowConfidence: { file: string; line: number; rule: string; reason: string }[];
  /** How many times each helper resolved something. */
  helperUse: Record<string, number>;
  endpoints: Endpoint[];
  middleware: Middleware[];
  routes: Route[];
  /** Registrations on a known router whose path could not be read statically (kept visible, not guessed). */
  unresolved: { file: string; line: number; rule: string; reason: string }[];
  /** Matches dropped because the receiver is not a router the recipe declared (`map.get(k)`, `r.Header.Get(h)`). */
  droppedNotRouter: number;
  /** Matches per rule (the plan's validation step reads these). */
  matches: Record<string, number>;
  files: number;
  ms: { parse: number; match: number; link: number; total: number };
}

/** The TanStack helper the recipe names; injected by the caller so this engine stays framework-blind. */
export interface TanstackHelper {
  mapRouteFile(rel: string): { routeId: string; urlPath: string; root: boolean } | null;
  urlPathOfRouteId(id: string): string;
  parentRouteId(id: string, ids: ReadonlySet<string>): string | undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Files

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", ".claude", "testdata"]);
const TS_RE = /\.(?:ts|tsx|mts|cts)$/;
const TS_SKIP = /(?:\.d\.ts|\.test\.tsx?|\.spec\.tsx?|\.gen\.ts)$/;

const TS_TEST = /(?:\.test\.tsx?|\.spec\.tsx?)$/;
const TS_SKIP_NOTEST = /(?:\.d\.ts|\.gen\.ts)$/;

function listFiles(root: string, lang: Language, includeTests = false): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (
          lang === "typescript"
            ? TS_RE.test(e) && !(includeTests ? TS_SKIP_NOTEST : TS_SKIP).test(e)
            : e.endsWith(".go") && (includeTests || !e.endsWith("_test.go"))
        )
          out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

/** Files with no syntax tree in the index (`.sql`, `.prisma`, ...), matched by the globs of a rule. */
function listTextFiles(root: string, match: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (match(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------------------------------------
// The run

interface Match {
  rule: RecipeRule;
  file: string;
  node: SgNode;
}

const pos = (file: string, n: SgNode): string => `${file}@${n.range().start.index}`;
const named = (n: SgNode): SgNode[] => n.children().filter((c) => c.isNamed());
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function joinPaths(parts: string[]): string {
  const segs = parts.flatMap((p) => p.split("/")).filter((s) => s !== "");
  return `/${segs.join("/")}`;
}

export function runRecipe(root: string, recipe: Recipe, tanstack?: TanstackHelper): RecipeOutput {
  const t0 = performance.now();
  const has = (h: Helper) => recipe.helpers.includes(h);
  const passthrough = new Set(recipe.passthrough ?? []);
  const langs = [...new Set([...recipe.rules.map((r) => r.language), ...(recipe.languages ?? [])])];
  const excludeRes = (recipe.exclude ?? []).map(globRe);
  const excluded = (rel: string) => excludeRes.some((r) => r.test(rel));
  const files = new Map<string, Language>();
  for (const l of langs)
    for (const f of listFiles(root, l, recipe.includeTests)) if (!excluded(f)) files.set(f, l);
  const helperUse: Record<string, number> = {};
  const used = (h: Helper) => {
    helperUse[h] = (helperUse[h] ?? 0) + 1;
  };

  // --- packages (TS): nearest package.json name and dependencies ---------------------------------------
  const pkgCache = new Map<string, { name: string; dir: string; deps: Set<string>; main?: string } | null>();
  const pkgOf = (rel: string) => {
    let dir = path.posix.dirname(rel);
    for (;;) {
      if (pkgCache.has(dir)) return pkgCache.get(dir) ?? null;
      try {
        const j = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")) as {
          name?: string;
          main?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const v = {
          name: j.name ?? dir,
          dir,
          deps: new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]),
          main: j.main,
        };
        pkgCache.set(dir, v);
        return v;
      } catch {
        if (dir === "." || dir === "") {
          pkgCache.set(dir, null);
          return null;
        }
        dir = path.posix.dirname(dir);
      }
    }
  };
  const wsOf = (rel: string): string => {
    const p = pkgOf(rel);
    if (p) return p.name;
    return path.posix.dirname(rel); // Go: the package directory
  };

  // --- parsing ------------------------------------------------------------------------------------------
  let parseMs = 0;
  const roots = new Map<string, SgNode>();
  const texts = new Map<string, string>();
  const rootOf = (file: string): SgNode | null => {
    const hit = roots.get(file);
    if (hit) return hit;
    const lang = files.get(file);
    if (!lang) return null;
    const src = readFileSync(path.join(root, file), "utf8");
    texts.set(file, src);
    const t = performance.now();
    const r = parse(lang === "go" ? "go" : file.endsWith("x") ? Lang.Tsx : Lang.TypeScript, src).root();
    parseMs += performance.now() - t;
    roots.set(file, r);
    return r;
  };
  let wsPkgs: { name: string; deps: Set<string> }[] | undefined;
  const workspacePkgs = () => {
    if (wsPkgs) return wsPkgs;
    wsPkgs = [];
    for (const f of listTextFiles(root, (rel) => path.posix.basename(rel) === "package.json")) {
      try {
        const j = JSON.parse(readFileSync(path.join(root, f), "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (j.name)
          wsPkgs.push({
            name: j.name,
            deps: new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]),
          });
      } catch {
        // an unreadable package.json is not a workspace package
      }
    }
    return wsPkgs;
  };
  const qualifies = (file: string): boolean => {
    const w = recipe.when;
    if (!w) return true;
    if (w.dependency && files.get(file) === "typescript") {
      const p = pkgOf(file);
      if (!p) return false;
      const direct = w.dependency.some((d) => p.deps.has(d));
      // `viaWorkspaces`: also a package that depends on a workspace package which declares one of the dependencies.
      if (
        !direct &&
        !(
          w.viaWorkspaces &&
          workspacePkgs().some((q) => p.deps.has(q.name) && w.dependency?.some((d) => q.deps.has(d)))
        )
      )
        return false;
    }
    if (w.imports) {
      rootOf(file);
      const src = texts.get(file) ?? "";
      if (!w.imports.some((i) => src.includes(`"${i}`) || src.includes(`'${i}`))) return false;
    }
    return true;
  };

  // --- matching -----------------------------------------------------------------------------------------
  const tm = performance.now();
  const matches: Match[] = [];
  const counts: Record<string, number> = {};
  const fileList = [...files.keys()].sort(cmp);
  const eligible = fileList.filter(qualifies);
  // Method classes: an access rule that captures `method` only matches the methods the recipe classed.
  const classed = new Set([...(recipe.methods?.read ?? []), ...(recipe.methods?.write ?? [])]);
  const constraintsOf = (rule: RecipeRule): Record<string, Rule> | undefined => {
    const e = rule.emit;
    if (e.kind === "access" && e.method?.startsWith("$") && has("method-classes") && classed.size > 0)
      return {
        ...rule.constraints,
        [e.method.slice(1)]: {
          regex: `^(?:${[...classed].map((m) => m.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&")).join("|")})$`,
        },
      };
    return rule.constraints;
  };
  for (const rule of recipe.rules) {
    counts[rule.id] = 0;
    const res = (rule.files ?? []).map(globRe);
    const constraints = constraintsOf(rule);
    for (const file of eligible) {
      if (files.get(file) !== rule.language) continue;
      if (res.length > 0 && !res.some((r) => r.test(file))) continue;
      const r = rootOf(file);
      if (!r) continue;
      for (const node of r.findAll({ rule: rule.rule, constraints })) {
        matches.push({ rule, file, node });
        counts[rule.id] = (counts[rule.id] ?? 0) + 1;
      }
    }
  }
  const matchMs = performance.now() - tm - 0;

  // --- syntax facts (per language; this is what a language module would supply) -------------------------
  const tl = performance.now();
  const langOf = (file: string): Language => files.get(file) ?? "typescript";
  const FN_KINDS: Record<Language, Set<string>> = {
    typescript: new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
      "generator_function_declaration",
    ]),
    go: new Set(["function_declaration", "method_declaration", "func_literal"]),
  };
  const unparen = (n: SgNode): SgNode => {
    let x = n;
    while (x.kind() === "parenthesized_expression") {
      const k = named(x)[0];
      if (!k) break;
      x = k;
    }
    return x;
  };
  /** `obj.method(...)`: [object, method name, args]; else null. */
  const memberCall = (n: SgNode): { obj: SgNode; method: string; args: SgNode[] } | null => {
    if (n.kind() !== "call_expression") return null;
    const fn = n.field("function");
    if (!fn) return null;
    const obj =
      fn.kind() === "member_expression"
        ? fn.field("object")
        : fn.kind() === "selector_expression"
          ? fn.field("operand")
          : null;
    const prop =
      fn.kind() === "member_expression"
        ? fn.field("property")
        : fn.kind() === "selector_expression"
          ? fn.field("field")
          : null;
    if (!obj || !prop) return null;
    const a = n.field("arguments");
    return { obj, method: prop.text(), args: a ? named(a).filter((x) => x.kind() !== "comment") : [] };
  };
  const stringOf = (n: SgNode | null | undefined): string | null => {
    if (!n) return null;
    const k = n.kind();
    if (k === "string" || k === "interpreted_string_literal" || k === "raw_string_literal") {
      const t = n.text();
      return t.slice(1, -1);
    }
    if (k === "template_string" && !named(n).some((c) => c.kind() === "template_substitution")) {
      return n.text().slice(1, -1);
    }
    return null;
  };

  interface Decl {
    file: string;
    ident: SgNode;
    value?: SgNode;
    fn?: SgNode; // a function declaration (for call-return / param-flow)
    param?: { fn: SgNode; fnName?: string; index: number };
  }

  const fnName = (fn: SgNode): string | undefined => {
    const nm = fn.field("name");
    if (nm) return nm.text();
    const p = fn.parent();
    if (p?.kind() === "variable_declarator") return p.field("name")?.text();
    return undefined;
  };

  /** Parameters of a function node as [identifier, index]. */
  const paramsOf = (fn: SgNode): SgNode[] => {
    const out: SgNode[] = [];
    const single = fn.field("parameter");
    if (single) return [single];
    const ps = fn.field("parameters");
    if (!ps) return out;
    for (const p of named(ps)) {
      if (p.kind() === "parameter_declaration") {
        for (const c of named(p)) if (c.kind() === "identifier") out.push(c);
      } else {
        const pat = p.field("pattern");
        if (pat?.kind() === "identifier") out.push(pat);
        else if (p.kind() === "identifier") out.push(p);
      }
    }
    return out;
  };

  /** Declarations directly in a statement list (TS block/program, Go block/source file). */
  const declsIn = (file: string, block: SgNode, name: string): Decl | null => {
    const stmts =
      block.kind() === "block"
        ? named(block).flatMap((c) => (c.kind() === "statement_list" ? named(c) : [c]))
        : named(block);
    for (let s of stmts) {
      if (s.kind() === "export_statement") {
        const d = s.field("declaration");
        if (!d) continue;
        s = d;
      }
      switch (s.kind()) {
        case "lexical_declaration":
        case "variable_declaration":
          for (const d of named(s)) {
            if (d.kind() !== "variable_declarator") continue;
            const id = d.field("name");
            if (id?.kind() === "identifier" && id.text() === name) {
              const value = d.field("value") ?? undefined;
              const isFn = value && FN_KINDS.typescript.has(String(value.kind()));
              return { file, ident: id, value, ...(isFn ? { fn: value } : {}) };
            }
          }
          break;
        case "function_declaration":
        case "generator_function_declaration":
          if (s.field("name")?.text() === name) return { file, ident: s.field("name") as SgNode, fn: s };
          break;
        case "short_var_declaration": {
          const left = s.field("left");
          const right = s.field("right");
          const ls = left ? named(left) : [];
          const rs = right ? named(right) : [];
          const i = ls.findIndex((l) => l.text() === name);
          if (i >= 0) return { file, ident: ls[i] as SgNode, value: rs[i] };
          break;
        }
        case "var_declaration":
        case "const_declaration":
          for (const spec of named(s)) {
            const ids = named(spec).filter((c) => c.kind() === "identifier");
            const v = spec.field("value");
            const vs = v ? named(v) : [];
            const i = ids.findIndex((x) => x.text() === name);
            if (i >= 0) return { file, ident: ids[i] as SgNode, value: vs[i] };
          }
          break;
      }
    }
    return null;
  };

  const resolveModule = (from: string, spec: string): string | null => {
    const tryFile = (base: string): string | null => {
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const f = path.posix.normalize(base + ext);
        if (files.has(f)) return f;
      }
      return null;
    };
    if (spec.startsWith(".")) return tryFile(path.posix.join(path.posix.dirname(from), spec));
    // Workspace package by name (no node_modules in fixtures).
    for (const f of files.keys()) {
      const p = pkgOf(f);
      if (p && p.name === spec) {
        const main = p.main ? path.posix.join(p.dir, p.main) : path.posix.join(p.dir, "src/index.ts");
        return tryFile(main.replace(/\.(?:ts|tsx|js)$/, "")) ?? tryFile(main);
      }
    }
    return null;
  };

  const resolveExport = (file: string, name: string, depth = 0): Decl | null => {
    const r = rootOf(file);
    if (!r || depth > 8) return null;
    for (const s of named(r)) {
      if (s.kind() !== "export_statement") continue;
      const src = stringOf(s.field("source"));
      const clause = named(s).find((c) => c.kind() === "export_clause");
      if (clause) {
        for (const sp of named(clause)) {
          const local = sp.field("name")?.text();
          const exported = sp.field("alias")?.text() ?? local;
          if (exported !== name || !local) continue;
          if (src) {
            const t = resolveModule(file, src);
            return t ? resolveExport(t, local, depth + 1) : null;
          }
          return declsIn(file, r, local) ?? importDecl(file, local, depth + 1);
        }
        continue;
      }
      if (name === "default" && /^export\s+default\b/.test(s.text())) {
        const v = s.field("value") ?? s.field("declaration");
        if (!v) continue;
        if (v.kind() === "identifier")
          return declsIn(file, r, v.text()) ?? importDecl(file, v.text(), depth + 1);
        return { file, ident: v, value: v, ...(FN_KINDS.typescript.has(String(v.kind())) ? { fn: v } : {}) };
      }
    }
    return declsIn(file, r, name) &&
      named(r).some(
        (s) => s.kind() === "export_statement" && s.field("declaration") && declsIn(file, s, name),
      )
      ? declsIn(file, r, name)
      : null;
  };

  const importDecl = (file: string, local: string, depth = 0): Decl | null => {
    const r = rootOf(file);
    if (!r) return null;
    for (const s of named(r)) {
      if (s.kind() !== "import_statement") continue;
      const src = stringOf(s.field("source"));
      const clause = named(s).find((c) => c.kind() === "import_clause");
      if (!src || !clause) continue;
      let imported: string | null = null;
      for (const c of named(clause)) {
        if (c.kind() === "identifier" && c.text() === local) imported = "default";
        if (c.kind() === "named_imports") {
          for (const sp of named(c)) {
            const nm = sp.field("name")?.text();
            const al = sp.field("alias")?.text() ?? nm;
            if (al === local && nm) imported = nm;
          }
        }
      }
      if (imported === null) continue;
      const target = resolveModule(file, src);
      return target ? resolveExport(target, imported, depth) : null;
    }
    return null;
  };

  const resolveName = (file: string, ident: SgNode): Decl | null => {
    const d = resolveName0(file, ident);
    if (d) used("resolve-names");
    return d;
  };
  const resolveName0 = (file: string, ident: SgNode): Decl | null => {
    const name = ident.text();
    const lang = langOf(file);
    for (let a = ident.parent(); a; a = a.parent()) {
      if (FN_KINDS[lang].has(String(a.kind()))) {
        const ps = paramsOf(a);
        const i = ps.findIndex((p) => p.text() === name);
        if (i >= 0) return { file, ident: ps[i] as SgNode, param: { fn: a, fnName: fnName(a), index: i } };
        if (a.kind() === "method_declaration") {
          const recv = a.field("receiver");
          const r = recv ? named(recv).flatMap((p) => named(p).filter((c) => c.kind() === "identifier")) : [];
          const hit = r.find((x) => x.text() === name);
          if (hit) return { file, ident: hit };
        }
      }
      const k = a.kind();
      if (k === "statement_block" || k === "block" || k === "program" || k === "source_file") {
        const d = declsIn(file, a, name);
        // No use-before-declaration check: the spike takes the nearest enclosing declaration of the name.
        if (d) return d;
      }
    }
    if (lang === "typescript") return importDecl(file, name);
    // Go: package scope across the files of the directory.
    const dir = path.posix.dirname(file);
    for (const f of fileList) {
      if (f === file || path.posix.dirname(f) !== dir || files.get(f) !== "go") continue;
      const r = rootOf(f);
      const d = r ? declsIn(f, r, name) : null;
      if (d) return d;
    }
    return null;
  };

  // --- expressions to router keys -------------------------------------------------------------------------
  /** Climbs passthrough chain calls and an enclosing declarator: the stable key of a constructor expression. */
  const canonicalKey = (file: string, node: SgNode): string => {
    let n = node;
    for (;;) {
      const p = n.parent();
      const gp = p?.parent();
      if (p && gp && (p.kind() === "member_expression" || p.kind() === "selector_expression")) {
        const mc = memberCall(gp);
        if (mc && mc.obj.range().start.index === n.range().start.index && passthrough.has(mc.method)) {
          n = gp;
          continue;
        }
      }
      break;
    }
    const p = n.parent();
    if (
      p?.kind() === "variable_declarator" &&
      p.field("value")?.range().start.index === n.range().start.index
    ) {
      const id = p.field("name");
      if (id) return pos(file, id);
    }
    if (p?.kind() === "expression_list") {
      const g = p.parent();
      const i = named(p).findIndex((c) => c.range().start.index === n.range().start.index);
      if (g?.kind() === "short_var_declaration") {
        const l = g.field("left");
        const id = l ? named(l)[i] : undefined;
        if (id && g.field("right")?.range().start.index === p.range().start.index) return pos(file, id);
      }
      if (g?.kind() === "var_spec") {
        const ids = named(g).filter((c) => c.kind() === "identifier");
        if (ids[i]) return pos(file, ids[i] as SgNode);
      }
    }
    return pos(file, n);
  };

  interface ParamRef {
    key: string;
    file: string;
    fnName: string;
    index: number;
  }
  const params = new Map<string, ParamRef>();

  const returnsOf = (fn: SgNode): SgNode[] => {
    const out: SgNode[] = [];
    const body = fn.field("body");
    if (!body) return out;
    if (body.kind() !== "statement_block" && body.kind() !== "block") return [body];
    const walk = (n: SgNode) => {
      for (const c of named(n)) {
        if (
          FN_KINDS[c.kind() === "func_literal" ? "go" : "typescript"].has(String(c.kind())) ||
          c.kind() === "func_literal"
        )
          continue;
        if (c.kind() === "return_statement") {
          const v = named(c)[0];
          if (v) out.push(v.kind() === "expression_list" ? (named(v)[0] as SgNode) : v);
        } else walk(c);
      }
    };
    walk(body);
    return out;
  };

  const goMethod = (file: string, typeName: string, method: string): { file: string; fn: SgNode } | null => {
    const dir = path.posix.dirname(file);
    for (const f of fileList) {
      if (path.posix.dirname(f) !== dir || files.get(f) !== "go") continue;
      const r = rootOf(f);
      if (!r) continue;
      for (const m of named(r)) {
        if (m.kind() !== "method_declaration" || m.field("name")?.text() !== method) continue;
        const recv = m.field("receiver")?.text() ?? "";
        if (
          new RegExp(`\\b\\*?${typeName}\\)\\s*$`).test(recv.trim()) ||
          recv.includes(` ${typeName})`) ||
          recv.includes(`*${typeName})`)
        )
          return { file: f, fn: m };
      }
    }
    return null;
  };

  const resolveExpr = (file: string, node: SgNode, depth = 0): string => {
    const n = unparen(node);
    if (depth > 12) return pos(file, n);
    const mc = memberCall(n);
    if (mc && passthrough.has(mc.method)) return resolveExpr(file, mc.obj, depth + 1);
    if (n.kind() === "identifier" && has("resolve-names")) {
      const d = resolveName(file, n);
      if (!d) return `unresolved:${file}:${n.text()}`;
      if (d.param) {
        const key = pos(d.file, d.ident);
        if (d.param.fnName)
          params.set(key, { key, file: d.file, fnName: d.param.fnName, index: d.param.index });
        return key;
      }
      if (d.value && d.value.range().start.index !== d.ident.range().start.index) {
        const inner = resolveExpr(d.file, d.value, depth + 1);
        // A constructor value keys to the declaration itself; an alias (`const x = createApp()`) keys to its target.
        return inner;
      }
      if (d.value) return resolveExpr(d.file, d.value, depth + 1);
      return pos(d.file, d.ident);
    }
    if (n.kind() === "call_expression" && has("call-return")) {
      const fn = n.field("function");
      if (fn?.kind() === "identifier" && has("resolve-names")) {
        const d = resolveName(file, fn);
        if (d?.fn) {
          const rs = returnsOf(d.fn);
          if (rs[0]) return resolveExpr(d.file, rs[0], depth + 1);
        }
      }
      if (fn?.kind() === "selector_expression") {
        const op = fn.field("operand");
        const field = fn.field("field")?.text();
        if (op?.kind() === "composite_literal" && field) {
          const t = op.field("type")?.text() ?? "";
          const m = goMethod(file, t, field);
          if (m) {
            const rs = returnsOf(m.fn);
            if (rs[0]) return resolveExpr(m.file, rs[0], depth + 1);
          }
        }
      }
    }
    return canonicalKey(file, n);
  };

  // --- captures -------------------------------------------------------------------------------------------
  const cap = (m: Match, c: Capture | undefined): SgNode[] => {
    if (!c) return [];
    if (c.startsWith("$$$")) return m.node.getMultipleMatches(c.slice(3)).filter((x) => x.isNamed());
    if (c.startsWith("$")) {
      const x = m.node.getMatch(c.slice(1));
      return x ? [x] : [];
    }
    return [];
  };
  const strOf = (file: string, n: SgNode | undefined): string | null => {
    if (!n) return null;
    const s = stringOf(n);
    if (s !== null) return s;
    if (n.kind() === "identifier" && has("const-strings") && has("resolve-names")) {
      const d = resolveName(file, n);
      const v = d?.value ? stringOf(d.value) : null;
      if (v !== null) used("const-strings");
      return v;
    }
    return null;
  };
  const methodsOf = (m: Match, c: Capture): string[] => {
    if (c.startsWith("=")) return [c.slice(1)];
    const n = cap(m, c)[0];
    if (!n) return [];
    if (n.kind() === "array" || n.kind() === "composite_literal") {
      return named(n)
        .map((x) => stringOf(x))
        .filter((x): x is string => x !== null)
        .map((x) => x.toUpperCase());
    }
    const s = stringOf(n);
    return [(s ?? n.text()).toUpperCase()];
  };
  const labelOf = (n: SgNode | undefined): string => {
    if (!n) return "none";
    const k = String(n.kind());
    if (FN_KINDS.typescript.has(k) || k === "func_literal") return "inline";
    if (k === "call_expression") return n.field("function")?.text() ?? "call";
    return n.text();
  };
  const topLevelSymbol = (file: string, n: SgNode): string => {
    let s: SgNode = n;
    for (let p = n.parent(); p && p.kind() !== "program" && p.kind() !== "source_file"; p = p.parent()) s = p;
    const d = s.kind() === "export_statement" ? s.field("declaration") : s;
    if (d?.kind() === "function_declaration") return `sym:${file}#${d.field("name")?.text()}`;
    if (d?.kind() === "lexical_declaration") {
      const v = named(d).find((x) => x.kind() === "variable_declarator");
      const nm = v?.field("name")?.text();
      if (nm) return `sym:${file}#${nm}`;
    }
    return `file:${file}`;
  };
  const symbolOf = (file: string, n: SgNode | undefined): string | null => {
    if (!n || langOf(file) !== "typescript") return null;
    if (n.kind() === "identifier") {
      if (!has("resolve-names")) return null;
      const d = resolveName(file, n);
      if (!d) return null;
      const s = topLevelSymbol(d.file, d.ident);
      return s.startsWith("sym:") ? s : null;
    }
    return topLevelSymbol(file, n);
  };

  // --- build the router graph -------------------------------------------------------------------------------
  const routers = new Map<string, { file: string; base: string }>();
  const links: { parent: string; child: string; prefix: string }[] = [];
  const childKeys = new Set<string>();
  interface PendingEp {
    m: Match;
    receiver: string;
    methods: string[];
    path: string | null;
    handler: SgNode | undefined;
    kind: "endpoint" | "middleware";
  }
  const pending: PendingEp[] = [];
  const routeMatches: Match[] = [];

  for (const m of matches) {
    const e = m.rule.emit;
    if (e.kind === "router") {
      const key = canonicalKey(m.file, m.node);
      const base = e.base ? (strOf(m.file, cap(m, e.base)[0]) ?? "") : "";
      const prev = routers.get(key);
      if (!prev || base) routers.set(key, { file: m.file, base });
    } else if (e.kind === "mount") {
      const parentN = cap(m, e.parent)[0];
      const childN = cap(m, e.child)[0];
      if (!parentN || !childN) continue;
      const parent = resolveExpr(m.file, parentN);
      let child: string | null;
      if (e.childIsScope) {
        const p = FN_KINDS[langOf(m.file)].has(String(childN.kind())) ? paramsOf(childN)[0] : undefined;
        child = p ? pos(m.file, p) : null;
      } else child = resolveExpr(m.file, childN);
      if (!child) continue;
      const prefix = e.prefix ? strOf(m.file, cap(m, e.prefix)[0]) : "";
      links.push({ parent, child, prefix: prefix ?? ":dynamic" });
      childKeys.add(child);
    } else if (e.kind === "endpoint" || e.kind === "middleware") {
      const recv = cap(m, e.receiver)[0];
      if (!recv) continue;
      const hs = cap(m, e.handler);
      let p: string | null = e.path
        ? strOf(m.file, cap(m, e.path)[0])
        : e.kind === "middleware"
          ? "/*"
          : null;
      if (e.kind === "endpoint" && e.pathFromChain) {
        // Reuse the path of the previous registration in the chain (`.get("/", a).post(b)`).
        for (let o = memberCall(m.node)?.obj; o; o = memberCall(o)?.obj) {
          const inner = memberCall(o);
          if (!inner) break;
          const s = inner.args.length > 1 ? stringOf(inner.args[0]) : null;
          if (s !== null) {
            p = s;
            break;
          }
        }
      }
      pending.push({
        m,
        receiver: resolveExpr(m.file, recv),
        methods: e.kind === "endpoint" ? methodsOf(m, e.method) : [],
        path: p,
        handler: hs[hs.length - 1],
        kind: e.kind,
      });
    } else if (e.kind === "route") routeMatches.push(m);
  }

  // Parameters that receive a router through a call (`addUserRoutes(v1)`).
  if (has("param-flow")) {
    const done = new Set<string>();
    for (const pr of params.values()) {
      if (done.has(pr.key)) continue;
      done.add(pr.key);
      for (const f of fileList) {
        if (files.get(f) !== files.get(pr.file)) continue;
        if (files.get(f) === "go" && path.posix.dirname(f) !== path.posix.dirname(pr.file)) continue;
        if (!(texts.get(f) ?? readFileSync(path.join(root, f), "utf8")).includes(`${pr.fnName}(`)) continue;
        const r = rootOf(f);
        if (!r) continue;
        for (const call of r.findAll({
          rule: { kind: "call_expression", has: { field: "function", regex: `^${pr.fnName}$` } },
        })) {
          const a = call.field("arguments");
          const arg = a ? named(a)[pr.index] : undefined;
          if (!arg) continue;
          links.push({ parent: resolveExpr(f, arg), child: pr.key, prefix: "" });
          childKeys.add(pr.key);
        }
      }
    }
  }

  // Full prefixes of a router: every chain of mounts up to a router with no parent.
  const parentsOf = new Map<string, { parent: string; prefix: string }[]>();
  for (const l of links) {
    const list = parentsOf.get(l.child) ?? [];
    list.push({ parent: l.parent, prefix: l.prefix });
    parentsOf.set(l.child, list);
  }
  const isRouter = (k: string): boolean => routers.has(k) || childKeys.has(k);
  const prefixes = (k: string, seen: Set<string> = new Set()): { parts: string[]; top: string }[] => {
    if (seen.has(k)) return [];
    seen.add(k);
    const base = routers.get(k)?.base ?? "";
    const ps = (parentsOf.get(k) ?? []).filter((p) => isRouter(p.parent));
    if (ps.length === 0) return routers.has(k) ? [{ parts: [base], top: k }] : [];
    const out: { parts: string[]; top: string }[] = [];
    for (const p of ps) {
      for (const up of prefixes(p.parent, new Set(seen)))
        out.push({ parts: [...up.parts, p.prefix, base], top: up.top });
    }
    return out;
  };

  const endpoints: Endpoint[] = [];
  const middleware: Middleware[] = [];
  const useGraph = has("mount-graph");
  const unresolved: RecipeOutput["unresolved"] = [];
  let droppedNotRouter = 0;
  for (const pe of pending) {
    const line = pe.m.node.range().start.line + 1;
    const chains = useGraph ? prefixes(pe.receiver) : [{ parts: [], top: `${pe.m.file}@0` }];
    if (chains.length === 0) droppedNotRouter++;
    else if (pe.kind === "endpoint" && pe.path === null)
      unresolved.push({
        file: pe.m.file,
        line,
        rule: pe.m.rule.id,
        reason: "path is not a literal or const string",
      });
    for (const c of chains) {
      const topFile = c.top.slice(0, c.top.lastIndexOf("@"));
      const ws = wsOf(topFile);
      const own = pe.path ?? "";
      if (pe.kind === "middleware") {
        const p = joinPaths([...c.parts, own]);
        const pp = own === "*" || own.endsWith("/*") || own === "/*" ? p.replace(/\/\*?$/, "/*") : p;
        const name = labelOf(pe.handler);
        middleware.push({ id: `mw:${ws}:${pp} ${name}`, path: pp, name, file: pe.m.file, line });
        continue;
      }
      if (pe.path === null) continue;
      const full = joinPaths([...c.parts, own]);
      for (const method of pe.methods) {
        endpoints.push({
          id: `ep:${ws}:${method} ${full}`,
          ws,
          method,
          path: full,
          handler: labelOf(pe.handler),
          handlerSymbol: symbolOf(pe.m.file, pe.handler),
          file: pe.m.file,
          line,
          rule: pe.m.rule.id,
        });
      }
    }
  }

  // --- page routes ------------------------------------------------------------------------------------------
  const routes: Route[] = [];
  if (routeMatches.length > 0) {
    const byWs = new Map<string, Route[]>();
    for (const m of routeMatches) {
      const e = m.rule.emit as Extract<Emit, { kind: "route" }>;
      const ws = wsOf(m.file);
      let routeId = e.root ? "__root__" : e.id ? strOf(m.file, cap(m, e.id)[0]) : null;
      let urlPath = routeId ?? "";
      if (tanstack && has("tanstack-file-routes")) {
        const rel = m.file.replace(/^.*?\/routes\//, "");
        const mapped = tanstack.mapRouteFile(rel);
        if (!mapped || mapped.root !== Boolean(e.root)) continue;
        if (routeId === null) routeId = mapped.routeId;
        urlPath = routeId === "__root__" ? "/" : tanstack.urlPathOfRouteId(routeId);
      }
      if (routeId === null) continue;
      const opts = cap(m, e.options)[0];
      let comp: SgNode | undefined;
      if (opts?.kind() === "object") {
        for (const p of named(opts)) {
          if (p.kind() === "pair" && p.field("key")?.text() === "component")
            comp = p.field("value") ?? undefined;
          if (p.kind() === "shorthand_property_identifier" && p.text() === "component") comp = p;
        }
      }
      const list = byWs.get(ws) ?? [];
      if (list.some((r) => r.routeId === routeId)) continue;
      list.push({
        id: `route:${ws}:${routeId}`,
        routeId,
        urlPath,
        ...(comp ? { component: labelOf(comp) } : {}),
        componentSymbol: comp?.kind() === "identifier" ? symbolOf(m.file, comp) : null,
        file: m.file,
      });
      byWs.set(ws, list);
    }
    for (const [ws, list] of [...byWs.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const ids = new Set(list.map((r) => r.routeId));
      for (const r of list) {
        const p =
          tanstack && has("tanstack-file-routes") ? tanstack.parentRouteId(r.routeId, ids) : undefined;
        if (p) r.parent = `route:${ws}:${p}`;
        routes.push(r);
      }
    }
  }

  // --- data access: tables, reads and writes --------------------------------------------------------------------
  const tables: TableOut[] = [];
  const accesses: AccessOut[] = [];
  const lowConfidence: RecipeOutput["lowConfidence"] = [];
  const tableByKey = new Map<string, TableOut>(); // lower-case name -> table
  const bindings = new Map<string, string>(); // position of a declared identifier -> table key
  const modelToTable = new Map<string, string>(); // normalized model name -> table key
  const keyOf = (s: string): string => s.toLowerCase();
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasData =
    recipe.rules.some((r) => r.emit.kind === "table" || r.emit.kind === "access") ||
    recipe.sql !== undefined ||
    (recipe.textRules ?? []).length > 0;

  const addTable = (
    name: string,
    file: string,
    line: number,
    rule: string,
    model?: string,
    exportName?: string,
  ): TableOut => {
    const k = keyOf(name);
    let t = tableByKey.get(k);
    if (!t) {
      t = { name, ...(model ? { model } : {}), ...(exportName ? { exportName } : {}), file, line, rule };
      tableByKey.set(k, t);
      tables.push(t);
    }
    if (model) modelToTable.set(norm(model), k);
    if (exportName) modelToTable.set(norm(exportName), k);
    return t;
  };
  /** An explicit model to table map found in the repo: it also renames a table declared under the model's own name. */
  const mapModel = (model: string, table: string) => {
    const old = tableByKey.get(keyOf(model));
    if (old && keyOf(old.name) !== keyOf(table) && !tableByKey.has(keyOf(table))) {
      tableByKey.delete(keyOf(model));
      old.name = table;
      tableByKey.set(keyOf(table), old);
      for (const [m, k] of modelToTable) if (k === keyOf(model)) modelToTable.set(m, keyOf(table));
    }
    if (tableByKey.has(keyOf(table))) {
      modelToTable.set(norm(model), keyOf(table));
      used("model-naming");
    }
  };

  const snake = (s: string): string =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  const plural = (s: string): string =>
    /(?:s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`;
  const deriveName = (model: string): string => {
    let v = model;
    for (const step of recipe.naming?.derive ?? []) {
      if (step === "snake") v = snake(v);
      else if (step === "plural") v = plural(v);
      else v = v.toLowerCase();
    }
    return v;
  };
  /** A model (or entity, struct, collection) name to the key of its table; null when no declared table fits. */
  const resolveModel = (model: string): string | null => {
    if (tableByKey.has(keyOf(model))) return keyOf(model);
    if (has("model-naming")) {
      const mapped = recipe.naming?.map?.[model];
      if (mapped && tableByKey.has(keyOf(mapped))) {
        used("model-naming");
        return keyOf(mapped);
      }
      const hit = modelToTable.get(norm(model));
      if (hit) {
        used("model-naming");
        return hit;
      }
      const d = deriveName(model);
      if (d !== model && tableByKey.has(keyOf(d))) {
        used("model-naming");
        return keyOf(d);
      }
    }
    return null;
  };
  const nameFallback = (name: string): string | null => {
    for (const t of tables) if (t.exportName === name) return keyOf(t.name);
    return modelToTable.get(norm(name)) ?? null;
  };

  const classOfDecorator = (n: SgNode): string | null => {
    const p = n.parent();
    const cls = p?.kind() === "export_statement" ? p.field("declaration") : p;
    if (cls && (cls.kind() === "class_declaration" || cls.kind() === "abstract_class_declaration"))
      return cls.field("name")?.text() ?? null;
    return null;
  };
  const textOfCapture = (m: Match, c: Capture, ident: boolean): string | null => {
    if (c.startsWith("=")) return c.slice(1);
    if (c === "@class") return classOfDecorator(m.node);
    let n = cap(m, c)[0];
    if (!n) return null;
    // A Go constant's value is an expression list of one expression.
    if (n.kind() === "expression_list" && named(n).length === 1) n = named(n)[0] as SgNode;
    const s = strOf(m.file, n);
    if (s !== null) return s;
    return ident && String(n.kind()).endsWith("identifier") ? n.text() : null;
  };
  const declaredIdent = (n: SgNode): SgNode | null => {
    const p = n.parent();
    return p?.kind() === "variable_declarator" &&
      p.field("value")?.range().start.index === n.range().start.index
      ? p.field("name")
      : null;
  };

  // The statement that declares an identifier, as text (a variable's `const x = ...`, a parameter, a property).
  const declStatementText = (d: Decl): string => {
    for (let a: SgNode | null = d.ident; a; a = a.parent()) {
      const k = String(a.kind());
      if (
        k === "lexical_declaration" ||
        k === "variable_declaration" ||
        k === "required_parameter" ||
        k === "optional_parameter" ||
        k === "short_var_declaration" ||
        k === "var_declaration" ||
        k === "parameter_declaration"
      )
        return a.text();
    }
    return d.ident.text();
  };
  const enclosingClassText = (n: SgNode): string | null => {
    for (let a = n.parent(); a; a = a.parent())
      if (a.kind() === "class_declaration" || a.kind() === "class") return a.text();
    return null;
  };
  /** Declaration text and member name of a receiver expression: `this.p`, `X.p` (X declared in the repo) or `x`. */
  const receiverDecl = (file: string, recv: SgNode): { text: string; prop: string } | null => {
    const r = unparen(recv);
    if (r.kind() === "member_expression") {
      const obj = r.field("object");
      const prop = r.field("property")?.text();
      if (!obj || !prop) return null;
      if (obj.kind() === "this") {
        const t = enclosingClassText(r);
        return t ? { text: t, prop } : null;
      }
      if (obj.kind() === "identifier") {
        const d = resolveName(file, obj);
        return d ? { text: declStatementText(d), prop } : null;
      }
      return null;
    }
    if (r.kind() === "identifier") {
      const d = resolveName(file, r);
      return d ? { text: declStatementText(d), prop: r.text() } : null;
    }
    return null;
  };
  /** `ns.member` where `ns` is a namespace import (`import * as ns from "./m"`). */
  const resolveMember = (file: string, obj: string, prop: string): Decl | null => {
    const r = rootOf(file);
    if (!r) return null;
    for (const s of named(r)) {
      if (s.kind() !== "import_statement") continue;
      const src = stringOf(s.field("source"));
      const clause = named(s).find((c) => c.kind() === "import_clause");
      const ns = clause ? named(clause).find((c) => c.kind() === "namespace_import") : undefined;
      const id = ns ? named(ns)[0] : undefined;
      if (!src || id?.text() !== obj) continue;
      const target = resolveModule(file, src);
      return target ? resolveExport(target, prop) : null;
    }
    return null;
  };
  /** A table expression: a string, a bound identifier, `ns.member`, or a passthrough call such as `alias(T, "a")`. */
  const tableOfExpr = (
    file: string,
    node: SgNode,
    depth = 0,
  ): { key: string; conf: "high" | "low" } | null => {
    const n = unparen(node);
    if (depth > 4) return null;
    const s = stringOf(n);
    if (s !== null) {
      const k = resolveModel(s);
      return k ? { key: k, conf: "high" } : null;
    }
    if (n.kind() === "call_expression") {
      const fn = n.field("function");
      if (fn && (recipe.tablePassthrough ?? []).includes(fn.text())) {
        const a = n.field("arguments");
        const first = a ? named(a)[0] : undefined;
        return first ? tableOfExpr(file, first, depth + 1) : null;
      }
      return null;
    }
    if (n.kind() === "identifier") {
      const d = resolveName(file, n);
      if (d) {
        const k = bindings.get(pos(d.file, d.ident));
        if (k) return { key: k, conf: "high" };
        // A constant that holds a table expression (`const a = alias(users, "a")`).
        return d.value && d.value.range().start.index !== d.ident.range().start.index
          ? tableOfExpr(d.file, d.value, depth + 1)
          : null;
      }
      const hit = nameFallback(n.text());
      return hit ? { key: hit, conf: "low" } : null;
    }
    if (n.kind() === "member_expression") {
      const obj = n.field("object");
      const prop = n.field("property");
      if (obj?.kind() === "identifier" && prop) {
        const d = resolveMember(file, obj.text(), prop.text());
        if (d) {
          const k = bindings.get(pos(d.file, d.ident));
          return k ? { key: k, conf: "high" } : null;
        }
        const hit = nameFallback(prop.text());
        return hit ? { key: hit, conf: "low" } : null;
      }
    }
    return null;
  };

  const fileLine = (file: string, index: number): number => {
    const src = texts.get(file);
    if (src === undefined) return 0;
    let n = 1;
    for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
  };
  const pushAccess = (
    kind: "read" | "write",
    key: string,
    file: string,
    line: number,
    src: string,
    rule: string,
    confidence: "high" | "low",
  ) => {
    const t = tableByKey.get(key);
    if (t) accesses.push({ kind, table: t.name, file, line, src, rule, confidence });
  };

  const lineInText = (t: string, off: number): number => {
    let n = 0;
    for (let i = 0; i < off && i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
    return n;
  };

  if (hasData) {
    // 1. Tables from syntax rules.
    for (const m of matches) {
      const e = m.rule.emit;
      if (e.kind !== "table") continue;
      const names = Array.isArray(e.name) ? e.name : [e.name];
      let name: string | null = null;
      for (const c of names) {
        name = textOfCapture(m, c, e.ident === true);
        if (name) break;
      }
      const line = m.node.range().start.line + 1;
      if (!name) {
        lowConfidence.push({
          file: m.file,
          line,
          rule: m.rule.id,
          reason: "table name is not a literal or constant",
        });
        continue;
      }
      const model = e.model ? (textOfCapture(m, e.model, true) ?? undefined) : undefined;
      const id = e.binding ? declaredIdent(m.node) : null;
      const t = addTable(name, m.file, line, m.rule.id, model, id?.text());
      if (id) bindings.set(pos(m.file, id), keyOf(t.name));
    }

    // 2. Text rules: line and regex rules over files with no syntax tree.
    const textMatches: { rule: TextRule; file: string; groups: string[]; line: number }[] = [];
    if (has("text-rules")) {
      for (const tr of recipe.textRules ?? []) {
        const res = tr.files.map(globRe);
        const rx = new RegExp(tr.regex, tr.flags ?? "gm");
        for (const f of listTextFiles(root, (rel) => res.some((r) => r.test(rel)) && !excluded(rel))) {
          const src = readFileSync(path.join(root, f), "utf8");
          texts.set(f, src);
          for (const mt of src.matchAll(rx)) {
            used("text-rules");
            textMatches.push({ rule: tr, file: f, groups: [...mt], line: fileLine(f, mt.index ?? 0) });
          }
        }
      }
      const grp = (g: string[], ref: string): string => {
        const i = ref.startsWith("$") ? Number(ref.slice(1)) : Number.NaN;
        return Number.isNaN(i) ? ref : (g[i] ?? "");
      };
      for (const tm of textMatches) {
        const e = tm.rule.emit;
        if (e.kind !== "table") continue;
        const name = e.name.map((r) => grp(tm.groups, r)).find((x) => x !== "");
        if (name) addTable(name, tm.file, tm.line, tm.rule.id, e.model ? grp(tm.groups, e.model) : undefined);
      }
      for (const tm of textMatches) {
        const e = tm.rule.emit;
        if (e.kind === "model-table") mapModel(grp(tm.groups, e.model), grp(tm.groups, e.table));
      }
      for (const tm of textMatches) {
        const e = tm.rule.emit;
        if (e.kind !== "access") continue;
        const ref = e.table ?? e.model;
        const nm = ref ? grp(tm.groups, ref) : "";
        const k = nm ? resolveModel(nm) : null;
        if (k) pushAccess(e.as, k, tm.file, tm.line, `file:${tm.file}`, tm.rule.id, "high");
      }
    }

    // 3. SQL text: CREATE TABLE gives tables, SELECT ... FROM, JOIN, INSERT INTO, UPDATE, DELETE FROM give accesses.
    if (recipe.sql && has("sql-text")) {
      const cfg = recipe.sql;
      const accessRes = (cfg.accessFiles ?? []).map(globRe);
      const declRes = (cfg.declFiles ?? []).map(globRe);
      const okAccess = (f: string) => accessRes.length === 0 || accessRes.some((r) => r.test(f));
      const okDecl = (f: string) => declRes.length === 0 || declRes.some((r) => r.test(f));
      const tags = new Set(cfg.tags ?? []);
      const PH = (i: number) => `\u0001${i}\u0002`;
      const ID = '(?:"[^"]+"|`[^`]+`|\\u0001\\d+\\u0002|[A-Za-z_][A-Za-z0-9_$]*)';
      const REF = `${ID}(?:\\s*\\.\\s*${ID})*`;
      const FLAGS = "gi";
      const createRx = new RegExp(
        `\\bCREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${REF})`,
        FLAGS,
      );
      const insertRx = new RegExp(`\\bINSERT\\s+INTO\\s+(${REF})`, FLAGS);
      const updateRx = new RegExp(
        `\\bUPDATE\\s+(?:ONLY\\s+)?(${REF})(?:\\s+(?:AS\\s+)?[A-Za-z_]\\w*)?\\s+SET\\b`,
        FLAGS,
      );
      const deleteRx = new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(${REF})`, FLAGS);
      const truncateRx = new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${REF})`, FLAGS);
      const fromRx = new RegExp(`\\b(FROM|JOIN)\\s+(?:LATERAL\\s+)?(${REF})`, FLAGS);
      const cteRx = /\b([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi;
      const aliasStop =
        /^(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|ON|GROUP|ORDER|LIMIT|UNION|SET|USING|OFFSET|HAVING|FOR|RETURNING|WINDOW|EXCEPT|INTERSECT|NATURAL|LATERAL|SELECT)\b)[A-Za-z_]\w*)?\s*,\s*/i;
      // A string is SQL when it holds a statement shape: SELECT ... FROM, INSERT INTO, UPDATE ... SET, DELETE FROM,
      // CREATE TABLE or TRUNCATE (anywhere in it, so a parenthesized subquery or a CTE fragment counts).
      const sqlShape =
        /\bSELECT\b[\s\S]*?\bFROM\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\b[\s\S]*?\bSET\b|\bCREATE\s+(?:[A-Z]+\s+)*TABLE\b|\bTRUNCATE\b/i;
      const idRx = new RegExp(ID, "g");
      const stripComments = (t: string): string =>
        t.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, "");
      /** The text a call returns when it returns a string or a template (substitutions become `#`). */
      const returnedText = (file: string, call: SgNode): string | null => {
        if (!has("call-return")) return null;
        const fn = call.field("function");
        let d: Decl | null = null;
        if (fn?.kind() === "identifier") d = resolveName(file, fn);
        else if (fn?.kind() === "member_expression") {
          const o = fn.field("object");
          const p = fn.field("property");
          if (o?.kind() === "identifier" && p) d = resolveMember(file, o.text(), p.text());
        }
        const r0 = d?.fn ? returnsOf(d.fn)[0] : undefined;
        if (!d || !r0) return null;
        const lit = unparen(r0);
        let out: string | null = null;
        if (lit.kind() === "template_string")
          out = lit
            .children()
            .map((c) => (c.kind() === "template_substitution" ? "#" : c.kind() === "`" ? "" : c.text()))
            .join("");
        else out = stringOf(lit);
        if (out !== null) used("call-return");
        return out;
      };

      interface Cand {
        file: string;
        line: number;
        text: string;
        subst: (i: number) => string | null;
        node?: SgNode;
      }
      const cands: Cand[] = [];
      const lang = (f: string): Language => files.get(f) ?? "typescript";
      for (const f of eligible) {
        const r = rootOf(f);
        if (!r) continue;
        const goFile = lang(f) === "go";
        const nodes = r.findAll({
          rule: {
            any: goFile
              ? [{ kind: "interpreted_string_literal" }, { kind: "raw_string_literal" }]
              : [{ kind: "string" }, { kind: "template_string" }],
          },
        });
        for (const n of nodes) {
          const k = String(n.kind());
          let text = "";
          const exprs: SgNode[] = [];
          if (k === "template_string") {
            for (const c of n.children()) {
              const ck = String(c.kind());
              if (ck === "template_substitution") {
                exprs.push(named(c)[0] as SgNode);
                text += PH(exprs.length - 1);
              } else if (ck !== "`") text += c.text();
            }
          } else text = n.text().slice(1, -1);
          // A tagged template (`sql`...``, `$queryRaw`...``) is SQL whatever it starts with.
          const p = n.parent();
          const tagged =
            k === "template_string" &&
            p?.kind() === "call_expression" &&
            tags.has(p.field("function")?.text().replace(/^.*\./, "") ?? "");
          if (!tagged && !sqlShape.test(stripComments(text))) continue;
          cands.push({
            file: f,
            line: n.range().start.line + 1,
            text,
            node: n,
            subst: (i) => {
              const ex = exprs[i];
              if (!ex) return null;
              const s = strOf(f, ex);
              if (s !== null) return s;
              return ex.kind() === "call_expression" ? returnedText(f, ex) : null;
            },
          });
        }
      }
      if (cfg.sqlFiles) {
        for (const f of listTextFiles(root, (rel) => rel.endsWith(".sql") && !excluded(rel))) {
          cands.push({ file: f, line: 1, text: readFileSync(path.join(root, f), "utf8"), subst: () => null });
        }
      }

      interface Ref {
        kind: "read" | "write" | "create";
        name: string | null;
        reason?: string;
        cand: Cand;
        line: number;
      }
      const refs: Ref[] = [];
      const clean = (t: string): string =>
        t
          .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "))
          .replace(/--[^\n]*/g, "")
          .replace(/'(?:[^']|'')*'/g, "''");
      const nameOf = (ref: string, c: Cand): { name: string | null; reason?: string } => {
        const segs = ref.match(idRx) ?? [];
        const last = segs[segs.length - 1];
        if (!last) return { name: null, reason: "no table name" };
        if (last.startsWith("\u0001")) {
          const v = c.subst(Number(last.slice(1, -1)));
          return v
            ? { name: v.replace(/^.*\./, "") }
            : { name: null, reason: "table name is built at runtime" };
        }
        return { name: last.replace(/^["`]|["`]$/g, "") };
      };
      for (const c of cands) {
        const text = clean(c.text);
        const ctes = new Set<string>();
        for (const m of text.matchAll(cteRx)) ctes.add((m[1] as string).toLowerCase());
        const add = (kind: Ref["kind"], ref: string, off: number) => {
          const nm = nameOf(ref, c);
          if (nm.name && ref.indexOf(".") < 0 && ctes.has(nm.name.toLowerCase())) return;
          refs.push({ kind, ...nm, cand: c, line: c.line + lineInText(text, off) });
        };
        for (const m of text.matchAll(createRx)) add("create", m[1] as string, m.index ?? 0);
        for (const m of text.matchAll(insertRx)) add("write", m[1] as string, m.index ?? 0);
        for (const m of text.matchAll(updateRx)) add("write", m[1] as string, m.index ?? 0);
        for (const m of text.matchAll(deleteRx)) add("write", m[1] as string, m.index ?? 0);
        for (const m of text.matchAll(truncateRx)) add("write", m[1] as string, m.index ?? 0);
        for (const m of text.matchAll(fromRx)) {
          const idx = m.index ?? 0;
          if (/DELETE\s+$/i.test(text.slice(Math.max(0, idx - 12), idx))) continue;
          const end = idx + m[0].length;
          if (/^\s*\(/.test(text.slice(end))) continue; // a function call, not a table
          add("read", m[2] as string, idx);
          if (m[1]?.toUpperCase() === "FROM") {
            let rest = text.slice(end);
            let base = end;
            for (;;) {
              const lead = aliasStop.exec(rest);
              if (!lead) break;
              const after = rest.slice(lead[0].length);
              const mm = new RegExp(`^(${REF})`, "i").exec(after);
              if (!mm || /^\s*\(/.test(after.slice(mm[0].length))) break;
              add("read", mm[1] as string, base + lead[0].length);
              const adv = lead[0].length + mm[0].length;
              rest = rest.slice(adv);
              base += adv;
            }
          }
        }
      }
      for (const r of refs) {
        if (r.kind !== "create" || !r.name || !okDecl(r.cand.file)) continue;
        used("sql-text");
        addTable(r.name, r.cand.file, r.line, "sql-create");
      }
      for (const r of refs) {
        if (r.kind === "create" || !okAccess(r.cand.file)) continue;
        const line = r.line;
        if (!r.name) {
          lowConfidence.push({
            file: r.cand.file,
            line,
            rule: "sql-text",
            reason: r.reason ?? "table name is built at runtime",
          });
          continue;
        }
        const k = tableByKey.has(keyOf(r.name)) ? keyOf(r.name) : null;
        if (!k) {
          if (cfg.knownTablesOnly) {
            helperUse["sql-undeclared-skipped"] = (helperUse["sql-undeclared-skipped"] ?? 0) + 1;
            continue;
          }
          continue;
        }
        used("sql-text");
        const src = r.cand.node ? topLevelSymbol(r.cand.file, r.cand.node) : `file:${r.cand.file}`;
        pushAccess(r.kind, k, r.cand.file, line, src, "sql-text", "high");
      }
    }

    // 4. Reads and writes from syntax rules.
    const isRead = new Set(recipe.methods?.read ?? []);
    const isWrite = new Set(recipe.methods?.write ?? []);
    for (const m of matches) {
      const e = m.rule.emit;
      if (e.kind !== "access") continue;
      let kind: "read" | "write" | undefined = e.as;
      if (!kind) {
        const mt = e.method ? textOfCapture(m, e.method, true) : null;
        if (!mt) continue;
        if (isWrite.has(mt)) kind = "write";
        else if (isRead.has(mt)) kind = "read";
        else continue;
        used("method-classes");
      }
      const hits: { key: string; conf: "high" | "low" }[] = [];
      for (const t of e.target ? cap(m, e.target) : []) {
        const h = tableOfExpr(m.file, t);
        if (h) hits.push(h);
      }
      for (const t of e.model ? cap(m, e.model) : []) {
        const s = stringOf(t) ?? t.text();
        const k = resolveModel(s);
        if (k) hits.push({ key: k, conf: "high" });
      }
      if (hits.length === 0 && e.receiver && e.modelFromReceiverDecl) {
        const recv = cap(m, e.receiver)[0];
        const d = recv ? receiverDecl(m.file, recv) : null;
        if (d) {
          for (const tpl of e.modelFromReceiverDecl) {
            const hit = new RegExp(tpl.replaceAll("{prop}", escRe(d.prop)), "s").exec(d.text);
            const k = hit?.[1] ? resolveModel(hit[1]) : null;
            if (k) {
              hits.push({ key: k, conf: "high" });
              break;
            }
          }
        }
      }
      // The line of a call is the line of its method name (a chain `db\n.select()\n.from(t)` reports the `.from`).
      const callee = m.node.kind() === "call_expression" ? m.node.field("function") : null;
      const at =
        callee?.kind() === "member_expression"
          ? callee.field("property")
          : callee?.kind() === "selector_expression"
            ? callee.field("field")
            : null;
      const line = (at ?? m.node).range().start.line + 1;
      for (const h of hits)
        pushAccess(kind, h.key, m.file, line, topLevelSymbol(m.file, m.node), m.rule.id, h.conf);
    }
  }

  const linkMs = performance.now() - tl;
  const dedupe = <T extends { id: string }>(xs: T[]): T[] => {
    const seen = new Set<string>();
    return xs
      .sort((a, b) => cmp(a.id, b.id))
      .filter((x) => {
        if (seen.has(x.id)) return false;
        seen.add(x.id);
        return true;
      });
  };
  return {
    tables: tables.sort((a, b) => cmp(keyOf(a.name), keyOf(b.name))),
    accesses: accesses.sort(
      (a, b) =>
        cmp(a.file, b.file) ||
        a.line - b.line ||
        cmp(a.kind, b.kind) ||
        cmp(a.table, b.table) ||
        cmp(a.rule, b.rule),
    ),
    lowConfidence: lowConfidence.sort(
      (a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.reason, b.reason),
    ),
    helperUse: Object.fromEntries(Object.entries(helperUse).sort(([a], [b]) => cmp(a, b))),
    endpoints: dedupe(endpoints),
    middleware: dedupe(middleware),
    routes: dedupe(routes),
    unresolved,
    droppedNotRouter,
    matches: counts,
    files: eligible.length,
    ms: { parse: parseMs, match: matchMs - parseMs, link: linkMs, total: performance.now() - t0 },
  };
}

// Spike engine: runs an agent-written recipe (ast-grep rules plus a short list of named, language-blind helpers)
// over a repo and returns routes, endpoints, middleware and tables. Not production code; see ../v2-recipe-agent.md.
// Copied from ../v2-recipes/engine.ts and extended: per-rule examples, zero-match warnings, text (regex) rules,
// table emits, path-from-file emits, enclosing-class prefixes and "METHOD /path" strings.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import go from "@ast-grep/lang-go";
import { Lang, parse, type Rule, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

registerDynamicLanguage({ go });

export type Language = "typescript" | "go" | "text";
/**
 * A capture: `$NAME` (a metavariable of the rule), `$$$NAME` (a multi-metavariable), `=text` (a literal), or
 * `#N` (group N of a text rule's regex match; `#0` is the whole match).
 */
export type Capture = string;

/**
 * A URL path computed from the repo-relative file path: `pattern` is a regex tested against the path, `template`
 * the URL with `$1`..`$9` for its groups, and `rewrite` a list of regex replacements applied to the result in order
 * (for example dropping `(group)` segments or turning `index` into nothing).
 */
export interface PathFromFile {
  pattern: string;
  template: string;
  rewrite?: { regex: string; with: string }[];
}

export type Emit =
  /** A router instance (the match is its constructor expression); `base` is a base path of its own. */
  | { kind: "router"; base?: Capture }
  /** `child` is reachable under `parent` at `prefix`. `childIsScope`: the child is a function whose first parameter is the router. */
  | { kind: "mount"; parent: Capture; child: Capture; prefix?: Capture; childIsScope?: boolean }
  /** A handler registration. `pathFromChain`: no path argument, reuse the previous call's path in the same chain. */
  | {
      kind: "endpoint";
      /** Required unless `pathFromFile` or `standalone` is set. */
      receiver?: Capture;
      method: Capture;
      path?: Capture;
      handler?: Capture;
      pathFromChain?: boolean;
      /** Path computed from the file path (file-system routing). Needs no receiver. */
      pathFromFile?: PathFromFile;
      /** No receiver: the registration is on a global app; its prefix (if any) is `prefix`. */
      standalone?: boolean;
      /** A literal or capture joined before the path (a global prefix, an API version). */
      prefix?: Capture;
      /** The prefix of the nearest enclosing node of `kind`: the first match of `rule` inside it, read at `capture`. */
      ancestorPrefix?: { kind: string; rule: Rule; capture: Capture };
      /** The path string is `"GET /x"`: split the method off it (Go 1.22 net/http patterns). */
      splitMethod?: boolean;
    }
  | { kind: "middleware"; receiver: Capture; path?: Capture; handler: Capture }
  /** A page route; `id` is the framework's route id, `options` an object literal read with `component`. */
  | { kind: "route"; id?: Capture; options?: Capture; root?: boolean; pathFromFile?: PathFromFile }
  /** A database table, collection or model. `name` is a capture; `#N` reads a regex group of a text rule. */
  | { kind: "table"; name: Capture };

export interface RecipeRule {
  id: string;
  language: Language;
  /** Repo-relative globs (`**` and `*` only). Default: every source file of the language. */
  files?: string[];
  /** For `text` rules: `{ regex }` is a JavaScript regex (flags `gm`) over the whole file; no `regex` = one match per file. */
  rule: Rule;
  constraints?: Record<string, Rule>;
  emit: Emit;
  /** Snippets that must match, and snippets that must not. Checked before a recipe is accepted. */
  examples?: { match: string[]; noMatch: string[] };
}

/** Named helpers a recipe may ask for. Each is generic (no framework names inside) except `tanstack-file-routes`. */
export type Helper =
  | "resolve-names" // identifiers to declarations: scopes, parameters, imports and re-exports (TS), package scope (Go)
  | "const-strings" // a path argument that is an identifier reads the const string it names
  | "mount-graph" // routers, mounts and base paths composed into full paths; receivers must be routers
  | "call-return" // a mounted `f()` or `T{}.M()` is the router that function returns
  | "param-flow" // a router passed as an argument flows into the callee's parameter
  | "tanstack-file-routes"; // built-in TanStack helper: file name to route id, URL path, parent route

export interface Recipe {
  name: string;
  frameworks: { name: string; evidence: string }[];
  /** Files qualify only in packages that declare one of `dependency` (TS), or files importing one of `imports`. */
  when?: { dependency?: string[]; imports?: string[] };
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
export interface Table {
  id: string;
  name: string;
  file: string;
  line: number;
  rule: string;
}
export interface RecipeOutput {
  endpoints: Endpoint[];
  tables: Table[];
  /** Rules that matched nothing in the repo: a warning, not an error (they may be for constructs not used yet). */
  zeroMatchRules: string[];
  /** The first three matches of each rule: file, line and the first line of the matched text. */
  samples: Record<string, { file: string; line: number; text: string }[]>;
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
const TEXT_SKIP =
  /\.(?:png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|pdf|zip|gz|lock|map|min\.js)$|^package-lock\.json$/;
const TS_SKIP = /(?:\.d\.ts|\.test\.tsx?|\.spec\.tsx?|\.gen\.ts)$/;

function listFiles(root: string, lang: Language): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (
          lang === "text"
            ? !TEXT_SKIP.test(e)
            : lang === "typescript"
              ? TS_RE.test(e) && !TS_SKIP.test(e)
              : e.endsWith(".go") && !e.endsWith("_test.go")
        )
          out.push(rel);
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
  const langs = [...new Set(recipe.rules.map((r) => r.language))];
  const files = new Map<string, Language>();
  const textFiles = new Set<string>();
  for (const l of langs) {
    if (l === "text") continue;
    for (const f of listFiles(root, l)) files.set(f, l);
  }
  if (langs.includes("text")) for (const f of listFiles(root, "text")) textFiles.add(f);

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
  const qualifies = (file: string): boolean => {
    const w = recipe.when;
    if (!w) return true;
    if (w.dependency && files.get(file) === "typescript") {
      const p = pkgOf(file);
      if (!p || !w.dependency.some((d) => p.deps.has(d))) return false;
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
  const samples: Record<string, { file: string; line: number; text: string }[]> = {};
  const sample = (id: string, file: string, line: number, text: string) => {
    const l = samples[id] ?? [];
    samples[id] = l;
    if (l.length < 3) l.push({ file, line, text: text.split("\n")[0]?.slice(0, 100) ?? "" });
  };
  const fileList = [...files.keys()].sort(cmp);
  const eligible = fileList.filter(qualifies);
  for (const rule of recipe.rules) {
    counts[rule.id] = 0;
    const res = (rule.files ?? []).map(globRe);
    if (rule.language === "text") continue;
    for (const file of eligible) {
      if (files.get(file) !== rule.language) continue;
      if (res.length > 0 && !res.some((r) => r.test(file))) continue;
      const r = rootOf(file);
      if (!r) continue;
      for (const node of r.findAll({ rule: rule.rule, constraints: rule.constraints })) {
        matches.push({ rule, file, node });
        counts[rule.id] = (counts[rule.id] ?? 0) + 1;
        sample(rule.id, file, node.range().start.line + 1, node.text());
      }
    }
  }
  // Text rules: a regex over the whole file (schema files, SQL, config), or one match per file when no regex.
  interface TextMatch {
    rule: RecipeRule;
    file: string;
    groups: string[];
    line: number;
  }
  const textMatches: TextMatch[] = [];
  for (const rule of recipe.rules) {
    if (rule.language !== "text") continue;
    counts[rule.id] = 0;
    const res = (rule.files ?? []).map(globRe);
    if (res.length === 0) continue; // a text rule must name its files
    const re = rule.rule.regex ? new RegExp(rule.rule.regex, "gm") : null;
    for (const file of [...textFiles].sort(cmp)) {
      if (!res.some((r) => r.test(file))) continue;
      if (!re) {
        textMatches.push({ rule, file, groups: [file], line: 1 });
        sample(rule.id, file, 1, file);
        counts[rule.id] = (counts[rule.id] ?? 0) + 1;
        continue;
      }
      const src = readFileSync(path.join(root, file), "utf8");
      for (const mm of src.matchAll(re)) {
        textMatches.push({
          rule,
          file,
          groups: [...mm].map((x) => x ?? ""),
          line: src.slice(0, mm.index ?? 0).split("\n").length,
        });
        counts[rule.id] = (counts[rule.id] ?? 0) + 1;
        sample(rule.id, file, src.slice(0, mm.index ?? 0).split("\n").length, mm[0]);
        if (mm[0] === "") re.lastIndex++;
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
      return d?.value ? stringOf(d.value) : null;
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

  // Sites that need no router graph: tables, file-system routes, global-app endpoints, decorator prefixes.
  interface Site {
    file: string;
    rule: RecipeRule;
    line: number;
    node?: SgNode;
    get: (c: Capture | undefined) => string | null;
  }
  const direct: Site[] = [];
  const unquote = (n: SgNode): string => stringOf(n) ?? n.text();
  function siteOfMatch(m: Match): Site {
    return {
      file: m.file,
      rule: m.rule,
      line: m.node.range().start.line + 1,
      node: m.node,
      get: (c) => {
        if (!c) return null;
        if (c.startsWith("=")) return c.slice(1);
        const n = cap(m, c)[0];
        if (!n) return null;
        return strOf(m.file, n) ?? unquote(n);
      },
    };
  }
  const siteOfText = (t: TextMatch): Site => ({
    file: t.file,
    rule: t.rule,
    line: t.line,
    get: (c) => {
      if (!c) return null;
      if (c.startsWith("=")) return c.slice(1);
      if (c.startsWith("#")) return t.groups[Number(c.slice(1))] ?? null;
      return null;
    },
  });
  for (const t of textMatches) direct.push(siteOfText(t));
  const fileUrl = (file: string, pf: PathFromFile): string | null => {
    const mm = new RegExp(pf.pattern).exec(file);
    if (!mm) return null;
    let url = pf.template.replace(/\$(\d)/g, (_, i) => mm[Number(i)] ?? "");
    for (const r of pf.rewrite ?? []) url = url.replace(new RegExp(r.regex, "g"), r.with);
    return joinPaths([url]);
  };

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
        let fnNode: SgNode = childN;
        let fnFile = m.file;
        if (childN.kind() === "identifier" && has("resolve-names")) {
          const d = resolveName(m.file, childN);
          if (d?.fn) {
            fnNode = d.fn;
            fnFile = d.file;
          }
        }
        const p = FN_KINDS[langOf(fnFile)].has(String(fnNode.kind())) ? paramsOf(fnNode)[0] : undefined;
        child = p ? pos(fnFile, p) : null;
      } else child = resolveExpr(m.file, childN);
      if (!child) continue;
      const prefix = e.prefix ? strOf(m.file, cap(m, e.prefix)[0]) : "";
      links.push({ parent, child, prefix: prefix ?? ":dynamic" });
      childKeys.add(child);
    } else if (e.kind === "table") {
      direct.push(siteOfMatch(m));
    } else if (
      (e.kind === "endpoint" && (e.pathFromFile || e.standalone || e.ancestorPrefix || !e.receiver)) ||
      (e.kind === "route" && e.pathFromFile)
    ) {
      direct.push(siteOfMatch(m));
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
      let methods = e.kind === "endpoint" ? methodsOf(m, e.method) : [];
      if (e.kind === "endpoint" && e.splitMethod && p !== null) {
        const sm = /^([A-Za-z]+)\s+(\S.*)$/.exec(p);
        if (sm) {
          methods = [(sm[1] as string).toUpperCase()];
          p = sm[2] as string;
        }
      }
      pending.push({
        m,
        receiver: resolveExpr(m.file, recv),
        methods,
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

  // --- direct sites -----------------------------------------------------------------------------------------
  const tables: Table[] = [];
  const routes: Route[] = [];
  for (const site of direct) {
    const e = site.rule.emit;
    const ws = wsOf(site.file);
    if (e.kind === "table") {
      const name = site.get(e.name);
      if (name)
        tables.push({
          id: `table:${name.toLowerCase()}`,
          name,
          file: site.file,
          line: site.line,
          rule: site.rule.id,
        });
    } else if (e.kind === "route" && e.pathFromFile) {
      const url = fileUrl(site.file, e.pathFromFile);
      if (url !== null)
        routes.push({
          id: `route:${ws}:${url}`,
          routeId: url,
          urlPath: url,
          componentSymbol: null,
          file: site.file,
        });
    } else if (e.kind === "endpoint") {
      let own: string | null = e.pathFromFile ? fileUrl(site.file, e.pathFromFile) : site.get(e.path);
      if (own === null) {
        if (e.path)
          unresolved.push({
            file: site.file,
            line: site.line,
            rule: site.rule.id,
            reason: "path is not a literal",
          });
        continue;
      }
      let methods = site.node
        ? methodsOf({ rule: site.rule, file: site.file, node: site.node }, e.method)
        : [site.get(e.method) ?? "ALL"];
      if (e.splitMethod) {
        const sm = /^([A-Za-z]+)\s+(\S.*)$/.exec(own);
        if (sm) {
          methods = [(sm[1] as string).toUpperCase()];
          own = sm[2] as string;
        }
      }
      let anc = "";
      if (e.ancestorPrefix && site.node) {
        for (let a = site.node.parent(); a; a = a.parent()) {
          if (String(a.kind()) !== e.ancestorPrefix.kind) continue;
          const hit = a.find({ rule: e.ancestorPrefix.rule });
          const c = e.ancestorPrefix.capture;
          const n = hit && c.startsWith("$") ? hit.getMatch(c.slice(1)) : null;
          if (n) anc = unquote(n);
          break;
        }
      }
      const pre = site.get(e.prefix) ?? "";
      const full = joinPaths([pre, anc, own]);
      for (const method of methods) {
        endpoints.push({
          id: `ep:${ws}:${method} ${full}`,
          ws,
          method,
          path: full,
          handler:
            e.handler && site.node
              ? labelOf(cap({ rule: site.rule, file: site.file, node: site.node }, e.handler)[0])
              : "none",
          handlerSymbol: null,
          file: site.file,
          line: site.line,
          rule: site.rule.id,
        });
      }
    }
  }

  // --- page routes ------------------------------------------------------------------------------------------
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
    endpoints: dedupe(endpoints),
    tables: dedupe(tables),
    zeroMatchRules: Object.entries(counts)
      .filter(([, n]) => n === 0)
      .map(([id]) => id)
      .sort(cmp),
    middleware: dedupe(middleware),
    routes: dedupe(routes),
    unresolved,
    droppedNotRouter,
    matches: counts,
    samples,
    files: eligible.length + textFiles.size,
    ms: { parse: parseMs, match: matchMs - parseMs, link: linkMs, total: performance.now() - t0 },
  };
}

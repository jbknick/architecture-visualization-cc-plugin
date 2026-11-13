// Spike helpers: pure analysis over oxc-parser output. Not production code (M1 builds the real one).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const coreRequire = createRequire(
  fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url)),
);
// oxc is a dependency of packages/core only; load it from there and type just what the spike uses.
interface ResolverLike {
  resolveFileSync(file: string, request: string): { path?: string; error?: string; builtin?: unknown };
}
interface ResolverOptions {
  conditionNames: string[];
  extensions: string[];
  tsconfig: "auto";
  builtinModules: boolean;
}
const { parseSync } = coreRequire("oxc-parser") as {
  parseSync(filename: string, source: string): { program: unknown; errors: unknown[] };
};
export const { ResolverFactory } = coreRequire("oxc-resolver") as {
  ResolverFactory: new (options: ResolverOptions) => ResolverLike;
};
export const oxcVersions = {
  parser: (coreRequire("oxc-parser/package.json") as { version: string }).version,
  resolver: (coreRequire("oxc-resolver/package.json") as { version: string }).version,
};

type Node = { type: string } & Record<string, unknown>;

// ---------- file discovery (SPEC section 5) ----------

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".wrangler",
  "coverage",
]);
const SENSITIVE = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^id_rsa/,
  /^\.npmrc$/,
  /^credentials/,
  /^secrets/,
  /\.tfvars$/,
];

/** Built-in excludes from spec section 5, applied to a repo-relative posix path. */
export function isExcluded(path: string): boolean {
  const segs = path.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (!/\.(ts|tsx|mts|cts)$/.test(base)) return true;
  if (segs.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s))) return true;
  // nested worktrees (e.g. .claude/worktrees/*)
  for (let i = 1; i < segs.length - 1; i++) {
    if (segs[i] === "worktrees" && segs[i - 1]?.startsWith(".")) return true;
  }
  if (/\.d\.(ts|mts|cts)$/.test(base) || /\.gen\.(ts|tsx|mts|cts)$/.test(base)) return true;
  return SENSITIVE.some((re) => re.test(base));
}

export function listSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "*.ts", "*.tsx", "*.mts", "*.cts"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isExcluded(p))
    .sort();
}

// ---------- AST facts ----------

export interface Binding {
  local: string;
  imported: string; // "default" | "*" | exported name
}
export interface ImportFact {
  specifier: string;
  kind: "static" | "reexport" | "dynamic";
  typeOnly: boolean;
  bindings: Binding[];
}
export interface ExportFact {
  kind: "named" | "all" | "default" | "declaration";
  names: string[];
  source: string | null;
}
export type CallClass = "import" | "top-level" | "local-scope" | "global";
export interface CallFact {
  root: string;
  classification: CallClass;
  /** index into FileFacts.imports when classification is "import" */
  importIndex: number | null;
}
export interface FileFacts {
  imports: ImportFact[];
  exports: ExportFact[];
  functions: string[];
  calls: CallFact[];
  /** counts of calls to selected framework entry points anywhere in the file */
  markers: Record<string, number>;
  /** option keys passed to createFileRoute(...)({...}) */
  routeKeys: Record<string, number>;
  routePaths: string[];
  parseErrors: number;
}

const MARKERS = new Set([
  "createFileRoute",
  "createRootRoute",
  "createRootRouteWithContext",
  "createRoute",
  "sqliteTable",
  "Hono",
  "OpenAPIHono",
  "implement",
  "createServerFn",
]);

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "parent") continue;
    const v = node[key];
    if (typeof v === "object" && v !== null) walk(v, visit);
  }
}

function patternNames(p: unknown, into: Set<string>): void {
  if (!isNode(p)) return;
  switch (p.type) {
    case "Identifier":
      into.add(p.name as string);
      break;
    case "ObjectPattern":
      for (const prop of p.properties as unknown[]) {
        if (isNode(prop) && prop.type === "RestElement") patternNames(prop.argument, into);
        else if (isNode(prop)) patternNames(prop.value, into);
      }
      break;
    case "ArrayPattern":
      for (const el of p.elements as unknown[]) patternNames(el, into);
      break;
    case "RestElement":
      patternNames(p.argument, into);
      break;
    case "AssignmentPattern":
      patternNames(p.left, into);
      break;
    case "TSParameterProperty":
      patternNames(p.parameter, into);
      break;
  }
}

/** Names declared anywhere inside a function (params, vars, nested functions/classes, catch params). */
function localNames(fn: Node): Set<string> {
  const names = new Set<string>();
  walk(fn, (n) => {
    switch (n.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        for (const prm of (n.params as unknown[]) ?? []) patternNames(prm, names);
        if (n.type === "FunctionDeclaration" && isNode(n.id)) names.add(n.id.name as string);
        break;
      case "VariableDeclarator":
        patternNames(n.id, names);
        break;
      case "ClassDeclaration":
        if (isNode(n.id)) names.add(n.id.name as string);
        break;
      case "CatchClause":
        patternNames(n.param, names);
        break;
    }
  });
  return names;
}

function calleeRoot(callee: unknown): string | null {
  let c: unknown = callee;
  for (let i = 0; i < 64 && isNode(c); i++) {
    if (c.type === "Identifier") return c.name as string;
    if (c.type === "MemberExpression") c = c.object;
    else if (c.type === "CallExpression") c = c.callee;
    else if (c.type === "ChainExpression") c = c.expression;
    else if (c.type === "TSNonNullExpression" || c.type === "ParenthesizedExpression") c = c.expression;
    else return null;
  }
  return null;
}

function strLit(n: unknown): string | null {
  return isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : null;
}

function declName(d: Node): string | null {
  return isNode(d.id) ? (d.id.name as string) : null;
}

export function analyzeFile(filename: string, source: string): FileFacts {
  const result = parseSync(filename, source);
  const program = result.program as unknown as Node;
  const facts: FileFacts = {
    imports: [],
    exports: [],
    functions: [],
    calls: [],
    markers: {},
    routeKeys: {},
    routePaths: [],
    parseErrors: result.errors.length,
  };
  const importByLocal = new Map<string, number>();
  const topLevel = new Set<string>();
  const fnNodes: Node[] = [];

  const addImport = (f: ImportFact): number => facts.imports.push(f) - 1;

  const noteFunction = (name: string | null, node: Node) => {
    facts.functions.push(name ?? "default");
    fnNodes.push(node);
  };

  const handleDeclaration = (d: unknown): string[] => {
    if (!isNode(d)) return [];
    const names: string[] = [];
    if (d.type === "FunctionDeclaration") {
      const nm = declName(d);
      if (nm) {
        topLevel.add(nm);
        names.push(nm);
      }
      noteFunction(nm, d);
    } else if (d.type === "VariableDeclaration") {
      for (const dec of d.declarations as Node[]) {
        const ids = new Set<string>();
        patternNames(dec.id, ids);
        for (const id of ids) {
          topLevel.add(id);
          names.push(id);
        }
        const init = dec.init;
        if (isNode(init) && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
          noteFunction(isNode(dec.id) && dec.id.type === "Identifier" ? (dec.id.name as string) : null, init);
        }
      }
    } else if (d.type === "ClassDeclaration" || d.type.startsWith("TS")) {
      const nm = declName(d);
      if (nm) {
        topLevel.add(nm);
        names.push(nm);
      }
    }
    return names;
  };

  for (const stmt of (program.body as unknown[]) ?? []) {
    if (!isNode(stmt)) continue;
    switch (stmt.type) {
      case "ImportDeclaration": {
        const bindings: Binding[] = [];
        for (const s of stmt.specifiers as Node[]) {
          const local = (s.local as Node).name as string;
          if (s.type === "ImportDefaultSpecifier") bindings.push({ local, imported: "default" });
          else if (s.type === "ImportNamespaceSpecifier") bindings.push({ local, imported: "*" });
          else
            bindings.push({
              local,
              imported: ((s.imported as Node).name ?? (s.imported as Node).value) as string,
            });
        }
        const idx = addImport({
          specifier: (stmt.source as Node).value as string,
          kind: "static",
          typeOnly: stmt.importKind === "type",
          bindings,
        });
        if (stmt.importKind !== "type") for (const b of bindings) importByLocal.set(b.local, idx);
        break;
      }
      case "ExportNamedDeclaration": {
        const src = strLit(stmt.source);
        if (src !== null) {
          addImport({ specifier: src, kind: "reexport", typeOnly: stmt.exportKind === "type", bindings: [] });
          facts.exports.push({ kind: "named", names: [], source: src });
        } else if (stmt.declaration) {
          facts.exports.push({
            kind: "declaration",
            names: handleDeclaration(stmt.declaration),
            source: null,
          });
        } else {
          const names = (stmt.specifiers as Node[]).map(
            (s) => ((s.exported as Node).name ?? (s.exported as Node).value) as string,
          );
          facts.exports.push({ kind: "named", names, source: null });
        }
        break;
      }
      case "ExportAllDeclaration": {
        const src = strLit(stmt.source) ?? "";
        addImport({ specifier: src, kind: "reexport", typeOnly: stmt.exportKind === "type", bindings: [] });
        facts.exports.push({ kind: "all", names: [], source: src });
        break;
      }
      case "ExportDefaultDeclaration": {
        const d = stmt.declaration;
        if (isNode(d) && d.type === "FunctionDeclaration") {
          const nm = declName(d);
          if (nm) topLevel.add(nm);
          noteFunction(nm, d);
        } else if (isNode(d) && (d.type === "ArrowFunctionExpression" || d.type === "FunctionExpression")) {
          noteFunction(null, d);
        }
        facts.exports.push({ kind: "default", names: ["default"], source: null });
        break;
      }
      default:
        handleDeclaration(stmt);
    }
  }

  // Whole-file pass: dynamic imports and framework markers.
  walk(program, (n) => {
    if (n.type === "ImportExpression") {
      const s = strLit(n.source);
      if (s !== null) addImport({ specifier: s, kind: "dynamic", typeOnly: false, bindings: [] });
    } else if (n.type === "CallExpression" || n.type === "NewExpression") {
      const callee = n.callee;
      if (isNode(callee) && callee.type === "Identifier" && MARKERS.has(callee.name as string)) {
        const name = callee.name as string;
        facts.markers[name] = (facts.markers[name] ?? 0) + 1;
        if (name === "createFileRoute") {
          const arg = strLit((n.arguments as unknown[])[0]);
          if (arg !== null) facts.routePaths.push(arg);
        }
      }
      // createFileRoute("/x")({ component, loader, ... })
      if (n.type === "CallExpression" && isNode(callee) && callee.type === "CallExpression") {
        const inner = callee.callee;
        if (isNode(inner) && inner.type === "Identifier" && inner.name === "createFileRoute") {
          const opts = (n.arguments as unknown[])[0];
          if (isNode(opts) && opts.type === "ObjectExpression") {
            for (const p of opts.properties as Node[]) {
              const k = isNode(p.key) ? ((p.key.name ?? p.key.value) as string | undefined) : undefined;
              if (k) facts.routeKeys[k] = (facts.routeKeys[k] ?? 0) + 1;
            }
          }
        }
      }
    }
  });

  // Call sites inside top-level function bodies, mapped without type info.
  for (const fn of fnNodes) {
    const locals = localNames(fn);
    walk(fn.body, (n) => {
      if (n.type !== "CallExpression") return;
      const root = calleeRoot(n.callee);
      if (root === null) return;
      if (locals.has(root)) facts.calls.push({ root, classification: "local-scope", importIndex: null });
      else if (importByLocal.has(root)) {
        facts.calls.push({ root, classification: "import", importIndex: importByLocal.get(root) ?? null });
      } else if (topLevel.has(root))
        facts.calls.push({ root, classification: "top-level", importIndex: null });
      else facts.calls.push({ root, classification: "global", importIndex: null });
    });
  }

  return facts;
}

// ---------- resolution classification ----------

export type ResolutionClass = "repo" | "node_modules" | "builtin" | "unresolved";

export function classifyResolved(
  root: string,
  r: { path?: string; error?: string; builtin?: unknown },
): ResolutionClass {
  if (r.builtin) return "builtin";
  if (!r.path) return "unresolved";
  const p = r.path.split(posix.sep).join("/");
  if (p.includes("/node_modules/")) return "node_modules";
  if (p.startsWith(`${root.replace(/\/$/, "")}/`)) return "repo";
  return "unresolved";
}

export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

export interface UnresolvedContext {
  workspaceNames: Set<string>;
}

const ALIAS_PREFIXES = ["~/", "@/", "#/"];

export function isWorkspaceSpecifier(spec: string, ctx: UnresolvedContext): boolean {
  for (const name of ctx.workspaceNames) if (spec === name || spec.startsWith(`${name}/`)) return true;
  return false;
}

export function isInternalSpecifier(spec: string, ctx: UnresolvedContext): boolean {
  if (isRelative(spec)) return true;
  if (ALIAS_PREFIXES.some((p) => spec.startsWith(p))) return true;
  return isWorkspaceSpecifier(spec, ctx);
}

/** Reason an import is unresolved. Heuristic, from the specifier shape and the resolver error. */
export function unresolvedReason(spec: string, error: string | undefined, ctx: UnresolvedContext): string {
  if (/^[a-z-]+:/.test(spec) && !spec.startsWith("node:"))
    return "virtual or runtime-provided module (scheme prefix)";
  if (spec.startsWith("#") && !spec.startsWith("#/")) return "package.json imports map (#subpath)";
  if (/[?!]/.test(spec)) return "bundler query or loader suffix (?raw, ?url, ...)";
  if (/\.(css|scss|svg|png|jpe?g|webp|gif|ico|woff2?|json5?|md|mdx|sql|txt|html)$/.test(spec)) {
    return "non-TS asset import";
  }
  if (/\.gen(\.|$)/.test(spec) || /routeTree/.test(spec)) return "generated module not present on disk";
  if (ALIAS_PREFIXES.some((p) => spec.startsWith(p))) return "path alias not covered by tsconfig paths";
  if (isRelative(spec)) return "relative path not found (missing file or generated output)";
  if (isWorkspaceSpecifier(spec, ctx)) {
    if (error && /export|condition/i.test(error))
      return "workspace package export condition or subpath not matched";
    return "workspace package entry points at unbuilt output or missing subpath";
  }
  if (error && /export|condition/i.test(error)) return "conditional export not matched by conditionNames";
  return "package not installed or no resolvable entry (types-only or conditional export)";
}

/** Strip anything that could identify private code: relative paths, workspace names, alias remainders. */
export function redactSpecifier(spec: string, ctx: UnresolvedContext): string {
  if (isRelative(spec)) return "<relative path>";
  const alias = ALIAS_PREFIXES.find((p) => spec.startsWith(p));
  if (alias) return `${alias}<path>`;
  if (isWorkspaceSpecifier(spec, ctx)) return "<workspace package>";
  if (/^[a-z-]+:/.test(spec) && !spec.startsWith("node:")) return `${spec.split(":")[0]}:<module>`;
  return spec;
}

// ---------- generalised path shapes for the report ----------

const GENERIC_DIRS = new Set([
  "src",
  "app",
  "routes",
  "routers",
  "router",
  "schema",
  "db",
  "api",
  "server",
  "client",
  "components",
  "lib",
  "utils",
  "hooks",
  "features",
  "modules",
  "middleware",
  "services",
  "tests",
  "e2e",
  "scripts",
  "test",
  "__tests__",
]);

/** Replace workspace-specific segments so a path can be described without naming private modules. */
export function generaliseDir(path: string): string {
  const segs = path.split("/").slice(0, -1);
  if (segs.length === 0) return ".";
  const out: string[] = [];
  let i = 0;
  if (["apps", "packages", "services", "libs"].includes(segs[0] ?? "")) {
    out.push(segs[0] as string, "<name>");
    i = 2;
  }
  for (; i < segs.length; i++) {
    const seg = segs[i] as string;
    // keep only framework-conventional folder names; anything else may be a private feature name
    const shown = GENERIC_DIRS.has(seg) ? seg : "<dir>";
    if (!(shown === "<dir>" && out[out.length - 1] === "<dir>")) out.push(shown);
    if (seg === "routes" && i < segs.length - 1) {
      out.push("...");
      break;
    }
  }
  return out.join("/");
}

export function routeFileShape(path: string): string {
  const base = (path.split("/").pop() ?? "").replace(/\.(tsx|ts|mts|cts)$/, "");
  if (base === "__root") return "__root";
  if (base.startsWith("-")) return "ignored (-prefix)";
  if (base === "route") return "route (directory route)";
  if (base === "index") return "index";
  if (base.startsWith("_") && !base.includes(".")) return "pathless layout (_prefix)";
  if (base.includes("$")) return base.includes(".") ? "flat dotted with $param" : "$param";
  if (base.includes(".")) return "flat dotted";
  return "plain segment";
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

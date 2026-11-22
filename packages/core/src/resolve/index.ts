import fs from "node:fs";
import path from "node:path";
import { ResolverFactory } from "oxc-resolver";
import picomatch from "picomatch";
import { BUILTIN_EXCLUDES } from "../config/index.js";
import { fileId as makeFileId, pathOfFileId } from "../ids.js";
import type { ParsedFile, ParsedImport, ParsedSite } from "../parse/index.js";
import type { EdgeKind, EdgeRecord, WorkspaceRecord } from "../types.js";
import { readJsonc, workspaceForPath } from "../workspace/index.js";
import { type BundlerAliases, readBundlerAliases } from "./bundlerAliases.js";

export interface ResolveContext {
  root: string;
  /** The repo name in every id (`GantryPaths.repo`). */
  repo: string;
  workspaces: WorkspaceRecord[];
  /** Parsed files keyed by file id (`file:<repo>:<repo-relative posix path>`). */
  parsed: Map<string, ParsedFile>;
}

export type SpecifierResolution =
  | { kind: "file"; fileId: string }
  | { kind: "external"; pkg: string }
  | { kind: "unresolved" };

/** How a specifier was classified internally. `generated` and `excluded` are reported as `unresolved`. */
export type SpecifierClass =
  | "file"
  | "external"
  | "builtin"
  | "virtual"
  | "generated"
  | "excluded"
  | "unresolved";

export interface UnresolvedSpecifier {
  fromFileId: string;
  specifier: string;
  class: "generated" | "excluded" | "unresolved";
  /** Set when a bundler alias that the index cannot read statically may stand behind the specifier. */
  reason?: "alias_not_static";
  /** With `reason`: the alias key the specifier starts with, or `*` when the whole alias value is unreadable. */
  alias?: string;
}

export interface ResolveStats {
  counts: Record<SpecifierClass, number>;
  /** Specifiers that resolved to nothing usable (generated, excluded or truly unresolved), sorted. */
  unresolved: UnresolvedSpecifier[];
}

export interface Resolver {
  resolveSpecifier(fromFileId: string, specifier: string): SpecifierResolution;
  /** Follows `export { x } from`, `export *` and imported-then-exported bindings. Cycle-safe, depth 10. */
  resolveSymbol(fileId: string, exportedName: string): string | null;
  /** All non-workspace edges whose source is this file or something inside it. Sorted by (src, dst, kind). */
  edgesForFile(fileId: string): EdgeRecord[];
  /**
   * Go only: the symbol id of the function or method that the call, or the function named without a call, at this
   * source range refers to (local type inference, no toolchain); null when it is not in the repository or unknown.
   */
  targetAt?(fileId: string, start: number, end: number): string | null;
  /** Go only: the name of the named type of the expression at this source range; null when unknown. */
  typeNameAt?(fileId: string, start: number, end: number): string | null;
  /** `depends_on` edges between workspaces, from package.json dependency names. Sorted. */
  workspaceEdges(): EdgeRecord[];
  /** Counts and unresolved list for every specifier resolved so far (each distinct pair counted once). */
  stats(): ResolveStats;
}

const MAX_DEPTH = 10;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

const matcherCache = new Map<string, (s: string) => boolean>();
function matcher(pattern: string): (s: string) => boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, m);
  }
  return m;
}

/** Same rule as file discovery: a pattern matches the path, an ancestor, or (slash-free) any segment. */
function matchesBuiltinExclude(p: string): boolean {
  const segments = p.split("/");
  const prefixes: string[] = [];
  for (let i = 1; i <= segments.length; i++) prefixes.push(segments.slice(0, i).join("/"));
  for (const pattern of BUILTIN_EXCLUDES) {
    const m = matcher(pattern);
    if (prefixes.some((pre) => m(pre))) return true;
    if (!pattern.includes("/") && segments.some((s) => m(s))) return true;
  }
  return false;
}

/** npm package name of a bare specifier, or null when it is not shaped like one. */
function packageName(spec: string): string | null {
  if (spec.startsWith("@")) {
    const m = /^(@[^/]+\/[^/]+)/.exec(spec);
    return m?.[1] ?? null;
  }
  const first = spec.split("/")[0];
  return first && /^[A-Za-z0-9_][\w.-]*$/.test(first) ? first : null;
}

function isBare(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !path.isAbsolute(spec);
}

function posix(p: string): string {
  return p.split(path.sep).join("/");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEdges(edges: EdgeRecord[]): EdgeRecord[] {
  return edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
}

/**
 * Evidence strings (`path:line`) kept per edge. It was 3 until #47; `trace` follows only the edges of an inline
 * handler whose evidence lies inside the handler's lines, and a router const often calls one helper from many
 * handlers, so 3 lines were too few to tell which handler a call belongs to.
 */
export const EVIDENCE_CAP = 20;

/** Accumulates edges by (src, dst, kind): sums counts, keeps up to EVIDENCE_CAP evidence strings, `high` wins. */
class EdgeBuilder {
  private readonly map = new Map<string, EdgeRecord>();
  constructor(private readonly fileId: string) {}

  add(
    src: string,
    dst: string,
    kind: EdgeKind,
    confidence: "high" | "low",
    evidence?: string,
    count = 1,
  ): void {
    const key = `${src}\0${dst}\0${kind}`;
    let e = this.map.get(key);
    if (!e) {
      e = { src, dst, kind, confidence, count: 0, evidence: [], fileId: this.fileId };
      this.map.set(key, e);
    }
    e.count += count;
    if (confidence === "high") e.confidence = "high";
    if (evidence !== undefined && e.evidence.length < EVIDENCE_CAP && !e.evidence.includes(evidence)) {
      e.evidence.push(evidence);
    }
  }

  build(): EdgeRecord[] {
    return sortEdges([...this.map.values()]);
  }
}

interface Classified {
  class: SpecifierClass;
  fileId?: string;
  pkg?: string;
  reason?: "alias_not_static";
  alias?: string;
}

export function createResolver(ctx: ResolveContext): Resolver {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(ctx.root);
  } catch {
    realRoot = path.resolve(ctx.root);
  }

  const wsByName = new Map<string, WorkspaceRecord>();
  for (const w of ctx.workspaces) if (w.dir !== ".") wsByName.set(w.name, w);
  const wsNamesByLength = [...wsByName.keys()].sort((a, b) => b.length - a.length || cmp(a, b));
  const rootWs = ctx.workspaces.find((w) => w.dir === ".");

  const resolvers = new Map<string, ResolverFactory>();
  const bundlerAliases = new Map<string, BundlerAliases>();
  const classCache = new Map<string, Classified>();
  const counted = new Map<string, UnresolvedSpecifier | null>();
  const counts: Record<SpecifierClass, number> = {
    file: 0,
    external: 0,
    builtin: 0,
    virtual: 0,
    generated: 0,
    excluded: 0,
    unresolved: 0,
  };

  const fileIdOf = (rel: string): string => makeFileId(ctx.repo, rel);
  const relOf = (id: string): string => pathOfFileId(id);

  function nearestTsconfig(wsDir: string): string | null {
    let dir = path.join(realRoot, wsDir === "." ? "" : wsDir);
    for (;;) {
      const candidate = path.join(dir, "tsconfig.json");
      if (fs.existsSync(candidate)) return candidate;
      if (dir === realRoot || !dir.startsWith(realRoot)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** The aliases of the Vite and webpack configs in the workspace directory (read, never run). */
  function aliasesOf(ws: WorkspaceRecord): BundlerAliases {
    let a = bundlerAliases.get(ws.id);
    if (!a) {
      a = readBundlerAliases(path.join(realRoot, ws.dir === "." ? "" : ws.dir));
      bundlerAliases.set(ws.id, a);
    }
    return a;
  }

  /** A key matches its specifier or the specifier plus `/` and a subpath; a trailing `$` means the exact specifier. */
  function keyMatches(key: string, spec: string): boolean {
    if (key.endsWith("$")) return spec === key.slice(0, -1);
    return spec === key || spec.startsWith(`${key}/`);
  }

  /** `alias_not_static` for a specifier that an alias the index could not read may have stood for. */
  function unreadableAlias(ws: WorkspaceRecord, spec: string): Classified {
    const hit = aliasesOf(ws).unreadable.find((u) => u.key === "*" || keyMatches(u.key, spec));
    return hit
      ? { class: "unresolved", reason: "alias_not_static", alias: hit.key }
      : { class: "unresolved" };
  }

  /**
   * The resolver of a workspace. Bundlers apply their aliases before anything else, but oxc-resolver tries tsconfig
   * `paths` before `alias`, so the aliases go to a second resolver without tsconfig that is asked first.
   */
  function resolverFor(ws: WorkspaceRecord, aliasOnly = false): ResolverFactory {
    const cacheKey = aliasOnly ? `${ws.id}\0alias` : ws.id;
    let r = resolvers.get(cacheKey);
    if (!r) {
      const tsconfig = aliasOnly ? null : nearestTsconfig(ws.dir);
      const aliases = aliasOnly ? aliasesOf(ws).aliases : [];
      r = new ResolverFactory({
        extensions: EXTENSIONS,
        extensionAlias: {
          ".js": [".ts", ".tsx", ".js", ".jsx"],
          ".jsx": [".tsx", ".jsx"],
          ".mjs": [".mts", ".mjs"],
          ".cjs": [".cts", ".cjs"],
        },
        conditionNames: ["import", "types", "default"],
        mainFields: ["types", "module", "main"],
        builtinModules: true,
        ...(aliases.length > 0
          ? { alias: Object.fromEntries(aliases.map((a) => [a.find, [a.target]] as const)) }
          : {}),
        ...(tsconfig ? { tsconfig: { configFile: tsconfig, references: "auto" as const } } : {}),
      });
      resolvers.set(cacheKey, r);
    }
    return r;
  }

  /** Find a parsed file for an absolute path without extension handling beyond the usual candidates. */
  function tryParsed(absBase: string): string | null {
    const rel = posix(path.relative(realRoot, absBase));
    if (rel.startsWith("..")) return null;
    const candidates: string[] = [rel];
    const stripped = rel.replace(SCRIPT_EXT_RE, "");
    if (stripped !== rel) {
      for (const ext of EXTENSIONS) candidates.push(stripped + ext);
    }
    for (const ext of EXTENSIONS) candidates.push(rel + ext);
    for (const ext of EXTENSIONS) candidates.push(`${rel}/index${ext}`);
    for (const c of candidates) {
      const id = fileIdOf(c);
      if (ctx.parsed.has(id)) return id;
    }
    return null;
  }

  /** Match `sub` ("." or "./x") against a flattened exports map, supporting a single `*` wildcard. */
  function exportsTarget(ws: WorkspaceRecord, sub: string): string | null {
    for (const e of ws.exportsMap ?? []) {
      if (e.subpath === sub) return e.target;
    }
    for (const e of ws.exportsMap ?? []) {
      const star = e.subpath.indexOf("*");
      if (star < 0) continue;
      const pre = e.subpath.slice(0, star);
      const post = e.subpath.slice(star + 1);
      if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
        return e.target.replace("*", sub.slice(pre.length, sub.length - post.length));
      }
    }
    return null;
  }

  /**
   * Built output mapped back to source. With a tsconfig.json in the workspace that sets `outDir`, a path under it maps to
   * the same relative path under `rootDir` (when unset: the common directory of the static parts of `include`, else the
   * workspace directory); without one, `dist`, `build`, `out` and `lib` map to `src`.
   */
  function sourceOfOutput(wsAbs: string, abs: string): string | null {
    const opts = readJsonc(path.join(wsAbs, "tsconfig.json"))?.compilerOptions;
    const o = opts && typeof opts === "object" ? (opts as Record<string, unknown>) : {};
    const sourceOf = (rest: string): string => rest.replace(/\.d\.([cm]?ts)$/, ".$1");
    if (typeof o.outDir === "string") {
      const rest = posix(path.relative(path.resolve(wsAbs, o.outDir), abs));
      if (rest.startsWith("..") || path.isAbsolute(rest)) return null;
      return tryParsed(path.join(sourceRoot(wsAbs, o), sourceOf(rest)));
    }
    const m = /^(?:dist|build|out|lib)\/(.*)$/.exec(posix(path.relative(wsAbs, abs)));
    return m ? tryParsed(path.join(wsAbs, "src", sourceOf(m[1] ?? ""))) : null;
  }

  function sourceRoot(wsAbs: string, o: Record<string, unknown>): string {
    if (typeof o.rootDir === "string") return path.resolve(wsAbs, o.rootDir);
    const include = readJsonc(path.join(wsAbs, "tsconfig.json"))?.include;
    const prefixes = (Array.isArray(include) ? include : [])
      .filter((x): x is string => typeof x === "string")
      .map((g) =>
        g
          .split("/")
          .filter((seg) => !/[*?[{]/.test(seg) && seg !== ".")
          .join("/"),
      );
    // Static prefix of each include, cut at the first glob segment; a file pattern such as `src/a.ts` counts as its dir.
    const dirs = prefixes.map((p) => (/\.[cm]?[jt]sx?$/.test(p) ? path.dirname(p) : p));
    if (dirs.length === 0) return wsAbs;
    let common = dirs[0]?.split("/").filter(Boolean) ?? [];
    for (const d of dirs.slice(1)) {
      const parts = d.split("/").filter(Boolean);
      let i = 0;
      while (i < common.length && common[i] === parts[i]) i++;
      common = common.slice(0, i);
    }
    return path.join(wsAbs, ...common);
  }

  /** Workspace package fallback (step 2): `<pkg name>[/sub]` -> workspace dir and its exports map. */
  function resolveWorkspacePackage(spec: string): string | null {
    const name = wsNamesByLength.find((n) => spec === n || spec.startsWith(`${n}/`));
    if (name === undefined) return null;
    const ws = wsByName.get(name);
    if (!ws) return null;
    const sub = spec === name ? "." : `.${spec.slice(name.length)}`;
    const wsAbs = path.join(realRoot, ws.dir);
    const targets: string[] = [];
    if (ws.exportsMap) {
      const t = exportsTarget(ws, sub);
      if (t) targets.push(t);
    } else if (sub === ".") {
      if (ws.types) targets.push(ws.types);
      if (ws.main) targets.push(ws.main);
      targets.push("./src/index", "./index");
    } else {
      targets.push(sub, `./src/${sub.slice(2)}`);
    }
    for (const t of targets) {
      const abs = path.join(wsAbs, t);
      const hit = tryParsed(abs);
      if (hit) return hit;
      const alt = sourceOfOutput(wsAbs, abs);
      if (alt) return alt;
    }
    return null;
  }

  function declaredDependency(ws: WorkspaceRecord, name: string): boolean {
    return ws.deps.includes(name) || (rootWs?.deps.includes(name) ?? false);
  }

  function hasTypesPackage(fromAbs: string, name: string): boolean {
    const typesName = name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
    let dir = path.dirname(fromAbs);
    for (;;) {
      if (fs.existsSync(path.join(dir, "node_modules", "@types", typesName))) return true;
      if (dir === realRoot) return false;
      const parent = path.dirname(dir);
      if (parent === dir || !parent.startsWith(realRoot)) return false;
      dir = parent;
    }
  }

  function classifyMissingPath(absCandidate: string): SpecifierClass {
    const rel = posix(path.relative(realRoot, absCandidate));
    if (rel.startsWith("..")) return "unresolved";
    const variants = [rel, ...EXTENSIONS.map((e) => rel + e)];
    const stripped = rel.replace(SCRIPT_EXT_RE, "");
    if (stripped !== rel) variants.push(...EXTENSIONS.map((e) => stripped + e));
    return variants.some(matchesBuiltinExclude) ? "generated" : "unresolved";
  }

  function classify(fromFileId: string, spec: string): Classified {
    // 1. node: builtins and other `<scheme>:` specifiers are virtual, never failures.
    if (spec.startsWith("node:")) return { class: "builtin", pkg: spec };
    if (SCHEME_RE.test(spec)) return { class: "virtual", pkg: spec };

    const fromRel = relOf(fromFileId);
    const fromAbs = path.join(realRoot, fromRel);
    const fromWs = workspaceForPath(ctx.workspaces, fromRel);

    // 2. Workspace package names map to workspace source before the resolver is asked.
    if (isBare(spec)) {
      const hit = resolveWorkspacePackage(spec);
      if (hit) return { class: "file", fileId: hit };
    }

    // 3. oxc-resolver, passing the importing file so tsconfig discovery is per package.
    let result: { path?: string; error?: string; builtin?: unknown } = {};
    const viaAlias = aliasesOf(fromWs).aliases.some((a) => keyMatches(a.find, spec));
    for (const aliasOnly of viaAlias ? [true, false] : [false]) {
      try {
        result = resolverFor(fromWs, aliasOnly).resolveFileSync(fromAbs, spec);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      if (result.path || result.builtin) break;
    }
    if (result.builtin) return { class: "builtin", pkg: spec };
    if (result.path) {
      const resolved = posix(result.path);
      if (resolved.includes("/node_modules/")) {
        const pkg = packageName(spec) ?? spec;
        return { class: "external", pkg };
      }
      const abs = path.resolve(result.path);
      const rel = posix(path.relative(realRoot, abs));
      if (rel.startsWith("..")) {
        // Outside the repo (symlinked or absolute): treat a bare specifier as a package, else excluded.
        const pkg = isBare(spec) ? packageName(spec) : null;
        return pkg ? { class: "external", pkg } : { class: "excluded" };
      }
      const id = fileIdOf(rel);
      if (ctx.parsed.has(id)) return { class: "file", fileId: id };
      return { class: matchesBuiltinExclude(rel) ? "generated" : "excluded" };
    }

    // 4. Failed. Relative paths: tolerate files known to the parse map, else generated vs missing.
    if (!isBare(spec) || path.isAbsolute(spec)) {
      const abs = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(fromAbs), spec);
      const hit = tryParsed(abs);
      if (hit) return { class: "file", fileId: hit };
      return { class: classifyMissingPath(abs) };
    }
    // Bare: an npm package that is declared (or types-only via @types) but not installed here.
    const pkg = packageName(spec);
    if (pkg && wsByName.has(pkg)) return { class: "unresolved" }; // workspace package, subpath not exported
    if (pkg && (declaredDependency(fromWs, pkg) || hasTypesPackage(fromAbs, pkg))) {
      return { class: "external", pkg };
    }
    return unreadableAlias(fromWs, spec);
  }

  function classified(fromFileId: string, spec: string): Classified {
    const key = `${fromFileId}\0${spec}`;
    let c = classCache.get(key);
    if (!c) {
      c = classify(fromFileId, spec);
      classCache.set(key, c);
      counts[c.class]++;
      counted.set(
        key,
        c.class === "generated" || c.class === "excluded" || c.class === "unresolved"
          ? {
              fromFileId,
              specifier: spec,
              class: c.class,
              ...(c.reason ? { reason: c.reason, alias: c.alias as string } : {}),
            }
          : null,
      );
    }
    return c;
  }

  function resolveSpecifier(fromFileId: string, specifier: string): SpecifierResolution {
    const c = classified(fromFileId, specifier);
    if (c.class === "file" && c.fileId) return { kind: "file", fileId: c.fileId };
    if ((c.class === "external" || c.class === "builtin" || c.class === "virtual") && c.pkg) {
      return { kind: "external", pkg: c.pkg };
    }
    return { kind: "unresolved" };
  }

  function targetFile(fromFileId: string, spec: string): string | null {
    const r = resolveSpecifier(fromFileId, spec);
    return r.kind === "file" ? r.fileId : null;
  }

  // ---- symbols ------------------------------------------------------------------------------

  function localSymbol(pf: ParsedFile, name: string): string | null {
    return pf.symbols.find((s) => s.name === name)?.id ?? null;
  }

  function viaImport(pf: ParsedFile, local: string, depth: number, visited: Set<string>): string | null {
    const imp = pf.imports.find((i) => i.local === local && i.local !== "");
    if (!imp || imp.imported === "*") return null;
    const target = targetFile(pf.fileId, imp.specifier);
    return target ? follow(target, imp.imported, depth + 1, visited) : null;
  }

  function follow(fileId: string, name: string, depth: number, visited: Set<string>): string | null {
    if (depth > MAX_DEPTH) return null;
    const key = `${fileId}\0${name}`;
    if (visited.has(key)) return null;
    visited.add(key);
    const pf = ctx.parsed.get(fileId);
    if (!pf) return null;

    for (const e of pf.exports) {
      if (e.star || e.exported !== name) continue;
      if (e.fromSpecifier !== undefined) {
        if (e.local === "*") return null; // `export * as ns`: a namespace, not a symbol
        const target = targetFile(fileId, e.fromSpecifier);
        if (!target) continue;
        const r = follow(target, e.local ?? name, depth + 1, visited);
        if (r) return r;
        continue;
      }
      const local = e.local ?? name;
      const sym = localSymbol(pf, local) ?? viaImport(pf, local, depth, visited);
      if (sym) return sym;
    }
    if (name !== "default") {
      for (const e of pf.exports) {
        if (!e.star || e.fromSpecifier === undefined) continue;
        const target = targetFile(fileId, e.fromSpecifier);
        if (!target) continue;
        const r = follow(target, name, depth + 1, visited);
        if (r) return r;
      }
    }
    return pf.symbols.find((s) => s.exported && s.name === name)?.id ?? null;
  }

  function resolveSymbol(fileId: string, exportedName: string): string | null {
    return follow(fileId, exportedName, 0, new Set());
  }

  /** Names exported by a file, including through `export *` (excluding `default`). */
  function exportedNames(fileId: string, depth: number, visited: Set<string>): string[] {
    if (depth > MAX_DEPTH || visited.has(fileId)) return [];
    visited.add(fileId);
    const pf = ctx.parsed.get(fileId);
    if (!pf) return [];
    const names = new Set<string>();
    for (const e of pf.exports) {
      if (e.star && e.fromSpecifier !== undefined) {
        const target = targetFile(fileId, e.fromSpecifier);
        if (target) for (const n of exportedNames(target, depth + 1, visited)) names.add(n);
      } else if (e.exported !== "default") {
        names.add(e.exported);
      }
    }
    return [...names].sort(cmp);
  }

  // ---- edges --------------------------------------------------------------------------------

  function siteTarget(pf: ParsedFile, site: ParsedSite): { dst: string; confidence: "high" | "low" } | null {
    const parts = site.callee.split(".");
    const root = parts[0] ?? "";
    if (root === "") return null;

    const methodOnly = (): { dst: string; confidence: "low" } | null => {
      const method = parts[parts.length - 1] ?? "";
      const matches = pf.symbols.filter((s) => s.kind === "method" && s.name.endsWith(`.${method}`));
      const only = matches.length === 1 ? matches[0] : undefined;
      return parts.length >= 2 && only ? { dst: only.id, confidence: "low" } : null;
    };

    if (root === "this" || root === "super") return root === "this" ? methodOnly() : null;

    const imp: ParsedImport | undefined = pf.imports.find((i) => i.local === root);
    if (imp) {
      const target = targetFile(pf.fileId, imp.specifier);
      if (!target) return null;
      let dst: string | null;
      if (imp.imported === "*") {
        const member = parts[1];
        dst = member ? resolveSymbol(target, member) : null;
      } else {
        dst = resolveSymbol(target, imp.imported);
      }
      return dst ? { dst, confidence: "high" } : null;
    }

    const local = pf.symbols.find((s) => s.name === root);
    if (local) {
      const member = parts[1];
      if (member) {
        const m = pf.symbols.find((s) => s.name === `${root}.${member}`);
        if (m) return { dst: m.id, confidence: "high" };
      }
      return { dst: local.id, confidence: "high" };
    }
    return methodOnly();
  }

  function edgesForFile(fileId: string): EdgeRecord[] {
    const pf = ctx.parsed.get(fileId);
    if (!pf) return [];
    const b = new EdgeBuilder(fileId);
    const rel = relOf(fileId);
    const ws = workspaceForPath(ctx.workspaces, rel);

    // contains
    b.add(ws.id, fileId, "contains", "high");
    for (const s of pf.symbols) b.add(fileId, s.id, "contains", "high");

    // imports: one edge per target; count = bindings. Re-export sources count as dependencies too.
    const addImport = (spec: string, line?: number): void => {
      const c = classified(fileId, spec);
      let dst: string | null = null;
      if (c.class === "file" && c.fileId) dst = c.fileId;
      else if (c.class === "external" && c.pkg) dst = `ext:${c.pkg}`;
      if (!dst || dst === fileId) return;
      b.add(fileId, dst, "imports", "high", line === undefined ? undefined : `${rel}:${line}`);
    };
    for (const i of pf.imports) addImport(i.specifier, i.line);
    for (const e of pf.exports) if (e.fromSpecifier !== undefined) addImport(e.fromSpecifier);

    // exports: file -> original symbol
    const exportNames = new Set<string>();
    for (const e of pf.exports) {
      if (e.star && e.fromSpecifier !== undefined) {
        const target = targetFile(fileId, e.fromSpecifier);
        if (target) for (const n of exportedNames(target, 1, new Set([fileId]))) exportNames.add(n);
      } else {
        exportNames.add(e.exported);
      }
    }
    for (const name of [...exportNames].sort(cmp)) {
      const dst = resolveSymbol(fileId, name);
      if (dst) b.add(fileId, dst, "exports", "high");
    }

    // calls / renders / uses_hook / extends / implements / references_type
    for (const site of pf.sites) {
      const t = siteTarget(pf, site);
      if (!t || t.dst === site.fromSymbol) continue;
      b.add(site.fromSymbol, t.dst, site.kind, t.confidence, `${rel}:${site.line}`);
    }
    return b.build();
  }

  function workspaceEdges(): EdgeRecord[] {
    return dependsOnEdges(ctx.repo, ctx.workspaces);
  }

  function stats(): ResolveStats {
    const unresolved = [...counted.values()].filter((v): v is UnresolvedSpecifier => v !== null);
    unresolved.sort((a, b) => cmp(a.fromFileId, b.fromFileId) || cmp(a.specifier, b.specifier));
    return { counts: { ...counts }, unresolved };
  }

  return { resolveSpecifier, resolveSymbol, edgesForFile, workspaceEdges, stats };
}

/** `depends_on` edges: workspace -> workspace for each package.json dependency that names a workspace. */
export function dependsOnEdges(repo: string, workspaces: WorkspaceRecord[]): EdgeRecord[] {
  const byName = new Map<string, WorkspaceRecord>();
  for (const w of workspaces) if (w.dir !== "." && w.lang !== "go") byName.set(w.name, w);
  const edges: EdgeRecord[] = [];
  for (const w of workspaces) {
    if (w.lang === "go") continue; // Go modules have their own edges (lang/go/workspace.ts)
    const pkgFile = makeFileId(repo, `${w.dir === "." ? "" : `${w.dir}/`}package.json`);
    for (const dep of w.deps) {
      const target = byName.get(dep);
      if (!target || target.id === w.id) continue;
      edges.push({
        src: w.id,
        dst: target.id,
        kind: "depends_on",
        confidence: "high",
        count: 1,
        evidence: [],
        fileId: pkgFile,
      });
    }
  }
  return sortEdges(edges);
}

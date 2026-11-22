import fs from "node:fs";
import path from "node:path";
import type { WorkspaceRecord } from "../types.js";
import { readJsonc } from "../workspace/index.js";

/** What the `extends` chain of one tsconfig gives the resolver. */
export interface TsconfigChain {
  /**
   * True when a bare `extends` in the chain is provided by a workspace package or by nothing, not by `node_modules`.
   * oxc-resolver cannot follow such a chain, so the caller passes `aliases` instead of the tsconfig.
   */
  needsAlias: boolean;
  /** The `paths` as oxc-resolver `alias` entries with absolute targets, longest key first. */
  aliases: Array<{ find: string; targets: string[] }>;
  /** The inherited `baseUrl`, absolute; bare imports are also looked up there. */
  baseUrl?: string;
}

interface Loaded {
  /** The nearest `paths` and the directory of the config that declares it; undefined when no config has one. */
  paths?: { dir: string; entries: Array<{ pattern: string; targets: string[] }> };
  /** The nearest `baseUrl`, absolute (resolved against the config that declares it). */
  baseUrl?: string;
  needsAlias: boolean;
}

const posix = (p: string): string => p.split(path.sep).join("/");

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
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

/** The package name of a bare specifier (`@scope/name` or `name`) and the rest of it. */
function splitBare(spec: string): { name: string; sub: string } | null {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  if (parts.length < n || parts.slice(0, n).some((p) => p === "")) return null;
  return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") };
}

/** A tsconfig file for `base`: the path itself, with `.json` added, or a directory's `tsconfig.json`. */
function configFileAt(base: string): string | null {
  if (isFile(base)) return base;
  if (isFile(`${base}.json`)) return `${base}.json`;
  const inDir = path.join(base, "tsconfig.json");
  return isFile(inDir) ? inDir : null;
}

/** The bare `extends` through `node_modules`, searched upward from the directory of the extending config. */
function viaNodeModules(spec: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const hit = configFileAt(path.join(dir, "node_modules", spec));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The bare `extends` through a workspace package: its directory plus the subpath, by `exports` when it has them. */
function viaWorkspace(spec: string, workspaces: WorkspaceRecord[], realRoot: string): string | null {
  const parts = splitBare(spec);
  const ws = parts ? workspaces.find((w) => w.name === parts.name) : undefined;
  if (!(parts && ws)) return null;
  const wsAbs = path.join(realRoot, ws.dir === "." ? "" : ws.dir);
  if (parts.sub === "") return configFileAt(path.join(wsAbs, "tsconfig.json"));
  if (ws.exportsMap) {
    const target = exportsTarget(ws, `./${parts.sub}`);
    return target ? configFileAt(path.join(wsAbs, target)) : null;
  }
  const direct = path.join(wsAbs, parts.sub);
  return configFileAt(direct.endsWith(".json") ? direct : `${direct}.json`);
}

function load(file: string, workspaces: WorkspaceRecord[], realRoot: string, stack: string[]): Loaded {
  const out: Loaded = { needsAlias: false };
  // A base reached twice through different branches is read twice; only a cycle ends the chain.
  if (stack.includes(file)) return out;
  const branch = [...stack, file];
  const json = readJsonc(file);
  if (!json || typeof json !== "object") return out;
  const dir = path.dirname(file);
  // `${configDir}` is the directory of the config the resolver was asked to use, the leaf of the chain.
  const withConfigDir = (s: string): string => s.replaceAll("${configDir}", path.dirname(stack[0] ?? file));

  const ext = (json as { extends?: unknown }).extends;
  const specs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : [];
  for (const spec of specs) {
    if (typeof spec !== "string") continue;
    let parent: string | null;
    if (spec.startsWith(".") || path.isAbsolute(spec)) {
      parent = configFileAt(path.resolve(dir, spec));
      if (!parent) out.needsAlias = true;
    } else {
      // A link in `node_modules` (a package manager's link to a workspace package too) is followed by oxc-resolver itself.
      parent = viaNodeModules(spec, dir);
      if (!parent) {
        parent = viaWorkspace(spec, workspaces, realRoot);
        out.needsAlias = true;
      }
    }
    if (!parent) continue;
    const base = load(parent, workspaces, realRoot, branch);
    if (base.paths) out.paths = base.paths;
    if (base.baseUrl !== undefined) out.baseUrl = base.baseUrl;
    if (base.needsAlias) out.needsAlias = true;
  }

  const co = (json as { compilerOptions?: Record<string, unknown> }).compilerOptions;
  if (typeof co?.baseUrl === "string") out.baseUrl = path.resolve(dir, withConfigDir(co.baseUrl));
  const paths = co?.paths;
  if (paths && typeof paths === "object" && !Array.isArray(paths)) {
    // The nearer config replaces `paths` wholesale; its entries keep the directory of the config that declares them.
    out.paths = {
      dir,
      entries: Object.entries(paths).map(([pattern, targets]) => ({
        pattern,
        targets: (Array.isArray(targets) ? targets : [])
          .filter((t): t is string => typeof t === "string")
          .map(withConfigDir),
      })),
    };
  }
  return out;
}

/**
 * Read the `extends` chain of a tsconfig as TypeScript does: `compilerOptions` from the base to the leaf, `paths`
 * replaced wholesale by a nearer config, `baseUrl` inherited (resolved against the config that declares it), each
 * `paths` target relative to that `baseUrl`, or to the directory of the config that declares `paths` when there is none.
 * `${configDir}` stands for the directory of the leaf config.
 * A bare `extends` is tried through `node_modules` first; one that only a workspace package provides is followed through
 * the workspace's directory and `exports`; one that nothing provides is skipped and the rest of the chain applies.
 */
export function readTsconfigChain(
  configFile: string,
  workspaces: WorkspaceRecord[],
  realRoot: string,
): TsconfigChain {
  const loaded = load(configFile, workspaces, realRoot, []);
  const aliases: TsconfigChain["aliases"] = [];
  const from = loaded.baseUrl ?? loaded.paths?.dir ?? "";
  for (const { pattern, targets: raw } of loaded.paths?.entries ?? []) {
    const targets = raw.map((t) => path.resolve(from, t));
    const star = pattern.indexOf("*");
    if (star < 0) {
      aliases.push({ find: `${pattern}$`, targets: targets.map(posix) });
      continue;
    }
    // Only `prefix/*` with one star at the end maps onto an alias key.
    if (star !== pattern.length - 1 || !pattern.endsWith("/*")) continue;
    const dirs: string[] = [];
    for (const t of targets) {
      const p = posix(t);
      if (p.endsWith("/*")) dirs.push(p.slice(0, -2));
    }
    if (dirs.length > 0) aliases.push({ find: pattern.slice(0, -2), targets: dirs });
  }
  aliases.sort((a, b) => b.find.length - a.find.length);
  return {
    needsAlias: loaded.needsAlias,
    aliases,
    ...(loaded.baseUrl !== undefined ? { baseUrl: loaded.baseUrl } : {}),
  };
}

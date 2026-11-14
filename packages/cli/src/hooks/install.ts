import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDataDir, type GantryPaths, openStore } from "@gantry/core";

/** The five hooks Gantry installs (spec section 12). */
export const GANTRY_HOOKS = [
  "pre-commit",
  "pre-push",
  "post-checkout",
  "post-merge",
  "post-rewrite",
] as const;

/** Every client-side hook git knows; the wrapper dir passes the ones Gantry does not use straight through. */
const STANDARD_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "reference-transaction",
  "push-to-checkout",
  "fsmonitor-watchman",
  "post-index-change",
  "sendemail-validate",
];

const PREV_SUFFIX = ".gantry-prev";
const META_PREV = "prev_hooks_path";
const META_PREV_SCOPE = "prev_hooks_path_scope";
/** Marks a script as ours; it is part of the call line in every script we write. */
const MARKER = '.gantry/bin/gantry" hook ';

export interface InstallResult {
  mode: "git-hooks" | "hooks-path";
  /** Directory the scripts were written to. */
  dir: string;
  chained: string[];
  warnings: string[];
}

export interface UninstallResult {
  restored: string[];
  removed: string[];
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, "") };
}

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

function isOurs(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  return fs.existsSync(p) || isSymlink(p);
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Gantry call line: stdin is cut off so a following hook still sees git's stdin (pre-push, post-rewrite). */
function callLine(name: string): string {
  return `[ "$GANTRY_WORKER" = 1 ] || "$HOME/.gantry/bin/gantry" hook ${name} "$@" </dev/null || true`;
}

/** The 3-line script for `.git/hooks` (the original, if any, was renamed to `<name>.gantry-prev`). */
export function hookScript(name: string, chained: boolean): string {
  const last = chained ? `[ -x "$0${PREV_SUFFIX}" ] && exec "$0${PREV_SUFFIX}" "$@"; exit 0` : "exit 0";
  return `#!/bin/sh\n${callLine(name)}\n${last}\n`;
}

/** Wrapper for the `core.hooksPath` case: Gantry (for its own hooks), then the original with the same args. */
export function wrapperScript(name: string, origDir: string): string {
  const orig = q(`${origDir}/${name}`);
  const first = (GANTRY_HOOKS as readonly string[]).includes(name) ? `${callLine(name)}\n` : "";
  return `#!/bin/sh\n${first}[ -x ${orig} ] && exec ${orig} "$@"; exit 0\n`;
}

/** Shim with absolute paths to node and the CLI bundle; silent no-op when either is gone. */
export function shimScript(nodePath: string, cliPath: string): string {
  return `#!/bin/sh\n[ -x ${q(nodePath)} ] && [ -f ${q(cliPath)} ] || exit 0\nexec ${q(nodePath)} ${q(cliPath)} "$@"\n`;
}

export function writeShim(paths: GantryPaths, cliPath: string, nodePath: string = process.execPath): void {
  fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
  fs.writeFileSync(paths.shimPath, shimScript(nodePath, cliPath), { mode: 0o755 });
  fs.chmodSync(paths.shimPath, 0o755);
}

function writeExec(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function localHooksPath(root: string): string | undefined {
  const r = git(root, ["config", "--local", "--get", "core.hooksPath"]);
  return r.ok ? r.out : undefined;
}

function effectiveHooksPath(root: string): string | undefined {
  const r = git(root, ["config", "--get", "core.hooksPath"]);
  return r.ok ? r.out : undefined;
}

function wrapperDirOf(paths: GantryPaths): string {
  return path.join(paths.dataDir, "hooks");
}

function withStore<T>(paths: GantryPaths, fn: (db: ReturnType<typeof openStore>) => T): T {
  const store = openStore(paths.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * Installs the shim and the five hooks (spec section 12). Idempotent: running it again rewrites our
 * scripts and never renames one of them to `.gantry-prev`.
 */
export function installHooks(
  paths: GantryPaths,
  opts: { cliPath: string; nodePath?: string; env?: NodeJS.ProcessEnv },
): InstallResult {
  const env = opts.env ?? process.env;
  const home = homeOf(env);
  const warnings: string[] = [];
  const chained: string[] = [];
  const root = paths.root;
  ensureDataDir(paths);
  writeShim(paths, opts.cliPath, opts.nodePath);

  const wrapperDir = wrapperDirOf(paths);
  const current = effectiveHooksPath(root);
  const currentAbs = current === undefined ? undefined : path.resolve(root, expandHome(current, home));

  if (current === undefined) {
    const gp = git(root, ["rev-parse", "--git-path", "hooks"]);
    if (!gp.ok) throw new Error("git rev-parse --git-path hooks failed");
    const dir = path.resolve(root, gp.out);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of GANTRY_HOOKS) {
      const file = path.join(dir, name);
      const prev = file + PREV_SUFFIX;
      if (exists(file) && !isOurs(file)) {
        if (exists(prev)) {
          warnings.push(`${name}: ${name}${PREV_SUFFIX} already exists; left the existing hook untouched`);
          continue;
        }
        fs.renameSync(file, prev);
      }
      const hasPrev = exists(prev);
      if (hasPrev) chained.push(name);
      writeExec(file, hookScript(name, hasPrev));
    }
    return { mode: "git-hooks", dir, chained, warnings };
  }

  // core.hooksPath is set: husky, lefthook with a custom dir, or our own wrapper dir from a prior install.
  if (currentAbs !== wrapperDir) {
    const scope = localHooksPath(root) === undefined ? "other" : "local";
    withStore(paths, (s) => {
      s.setMeta(META_PREV, current);
      s.setMeta(META_PREV_SCOPE, scope);
    });
  }
  const prevRaw = withStore(paths, (s) => s.getMeta(META_PREV));
  if (prevRaw === undefined)
    throw new Error("core.hooksPath points at the Gantry wrapper dir but no previous value is recorded");
  const origDir = path.resolve(root, expandHome(prevRaw, home));
  fs.mkdirSync(wrapperDir, { recursive: true });
  const names = new Set<string>([...STANDARD_HOOKS, ...GANTRY_HOOKS]);
  // Hooks living in the original dir that git does not list above still need a pass-through.
  try {
    for (const f of fs.readdirSync(origDir)) {
      const full = path.join(origDir, f);
      if (!f.startsWith(".") && !f.endsWith(PREV_SUFFIX) && fs.statSync(full).isFile()) names.add(f);
    }
  } catch {
    // original dir missing: wrappers just exit 0
  }
  for (const name of [...names].sort()) {
    writeExec(path.join(wrapperDir, name), wrapperScript(name, origDir));
    if (fs.existsSync(path.join(origDir, name)) && (GANTRY_HOOKS as readonly string[]).includes(name)) {
      chained.push(name);
    }
  }
  const set = spawnSync("git", ["config", "--local", "core.hooksPath", wrapperDir], { cwd: root });
  if (set.status !== 0) throw new Error("git config core.hooksPath failed");
  return { mode: "hooks-path", dir: wrapperDir, chained, warnings };
}

/** Reverses `installHooks` exactly: removes our scripts, renames `.gantry-prev` back, restores `core.hooksPath`. */
export function uninstallHooks(paths: GantryPaths, _env: NodeJS.ProcessEnv = process.env): UninstallResult {
  const root = paths.root;
  const restored: string[] = [];
  const removed: string[] = [];
  const wrapperDir = wrapperDirOf(paths);
  const local = localHooksPath(root);

  if (local !== undefined && path.resolve(root, local) === wrapperDir) {
    let prev: string | undefined;
    let scope: string | undefined;
    if (fs.existsSync(paths.dbPath)) {
      withStore(paths, (s) => {
        prev = s.getMeta(META_PREV);
        scope = s.getMeta(META_PREV_SCOPE);
        s.db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(META_PREV, META_PREV_SCOPE);
      });
    }
    if (prev !== undefined && scope === "local") {
      git(root, ["config", "--local", "core.hooksPath", prev]);
      restored.push("core.hooksPath");
    } else {
      git(root, ["config", "--local", "--unset", "core.hooksPath"]);
      removed.push("core.hooksPath");
    }
    fs.rmSync(wrapperDir, { recursive: true, force: true });
    removed.push(wrapperDir);
    return { restored, removed };
  }

  const gp = git(root, ["rev-parse", "--git-path", "hooks"]);
  if (!gp.ok) return { restored, removed };
  const dir = path.resolve(root, gp.out);
  for (const name of GANTRY_HOOKS) {
    const file = path.join(dir, name);
    const prev = file + PREV_SUFFIX;
    if (exists(file) && isOurs(file)) {
      fs.rmSync(file);
      removed.push(name);
      if (exists(prev)) {
        fs.renameSync(prev, file);
        restored.push(name);
      }
    }
  }
  return { restored, removed };
}

/** Removes a data dir, refusing anything that is not a per-worktree dir. */
export function removeDataDir(paths: GantryPaths): boolean {
  if (path.basename(paths.dataDir) !== paths.worktreeHash) return false;
  fs.rmSync(paths.dataDir, { recursive: true, force: true });
  return true;
}

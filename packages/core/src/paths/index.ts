import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GantryPaths {
  root: string;
  worktreeHash: string;
  dataDir: string;
  dbPath: string;
  configPath: string;
  catalogDir: string;
  logsDir: string;
  globalConfigPath: string;
  shimPath: string;
}

export class NotAGitRepoError extends Error {
  constructor(cwd: string) {
    super(`Not a git repository: ${cwd}`);
    this.name = "NotAGitRepoError";
  }
}

/**
 * The plugin data dir Claude Code assigns, derived from `CLAUDE_PLUGIN_ROOT` when `CLAUDE_PLUGIN_DATA` is not in the
 * environment (Bash tool commands never get it, spec section 4). An installed plugin lives at
 * `<claude home>/plugins/cache/<marketplace>/<plugin>/<version>` and its data dir is
 * `<claude home>/plugins/data/<plugin>-<marketplace>` with every character other than a letter, digit, `_` or `-`
 * replaced by `-`. Returns `undefined` for any other layout (for example `--plugin-dir`).
 */
export function pluginDataFromRoot(pluginRoot: string): string | undefined {
  const parts = path.resolve(pluginRoot).split(path.sep);
  const n = parts.length;
  if (n < 5 || parts[n - 4] !== "cache" || parts[n - 5] !== "plugins") return undefined;
  const id = `${parts[n - 2]}-${parts[n - 3]}`.replace(/[^A-Za-z0-9_-]/g, "-");
  return path.join(parts.slice(0, n - 4).join(path.sep) || path.sep, "data", id);
}

/** Resolve the per-worktree data locations (spec section 4). Never touches the repo working tree. */
export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv = process.env): GantryPaths {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const top = res.status === 0 ? res.stdout.trim() : "";
  if (res.error || !top) throw new NotAGitRepoError(cwd);

  const root = fs.realpathSync(top);
  const worktreeHash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const home = env.HOME || os.homedir();
  const gantryHome = path.join(home, ".gantry");
  const legacyBase = path.join(gantryHome, "data");
  const pluginBase =
    env.CLAUDE_PLUGIN_DATA ||
    (env.CLAUDE_PLUGIN_ROOT ? pluginDataFromRoot(env.CLAUDE_PLUGIN_ROOT) : undefined);
  let dataDir = path.join(pluginBase ?? legacyBase, "repos", worktreeHash);
  if (pluginBase) {
    // Data created before the plugin data dir was used everywhere stays found until the new location has its own.
    // Both sides are judged by their store file, so an empty directory (a stray `logs/`, an interrupted run) never
    // decides where the index lives (#147).
    const legacy = path.join(legacyBase, "repos", worktreeHash);
    const hasStore = (dir: string): boolean => fs.existsSync(path.join(dir, "gantry.db"));
    if (!hasStore(dataDir) && hasStore(legacy)) dataDir = legacy;
  }

  return {
    root,
    worktreeHash,
    dataDir,
    dbPath: path.join(dataDir, "gantry.db"),
    configPath: path.join(dataDir, "config.json"),
    catalogDir: path.join(dataDir, "catalog"),
    logsDir: path.join(dataDir, "logs"),
    globalConfigPath: path.join(gantryHome, "config.json"),
    shimPath: path.join(gantryHome, "bin", "gantry"),
  };
}

/**
 * The legacy data dir `~/.gantry/data/repos/<worktreeHash>/` when it still holds an index (`gantry.db`) although this
 * run uses another data dir: an orphan left from before the plugin data dir was used everywhere (#141), safe to
 * remove once the plugin store has its own index (docs/INSTALL.md). `undefined` when there is none.
 */
export function orphanedLegacyDataDir(p: GantryPaths): string | undefined {
  const legacy = path.join(path.dirname(p.globalConfigPath), "data", "repos", p.worktreeHash);
  if (path.resolve(legacy) === path.resolve(p.dataDir)) return undefined;
  return fs.existsSync(path.join(legacy, "gantry.db")) ? legacy : undefined;
}

/** mkdir -p the data dir and its subdirs with mode 0700. */
export function ensureDataDir(p: GantryPaths): void {
  for (const dir of [p.dataDir, p.catalogDir, p.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

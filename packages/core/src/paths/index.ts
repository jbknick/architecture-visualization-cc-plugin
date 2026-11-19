import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GantryPaths {
  root: string;
  /** The repo name carried in every stable id (`repoName`, spec section 6); the same on every machine. */
  repo: string;
  worktreeHash: string;
  dataDir: string;
  dbPath: string;
  /** `<dataDir>/overlay.db`: what a person decided; survives an index rebuild (spec section 9). */
  overlayPath: string;
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

/** The last two path segments of a remote URL (`a/b`), trailing slashes and any `.git` suffix removed. */
function ownerAndName(url: string): string | undefined {
  const parts = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter((p) => p !== "");
  if (parts.length < 2) return undefined;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * The repo name carried in every stable id (spec section 6): the last two path segments of the `origin` remote URL with
 * any `.git` suffix removed (`https://github.com/a/b.git`, `git@github.com:a/b.git` and `ssh://git@host/a/b` all give
 * `a/b`); with no `origin`, the basename of the worktree root. Never a local path. A `:` in the name becomes `_`
 * because ids split on it. `root` is any directory of the repo (a linked worktree gives the name of its `origin`).
 */
export function repoName(root: string): string {
  const res = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const fromRemote = res.status === 0 ? ownerAndName(res.stdout) : undefined;
  return (fromRemote ?? path.basename(path.resolve(root))).replace(/:/g, "_");
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
  const terminalBase = path.join(gantryHome, "data");
  const pluginBase =
    env.CLAUDE_PLUGIN_DATA ||
    (env.CLAUDE_PLUGIN_ROOT ? pluginDataFromRoot(env.CLAUDE_PLUGIN_ROOT) : undefined);
  const dataDir = path.join(pluginBase ?? terminalBase, "repos", worktreeHash);

  return {
    root,
    repo: repoName(root),
    worktreeHash,
    dataDir,
    dbPath: path.join(dataDir, "gantry.db"),
    overlayPath: path.join(dataDir, "overlay.db"),
    configPath: path.join(dataDir, "config.json"),
    catalogDir: path.join(dataDir, "catalog"),
    logsDir: path.join(dataDir, "logs"),
    globalConfigPath: path.join(gantryHome, "config.json"),
    shimPath: path.join(gantryHome, "bin", "gantry"),
  };
}

/** mkdir -p the data dir and its subdirs with mode 0700. */
export function ensureDataDir(p: GantryPaths): void {
  for (const dir of [p.dataDir, p.catalogDir, p.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

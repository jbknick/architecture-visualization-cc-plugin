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
  const base = env.CLAUDE_PLUGIN_DATA ? env.CLAUDE_PLUGIN_DATA : path.join(gantryHome, "data");
  const dataDir = path.join(base, "repos", worktreeHash);

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

/** mkdir -p the data dir and its subdirs with mode 0700. */
export function ensureDataDir(p: GantryPaths): void {
  for (const dir of [p.dataDir, p.catalogDir, p.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findWorkspaceFile,
  type LoadedWorkspace,
  loadWorkspaceFile,
  WorkspaceFileError,
} from "../workspace/file.js";
import { repoName } from "./repo-name.js";

export { repoName };

/** The repos one data dir holds (spec section 4). A repo with no workspace file is a workspace of one. */
export interface WorkspaceInfo {
  /** The workspace file (absolute); null for a workspace of one. */
  file: string | null;
  /** Every repo of the workspace, sorted by name. */
  repos: { name: string; root: string }[];
}

export interface GantryPaths {
  /** The work tree root of the repo the command runs in (the other repos of a workspace are in `workspace.repos`). */
  root: string;
  /** The repo name carried in every stable id (`repoName`, spec section 6); the same on every machine. */
  repo: string;
  workspace: WorkspaceInfo;
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

/** The directory above `root` as the user reaches it: the first ancestor of `cwd` whose real path is `root`. */
function logicalRootOf(cwd: string, root: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (fs.realpathSync(dir) === root) return dir;
    } catch {
      return root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return root;
    dir = parent;
  }
}

export interface ResolveOptions {
  /** A workspace file that replaces discovery (`--workspace <file>`). */
  workspaceFile?: string;
}

/**
 * Resolve the data locations (spec section 4). Never touches the repo working tree. With a workspace file that lists
 * the repo (found by walking up, or given in `opts.workspaceFile`) the data dir is
 * `<base>/workspaces/<first 16 hex of sha256(real path of the file's directory)>/` and holds every repo of the file;
 * otherwise it is `<base>/repos/<worktreeHash>/` and the repo is a workspace of one. A workspace file that is invalid
 * throws `WorkspaceFileError`.
 */
export function resolvePaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveOptions = {},
): GantryPaths {
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
  const base = pluginBase ?? terminalBase;

  let ws: LoadedWorkspace | undefined;
  if (opts.workspaceFile !== undefined) {
    ws = loadWorkspaceFile(path.resolve(cwd, opts.workspaceFile));
    if (!ws.repos.some((r) => r.root === root)) {
      throw new WorkspaceFileError(`workspace file ${ws.file}: does not list this repository (${root})`);
    }
  } else {
    ws = findWorkspaceFile(root, { startAbove: logicalRootOf(cwd, root), home });
  }

  const dataDir = ws
    ? path.join(base, "workspaces", createHash("sha256").update(ws.dir).digest("hex").slice(0, 16))
    : path.join(base, "repos", worktreeHash);
  const repo = ws ? (ws.repos.find((r) => r.root === root)?.name as string) : repoName(root);
  const workspace: WorkspaceInfo = ws
    ? { file: ws.file, repos: ws.repos }
    : { file: null, repos: [{ name: repo, root }] };

  return {
    root,
    repo,
    workspace,
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

/**
 * The paths of another repo of the same workspace: the same data dir, with that repo's root, name and worktree hash.
 * Throws when the workspace does not list `repo`.
 */
export function pathsForRepo(paths: GantryPaths, repo: string): GantryPaths {
  if (repo === paths.repo) return paths;
  const member = paths.workspace.repos.find((r) => r.name === repo);
  if (!member) throw new Error(`the workspace has no repo named ${repo}`);
  return {
    ...paths,
    root: member.root,
    repo: member.name,
    worktreeHash: createHash("sha256").update(member.root).digest("hex").slice(0, 16),
  };
}

/** The repo of the workspace whose work tree holds `file` (an absolute path, or one relative to `paths.root`). */
export function repoOfPath(paths: GantryPaths, file: string): GantryPaths | undefined {
  let real: string;
  try {
    real = fs.realpathSync(path.isAbsolute(file) ? file : path.join(paths.root, file));
  } catch {
    return undefined;
  }
  let best: { name: string; len: number } | undefined;
  for (const r of paths.workspace.repos) {
    const rel = path.relative(r.root, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!best || r.root.length > best.len) best = { name: r.name, len: r.root.length };
  }
  return best ? pathsForRepo(paths, best.name) : undefined;
}

/** mkdir -p the data dir and its subdirs with mode 0700. */
export function ensureDataDir(p: GantryPaths): void {
  for (const dir of [p.dataDir, p.catalogDir, p.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

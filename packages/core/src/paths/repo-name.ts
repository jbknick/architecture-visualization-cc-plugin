import { spawnSync } from "node:child_process";
import path from "node:path";

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

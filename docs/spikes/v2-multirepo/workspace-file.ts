// Prototype of the decided workspace file (`gantry-workspace.json` found by walking up) and the cases that might break it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoName, resolvePaths } from "../../../packages/core/dist/index.js";
import { copyClone, envFor, git } from "./lib.js";

const FILE = "gantry-workspace.json";

/** The nearest `gantry-workspace.json` in `start` or any directory above it. */
export function findWorkspaceFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, FILE);
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const real = (p: string): string => fs.realpathSync(p);

/** Whether `repoRoot` is one of the repos the file lists (listed paths are relative to the file's directory). */
export function isMember(wsFile: string, repoRoot: string): boolean {
  const dir = path.dirname(wsFile);
  const parsed = JSON.parse(fs.readFileSync(wsFile, "utf8")) as { repos: { path: string }[] };
  return parsed.repos.some((r) => {
    try {
      return real(path.join(dir, r.path)) === real(repoRoot);
    } catch {
      return false;
    }
  });
}

/** The store key: the same 16 hex characters as `worktreeHash`, but of the workspace file's directory. */
export const storeKey = (wsFile: string): string =>
  createHash("sha256")
    .update(real(path.dirname(wsFile)))
    .digest("hex")
    .slice(0, 16);

const write = (dir: string, repos: string[]): string => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, FILE);
  fs.writeFileSync(f, JSON.stringify({ repos: repos.map((p) => ({ path: p })) }, null, 2));
  return f;
};

function tinyRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
}

export function workspaceFileScenarios(work: string, honoSrc: string) {
  const base = path.join(work, "wsfile");
  const env = envFor(path.join(work, "home-wsfile"));
  const rel = (p: string | undefined): string | null => (p ? path.relative(base, p) : null);

  // 1. The decided form, found from the repo root and from a nested directory.
  const w1 = path.join(base, "w1");
  const f1 = write(w1, ["./hono", "./middleware"]);
  copyClone(honoSrc, path.join(w1, "hono"));
  tinyRepo(path.join(w1, "middleware"));
  const found1 = findWorkspaceFile(path.join(w1, "hono"));
  const foundNested = findWorkspaceFile(path.join(w1, "hono", "src", "middleware"));

  // 2. Linked worktrees.
  const hono = path.join(w1, "hono");
  const wtInside = path.join(w1, "hono-wt");
  const wtOutside = path.join(base, "elsewhere", "hono-wt");
  fs.mkdirSync(path.dirname(wtOutside), { recursive: true });
  git(hono, "worktree", "add", "-q", "--detach", wtInside);
  git(hono, "worktree", "add", "-q", "--detach", wtOutside);
  const wtInsideFound = findWorkspaceFile(wtInside);
  const wtOutsideFound = findWorkspaceFile(wtOutside);
  const nameMain = repoName(hono);
  const nameWt = repoName(wtInside);

  // 3. Symlinks.
  const outside = path.join(base, "outside", "hono-ext");
  copyClone(honoSrc, outside);
  fs.symlinkSync(hono, path.join(w1, "hono-link"));
  fs.symlinkSync(outside, path.join(w1, "hono-ext"));
  const f3 = write(path.join(base, "w3"), ["./hono-link", "./hono-ext"]);
  fs.symlinkSync(hono, path.join(base, "w3", "hono-link"));
  fs.symlinkSync(outside, path.join(base, "w3", "hono-ext"));
  const linkRoot = resolvePaths(path.join(base, "w3", "hono-link"), env).root;
  const extRoot = resolvePaths(path.join(base, "w3", "hono-ext"), env).root;

  // 4. One repo listed by two workspace files (an outer one and an inner one).
  const outer = path.join(base, "w4");
  const outerFile = write(outer, ["./proj/hono"]);
  const innerFile = write(path.join(outer, "proj"), ["./hono"]);
  const honoIn4 = path.join(outer, "proj", "hono");
  copyClone(honoSrc, honoIn4);
  const found4 = findWorkspaceFile(honoIn4);

  // 5. Two repos with no origin and the same directory name.
  const w5 = path.join(base, "w5");
  tinyRepo(path.join(w5, "a", "api"));
  tinyRepo(path.join(w5, "b", "api"));
  write(w5, ["./a/api", "./b/api"]);
  const nameA = resolvePaths(path.join(w5, "a", "api"), env).repo;
  const nameB = resolvePaths(path.join(w5, "b", "api"), env).repo;

  // 6. A workspace file above a repo it does not list.
  const w6 = path.join(base, "w6");
  const f6 = write(w6, ["./listed"]);
  tinyRepo(path.join(w6, "listed"));
  tinyRepo(path.join(w6, "unlisted"));
  const found6 = findWorkspaceFile(path.join(w6, "unlisted"));

  return {
    decidedForm: {
      foundFromRepoRoot: rel(found1),
      foundFromNestedDir: rel(foundNested),
      isMember: isMember(f1, hono),
      storeKeyEqualFromBothStarts:
        found1 !== undefined && storeKey(found1) === storeKey(foundNested as string),
    },
    linkedWorktree: {
      insideWorkspaceDir: {
        found: rel(wtInsideFound),
        isMember: wtInsideFound ? isMember(wtInsideFound, wtInside) : null,
      },
      outsideWorkspaceDir: { found: rel(wtOutsideFound) },
      repoNameMain: nameMain,
      repoNameWorktree: nameWt,
      sameRepoName: nameMain === nameWt,
    },
    symlinks: {
      linkInsideWorkspace: {
        resolvedRootIsRealTarget: linkRoot === real(hono),
        foundFromRealRoot: rel(findWorkspaceFile(linkRoot)),
        isMember: isMember(f3, linkRoot),
      },
      linkToOutside: {
        resolvedRootIsRealTarget: extRoot === real(outside),
        foundFromRealRoot: rel(findWorkspaceFile(extRoot)),
        foundFromTypedPath: rel(findWorkspaceFile(path.join(base, "w3", "hono-ext"))),
        isMemberByRealPath: isMember(f3, extRoot),
      },
    },
    repoListedByTwoWorkspaceFiles: {
      foundFromRepo: rel(found4),
      nearestIsInner: found4 === innerFile,
      innerAndOuterStoreKeysDiffer: storeKey(innerFile) !== storeKey(outerFile),
      outerAlsoListsIt: isMember(outerFile, honoIn4),
      innerAlsoListsIt: isMember(innerFile, honoIn4),
    },
    sameDirectoryNameNoOrigin: { repoNameA: nameA, repoNameB: nameB, collide: nameA === nameB },
    fileAboveUnlistedRepo: {
      found: rel(found6),
      isMember: found6 ? isMember(found6, path.join(w6, "unlisted")) : null,
      listedIsMember: isMember(f6, path.join(w6, "listed")),
    },
  };
}

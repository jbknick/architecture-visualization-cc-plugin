/**
 * Guard for the M2 evals, which check out, reset and clean the copy they run on (as the M1 bench does,
 * see docs/milestones/M1.md "Running and recovering the bench"). Call `assertThrowawayCopy` before the first
 * git command that changes the copy: it refuses a path outside the system temp dir (unless the command line carries
 * `--i-know-this-is-a-throwaway-clone`, as the M1 bench accepts) and a copy with local changes.
 */
import { spawnSync } from "node:child_process";
import { assertThrowawayClone, THROWAWAY_FLAG } from "../bench/m1-safety.js";

export function assertThrowawayCopy(
  repo: string,
  tmpRoots?: string[],
  acknowledged: boolean = process.argv.includes(THROWAWAY_FLAG),
): void {
  assertThrowawayClone(repo, acknowledged, tmpRoots);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" });
  if (top.status !== 0) throw new Error(`refusing to run: ${repo} is not a git repository`);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim() !== "") {
    throw new Error(
      `refusing to run: ${repo} has local changes. Use a fresh copy (git status must print nothing).`,
    );
  }
}

/** The data dir must be named explicitly so a run never reads or writes the real ~/.gantry/data. */
export function requireDataDir(): string {
  const d = process.env.CLAUDE_PLUGIN_DATA;
  if (!d)
    throw new Error(
      "set CLAUDE_PLUGIN_DATA to the data dir of the copy (the real ~/.gantry/data is never used)",
    );
  return d;
}

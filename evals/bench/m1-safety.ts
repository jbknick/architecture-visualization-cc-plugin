/**
 * Safety rails for the M1 benchmark, which edits and stashes a tracked file in the test bed.
 *
 * - `assertThrowawayClone` refuses any path outside the system temp dir unless the caller passed the
 *   explicit flag, so the bench cannot be pointed at a working checkout by accident.
 * - `ProbeGuard` owns the probe edit and its stash. The stash message carries a per-run nonce and is
 *   matched exactly, so only this run's entry is ever applied or dropped. `restore()` is idempotent and
 *   synchronous, and runs from a `finally` block and from SIGINT/SIGTERM/SIGHUP/exit handlers, so the
 *   clone ends clean after an exception or a Ctrl-C. SIGKILL and power loss cannot be caught; see the
 *   recovery notes in docs/milestones/M1.md.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const THROWAWAY_FLAG = "--i-know-this-is-a-throwaway-clone";
export const STASH_PREFIX = "gantry-m1-bench";

/** realpath of the nearest existing ancestor plus the rest, so a path that does not exist yet still compares. */
function realOrResolved(p: string): string {
  const abs = resolve(p);
  for (let cur = abs, rest = ""; ; ) {
    try {
      return rest ? join(realpathSync(cur), rest) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest = rest ? join(basename(cur), rest) : basename(cur);
      cur = parent;
    }
  }
}

/** `os.tmpdir()` plus `/tmp`, which on macOS is not under `os.tmpdir()` (`/var/folders/...`). */
const defaultTmpRoots = (): string[] => [tmpdir(), "/tmp"];

/** True when `repo` is strictly inside one of the temp roots (symlinks resolved on both sides). */
export function isUnderTmp(repo: string, tmpRoots: string[] = defaultTmpRoots()): boolean {
  const dir = realOrResolved(repo);
  return tmpRoots.some((t) => {
    const root = realOrResolved(t);
    return dir !== root && dir.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export function assertThrowawayClone(
  repo: string,
  acknowledged: boolean,
  tmpRoots: string[] = defaultTmpRoots(),
): void {
  if (acknowledged || isUnderTmp(repo, tmpRoots)) return;
  throw new Error(
    `refusing to run: ${repo} is not under the system temp dir (${tmpRoots.map(realOrResolved).join(", ")}). The bench edits and stashes a tracked file there. Use a throwaway clone, or pass ${THROWAWAY_FLAG} if this path really is one.`,
  );
}

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

function gitOrThrow(repo: string, args: string[]): string {
  const r = git(repo, args);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err}`);
  return r.out;
}

export class ProbeGuard {
  readonly message: string;
  private stashed = false;
  private edited = false;
  private handlers: [NodeJS.Signals | "exit", () => void][] = [];

  constructor(
    private readonly repo: string,
    private readonly target: string,
    nonce: string = randomBytes(6).toString("hex"),
  ) {
    this.message = `${STASH_PREFIX}-${nonce}`;
  }

  /** Call before the first edit: refuses a dirty tree and arms the signal handlers. */
  arm(): void {
    if (gitOrThrow(this.repo, ["status", "--porcelain"]).trim() !== "") {
      throw new Error(
        "test bed has local changes; use a clean throwaway clone (recovery notes: docs/milestones/M1.md)",
      );
    }
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const h = (): void => {
        this.restore();
        process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
      };
      process.on(sig, h);
      this.handlers.push([sig, h]);
    }
    const onExit = (): void => this.restore();
    process.on("exit", onExit);
    this.handlers.push(["exit", onExit]);
  }

  /** Records that the probe edit has been written to the target (call right after writing it). */
  markEdited(): void {
    this.edited = true;
  }

  /** `git stash push -u` with this run's message. */
  stash(): void {
    gitOrThrow(this.repo, ["stash", "push", "-u", "-m", this.message]);
    this.stashed = true;
  }

  /** Index of this run's stash entry (exact message match), or -1. */
  private findStash(): { idx: number; sha: string } | undefined {
    const lines = git(this.repo, ["stash", "list", "--format=%H %gs"]).out.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const sp = line.indexOf(" ");
      const subject = line.slice(sp + 1);
      if (subject === this.message || subject.endsWith(`: ${this.message}`)) {
        return { idx: i, sha: line.slice(0, sp) };
      }
    }
    return undefined;
  }

  /**
   * Puts the clone back: applies and drops this run's stash if it exists (falling back to discarding it
   * when `apply` fails), then discards the probe edit so the tree is clean. Never throws.
   */
  restore(): void {
    try {
      const entry = this.findStash();
      if (entry) {
        const applied = git(this.repo, ["stash", "apply", entry.sha]).ok;
        // The stash holds only the probe edit, so a failed apply loses nothing: drop it either way.
        if (!applied) git(this.repo, ["checkout", "--", this.target]);
        const again = this.findStash();
        if (again) git(this.repo, ["stash", "drop", `stash@{${again.idx}}`]);
      }
      if (git(this.repo, ["status", "--porcelain"]).out.trim() !== "") {
        git(this.repo, ["checkout", "--", this.target]);
        git(this.repo, ["clean", "-fdq", "--", this.target]);
      }
      this.stashed = false;
      this.edited = false;
    } catch {
      // restore runs from signal and exit handlers: report through isClean(), never throw.
    }
  }

  isClean(): boolean {
    const st = git(this.repo, ["status", "--porcelain"]);
    return st.ok && st.out.trim() === "" && this.findStash() === undefined;
  }

  /** Removes the signal handlers (after a normal finish). */
  disarm(): void {
    for (const [ev, h] of this.handlers) process.off(ev, h);
    this.handlers = [];
  }

  get pending(): boolean {
    return this.edited || this.stashed;
  }
}

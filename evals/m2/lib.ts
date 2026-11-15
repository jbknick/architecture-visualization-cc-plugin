/**
 * Shared helpers for the M2 evals (issue #32). Private inputs and raw results live only under
 * `$GANTRY_PRIVATE_DIR/m2/` (git-ignored, outside this repo); nothing here prints a path, a symbol name or code
 * from the test bed, only counts, ratios, timings and opaque case ids.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const gantryRoot = resolve(here, "..", "..");
export const cliJs = join(gantryRoot, "plugin", "dist", "cli.js");

/** Where private data goes: `$GANTRY_PRIVATE_DIR`, else the git-ignored `evals/private/` of this repo (may be a symlink to a directory outside it). */
export function privateDir(): string {
  const d = process.env.GANTRY_PRIVATE_DIR ?? join(gantryRoot, "evals", "private");
  const dir = join(resolve(d), "m2");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function readPrivate<T>(name: string): T {
  return JSON.parse(readFileSync(join(privateDir(), name), "utf8")) as T;
}
export function writePrivate(name: string, data: unknown): void {
  writeFileSync(join(privateDir(), name), `${JSON.stringify(data, null, 1)}\n`);
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

/** Runs the built hook CLI exactly as Claude Code does: JSON on stdin, stdout captured. */
export function runPostToolHook(
  repo: string,
  file: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync("node", [cliJs, "hook", "post-tool-use"], {
    cwd: repo,
    env,
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(repo, file) }, cwd: repo }),
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", ms: Date.now() - t0 };
}

export interface SeededCase {
  id: string;
  /** Name differs from the existing function's and says nothing about what it does (spec section 13). */
  misleading: boolean;
  /** What the author would type into gantry_find_similar's `query`. Generic for the public cases; a private case gets it from its binding. */
  query?: string;
  /** Hand-written, generic code. Absent for the private verbatim-copy cases. */
  newCode?: string;
  /** Private verbatim-copy case: the runner copies the existing function from the copy under the binding's `copyAs` name. */
  copyOfExisting?: boolean;
  expected: { tiers: string[]; situation: 1 | 2 | 3 | 4 | 5 | 6 };
}
export interface SeededBinding {
  id: string;
  existing: string;
  targetFile: string;
  /** Private cases only: the query and the new function's name. */
  query?: string;
  copyAs?: string;
}

export const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
export function table(head: string[], rows: (string | number)[][]): string {
  const all = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]): string => `| ${r.map((c, i) => c.padEnd(w[i] ?? 0)).join(" | ")} |`;
  return [line(head), `| ${w.map((n) => "-".repeat(n)).join(" | ")} |`, ...all.slice(1).map(line)].join("\n");
}

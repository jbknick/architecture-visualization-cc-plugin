import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type GantryPaths,
  heal,
  indexRepo,
  isIndexable,
  loadConfig,
  openStore,
  resolvePaths,
  type Store,
  syncBacklog,
} from "@gantry/core";

export const HOOK_NAMES = [
  "session-start",
  "post-tool-use",
  "pre-commit",
  "pre-push",
  "post-checkout",
  "post-merge",
  "post-rewrite",
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export function logHook(paths: GantryPaths, name: string, message: string): void {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(paths.logsDir, "hooks.log"),
      `${new Date().toISOString()} ${name} ${message.replace(/\n/g, " | ")}\n`,
    );
  } catch {
    // logging must never fail a hook
  }
}

function git(root: string, args: string[]): { ok: boolean; out: Buffer } {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
}

function stagedPaths(root: string): string[] {
  const r = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
  return r.ok
    ? r.out
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== "")
    : [];
}

/** Pre-commit: index the staged blobs on a scratch copy of the store and enqueue undescribed functions. */
export async function preCommit(paths: GantryPaths): Promise<number> {
  const config = loadConfig(paths);
  const files = stagedPaths(paths.root).filter((p) => isIndexable(p, config));
  if (files.length === 0 || !fs.existsSync(paths.dbPath)) return 0;

  const sources = new Map<string, string>();
  for (const p of files) {
    const r = git(paths.root, ["show", `:${p}`]);
    if (r.ok) sources.set(p, r.out.toString("utf8"));
  }
  if (sources.size === 0) return 0;

  const scratchPath = path.join(paths.dataDir, `precommit-${process.pid}.db`);
  const real = openStore(paths.dbPath);
  let scratch: Store | undefined;
  try {
    real.db.exec(`VACUUM INTO '${scratchPath.replace(/'/g, "''")}'`);
    scratch = openStore(scratchPath);
    await indexRepo(paths, { layer: "working", files: [...sources.keys()], sources, store: scratch });

    const staged = [...sources.keys()].flatMap((p) =>
      (scratch as Store).effectiveSymbols({ fileId: `file:${p}` }),
    );
    return syncBacklog(real, { root: paths.root, sources, symbols: staged }).enqueued;
  } finally {
    scratch?.close();
    real.close();
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(scratchPath + ext, { force: true });
  }
}

/** Number of pending/claimed backlog items, restricted to files changed on the way to the upstream when known. */
function pushBacklog(paths: GantryPaths): number {
  if (!fs.existsSync(paths.dbPath)) return 0;
  const store = openStore(paths.dbPath);
  try {
    const rows = store.db
      .prepare("SELECT symbol_id FROM backlog WHERE status IN ('pending','claimed')")
      .all() as { symbol_id: string }[];
    const up = git(paths.root, ["diff", "--name-only", "-z", "@{upstream}...HEAD"]);
    if (!up.ok) return rows.length;
    const pushed = new Set(
      up.out
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== ""),
    );
    return rows.filter((r) => pushed.has(r.symbol_id.slice("sym:".length).split("#")[0] ?? "")).length;
  } finally {
    store.close();
  }
}

function backlogCount(paths: GantryPaths): number {
  const store = openStore(paths.dbPath);
  try {
    const r = store.db.prepare("SELECT COUNT(*) AS n FROM backlog WHERE status != 'failed'").get() as {
      n: number;
    };
    return r.n;
  } finally {
    store.close();
  }
}

/**
 * Runs one hook. Never throws and never writes to stdout except where the spec says so (session-start's
 * single line); the caller exits 0 regardless. Returns the stdout line, if any.
 */
export async function runHook(
  name: string,
  _args: string[],
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  errOut: (s: string) => void = (s) => void process.stderr.write(s),
): Promise<string | undefined> {
  if (env.GANTRY_WORKER === "1") return undefined;
  let paths: GantryPaths;
  try {
    paths = resolvePaths(cwd, env);
  } catch {
    return undefined; // not a repo: nowhere to log, nothing to do
  }
  try {
    switch (name as HookName) {
      case "post-checkout":
      case "post-merge":
      case "post-rewrite":
        if (fs.existsSync(paths.dbPath)) await heal(paths);
        return undefined;
      case "pre-push": {
        if (fs.existsSync(paths.dbPath)) await heal(paths);
        const n = pushBacklog(paths);
        if (n > 0) {
          errOut(
            `gantry: ${n} function${n === 1 ? "" : "s"} in this push ${n === 1 ? "has" : "have"} no description yet\n`,
          );
        }
        return undefined;
      }
      case "pre-commit":
        await preCommit(paths);
        return undefined;
      case "session-start": {
        if (!fs.existsSync(paths.dbPath)) return "Gantry: no index for this repo yet. Run `gantry init`.";
        await heal(paths);
        const n = backlogCount(paths);
        const threshold = loadConfig(paths).backlogReminderThreshold;
        return n >= threshold ? `Gantry: ${n} functions are waiting for descriptions.` : undefined;
      }
      case "post-tool-use":
        return undefined; // findings arrive with the M2 duplicate checks
      default:
        logHook(paths, name, "unknown hook name");
        return undefined;
    }
  } catch (err) {
    logHook(paths, name, `error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return undefined;
  }
}

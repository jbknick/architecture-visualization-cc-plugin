import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { GantryPaths } from "@gantry/core";
import { type ExplorerState, findRunningExplorer } from "./state.js";

/** How long to wait for a freshly spawned explorer; `gantry_open_view`'s contract is a URL within 3 s. */
export const START_TIMEOUT_MS = 2500;
const POLL_MS = 40;

/**
 * Starts `gantry map --no-open` detached. Its output has no access token (`--no-url`) and goes to
 * `<logsDir>/explorer.log` (never to this process's stdout, which may carry protocol frames, and never into the
 * repository). `exited` resolves when the child ends, so the caller can stop waiting.
 */
function spawnExplorer(
  paths: GantryPaths,
  cli: string,
  env: NodeJS.ProcessEnv,
): { exited: Promise<number | null> } {
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  // Replaced on each spawn, so old output never piles up. The old name is unlinked (a planted symlink is not
  // followed) and the new file is created exclusively.
  const logFile = join(paths.logsDir, "explorer.log");
  try {
    unlinkSync(logFile);
  } catch {
    // none yet
  }
  const fd = openSync(logFile, "wx", 0o600);
  try {
    const child = spawn(process.execPath, [cli, "map", "--no-open", "--no-url"], {
      cwd: paths.root,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("exit", (code) => resolve(code));
    });
    child.unref();
    return { exited };
  } finally {
    closeSync(fd);
  }
}

export type EnsureResult =
  | { ok: true; state: Pick<ExplorerState, "port" | "token"> }
  | { ok: false; message: string };

/**
 * The running explorer of this worktree, or a new one started in the background with the `gantry` CLI bundle at
 * `cli` (shared by `gantry_open_view` and `gantry review --open`). Waits up to `timeoutMs` for it to answer.
 */
export async function ensureExplorer(opts: {
  paths: GantryPaths;
  cli: string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<EnsureResult> {
  const { paths, env } = opts;
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  let state: Awaited<ReturnType<typeof findRunningExplorer>>;
  try {
    state = await findRunningExplorer(paths);
    if (!state) {
      if (!opts.cli) throw new Error("Cannot find the gantry CLI bundle (plugin/dist/cli.js); run the build");
      const { exited } = spawnExplorer(paths, opts.cli, env);
      let dead = false;
      void exited.then(() => {
        dead = true;
      });
      const deadline = Date.now() + timeoutMs;
      while (!state && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        state = await findRunningExplorer(paths);
        // If the child exited, it either lost a start race (the winner's explorer.json is in place) or failed.
        if (!state && dead) {
          state = await findRunningExplorer(paths);
          break;
        }
      }
    }
  } catch (err) {
    // For example ExplorerUnresponsive: a live process owns explorer.json but does not answer.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!state) {
    return {
      ok: false,
      message: `The explorer did not start within ${timeoutMs} ms. See ${join(paths.logsDir, "explorer.log")}.`,
    };
  }
  return { ok: true, state: { port: state.port, token: state.token } };
}

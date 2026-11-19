import fs from "node:fs";
import path from "node:path";
import {
  type GantryPaths,
  heal,
  loadConfig,
  openStore,
  pathOfSymId,
  resolvePaths,
  StaleStoreError,
} from "@gantry/core";
import {
  POST_TOOL_BUDGET_MS,
  parsePostToolInput,
  parseStopInput,
  postToolUse,
  settleBatch,
} from "./postToolUse.js";
import { INIT_REMINDER, sessionStart } from "./sessionStart.js";
import { describeStaged, git, preCommit } from "./staged.js";

export { preCommit };

/** Time kept back from the hook budget for formatting and printing after the last file is checked. */
const STOP_MARGIN_MS = 300;

export const HOOK_NAMES = [
  "session-start",
  "post-tool-use",
  "stop",
  "pre-commit",
  "pre-push",
  "post-checkout",
  "post-merge",
  "post-rewrite",
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** One log line for an error: a stale store is named plainly (hooks never rebuild it), anything else keeps its stack. */
function errorLine(err: unknown): string {
  if (err instanceof StaleStoreError)
    return `stale store (schema ${err.found}, now ${err.expected}); left for the next non-hook command`;
  return `error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
}

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

/** Number of pending/claimed backlog items, restricted to files changed on the way to the upstream when known. */
function pushBacklog(paths: GantryPaths): number {
  if (!fs.existsSync(paths.dbPath)) return 0;
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath });
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
    return rows.filter((r) => pushed.has(pathOfSymId(r.symbol_id) ?? "")).length;
  } finally {
    store.close();
  }
}

/**
 * Runs one hook. Never throws and never writes to stdout except where the spec says so (session-start's
 * single line, post-tool-use's and stop's JSON); the caller exits 0 regardless. Returns the stdout line, if any.
 * `stdin` is the hook's input text (post-tool-use and stop only).
 */
export async function runHook(
  name: string,
  _args: string[],
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  errOut: (s: string) => void = (s) => void process.stderr.write(s),
  stdin?: string,
): Promise<string | undefined> {
  if (env.GANTRY_WORKER === "1") return undefined;
  const startedAt = Date.now();
  let paths: GantryPaths;
  const toolInput = name === "post-tool-use" ? parsePostToolInput(stdin) : undefined;
  if (name === "post-tool-use" && !toolInput) return undefined;
  const stopInput = name === "stop" ? parseStopInput(stdin) : undefined;
  if (name === "stop" && !stopInput) return undefined;
  try {
    paths = resolvePaths(toolInput?.cwd ?? stopInput?.cwd ?? cwd, env);
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
      case "pre-commit": {
        const printFindings = (lines: string[]): void => {
          for (const l of lines) errOut(`${l}\n`);
        };
        // `off` (the default) only enqueues; `timeboxed` and `strict` also run the headless describer.
        if (loadConfig(paths).precommit.mode === "off") {
          await preCommit(paths, printFindings);
          return undefined;
        }
        const r = await describeStaged(paths, { env, startedAt, onFindings: printFindings });
        if (r && r.undescribed > 0) errOut(`gantry: described ${r.described}, queued ${r.queued}\n`);
        return undefined;
      }
      case "session-start":
        try {
          return await sessionStart(paths);
        } catch (err) {
          if (!(err instanceof StaleStoreError)) throw err;
          logHook(paths, name, errorLine(err));
          return INIT_REMINDER;
        }
      case "post-tool-use":
      case "stop": {
        const budget = Number(env.GANTRY_POST_TOOL_BUDGET_MS);
        const ms =
          env.GANTRY_POST_TOOL_BUDGET_MS && Number.isFinite(budget) && budget >= 0
            ? budget
            : POST_TOOL_BUDGET_MS;
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
        });
        // Stop no file after this point, so the findings of the files already checked are printed in time.
        const settleOpts = { deadline: startedAt + ms - Math.min(STOP_MARGIN_MS, ms / 4) };
        const job =
          name === "stop"
            ? settleBatch(paths, stopInput as NonNullable<typeof stopInput>, settleOpts)
            : postToolUse(paths, toolInput as NonNullable<typeof toolInput>, settleOpts);
        const work = job.catch((err) => {
          logHook(paths, name, errorLine(err));
          return undefined;
        });
        const r = await Promise.race([work, late]);
        clearTimeout(timer);
        if (r === undefined && Date.now() - startedAt >= ms)
          logHook(paths, name, `budget of ${ms} ms exceeded`);
        return r;
      }
      default:
        logHook(paths, name, "unknown hook name");
        return undefined;
    }
  } catch (err) {
    logHook(paths, name, errorLine(err));
    return undefined;
  }
}

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GantryPaths } from "@gantry/core";
import { buildExplorerUrl, findRunningExplorer, listViews } from "@gantry/explorer";
import { z } from "zod";
import { defineTool } from "../tool.js";

/** How long to wait for a freshly spawned explorer; the tool's contract is a URL within 3 s. */
export const START_TIMEOUT_MS = 2500;
const POLL_MS = 40;
/** Parts of the URL that are set by other arguments; a filter must not override them. */
const RESERVED_FILTER_KEYS = new Set(["focus", "t", "view"]);

/** `gantry` CLI bundle: next to the MCP bundle in `plugin/dist/`, or (running from source) at the repo's `plugin/dist/`. */
function cliPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "cli.js"), join(here, "..", "..", "..", "..", "plugin", "dist", "cli.js")].find((p) =>
    existsSync(p),
  );
}

/**
 * Starts `gantry map --no-open` detached. Its output has no access token (`--no-url`) and goes to `<logsDir>/explorer.log` (never to this
 * process's stdout, which carries protocol frames only, and never into the repository). `exited` resolves when the
 * child ends, so the caller can stop waiting.
 */
function spawnExplorer(paths: GantryPaths, env: NodeJS.ProcessEnv): { exited: Promise<number | null> } {
  const cli = cliPath();
  if (!cli) throw new Error("Cannot find the gantry CLI bundle (plugin/dist/cli.js); run the build");
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

export const openViewTool = defineTool({
  name: "gantry_open_view",
  description:
    "Opens the architecture explorer for this worktree and returns {url}, a local http://127.0.0.1 link with an access token that the user opens in a browser. " +
    "It starts the explorer server in the background if it is not running (within 3 seconds) and reuses it otherwise. " +
    "Give the url to the user as is; do not fetch it. view is a view id (for example project-map, ego, duplicates, map3d); focus is a node id (sym:..., file:..., ws:...) to center on; filters are view options as string key/value pairs. " +
    "Unknown view ids return {error: unknown_view, views}.",
  inputSchema: {
    view: z.string().min(1).max(50).describe("View id, for example project-map, ego, duplicates, map3d"),
    focus: z.string().min(1).max(500).optional().describe("Node id to focus (sym:..., file:..., ws:...)"),
    filters: z
      .record(z.string().max(100), z.string().max(500))
      .optional()
      .describe("View options as string key/value pairs"),
  },
  async run({ view, focus, filters }, { paths, env }) {
    const reserved = Object.keys(filters ?? {}).filter((k) => RESERVED_FILTER_KEYS.has(k));
    if (reserved.length > 0) {
      return {
        error: "reserved_filter_key",
        message: `filters may not use ${reserved.map((k) => `'${k}'`).join(", ")}; pass focus as its own argument.`,
      };
    }
    const ids = listViews().map((v) => v.id);
    if (!ids.includes(view)) {
      return { error: "unknown_view", message: `No view named '${view}'.`, views: ids };
    }
    let state: Awaited<ReturnType<typeof findRunningExplorer>>;
    try {
      state = await findRunningExplorer(paths);
      if (!state) {
        const { exited } = spawnExplorer(paths, env);
        let dead = false;
        void exited.then(() => {
          dead = true;
        });
        const deadline = Date.now() + START_TIMEOUT_MS;
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
      return { error: "explorer_unavailable", message: err instanceof Error ? err.message : String(err) };
    }
    if (!state) {
      return {
        error: "explorer_unavailable",
        message: `The explorer did not start within ${START_TIMEOUT_MS} ms. See ${join(paths.logsDir, "explorer.log")}.`,
      };
    }
    return {
      url: buildExplorerUrl({
        port: state.port,
        token: state.token,
        view,
        ...(focus ? { focus } : {}),
        ...(filters ? { filters } : {}),
      }),
    };
  },
});

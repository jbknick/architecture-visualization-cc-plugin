import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExplorerUrl, ensureExplorer, listViews } from "@gantry/explorer";
import { z } from "zod";
import { defineTool } from "../tool.js";

export { START_TIMEOUT_MS } from "@gantry/explorer";

/** Parts of the URL that are set by other arguments; a filter must not override them. */
const RESERVED_FILTER_KEYS = new Set(["focus", "t", "view"]);

/** `gantry` CLI bundle: next to the MCP bundle in `plugin/dist/`, or (running from source) at the repo's `plugin/dist/`. */
function cliPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "cli.js"), join(here, "..", "..", "..", "..", "plugin", "dist", "cli.js")].find((p) =>
    existsSync(p),
  );
}

export const openViewTool = defineTool({
  name: "gantry_open_view",
  description:
    "Opens the architecture explorer for this worktree and returns {url}, a local http://127.0.0.1 link with an access token that the user opens in a browser. " +
    "It starts the explorer server in the background if it is not running (within 3 seconds) and reuses it otherwise. " +
    "Give the url to the user as is; do not fetch it. view is a view id (for example project-map, ego, duplicates, review, map-3d); focus is a node id (sym:..., file:..., ws:...) to center on and open in the inspector; filters are view options as string key/value pairs (the review view needs {range: '<base>...<head>'} or {pr: '<n>'}). " +
    "Unknown view ids return {error: unknown_view, views}.",
  inputSchema: {
    view: z.string().min(1).max(50).describe("View id, for example project-map, ego, duplicates, map-3d"),
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
    const r = await ensureExplorer({ paths, cli: cliPath(), env });
    if (!r.ok) return { error: "explorer_unavailable", message: r.message };
    const state = r.state;
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

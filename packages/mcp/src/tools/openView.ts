import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kindOfId, qualifyId, readOverlay } from "@gantry/core";
import { buildExplorerUrl, ensureExplorer, listViews } from "@gantry/explorer";
import { z } from "zod";
import { defineTool } from "../tool.js";

export { START_TIMEOUT_MS } from "@gantry/explorer";

/** A node id typed without the repo part (`route:<ws>:<path>`, `table:<name>`) gets this repo after its prefix. */
function qualifyFocus(repo: string, focus: string): string {
  const kind = kindOfId(focus);
  if (kind === undefined || focus.startsWith(`${kind}:${repo}:`)) return focus;
  return qualifyId(repo, focus) ?? focus;
}

/** Parts of the URL that are set by other arguments; a filter must not override them. */
const RESERVED_FILTER_KEYS = new Set(["focus", "saved", "t", "view"]);

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
    "Give the url to the user as is; do not fetch it. view is a view id (for example project-map, ego, duplicates, review, map-3d, endpoints, page-api, api-tables, feature-path, table-usage); focus is a node id (sym:..., file:..., ws:...) to center on and open in the inspector; filters are view options as string key/value pairs (the review view needs {range: '<base>...<head>'} or {pr: '<n>'}). " +
    "saved_view is the id of a saved view (made in the explorer with Save view); its view must be the one in view. " +
    "Unknown view ids return {error: unknown_view, views}; an unknown saved view returns {error: unknown_saved_view, views: [ids]}; a saved view of another view returns {error: saved_view_mismatch, view}.",
  inputSchema: {
    view: z.string().min(1).max(50).describe("View id, for example project-map, ego, duplicates, map-3d"),
    focus: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Node id to focus (sym:..., file:..., ws:...; route:... or ep:... for feature-path, table:... for table-usage)",
      ),
    saved_view: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe(
        "Id of a saved view (a slug such as curated); it opens with that view's level, focus and filters",
      ),
    filters: z
      .record(z.string().max(100), z.string().max(500))
      .optional()
      .describe("View options as string key/value pairs"),
  },
  async run({ view, focus, saved_view, filters }, { paths, store, env }) {
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
    if (saved_view !== undefined) {
      const views = readOverlay(store).views;
      const saved = views.find((v) => v.id === saved_view);
      if (!saved) {
        return {
          error: "unknown_saved_view",
          message: `No saved view with id '${saved_view}'.`,
          views: views.map((v) => v.id),
        };
      }
      if (saved.spec.view !== view) {
        return {
          error: "saved_view_mismatch",
          message: `Saved view '${saved_view}' is for the view '${saved.spec.view}', not '${view}'.`,
          view: saved.spec.view,
        };
      }
    }
    const r = await ensureExplorer({ paths, cli: cliPath(), env });
    if (!r.ok) return { error: "explorer_unavailable", message: r.message };
    const state = r.state;
    return {
      url: buildExplorerUrl({
        port: state.port,
        token: state.token,
        view,
        ...(focus ? { focus: qualifyFocus(paths.repo, focus) } : {}),
        ...(saved_view ? { saved: saved_view } : {}),
        ...(filters ? { filters } : {}),
      }),
    };
  },
});

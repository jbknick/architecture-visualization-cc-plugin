import fs from "node:fs";
import {
  GantryError,
  type Group,
  loadConfig,
  openStore,
  publishGroup,
  publishView,
  pullTeamCache,
  readOverlay,
  resetStaleStore,
  resolveTeamSettings,
  type SavedView,
  teamClient,
  unpublishGroup,
  unpublishView,
} from "@gantry/core";
import { EXIT_ERROR, EXIT_OK } from "./shared.js";
import type { TeamContext } from "./team.js";

export type PublishKind = "view" | "group";

/** Exit code for an id that is not a local view or group (spec section 10: a usage error). */
const EXIT_USAGE = 2;

/** The local view or group `id` (the overlay's, never the team's), or `undefined`. */
function findLocal(ctx: TeamContext, kind: PublishKind, id: string): Group | SavedView | undefined {
  // Read-only: a repository with no index here has no overlay to look in, and none is created.
  if (!fs.existsSync(ctx.paths.dbPath)) return undefined;
  resetStaleStore(ctx.paths);
  const store = openStore(ctx.paths.dbPath, { overlayPath: ctx.paths.overlayPath, repo: ctx.paths.repo });
  try {
    const overlay = readOverlay(store);
    return (kind === "view" ? overlay.views : overlay.groups).find((x) => x.id === id);
  } finally {
    store.close();
  }
}

/**
 * `gantry team publish|unpublish view|group <id>` (spec sections 10 and 11). Exit 0 on success, 1 with the server's
 * message when it refuses (or when no team is linked), 2 when `id` is not a local view or group.
 */
export async function teamPublish(
  ctx: TeamContext,
  opts: { action: "publish" | "unpublish"; kind: PublishKind; id: string; json?: boolean },
): Promise<number> {
  const { action, kind, id } = opts;
  const failed = action === "publish" ? "Not published" : "Not removed";
  try {
    const config = loadConfig(ctx.paths);
    const settings = resolveTeamSettings(config, ctx.env);
    if (settings.server === undefined) {
      ctx.err("not linked to a team\n");
      return EXIT_ERROR;
    }
    const client = teamClient(ctx.paths, config, {
      env: ctx.env,
      ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
    });
    if (!client.hasToken || client.org === undefined) {
      ctx.err("not linked to a team\n");
      return EXIT_ERROR;
    }
    const local = findLocal(ctx, kind, id);
    if (local === undefined) {
      ctx.err(`gantry: no local ${kind} with the id ${id}\n`);
      return EXIT_USAGE;
    }
    const repo = ctx.paths.repo;
    const refresh = () =>
      pullTeamCache(ctx.paths, config, {
        env: ctx.env,
        ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
        ...(ctx.now === undefined ? {} : { now: ctx.now }),
      });
    let pulled: { status: string; error?: string };
    if (action === "publish") {
      pulled =
        kind === "view"
          ? await publishView(client, repo, local as SavedView, refresh)
          : await publishGroup(client, repo, local as Group, refresh);
    } else {
      const result =
        kind === "view"
          ? await unpublishView(client, repo, id, refresh)
          : await unpublishGroup(client, repo, id, refresh);
      pulled = result.refresh;
      if (!result.deleted) {
        ctx.err(`${failed}: the team has no ${kind} ${id}.\n`);
        return EXIT_ERROR;
      }
    }
    if (opts.json === true) {
      ctx.out(`${JSON.stringify({ kind, id, published: action === "publish" })}\n`);
    } else if (action === "publish") {
      ctx.out(`Published ${kind} ${id} to ${repo}.\n`);
    } else {
      ctx.out(`Removed ${kind} ${id} from ${repo}.\n`);
    }
    // The server accepted the change; only the local copy of the team's state is behind.
    if (pulled.status === "failed") {
      ctx.err(`The team cache was not refreshed: ${pulled.error ?? "unknown error"}\n`);
    }
    return EXIT_OK;
  } catch (err) {
    if (err instanceof GantryError) {
      ctx.err(`${failed}: ${err.message}\n`);
      return EXIT_ERROR;
    }
    throw err;
  }
}

import { type GantryPaths, loadConfig, syncTeamDescriptions } from "@gantry/core";
import type { Logger } from "./log.js";

/** At most this many functions are asked about when the server starts. */
export const START_SYNC_LIMIT = 2000;
/** The most the start-up sync runs; the server never waits for it. */
export const START_SYNC_TIMEOUT_MS = 5000;

export interface StartupSyncOptions {
  paths: GantryPaths;
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** For tests: the fetch the sync uses. */
  fetch?: typeof fetch;
}

/**
 * Fills in the team's descriptions for the functions this machine has none for (spec section 11). It runs once, after
 * the team cache pull, in the MCP server and never in a hook. It is best effort: a failure or a timeout is written to
 * the MCP log and ignored, and it never reaches a tool result. Resolves when it is over; the caller does not await it.
 */
export async function syncDescriptionsAtStart(o: StartupSyncOptions): Promise<void> {
  try {
    await syncTeamDescriptions(o.paths, loadConfig(o.paths), {
      env: o.env,
      limit: START_SYNC_LIMIT,
      timeoutMs: START_SYNC_TIMEOUT_MS,
      log: (line) => o.log.info(line),
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
  } catch (err) {
    o.log.error(`description sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

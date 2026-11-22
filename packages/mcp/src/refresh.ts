import { type GantryPaths, heal, healPending, openStore, refreshWorking } from "@gantry/core";
import type { Logger } from "./log.js";

function pending(paths: GantryPaths): boolean {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    return healPending(paths, store);
  } finally {
    store.close();
  }
}

/**
 * Lazy refresh before a tool call (spec section 11): `heal` only when `HEAD` of some repo is not the commit its index was
 * built for, then `refreshWorking`. A failure is logged and the call goes on with the index as it is, because an
 * answer from a slightly stale index beats no answer.
 */
export async function lazyRefresh(paths: GantryPaths, log: Logger): Promise<{ healed: boolean }> {
  let healed = false;
  try {
    if (pending(paths)) {
      await heal(paths, { reattach: true });
      healed = true;
    }
    await refreshWorking(paths, { reattach: true });
  } catch (err) {
    log.error("lazy refresh failed; continuing with the current index", err);
  }
  return { healed };
}

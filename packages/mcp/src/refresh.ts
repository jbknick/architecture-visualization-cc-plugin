import { spawnSync } from "node:child_process";
import { type GantryPaths, heal, openStore, refreshWorking } from "@gantry/core";
import type { Logger } from "./log.js";

function headOf(root: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

function storedHead(paths: GantryPaths): string | undefined {
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath });
  try {
    return store.getMeta("head_sha");
  } finally {
    store.close();
  }
}

/**
 * Lazy refresh before a tool call (spec section 11): `heal` only when `HEAD` is not the commit the index was
 * built for, then `refreshWorking`. A failure is logged and the call goes on with the index as it is, because an
 * answer from a slightly stale index beats no answer.
 */
export async function lazyRefresh(paths: GantryPaths, log: Logger): Promise<{ healed: boolean }> {
  let healed = false;
  try {
    const head = headOf(paths.root);
    if (head !== undefined && head !== storedHead(paths)) {
      await heal(paths);
      healed = true;
    }
    await refreshWorking(paths);
  } catch (err) {
    log.error("lazy refresh failed; continuing with the current index", err);
  }
  return { healed };
}

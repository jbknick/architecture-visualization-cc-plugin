import fs from "node:fs";
import { type GantryPaths, heal, isIndexed, loadConfig, openStore } from "@gantry/core";

export const INIT_REMINDER = "Gantry: run /gantry:init to index this repo";

/**
 * SessionStart (spec section 14): heal, then one plain line, only when the index is missing or the backlog
 * has reached `backlogReminderThreshold`. Claude Code adds plain stdout of this event to the context. It creates no
 * data dir: a repository without an index here is only reminded to run `/gantry:init` (#147), and a store that a
 * lookup or the MCP lazy refresh created without a backlog counts as missing too.
 *
 * A store built by another version of Gantry (a different `schema_version`) is left alone: hooks never reset or
 * rebuild it, so `openStore` throws `StaleStoreError`; `runHook` logs it and prints the reminder to run
 * `/gantry:init`. The next non-hook command rebuilds the store.
 */
export async function sessionStart(paths: GantryPaths): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return INIT_REMINDER;
  await heal(paths);
  const store = openStore(paths.dbPath);
  let n: number;
  try {
    if (!isIndexed(store)) return INIT_REMINDER;
    n = (
      store.db.prepare("SELECT COUNT(*) AS n FROM backlog WHERE status != 'failed'").get() as { n: number }
    ).n;
  } finally {
    store.close();
  }
  const threshold = loadConfig(paths).backlogReminderThreshold;
  return n >= threshold
    ? `Gantry: ${n} functions await descriptions — run /gantry:sync when convenient`
    : undefined;
}

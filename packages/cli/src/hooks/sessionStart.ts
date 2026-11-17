import fs from "node:fs";
import { type GantryPaths, heal, indexFormatStale, isIndexed, loadConfig, openStore } from "@gantry/core";

/**
 * SessionStart (spec section 14): heal, then one plain line, only when the index is missing or the backlog
 * has reached `backlogReminderThreshold`. Claude Code adds plain stdout of this event to the context. It creates no
 * data dir: a repository without an index here is only reminded to run `/gantry:init` (#147), and a store that a
 * lookup or the MCP lazy refresh created without a backlog counts as missing too.
 *
 * A store built with an older index format (#195) needs a full main re-index, which can outlast the hook's timeout on
 * a large repository; the session start does not wait for it. It is deferred to the first MCP tool call's lazy
 * refresh (or the explorer's Refresh, `gantry map`, a git hook, `gantry heal`), which runs it without a timeout.
 */
export async function sessionStart(paths: GantryPaths): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return "Gantry: run /gantry:init to index this repo";
  if (!formatUpgradeDue(paths)) await heal(paths);
  const store = openStore(paths.dbPath);
  let n: number;
  try {
    if (!isIndexed(store)) return "Gantry: run /gantry:init to index this repo";
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

function formatUpgradeDue(paths: GantryPaths): boolean {
  const store = openStore(paths.dbPath);
  try {
    return indexFormatStale(store.db);
  } finally {
    store.close();
  }
}

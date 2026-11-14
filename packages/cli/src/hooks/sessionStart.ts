import fs from "node:fs";
import { type GantryPaths, heal, loadConfig, openStore } from "@gantry/core";

/**
 * SessionStart (spec section 14): heal, then one plain line, only when the index is missing or the backlog
 * has reached `backlogReminderThreshold`. Claude Code adds plain stdout of this event to the context.
 */
export async function sessionStart(paths: GantryPaths): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return "Gantry: run /gantry:init to index this repo";
  await heal(paths);
  const store = openStore(paths.dbPath);
  let n: number;
  try {
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

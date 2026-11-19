import { existsSync } from "node:fs";
import type Database from "better-sqlite3";

/**
 * The overlay: `<dataDir>/overlay.db`, a second SQLite file attached to every store connection as `overlay`.
 * It holds what a person decided (duplicate dismissals, saved node positions, labels, hidden parts, groups, saved views), so deleting and rebuilding
 * `gantry.db` (spec section 9, `resetStaleStore`) never loses it.
 *
 * Rule for this file: tables are only ever added, with `CREATE TABLE IF NOT EXISTS`; they are never dropped or
 * altered. The overlay has no schema version, and Gantry never deletes it (only `gantry uninstall` does, as part of
 * the data dir). Opening it writes nothing when it is already up to date.
 */
export const OVERLAY_SCHEMA = `CREATE TABLE IF NOT EXISTS overlay.dismissals(a TEXT, b TEXT, reason TEXT, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS overlay.layouts(view TEXT, node_id TEXT, x REAL, y REAL, PRIMARY KEY(view, node_id));
CREATE TABLE IF NOT EXISTS overlay.labels(node_id TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS overlay.hidden(position INTEGER PRIMARY KEY, selector TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS overlay.groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, selectors TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS overlay.group_rules(group_id TEXT PRIMARY KEY, may_use TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS overlay.views(id TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL);
`;

/** Attaches the overlay file as `overlay` and makes sure its tables exist. `":memory:"` attaches a private in-memory one. */
export function attachOverlay(db: Database.Database, overlayPath: string): void {
  const fresh = overlayPath !== ":memory:" && !existsSync(overlayPath);
  db.prepare("ATTACH DATABASE ? AS overlay").run(overlayPath);
  if (fresh) db.pragma("overlay.journal_mode = WAL");
  // CREATE TABLE IF NOT EXISTS on an existing table changes no bytes, so a reopen leaves the file as it was.
  db.exec(OVERLAY_SCHEMA);
}

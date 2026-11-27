// A seeded `team-cache.db` for tests and the explorer's end-to-end specs: no server, no pull.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeSet } from "@gantry/protocol";
import Database from "better-sqlite3";
import { TEAM_CACHE_SCHEMA } from "./cacheSchema.js";

/** The `meta` rows `seedTeamCache` writes. */
export const SEEDED_META = {
  pulled_at: "2026-11-25T14:00:00Z",
  server: "https://gantry.example.com",
  org: "acme",
  repo: "fixture/pnpm-turbo",
} as const;

/**
 * Creates `team-cache.db` at `dbPath` (replacing any file there) with the cache schema, loads the change sets of the
 * JSON file `file` (an array of change sets) and sets `meta` to `SEEDED_META`.
 */
export function seedTeamCache(dbPath: string, file: string): void {
  const changeSets = JSON.parse(readFileSync(file, "utf8")) as ChangeSet[];
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(TEAM_CACHE_SCHEMA);
    db.pragma("user_version = 1");
    const insertSet = db.prepare(
      `INSERT INTO change_sets(id, repo, source, state, estimated, confidence, owner, title, pr, ref, head_ref,
         base_branch, head_sha, links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertNode = db.prepare(
      "INSERT OR IGNORE INTO change_set_nodes(change_set_id, node_id) VALUES (?, ?)",
    );
    const insertReach = db.prepare(
      "INSERT OR REPLACE INTO change_set_reach(change_set_id, node_id, hop, tier, via_hub) VALUES (?, ?, ?, ?, ?)",
    );
    const insertMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    db.transaction(() => {
      for (const cs of changeSets) {
        insertSet.run(
          cs.id,
          cs.repo,
          cs.source,
          cs.state,
          cs.estimated ? 1 : 0,
          cs.confidence ?? null,
          cs.owner,
          cs.title ?? null,
          cs.pr ?? null,
          cs.ref,
          cs.head_ref,
          cs.base_branch,
          cs.head_sha,
          JSON.stringify(cs.links),
          cs.created_at,
          cs.updated_at,
        );
        for (const node of cs.nodes) insertNode.run(cs.id, node);
        for (const r of cs.radius) insertReach.run(cs.id, r.id, r.hop, r.tier, r.via_hub ? 1 : 0);
      }
      for (const [key, value] of Object.entries(SEEDED_META)) insertMeta.run(key, value);
    })();
  } finally {
    db.close();
  }
}

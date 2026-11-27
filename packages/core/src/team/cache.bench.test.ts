import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GantryPaths } from "../paths/index.js";
import { openTeamCache, readChangeSetsTouching, teamCachePath } from "./cache.js";
import { TEAM_CACHE_SCHEMA } from "./cacheSchema.js";
import { REPO, tempPaths } from "./cacheTestkit.js";

let tmp: ReturnType<typeof tempPaths>;
let paths: GantryPaths;
beforeEach(() => {
  tmp = tempPaths();
  paths = tmp.paths;
});
afterEach(() => tmp.cleanup());

const SETS = 200;
const REACH = 500;
const RUNS = 20;
const BUDGET_MS = 20;

/** A cache with 200 change sets of 500 reach rows each (100,000 rows), written the way a pull writes it. */
function seed(): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const db = new Database(teamCachePath(paths));
  db.pragma("journal_mode = WAL");
  db.exec(TEAM_CACHE_SCHEMA);
  db.pragma("user_version = 1");
  const insertSet = db.prepare(
    "INSERT INTO change_sets VALUES (?, ?, 'pr', 'in_review', 0, NULL, 'octo-dev', ?, ?, ?, ?, 'main', ?, '[]', ?, ?)",
  );
  const insertNode = db.prepare("INSERT INTO change_set_nodes VALUES (?, ?)");
  const insertReach = db.prepare("INSERT INTO change_set_reach VALUES (?, ?, ?, ?, 0)");
  db.transaction(() => {
    for (let n = 1; n <= SETS; n++) {
      const id = `cs:pr:${REPO}#${n}`;
      insertSet.run(
        id,
        REPO,
        `Change ${n}`,
        n,
        `#${n}`,
        `feat/${n}`,
        "a".repeat(40),
        "2026-11-20T09:15:00.000Z",
        `2026-11-20T09:${String(n % 60).padStart(2, "0")}:00.000Z`,
      );
      for (let k = 0; k < 20; k++) insertNode.run(id, `file:${REPO}:src/own-${n}-${k}.ts`);
      for (let k = 0; k < REACH; k++) {
        // every change set reaches the shared nodes 0..49, so a lookup on one of them returns 200 rows
        const node = k < 50 ? `file:${REPO}:src/shared-${k}.ts` : `file:${REPO}:src/r-${n}-${k}.ts`;
        insertReach.run(id, node, 1 + (k % 5), "potential");
      }
    }
  })();
  db.close();
}

describe("readChangeSetsTouching on a large cache", () => {
  it(`has a median under ${BUDGET_MS} ms for ${SETS} change sets of ${REACH} reach rows (open included)`, () => {
    seed();
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      const cache = openTeamCache(paths, { readonly: true });
      const found = readChangeSetsTouching(cache, `file:${REPO}:src/shared-${i % 50}.ts`);
      cache?.close();
      times.push(performance.now() - started);
      expect(found).toHaveLength(SETS);
    }
    times.sort((a, b) => a - b);
    const median = ((times[RUNS / 2 - 1] ?? 0) + (times[RUNS / 2] ?? 0)) / 2;
    expect(median).toBeLessThan(BUDGET_MS);
  });
});

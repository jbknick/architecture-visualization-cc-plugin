import { type GantryPaths, type Group, openTeamCache } from "@gantry/core";

/**
 * For tests: writes a team cache (`team-cache.db` in the data directory) holding `groups`, as a pull would leave it,
 * the groups' JSON in `team_groups` and the repo in `meta`. No server is involved. Not part of any hook.
 */
export function seedTeamCache(paths: GantryPaths, groups: Group[], repo: string = paths.repo): void {
  const cache = openTeamCache(paths);
  try {
    const put = cache.db.prepare("INSERT OR REPLACE INTO team_groups(id, name, spec) VALUES (?, ?, ?)");
    for (const g of groups) put.run(g.id, g.name, JSON.stringify(g));
    cache.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('repo', ?), ('pulled_at', ?)")
      .run(repo, new Date().toISOString());
  } finally {
    cache.close();
  }
}

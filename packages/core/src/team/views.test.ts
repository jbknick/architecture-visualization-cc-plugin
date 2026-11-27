import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveGroup, saveView } from "../overlay/repo.js";
import type { Group, SavedView } from "../overlay/types.js";
import { openStore, type Store } from "../store/index.js";
import { openTeamCache, type TeamCache } from "./cache.js";
import { tempPaths } from "./cacheTestkit.js";
import { defaultViewId, mergedGroups, mergedViews } from "./views.js";

const group = (id: string, name = id, mayUse: string[] | null = null): Group => ({
  id,
  name,
  selectors: [{ type: "glob", glob: `src/${id}/**` }],
  mayUse,
});
const view = (id: string, name = id): SavedView => ({
  id,
  name,
  spec: { view: "project", hidden: [], groups: [], filters: {} },
});

let store: Store;
let cache: TeamCache;
let cleanup: () => void;

beforeEach(() => {
  const t = tempPaths();
  cleanup = t.cleanup;
  store = openStore(":memory:");
  cache = openTeamCache(t.paths);
});
afterEach(() => {
  cache.close();
  store.close();
  cleanup();
});

/** Writes rows the way a pull does: `spec` is the JSON of the whole object. */
function putTeam(table: "team_groups" | "team_views", items: { id: string; name: string }[]): void {
  for (const item of items)
    cache.db
      .prepare(`INSERT OR REPLACE INTO ${table}(id, name, spec) VALUES (?, ?, ?)`)
      .run(item.id, item.name, JSON.stringify(item));
}
const putSetting = (key: string, value: string): void => {
  cache.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(key, value);
};

describe("mergedGroups", () => {
  it("returns the team groups and the local ones, marked by origin, sorted by id", () => {
    saveGroup(store, group("orders"));
    saveGroup(store, group("alpha"));
    putTeam("team_groups", [group("payments"), group("catalog")]);
    expect(mergedGroups(store, cache).map((g) => [g.id, g.origin, g.shadowed])).toEqual([
      ["alpha", "local", undefined],
      ["catalog", "team", undefined],
      ["orders", "local", undefined],
      ["payments", "team", undefined],
    ]);
  });

  it("lets a team group shadow the local one with its id, which stays readable and marked", () => {
    saveGroup(store, group("payments", "Local payments", ["orders"]));
    putTeam("team_groups", [group("payments", "Team payments")]);
    const merged = mergedGroups(store, cache);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: "payments", name: "Team payments", origin: "team" });
    expect(merged[0]).not.toHaveProperty("shadowed");
    expect(merged[1]).toMatchObject({
      id: "payments",
      name: "Local payments",
      mayUse: ["orders"],
      origin: "local",
      shadowed: true,
    });
  });

  it("skips a cache row that does not parse with GroupSchema", () => {
    putTeam("team_groups", [group("good")]);
    cache.db
      .prepare("INSERT INTO team_groups(id, name, spec) VALUES (?, ?, ?)")
      .run("bad", "bad", "{not json");
    cache.db
      .prepare("INSERT INTO team_groups(id, name, spec) VALUES (?, ?, ?)")
      .run("odd", "odd", JSON.stringify({ id: "odd", name: "odd", selectors: [], extra: 1 }));
    expect(mergedGroups(store, cache).map((g) => g.id)).toEqual(["good"]);
  });

  it("is the local groups alone with no cache, and does not return the computed default groups", () => {
    saveGroup(store, group("orders"));
    expect(mergedGroups(store, undefined)).toEqual([{ ...group("orders"), origin: "local" }]);
  });

  it("gives the same answer however the rows were inserted", () => {
    const ids = ["m", "c", "x", "a", "q"];
    const orders = [ids, [...ids].reverse(), ["x", "a", "m", "q", "c"]];
    const results = orders.map((order) => {
      const s = openStore(":memory:");
      const t = tempPaths();
      const c = openTeamCache(t.paths);
      try {
        for (const id of order) saveGroup(s, group(id, `local ${id}`));
        for (const id of [...order].reverse().filter((i) => i !== "q")) {
          c.db
            .prepare("INSERT INTO team_groups(id, name, spec) VALUES (?, ?, ?)")
            .run(id, id, JSON.stringify(group(id, `team ${id}`)));
        }
        return JSON.stringify(mergedGroups(s, c));
      } finally {
        c.close();
        s.close();
        t.cleanup();
      }
    });
    expect(new Set(results).size).toBe(1);
  });
});

describe("mergedViews", () => {
  it("merges with the same rule, using SavedViewSchema", () => {
    saveView(store, view("release-risk", "Local risk"));
    saveView(store, view("mine"));
    putTeam("team_views", [view("release-risk", "Team risk"), view("overview")]);
    cache.db
      .prepare("INSERT INTO team_views(id, name, spec) VALUES (?, ?, ?)")
      .run("broken", "broken", JSON.stringify({ id: "broken", name: "broken", spec: { view: 3 } }));
    expect(mergedViews(store, cache).map((v) => [v.id, v.name, v.origin, v.shadowed])).toEqual([
      ["mine", "mine", "local", undefined],
      ["overview", "overview", "team", undefined],
      ["release-risk", "Team risk", "team", undefined],
      ["release-risk", "Local risk", "local", true],
    ]);
  });
});

describe("defaultViewId", () => {
  it("is the settings.default_view id when a cached view has it", () => {
    putTeam("team_views", [view("overview"), view("release-risk")]);
    putSetting("default_view", "release-risk");
    expect(defaultViewId(cache)).toBe("release-risk");
  });

  it("is undefined when the id names no cached view, when none is set, and with no cache", () => {
    putTeam("team_views", [view("overview")]);
    expect(defaultViewId(cache)).toBeUndefined();
    putSetting("default_view", "gone");
    expect(defaultViewId(cache)).toBeUndefined();
    expect(defaultViewId(undefined)).toBeUndefined();
  });

  it("does not count a cached view that fails SavedViewSchema", () => {
    cache.db
      .prepare("INSERT INTO team_views(id, name, spec) VALUES (?, ?, ?)")
      .run("overview", "overview", JSON.stringify({ id: "overview" }));
    putSetting("default_view", "overview");
    expect(defaultViewId(cache)).toBeUndefined();
  });
});

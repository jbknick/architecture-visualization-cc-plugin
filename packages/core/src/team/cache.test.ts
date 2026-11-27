import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GantryPaths } from "../paths/index.js";
import {
  cacheAgeSeconds,
  openTeamCache,
  pullTeamCache,
  readCacheSummary,
  readChangeSets,
  readChangeSetsTouching,
  readTeamGroups,
  readTeamViews,
  TEAM_CACHE_VERSION,
  teamCachePath,
} from "./cache.js";
import { TEAM_CACHE_SCHEMA } from "./cacheSchema.js";
import { changeSet, configFor, envFor, REPO, recorder, tempPaths, USER_TOKEN } from "./cacheTestkit.js";
import { resetTeamProtocolCache } from "./client.js";

let fake: FakeServer;
let tmp: ReturnType<typeof tempPaths>;
let paths: GantryPaths;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = tempPaths();
  paths = tmp.paths;
  env = envFor(tmp.dir);
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
  tmp.cleanup();
});

const seed = (...sets: ReturnType<typeof changeSet>[]) => {
  for (const cs of sets) fake.state.changeSets.set(cs.id, cs);
};
const pull = (opts: Parameters<typeof pullTeamCache>[2] = {}) =>
  pullTeamCache(paths, configFor(fake.url), { env, ...opts });
const rows = (table: string): unknown[] => {
  const db = new Database(teamCachePath(paths), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
  } finally {
    db.close();
  }
};
const metaOf = (key: string): string | undefined => {
  const cache = openTeamCache(paths, { readonly: true });
  try {
    return (
      cache?.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
    )?.value;
  } finally {
    cache?.close();
  }
};
const failingFetch =
  (status: number): typeof fetch =>
  async (input, init) => {
    if (String(input).includes("/v1/pull"))
      return new Response(JSON.stringify({ error: "invalid", message: "boom" }), { status });
    return fetch(input, init);
  };

describe("schema", () => {
  it("the DDL in cacheSchema.ts is the text of cache.sql", () => {
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cache.sql"), "utf8");
    expect(TEAM_CACHE_SCHEMA).toBe(sql);
  });
});

describe("first pull", () => {
  it("fills every table and the meta keys", async () => {
    seed(changeSet(1), changeSet(2));
    fake.state.views.set(
      REPO,
      new Map([
        [
          "api-only",
          {
            id: "api-only",
            name: "API only",
            spec: { view: "api-only", level: "files", hidden: [], groups: [], filters: {} },
          },
        ],
      ]),
    );
    fake.state.groups.set(
      REPO,
      new Map([
        [
          "web",
          { id: "web", name: "Web", selectors: [{ type: "workspace", workspace: "ws:x" }], mayUse: null },
        ],
      ]),
    );
    expect(await pull()).toEqual({ status: "updated", change_sets: 2 });

    expect(rows("change_sets")).toHaveLength(2);
    expect(rows("change_set_nodes")).toHaveLength(4);
    expect(rows("change_set_reach")).toHaveLength(4);
    expect(rows("team_views")).toHaveLength(1);
    expect(rows("team_groups")).toHaveLength(1);
    expect(rows("inflight")).toEqual([]);
    expect(metaOf("server")).toBe(fake.url);
    expect(metaOf("org")).toBe("acme");
    expect(metaOf("repo")).toBe(REPO);
    expect(metaOf("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(metaOf("pulled_at")).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(metaOf("last_error")).toBeUndefined();

    const cache = openTeamCache(paths, { readonly: true });
    expect(readChangeSets(cache).map((c) => c.id)).toEqual([changeSet(2).id, changeSet(1).id]);
    expect(readChangeSets(cache)[1]).toEqual({
      id: changeSet(1).id,
      repo: REPO,
      source: "pr",
      state: "in_review",
      estimated: false,
      owner: "octo-dev",
      title: "Change 1",
      pr: 1,
      ref: "#1",
      head_ref: "feat/change-1",
      base_branch: "main",
      head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
      links: [],
      created_at: "2026-11-20T09:15:00.000Z",
      updated_at: "2026-11-20T09:41:12.000Z",
    });
    expect(readTeamViews(cache).map((v) => v.id)).toEqual(["api-only"]);
    expect(readTeamGroups(cache).map((g) => g.id)).toEqual(["web"]);
    cache?.close();
  });

  it("follows every page of a paged pull", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO, pageSize: 2 });
    seed(changeSet(1), changeSet(2), changeSet(3), changeSet(4), changeSet(5));
    expect(await pull()).toEqual({ status: "updated", change_sets: 5 });
  });

  it("ignores a field it does not know, so a newer server does not break it", async () => {
    seed(changeSet(1));
    const extra: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).includes("/v1/pull") || res.status !== 200) return res;
      const body = (await res.json()) as { change_sets: Record<string, unknown>[] };
      body.change_sets = body.change_sets.map((c) => ({ ...c, new_field: { a: 1 } }));
      return new Response(JSON.stringify({ ...body, new_top: true }), { status: 200, headers: res.headers });
    };
    expect((await pull({ fetch: extra })).status).toBe("updated");
    expect(rows("change_sets")).toHaveLength(1);
  });
});

describe("later pulls", () => {
  it("answers unchanged with one pull request carrying If-None-Match", async () => {
    seed(changeSet(1), changeSet(2));
    await pull();
    const etag = metaOf("etag");
    const first = metaOf("pulled_at");
    const rec = recorder();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await pull({ fetch: rec.fetch })).toEqual({ status: "unchanged", change_sets: 2 });
    const pulls = rec.calls.filter((c) => c.url.includes("/v1/pull"));
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.headers["If-None-Match"]).toBe(etag);
    expect(metaOf("etag")).toBe(etag);
    expect(metaOf("pulled_at")).not.toBe(first);
    expect(rows("change_sets")).toHaveLength(2);
  });

  it("replaces the rows of a changed change set and drops a closed one", async () => {
    seed(changeSet(1), changeSet(2));
    await pull();
    seed(
      changeSet(1, {
        title: "Retitled",
        nodes: [`file:${REPO}:src/only.ts`],
        radius: [],
        updated_at: "2026-11-21T10:00:00.000Z",
      }),
    );
    fake.state.changeSets.delete(changeSet(2).id);
    expect(await pull()).toEqual({ status: "updated", change_sets: 1 });
    expect(rows("change_sets")).toMatchObject([{ id: changeSet(1).id, title: "Retitled" }]);
    expect(rows("change_set_nodes")).toEqual([
      { change_set_id: changeSet(1).id, node_id: `file:${REPO}:src/only.ts` },
    ]);
    expect(rows("change_set_reach")).toEqual([]);
  });

  it("keeps the old rows and records last_error when the server errors", async () => {
    seed(changeSet(1), changeSet(2));
    await pull();
    const before = { sets: rows("change_sets"), etag: metaOf("etag"), at: metaOf("pulled_at") };
    const result = await pull({ fetch: failingFetch(500) });
    expect(result.status).toBe("failed");
    expect(result.change_sets).toBe(2);
    expect(result.error).toContain("boom");
    expect(rows("change_sets")).toEqual(before.sets);
    expect(metaOf("etag")).toBe(before.etag);
    expect(metaOf("pulled_at")).toBe(before.at);
    expect(metaOf("last_error")).toContain("boom");
    expect(readCacheSummary(openTeamCache(paths, { readonly: true })).last_error).toContain("boom");

    // the next good pull clears it
    expect((await pull()).status).toBe("unchanged");
    expect(metaOf("last_error")).toBeUndefined();
  });

  it("keeps the old rows when the server is gone", async () => {
    seed(changeSet(1));
    await pull();
    const url = fake.url;
    await fake.close();
    const result = await pullTeamCache(paths, configFor(url), { env, timeoutMs: 1000 });
    expect(result.status).toBe("failed");
    expect(result.change_sets).toBe(1);
    expect(metaOf("last_error")).toContain("team_unreachable");
    expect(rows("change_sets")).toHaveLength(1);
    fake = await startFakeServer();
  });

  it("records last_error even when there was no cache yet", async () => {
    const result = await pull({ fetch: failingFetch(500) });
    expect(result).toMatchObject({ status: "failed", change_sets: 0 });
    expect(readCacheSummary(openTeamCache(paths, { readonly: true }))).toMatchObject({
      change_sets: 0,
      pulled_at: null,
      age_s: null,
    });
    expect(metaOf("last_error")).toContain("boom");
  });

  it("gives up after timeoutMs for the whole pull and keeps the cache", async () => {
    await fake.close();
    fake = await startFakeServer({ tokens: [USER_TOKEN], repo: REPO, pullDelayMs: 600 });
    seed(changeSet(1));
    expect((await pull({ timeoutMs: 3000 })).status).toBe("updated");
    seed(changeSet(1, { title: "Newer", updated_at: "2026-11-22T10:00:00.000Z" }));
    const started = Date.now();
    const result = await pull({ timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("team_unreachable");
    expect(rows("change_sets")).toMatchObject([{ title: "Change 1" }]);
  });
});

describe("the file's identity", () => {
  it("is recreated when it has another version", async () => {
    seed(changeSet(1));
    await pull();
    const db = new Database(teamCachePath(paths));
    db.pragma(`user_version = ${TEAM_CACHE_VERSION + 1}`);
    db.close();
    expect(openTeamCache(paths, { readonly: true })).toBeUndefined();
    fake.state.changeSets.clear();
    seed(changeSet(2));
    expect(await pull()).toEqual({ status: "updated", change_sets: 1 });
    expect(rows("change_sets")).toMatchObject([{ id: changeSet(2).id }]);
    const reopened = openTeamCache(paths, { readonly: true });
    expect(reopened?.db.pragma("user_version", { simple: true })).toBe(TEAM_CACHE_VERSION);
    reopened?.close();
  });

  it("is recreated when it is not a database", async () => {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(
      teamCachePath(paths),
      "this is not sqlite, it is just text that is long enough to look odd",
    );
    seed(changeSet(1));
    expect((await pull()).status).toBe("updated");
  });

  for (const key of ["server", "org", "repo"]) {
    it(`is recreated before pulling when its ${key} differs`, async () => {
      seed(changeSet(1), changeSet(2));
      await pull();
      const db = new Database(teamCachePath(paths));
      db.prepare("UPDATE meta SET value = 'someone-else' WHERE key = ?").run(key);
      db.close();
      // the other team's rows are gone even though this pull fails
      const result = await pull({ fetch: failingFetch(500) });
      expect(result).toMatchObject({ status: "failed", change_sets: 0 });
      expect(rows("change_sets")).toEqual([]);
      expect(metaOf(key)).not.toBe("someone-else");
      expect((await pull()).status).toBe("updated");
      expect(rows("change_sets")).toHaveLength(2);
    });
  }
});

describe("skipped", () => {
  it("with no team block", async () => {
    expect(await pullTeamCache(paths, {} as never, { env })).toEqual({ status: "skipped", change_sets: 0 });
    expect(fs.existsSync(teamCachePath(paths))).toBe(false);
  });

  it("with no token", async () => {
    const result = await pullTeamCache(paths, configFor(fake.url), {
      env: { GANTRY_CREDENTIALS_FILE: path.join(tmp.dir, "none.json") },
    });
    expect(result).toEqual({ status: "skipped", change_sets: 0 });
    expect(fs.existsSync(teamCachePath(paths))).toBe(false);
  });
});

describe("a CI token", () => {
  it("pulls without an organisation", async () => {
    seed(changeSet(1));
    const config = { team: { server: fake.url, upload: { descriptions: true, working: false } } } as never;
    const result = await pullTeamCache(paths, config, { env: { GANTRY_TOKEN: "gct_fake" } });
    expect(result).toEqual({ status: "updated", change_sets: 1 });
    expect(metaOf("org")).toBe("");
  });
});

describe("readers", () => {
  it("return empty results when the file does not exist", () => {
    const cache = openTeamCache(paths, { readonly: true });
    expect(cache).toBeUndefined();
    expect(readChangeSets(cache)).toEqual([]);
    expect(readChangeSetsTouching(cache, "x")).toEqual([]);
    expect(readTeamGroups(cache)).toEqual([]);
    expect(readTeamViews(cache)).toEqual([]);
    expect(cacheAgeSeconds(cache)).toBeUndefined();
    expect(readCacheSummary(cache)).toEqual({
      change_sets: 0,
      pulled_at: null,
      age_s: null,
      last_error: null,
    });
    expect(fs.existsSync(paths.dataDir)).toBe(false);
  });

  it("find the change sets that change or reach a node", async () => {
    seed(changeSet(1), changeSet(2));
    await pull();
    const cache = openTeamCache(paths, { readonly: true });
    expect(readChangeSetsTouching(cache, `file:${REPO}:src/a1.ts`).map((c) => [c.id, c.touch])).toEqual([
      [changeSet(1).id, { kind: "changed" }],
    ]);
    expect(readChangeSetsTouching(cache, `file:${REPO}:src/far2.ts`)).toMatchObject([
      { id: changeSet(2).id, touch: { kind: "reach", hop: 4, tier: "reachable", via_hub: true } },
    ]);
    // reached by both: the shared helper is hop 1 of each
    expect(readChangeSetsTouching(cache, `sym:${REPO}:src/shared.ts#helper`).map((c) => c.id)).toEqual([
      changeSet(2).id,
      changeSet(1).id,
    ]);
    expect(readChangeSetsTouching(cache, "nothing")).toEqual([]);
    cache?.close();
  });

  it("skip a group or view row that does not parse", async () => {
    await pull();
    const db = new Database(teamCachePath(paths));
    db.prepare("INSERT INTO team_groups(id, name, spec) VALUES ('bad', 'Bad', '{\"id\":\"bad\"}')").run();
    db.prepare("INSERT INTO team_groups(id, name, spec) VALUES ('worse', 'Worse', 'not json')").run();
    db.prepare("INSERT INTO team_views(id, name, spec) VALUES ('bad', 'Bad', '[]')").run();
    db.close();
    const cache = openTeamCache(paths, { readonly: true });
    expect(readTeamGroups(cache)).toEqual([]);
    expect(readTeamViews(cache)).toEqual([]);
    cache?.close();
  });

  it("report the age from the last pull", async () => {
    await pull({ now: () => Date.parse("2026-11-25T14:00:00.000Z") });
    const cache = openTeamCache(paths, { readonly: true });
    expect(cacheAgeSeconds(cache, Date.parse("2026-11-25T14:02:06.000Z"))).toBe(126);
    expect(readCacheSummary(cache, Date.parse("2026-11-25T14:02:06.000Z"))).toEqual({
      change_sets: 0,
      pulled_at: "2026-11-25T14:00:00.000Z",
      age_s: 126,
      last_error: null,
    });
    cache?.close();
  });
});

describe("schema of the file", () => {
  it("has every table the contract names", async () => {
    await pull();
    const names = (rows("sqlite_master") as { type: string; name: string }[])
      .filter((r) => r.type === "table")
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(
      [
        "change_set_nodes",
        "change_set_reach",
        "change_sets",
        "inflight",
        "meta",
        "settings",
        "team_groups",
        "team_views",
      ].sort(),
    );
  });
});

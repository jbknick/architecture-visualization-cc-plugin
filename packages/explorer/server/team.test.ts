import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GantryConfig,
  type GantryPaths,
  openTeamCache,
  type Store,
  seedTeamCache,
  teamCachePath,
} from "@gantry/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ExplorerServer, startExplorerServer } from "./index.js";
import { TEAM_NODES_CAP, TEAM_RADIUS_CAP, teamLayer } from "./team.js";
import { fixtureStore } from "./testkit.js";
import type { ApiContext, TeamLayerResponse } from "./types.js";

const REPO = "fixture/pnpm-turbo";
const SET_FILE = join(import.meta.dirname, "../../../fixtures/team-changesets/change-sets.json");
const SLUG = `sym:${REPO}:packages/utils/src/slug.ts#slugify`;
const WS_UTILS = `ws:${REPO}:@acme/utils`;
const WS_DB = `ws:${REPO}:@acme/db`;

let dir: string;
let store: Store;
let fixtureDir: string;
let paths: GantryPaths;

const ctx = (): ApiContext => ({ store, paths, config: {} as GantryConfig });
const dbFile = () => teamCachePath(paths);
const seed = () => seedTeamCache(dbFile(), SET_FILE);
/** Runs `body` against the seeded cache, opened for writing. */
const withCache = (body: (db: ReturnType<typeof openTeamCache>["db"]) => void) => {
  const cache = openTeamCache(paths);
  try {
    body(cache.db);
  } finally {
    cache.close();
  }
};
const edit = (sql: string, ...args: unknown[]) => withCache((db) => void db.prepare(sql).run(...args));

beforeAll(() => {
  const f = fixtureStore("pnpm-turbo", REPO);
  store = f.store;
  fixtureDir = f.dir;
  dir = mkdtempSync(join(tmpdir(), "gantry-team-layer-"));
  paths = {
    root: dir,
    dataDir: join(dir, "data"),
    dbPath: join(fixtureDir, "gantry.db"),
    repo: REPO,
  } as GantryPaths;
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/team/layer", () => {
  it("has the shape of the contract, change sets sorted by id, people sorted and unique", () => {
    seed();
    const r = teamLayer(ctx());
    expect(r.available).toBe(true);
    expect(typeof r.age_s).toBe("number");
    expect(r.change_sets.map((c) => c.id)).toEqual([
      `cs:pr:${REPO}#138`,
      `cs:pr:${REPO}#142`,
      `cs:pr:${REPO}#145`,
    ]);
    expect(r.people).toEqual(["ana", "sam"]);
    const first = r.change_sets[0];
    expect(first).toMatchObject({
      source: "pr",
      state: "in_review",
      owner: "ana",
      pr: 138,
      title: "Cache slugs between calls",
      nodes: [`file:${REPO}:packages/utils/src/slug.ts`, SLUG],
      nodes_total: 2,
      radius_total: 1,
      map_nodes: [WS_UTILS],
    });
    expect(first?.radius[0]).toEqual({
      id: `sym:${REPO}:packages/utils/src/slug.ts#SLUG_VERSION`,
      hop: 1,
      tier: "direct",
      via_hub: false,
    });
    expect(r.change_sets[2]?.map_nodes).toEqual([WS_DB]);
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        "direct_uses",
        "id",
        "map_nodes",
        "nodes",
        "nodes_total",
        "owner",
        "pr",
        "radius",
        "radius_total",
        "source",
        "state",
        "title",
      ].sort(),
    );
  });

  it("orders the radius by hop, lowest first", () => {
    seed();
    const radius = teamLayer(ctx()).change_sets[2]?.radius ?? [];
    expect(radius.length).toBeGreaterThan(3);
    const hops = radius.map((x) => x.hop);
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
  });

  it("cuts nodes at 200 and radius at 500 and keeps the totals", () => {
    seed();
    const id = `cs:pr:${REPO}#145`;
    withCache((db) => {
      const node = db.prepare("INSERT INTO change_set_nodes(change_set_id, node_id) VALUES (?, ?)");
      const reach = db.prepare(
        "INSERT INTO change_set_reach(change_set_id, node_id, hop, tier, via_hub) VALUES (?, ?, ?, 'reachable', 0)",
      );
      db.transaction(() => {
        for (let i = 0; i < 250; i++) node.run(id, `sym:${REPO}:packages/utils/src/gen${i}.ts#f${i}`);
        for (let i = 0; i < 600; i++) reach.run(id, `sym:${REPO}:apps/web/src/gen${i}.ts#g${i}`, 5 + (i % 3));
      })();
    });
    const cs = teamLayer(ctx()).change_sets[2];
    expect(cs?.nodes.length).toBe(TEAM_NODES_CAP);
    expect(cs?.radius.length).toBe(TEAM_RADIUS_CAP);
    expect(cs?.nodes_total).toBe(252);
    expect(cs?.radius_total).toBe(610);
    // lowest hop first: the cut drops the farthest entries, so the kept ones are sorted by hop
    const hops = cs?.radius.map((x) => x.hop) ?? [];
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
    expect(hops[0]).toBe(1);
  });

  it("counts a node the local index does not know in nodes_total and leaves it out of map_nodes", () => {
    seed();
    const id = `cs:pr:${REPO}#138`;
    edit(
      "INSERT INTO change_set_nodes(change_set_id, node_id) VALUES (?, ?)",
      id,
      `sym:${REPO}:gone/nowhere.ts#ghost`,
    );
    const cs = teamLayer(ctx()).change_sets[0];
    expect(cs?.nodes_total).toBe(3);
    expect(cs?.nodes).toContain(`sym:${REPO}:gone/nowhere.ts#ghost`);
    expect(cs?.map_nodes).toEqual([WS_UTILS]);
  });

  it("names the changed nodes each direct entry uses, by the local graph, and nothing else", () => {
    seed();
    const sets = teamLayer(ctx()).change_sets;
    expect(sets[0]?.direct_uses).toEqual([
      { id: `sym:${REPO}:packages/utils/src/slug.ts#SLUG_VERSION`, changed: [SLUG] },
    ]);
    // listPosts is used by the router symbol; the db barrel file imports its file.
    expect(sets[2]?.direct_uses).toEqual([
      {
        id: `file:${REPO}:packages/db/src/index.ts`,
        changed: [
          `file:${REPO}:packages/db/src/queries.ts`,
          `sym:${REPO}:packages/db/src/queries.ts#listPosts`,
        ],
      },
      {
        id: `sym:${REPO}:apps/api/src/router.ts#router`,
        changed: [`sym:${REPO}:packages/db/src/queries.ts#listPosts`],
      },
    ]);
  });

  it("leaves out a direct entry the local index has no edge to a changed node for", () => {
    seed();
    const id = `cs:pr:${REPO}#138`;
    const reach = (node: string, hop: number, tier: string) =>
      edit(
        "INSERT INTO change_set_reach(change_set_id, node_id, hop, tier, via_hub) VALUES (?, ?, ?, ?, 0)",
        id,
        node,
        hop,
        tier,
      );
    // One entry the index knows but that does not use slugify, and one the index does not know at all.
    reach(`sym:${REPO}:packages/utils/src/date.ts#formatRelativeDate`, 1, "direct");
    reach(`sym:${REPO}:gone/nowhere.ts#ghost`, 1, "direct");
    const uses = teamLayer(ctx()).change_sets[0]?.direct_uses;
    expect(uses?.map((u) => u.id)).toEqual([`sym:${REPO}:packages/utils/src/slug.ts#SLUG_VERSION`]);
  });

  it("has no uses when the change set's own nodes are unknown to the index", () => {
    seed();
    const id = `cs:pr:${REPO}#142`;
    edit("DELETE FROM change_set_nodes WHERE change_set_id = ?", id);
    edit(
      "INSERT INTO change_set_nodes(change_set_id, node_id) VALUES (?, ?)",
      id,
      `sym:${REPO}:gone/nowhere.ts#ghost`,
    );
    expect(teamLayer(ctx()).change_sets[1]?.direct_uses).toEqual([]);
  });

  it("is unavailable, with empty lists, when the cache file is absent", () => {
    rmSync(dbFile(), { force: true });
    rmSync(`${dbFile()}-wal`, { force: true });
    rmSync(`${dbFile()}-shm`, { force: true });
    expect(teamLayer(ctx())).toEqual({ available: false, age_s: null, change_sets: [], people: [] });
  });

  it("is unavailable when the cache was pulled for another repo", () => {
    seed();
    edit("UPDATE meta SET value = 'someone/else' WHERE key = 'repo'");
    expect(teamLayer(ctx())).toEqual({ available: false, age_s: null, change_sets: [], people: [] });
  });

  it("makes no outbound request", () => {
    seed();
    const stub = vi.fn(() => {
      throw new Error("the Team layer handler must not call fetch");
    });
    vi.stubGlobal("fetch", stub);
    expect(teamLayer(ctx()).available).toBe(true);
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("the route", () => {
  let srv: ExplorerServer;
  beforeAll(async () => {
    seed();
    srv = await startExplorerServer({ paths, store, config: {} as GantryConfig, writeStateFile: false });
  });
  afterAll(async () => {
    await srv.close();
  });
  it("answers JSON for the token holder and 404 for other team paths", async () => {
    const get = (p: string) =>
      fetch(`http://127.0.0.1:${srv.port}${p}`, { headers: { "x-gantry-token": srv.token } });
    const ok = await get("/api/team/layer");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as TeamLayerResponse;
    expect(body.people).toEqual(["ana", "sam"]);
    expect((await get("/api/team/other")).status).toBe(404);
    expect((await get("/api/team")).status).toBe(404);
  });
});

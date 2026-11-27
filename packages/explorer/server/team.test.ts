import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteGroup,
  deleteView,
  type GantryConfig,
  type GantryPaths,
  type Group,
  openTeamCache,
  readOverlay,
  type SavedView,
  type Store,
  saveGroup,
  saveView,
  seedTeamCache,
  teamCachePath,
} from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./errors.js";
import { type ExplorerServer, startExplorerServer } from "./index.js";
import { TEAM_NODES_CAP, TEAM_RADIUS_CAP, teamLayer, teamOverlay, teamPublish, teamViews } from "./team.js";
import { fixtureStore } from "./testkit.js";
import type { ApiContext, TeamLayerResponse, TeamViewsResponse } from "./types.js";

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

// ---- shared views and groups: `GET /api/team/views` and the four publish routes

const view = (id: string, name: string): SavedView => ({
  id,
  name,
  spec: { view: "project-map", level: "files", hidden: [], groups: [], filters: {} },
});
const group = (id: string, name: string): Group => ({
  id,
  name,
  selectors: [{ type: "glob", glob: `src/${id}/**` }],
  mayUse: null,
});

describe("views and groups", () => {
  let vStore: Store;
  let vDir: string;
  let vFixture: string;
  let vPaths: GantryPaths;
  const vctx = (config: GantryConfig = {} as GantryConfig): ApiContext => ({
    store: vStore,
    paths: vPaths,
    config,
  });
  /** The cache of the contract: three team views (one the default), two team groups, pulled 12 minutes ago. */
  const seedViews = (opts: { defaultView?: string | null } = {}) => {
    seedTeamCache(teamCachePath(vPaths), SET_FILE);
    const cache = openTeamCache(vPaths);
    try {
      const put = (table: "team_views" | "team_groups", item: { id: string; name: string }) =>
        cache.db
          .prepare(`INSERT OR REPLACE INTO ${table}(id, name, spec) VALUES (?, ?, ?)`)
          .run(item.id, item.name, JSON.stringify(item));
      for (const v of [
        view("release-risk", "Release risk"),
        view("owners", "Owners"),
        view("shared-core", "Shared core"),
      ])
        put("team_views", v);
      for (const g of [group("orders", "Orders"), group("catalog", "Catalog")]) put("team_groups", g);
      const def = opts.defaultView === undefined ? "release-risk" : opts.defaultView;
      if (def !== null)
        cache.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('default_view', ?)").run(def);
      const at = new Date(Date.now() - 12 * 60_000).toISOString();
      cache.db.prepare("UPDATE meta SET value = ? WHERE key = 'pulled_at'").run(at);
    } finally {
      cache.close();
    }
  };
  const clearCache = () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${teamCachePath(vPaths)}${suffix}`, { force: true });
  };

  beforeAll(() => {
    const f = fixtureStore("overlay-groups", "fixture/pnpm-turbo");
    vStore = f.store;
    vFixture = f.dir;
    vDir = mkdtempSync(join(tmpdir(), "gantry-team-views-"));
    vPaths = {
      root: vDir,
      dataDir: join(vDir, "data"),
      dbPath: join(vFixture, "gantry.db"),
      repo: REPO,
    } as GantryPaths;
  });
  afterAll(() => {
    vStore.close();
    rmSync(vDir, { recursive: true, force: true });
    rmSync(vFixture, { recursive: true, force: true });
  });
  beforeEach(() => {
    clearCache();
    for (const v of readOverlay(vStore).views) deleteView(vStore, v.id);
    for (const g of readOverlay(vStore).groups) deleteGroup(vStore, g.id);
  });

  describe("GET /api/team/views", () => {
    it("returns the merged views and groups, the default and the age", () => {
      saveView(vStore, view("my-sketch", "My sketch"));
      saveGroup(vStore, group("payments", "Payments"));
      seedViews();
      const r = teamViews(vctx());
      expect(r.available).toBe(true);
      expect(r.age_s).toBeGreaterThanOrEqual(12 * 60);
      expect(r.age_s).toBeLessThan(13 * 60);
      expect(r.default_view).toBe("release-risk");
      expect(r.views.map((v) => [v.id, v.origin])).toEqual([
        ["my-sketch", "local"],
        ["owners", "team"],
        ["release-risk", "team"],
        ["shared-core", "team"],
      ]);
      expect(r.groups.map((g) => [g.id, g.origin])).toEqual([
        ["catalog", "team"],
        ["orders", "team"],
        ["payments", "local"],
      ]);
    });

    it("marks a local group with a team group's id as shadowed, and keeps it", () => {
      saveGroup(vStore, group("orders", "My orders"));
      seedViews();
      const orders = teamViews(vctx()).groups.filter((g) => g.id === "orders");
      expect(orders.map((g) => [g.origin, g.name, g.shadowed])).toEqual([
        ["team", "Orders", undefined],
        ["local", "My orders", true],
      ]);
      expect(readOverlay(vStore).groups.map((g) => g.id)).toContain("orders");
    });

    it("marks a view or group of yours as published when the team holds an equal copy, and that copy as your own", () => {
      saveView(vStore, view("release-risk", "Release risk"));
      saveGroup(vStore, group("orders", "Orders"));
      seedViews();
      const r = teamViews(vctx());
      const flags = (
        items: { id: string; origin: string; published?: true; own?: true; shadowed?: true }[],
        id: string,
      ) => items.filter((i) => i.id === id).map((i) => [i.origin, i.published, i.own, i.shadowed]);
      expect(flags(r.views, "release-risk")).toEqual([
        ["team", undefined, true, undefined],
        ["local", true, undefined, true],
      ]);
      expect(flags(r.groups, "orders")).toEqual([
        ["team", undefined, true, undefined],
        ["local", true, undefined, true],
      ]);
      // Teammates' items and items nobody published carry no marker.
      expect(flags(r.views, "owners")).toEqual([["team", undefined, undefined, undefined]]);
    });

    it("does not call a local item published when the team's item with its id has other content", () => {
      saveView(vStore, { ...view("release-risk", "Release risk"), name: "My release risk" });
      saveGroup(vStore, group("orders", "My orders"));
      seedViews();
      const r = teamViews(vctx());
      for (const items of [r.views, r.groups])
        for (const i of items.filter((x) => x.id === "release-risk" || x.id === "orders")) {
          expect(i.published).toBeUndefined();
          expect(i.own).toBeUndefined();
        }
      expect(r.views.find((v) => v.origin === "local" && v.id === "release-risk")?.shadowed).toBe(true);
    });

    it("keeps the last pick in a file of the data directory, so a new server on another port still has it", async () => {
      seedViews();
      const open = async (token?: string) => {
        const srv = await startExplorerServer({
          paths: vPaths,
          store: vStore,
          config: {} as GantryConfig,
          writeStateFile: false,
        });
        const get = async () =>
          (
            (await (
              await fetch(`http://127.0.0.1:${srv.port}/api/team/views`, {
                headers: { "x-gantry-token": srv.token },
              })
            ).json()) as TeamViewsResponse
          ).last_view;
        const put = (id: unknown) =>
          fetch(`http://127.0.0.1:${srv.port}/api/team/last-view`, {
            method: "PUT",
            headers: { "x-gantry-token": token ?? srv.token, "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
        return { srv, get, put };
      };
      const first = await open();
      expect(await first.get()).toBeNull();
      expect((await first.put("owners")).status).toBe(200);
      expect(await first.get()).toBe("owners");
      expect((await first.put("../etc")).status).toBe(400);
      expect((await first.put(7)).status).toBe(400);
      expect((await first.put("owners")).status).toBe(200);
      const firstPort = first.srv.port;
      await first.srv.close();
      const second = await open();
      try {
        expect(second.srv.port).not.toBe(firstPort);
        expect(await second.get()).toBe("owners");
      } finally {
        await second.srv.close();
      }
      rmSync(join(vPaths.dataDir, "last-view.json"), { force: true });
    });

    it("refuses PUT /api/team/last-view without the token, with a wrong one, from a foreign Origin or with a foreign Host", async () => {
      seedViews();
      const srv = await startExplorerServer({
        paths: vPaths,
        store: vStore,
        config: {} as GantryConfig,
        writeStateFile: false,
      });
      const file = join(vPaths.dataDir, "last-view.json");
      rmSync(file, { force: true });
      const put = (headers: Record<string, string>) =>
        new Promise<{ status: number; body: string }>((ok, fail) => {
          const body = JSON.stringify({ id: "owners" });
          const req = request(
            {
              host: "127.0.0.1",
              port: srv.port,
              path: "/api/team/last-view",
              method: "PUT",
              headers: {
                host: `127.0.0.1:${srv.port}`,
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
                ...headers,
              },
            },
            (res) => {
              let out = "";
              res.on("data", (c: Buffer) => {
                out += c.toString();
              });
              res.on("end", () => ok({ status: res.statusCode ?? 0, body: out }));
            },
          );
          req.on("error", fail);
          req.end(body);
        });
      try {
        expect((await put({})).status).toBe(403);
        expect((await put({ "x-gantry-token": "not-the-token" })).status).toBe(403);
        const origin = await put({ "x-gantry-token": srv.token, origin: "http://evil.example" });
        expect(origin.status).toBe(403);
        expect(origin.body).toContain("Bad Origin");
        const host = await put({ "x-gantry-token": srv.token, host: "evil.example" });
        expect(host.status).toBe(403);
        expect(host.body).toContain("Bad Host");
        expect(existsSync(file)).toBe(false);
        // The right token, from the explorer's own origin, is accepted.
        expect(
          (await put({ "x-gantry-token": srv.token, origin: `http://127.0.0.1:${srv.port}` })).status,
        ).toBe(200);
        expect(existsSync(file)).toBe(true);
      } finally {
        await srv.close();
        rmSync(file, { force: true });
      }
    });

    it("has no default_view when the named view is not in the cache, or none is named", () => {
      seedViews({ defaultView: "gone" });
      expect(teamViews(vctx()).default_view).toBeNull();
      clearCache();
      seedViews({ defaultView: null });
      expect(teamViews(vctx())).toMatchObject({ available: true, default_view: null });
    });

    it("is unavailable, with empty lists, without a cache or with one pulled for another repo", () => {
      const none: TeamViewsResponse = {
        available: false,
        age_s: null,
        views: [],
        groups: [],
        default_view: null,
        last_view: null,
      };
      expect(teamViews(vctx())).toEqual(none);
      seedViews();
      const cache = openTeamCache(vPaths);
      cache.db.prepare("UPDATE meta SET value = 'someone/else' WHERE key = 'repo'").run();
      cache.close();
      expect(teamViews(vctx())).toEqual(none);
    });

    it("makes no outbound request", () => {
      seedViews();
      const stub = vi.fn(() => {
        throw new Error("the views handler must not call fetch");
      });
      vi.stubGlobal("fetch", stub);
      expect(teamViews(vctx()).available).toBe(true);
      expect(stub).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("gives the overlay a view is built with the team's views and groups, the team's group first on a clash", () => {
      saveGroup(vStore, group("orders", "My orders"));
      seedViews();
      const merged = teamOverlay(vctx(), readOverlay(vStore));
      expect(merged.views.map((v) => v.id)).toEqual(["owners", "release-risk", "shared-core"]);
      expect(merged.groups.map((g) => [g.id, g.name])).toEqual([
        ["catalog", "Catalog"],
        ["orders", "Orders"],
      ]);
      expect(merged.groups[0]).not.toHaveProperty("origin");
      clearCache();
      const local = readOverlay(vStore);
      expect(teamOverlay(vctx(), local)).toBe(local);
    });
  });

  describe("the publish routes", () => {
    let fake: FakeServer | undefined;
    let url = "";
    const config = (url: string): GantryConfig =>
      ({
        team: { server: url, org: "acme", upload: { descriptions: true, working: false } },
      }) as unknown as GantryConfig;
    const run = (method: "POST" | "DELETE", kind: "views" | "groups", id: string) =>
      teamPublish(vctx(config(url)), method, `/api/team/${kind}/${encodeURIComponent(id)}/publish`);
    const refused = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      return err as HttpError;
    };
    const start = async (role: "owner" | "admin" | "member") => {
      fake = await startFakeServer({ role, repo: REPO });
      url = fake.url;
      vi.stubEnv("GANTRY_TOKEN", "fake-user");
      vi.stubEnv("GANTRY_CREDENTIALS_FILE", join(vDir, "credentials.json"));
      vi.stubEnv("GANTRY_SERVER", "");
      vi.stubEnv("GANTRY_ORG", "");
    };
    afterEach(async () => {
      vi.unstubAllEnvs();
      await fake?.close();
      fake = undefined;
    });

    it("publishes a local view: the server holds it and the cache shows it as the team's", async () => {
      await start("member");
      saveView(vStore, view("my-sketch", "My sketch"));
      await expect(run("POST", "views", "my-sketch")).resolves.toEqual({ published: true });
      expect(fake?.state.views.get(REPO)?.get("my-sketch")?.name).toBe("My sketch");
      const r = teamViews(vctx(config(url)));
      expect(r.views.map((v) => [v.id, v.origin, v.shadowed])).toEqual([
        ["my-sketch", "team", undefined],
        ["my-sketch", "local", true],
      ]);
    });

    it("publishes a local group, and removes a group and a view the team holds", async () => {
      await start("admin");
      saveGroup(vStore, group("payments", "Payments"));
      await expect(run("POST", "groups", "payments")).resolves.toEqual({ published: true });
      expect(fake?.state.groups.get(REPO)?.has("payments")).toBe(true);
      await expect(run("DELETE", "groups", "payments")).resolves.toEqual({ published: false });
      expect(fake?.state.groups.get(REPO)?.has("payments")).toBe(false);
      saveView(vStore, view("my-sketch", "My sketch"));
      await run("POST", "views", "my-sketch");
      await expect(run("DELETE", "views", "my-sketch")).resolves.toEqual({ published: false });
      expect(fake?.state.views.get(REPO)?.has("my-sketch")).toBe(false);
      expect(teamViews(vctx(config(url))).views.map((v) => v.origin)).toEqual(["local"]);
    });

    it("answers 403 with the server's message when a member removes a group, and the team keeps it", async () => {
      await start("member");
      saveGroup(vStore, group("payments", "Payments"));
      await run("POST", "groups", "payments");
      const err = await refused(run("DELETE", "groups", "payments"));
      expect(err.status).toBe(403);
      expect(err.message).toBe("only an owner or admin may delete a group");
      expect(fake?.state.groups.get(REPO)?.has("payments")).toBe(true);
    });

    it("answers 404 for an id that is not a local view or group, and for a team item that is not there", async () => {
      await start("owner");
      saveView(vStore, view("my-sketch", "My sketch"));
      expect((await refused(run("POST", "views", "nothing"))).status).toBe(404);
      expect((await refused(run("POST", "groups", "my-sketch"))).status).toBe(404);
      const gone = await refused(run("DELETE", "views", "my-sketch"));
      expect(gone.status).toBe(404);
      expect(gone.message).toBe("The team has no view my-sketch.");
    });

    it("answers 502 when the server cannot be reached, and when no team is linked", async () => {
      await start("owner");
      saveView(vStore, view("my-sketch", "My sketch"));
      await fake?.close();
      fake = undefined;
      expect((await refused(run("POST", "views", "my-sketch"))).status).toBe(502);
      vi.stubEnv("GANTRY_TOKEN", "");
      const unlinked = await refused(run("POST", "views", "my-sketch"));
      expect(unlinked.status).toBe(502);
      expect(unlinked.message).toMatch(/not linked/i);
    });

    it("is reached over HTTP only with the token, by POST and DELETE, and answers { published }", async () => {
      await start("owner");
      saveView(vStore, view("my-sketch", "My sketch"));
      const srv = await startExplorerServer({
        paths: vPaths,
        store: vStore,
        config: config(url),
        writeStateFile: false,
      });
      try {
        const call = (method: string, path: string, token: string | null = srv.token) =>
          fetch(`http://127.0.0.1:${srv.port}${path}`, {
            method,
            headers: {
              ...(token === null ? {} : { "x-gantry-token": token }),
              ...(method === "POST" ? { "content-type": "application/json" } : {}),
            },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
        expect((await call("POST", "/api/team/views/my-sketch/publish", null)).status).toBe(403);
        const ok = await call("POST", "/api/team/views/my-sketch/publish");
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ published: true });
        const removed = await call("DELETE", "/api/team/views/my-sketch/publish");
        expect(await removed.json()).toEqual({ published: false });
        const missing = await call("DELETE", "/api/team/views/my-sketch/publish");
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: "The team has no view my-sketch." });
        expect((await call("PUT", "/api/team/views/my-sketch/publish")).status).toBe(405);
        const list = await fetch(`http://127.0.0.1:${srv.port}/api/team/views`, {
          headers: { "x-gantry-token": srv.token },
        });
        expect(list.status).toBe(200);
      } finally {
        await srv.close();
      }
    });
  });
});

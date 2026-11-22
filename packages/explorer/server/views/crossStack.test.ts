import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GantryPaths,
  indexRepo,
  loadConfig,
  openStore,
  refreshDescriptionFts,
  resolvePaths,
  type Store,
  snapshotStore,
  trace,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError, handleApi } from "../api.js";
import type { ApiContext, ViewResult } from "../types.js";
import type { ApiTablesResult } from "./apiTables.js";
import { adapterCounts } from "./crossStack.js";
import type { EndpointsResult } from "./endpoints.js";
import type { FeaturePathResult } from "./featurePath.js";
import type { PageApiResult } from "./pageApi.js";
import type { TableUsageResult } from "./tableUsage.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const MARKER = "QuuxSevenCrossStackMarker";
const VIEWS = ["endpoints", "page-api", "api-tables", "feature-path", "table-usage"] as const;

interface Indexed {
  ctx: ApiContext;
  store: Store;
}
const cleanups: (() => Promise<void> | void)[] = [];

async function indexed(name: string, describeAll = false): Promise<Indexed> {
  const fx = await materializeFixture(name);
  const data = mkdtempSync(join(tmpdir(), "gantry-cross-"));
  cleanups.push(
    () => fx.cleanup(),
    () => rmSync(data, { recursive: true, force: true }),
  );
  const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  cleanups.push(() => store.close());
  if (describeAll) {
    // Every function gets a description and a suggested name holding the marker: none may reach a view.
    for (const s of store.effectiveSymbols()) {
      if (s.exactHash === "") continue;
      store.db
        .prepare(
          `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name, model, prompt_version, created_at, provenance)
           VALUES (?, ?, '[]', 0, ?, 'test', 'p1', '2026-01-01', 'model')`,
        )
        .run(`${s.exactHash}:p1`, `${MARKER} reads everything.`, `${MARKER}Name`);
    }
    refreshDescriptionFts(store);
  }
  return { ctx: { store, paths, config: loadConfig(paths) }, store };
}

let fx: Indexed;
let single: Indexed;
beforeAll(async () => {
  fx = await indexed("adapters", true);
  single = await indexed("single-pkg");
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

const run = <T extends ViewResult>(id: string, qs = "", c: ApiContext = fx.ctx): T =>
  handleApi(c, `/api/view/${id}`, new URLSearchParams(qs)) as T;
const lines = (r: ViewResult) => r.edges.map((e) => `${e.src} ${e.kind} ${e.dst}`);
const ids = (r: ViewResult, kind?: string) =>
  r.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.id);

const ROUTE = "route:adapters:@demo/web:/posts/$postId";
const GET = "ep:adapters:@demo/api:rpc posts.get";

describe("snapshot store", () => {
  it("answers every trace exactly as the store does", () => {
    const snap = snapshotStore(fx.store);
    const targets = fx.store
      .effectiveAdapterNodes()
      .filter((n) => ["route", "endpoint", "table"].includes(n.kind))
      .map((n) => n.id);
    expect(targets.length).toBeGreaterThan(20);
    for (const t of targets)
      for (const direction of ["down", "up"] as const)
        expect(trace(snap, t, { direction })).toEqual(trace(fx.store, t, { direction }));
  });
});

describe("meta and enabling", () => {
  it("enables the five views on a repo with adapters and disables them on single-pkg", () => {
    const meta = (c: ApiContext) =>
      (
        handleApi(c, "/api/meta", new URLSearchParams()) as {
          views: { id: string; enabled: boolean; reason?: string }[];
        }
      ).views;
    for (const id of VIEWS) expect(meta(fx.ctx).find((v) => v.id === id)?.enabled).toBe(true);
    const off = meta(single.ctx);
    for (const id of VIEWS) {
      const v = off.find((x) => x.id === id);
      expect(v?.enabled).toBe(false);
      expect(v?.reason).toBeTruthy();
      expect(() => run(id, "", single.ctx)).toThrow(HttpError);
    }
    // The other views are untouched.
    expect(off.find((v) => v.id === "project-map")?.enabled).toBe(true);
  });
});

describe("endpoints view", () => {
  it("groups endpoints by kind with middleware, handler and services", () => {
    const r = run<EndpointsResult>("endpoints");
    expect(r.layoutHint).toBe("elk-layered");
    expect(r.groups.map((g) => g.id)).toEqual(["rpc", "http", "fn"]);
    expect(ids(r, "endpoint")).toHaveLength(20);
    const l = lines(r);
    expect(l).toContain(
      "ep:adapters:@demo/server:GET /api/posts/:id middleware mw:adapters:@demo/server:/* cors",
    );
    expect(l).toContain("ep:adapters:@demo/web:fn savePost middleware mwref:@demo/web:requireUser");
    expect(l).toContain(`${GET} handles sym:adapters:packages/api/src/routers/posts.ts#postsRouter`);
    const get = r.nodes.find((n) => n.id === GET);
    expect(get).toMatchObject({ lane: 0, band: "rpc" });
    expect(r.nodes.find((n) => n.id === "mw:adapters:@demo/server:/* cors")?.lane).toBe(1);
  });

  it("filters by kind, method, prefix and workspace", () => {
    expect(ids(run("endpoints", "filters=kind=fn"), "endpoint")).toEqual([
      "ep:adapters:@demo/web:fn countPosts",
      "ep:adapters:@demo/web:fn fetchPost",
      "ep:adapters:@demo/web:fn savePost",
    ]);
    expect(ids(run("endpoints", "filters=method=PATCH"), "endpoint")).toEqual([
      "ep:adapters:@demo/server:PATCH /api/posts/:id",
    ]);
    expect(ids(run("endpoints", "filters=prefix=/api/users"), "endpoint")).toEqual([
      "ep:adapters:@demo/server:GET /api/users/v1",
      "ep:adapters:@demo/server:POST /api/users/v1",
    ]);
    expect(ids(run("endpoints", "filters=prefix=users."), "endpoint")).toEqual([
      "ep:adapters:@demo/api:rpc users.count",
      "ep:adapters:@demo/api:rpc users.rename",
    ]);
    expect(ids(run("endpoints", "filters=ws=@demo/web"), "endpoint")).toHaveLength(3);
    expect(() => run("endpoints", "depth=9")).toThrow(HttpError);
  });

  it("follows an inline handler's calls from inside its own span only", () => {
    const r = run("endpoints", "filters=prefix=posts.get");
    // posts.get and posts.authors share postsRouter; posts.get calls only what its own line calls.
    const fromRouter = r.edges.filter(
      (e) => e.src === "sym:adapters:packages/api/src/routers/posts.ts#postsRouter",
    );
    expect(fromRouter.map((e) => e.dst)).toContain("sym:adapters:packages/db/src/queries.ts#postWithAuthor");
    expect(fromRouter.map((e) => e.dst)).not.toContain("sym:adapters:packages/db/src/queries.ts#countUsers");
  });
});

describe("page -> API view", () => {
  it("joins each route to the endpoints its page requests, with a via count", () => {
    const r = run<PageApiResult>("page-api");
    expect(r.layoutHint).toBe("columns");
    const l = lines(r);
    expect(l).toContain(`${ROUTE} requests ${GET}`);
    expect(l).toContain(`${ROUTE} requests ep:adapters:@demo/web:fn fetchPost`);
    const patch = r.edges.find(
      (e) => e.src === ROUTE && e.dst === "ep:adapters:@demo/server:PATCH /api/posts/:id",
    );
    expect(patch?.confidence).toBe("high");
    expect(patch?.via).toBe(1);
    expect(patch?.viaSample).toEqual(["usePostActions"]);
    expect(r.nodes.find((n) => n.id === ROUTE)?.badges).toContain("2 unmatched");
    for (const n of r.nodes) expect(n.lane).toBe(n.kind === "route" ? 0 : 1);
    // Distinct unmatched calls over every page (a shared hook's call counts once), not a sum per route.
    const callers = new Set(
      fx.store
        .effectiveAdapterNodes({ kind: "client_call" })
        .filter((u) => u.data.caller === "sym:adapters:apps/web/src/hooks/usePostActions.ts#usePostActions")
        .map((u) => u.id),
    );
    expect(r.totals.unmatched).toBe(callers.size);
  });

  it("filters by prefix and shows unlinked nodes with all=true", () => {
    expect(ids(run("page-api", "filters=prefix=/users"), "route")).toEqual([
      "route:adapters:@demo/web:/users",
    ]);
    const all = run<PageApiResult>("page-api", "filters=all=true");
    expect(ids(all, "endpoint")).toHaveLength(20);
  });
});

describe("API -> tables view", () => {
  it("draws reads and writes per endpoint, services collapsed", () => {
    const r = run<ApiTablesResult>("api-tables");
    expect(r.lanes.map((l) => l.lane)).toEqual([0, 1, 2]);
    const row = (ep: string) => r.endpointTables.find((x) => x.endpoint === ep);
    expect(row(GET)).toEqual({
      endpoint: GET,
      reads: ["table:adapters:posts", "table:adapters:users"],
      writes: [],
    });
    expect(row("ep:adapters:@demo/api:rpc posts.authors")?.reads).not.toContain("table:adapters:posts");
    expect(row("ep:adapters:@demo/api:rpc users.rename")?.writes).toEqual(["table:adapters:users"]);
    const kinds = new Set(r.edges.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["reads", "uses", "writes"]);
    expect(r.nodes.filter((n) => n.lane === 2).every((n) => n.kind === "table")).toBe(true);
  });

  it("expands services with services=all", () => {
    const r = run<ApiTablesResult>("api-tables", "filters=services=all");
    expect(r.totals.expanded).toBe(true);
    expect(lines(r)).toContain(`${GET} handles sym:adapters:packages/api/src/routers/posts.ts#postsRouter`);
    expect(r.edges.some((e) => e.kind === "uses")).toBe(false);
  });
});

describe("feature path view", () => {
  it("needs a focus and lists the choices without one", () => {
    const r = run<FeaturePathResult>("feature-path");
    expect(r.nodes).toEqual([]);
    expect(r.choices?.some((c) => c.id === ROUTE)).toBe(true);
    expect(() => run("feature-path", "focus=nope")).toThrow(HttpError);
    expect(() => run("feature-path", "focus=table:posts")).toThrow(HttpError);
  });

  it("lays a route's path out in page / client / endpoint / service / table lanes", () => {
    const r = run<FeaturePathResult>("feature-path", `focus=${encodeURIComponent("/posts/$postId")}`);
    expect(r.focus).toBe(ROUTE);
    const lane = (id: string) => r.nodes.find((n) => n.id === id)?.lane;
    expect(lane(ROUTE)).toBe(0);
    expect(lane("sym:adapters:apps/web/src/routes/posts.$postId.tsx#PostPage")).toBe(1);
    expect(lane(GET)).toBe(2);
    expect(lane("sym:adapters:packages/api/src/routers/posts.ts#postsRouter")).toBe(3);
    expect(lane("table:adapters:posts")).toBe(4);
  });

  it("adds the pages that request an endpoint when the focus is one", () => {
    const r = run<FeaturePathResult>("feature-path", `focus=${encodeURIComponent(GET)}`);
    expect(ids(r, "route")).toEqual([ROUTE]);
    expect(ids(r, "table")).toEqual(["table:adapters:posts", "table:adapters:users"]);
  });
});

describe("table usage view", () => {
  it("puts writers above readers and reaches the pages", () => {
    const none = run<TableUsageResult>("table-usage");
    expect(none.choices?.map((c) => c.id)).toEqual(["table:adapters:posts", "table:adapters:users"]);
    const r = run<TableUsageResult>("table-usage", "focus=posts");
    expect(r.layoutHint).toBe("tree-lr");
    expect(r.table?.columns).toEqual(["id", "title", "authorId", "views"]);
    const table = r.nodes.find((n) => n.id === "table:adapters:posts");
    expect(table?.lane).toBe(Math.max(...r.nodes.map((n) => n.lane ?? 0)));
    expect(ids(r, "route")).toContain(ROUTE);
    const first = r.nodes
      .filter((n) => n.lane === (table?.lane ?? 0) - 1)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    expect(first[0]?.badges?.some((b) => b.startsWith("writes"))).toBe(true);
    expect(
      r.edges.find((e) => e.src === "sym:adapters:packages/api/src/report.ts#reportPosts")?.confidence,
    ).toBe("low");
    expect(() => run("table-usage", `focus=${encodeURIComponent(GET)}`)).toThrow(HttpError);
  });
});

describe("table usage view of a query file", () => {
  let sql: Indexed;
  beforeAll(async () => {
    sql = await indexed("go-recipes/sql");
  });
  it("carries the query file on the edges a query rule made, and on no other", () => {
    for (const [table, want] of [
      [
        "posts",
        [
          "reads Queries.ListAuthorPosts db/queries/posts.sql",
          "reads Queries.ListPosts db/queries/posts.sql",
          "writes Queries.PublishPost db/queries/posts.sql",
        ],
      ],
      ["users", ["reads Queries.ListAuthorPosts db/queries/posts.sql"]],
    ] as const) {
      const r = run<TableUsageResult>("table-usage", `focus=${table}`, sql.ctx);
      const label = new Map(r.nodes.map((n) => [n.id, n.label]));
      const access = r.edges.filter((e) => e.kind === "reads" || e.kind === "writes");
      expect(access.length).toBeGreaterThan(want.length);
      expect(
        access
          .filter((e) => e.textFile !== undefined)
          .map((e) => `${e.kind} ${label.get(e.src)} ${e.textFile}`)
          .sort(),
      ).toEqual([...want]);
      for (const e of r.edges) if (e.textFile === undefined) expect("textFile" in e).toBe(false);
    }
  });
});

describe("enabling counts", () => {
  it("counts adapter nodes by kind in SQL, equal to the effective nodes", () => {
    const want: Record<string, number> = {};
    for (const n of fx.store.effectiveAdapterNodes()) want[n.kind] = (want[n.kind] ?? 0) + 1;
    expect(adapterCounts(fx.store)).toEqual(want);
    expect(adapterCounts(single.store)).toEqual({});
  });
});

describe("collapsed services", () => {
  it("marks a collapsed path low only when no high-confidence way leads to the database call", () => {
    const r = run<ApiTablesResult>("api-tables");
    const uses = r.edges.filter((e) => e.kind === "uses");
    expect(uses.length).toBeGreaterThan(0);
    // Every way into the fixture's database callers is a resolved call, so every collapsed path is high.
    for (const e of uses) expect(e.confidence).toBe("high");
  });
});

describe("inspector facts", () => {
  it("describes endpoints and tables", () => {
    const node = (id: string) =>
      handleApi(fx.ctx, `/api/node/${encodeURIComponent(id)}`, new URLSearchParams()) as {
        node: Record<string, unknown> & {
          endpoint?: Record<string, unknown>;
          table?: Record<string, unknown>;
        };
        untrusted_description: unknown;
      };
    const ep = node("ep:adapters:@demo/server:GET /api/posts/:id");
    expect(ep.node.endpoint).toMatchObject({
      method: "GET",
      path: "/api/posts/:id",
      group: "http",
      handler: { id: "sym:adapters:packages/posts/src/handlers.ts#showPost", label: "showPost" },
      middleware: ["cors /*", "inline /api/*"],
    });
    const rpc = node(GET);
    expect(rpc.node.endpoint).toMatchObject({ method: "RPC", rpcPath: "posts.get", path: "/rpc/posts/get" });
    const mw = node("mwref:@demo/web:requireUser") as unknown as {
      node: { kind: string; middlewareRef: { name: string; endpoints: { id: string }[] } };
    };
    expect(mw.node.kind).toBe("middleware");
    expect(mw.node.middlewareRef.endpoints.map((e) => e.id)).toEqual(["ep:adapters:@demo/web:fn savePost"]);
    const t = node("table:adapters:users");
    expect(t.node.table).toMatchObject({ columns: ["id", "name"], readers: 2, writers: 1 });
    expect(t.untrusted_description).toBeNull();
  });
});

describe("determinism and containment", () => {
  const queries: [string, string][] = [
    ["endpoints", ""],
    ["page-api", ""],
    ["api-tables", ""],
    ["api-tables", "filters=services=all"],
    ["feature-path", `focus=${encodeURIComponent(ROUTE)}`],
    ["feature-path", `focus=${encodeURIComponent(GET)}`],
    ["table-usage", "focus=table:posts"],
  ];
  it("answers with the same JSON every time (snapshot)", () => {
    for (const [id, qs] of queries) {
      const a = JSON.stringify(run(id, qs));
      expect(JSON.stringify(run(id, qs))).toBe(a);
      expect(JSON.parse(a)).toMatchSnapshot(`${id}?${qs}`);
    }
  });
  it("never carries description text", () => {
    for (const [id, qs] of queries) expect(JSON.stringify(run(id, qs))).not.toContain(MARKER);
    for (const id of ["ep:adapters:@demo/server:GET /api/posts/:id", "table:adapters:posts", GET]) {
      const body = JSON.stringify(
        handleApi(fx.ctx, `/api/node/${encodeURIComponent(id)}`, new URLSearchParams()),
      );
      expect(body).not.toContain(MARKER);
    }
  });
});

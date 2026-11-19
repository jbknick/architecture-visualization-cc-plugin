import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../types.js";
import { mergePaths, patternMatches } from "./hono.js";

const helperPath = "../../test/helpers/fixture.js";
interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

interface Graph {
  nodes: AdapterNodeRecord[];
  edges: EdgeRecord[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** Indexes a fixture (main layer); with `edit`, then rewrites one file and re-indexes only it into the working layer. */
async function indexFixture(name: string, edit?: { path: string; from: string; to: string }): Promise<Graph> {
  const fx = await materializeFixture(name);
  const data = mkdtempSync(join(tmpdir(), "gantry-adapters-"));
  try {
    const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    if (edit) {
      const abs = join(fx.dir, edit.path);
      writeFileSync(abs, readFileSync(abs, "utf8").replace(edit.from, edit.to));
      await indexRepo(paths, { layer: "working", files: [edit.path] });
    }
    const store = openStore(paths.dbPath);
    try {
      const g = dumpGraph(store);
      return {
        nodes: (g.adapterNodes ?? []) as AdapterNodeRecord[],
        edges: (g.edges as EdgeRecord[]).filter((e) =>
          ["handles", "serves", "requests", "reads", "writes"].includes(e.kind),
        ),
      };
    } finally {
      store.close();
    }
  } finally {
    cleanups.push(() => fx.cleanup());
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  }
}

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id);
const edgesOf = (g: Graph, kind: string, src: string) =>
  g.edges.filter((e) => e.kind === kind && e.src === src).map((e) => e.dst);

describe("path helpers", () => {
  it("merges base paths, prefixes and route paths like Hono", () => {
    expect(mergePaths(["/api", "/posts/:id"])).toBe("/api/posts/:id");
    expect(mergePaths(["/api/users", "/v1", "/"])).toBe("/api/users/v1");
    expect(mergePaths(["", "/"])).toBe("/");
    expect(mergePaths(["/api/", "posts"])).toBe("/api/posts");
    expect(mergePaths(["/api", "*"])).toBe("/api/*");
  });

  it("matches middleware patterns", () => {
    expect(patternMatches("/*", "/health")).toBe(true);
    expect(patternMatches("/api/*", "/api")).toBe(true);
    expect(patternMatches("/api/*", "/api/posts/:id")).toBe(true);
    expect(patternMatches("/api/*", "/apix")).toBe(false);
    expect(patternMatches("/posts/:id", "/posts/:id")).toBe(true);
    expect(patternMatches("/posts", "/posts/1")).toBe(false);
  });
});

describe("adapters on fixtures/pnpm-turbo", () => {
  let g: Graph;
  beforeAll(async () => {
    g = await indexFixture("pnpm-turbo");
  });

  it("finds the Hono routes GET /posts/:id and POST /posts with their handlers", () => {
    const get = node(g, "ep:pnpm-turbo:@acme/api:GET /posts/:id");
    const post = node(g, "ep:pnpm-turbo:@acme/api:POST /posts");
    expect(get).toMatchObject({
      kind: "endpoint",
      ws: "ws:@acme/api",
      fileId: "file:pnpm-turbo:apps/api/src/app.ts",
    });
    expect(get?.data).toMatchObject({
      adapter: "hono",
      method: "GET",
      path: "/posts/:id",
      handler: "inline",
    });
    expect(post?.data).toMatchObject({ method: "POST", path: "/posts", handler: "inline" });
    // Module-level inline handlers: their calls are attributed to the file, so that is what they handle.
    expect(edgesOf(g, "handles", "ep:pnpm-turbo:@acme/api:GET /posts/:id")).toEqual([
      "file:pnpm-turbo:apps/api/src/app.ts",
    ]);
    expect(edgesOf(g, "handles", "ep:pnpm-turbo:@acme/api:POST /posts")).toEqual([
      "file:pnpm-turbo:apps/api/src/app.ts",
    ]);
  });

  it("skips workspaces without the framework dependency", () => {
    // apps/web has TanStack Router but neither hono nor TanStack Start; packages have neither.
    const kinds = new Set(g.nodes.filter((n) => n.ws === "ws:@acme/web").map((n) => n.kind));
    expect([...kinds]).toEqual(["route"]);
    expect(g.nodes.filter((n) => n.kind === "endpoint").every((n) => n.ws === "ws:@acme/api")).toBe(true);
  });

  it("finds the oRPC procedures posts.list and posts.create with their handlers", () => {
    const rpc = g.nodes.filter((n) => n.data.adapter === "orpc").map((n) => n.id);
    expect(rpc).toEqual([
      "ep:pnpm-turbo:@acme/api:rpc posts.create",
      "ep:pnpm-turbo:@acme/api:rpc posts.list",
    ]);
    expect(node(g, "ep:pnpm-turbo:@acme/api:rpc posts.list")).toMatchObject({
      kind: "endpoint",
      ws: "ws:@acme/api",
      fileId: "file:pnpm-turbo:apps/api/src/router.ts",
      data: { path: "posts.list", router: "apps/api/src/router.ts#router", handler: "inline" },
    });
    // Inline handlers in a router object: their calls belong to the router const.
    expect(edgesOf(g, "handles", "ep:pnpm-turbo:@acme/api:rpc posts.list")).toEqual([
      "sym:pnpm-turbo:apps/api/src/router.ts#router",
    ]);
    expect(edgesOf(g, "handles", "ep:pnpm-turbo:@acme/api:rpc posts.create")).toEqual([
      "sym:pnpm-turbo:apps/api/src/router.ts#router",
    ]);
  });

  it("finds the posts and users tables, and which queries read or write them", () => {
    const tables = g.nodes.filter((n) => n.kind === "table");
    expect(tables.map((n) => n.id)).toEqual(["table:pnpm-turbo:posts", "table:pnpm-turbo:users"]);
    expect(node(g, "table:pnpm-turbo:posts")).toMatchObject({
      ws: "ws:@acme/db",
      fileId: "file:pnpm-turbo:packages/db/src/schema.ts",
      data: {
        adapter: "drizzle",
        name: "posts",
        exportName: "posts",
        symbol: "sym:pnpm-turbo:packages/db/src/schema.ts#posts",
        dialect: "sqlite",
        columns: ["id", "title", "authorId", "createdAt"],
      },
    });
    const rw = g.edges.filter((e) => e.kind === "reads" || e.kind === "writes");
    expect(rw.map((e) => [e.kind, e.src, e.dst, e.confidence, e.evidence])).toEqual([
      [
        "writes",
        "sym:pnpm-turbo:packages/db/src/queries.ts#createPost",
        "table:pnpm-turbo:posts",
        "high",
        ["packages/db/src/queries.ts:16"],
      ],
      [
        "reads",
        "sym:pnpm-turbo:packages/db/src/queries.ts#getPost",
        "table:pnpm-turbo:posts",
        "high",
        ["packages/db/src/queries.ts:12"],
      ],
      [
        "reads",
        "sym:pnpm-turbo:packages/db/src/queries.ts#listPosts",
        "table:pnpm-turbo:posts",
        "high",
        ["packages/db/src/queries.ts:8"],
      ],
    ]);
  });
});

describe("adapters on fixtures/adapters", () => {
  let g: Graph;
  beforeAll(async () => {
    g = await indexFixture("adapters");
  });

  it("composes Hono paths across .route() mounts, imports and basePath", () => {
    const eps = g.nodes
      .filter((n) => n.kind === "endpoint" && n.data.adapter === "hono")
      .map((n) => n.id)
      .sort();
    expect(eps).toEqual([
      "ep:adapters:@demo/server:GET /api/posts/:id",
      "ep:adapters:@demo/server:GET /api/users/v1",
      "ep:adapters:@demo/server:GET /health",
      "ep:adapters:@demo/server:PATCH /api/posts/:id",
      "ep:adapters:@demo/server:POST /api/posts",
      "ep:adapters:@demo/server:POST /api/users/v1",
      "ep:adapters:@demo/server:PUT /api/posts/:id",
    ]);
    // The sub-app lives in another workspace; the node stays with the file that registers the route.
    expect(node(g, "ep:adapters:@demo/server:GET /api/posts/:id")).toMatchObject({
      fileId: "file:adapters:packages/posts/src/routes.ts",
      data: { routePath: "/posts/:id", handler: "showPost" },
    });
  });

  it("links handlers: named ones to their symbol (through imports), inline ones to the code holding them", () => {
    expect(edgesOf(g, "handles", "ep:adapters:@demo/server:GET /api/posts/:id")).toEqual([
      "sym:adapters:packages/posts/src/handlers.ts#showPost",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/server:POST /api/users/v1")).toEqual([
      "sym:adapters:apps/server/src/users.ts#createUser",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/server:GET /health")).toEqual([
      "sym:adapters:apps/server/src/app.ts#createApp",
    ]);
  });

  it("finds middleware and the endpoints it serves by prefix", () => {
    expect(node(g, "mw:adapters:@demo/server:/* cors")?.kind).toBe("middleware");
    expect(edgesOf(g, "serves", "mw:adapters:@demo/server:/* cors")).toHaveLength(7);
    const api = edgesOf(g, "serves", "mw:adapters:@demo/server:/api/* inline");
    expect(api).toHaveLength(6);
    expect(api).not.toContain("ep:adapters:@demo/server:GET /health");
  });

  it("finds server functions with method, validator, middleware and handler", () => {
    expect(node(g, "ep:adapters:@demo/web:fn fetchPost")?.data).toMatchObject({
      adapter: "tanstack-start",
      method: "GET",
      validator: true,
      middleware: [],
      handler: "inline",
      exported: true,
    });
    expect(node(g, "ep:adapters:@demo/web:fn savePost")?.data).toMatchObject({
      method: "POST",
      validator: false,
      middleware: ["requireUser"],
      handler: "savePostHandler",
    });
    expect(edgesOf(g, "handles", "ep:adapters:@demo/web:fn fetchPost")).toEqual([
      "sym:adapters:apps/web/src/server/posts.ts#fetchPost",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/web:fn savePost")).toEqual([
      "sym:adapters:apps/web/src/server/posts.ts#savePostHandler",
    ]);
  });

  it("links a route loader (and a beforeLoad function) to the server function it calls", () => {
    // From routes; requests from code (client calls) are tested in clients.test.ts.
    const req = g.edges.filter((e) => e.kind === "requests" && e.src.startsWith("route:"));
    expect(req.map((e) => [e.src, e.dst, e.confidence, e.fileId])).toEqual([
      [
        "route:adapters:@demo/web:/",
        "ep:adapters:@demo/web:fn countPosts",
        "high",
        "file:adapters:apps/web/src/routes/index.tsx",
      ],
      [
        "route:adapters:@demo/web:/posts/$postId",
        "ep:adapters:@demo/web:fn fetchPost",
        "high",
        "file:adapters:apps/web/src/routes/posts.$postId.tsx",
      ],
    ]);
  });

  it("skips test files and workspaces without the framework dependency", () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids.some((id) => id.includes("only-in-tests"))).toBe(false);
    expect(g.nodes.some((n) => n.ws === "ws:@demo/legacy")).toBe(false);
    expect(ids.some((id) => id.includes("legacy"))).toBe(false);
    expect(g.edges.some((e) => e.fileId.startsWith("file:adapters:packages/legacy/"))).toBe(false);
  });

  it("composes oRPC procedure paths across imported routers, builders, router(), lazy, factories and contracts", () => {
    const rpc = g.nodes.filter((n) => n.data.adapter === "orpc");
    expect(rpc.map((n) => n.id)).toEqual([
      "ep:adapters:@demo/api:rpc admin.purgePost",
      "ep:adapters:@demo/api:rpc health",
      "ep:adapters:@demo/api:rpc posts.authors",
      "ep:adapters:@demo/api:rpc posts.create",
      "ep:adapters:@demo/api:rpc posts.get",
      "ep:adapters:@demo/api:rpc posts.list",
      "ep:adapters:@demo/api:rpc posts.remove",
      "ep:adapters:@demo/api:rpc stats.summary",
      "ep:adapters:@demo/api:rpc users.count",
      "ep:adapters:@demo/api:rpc users.rename",
    ]);
    expect(node(g, "ep:adapters:@demo/api:rpc posts.list")).toMatchObject({
      fileId: "file:adapters:packages/api/src/routers/posts.ts",
      data: {
        router: "packages/api/src/router.ts#appRouter",
        route: { method: "GET", path: "/posts" },
        input: false,
      },
    });
    expect(node(g, "ep:adapters:@demo/api:rpc posts.create")?.data).toMatchObject({
      input: true,
      handler: "inline",
      handlerSpan: { start: 15, end: 15 },
    });
    expect(node(g, "ep:adapters:@demo/api:rpc posts.remove")?.data).toMatchObject({ handler: "removePost" });
    // A named handler is its own symbol: no span. A multi-line inline handler spans its lines.
    expect(node(g, "ep:adapters:@demo/api:rpc posts.remove")?.data.handlerSpan).toBeUndefined();
    expect(node(g, "ep:adapters:@demo/api:rpc users.rename")?.data.handlerSpan).toEqual({
      start: 8,
      end: 11,
    });
  });

  it("links procedure handlers to the code holding them", () => {
    expect(edgesOf(g, "handles", "ep:adapters:@demo/api:rpc posts.list")).toEqual([
      "sym:adapters:packages/api/src/routers/posts.ts#postsRouter",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/api:rpc posts.remove")).toEqual([
      "sym:adapters:packages/api/src/routers/posts.ts#removePost",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/api:rpc users.count")).toEqual([
      "sym:adapters:packages/api/src/routers/users.ts#countUsersProc",
    ]);
    expect(edgesOf(g, "handles", "ep:adapters:@demo/api:rpc admin.purgePost")).toEqual([
      "sym:adapters:packages/api/src/routers/admin.ts#makeAdminRouter",
    ]);
  });

  it("records where a Hono app mounts the oRPC handler", () => {
    const rpc = g.nodes.filter((n) => n.data.adapter === "orpc");
    for (const n of rpc) {
      expect(n.data).toMatchObject({ mountedAt: "/rpc", honoPath: "/rpc/*", protocol: "rpc" });
    }
  });

  it("finds Drizzle tables with columns (object and callback forms)", () => {
    const tables = g.nodes.filter((n) => n.kind === "table");
    expect(tables.map((n) => [n.id, n.ws, n.data.columns])).toEqual([
      ["table:adapters:posts", "ws:@demo/db", ["id", "title", "authorId", "views"]],
      ["table:adapters:users", "ws:@demo/db", ["id", "name"]],
    ]);
  });

  it("maps reads and writes, the relational query API, $count, aliases and namespace members to tables", () => {
    const rw = g.edges
      .filter((e) => e.kind === "reads" || e.kind === "writes")
      .map((e) => `${e.kind} ${e.src.replace(/^sym:[^#]*#/, "")} ${e.dst} ${e.confidence}`);
    expect(rw).toEqual([
      "reads reportPosts table:adapters:posts low",
      "reads countUsers table:adapters:users high",
      "writes createPost table:adapters:posts high",
      "writes deletePost table:adapters:posts high",
      "reads listPosts table:adapters:posts high",
      "reads postWithAuthor table:adapters:posts high",
      "reads postWithAuthor table:adapters:users high",
      "writes renameUser table:adapters:users high",
    ]);
    const list = g.edges.find((e) => e.kind === "reads" && e.src.endsWith("#listPosts"));
    expect(list?.evidence).toEqual(["packages/db/src/queries.ts:8"]);
    // Raw SQL and `Array.from` are not reads.
    expect(g.edges.some((e) => e.src.endsWith("#rawPostCount") || e.src.endsWith("#columnsOf"))).toBe(false);
  });

  it("re-derives endpoints of other files when a mount changes (working layer, one file re-indexed)", async () => {
    const after = await indexFixture("adapters", {
      path: "apps/server/src/app.ts",
      from: 'app.route("/api", posts)',
      to: 'app.route("/v2", posts)',
    });
    const ids = after.nodes
      .filter((n) => n.fileId === "file:adapters:packages/posts/src/routes.ts")
      .map((n) => n.id);
    expect(ids).toContain("ep:adapters:@demo/server:GET /v2/posts/:id");
    expect(ids).not.toContain("ep:adapters:@demo/server:GET /api/posts/:id");
    // The `/api/*` middleware no longer covers the posts routes.
    expect(edgesOf(after, "serves", "mw:adapters:@demo/server:/api/* inline")).toHaveLength(2);
  });

  it("re-derives procedure paths of other files when the root router changes", async () => {
    const after = await indexFixture("adapters", {
      path: "packages/api/src/router.ts",
      from: "posts: postsRouter,",
      to: "articles: postsRouter,",
    });
    const ids = after.nodes
      .filter((n) => n.fileId === "file:adapters:packages/api/src/routers/posts.ts")
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual([
      "ep:adapters:@demo/api:rpc articles.authors",
      "ep:adapters:@demo/api:rpc articles.create",
      "ep:adapters:@demo/api:rpc articles.get",
      "ep:adapters:@demo/api:rpc articles.list",
      "ep:adapters:@demo/api:rpc articles.remove",
    ]);
  });

  it("is deterministic across runs", async () => {
    const again = await indexFixture("adapters");
    expect(again).toEqual(g);
  });
});

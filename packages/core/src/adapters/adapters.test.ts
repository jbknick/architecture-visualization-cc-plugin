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
        edges: (g.edges as EdgeRecord[]).filter((e) => ["handles", "serves", "requests"].includes(e.kind)),
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
    const get = node(g, "ep:@acme/api:GET /posts/:id");
    const post = node(g, "ep:@acme/api:POST /posts");
    expect(get).toMatchObject({ kind: "endpoint", ws: "ws:@acme/api", fileId: "file:apps/api/src/app.ts" });
    expect(get?.data).toMatchObject({
      adapter: "hono",
      method: "GET",
      path: "/posts/:id",
      handler: "inline",
    });
    expect(post?.data).toMatchObject({ method: "POST", path: "/posts", handler: "inline" });
    // Module-level inline handlers: their calls are attributed to the file, so that is what they handle.
    expect(edgesOf(g, "handles", "ep:@acme/api:GET /posts/:id")).toEqual(["file:apps/api/src/app.ts"]);
    expect(edgesOf(g, "handles", "ep:@acme/api:POST /posts")).toEqual(["file:apps/api/src/app.ts"]);
  });

  it("skips workspaces without the framework dependency", () => {
    // apps/web has TanStack Router but neither hono nor TanStack Start; packages have neither.
    const kinds = new Set(g.nodes.filter((n) => n.ws === "ws:@acme/web").map((n) => n.kind));
    expect([...kinds]).toEqual(["route"]);
    expect(g.nodes.filter((n) => n.kind === "endpoint").every((n) => n.ws === "ws:@acme/api")).toBe(true);
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
      "ep:@demo/server:GET /api/posts/:id",
      "ep:@demo/server:GET /api/users/v1",
      "ep:@demo/server:GET /health",
      "ep:@demo/server:PATCH /api/posts/:id",
      "ep:@demo/server:POST /api/posts",
      "ep:@demo/server:POST /api/users/v1",
      "ep:@demo/server:PUT /api/posts/:id",
    ]);
    // The sub-app lives in another workspace; the node stays with the file that registers the route.
    expect(node(g, "ep:@demo/server:GET /api/posts/:id")).toMatchObject({
      fileId: "file:packages/posts/src/routes.ts",
      data: { routePath: "/posts/:id", handler: "showPost" },
    });
  });

  it("links handlers: named ones to their symbol (through imports), inline ones to the code holding them", () => {
    expect(edgesOf(g, "handles", "ep:@demo/server:GET /api/posts/:id")).toEqual([
      "sym:packages/posts/src/handlers.ts#showPost",
    ]);
    expect(edgesOf(g, "handles", "ep:@demo/server:POST /api/users/v1")).toEqual([
      "sym:apps/server/src/users.ts#createUser",
    ]);
    expect(edgesOf(g, "handles", "ep:@demo/server:GET /health")).toEqual([
      "sym:apps/server/src/app.ts#createApp",
    ]);
  });

  it("finds middleware and the endpoints it serves by prefix", () => {
    expect(node(g, "mw:@demo/server:/* cors")?.kind).toBe("middleware");
    expect(edgesOf(g, "serves", "mw:@demo/server:/* cors")).toHaveLength(7);
    const api = edgesOf(g, "serves", "mw:@demo/server:/api/* inline");
    expect(api).toHaveLength(6);
    expect(api).not.toContain("ep:@demo/server:GET /health");
  });

  it("finds server functions with method, validator, middleware and handler", () => {
    expect(node(g, "ep:@demo/web:fn fetchPost")?.data).toMatchObject({
      adapter: "tanstack-start",
      method: "GET",
      validator: true,
      middleware: [],
      handler: "inline",
      exported: true,
    });
    expect(node(g, "ep:@demo/web:fn savePost")?.data).toMatchObject({
      method: "POST",
      validator: false,
      middleware: ["requireUser"],
      handler: "savePostHandler",
    });
    expect(edgesOf(g, "handles", "ep:@demo/web:fn fetchPost")).toEqual([
      "sym:apps/web/src/server/posts.ts#fetchPost",
    ]);
    expect(edgesOf(g, "handles", "ep:@demo/web:fn savePost")).toEqual([
      "sym:apps/web/src/server/posts.ts#savePostHandler",
    ]);
  });

  it("links a route loader (and a beforeLoad function) to the server function it calls", () => {
    const req = g.edges.filter((e) => e.kind === "requests");
    expect(req.map((e) => [e.src, e.dst, e.confidence, e.fileId])).toEqual([
      ["route:@demo/web:/", "ep:@demo/web:fn countPosts", "high", "file:apps/web/src/routes/index.tsx"],
      [
        "route:@demo/web:/posts/$postId",
        "ep:@demo/web:fn fetchPost",
        "high",
        "file:apps/web/src/routes/posts.$postId.tsx",
      ],
    ]);
  });

  it("skips test files and workspaces without the framework dependency", () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids.some((id) => id.includes("only-in-tests"))).toBe(false);
    expect(g.nodes.some((n) => n.ws === "ws:@demo/legacy")).toBe(false);
    expect(ids.some((id) => id.includes("legacy"))).toBe(false);
  });

  it("re-derives endpoints of other files when a mount changes (working layer, one file re-indexed)", async () => {
    const after = await indexFixture("adapters", {
      path: "apps/server/src/app.ts",
      from: 'app.route("/api", posts)',
      to: 'app.route("/v2", posts)',
    });
    const ids = after.nodes.filter((n) => n.fileId === "file:packages/posts/src/routes.ts").map((n) => n.id);
    expect(ids).toContain("ep:@demo/server:GET /v2/posts/:id");
    expect(ids).not.toContain("ep:@demo/server:GET /api/posts/:id");
    // The `/api/*` middleware no longer covers the posts routes.
    expect(edgesOf(after, "serves", "mw:@demo/server:/api/* inline")).toHaveLength(2);
  });

  it("is deterministic across runs", async () => {
    const again = await indexFixture("adapters");
    expect(again).toEqual(g);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "./indexer.js";
import { resolvePaths } from "./paths/index.js";
import { openStore, type Store } from "./store/index.js";
import { resolveTraceTarget, type TraceResult, trace } from "./trace.js";

const helperPath = "../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

const ROUTE = "route:@demo/web:/posts/$postId";
const ROUTER = "sym:packages/api/src/routers/posts.ts#postsRouter";

let store: Store;
const cleanups: (() => Promise<void> | void)[] = [];
beforeAll(async () => {
  const fx = await materializeFixture("adapters");
  const data = mkdtempSync(join(tmpdir(), "gantry-trace-"));
  cleanups.push(
    () => fx.cleanup(),
    () => rmSync(data, { recursive: true, force: true }),
  );
  const paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  store = openStore(paths.dbPath);
  cleanups.push(() => store.close());
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

const ids = (r: TraceResult | null, kind?: string) =>
  (r?.chain ?? []).filter((s) => kind === undefined || s.kind === kind).map((s) => s.id);
const step = (r: TraceResult | null, id: string) => r?.chain.find((s) => s.id === id);

describe("trace targets", () => {
  it("resolves ids, route paths, endpoint labels, table names and file paths", () => {
    expect(resolveTraceTarget(store, ROUTE)).toBe(ROUTE);
    expect(resolveTraceTarget(store, "/posts/$postId")).toBe(ROUTE);
    expect(resolveTraceTarget(store, "rpc posts.list")).toBe("ep:@demo/api:rpc posts.list");
    expect(resolveTraceTarget(store, "GET /api/posts/:id")).toBe("ep:@demo/server:GET /api/posts/:id");
    expect(resolveTraceTarget(store, "posts")).toBe("table:posts");
    expect(resolveTraceTarget(store, "packages/db/src/queries.ts")).toBe("file:packages/db/src/queries.ts");
    expect(resolveTraceTarget(store, "nope")).toBeNull();
    expect(trace(store, "nope")).toBeNull();
  });
});

describe("trace down from a page", () => {
  it("reaches the endpoint and table posts from /posts/$postId", () => {
    const r = trace(store, "/posts/$postId");
    expect(r?.direction).toBe("down");
    expect(r?.target).toBe(ROUTE);
    expect(step(r, "sym:apps/web/src/routes/posts.$postId.tsx#PostPage")).toMatchObject({
      via: "serves",
      depth: 1,
    });
    expect(step(r, "ep:@demo/api:rpc posts.get")).toMatchObject({
      via: "requests",
      kind: "endpoint",
      depth: 2,
    });
    expect(step(r, "table:posts")).toMatchObject({ kind: "table", via: "reads" });
    // Depth, then id: the loader's server function and the page's procedure, then the hook's calls.
    expect(ids(r, "endpoint")).toEqual([
      "ep:@demo/web:fn fetchPost",
      "ep:@demo/api:rpc posts.get",
      "ep:@demo/api:rpc posts.remove",
      "ep:@demo/server:GET /api/posts/:id",
      "ep:@demo/server:PATCH /api/posts/:id",
      "ep:@demo/web:fn savePost",
    ]);
    // The fetch match is low confidence and says so.
    expect(step(r, "ep:@demo/server:PATCH /api/posts/:id")?.confidence).toBe("low");
    expect(r?.gaps).toContain(
      `unmatched client call "rpc posts.archive" (no_endpoint) in sym:apps/web/src/hooks/usePostActions.ts#usePostActions at apps/web/src/hooks/usePostActions.ts:12`,
    );
    expect(r?.gaps).toContain("no table reached from ep:@demo/web:fn fetchPost");
    expect(r?.truncated).toBe(false);
    // Every chain edge joins two chain nodes.
    const chain = new Set(ids(r));
    for (const e of r?.edges ?? []) expect(chain.has(e.src) && chain.has(e.dst)).toBe(true);
  });

  it("is deterministic", () => {
    expect(trace(store, ROUTE)).toEqual(trace(store, ROUTE));
    expect(trace(store, "table:posts")).toEqual(trace(store, "table:posts"));
  });
});

describe("trace up from a table", () => {
  it("lists the page from table:posts", () => {
    const r = trace(store, "table:posts");
    expect(r?.direction).toBe("up");
    expect(ids(r, "route")).toEqual([ROUTE]);
    expect(ids(r, "endpoint")).toEqual([
      "ep:@demo/api:rpc admin.purgePost",
      "ep:@demo/api:rpc posts.create",
      "ep:@demo/api:rpc posts.get",
      "ep:@demo/api:rpc posts.list",
      "ep:@demo/api:rpc posts.remove",
    ]);
    expect(r?.gaps).toContain("no client call found for ep:@demo/api:rpc posts.create");
  });
});

describe("inline handlers that share a const (handlerSpan)", () => {
  it("the shared router const holds every sibling's calls", () => {
    const callees = store
      .effectiveEdges({ src: ROUTER, kind: ["calls"] })
      .map((e) => e.dst)
      .filter((d) => d.includes("/db/"))
      .sort();
    expect(callees).toEqual([
      "sym:packages/db/src/queries.ts#countUsers",
      "sym:packages/db/src/queries.ts#createPost",
      "sym:packages/db/src/queries.ts#listPosts",
      "sym:packages/db/src/queries.ts#postWithAuthor",
    ]);
  });

  it("down: each procedure reaches only its own tables", () => {
    const list = trace(store, "ep:@demo/api:rpc posts.list");
    expect(ids(list, "table")).toEqual(["table:posts"]);
    expect(ids(list)).not.toContain("sym:packages/db/src/queries.ts#countUsers");
    const authors = trace(store, "ep:@demo/api:rpc posts.authors");
    expect(ids(authors, "table")).toEqual(["table:users"]);
    expect(ids(authors)).toContain(ROUTER);
  });

  it("up: a table reaches only the procedures whose own handler touches it", () => {
    const users = trace(store, "table:users");
    const eps = ids(users, "endpoint");
    expect(eps).toContain("ep:@demo/api:rpc posts.authors");
    expect(eps).toContain("ep:@demo/api:rpc posts.get");
    expect(eps).not.toContain("ep:@demo/api:rpc posts.list");
    expect(eps).not.toContain("ep:@demo/api:rpc posts.create");
    const posts = trace(store, "table:posts");
    expect(ids(posts, "endpoint")).not.toContain("ep:@demo/api:rpc posts.authors");
  });
});

describe("limits", () => {
  it("stops at the node budget and says so", () => {
    const r = trace(store, ROUTE, { maxNodes: 4 });
    expect(r?.truncated).toBe(true);
    expect(r?.gaps).toContain("node budget (4) reached; the chain is incomplete");
  });

  it("stops at the hop limit and says where", () => {
    const r = trace(store, ROUTE, { maxDepth: 1 });
    expect(ids(r)).not.toContain("ep:@demo/api:rpc posts.remove");
    expect(r?.gaps.some((g) => g.startsWith("depth limit (1 hops) reached at "))).toBe(true);
  });
});

describe("cycles", () => {
  it("visits each node once on a call cycle and ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-trace-cycle-"));
    const data = mkdtempSync(join(tmpdir(), "gantry-trace-cycle-data-"));
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(data, { recursive: true, force: true }),
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cycle", private: true }));
    writeFileSync(
      join(dir, "src/a.ts"),
      'import { b } from "./b";\nexport function a(n: number): number {\n  return n > 0 ? b(n - 1) : 0;\n}\n',
    );
    writeFileSync(
      join(dir, "src/b.ts"),
      'import { a } from "./a";\nexport function b(n: number): number {\n  return a(n) + 1;\n}\n',
    );
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "x",
    );
    const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const s = openStore(paths.dbPath);
    try {
      for (const direction of ["down", "up"] as const) {
        const r = trace(s, "sym:src/a.ts#a", { direction });
        expect(r?.truncated).toBe(false);
        // a -> b -> a: b is visited once and leads to no endpoint, table or route.
        expect(r?.omitted).toBe(1);
        expect(ids(r)).toEqual(["sym:src/a.ts#a"]);
      }
    } finally {
      s.close();
    }
  });
});

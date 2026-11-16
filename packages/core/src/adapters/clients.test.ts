import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSync } from "oxc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../types.js";
import { pathScore, urlPath } from "./clients.js";

const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

interface Graph {
  nodes: AdapterNodeRecord[];
  edges: EdgeRecord[];
}
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function indexDir(dir: string): Promise<Graph> {
  const data = mkdtempSync(join(tmpdir(), "gantry-clients-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  try {
    const g = dumpGraph(store);
    return { nodes: (g.adapterNodes ?? []) as AdapterNodeRecord[], edges: g.edges as EdgeRecord[] };
  } finally {
    store.close();
  }
}

/** A temp git repo from a map of files. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gantry-clients-repo-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
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
  return dir;
}

const requests = (g: Graph, src: string) =>
  g.edges
    .filter((e) => e.kind === "requests" && e.src === src)
    .map((e) => [e.dst, e.confidence, e.evidence.join(",")]);

/** The first argument of the first call in `code`, as oxc parses it. */
function arg(code: string): unknown {
  const r = parseSync("x.ts", `f(${code})`, { sourceType: "module", lang: "ts" });
  const st = (r.program as unknown as { body: { expression: { arguments: unknown[] } }[] }).body[0];
  return st?.expression.arguments[0];
}

describe("URL helpers", () => {
  it("reads literal and template URLs as paths, a template piece as :param", () => {
    expect(urlPath(arg('"/api/posts"'))).toBe("/api/posts");
    expect(urlPath(arg("`/api/posts/${id}`"))).toBe("/api/posts/:param");
    expect(urlPath(arg("`${base}/api/posts/${id}/comments`"))).toBe("/api/posts/:param/comments");
    expect(urlPath(arg('"/api/posts/?page=2#top"'))).toBe("/api/posts");
    expect(urlPath(arg('"https://example.com/x?y=1"'))).toBe("https://example.com/x");
    expect(urlPath(arg("url"))).toBeNull();
    expect(urlPath(arg('"posts"'))).toBeNull();
  });

  it("matches a call path to an endpoint path, counting parameter segments", () => {
    expect(pathScore("/api/posts/:param", "/api/posts/:id")).toBe(1);
    expect(pathScore("/api/posts/new", "/api/posts/:id")).toBe(1);
    expect(pathScore("/api/posts/new", "/api/posts/new")).toBe(0);
    expect(pathScore("/api/posts", "/api/posts/:id")).toBeNull();
    expect(pathScore("/api/users", "/api/posts")).toBeNull();
  });
});

describe("client calls on fixtures/adapters", () => {
  let g: Graph;
  beforeAll(async () => {
    const fx = await materializeFixture("adapters");
    cleanups.push(() => fx.cleanup());
    g = await indexDir(fx.dir);
  });
  const HOOK = "sym:apps/web/src/hooks/usePostActions.ts#usePostActions";

  it("rule 1: a server function call (same file or imported) and useServerFn, high", () => {
    expect(requests(g, "sym:apps/web/src/routes/index.tsx#checkCount")).toEqual([
      ["ep:@demo/web:fn countPosts", "high", "apps/web/src/routes/index.tsx:12"],
    ]);
    expect(requests(g, HOOK)).toContainEqual([
      "ep:@demo/web:fn savePost",
      "high",
      "apps/web/src/hooks/usePostActions.ts:9",
    ]);
    // The route definition's loader is the route's own edge (TanStack Start adapter), not a second one.
    expect(requests(g, "sym:apps/web/src/routes/posts.$postId.tsx#Route")).toEqual([]);
  });

  it("rule 2: oRPC client and query utils chains, helpers stripped, through a client factory, high", () => {
    expect(requests(g, "sym:apps/web/src/routes/posts.$postId.tsx#PostPage")).toEqual([
      ["ep:@demo/api:rpc posts.get", "high", "apps/web/src/routes/posts.$postId.tsx:15"],
    ]);
    expect(requests(g, "sym:apps/web/src/routes/users.tsx#loadCount")).toEqual([
      ["ep:@demo/api:rpc users.count", "high", "apps/web/src/routes/users.tsx:7"],
    ]);
    expect(requests(g, HOOK)).toContainEqual([
      "ep:@demo/api:rpc posts.remove",
      "high",
      "apps/web/src/hooks/usePostActions.ts:10",
    ]);
    // `orpc.posts.key()` names a router: a cache helper, neither a request nor an unmatched call.
    expect(g.nodes.some((n) => n.kind === "client_call" && n.label === "rpc posts")).toBe(false);
    // Through a sub-client alias (`const postsClient = client.posts`).
    expect(requests(g, "sym:apps/web/src/lib/clients.ts#listPostsNow")).toEqual([
      ["ep:@demo/api:rpc posts.list", "high", "apps/web/src/lib/clients.ts:10"],
    ]);
  });

  it("rule 3: a Hono RPC client chain with a computed path key, high", () => {
    expect(requests(g, HOOK)).toContainEqual([
      "ep:@demo/server:GET /api/posts/:id",
      "high",
      "apps/web/src/hooks/usePostActions.ts:15",
    ]);
  });

  it("rule 4: fetch with a template URL and a method option, low (flagged)", () => {
    expect(requests(g, HOOK)).toContainEqual([
      "ep:@demo/server:PATCH /api/posts/:id",
      "low",
      "apps/web/src/hooks/usePostActions.ts:16",
    ]);
    // Only the fetch match is low.
    const low = g.edges.filter((e) => e.kind === "requests" && e.confidence === "low").map((e) => e.dst);
    expect(low).toEqual(["ep:@demo/server:PATCH /api/posts/:id"]);
  });

  it("rule 5: unmatched calls are reported as client_call nodes, never guessed", () => {
    const calls = g.nodes.filter((n) => n.kind === "client_call");
    expect(calls.map((n) => [n.id, n.data.rule, n.data.reason, n.data.caller, n.data.line])).toEqual([
      ["call:@demo/web:GET https://status.example.com/ping", "fetch", "external_url", HOOK, 17],
      ["call:@demo/web:rpc posts.archive", "orpc", "no_endpoint", HOOK, 12],
      // A sub-client passed on as a value: where its calls go cannot be followed.
      [
        "call:@demo/web:rpc users.*",
        "orpc",
        "client_alias",
        "sym:apps/web/src/lib/clients.ts#usersClient",
        7,
      ],
    ]);
    expect(g.edges.some((e) => e.kind === "requests" && e.dst.startsWith("call:"))).toBe(false);
  });
});

describe("narrowing candidates", () => {
  const pkg = (name: string, deps: Record<string, string>) =>
    JSON.stringify({
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      dependencies: deps,
    });
  const api = (name: string) => ({
    [`packages/${name}/package.json`]: pkg(`@x/${name}`, { "@orpc/server": "^1.0.0" }),
    [`packages/${name}/src/index.ts`]: `import { os } from "@orpc/server";\nexport const router = { posts: { list: os.handler(() => []) } };\n`,
  });
  const client = (app: string, deps: Record<string, string>) => ({
    [`apps/${app}/package.json`]: pkg(`@x/${app}`, { "@orpc/client": "^1.0.0", ...deps }),
    [`apps/${app}/src/client.ts`]: `import { createORPCClient } from "@orpc/client";\nexport const client = createORPCClient(link);\nexport function load() {\n  return client.posts.list();\n}\n`,
  });

  it("keeps the candidate in a dependency (high), else links each candidate low", async () => {
    const g = await indexDir(
      repo({
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
        ...api("one"),
        ...api("two"),
        ...client("web", { "@x/one": "workspace:*" }),
        ...client("other", {}),
      }),
    );
    expect(requests(g, "sym:apps/web/src/client.ts#load")).toEqual([
      ["ep:@x/one:rpc posts.list", "high", "apps/web/src/client.ts:4"],
    ]);
    expect(requests(g, "sym:apps/other/src/client.ts#load")).toEqual([
      ["ep:@x/one:rpc posts.list", "low", "apps/other/src/client.ts:4"],
      ["ep:@x/two:rpc posts.list", "low", "apps/other/src/client.ts:4"],
    ]);
  });
});

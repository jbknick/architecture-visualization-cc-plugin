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
import { joinUrl, pathScore, urlPath } from "./clients.js";

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
  const parent = mkdtempSync(join(tmpdir(), "gantry-clients-repo-"));
  const dir = join(parent, "repo"); // the repo name (no remote) is this basename
  mkdirSync(dir);
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
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

describe("join rules", () => {
  it("axios: base and path with one slash, an absolute URL replaces the base", () => {
    expect(joinUrl("axios", "/api", "/users")).toBe("/api/users");
    expect(joinUrl("axios", "/api/", "/users")).toBe("/api/users");
    expect(joinUrl("axios", "/api/", "users/me")).toBe("/api/users/me");
    expect(joinUrl("axios", "/api", "/users/:param?x=1#top")).toBe("/api/users/:param");
    expect(joinUrl("axios", "/api", "https://other.example/x")).toBe("https://other.example/x");
    expect(joinUrl("axios", "/api", "//other.example/x")).toBe("//other.example/x");
    expect(joinUrl("axios", "", "/users")).toBe("/users");
  });

  it("ky: prefixUrl, a slash and an input without a leading slash", () => {
    expect(joinUrl("ky", "/api", "users/:param")).toBe("/api/users/:param");
    expect(joinUrl("ky", "/api/", "users")).toBe("/api/users");
    expect(joinUrl("ky", "/api", "/users")).toBeNull();
    expect(joinUrl("ky", "", "/users")).toBe("/users");
  });
});

describe("client calls on fixtures/adapters", () => {
  let g: Graph;
  beforeAll(async () => {
    const fx = await materializeFixture("adapters");
    cleanups.push(() => fx.cleanup());
    g = await indexDir(fx.dir);
  });
  const HOOK = "sym:adapters:apps/web/src/hooks/usePostActions.ts#usePostActions";

  it("rule 1: a server function call (same file or imported) and useServerFn, high", () => {
    expect(requests(g, "sym:adapters:apps/web/src/routes/index.tsx#checkCount")).toEqual([
      ["ep:adapters:@demo/web:fn countPosts", "high", "apps/web/src/routes/index.tsx:12"],
    ]);
    expect(requests(g, HOOK)).toContainEqual([
      "ep:adapters:@demo/web:fn savePost",
      "high",
      "apps/web/src/hooks/usePostActions.ts:9",
    ]);
    // The route definition's loader is the route's own edge (TanStack Start adapter), not a second one.
    expect(requests(g, "sym:adapters:apps/web/src/routes/posts.$postId.tsx#Route")).toEqual([]);
  });

  it("rule 2: oRPC client and query utils chains, helpers stripped, through a client factory, high", () => {
    expect(requests(g, "sym:adapters:apps/web/src/routes/posts.$postId.tsx#PostPage")).toEqual([
      ["ep:adapters:@demo/api:rpc posts.get", "high", "apps/web/src/routes/posts.$postId.tsx:15"],
    ]);
    expect(requests(g, "sym:adapters:apps/web/src/routes/users.tsx#loadCount")).toEqual([
      ["ep:adapters:@demo/api:rpc users.count", "high", "apps/web/src/routes/users.tsx:7"],
    ]);
    expect(requests(g, HOOK)).toContainEqual([
      "ep:adapters:@demo/api:rpc posts.remove",
      "high",
      "apps/web/src/hooks/usePostActions.ts:10",
    ]);
    // `orpc.posts.key()` names a router: a cache helper, neither a request nor an unmatched call.
    expect(g.nodes.some((n) => n.kind === "client_call" && n.label === "rpc posts")).toBe(false);
    // Through a sub-client alias (`const postsClient = client.posts`).
    expect(requests(g, "sym:adapters:apps/web/src/lib/clients.ts#listPostsNow")).toEqual([
      ["ep:adapters:@demo/api:rpc posts.list", "high", "apps/web/src/lib/clients.ts:10"],
    ]);
  });

  it("rule 3: a Hono RPC client chain with a computed path key, high", () => {
    expect(requests(g, HOOK)).toContainEqual([
      "ep:adapters:@demo/server:GET /api/posts/:id",
      "high",
      "apps/web/src/hooks/usePostActions.ts:15",
    ]);
  });

  it("rule 4: fetch with a template URL and a method option, low (flagged)", () => {
    expect(requests(g, HOOK)).toContainEqual([
      "ep:adapters:@demo/server:PATCH /api/posts/:id",
      "low",
      "apps/web/src/hooks/usePostActions.ts:16",
    ]);
    // Only the fetch match is low.
    const low = g.edges.filter((e) => e.kind === "requests" && e.confidence === "low").map((e) => e.dst);
    expect(low).toEqual(["ep:adapters:@demo/server:PATCH /api/posts/:id"]);
  });

  it("rule 5: unmatched calls are reported as client_call nodes, never guessed", () => {
    const calls = g.nodes.filter((n) => n.kind === "client_call");
    expect(calls.map((n) => [n.id, n.data.rule, n.data.reason, n.data.caller, n.data.line])).toEqual([
      ["call:adapters:@demo/web:GET https://status.example.com/ping", "fetch", "external_url", HOOK, 17],
      ["call:adapters:@demo/web:rpc posts.archive", "orpc", "no_endpoint", HOOK, 12],
      // A sub-client passed on as a value: where its calls go cannot be followed.
      [
        "call:adapters:@demo/web:rpc users.*",
        "orpc",
        "client_alias",
        "sym:adapters:apps/web/src/lib/clients.ts#usersClient",
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
    expect(requests(g, "sym:repo:apps/web/src/client.ts#load")).toEqual([
      ["ep:repo:@x/one:rpc posts.list", "high", "apps/web/src/client.ts:4"],
    ]);
    expect(requests(g, "sym:repo:apps/other/src/client.ts#load")).toEqual([
      ["ep:repo:@x/one:rpc posts.list", "low", "apps/other/src/client.ts:4"],
      ["ep:repo:@x/two:rpc posts.list", "low", "apps/other/src/client.ts:4"],
    ]);
  });
});

describe("client instances on fixtures/linking", () => {
  let g: Graph;
  beforeAll(async () => {
    const fx = await materializeFixture("linking");
    cleanups.push(() => fx.cleanup());
    g = await indexDir(fx.dir);
  });
  const SO = "sym:linking:apps/web/src/features/same-origin.ts#";
  const DEF = "sym:linking:apps/legacy-web/src/calls.ts#";
  const ep = (route: string) => `ep:linking:@fx/users-api:${route}`;
  const gap = (caller: string) =>
    g.nodes
      .filter((n) => n.kind === "client_call" && n.data.caller === caller)
      .map((n) => [n.data.rule, n.data.reason, n.label]);

  it("links calls on axios and ky instances to the endpoint of the joined URL, low", () => {
    const f = "apps/web/src/features/same-origin.ts";
    expect(requests(g, `${SO}instGet`)).toEqual([[ep("GET /api/users/:id"), "low", `${f}:4`]]);
    expect(requests(g, `${SO}instPost`)).toEqual([[ep("POST /api/users"), "low", `${f}:8`]]);
    // The literal `/users/me` beats `/users/:id`.
    expect(requests(g, `${SO}instRequest`)).toEqual([[ep("GET /api/users/me"), "low", `${f}:12`]]);
    expect(requests(g, `${SO}instCall`)).toEqual([[ep("GET /api/orders/:id"), "low", `${f}:16`]]);
    expect(requests(g, `${SO}kyGet`)).toEqual([[ep("GET /api/users/:id"), "low", `${f}:20`]]);
    // `kyRelAuth = kyRel.extend({ headers })` keeps the prefix of `kyRel`.
    expect(requests(g, `${SO}kyExtended`)).toEqual([[ep("DELETE /api/users/:id"), "low", `${f}:24`]]);
  });

  it("follows an instance through a re-export", () => {
    expect(requests(g, "sym:linking:apps/web/src/features/reexport.ts#viaReexport")).toEqual([
      [ep("PUT /api/users/:id"), "low", "apps/web/src/features/reexport.ts:4"],
    ]);
  });

  it("reports an instance call that matches no endpoint as a gap", () => {
    expect(requests(g, `${SO}instMissing`)).toEqual([]);
    expect(gap(`${SO}instMissing`)).toEqual([["instance", "no_endpoint", "GET /api/nope"]]);
  });

  it("uses axios.defaults.baseURL of the workspace for the default axios import", () => {
    const f = "apps/legacy-web/src/calls.ts";
    expect(requests(g, `${DEF}defGet`)).toEqual([[ep("GET /api/users/:id"), "low", `${f}:4`]]);
    expect(requests(g, `${DEF}defConfig`)).toEqual([[ep("POST /api/users"), "low", `${f}:8`]]);
    expect(requests(g, `${DEF}defRelative`)).toEqual([[ep("GET /api/users/me"), "low", `${f}:12`]]);
  });

  it("leaves the spike calls whose base comes from the environment unlinked", () => {
    const users = "sym:linking:apps/web/src/features/users.ts#";
    for (const fn of [
      "axiosInstance",
      "kyPrefix",
      "wrapperWithMethodArg",
      "enumPath",
      "constObjectPath",
      "nestedParams",
      "axiosConfig",
    ]) {
      expect(requests(g, `${users}${fn}`), fn).toEqual([]);
    }
    expect(gap(`${users}axiosInstance`)).toEqual([
      ["instance", "dynamic_url", "DELETE <dynamic>"],
      ["instance", "dynamic_url", "GET <dynamic>"],
      ["instance", "dynamic_url", "PUT <dynamic>"],
    ]);
  });
});

describe("default axios base", () => {
  const web = (assignments: string[]) =>
    repo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
      "apps/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { axios: "^1.7.0" } }),
      "apps/web/src/set.ts": `import axios from "axios";\n${assignments.join("\n")}\n`,
      "apps/web/src/call.ts": `import axios from "axios";\nexport function load() {\n  return axios.get("/users");\n}\n`,
      "apps/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { hono: "^4.0.0" } }),
      "apps/api/src/app.ts": `import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/api/users", (c) => c.json([]));\napp.get("/v2/users", (c) => c.json([]));\n`,
    });

  it("two different assignments in a workspace make the calls gaps, the same one twice does not", async () => {
    const two = await indexDir(web(['axios.defaults.baseURL = "/api";', 'axios.defaults.baseURL = "/v2";']));
    expect(requests(two, "sym:repo:apps/web/src/call.ts#load")).toEqual([]);
    expect(
      two.nodes.filter((n) => n.kind === "client_call").map((n) => [n.data.rule, n.data.reason]),
    ).toEqual([["instance", "ambiguous"]]);
    const same = await indexDir(
      web(['axios.defaults.baseURL = "/api";', 'axios.defaults.baseURL = "/api/";']),
    );
    expect(requests(same, "sym:repo:apps/web/src/call.ts#load")).toEqual([
      ["ep:repo:@x/api:GET /api/users", "low", "apps/web/src/call.ts:3"],
    ]);
  });

  it("a base that is not static makes the calls gaps", async () => {
    const g = await indexDir(web(["axios.defaults.baseURL = import.meta.env.VITE_API;"]));
    expect(requests(g, "sym:repo:apps/web/src/call.ts#load")).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "client_call").map((n) => [n.data.rule, n.data.reason])).toEqual([
      ["instance", "dynamic_url"],
    ]);
  });
});

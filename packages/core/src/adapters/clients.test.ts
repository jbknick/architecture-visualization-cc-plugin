import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "../indexer.js";
import { resolvePaths } from "../paths/index.js";
import { openStore } from "../store/index.js";
import type { AdapterNodeRecord, EdgeRecord } from "../types.js";
import { joinUrl, pathScore } from "./clients.js";

const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (
    name: string,
  ) => Promise<{ dir: string; git(args: string[]): string; cleanup(): Promise<void> }>;
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

describe("URL helpers", () => {
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

  it("rule 4: fetch with a template URL and a method option, high", () => {
    expect(requests(g, HOOK)).toContainEqual([
      "ep:adapters:@demo/server:PATCH /api/posts/:id",
      "high",
      "apps/web/src/hooks/usePostActions.ts:16",
    ]);
    expect(g.edges.some((e) => e.kind === "requests" && e.confidence === "low")).toBe(false);
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

  it("links calls on axios and ky instances to the endpoint of the joined URL, high", () => {
    const f = "apps/web/src/features/same-origin.ts";
    expect(requests(g, `${SO}instGet`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:4`]]);
    expect(requests(g, `${SO}instPost`)).toEqual([[ep("POST /api/users"), "high", `${f}:8`]]);
    // The literal `/users/me` beats `/users/:id`.
    expect(requests(g, `${SO}instRequest`)).toEqual([[ep("GET /api/users/me"), "high", `${f}:12`]]);
    expect(requests(g, `${SO}instCall`)).toEqual([[ep("GET /api/orders/:id"), "high", `${f}:16`]]);
    expect(requests(g, `${SO}kyGet`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:20`]]);
    // `kyRelAuth = kyRel.extend({ headers })` keeps the prefix of `kyRel`.
    expect(requests(g, `${SO}kyExtended`)).toEqual([[ep("DELETE /api/users/:id"), "high", `${f}:24`]]);
  });

  it("follows an instance through a re-export", () => {
    expect(requests(g, "sym:linking:apps/web/src/features/reexport.ts#viaReexport")).toEqual([
      [ep("PUT /api/users/:id"), "high", "apps/web/src/features/reexport.ts:4"],
    ]);
  });

  it("reports an instance call that matches no endpoint as a gap", () => {
    expect(requests(g, `${SO}instMissing`)).toEqual([]);
    expect(gap(`${SO}instMissing`)).toEqual([["instance", "no_endpoint", "GET /api/nope"]]);
  });

  it("uses axios.defaults.baseURL of the workspace for the default axios import", () => {
    const f = "apps/legacy-web/src/calls.ts";
    expect(requests(g, `${DEF}defGet`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:4`]]);
    expect(requests(g, `${DEF}defConfig`)).toEqual([[ep("POST /api/users"), "high", `${f}:8`]]);
    expect(requests(g, `${DEF}defRelative`)).toEqual([[ep("GET /api/users/me"), "high", `${f}:12`]]);
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

describe("client wrappers on fixtures/linking", () => {
  let g: Graph;
  beforeAll(async () => {
    const fx = await materializeFixture("linking");
    cleanups.push(() => fx.cleanup());
    g = await indexDir(fx.dir);
  });
  const W = "sym:linking:apps/web/src/features/same-origin-wrappers.ts#";
  const LIB = "sym:linking:apps/web/src/lib/same-origin-http.ts#";
  const f = "apps/web/src/features/same-origin-wrappers.ts";
  const ep = (route: string) => `ep:linking:@fx/users-api:${route}`;
  const gaps = (caller: string) =>
    g.nodes
      .filter((n) => n.kind === "client_call" && n.data.caller === caller)
      .map((n) => [n.data.rule, n.data.reason, n.label, n.data.wrapper]);

  it("links each call of a wrapper to the endpoint its arguments reach, high", () => {
    expect(requests(g, `${W}wGet`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:5`]]);
    expect(requests(g, `${W}wPost`)).toEqual([[ep("POST /api/users"), "high", `${f}:9`]]);
    expect(requests(g, `${W}wMethod`)).toEqual([[ep("DELETE /api/users/:id"), "high", `${f}:13`]]);
    // A wrapper of a wrapper; the literal `/users/me` beats `/users/:id`.
    expect(requests(g, `${W}wHook`)).toEqual([[ep("GET /api/users/me"), "high", `${f}:17`]]);
    // A function whose parameter only fills a later segment is no wrapper: the edge is its own.
    expect(requests(g, `${W}wUser`)).toEqual([]);
    expect(requests(g, `${LIB}getUser`)).toEqual([
      [ep("GET /api/users/:id"), "high", "apps/web/src/lib/same-origin-http.ts:21"],
    ]);
    expect(gaps(`${LIB}getUser`)).toEqual([]);
  });

  it("reports the body of a wrapper as wrapper_body, never as a request", () => {
    for (const fn of ["relFetch", "relRequest", "useRelFetch"]) {
      expect(requests(g, `${LIB}${fn}`), fn).toEqual([]);
      expect(gaps(`${LIB}${fn}`), fn).toEqual([["wrapper", "wrapper_body", `wrapper ${fn}`, `${LIB}${fn}`]]);
    }
  });

  it("links a call of a wrapper the recipe lists, where inference does not see the flow", () => {
    expect(requests(g, `${W}wSend`)).toEqual([[ep("GET /api/users"), "high", `${f}:25`]]);
    const send = "sym:linking:apps/web/src/lib/opaque.ts#send";
    expect(gaps(send)).toEqual([["wrapper", "wrapper_body", "wrapper send", send]]);
  });

  it("without the recipe entry the call in send is a dynamic_url gap and wSend links nothing", async () => {
    const fx = await materializeFixture("linking");
    cleanups.push(() => fx.cleanup());
    const file = join(fx.dir, ".gantry/recipe.json");
    const recipe = JSON.parse(readFileSync(file, "utf8"));
    delete recipe.clientWrappers;
    writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`);
    fx.git(["commit", "-qam", "drop the wrapper entry"]);
    const bare = await indexDir(fx.dir);
    expect(requests(bare, `${W}wSend`)).toEqual([]);
    const send = "sym:linking:apps/web/src/lib/opaque.ts#send";
    expect(
      bare.nodes
        .filter((n) => n.kind === "client_call" && n.data.caller === send)
        .map((n) => [n.data.rule, n.data.reason]),
    ).toEqual([["fetch", "dynamic_url"]]);
  });

  it("gives the same graph on every run", async () => {
    const fx = await materializeFixture("linking");
    cleanups.push(() => fx.cleanup());
    const again = await indexDir(fx.dir);
    expect(JSON.stringify(again)).toBe(JSON.stringify(g));
  });

  it("gaps: an argument that fills the start, or a method that is not static", async () => {
    const code = [
      "export function get(path: string, init?: RequestInit) {\n  return fetch(`/api${path}`, init);\n}",
      "export function viaVar() {\n  const base = process.env.API;\n  return get(`${base}/users`);\n}",
      'export function viaMethod() {\n  const init = makeInit();\n  return get("/users", init);\n}',
      "export function chained(path: string) {\n  return get(path);\n}",
      'export function twice() {\n  return get("/users", { method: "POST" });\n}',
    ].join("\n");
    const r = await indexDir(
      repo({
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        "apps/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { hono: "^4.0.0" } }),
        "apps/api/src/app.ts": `import { Hono } from "hono";\nexport const app = new Hono();\napp.post("/api/users", (c) => c.json([]));\n`,
        "apps/web/package.json": JSON.stringify({ name: "@x/web" }),
        "apps/web/src/c.ts": `${code}\n`,
      }),
    );
    const at = (fn: string) => `sym:repo:apps/web/src/c.ts#${fn}`;
    expect(requests(r, at("twice"))).toEqual([
      ["ep:repo:@x/api:POST /api/users", "high", "apps/web/src/c.ts:16"],
    ]);
    expect(requests(r, at("viaVar"))).toEqual([]);
    // `chained` passes its parameter on, so it is a wrapper itself.
    const gap = (fn: string) =>
      r.nodes
        .filter((n) => n.kind === "client_call" && n.data.caller === at(fn))
        .map((n) => [n.data.reason, n.label]);
    expect(gap("viaVar")).toEqual([["dynamic_url", "GET <dynamic>"]]);
    expect(gap("viaMethod")).toEqual([["dynamic_url", "<dynamic>"]]);
    expect(gap("chained")).toEqual([["wrapper_body", "wrapper chained"]]);
  });
});

describe("constant URLs on fixtures/linking", () => {
  let g: Graph;
  beforeAll(async () => {
    const fx = await materializeFixture("linking");
    cleanups.push(() => fx.cleanup());
    g = await indexDir(fx.dir);
  });
  const C = "sym:linking:apps/web/src/features/same-origin-consts.ts#";
  const f = "apps/web/src/features/same-origin-consts.ts";
  const ep = (route: string) => `ep:linking:@fx/users-api:${route}`;
  const gaps = (caller: string) =>
    g.nodes
      .filter((n) => n.kind === "client_call" && n.data.caller === caller)
      .map((n) => [n.data.rule, n.data.reason, n.label, n.data.candidates]);

  it("links a URL built from consts, enums, `as const` members, `??` and conditionals, high", () => {
    expect(requests(g, `${C}cConst`)).toEqual([[ep("GET /api/orders/:id"), "high", `${f}:6`]]);
    expect(requests(g, `${C}cEnum`)).toEqual([[ep("GET /api/users"), "high", `${f}:10`]]);
    expect(requests(g, `${C}cAsConst`)).toEqual([[ep("GET /api/users/me"), "high", `${f}:14`]]);
    expect(requests(g, `${C}cConcat`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:18`]]);
    expect(requests(g, `${C}cNullish`)).toEqual([[ep("GET /api/users"), "high", `${f}:22`]]);
    expect(requests(g, `${C}cCond`)).toEqual([[ep("GET /api/users/:id"), "high", `${f}:26`]]);
    for (const fn of ["cConst", "cEnum", "cAsConst", "cConcat", "cNullish", "cCond"])
      expect(gaps(`${C}${fn}`), fn).toEqual([]);
  });

  it("`new URL` with an absolute path replaces the path of its base: no endpoint, a gap", () => {
    expect(requests(g, `${C}cNewUrl`)).toEqual([]);
    expect(gaps(`${C}cNewUrl`)).toEqual([["fetch", "no_endpoint", "GET /orders/:param", undefined]]);
  });

  it("a route of two backends is an ambiguous gap with both candidates, never an edge", () => {
    expect(requests(g, `${C}cTwoBackends`)).toEqual([]);
    expect(gaps(`${C}cTwoBackends`)).toEqual([
      ["fetch", "ambiguous", "GET /health", ["ep:linking:@fx/billing:GET /health", ep("GET /health")]],
    ]);
    expect(g.edges.some((e) => e.kind === "requests" && e.dst.startsWith("call:"))).toBe(false);
  });

  it("leaves a URL that starts with an environment member a dynamic_url gap, a relative one a link", () => {
    const users = "sym:linking:apps/web/src/features/users.ts#";
    expect(requests(g, `${users}fullyDynamic`)).toEqual([]);
    expect(gaps(`${users}sameRouteTwoBackends`)).toEqual([
      ["fetch", "dynamic_url", "GET <dynamic>", undefined],
    ]);
    expect(requests(g, `${users}relativeProxy`)).toEqual([
      [ep("GET /api/users"), "high", "apps/web/src/features/users.ts:63"],
    ]);
  });
});

describe("constant URL shapes", () => {
  const web = (files: Record<string, string>) =>
    indexDir(
      repo({
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        "apps/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { hono: "^4.0.0" } }),
        "apps/api/src/app.ts":
          'import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/api/users", (c) => c.json([]));\napp.get("/api/users/:id", (c) => c.json({}));\napp.get("/api/orders/:id", (c) => c.json({}));\n',
        "apps/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { axios: "^1.7.0" } }),
        ...files,
      }),
    );
  const at = (fn: string) => `sym:repo:apps/web/src/c.ts#${fn}`;
  const gaps = (g: Graph, src: string) =>
    g.nodes
      .filter((n) => n.kind === "client_call" && n.data.caller === src)
      .map((n) => [n.data.reason, n.label, n.data.candidates]);

  it("alternatives that fit different endpoints are ambiguous, ones that agree link", async () => {
    const g = await web({
      "apps/web/src/c.ts": [
        'export function differ(a: boolean) {\n  return fetch(a ? "/api/users" : "/api/orders/1");\n}',
        'export function agree(a: boolean) {\n  return fetch(a ? "/api/users" : "/nowhere");\n}',
        'export function same(a: boolean, id: string) {\n  return fetch(a ? `/api/users/${id}` : "/api/users/7");\n}',
      ].join("\n"),
    });
    expect(requests(g, at("differ"))).toEqual([]);
    expect(gaps(g, at("differ"))).toEqual([
      [
        "ambiguous",
        "GET /api/users",
        ["ep:repo:@x/api:GET /api/orders/:id", "ep:repo:@x/api:GET /api/users"],
      ],
    ]);
    expect(requests(g, at("agree")).map((r) => [r[0], r[1]])).toEqual([
      ["ep:repo:@x/api:GET /api/users", "high"],
    ]);
    expect(requests(g, at("same")).map((r) => [r[0], r[1]])).toEqual([
      ["ep:repo:@x/api:GET /api/users/:id", "high"],
    ]);
  });

  it("a part that is not known keeps a unique match from being high: an ambiguous gap", async () => {
    const g = await web({
      "apps/web/src/c.ts":
        'export function load(id: number) {\n  return fetch("/api/users/" + String(id));\n}\n',
    });
    expect(requests(g, at("load"))).toEqual([]);
    expect(gaps(g, at("load"))).toEqual([
      ["ambiguous", "GET /api/users/:param", ["ep:repo:@x/api:GET /api/users/:id"]],
    ]);
  });

  it("evaluates the base of an instance, a const imported from another file", async () => {
    const g = await web({
      "apps/web/src/config.ts": 'export const PREFIX = "/api";\nexport const BASE = PREFIX;\n',
      "apps/web/src/c.ts": [
        'import axios from "axios";',
        'import { BASE } from "./config";',
        "export const rel = axios.create({ baseURL: BASE });",
        'export function load() {\n  return rel.get("/users");\n}',
      ].join("\n"),
    });
    expect(requests(g, at("load")).map((r) => [r[0], r[1]])).toEqual([
      ["ep:repo:@x/api:GET /api/users", "high"],
    ]);
  });

  it("a wrapper argument is evaluated: a const, a conditional", async () => {
    const g = await web({
      "apps/web/src/c.ts": [
        'const USERS = "/users";',
        "export function get(path: string) {\n  return fetch(`/api${path}`);\n}",
        "export function viaConst() {\n  return get(USERS);\n}",
        'export function viaCond(a: boolean) {\n  return get(a ? USERS : "/orders/1");\n}',
      ].join("\n"),
    });
    expect(requests(g, at("viaConst")).map((r) => [r[0], r[1]])).toEqual([
      ["ep:repo:@x/api:GET /api/users", "high"],
    ]);
    expect(requests(g, at("viaCond"))).toEqual([]);
    expect(gaps(g, at("viaCond"))).toEqual([
      [
        "ambiguous",
        "GET /api/users",
        ["ep:repo:@x/api:GET /api/orders/:id", "ep:repo:@x/api:GET /api/users"],
      ],
    ]);
  });
});

describe("client wrapper shapes", () => {
  const web = (files: Record<string, string>) =>
    indexDir(
      repo({
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        "apps/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { hono: "^4.0.0" } }),
        "apps/api/src/app.ts":
          'import { Hono } from "hono";\nexport const app = new Hono();\napp.get("/api/users", (c) => c.json([]));\napp.get("/api/users/:id", (c) => c.json({}));\napp.post("/api/users", (c) => c.json({}));\n',
        "apps/web/package.json": JSON.stringify({ name: "@x/web" }),
        ...files,
      }),
    );
  const at = (fn: string, file = "c.ts") => `sym:repo:apps/web/src/${file}#${fn}`;
  const reqs = (g: Graph, src: string) => requests(g, src).map((r) => [r[0], r[1]]);
  const gaps = (g: Graph, src: string) =>
    g.nodes
      .filter((n) => n.kind === "client_call" && n.data.caller === src)
      .map((n) => [n.data.rule, n.data.reason, n.label]);

  it("text ending in a slash: a wrapper when a call passes a slash, else the parameter fills a segment", async () => {
    const g = await web({
      "apps/web/src/c.ts": [
        "export function api(path: string) {\n  return fetch(`/api/${path}`);\n}",
        'export function a1() {\n  return api("users");\n}',
        'export function a2() {\n  return api("/users/7");\n}',
        "export function getUser(id: string) {\n  return fetch(`/api/users/${id}`);\n}",
        'export function g1() {\n  return getUser("7");\n}',
      ].join("\n"),
    });
    // `api` is a wrapper: no rule 4 edge from its body, the calls link.
    expect(reqs(g, at("api"))).toEqual([]);
    expect(gaps(g, at("api"))).toEqual([["wrapper", "wrapper_body", "wrapper api"]]);
    expect(reqs(g, at("a1"))).toEqual([["ep:repo:@x/api:GET /api/users", "high"]]);
    expect(reqs(g, at("a2"))).toEqual([["ep:repo:@x/api:GET /api/users/:id", "high"]]);
    // `getUser` is called with no slash: it stays a rule 4 link of its own.
    expect(reqs(g, at("getUser"))).toEqual([["ep:repo:@x/api:GET /api/users/:id", "high"]]);
    expect(gaps(g, at("getUser"))).toEqual([]);
    expect(reqs(g, at("g1"))).toEqual([]);
  });

  it("skips a leading base and drops it at the calls", async () => {
    const g = await web({
      "apps/web/src/c.ts": [
        "const BASE = process.env.API_URL;",
        "export function viaBase(path: string) {\n  return fetch(`${BASE}/${path}`);\n}",
        "export function viaBase2(path: string) {\n  return fetch(`${BASE}${path}`);\n}",
        'export function b1() {\n  return viaBase("api/users");\n}',
        'export function b2() {\n  return viaBase2("/api/users");\n}',
      ].join("\n"),
    });
    expect(reqs(g, at("viaBase"))).toEqual([]);
    expect(gaps(g, at("viaBase"))).toEqual([["wrapper", "wrapper_body", "wrapper viaBase"]]);
    expect(reqs(g, at("viaBase2"))).toEqual([]);
    expect(reqs(g, at("b1"))).toEqual([["ep:repo:@x/api:GET /api/users", "high"]]);
    expect(reqs(g, at("b2"))).toEqual([["ep:repo:@x/api:GET /api/users", "high"]]);
  });

  it("a function whose qualifying requests disagree makes each of its calls a gap", async () => {
    const g = await web({
      "apps/web/src/c.ts": [
        'import axios from "axios";',
        'export const rel = axios.create({ baseURL: "/api" });',
        "export function pick(path: string, method?: string) {\n  if (method) return rel.request({ url: path, method });\n  return rel.get(path);\n}",
        'export function p1() {\n  return pick("/users");\n}',
        'export function p2() {\n  return pick("/users", "POST");\n}',
      ].join("\n"),
    });
    expect(reqs(g, at("p1"))).toEqual([]);
    expect(reqs(g, at("p2"))).toEqual([]);
    expect(gaps(g, at("p1"))).toEqual([["wrapper", "dynamic_url", "pick <dynamic>"]]);
    expect(gaps(g, at("p2"))).toEqual([["wrapper", "dynamic_url", "pick <dynamic>"]]);
    expect(reqs(g, at("pick"))).toEqual([]);
    expect(gaps(g, at("pick"))).toEqual([["wrapper", "wrapper_body", "wrapper pick"]]);
  });

  it("finds a default-exported wrapper, named or anonymous, imported under another name", async () => {
    const g = await web({
      "apps/web/src/named.ts":
        "export default function apiFetch(path: string, init?: RequestInit) {\n  return fetch(`/api${path}`, init);\n}\n",
      "apps/web/src/anon.ts": "export default (path: string) => fetch(`/api${path}`);\n",
      "apps/web/src/use.ts": [
        'import call from "./named";',
        'import other from "./anon";',
        'export function n1() {\n  return call("/users", { method: "POST" });\n}',
        'export function n2() {\n  return other("/users");\n}',
      ].join("\n"),
    });
    expect(reqs(g, at("n1", "use.ts"))).toEqual([["ep:repo:@x/api:POST /api/users", "high"]]);
    expect(reqs(g, at("n2", "use.ts"))).toEqual([["ep:repo:@x/api:GET /api/users", "high"]]);
    expect(reqs(g, at("apiFetch", "named.ts"))).toEqual([]);
    expect(gaps(g, at("apiFetch", "named.ts"))).toEqual([["wrapper", "wrapper_body", "wrapper apiFetch"]]);
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
      ["ep:repo:@x/api:GET /api/users", "high", "apps/web/src/call.ts:3"],
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

describe("rule 3 reads Hono endpoints only", () => {
  it("does not link an hc chain to an endpoint another framework made", async () => {
    const recipe = {
      version: 1,
      dependencies: [
        { name: "express", workspace: "@x/api", role: "framework", note: "HTTP framework" },
        { name: "hono", workspace: "@x/web", role: "neither", note: "client types" },
      ],
      helpers: [],
      passthrough: [],
      rules: [
        {
          id: "express-app",
          language: "typescript",
          when: { dependency: ["express"] },
          rule: { pattern: "express($$$A)" },
          emit: { kind: "router", data: { adapter: "express" } },
          examples: { match: ["const app = express();"], noMatch: ["const app = new Map();"] },
        },
        {
          id: "express-route",
          language: "typescript",
          when: { dependency: ["express"] },
          rule: { pattern: "$APP.$M($P, $$$H)" },
          constraints: {
            M: { regex: "^(get|post)$" },
            P: { kind: "string" },
          },
          emit: {
            kind: "endpoint",
            receiver: "$APP",
            method: "$M",
            path: "$P",
            handler: "$$$H",
            data: { adapter: "express" },
          },
          examples: { match: ['app.get("/api/posts", list);'], noMatch: ["cache.has(k);"] },
        },
      ],
    };
    const g = await indexDir(
      repo({
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        ".gantry/recipe.json": JSON.stringify(recipe),
        "apps/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { express: "^4.0.0" } }),
        "apps/api/src/app.ts": 'const app = express();\napp.get("/api/posts", (req, res) => res.json([]));\n',
        "apps/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { hono: "^4.0.0" } }),
        "apps/web/src/client.ts":
          'import { hc } from "hono/client";\nexport const client = hc("/");\nexport function load() {\n  return client.api.posts.$get();\n}\n',
      }),
    );
    expect(g.nodes.filter((n) => n.kind === "endpoint").map((n) => [n.data.adapter, n.label])).toEqual([
      ["express", "GET /api/posts"],
    ]);
    expect(requests(g, "sym:repo:apps/web/src/client.ts#load")).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "client_call").map((n) => [n.data.rule, n.data.reason])).toEqual([
      ["hono", "no_endpoint"],
    ]);
  });
});

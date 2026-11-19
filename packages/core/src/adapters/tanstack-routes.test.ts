import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../types.js";
import {
  detectTanstackRoutes,
  mapRouteFile,
  parentRouteId,
  readRouteCall,
  routesDirectoryFor,
  urlPathOfRouteId,
} from "./tanstack-routes.js";

// The table of record for the file naming rules (https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions).
// [file relative to the routes directory, route id, URL path]
const TABLE: [string, string, string][] = [
  ["index.tsx", "/", "/"],
  ["about.tsx", "/about", "/about"],
  ["posts.tsx", "/posts", "/posts"],
  ["posts.index.tsx", "/posts/", "/posts"],
  ["posts/index.tsx", "/posts/", "/posts"],
  ["posts.$postId.tsx", "/posts/$postId", "/posts/$postId"],
  ["posts/$postId.tsx", "/posts/$postId", "/posts/$postId"],
  ["settings/profile.tsx", "/settings/profile", "/settings/profile"],
  ["blog.post.tsx", "/blog/post", "/blog/post"],
  ["blog/post/route.tsx", "/blog/post", "/blog/post"],
  ["blog.post.route.tsx", "/blog/post", "/blog/post"],
  ["account/route.tsx", "/account", "/account"],
  ["account/overview.tsx", "/account/overview", "/account/overview"],
  ["files.$.tsx", "/files/$", "/files/$"],
  ["$.tsx", "/$", "/$"],
  // Pathless layouts: a leading underscore stays in the id, not in the URL.
  ["_app.tsx", "/_app", "/"],
  ["_app.a.tsx", "/_app/a", "/a"],
  ["_app/b.tsx", "/_app/b", "/b"],
  ["_app/index.tsx", "/_app/", "/"],
  ["_app/route.tsx", "/_app", "/"],
  // Route groups are left out of the URL.
  ["(marketing)/pricing.tsx", "/(marketing)/pricing", "/pricing"],
  ["(marketing)/_layout/faq.tsx", "/(marketing)/_layout/faq", "/faq"],
  // A trailing underscore takes the route out of its parent's nesting; the URL keeps the segment.
  ["posts_.$postId.edit.tsx", "/posts_/$postId/edit", "/posts/$postId/edit"],
  // Brackets make special characters literal.
  ["script[.]js.tsx", "/script.js", "/script.js"],
  ["api[.]v1.tsx", "/api.v1", "/api.v1"],
  ["a/b.c.d.tsx", "/a/b/c/d", "/a/b/c/d"],
  ["x.ts", "/x", "/x"],
];

describe("mapRouteFile (file -> route id -> URL path)", () => {
  it.each(TABLE)("%s", (file, routeId, urlPath) => {
    const m = mapRouteFile(file);
    expect(m).not.toBeNull();
    expect(m?.routeId).toBe(routeId);
    expect(m?.urlPath).toBe(urlPath);
    expect(m?.root).toBe(false);
  });

  it("__root is the root layout", () => {
    expect(mapRouteFile("__root.tsx")).toMatchObject({ root: true, routeId: "__root__", urlPath: "/" });
  });

  it("marks index and pathless routes", () => {
    expect(mapRouteFile("posts.index.tsx")).toMatchObject({ index: true, pathless: false });
    expect(mapRouteFile("_app.tsx")).toMatchObject({ index: false, pathless: true });
    expect(mapRouteFile("(g)/x.tsx")).toMatchObject({ pathless: false });
    expect(mapRouteFile("_app.a.tsx")).toMatchObject({ pathless: false });
  });

  it.each([
    "-components/Button.tsx", // `-` prefixed folder
    "posts/-helpers.ts", // `-` prefixed file
    "-x.tsx",
    "posts.lazy.tsx", // lazy parts are not route definitions
    "readme.md",
    "types.d.ts",
    "data.json",
  ])("ignores %s", (file) => {
    expect(mapRouteFile(file)).toBeNull();
  });

  it("urlPathOfRouteId applies the same rules to a createFileRoute id", () => {
    expect(urlPathOfRouteId("/_app/a")).toBe("/a");
    expect(urlPathOfRouteId("/posts/")).toBe("/posts");
    expect(urlPathOfRouteId("/(g)/x")).toBe("/x");
    expect(urlPathOfRouteId("/")).toBe("/");
    expect(urlPathOfRouteId("__root__")).toBe("/");
  });
});

describe("parentRouteId", () => {
  const ids = new Set([
    "__root__",
    "/",
    "/posts",
    "/posts/",
    "/posts/$postId",
    "/_app",
    "/_app/a",
    "/posts_/$id/edit",
  ]);
  it.each([
    ["/", "__root__"],
    ["/posts", "__root__"],
    ["/posts/", "/posts"],
    ["/posts/$postId", "/posts"],
    ["/posts/$postId/edit", "/posts/$postId"],
    ["/_app/a", "/_app"],
    ["/_app/zzz", "/_app"],
    ["/posts_/$id/edit", "__root__"], // trailing underscore: not nested under /posts
    ["/other/deep/er", "__root__"],
  ])("%s -> %s", (id, parent) => {
    expect(parentRouteId(id, ids)).toBe(parent);
  });
  it("the root has no parent, and a tree without a root has none for top-level routes", () => {
    expect(parentRouteId("__root__", ids)).toBeUndefined();
    expect(parentRouteId("/a", new Set(["/a"]))).toBeUndefined();
  });
});

describe("readRouteCall", () => {
  const read = (src: string) => readRouteCall("r.tsx", src);
  it("reads component, loader and beforeLoad as identifiers, inline functions or expressions", () => {
    const r = read(
      `export const Route = createFileRoute("/p")({ component: Page, loader: async () => 1, beforeLoad() {}, head: () => ({}) });`,
    );
    expect(r).toMatchObject({
      idArg: "/p",
      root: false,
      options: {
        component: "Page",
        loader: "inline",
        beforeLoad: "inline",
        keys: ["beforeLoad", "component", "head", "loader"],
      },
    });
  });
  it("reads shorthand properties and wrapped values", () => {
    const r = read(`export const Route = createFileRoute("/p")({ component, loader: lazy(() => x) });`);
    expect(r?.options).toMatchObject({ component: "component", loader: "expression" });
  });
  it("reads createRootRoute and createRootRouteWithContext", () => {
    expect(read(`export const Route = createRootRoute({ component: Root });`)).toMatchObject({
      root: true,
      options: { component: "Root" },
    });
    expect(
      read(`export const Route = createRootRouteWithContext<Ctx>()({ component: Root });`),
    ).toMatchObject({
      root: true,
    });
  });
  it("handles a createFileRoute call without a path", () => {
    const r = read(`export const Route = createFileRoute()({ component: A });`);
    expect(r?.idArg).toBeUndefined();
    expect(r?.options.component).toBe("A");
  });
  it("returns null for files that define no route", () => {
    expect(read(`export const x = 1;`)).toBeNull();
    expect(read(`export const Route = createLazyFileRoute("/p")({ component: A });`)).toBeNull();
  });
});

describe("routesDirectoryFor", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ws = (dir: string): WorkspaceRecord => ({
    id: "ws:@a/web",
    name: "@a/web",
    dir,
    kind: "app",
    frameworks: ["@tanstack/react-router"],
    deps: [],
    exportsMap: null,
  });
  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "gantry-routes-"));
    dirs.push(root);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    return root;
  };

  it("defaults to src/routes", () => {
    expect(routesDirectoryFor(repo({}), ws("apps/web"))).toBe("apps/web/src/routes");
  });
  it("reads tsr.config.json", () => {
    const root = repo({ "apps/web/tsr.config.json": '{"routesDirectory": "./app/pages"}' });
    expect(routesDirectoryFor(root, ws("apps/web"))).toBe("apps/web/app/pages");
  });
  it("reads routesDirectory from a Vite config as text", () => {
    const root = repo({
      "apps/web/vite.config.ts":
        'export default { plugins: [tanstackRouter({ routesDirectory: "src/screens", target: "react" })] };',
    });
    expect(routesDirectoryFor(root, ws("apps/web"))).toBe("apps/web/src/screens");
  });
  it("tsr.config.json wins, and a root workspace has no prefix", () => {
    const root = repo({
      "tsr.config.json": '{"routesDirectory": "src/a"}',
      "vite.config.ts": 'x({ routesDirectory: "src/b" })',
    });
    expect(routesDirectoryFor(root, ws("."))).toBe("src/a");
  });
});

describe("detectTanstackRoutes", () => {
  const web: WorkspaceRecord = {
    id: "ws:@a/web",
    name: "@a/web",
    dir: "apps/web",
    kind: "app",
    frameworks: ["react", "@tanstack/react-router"],
    deps: [],
    exportsMap: null,
  };
  const lib: WorkspaceRecord = {
    ...web,
    id: "ws:@a/lib",
    name: "@a/lib",
    dir: "packages/lib",
    kind: "package",
  };
  const src = (path: string, source: string) => ({
    path: `apps/web/src/routes/${path}`,
    id: `file:repo:apps/web/src/routes/${path}`,
    workspaceId: web.id,
    source,
  });
  const run = (files: ReturnType<typeof src>[], workspaces = [web, lib]) =>
    detectTanstackRoutes({
      root: "/nonexistent",
      repo: "repo",
      workspaces,
      files,
      parsed: { get: () => undefined },
      resolver: { resolveSpecifier: () => ({ kind: "unresolved" }), resolveSymbol: () => null },
    });

  it("emits nodes and contains edges for a nested tree, ignoring non-route files", () => {
    const r = run([
      src("__root.tsx", "export const Route = createRootRoute({ component: R });"),
      src("index.tsx", 'export const Route = createFileRoute("/")({});'),
      src("posts.tsx", 'export const Route = createFileRoute("/posts")({});'),
      src("posts.$postId.tsx", 'export const Route = createFileRoute("/posts/$postId")({ loader: load });'),
      src("-ignored.tsx", 'export const Route = createFileRoute("/ignored")({});'),
      src("helper.tsx", "export const h = 1;"),
    ]);
    expect(r.nodes.map((n) => [n.id, n.label])).toEqual([
      ["route:repo:@a/web:/", "/"],
      ["route:repo:@a/web:/posts", "/posts"],
      ["route:repo:@a/web:/posts/$postId", "/posts/$postId"],
      ["route:repo:@a/web:__root__", "__root"],
    ]);
    expect(r.nodes.find((n) => n.id.endsWith("$postId"))?.data).toMatchObject({
      loader: "load",
      urlPath: "/posts/$postId",
    });
    expect(r.edges.map((e) => `${e.src} > ${e.dst} ${e.kind}`)).toEqual([
      "route:repo:@a/web:__root__ > route:repo:@a/web:/ contains",
      "route:repo:@a/web:__root__ > route:repo:@a/web:/posts contains",
      "route:repo:@a/web:/posts > route:repo:@a/web:/posts/$postId contains",
    ]);
    expect(r.edges.every((e) => e.fileId.startsWith("file:repo:apps/web/src/routes/"))).toBe(true);
  });

  it("uses the createFileRoute argument as the id when it differs from the file name", () => {
    const r = run([src("whatever.tsx", 'export const Route = createFileRoute("/custom/path")({});')]);
    expect(r.nodes.map((n) => n.id)).toEqual(["route:repo:@a/web:/custom/path"]);
  });

  it("skips workspaces that are not apps using TanStack Router", () => {
    const f = {
      ...src("a.tsx", 'export const Route = createFileRoute("/a")({});'),
      workspaceId: lib.id,
      path: "packages/lib/src/routes/a.tsx",
    };
    expect(run([f]).nodes).toEqual([]);
  });

  it("a root-level file in a root workspace maps relative to the routes directory", () => {
    const rootWs: WorkspaceRecord = { ...web, id: "ws:.", name: "root", dir: "." };
    const r = detectTanstackRoutes({
      root: "/nonexistent",
      repo: "repo",
      workspaces: [rootWs],
      files: [
        {
          path: "src/routes/index.tsx",
          id: "file:repo:src/routes/index.tsx",
          workspaceId: "ws:.",
          source: 'export const Route = createFileRoute("/")({});',
        },
      ],
      parsed: { get: () => undefined },
      resolver: { resolveSpecifier: () => ({ kind: "unresolved" }), resolveSymbol: () => null },
    });
    expect(r.nodes.map((n) => n.id)).toEqual(["route:repo:.:/"]);
  });
});

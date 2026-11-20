import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../../types.js";
import { mapRouteFile, parentRouteId, routesDirectoryFor, urlPathOfRouteId } from "./fs-routes.js";

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

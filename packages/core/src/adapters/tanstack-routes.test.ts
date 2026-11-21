import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../types.js";
import { detectTanstackRoutes, readRouteCall } from "./tanstack-routes.js";

// The table of record for the file naming rules (https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions).

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

describe("detectTanstackRoutes", () => {
  const web: WorkspaceRecord = {
    id: "ws:repo:@a/web",
    name: "@a/web",
    dir: "apps/web",
    kind: "app",
    frameworks: ["react", "@tanstack/react-router"],
    deps: [],
    exportsMap: null,
  };
  const lib: WorkspaceRecord = {
    ...web,
    id: "ws:repo:@a/lib",
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
    const rootWs: WorkspaceRecord = { ...web, id: "ws:repo:.", name: "root", dir: "." };
    const r = detectTanstackRoutes({
      root: "/nonexistent",
      repo: "repo",
      workspaces: [rootWs],
      files: [
        {
          path: "src/routes/index.tsx",
          id: "file:repo:src/routes/index.tsx",
          workspaceId: "ws:repo:.",
          source: 'export const Route = createFileRoute("/")({});',
        },
      ],
      parsed: { get: () => undefined },
      resolver: { resolveSpecifier: () => ({ kind: "unresolved" }), resolveSymbol: () => null },
    });
    expect(r.nodes.map((n) => n.id)).toEqual(["route:repo:.:/"]);
  });
});

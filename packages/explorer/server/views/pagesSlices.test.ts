import { rmSync } from "node:fs";
import type { GantryConfig, GantryPaths, Store } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError, handleApi } from "../api.js";
import { fixtureStore } from "../testkit.js";
import type { ApiContext, ViewResult } from "../types.js";
import type { PagesResult } from "./pages.js";
import type { SlicesResult } from "./slices.js";

let ctx: ApiContext;
let store: Store;
let dir: string;

beforeAll(() => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  ctx = { store, paths: { root: dir } as GantryPaths, config: {} as GantryConfig };
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = <T extends ViewResult>(id: string, qs = "", c: ApiContext = ctx): T =>
  handleApi(c, `/api/view/${id}`, new URLSearchParams(qs)) as T;
const edgeLines = (r: ViewResult) => r.edges.map((e) => `${e.src} ${e.kind} ${e.dst}`);

const WEB = "route:@acme/web:";
const sym = (p: string, n: string) => `sym:${p}#${n}`;
const BUTTON = sym("packages/ui/src/button.tsx", "Button");

describe("pages view", () => {
  it("shows / , /posts/$postId and /settings/profile with their components and the shared Button", () => {
    const r = run<PagesResult>("pages");
    expect(r.layoutHint).toBe("tree-lr");
    const routes = r.nodes.filter((n) => n.kind === "route");
    expect(routes.map((n) => n.label)).toEqual(["/", "/posts/$postId", "/settings/profile", "__root"]);
    const lines = edgeLines(r);
    for (const [route, comp] of [
      ["/", sym("apps/web/src/routes/index.tsx", "HomePage")],
      ["/posts/$postId", sym("apps/web/src/routes/posts.$postId.tsx", "PostPage")],
      ["/settings/profile", sym("apps/web/src/routes/settings/profile.tsx", "ProfilePage")],
    ] as const) {
      expect(lines).toContain(`${WEB}${route} serves ${comp}`);
    }
    // The route tree: the root layout contains the three pages.
    for (const p of ["/", "/posts/$postId", "/settings/profile"])
      expect(lines).toContain(`${WEB}__root__ contains ${WEB}${p}`);
    // Button is one node with two incoming edges (home page and profile page).
    expect(r.nodes.filter((n) => n.id === BUTTON)).toHaveLength(1);
    expect(r.edges.filter((e) => e.dst === BUTTON && e.kind === "renders").map((e) => e.src)).toEqual([
      sym("apps/web/src/routes/index.tsx", "HomePage"),
      sym("apps/web/src/routes/settings/profile.tsx", "ProfilePage"),
    ]);
    expect(r.nodes.find((n) => n.id === BUTTON)?.badges).toContain("shared by 2");
    // The route's own `Route` constant is not drawn as a hook target.
    expect(r.nodes.some((n) => n.label === "Route")).toBe(false);
  });

  it("hops limit how far renders and uses_hook edges are followed", () => {
    const names = (qs: string) => run<PagesResult>("pages", qs).nodes.map((n) => n.label);
    expect(names("hops=1")).toContain("PostList");
    expect(names("hops=1")).not.toContain("useDebounce");
    expect(names("hops=2")).toContain("useDebounce");
    expect(names("depth=4")).toContain("useDebounce");
    expect(() => run("pages", "hops=0")).toThrow(HttpError);
    expect(() => run("pages", "hops=5")).toThrow(HttpError);
  });

  it("filters by route prefix (keeping ancestors) and by app", () => {
    const r = run<PagesResult>("pages", "filters=prefix=/settings");
    expect(r.nodes.filter((n) => n.kind === "route").map((n) => n.label)).toEqual([
      "/settings/profile",
      "__root",
    ]);
    expect(run<PagesResult>("pages", "filters=prefix=/set").nodes.some((n) => n.kind === "route")).toBe(
      false,
    );
    const none = run<PagesResult>("pages", "filters=app=@acme/api");
    expect(none.nodes).toEqual([]);
    // The app list does not depend on the filter.
    expect(none.apps.map((a) => a.id)).toEqual(["ws:@acme/web"]);
    expect(run<PagesResult>("pages", "filters=app=@acme/web").nodes.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(run("pages"))).toBe(JSON.stringify(run("pages")));
  });
});

describe("slices view", () => {
  it("uses the packages/* glob and falls back to first-level route segments for the app", () => {
    const r = run<SlicesResult>("slices");
    expect(r.layoutHint).toBe("nested-elk");
    expect(r.routeFallback).toEqual(["ws:@acme/web"]);
    expect(r.nodes.filter((n) => n.kind === "slice").map((n) => n.id)).toEqual([
      "slice:apps/web#/",
      "slice:apps/web#/posts",
      "slice:apps/web#/settings",
      "slice:packages/db",
      "slice:packages/ui",
      "slice:packages/utils",
    ]);
    expect(r.nodes.find((n) => n.id === "slice:apps/web#/settings")?.label).toBe("web /settings");
    const file = r.nodes.find((n) => n.id === "file:apps/web/src/routes/posts.$postId.tsx");
    expect(file?.parent).toBe("slice:apps/web#/posts");
    // Files outside every slice (apps/web's components, apps/api) are left out.
    expect(r.nodes.some((n) => n.id.includes("components/PostList"))).toBe(false);
    expect(r.nodes.some((n) => n.id.startsWith("file:apps/api"))).toBe(false);
  });

  it("shows cross-slice imports with the right counts, and hides imports inside a slice", () => {
    const r = run<SlicesResult>("slices");
    const sliceEdges = r.edges
      .filter((e) => e.src.startsWith("slice:"))
      .map((e) => `${e.src} -> ${e.dst} = ${e.weight}`);
    expect(sliceEdges).toEqual([
      "slice:apps/web#/posts -> slice:packages/db = 1",
      "slice:apps/web#/posts -> slice:packages/utils = 1",
      "slice:apps/web#/settings -> slice:packages/ui = 2",
      "slice:apps/web#/ -> slice:packages/ui = 1",
    ]);
    expect(r.edges.every((e) => e.cross === true)).toBe(true);
    // packages/ui/src/index.ts re-exports button and card (inside one slice): not drawn.
    expect(r.edges.some((e) => e.src.startsWith("file:packages/ui"))).toBe(false);
    const withIntra = run<SlicesResult>("slices", "filters=intra=true");
    const intra = withIntra.edges.filter((e) => e.cross === false);
    expect(intra.length).toBeGreaterThan(0);
    expect(intra.every((e) => e.src.startsWith("file:packages/"))).toBe(true);
    expect(intra.some((e) => e.src.startsWith("file:packages/ui"))).toBe(true);
  });

  it("lists functions used from at least two slices", () => {
    const r = run<SlicesResult>("slices");
    expect(r.shared.map((s) => s.id)).toEqual([BUTTON]);
    expect(r.shared[0]?.slice).toBe("slice:packages/ui");
    expect(r.shared[0]?.usedBy.map((u) => u.id)).toEqual(["slice:apps/web#/", "slice:apps/web#/settings"]);
  });

  it("levels: slices only, files, functions", () => {
    const slicesOnly = run<SlicesResult>("slices", "level=workspaces");
    expect(slicesOnly.nodes.every((n) => n.kind === "slice")).toBe(true);
    expect(slicesOnly.edges.find((e) => e.src === "slice:apps/web#/settings")?.weight).toBe(2);
    const fns = run<SlicesResult>("slices", "level=symbols");
    expect(fns.nodes.find((n) => n.id === BUTTON)?.parent).toBe("file:packages/ui/src/button.tsx");
    expect(run<SlicesResult>("slices").nodes.some((n) => n.id === BUTTON)).toBe(false);
  });

  it("follows the views.slices config: a matching glob replaces the route fallback for that app", () => {
    const c: ApiContext = {
      ...ctx,
      config: { views: { slices: ["apps/*/src/*", "packages/*"] } } as GantryConfig,
    };
    const r = run<SlicesResult>("slices", "", c);
    expect(r.routeFallback).toEqual([]);
    const ids = r.nodes.filter((n) => n.kind === "slice").map((n) => n.id);
    expect(ids).toContain("slice:apps/web/src/routes");
    expect(ids).toContain("slice:apps/web/src/components");
    expect(ids).toContain("slice:apps/web/src/hooks");
    // components -> hooks and lib are cross-slice imports now.
    expect(
      r.edges.some((e) => e.src === "slice:apps/web/src/components" && e.dst === "slice:apps/web/src/hooks"),
    ).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(run("slices"))).toBe(JSON.stringify(run("slices")));
  });
});

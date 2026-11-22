import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaces, flattenExports, workspaceForPath } from "./index.js";

const config = { workspaces: { overrides: {} as Record<string, { kind?: "app" | "package" }> } };
const dirs: string[] = [];

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gantry-ws-"));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof c === "string" ? c : JSON.stringify(c));
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const uiExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" },
  "./button": { default: "./dist/button.js" },
};

describe("detectWorkspaces", () => {
  it("handles pnpm workspaces", () => {
    const root = repo({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"packages/*\" # libs\n  - '!packages/skip'\n",
      "apps/web/package.json": { name: "@acme/web", dependencies: { react: "1", next: "1" } },
      "packages/ui/package.json": {
        name: "@acme/ui",
        exports: uiExports,
        dependencies: { react: "1" },
        devDependencies: { vitest: "1" },
      },
      "packages/skip/package.json": { name: "@acme/skip" },
      "node_modules/x/package.json": { name: "x" },
      ".claude/worktrees/a/package.json": { name: "nested" },
    });
    const ws = detectWorkspaces(root, config, "repo");
    expect(ws.map((w) => [w.id, w.dir, w.kind])).toEqual([
      ["ws:repo:.", ".", "unknown"],
      ["ws:repo:@acme/web", "apps/web", "app"],
      ["ws:repo:@acme/ui", "packages/ui", "package"],
    ]);
    const ui = ws.find((w) => w.name === "@acme/ui");
    expect(ui?.deps).toEqual(["react", "vitest"]);
    expect(ui?.frameworks).toEqual(["react"]);
    expect(ws.find((w) => w.name === "@acme/web")?.frameworks).toEqual(["react", "next"]);
  });

  it("flattens @acme/ui exports to . and ./button only", () => {
    const root = repo({
      "package.json": { name: "r", workspaces: ["packages/*"] },
      "packages/ui/package.json": {
        name: "@acme/ui",
        exports: uiExports,
        types: "./dist/index.d.ts",
        main: "./dist/index.js",
      },
    });
    const ui = detectWorkspaces(root, config, "repo").find((w) => w.id === "ws:repo:@acme/ui");
    expect(ui?.exportsMap).toEqual([
      { subpath: ".", target: "./dist/index.js" },
      { subpath: "./button", target: "./dist/button.js" },
    ]);
    expect(ui?.main).toBe("./dist/index.js");
    expect(ui?.types).toBe("./dist/index.d.ts");
  });

  it("handles npm workspaces array and yarn { packages }", () => {
    for (const workspaces of [["libs/*"], { packages: ["libs/*"] }]) {
      const root = repo({
        "package.json": { name: "r", workspaces },
        "libs/a/package.json": { name: "a" },
        "libs/b/package.json": { name: "b", main: "x.js" },
      });
      const ws = detectWorkspaces(root, config, "repo");
      expect(ws.map((w) => w.id)).toEqual(["ws:repo:.", "ws:repo:a", "ws:repo:b"]);
      expect(ws.map((w) => w.kind)).toEqual(["unknown", "package", "package"]);
    }
  });

  it("handles Nx project.json", () => {
    const root = repo({
      "package.json": { name: "r" },
      "nx.json": {},
      "apps/shop/project.json": { name: "shop" },
      "libs/core/project.json": { name: "core" },
      "libs/core/package.json": { name: "@acme/core" },
      "node_modules/z/project.json": { name: "z" },
    });
    const ws = detectWorkspaces(root, config, "repo");
    expect(ws.map((w) => [w.id, w.kind])).toEqual([
      ["ws:repo:.", "unknown"],
      ["ws:repo:shop", "app"],
      ["ws:repo:@acme/core", "package"],
    ]);
  });

  it("follows tsconfig project references transitively, once each, inside the repo", () => {
    const root = repo({
      "package.json": { name: "root" },
      "tsconfig.json": `{
        // comments and trailing commas are allowed
        "files": [],
        "references": [{ "path": "./packages/a" }, { "path": "./tsconfig.web.json", }, { "path": "../outside" }],
      }`,
      "tsconfig.web.json": { references: [{ path: "./apps/web/tsconfig.app.json" }] },
      "packages/a/package.json": { name: "@acme/a" },
      "packages/a/tsconfig.json": { references: [{ path: "../b" }] },
      "packages/b/tsconfig.json": { references: [{ path: "../a" }, { path: "../../node_modules/x" }] },
      "apps/web/tsconfig.app.json": {},
      "node_modules/x/tsconfig.json": {},
    });
    const ws = detectWorkspaces(root, config, "repo");
    expect(ws.map((w) => [w.id, w.dir])).toEqual([
      ["ws:repo:.", "."],
      ["ws:repo:apps/web", "apps/web"],
      ["ws:repo:@acme/a", "packages/a"],
      ["ws:repo:packages/b", "packages/b"],
    ]);
  });

  it("ignores a reference through a symlink that points outside the repo", () => {
    const outside = repo({ "tsconfig.json": {} });
    const root = repo({
      "package.json": { name: "root" },
      "tsconfig.json": { references: [{ path: "./linked" }, { path: "./real" }] },
      "real/tsconfig.json": {},
    });
    symlinkSync(outside, join(root, "linked"));
    expect(detectWorkspaces(root, config, "repo").map((w) => w.dir)).toEqual([".", "real"]);
  });

  it("prefers Nx projects over tsconfig references", () => {
    const root = repo({
      "package.json": { name: "root" },
      "tsconfig.json": { references: [{ path: "./libs/x" }] },
      "libs/x/tsconfig.json": {},
      "libs/y/project.json": { name: "y" },
    });
    expect(detectWorkspaces(root, config, "repo").map((w) => w.dir)).toEqual([".", "libs/y"]);
  });

  it("makes every package.json directory a workspace when no tool names them", () => {
    const root = repo({
      "package.json": { name: "plain-root" },
      "server/package.json": { name: "@plain/server" },
      "tools/scripts/package.json": { name: "@plain/scripts" },
      "node_modules/x/package.json": { name: "x" },
      "dist/pkg/package.json": { name: "built" },
      "server/build/package.json": { name: "built-too" },
    });
    expect(detectWorkspaces(root, config, "repo").map((w) => [w.dir, w.name])).toEqual([
      [".", "plain-root"],
      ["server", "@plain/server"],
      ["tools/scripts", "@plain/scripts"],
    ]);
  });

  it("skips a package.json that git ignores", () => {
    const root = repo({
      "package.json": { name: "plain-root" },
      ".gitignore": "scratch/\n",
      "a/package.json": { name: "a" },
      "scratch/b/package.json": { name: "b" },
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(detectWorkspaces(root, config, "repo").map((w) => w.dir)).toEqual([".", "a"]);
  });

  it("stays one workspace when only the root has a package.json", () => {
    const root = repo({ "package.json": { name: "solo" }, "src/x.ts": "" });
    expect(detectWorkspaces(root, config, "repo")).toHaveLength(1);
  });

  it("uses only the globs of a pnpm workspace file, not every package.json", () => {
    const root = repo({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": { name: "web" },
      "tools/scripts/package.json": { name: "scripts" },
    });
    expect(detectWorkspaces(root, config, "repo").map((w) => w.dir)).toEqual([".", "apps/web"]);
  });

  it("falls back to a single root workspace", () => {
    const root = repo({
      "package.json": { name: "solo", dependencies: { hono: "1" } },
      "wrangler.toml": "",
    });
    const ws = detectWorkspaces(root, config, "repo");
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      id: "ws:repo:.",
      dir: ".",
      name: "solo",
      kind: "app",
      frameworks: ["hono"],
    });
    expect(detectWorkspaces(repo({}), config, "repo")[0]?.id).toBe("ws:repo:.");
  });

  it("detects framework apps and honours overrides", () => {
    const root = repo({
      "package.json": { name: "r", workspaces: ["x/*"] },
      "x/router/package.json": { name: "router", dependencies: { "@tanstack/react-router": "1" } },
      "x/router/src/routes/index.tsx": "",
      "x/vite/package.json": { name: "vt", devDependencies: { vite: "1" } },
      "x/vite/index.html": "",
      "x/vitelib/package.json": { name: "vl", devDependencies: { vite: "1" } },
    });
    const by = (c = config) =>
      Object.fromEntries(detectWorkspaces(root, c, "repo").map((w) => [w.name, w.kind]));
    expect(by()).toMatchObject({ router: "app", vt: "app", vl: "unknown" });
    const over = {
      workspaces: { overrides: { "ws:repo:vt": { kind: "package" as const }, vl: { kind: "app" as const } } },
    };
    expect(by(over)).toMatchObject({ vt: "package", vl: "app" });
  });

  it("is sorted and stable", () => {
    const root = repo({
      "package.json": { name: "r", workspaces: ["*"] },
      "z/package.json": { name: "z" },
      "a/package.json": { name: "a" },
    });
    const a = detectWorkspaces(root, config, "repo");
    expect(a.map((w) => w.dir)).toEqual([".", "a", "z"]);
    expect(detectWorkspaces(root, config, "repo")).toEqual(a);
  });
});

describe("flattenExports", () => {
  it("handles string, condition object and null", () => {
    expect(flattenExports("./i.js")).toEqual([{ subpath: ".", target: "./i.js" }]);
    expect(flattenExports({ import: "./i.mjs", default: "./i.cjs" })).toEqual([
      { subpath: ".", target: "./i.mjs" },
    ]);
    expect(flattenExports({ ".": { node: { import: "./n.js" }, default: "./d.js" } })).toEqual([
      { subpath: ".", target: "./d.js" },
    ]);
    expect(flattenExports(undefined)).toBeNull();
  });
});

describe("workspaceForPath", () => {
  it("uses the longest dir prefix, else root", () => {
    const root = repo({
      "package.json": { name: "r", workspaces: ["packages/*", "packages/a/inner"] },
      "packages/a/package.json": { name: "a" },
      "packages/a/inner/package.json": { name: "inner" },
      "packages/ab/package.json": { name: "ab" },
    });
    const ws = detectWorkspaces(root, config, "repo");
    expect(workspaceForPath(ws, "packages/a/inner/x.ts").name).toBe("inner");
    expect(workspaceForPath(ws, "packages/a/src/x.ts").name).toBe("a");
    expect(workspaceForPath(ws, "packages/ab/x.ts").name).toBe("ab");
    expect(workspaceForPath(ws, "scripts/x.ts").id).toBe("ws:repo:.");
  });
});

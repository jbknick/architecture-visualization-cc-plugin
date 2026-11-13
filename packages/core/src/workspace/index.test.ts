import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const ws = detectWorkspaces(root, config);
    expect(ws.map((w) => [w.id, w.dir, w.kind])).toEqual([
      ["ws:.", ".", "unknown"],
      ["ws:@acme/web", "apps/web", "app"],
      ["ws:@acme/ui", "packages/ui", "package"],
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
    const ui = detectWorkspaces(root, config).find((w) => w.id === "ws:@acme/ui");
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
      const ws = detectWorkspaces(root, config);
      expect(ws.map((w) => w.id)).toEqual(["ws:.", "ws:a", "ws:b"]);
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
    const ws = detectWorkspaces(root, config);
    expect(ws.map((w) => [w.id, w.kind])).toEqual([
      ["ws:.", "unknown"],
      ["ws:shop", "app"],
      ["ws:@acme/core", "package"],
    ]);
  });

  it("falls back to a single root workspace", () => {
    const root = repo({
      "package.json": { name: "solo", dependencies: { hono: "1" } },
      "wrangler.toml": "",
    });
    const ws = detectWorkspaces(root, config);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      id: "ws:.",
      dir: ".",
      name: "solo",
      kind: "app",
      frameworks: ["hono"],
    });
    expect(detectWorkspaces(repo({}), config)[0]?.id).toBe("ws:.");
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
    const by = (c = config) => Object.fromEntries(detectWorkspaces(root, c).map((w) => [w.name, w.kind]));
    expect(by()).toMatchObject({ router: "app", vt: "app", vl: "unknown" });
    const over = {
      workspaces: { overrides: { "ws:vt": { kind: "package" as const }, vl: { kind: "app" as const } } },
    };
    expect(by(over)).toMatchObject({ vt: "package", vl: "app" });
  });

  it("is sorted and stable", () => {
    const root = repo({
      "package.json": { name: "r", workspaces: ["*"] },
      "z/package.json": { name: "z" },
      "a/package.json": { name: "a" },
    });
    const a = detectWorkspaces(root, config);
    expect(a.map((w) => w.dir)).toEqual([".", "a", "z"]);
    expect(detectWorkspaces(root, config)).toEqual(a);
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
    const ws = detectWorkspaces(root, config);
    expect(workspaceForPath(ws, "packages/a/inner/x.ts").name).toBe("inner");
    expect(workspaceForPath(ws, "packages/a/src/x.ts").name).toBe("a");
    expect(workspaceForPath(ws, "packages/ab/x.ts").name).toBe("ab");
    expect(workspaceForPath(ws, "scripts/x.ts").id).toBe("ws:.");
  });
});

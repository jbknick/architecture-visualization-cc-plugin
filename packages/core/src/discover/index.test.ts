import fs, { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { detectWorkspaces } from "../workspace/index.js";
import { discoverFiles, isIndexable, isSensitive, SENSITIVE_PATTERNS } from "./index.js";

// The helper lives outside tsconfig rootDir (src), so load it dynamically by path.
interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function setup(name: "single-pkg" | "pnpm-turbo" | "nx") {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  const env = { HOME: join(fx.dir, ".home-none"), CLAUDE_PLUGIN_DATA: join(fx.dir, ".data-none") };
  const paths: GantryPaths = resolvePaths(fx.dir, env);
  const config = loadConfig(paths);
  const ws = detectWorkspaces(paths.root, config);
  const write = (rel: string, content = "export const x = 1;\n") => {
    mkdirSync(dirname(join(fx.dir, rel)), { recursive: true });
    writeFileSync(join(fx.dir, rel), content);
  };
  return { fx, paths, config, ws, write };
}

describe("discoverFiles", () => {
  it("pnpm-turbo excludes generated, worktree, d.ts and dist files", async () => {
    const { fx, paths, config, ws, write } = await setup("pnpm-turbo");
    write("apps/web/src/types.d.ts");
    write("packages/ui/dist/index.ts");
    fx.git(["add", "-A", "-f"]);
    const files = discoverFiles(paths, config, ws).map((f) => f.path);
    expect(files).toContain("apps/web/src/routes/index.tsx");
    expect(files).not.toContain("apps/web/src/routeTree.gen.ts");
    expect(files.some((f) => f.startsWith(".claude/worktrees/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".d.ts"))).toBe(false);
    expect(files.some((f) => f.split("/").includes("dist"))).toBe(false);
    expect(files).toEqual([...files].sort());
  });

  it("single-pkg drops secrets and generated files and attaches workspace ids", async () => {
    const { paths, config, ws } = await setup("single-pkg");
    const found = discoverFiles(paths, config, ws);
    const files = found.map((f) => f.path);
    expect(files).toContain("src/greet.ts");
    expect(files).not.toContain("src/secrets.ts");
    expect(files).not.toContain("src/gen/api.gen.ts");
    for (const f of found) {
      expect(f.workspaceId).toBe(ws[0]?.id);
      expect(f.size).toBeGreaterThan(0);
      expect(f.mtimeMs).toBeGreaterThan(0);
    }
  });

  it("never opens or reads .env or other sensitive files", async () => {
    const { paths, config, ws } = await setup("single-pkg");
    const touched: string[] = [];
    const target = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ["readFileSync", "openSync", "createReadStream", "readFile", "open"]) {
      const orig = target[fn];
      vi.spyOn(target as { [k: string]: (...a: unknown[]) => unknown }, fn).mockImplementation(
        (p: unknown, ...rest: unknown[]) => {
          touched.push(String(p));
          return orig?.(p, ...rest);
        },
      );
    }
    discoverFiles(paths, config, ws);
    expect(touched.filter((p) => /\.env|secrets/.test(p))).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("includes untracked files, omits git-ignored ones", async () => {
    const { fx, paths, config, ws, write } = await setup("single-pkg");
    write("src/brand-new.ts");
    write("ignored/thing.ts");
    writeFileSync(join(fx.dir, ".gitignore"), "ignored/\n", { flag: "a" });
    const files = discoverFiles(paths, config, ws).map((f) => f.path);
    expect(files).toContain("src/brand-new.ts");
    expect(files).not.toContain("ignored/thing.ts");
  });

  it("drops nested git directories, user excludes and files over 1 MB", async () => {
    const { fx, paths, config, ws, write } = await setup("single-pkg");
    write("vendor/lib/index.ts");
    mkdirSync(join(fx.dir, "vendor/lib/.git"), { recursive: true });
    write("src/skipme/a.ts");
    write("src/huge.ts", `export const s = "${"a".repeat(1024 * 1024 + 10)}";\n`);
    const cfg = { ...config, exclude: ["src/skipme/**"] };
    const files = discoverFiles(paths, cfg, ws).map((f) => f.path);
    expect(files).not.toContain("vendor/lib/index.ts");
    expect(files).not.toContain("src/skipme/a.ts");
    expect(files).not.toContain("src/huge.ts");
    expect(files).toContain("src/greet.ts");
  });

  it("isIndexable agrees with discoverFiles on every fixture path", async () => {
    for (const name of ["single-pkg", "pnpm-turbo", "nx"] as const) {
      const { fx, paths, config, ws } = await setup(name);
      const found = new Set(discoverFiles(paths, config, ws).map((f) => f.path));
      const all = fx.git(["ls-files", "-z"]).split("\0").filter(Boolean);
      expect(all.length).toBeGreaterThan(0);
      for (const p of all) expect(isIndexable(p, config), `${name}:${p}`).toBe(found.has(p));
    }
  });
});

describe("isSensitive / isIndexable", () => {
  it("flags sensitive paths by basename and full path", () => {
    const yes = [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      "certs/server.pem",
      "a/b/tls.key",
      "x/cert.p12",
      "id_rsa",
      "id_rsa.pub",
      ".npmrc",
      "src/credentials.ts",
      "src/secrets.ts",
      "infra/prod.tfvars",
      "secrets/config.ts",
    ];
    for (const p of yes) expect(isSensitive(p), p).toBe(true);
    for (const p of ["src/main.ts", "src/environment.ts", "src/keyboard.ts"])
      expect(isSensitive(p), p).toBe(false);
    expect(SENSITIVE_PATTERNS).toContain(".env*");
  });

  it("applies extensions, built-ins and user excludes", async () => {
    const { config } = await setup("single-pkg");
    expect(isIndexable("src/a.ts", config)).toBe(true);
    expect(isIndexable("src/a.tsx", config)).toBe(true);
    expect(isIndexable("src/a.mts", config)).toBe(true);
    expect(isIndexable("src/a.cts", config)).toBe(true);
    expect(isIndexable("src/a.js", config)).toBe(false);
    expect(isIndexable("src/a.d.ts", config)).toBe(false);
    expect(isIndexable("node_modules/x/index.ts", config)).toBe(false);
    expect(isIndexable("packages/a/dist/index.ts", config)).toBe(false);
    expect(isIndexable(".claude/worktrees/w/src/a.ts", config)).toBe(false);
    expect(isIndexable("src/secrets.ts", config)).toBe(false);
    expect(isIndexable("src/a.ts", { ...config, exclude: ["src/**"] })).toBe(false);
    expect(isIndexable("../outside.ts", config)).toBe(false);
  });
});

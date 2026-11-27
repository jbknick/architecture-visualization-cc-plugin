import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Group, openStore, openTeamCache, readTeamGroups, resolvePaths, saveGroup } from "@gantry/core";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const USER_TOKEN = "tok-user-4d2b6e";
const REPO = "acme/storefront";
let bundleDir: string;
let cli: string;

// The same bundle the other command tests run: the real CLI entry, built from source.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "gantry-publish-bundle-"));
  mkdirSync(join(bundleDir, ".claude-plugin"));
  copyFileSync(
    join(repoRoot, "plugin/.claude-plugin/plugin.json"),
    join(bundleDir, ".claude-plugin/plugin.json"),
  );
  symlinkSync(join(repoRoot, "node_modules"), join(bundleDir, "node_modules"), "dir");
  await build({
    entry: { cli: join(repoRoot, "packages/cli/src/main.ts") },
    outDir: join(bundleDir, "dist"),
    format: ["esm"],
    platform: "node",
    target: "node22",
    external: [
      "better-sqlite3",
      "sqlite-vec",
      "oxc-parser",
      "oxc-resolver",
      "@huggingface/transformers",
      "onnxruntime-node",
    ],
    esbuildOptions(o) {
      o.alias = {
        "@gantry/core": join(repoRoot, "packages/core/src/index.ts"),
        "@gantry/protocol": join(repoRoot, "packages/protocol/src/index.ts"),
      };
    },
    silent: true,
    dts: false,
    config: false,
  });
  cli = join(bundleDir, "dist/cli.js");
}, 60_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

const ORDERS: Group = {
  id: "orders",
  name: "Orders",
  selectors: [{ type: "glob", glob: "src/orders/**" }],
  mayUse: [],
};

let fx: MaterializedFixture;
let home: string;
let pluginData: string;
let fake: FakeServer;

function gantry(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], {
      cwd: fx.dir,
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        CLAUDE_PLUGIN_DATA: pluginData,
        GANTRY_CREDENTIALS_FILE: join(home, "credentials.json"),
        GANTRY_SERVER: fake.url,
        GANTRY_ORG: "acme",
        GANTRY_TOKEN: USER_TOKEN,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

beforeEach(async () => {
  fx = await materializeFixture("overlay-groups");
  fx.git(["remote", "add", "origin", `https://github.com/${REPO}.git`]);
  home = mkdtempSync(join(tmpdir(), "gantry-publish-home-"));
  pluginData = mkdtempSync(join(tmpdir(), "gantry-publish-data-"));
  const paths = resolvePaths(fx.dir, { HOME: home, CLAUDE_PLUGIN_DATA: pluginData });
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  saveGroup(store, ORDERS);
  store.close();
  fake = await startFakeServer({ tokens: ["gct_fake", USER_TOKEN], repo: REPO });
});
afterEach(async () => {
  await fake.close();
  await fx.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(pluginData, { recursive: true, force: true });
});

describe("gantry team publish and unpublish, built, against the fake server", () => {
  it("sends a group, which the pulled cache then holds, and removes it again", async () => {
    const paths = resolvePaths(fx.dir, { HOME: home, CLAUDE_PLUGIN_DATA: pluginData });
    const teamGroups = (): string[] => {
      const cache = openTeamCache(paths, { readonly: true });
      try {
        return readTeamGroups(cache).map((g) => g.id);
      } finally {
        cache?.close();
      }
    };

    const published = await gantry(["team", "publish", "group", "orders", "--json"]);
    expect(published.code).toBe(0);
    expect(published.out).toBe('{"kind":"group","id":"orders","published":true}\n');
    expect(fake.state.groups.get(REPO)?.get("orders")).toEqual(ORDERS);
    expect(teamGroups()).toEqual(["orders"]);

    const removed = await gantry(["team", "unpublish", "group", "orders", "--json"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toBe('{"kind":"group","id":"orders","published":false}\n');
    expect(teamGroups()).toEqual([]);

    const text = await gantry(["team", "publish", "group", "orders"]);
    expect(text.out).toBe(`Published group orders to ${REPO}.\n`);
    const missing = await gantry(["team", "publish", "view", "orders"]);
    expect(missing.code).toBe(2);
    expect(missing.out).toBe("");
  }, 30_000);
});

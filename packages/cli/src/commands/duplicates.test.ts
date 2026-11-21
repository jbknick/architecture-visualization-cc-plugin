import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const snapshot = (name: string): string => readFileSync(join(here, "__snapshots__", name), "utf8");
let bundleDir: string;
let cli: string;
const tmpDirs: string[] = [];
const fixtures: MaterializedFixture[] = [];

// Bundle the real CLI entry like commands.test.ts does, so the test runs the artifact users run.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "gantry-dup-bundle-"));
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
      o.alias = { "@gantry/core": join(repoRoot, "packages/core/src/index.ts") };
    },
    silent: true,
    dts: false,
    config: false,
  });
  cli = join(bundleDir, "dist/cli.js");
}, 60_000);

afterAll(async () => {
  rmSync(bundleDir, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

function freshData(): string {
  const d = mkdtempSync(join(tmpdir(), "gantry-dup-data-"));
  tmpDirs.push(d);
  return d;
}

function run(cwd: string, data: string, args: string[]) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function indexed() {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  const data = freshData();
  expect(run(fx.dir, data, ["init"]).code).toBe(0);
  return { fx, data };
}

interface Json {
  summary: { clusters: number; functions: number; duplicateLines: number; crossWorkspace: number };
  clusters: { id: string; workspaces: string[]; members: { id: string; path: string }[] }[];
}

describe("gantry duplicates", () => {
  it("--json matches the committed snapshot and is byte-identical across runs and data dirs", async () => {
    const { fx, data } = await indexed();
    const a = run(fx.dir, data, ["duplicates", "--json"]);
    const b = run(fx.dir, data, ["duplicates", "--json"]);
    const other = freshData();
    expect(run(fx.dir, other, ["init"]).code).toBe(0);
    const c = run(fx.dir, other, ["duplicates", "--json"]);
    expect(a.err).toBe("");
    expect(a.code).toBe(0);
    expect(a.out).toBe(snapshot("duplicates-pnpm-turbo.json"));
    expect(b.out).toBe(a.out);
    expect(c.out).toBe(a.out);
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("prints the totals strip, then one block per group in rank order", async () => {
    const { fx, data } = await indexed();
    const r = run(fx.dir, data, ["duplicates"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(snapshot("duplicates-pnpm-turbo.txt"));
    expect(r.out.split("\n")[0]).toBe("2 groups · 4 functions · 19 duplicate lines · 1 across workspaces");
  });

  it("--workspace keeps only groups with a member in that workspace (id or name, repeatable)", async () => {
    const { fx, data } = await indexed();
    const byName = JSON.parse(
      run(fx.dir, data, ["duplicates", "--json", "--workspace", "@acme/web"]).out,
    ) as Json;
    expect(byName.clusters.length).toBe(1);
    for (const c of byName.clusters) expect(c.workspaces).toContain("ws:pnpm-turbo:@acme/web");
    expect(byName.summary.clusters).toBe(1);
    const byId = JSON.parse(
      run(fx.dir, data, ["duplicates", "--json", "--workspace", "ws:pnpm-turbo:@acme/web"]).out,
    ) as Json;
    expect(byId).toEqual(byName);
    const both = JSON.parse(
      run(fx.dir, data, ["duplicates", "--json", "--workspace", "@acme/web", "--workspace", "@acme/utils"])
        .out,
    ) as Json;
    expect(both.clusters.length).toBe(2);
    const bad = run(fx.dir, data, ["duplicates", "--workspace", "@acme/nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown workspace @acme/nope");
  });

  it("--since HEAD on a clean tree finds nothing; an unknown ref is a usage error", async () => {
    const { fx, data } = await indexed();
    const r = run(fx.dir, data, ["duplicates", "--since", "HEAD"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No duplicate groups.");
    expect(r.out.split("\n")[0]).toBe("0 groups · 0 functions · 0 duplicate lines · 0 across workspaces");
    const bad = run(fx.dir, data, ["duplicates", "--since", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown ref nope");
  });

  it("--since main lists exactly the group a branch adds a copy to, counting only what is kept", async () => {
    const { fx, data } = await indexed();
    fx.git(["checkout", "-b", "copy"]);
    const slug = readFileSync(join(fx.dir, "apps/web/src/lib/slug.ts"), "utf8");
    writeFileSync(join(fx.dir, "apps/api/src/slug.ts"), slug);
    fx.git(["add", "-A"]);
    fx.git(["commit", "-m", "copy slugify"]);
    const r = run(fx.dir, data, ["duplicates", "--since", "main", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Json;
    expect(j.clusters.length).toBe(1);
    expect(j.clusters[0]?.members.map((m) => m.path)).toContain("apps/api/src/slug.ts");
    expect(j.clusters[0]?.members.map((m) => m.path)).toContain("packages/utils/src/slug.ts");
    expect(j.summary.clusters).toBe(1);
    expect(j.summary.functions).toBe(3);
    // The unfiltered report still has both groups.
    const all = JSON.parse(run(fx.dir, data, ["duplicates", "--json"]).out) as Json;
    expect(all.clusters.length).toBe(2);
  });
});

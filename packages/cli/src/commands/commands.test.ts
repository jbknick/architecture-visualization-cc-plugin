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
let bundleDir: string;
let cli: string;
let dataDir: string;
const fixtures: MaterializedFixture[] = [];

// Bundle the real CLI entry exactly like tsup.config.ts does (native deps external), so these tests
// prove the bundled artifact works: schema DDL included, native modules resolvable.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "gantry-cli-bundle-"));
  dataDir = mkdtempSync(join(tmpdir(), "gantry-cli-data-"));
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
    external: ["better-sqlite3", "sqlite-vec", "oxc-parser", "oxc-resolver"],
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
  rmSync(dataDir, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

function run(cwd: string, args: string[]) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: join(dataDir, "home"), CLAUDE_PLUGIN_DATA: dataDir },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function fixture(name: "single-pkg" | "pnpm-turbo" | "nx") {
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  return fx;
}

describe("gantry init", () => {
  it("indexes fixtures/pnpm-turbo, prints a summary and exits 0 without touching the repo", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["init"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Indexed \d+ files in \d+ ms/);
    expect(r.out).toMatch(/symbols:\s+\d+/);
    expect(r.out).toMatch(/function-like:\s+\d+/);
    expect(r.out).toMatch(/edges:\s+\d+/);
    expect(r.out).toMatch(/unresolved:\s+\d+/);
    expect(r.out).not.toContain("Descriptions not estimated");
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("--estimate prints counts and the M2 placeholder line", async () => {
    const fx = await fixture("single-pkg");
    const r = run(fx.dir, ["init", "--estimate"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Descriptions not estimated until M2");
  });

  it("exits 2 outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-nogit-"));
    try {
      const r = run(dir, ["init"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Not a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gantry index --dump", () => {
  it.each(["single-pkg", "pnpm-turbo", "nx"] as const)(
    "%s dump equals the committed snapshot and is byte-identical across runs",
    async (name) => {
      const fx = await fixture(name);
      expect(run(fx.dir, ["init"]).code).toBe(0);
      const a = run(fx.dir, ["index", "--dump"]);
      const b = run(fx.dir, ["index", "--dump"]);
      expect(a.code).toBe(0);
      expect(a.out).toBe(b.out);
      const snap = readFileSync(join(repoRoot, `packages/core/src/__snapshots__/dump-${name}.json`), "utf8");
      expect(a.out).toBe(snap);
      expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
    },
  );

  it("rejects an invalid --layer with exit 1", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["index", "--layer", "nope"]).code).toBe(1);
  });
});

describe("gantry heal", () => {
  it("reports an incremental heal after a commit and a no-op afterwards", async () => {
    const fx = await fixture("pnpm-turbo");
    expect(run(fx.dir, ["init"]).code).toBe(0);
    writeFileSync(join(fx.dir, "packages/utils/src/extra.ts"), "export const extra = 1;\n");
    fx.git(["add", "-A"]);
    fx.git(["commit", "-q", "-m", "extra"]);
    const a = run(fx.dir, ["heal"]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^Healed 1 file \(incremental\) in \d+ ms$/m);
    expect(run(fx.dir, ["heal"]).out).toMatch(/^Healed 0 files \(incremental\)/m);
    expect(run(fx.dir, ["heal", "--from", "deadbeef"]).out).toMatch(/\(full re-index\)/);
  });
});

describe("gantry search / node", () => {
  it("search 'relative date' lists formatRelativeDate first, as a table and as JSON", async () => {
    const fx = await fixture("pnpm-turbo");
    const t = run(fx.dir, ["search", "relative date"]);
    expect(t.err).toBe("");
    expect(t.code).toBe(0);
    const lines = t.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+LOCATION\s+SCORE$/);
    expect(lines[1]).toMatch(/^formatRelativeDate\s+function\s+packages\/utils\/src\/date\.ts:1\s+\d/);
    expect(t.out).not.toContain("\u001b[");

    const j = JSON.parse(run(fx.dir, ["search", "relative date", "--json"]).out);
    expect(j[0]).toMatchObject({ name: "formatRelativeDate", kind: "function" });
    expect(run(fx.dir, ["search", "zzzqqq"]).out).toBe("No matches\n");
    expect(JSON.parse(run(fx.dir, ["search", "date", "--kind", "const", "--json"]).out)).toEqual([]);
    expect(run(fx.dir, ["search", "date", "--kind", "bogus"]).code).toBe(1);
  });

  it("node path:line --json returns the symbol and neighbors grouped by edge kind", async () => {
    const fx = await fixture("pnpm-turbo");
    const r = run(fx.dir, ["node", "packages/utils/src/date.ts:5", "--json"]);
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.node).toMatchObject({
      name: "formatRelativeDate",
      kind: "function",
      path: "packages/utils/src/date.ts",
    });
    expect(info.node.minhash).toBeUndefined();
    expect(info.neighbors["contains:in"]).toContain("file:packages/utils/src/date.ts");
    expect(typeof info.fanIn).toBe("number");

    const text = run(fx.dir, ["node", "packages/utils/src/date.ts:5"]);
    expect(text.out).toContain("formatRelativeDate (function, exported)");
    expect(text.out).toMatch(/EDGE\s+NODE/);
    expect(run(fx.dir, ["node", "packages/utils/src/date.ts:999"]).code).toBe(1);
  });

  it("lookups heal and refresh first: a new uncommitted file is searchable without init", async () => {
    const fx = await fixture("single-pkg");
    writeFileSync(join(fx.dir, "brand-new.ts"), "export function brandNewThing() { return 1; }\n");
    const r = run(fx.dir, ["search", "brand new thing", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)[0]).toMatchObject({ name: "brandNewThing" });
  });

  it.each([["search", "x"], ["node", "x"], ["usage"], ["config", "get", "precommit.mode"]])(
    "%s exits 2 outside a git repository",
    (...args) => {
      const dir = mkdtempSync(join(tmpdir(), "gantry-nogit-"));
      try {
        const r = run(dir, args);
        expect(r.code).toBe(2);
        expect(r.err).toContain("Not a git repository");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("gantry usage", () => {
  it("prints an empty table and [] as JSON in M1", async () => {
    const fx = await fixture("single-pkg");
    const t = run(fx.dir, ["usage"]);
    expect(t.code).toBe(0);
    expect(t.out.trimEnd().split("\n")).toHaveLength(1);
    expect(t.out).toMatch(/^TASK\s+MODEL\s+RUNS/);
    expect(JSON.parse(run(fx.dir, ["usage", "--json"]).out)).toEqual([]);
  });
});

describe("gantry config", () => {
  it("sets and gets a value, persisting it in the project config", async () => {
    const fx = await fixture("single-pkg");
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("off\n");
    const s = run(fx.dir, ["config", "set", "precommit.mode", "timeboxed"]);
    expect(s.err).toBe("");
    expect(s.code).toBe(0);
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("timeboxed\n");
    expect(run(fx.dir, ["config", "set", "precommit.budgetMs", "1234"]).code).toBe(0);
    expect(run(fx.dir, ["config", "get", "precommit.budgetMs"]).out).toBe("1234\n");
    expect(run(fx.dir, ["config", "set", "exclude", '["a/**","b"]']).code).toBe(0);
    expect(JSON.parse(run(fx.dir, ["config", "get", "exclude"]).out)).toEqual(["a/**", "b"]);
    expect(JSON.parse(run(fx.dir, ["config", "get", "precommit"]).out)).toMatchObject({
      mode: "timeboxed",
      budgetMs: 1234,
    });
    expect(fx.git(["status", "--porcelain", "--ignored"])).toBe("");
  });

  it("rejects invalid values and unknown keys with a clear message and leaves the config alone", async () => {
    const fx = await fixture("single-pkg");
    const bad = run(fx.dir, ["config", "set", "precommit.mode", "sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Invalid value for precommit\.mode/);
    expect(run(fx.dir, ["config", "get", "precommit.mode"]).out).toBe("off\n");
    const num = run(fx.dir, ["config", "set", "precommit.budgetMs", "-5"]);
    expect(num.code).toBe(1);
    expect(num.err).toMatch(/Invalid value for precommit\.budgetMs/);
    const unknown = run(fx.dir, ["config", "set", "nope.key", "1"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Unknown config key: nope.key");
    expect(run(fx.dir, ["config", "get", "nope"]).code).toBe(1);
  });
});

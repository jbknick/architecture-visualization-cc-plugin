import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GantryPaths, openStore, resolvePaths } from "@gantry/core";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHook } from "./entry.js";
import { assertTempHome } from "./testkit.js";

// Pre-commit describer (#26). The worker binary is always a fake script injected through the config override
// (`worker.binary`); nothing here can reach the real `claude`.

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
interface FakeCall {
  kind: string;
  argv: string[];
  gantryWorker: string | null;
  effortLevelSet: boolean;
  keys: string[];
  model: string | null;
}
interface FakeClaude {
  bin: string;
  configure(patch: Record<string, unknown>): void;
  calls(): FakeCall[];
  runCalls(): FakeCall[];
  grandchildPid(): number | undefined;
}
const fixtureHelper = "../../../core/test/helpers/fixture.js";
const fakeHelper = "../../../core/test/helpers/fakeClaude.js";
const { materializeFixture } = (await import(/* @vite-ignore */ fixtureHelper)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};
const { writeFakeClaude } = (await import(/* @vite-ignore */ fakeHelper)) as {
  writeFakeClaude: (dir: string, initial?: Record<string, unknown>) => FakeClaude;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

let tmpRoot: string;
let env: NodeJS.ProcessEnv;
let cli: string;
const saved: Record<string, string | undefined> = {};
const fixtures: MaterializedFixture[] = [];
const ENV_KEYS = [
  "HOME",
  "CLAUDE_PLUGIN_DATA",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "gantry-describe-cli-test-"));
  mkdirSync(join(tmpRoot, "home"), { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = join(tmpRoot, "home");
  process.env.CLAUDE_PLUGIN_DATA = join(tmpRoot, "data");
  process.env.XDG_CONFIG_HOME = join(tmpRoot, "xdg");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  assertTempHome();
  env = { ...process.env };

  const bundleDir = join(tmpRoot, "bundle");
  mkdirSync(join(bundleDir, ".claude-plugin"), { recursive: true });
  cpSync(join(repoRoot, "plugin/.claude-plugin/plugin.json"), join(bundleDir, ".claude-plugin/plugin.json"));
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
  // The bundle reads its system prompt from <dist>/prompts/ (copied by tsup.config.ts in the real build).
  cpSync(join(repoRoot, "packages/core/src/describe/prompts"), join(bundleDir, "dist/prompts"), {
    recursive: true,
  });
  cli = join(bundleDir, "dist/cli.js");
}, 60_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

const pathsOf = (dir: string): GantryPaths => resolvePaths(dir, env);

function sh(cwd: string, cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  assertTempHome(env.HOME);
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    maxBuffer: 64 << 20,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const git = (cwd: string, args: string[]) => sh(cwd, "git", args);
const gantry = (cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv) =>
  sh(cwd, "node", [cli, ...args], extraEnv);

const SOURCE = [0, 1, 2]
  .map(
    (i) =>
      `export function staged${i}(n: number) {\n  const a = n + ${i};\n  const b = a * 2;\n  return b - ${i};\n}\n`,
  )
  .join("\n");

interface Setup {
  dir: string;
  p: GantryPaths;
  fake: FakeClaude;
}

/** An indexed fixture repo with three new multi-statement functions staged and the fake worker configured. */
async function setup(
  precommit: { mode: "off" | "timeboxed" | "strict"; budgetMs?: number; maxFunctions?: number },
  fakeCfg: Record<string, unknown> = {},
): Promise<Setup> {
  assertTempHome();
  const fx = await materializeFixture("single-pkg");
  fixtures.push(fx);
  expect(gantry(fx.dir, ["init"]).code).toBe(0);
  const p = pathsOf(fx.dir);
  const fake = writeFakeClaude(mkdtempSync(join(tmpRoot, "fake-")), fakeCfg);
  mkdirSync(p.dataDir, { recursive: true });
  writeFileSync(p.configPath, JSON.stringify({ precommit, worker: { binary: fake.bin } }));
  writeFileSync(join(fx.dir, "src/staged.ts"), SOURCE);
  git(fx.dir, ["add", "src/staged.ts"]);
  return { dir: fx.dir, p, fake };
}

const rows = (p: GantryPaths, sql: string) => {
  const s = openStore(p.dbPath);
  try {
    return s.db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    s.close();
  }
};
const workerDescriptions = (p: GantryPaths) =>
  rows(p, "SELECT * FROM descriptions WHERE provenance = 'model'");
const porcelain = (dir: string) => git(dir, ["status", "--porcelain", "--ignored"]).out;

describe("precommit.mode off (the default)", () => {
  it("only enqueues: the hook never starts a worker and prints nothing", async () => {
    const s = await setup({ mode: "off" });
    const before = porcelain(s.dir);
    expect(gantry(s.dir, ["hook", "pre-commit"])).toEqual({ code: 0, out: "", err: "" });
    expect(s.fake.calls()).toHaveLength(0);
    expect(rows(s.p, "SELECT status FROM backlog WHERE symbol_id LIKE '%staged%'")).toHaveLength(3);
    expect(porcelain(s.dir)).toBe(before);
  });

  it("`gantry describe --staged` does nothing and says why", async () => {
    const s = await setup({ mode: "off" });
    const r = gantry(s.dir, ["describe", "--staged"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/precommit\.mode is off/);
    expect(s.fake.calls()).toHaveLength(0);
  });
});

describe("timeboxed and strict", () => {
  it("timeboxed: describes the staged functions, prints one stderr line, logs usage, writes nothing into the repo", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 }, { loggedIn: true });
    const before = porcelain(s.dir);
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r).toEqual({ code: 0, out: "", err: "gantry: described 3, queued 0\n" });
    expect(workerDescriptions(s.p)).toHaveLength(3);
    expect(rows(s.p, "SELECT * FROM backlog WHERE symbol_id LIKE '%staged%'")).toHaveLength(0);
    const log = rows(
      s.p,
      "SELECT task, model, functions, input_tokens, output_tokens, source FROM usage_log",
    );
    expect(log).toEqual([
      {
        task: "describe.precommit",
        model: "haiku",
        functions: 3,
        input_tokens: 900,
        output_tokens: 60,
        source: "worker",
      },
    ]);
    const call = s.fake.runCalls()[0];
    expect(call?.gantryWorker).toBe("1");
    expect(call?.effortLevelSet).toBe(false);
    expect(porcelain(s.dir)).toBe(before);
  });

  it("strict: no deadline, same result, still exit 0", async () => {
    const s = await setup({ mode: "strict" }, { delayMs: 300 });
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r).toEqual({ code: 0, out: "", err: "gantry: described 3, queued 0\n" });
  });

  it("maxFunctions caps the batch; the rest stays queued", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000, maxFunctions: 2 });
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r.err).toBe("gantry: described 2, queued 1\n");
    expect(s.fake.runCalls()[0]?.keys).toHaveLength(2);
    expect(rows(s.p, "SELECT status FROM backlog WHERE symbol_id LIKE '%staged%'")).toEqual([
      { status: "pending" },
    ]);
  });

  it("worker not logged in: everything stays queued, exit 0", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 }, { loggedIn: false });
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r).toEqual({ code: 0, out: "", err: "gantry: described 0, queued 3\n" });
    expect(s.fake.runCalls()).toHaveLength(0);
    expect(rows(s.p, "SELECT status FROM backlog WHERE symbol_id LIKE '%staged%'")).toHaveLength(3);
    expect(workerDescriptions(s.p)).toHaveLength(0);
  });

  it("crashing worker: everything queued, exit 0", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 }, { mode: "crash" });
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("gantry: described 0, queued 3\n");
  });

  it("invalid output is re-queued, then retried on the describe.retry route; `gantry usage` groups by task and model", async () => {
    const s = await setup(
      { mode: "timeboxed", budgetMs: 30_000 },
      { mode: "invalid", perModel: { sonnet: "valid" } },
    );
    const r = gantry(s.dir, ["hook", "pre-commit"]);
    expect(r.err).toBe("gantry: described 3, queued 0\n");
    expect(s.fake.runCalls().map((c) => c.model)).toEqual(["haiku", "sonnet"]);
    const usage = JSON.parse(gantry(s.dir, ["usage", "--json"]).out) as {
      task: string;
      model: string;
      functions: number;
    }[];
    expect(usage.map((u) => [u.task, u.model, u.functions])).toEqual([
      ["describe.precommit", "haiku", 3],
      ["describe.retry", "sonnet", 3],
    ]);
    expect(gantry(s.dir, ["usage"]).out).toMatch(/describe\.retry\s+sonnet/);
  });

  it("`gantry describe --staged --json` reports the result on stdout", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 });
    const r = gantry(s.dir, ["describe", "--staged", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      described: 3,
      queued: 0,
      failed: 0,
      inputTokens: 900,
      outputTokens: 60,
    });
    expect(r.err).toBe("gantry: described 3, queued 0\n");
  });
});

describe("deadline", () => {
  it("a hanging worker is killed at precommit.budgetMs: the hook returns within budget + 500 ms and queues the rest", async () => {
    // 4500 ms is just enough for a call to be started (batchSizeFor(~4000) = 1); the fake then never answers.
    const s = await setup({ mode: "timeboxed", budgetMs: 4500 }, { mode: "hang" });
    const errs: string[] = [];
    const t0 = Date.now();
    await runHook("pre-commit", [], s.dir, env, (x) => void errs.push(x));
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(4500 + 500);
    expect(s.fake.runCalls().length).toBeGreaterThanOrEqual(1);
    expect(errs.join("")).toBe("gantry: described 0, queued 3\n");
    expect(workerDescriptions(s.p)).toHaveLength(0);
    expect(rows(s.p, "SELECT status FROM backlog WHERE symbol_id LIKE '%staged%'")).toHaveLength(3);
    await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(s.fake.grandchildPid() as number, 0)).toThrow();
  });

  it("a budget too small for a call (under the M0 cold start) starts no worker at all", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 2000 });
    const errs: string[] = [];
    await runHook("pre-commit", [], s.dir, env, (x) => void errs.push(x));
    expect(s.fake.runCalls()).toHaveLength(0);
    expect(errs.join("")).toBe("gantry: described 0, queued 3\n");
  });
});

describe("recursion guard", () => {
  it("GANTRY_WORKER=1 makes the hook and the describe command no-ops, even in timeboxed mode", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 });
    expect(gantry(s.dir, ["hook", "pre-commit"], { GANTRY_WORKER: "1" })).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    expect(gantry(s.dir, ["describe", "--staged"], { GANTRY_WORKER: "1" })).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    expect(await runHook("pre-commit", [], s.dir, { ...env, GANTRY_WORKER: "1" })).toBeUndefined();
    expect(s.fake.calls()).toHaveLength(0);
    expect(rows(s.p, "SELECT * FROM backlog WHERE symbol_id LIKE '%staged%'")).toHaveLength(0);
  });

  it("the worker child gets GANTRY_WORKER=1 and runs in a throwaway directory, not the repo", async () => {
    const s = await setup({ mode: "timeboxed", budgetMs: 30_000 });
    gantry(s.dir, ["hook", "pre-commit"], { CLAUDE_CODE_EFFORT_LEVEL: "max" });
    const log = readFileSync(join(dirname(s.fake.bin), "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { cwd: string; gantryWorker: string; effortLevelSet: boolean });
    expect(log.length).toBeGreaterThan(0);
    for (const c of log) {
      expect(c.gantryWorker).toBe("1");
      expect(c.effortLevelSet).toBe(false);
      expect(c.cwd.startsWith(s.dir)).toBe(false);
    }
  });
});

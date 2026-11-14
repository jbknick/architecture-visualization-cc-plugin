import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GantryPaths, openStore, resolvePaths } from "@gantry/core";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preCommit, runHook } from "./entry.js";
import { hookScript, installHooks, shimScript, uninstallHooks } from "./install.js";
import { assertTempHome } from "./testkit.js";

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

let tmpRoot: string;
let home: string;
let dataRoot: string;
let bundleDir: string;
let cli: string;
let env: NodeJS.ProcessEnv;
const saved: Record<string, string | undefined> = {};
const fixtures: MaterializedFixture[] = [];

const ENV_KEYS = [
  "HOME",
  "CLAUDE_PLUGIN_DATA",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];

// Everything below runs against a temp HOME and temp data dir; the guard runs before any install code.
beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "gantry-hooks-test-"));
  home = join(tmpRoot, "home");
  dataRoot = join(tmpRoot, "data");
  mkdirSync(home, { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.CLAUDE_PLUGIN_DATA = dataRoot;
  process.env.XDG_CONFIG_HOME = join(tmpRoot, "xdg");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  assertTempHome();
  env = { ...process.env };

  bundleDir = join(tmpRoot, "bundle");
  mkdirSync(join(bundleDir, ".claude-plugin"), { recursive: true });
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
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function fixture(name: "single-pkg" | "pnpm-turbo" = "single-pkg") {
  assertTempHome();
  const fx = await materializeFixture(name);
  fixtures.push(fx);
  return fx;
}

const pathsOf = (dir: string): GantryPaths => resolvePaths(dir, env);
const install = (dir: string) => installHooks(pathsOf(dir), { cliPath: cli, env });
const uninstall = (dir: string) => uninstallHooks(pathsOf(dir), env);

function sh(cwd: string, cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  assertTempHome(env.HOME);
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const git = (cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => sh(cwd, "git", args, extraEnv);
const gantry = (cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv) =>
  sh(cwd, "node", [cli, ...args], extraEnv);

/** Name -> [mode, bytes] for every file in a directory (the "state" an uninstall must restore). */
function snapshot(dir: string): Record<string, [number, string]> {
  const out: Record<string, [number, string]> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    out[f] = [statSync(join(dir, f)).mode, readFileSync(join(dir, f), "latin1")];
  }
  return out;
}
const hooksPathConfig = (cwd: string) => git(cwd, ["config", "--get", "core.hooksPath"]);

function writeHook(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function commitFile(dir: string, name = "x.txt") {
  writeFileSync(join(dir, name), `${Math.random()}\n`);
  git(dir, ["add", name]);
  return git(dir, ["commit", "-q", "-m", "t"]);
}

describe("test safety", () => {
  it("assertTempHome refuses a HOME outside the temp dir", () => {
    expect(() => assertTempHome("/Users/someone")).toThrow(/refusing/);
    expect(() => assertTempHome("")).toThrow();
    expect(assertTempHome(home)).toBe(home);
  });
});

describe("script text", () => {
  it("hook scripts are three lines of POSIX sh and follow spec section 12", () => {
    const s = hookScript("pre-commit", false);
    expect(s.trimEnd().split("\n")).toHaveLength(3);
    expect(s).toContain('[ "$GANTRY_WORKER" = 1 ]');
    expect(s).toContain('"$HOME/.gantry/bin/gantry" hook pre-commit "$@"');
    expect(s).toContain("|| true");
    expect(s.trimEnd().endsWith("exit 0")).toBe(true);
    expect(hookScript("pre-commit", true).trimEnd().split("\n")).toHaveLength(3);
    expect(hookScript("pre-commit", true)).toContain(".gantry-prev");
  });

  it("the shim embeds absolute paths and quotes awkward ones", () => {
    const s = shimScript("/opt/node it/bin/node", "/x/it's/cli.js");
    expect(s).toContain("'/opt/node it/bin/node'");
    expect(s).toContain(`'/x/it'\\''s/cli.js'`);
  });
});

describe("install and uninstall round trips", () => {
  it("no existing hooks: installs five executable scripts and restores the exact prior state", async () => {
    const fx = await fixture();
    const hooksDir = join(fx.dir, ".git/hooks");
    const before = snapshot(hooksDir);
    const r = install(fx.dir);
    expect(r.mode).toBe("git-hooks");
    for (const n of ["pre-commit", "pre-push", "post-checkout", "post-merge", "post-rewrite"]) {
      const st = statSync(join(hooksDir, n));
      expect(st.mode & 0o777).toBe(0o755);
      expect(existsSync(join(hooksDir, `${n}.gantry-prev`))).toBe(false);
    }
    expect(statSync(pathsOf(fx.dir).shimPath).mode & 0o777).toBe(0o755);
    const shim = readFileSync(pathsOf(fx.dir).shimPath, "utf8");
    expect(shim).toContain(process.execPath);
    expect(shim).toContain(cli);
    expect(commitFile(fx.dir).code).toBe(0);

    uninstall(fx.dir);
    expect(snapshot(hooksDir)).toEqual(before);
    expect(hooksPathConfig(fx.dir).code).toBe(1);
  });

  it("is idempotent", async () => {
    const fx = await fixture();
    const hooksDir = join(fx.dir, ".git/hooks");
    writeHook(join(hooksDir, "pre-commit"), "exit 0");
    const orig = snapshot(hooksDir);
    install(fx.dir);
    const once = snapshot(hooksDir);
    const r2 = install(fx.dir);
    expect(r2.warnings).toEqual([]);
    expect(snapshot(hooksDir)).toEqual(once);
    expect(readdirSync(hooksDir).filter((f) => f.endsWith(".gantry-prev"))).toEqual([
      "pre-commit.gantry-prev",
    ]);
    uninstall(fx.dir);
    expect(snapshot(hooksDir)).toEqual(orig);
  });

  it("chains an existing plain hook: runs after Gantry, same args, exit code propagates, byte-exact restore", async () => {
    const fx = await fixture();
    const hooksDir = join(fx.dir, ".git/hooks");
    const log = join(tmpRoot, "chain.log");
    rmSync(log, { force: true });
    const original = `#!/bin/sh\n# odd bytes \u00e9 and tabs\t\necho "prev $0 $*" >> '${log}'\nexit "\${PREV_EXIT:-0}"\n`;
    writeFileSync(join(hooksDir, "post-checkout"), original, { mode: 0o755 });
    writeFileSync(join(hooksDir, "pre-commit"), original, { mode: 0o755 });
    const before = snapshot(hooksDir);
    const r = install(fx.dir);
    expect([...r.chained].sort()).toEqual(["post-checkout", "pre-commit"]);
    expect(readFileSync(join(hooksDir, "pre-commit.gantry-prev"), "utf8")).toBe(original);

    // A fake shim records when Gantry ran, so the order is observable.
    writeFileSync(pathsOf(fx.dir).shimPath, `#!/bin/sh\necho "gantry $*" >> '${log}'\n`, { mode: 0o755 });
    const co = git(fx.dir, ["checkout", "-q", "-b", "other"]);
    expect(co.code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toMatch(/^gantry hook post-checkout [0-9a-f]{40} [0-9a-f]{40} 1$/);
    expect(lines[1]).toMatch(/^prev .*post-checkout\.gantry-prev [0-9a-f]{40} [0-9a-f]{40} 1$/);

    // The original's non-zero exit blocks the commit; Gantry's own failure never would.
    writeFileSync(join(fx.dir, "a.txt"), "a\n");
    git(fx.dir, ["add", "a.txt"]);
    expect(git(fx.dir, ["commit", "-q", "-m", "x"], { PREV_EXIT: "7" }).code).toBe(1);
    expect(git(fx.dir, ["commit", "-q", "-m", "x"]).code).toBe(0);

    uninstall(fx.dir);
    expect(snapshot(hooksDir)).toEqual(before);
  });

  it("husky-style core.hooksPath: wraps, still runs the originals, restores the config value and dir", async () => {
    const fx = await fixture();
    const log = join(tmpRoot, "husky.log");
    rmSync(log, { force: true });
    writeHook(
      join(fx.dir, ".husky/pre-commit"),
      `echo "husky pre-commit" >> '${log}'; exit "\${PREV_EXIT:-0}"`,
    );
    writeHook(join(fx.dir, ".husky/commit-msg"), `echo "husky commit-msg $1" >> '${log}'`);
    git(fx.dir, ["config", "core.hooksPath", ".husky"]);
    const huskyBefore = snapshot(join(fx.dir, ".husky"));
    const gitHooksBefore = snapshot(join(fx.dir, ".git/hooks"));
    const configBefore = readFileSync(join(fx.dir, ".git/config"), "utf8");

    const p = pathsOf(fx.dir);
    const r = install(fx.dir);
    expect(r.mode).toBe("hooks-path");
    expect(r.dir).toBe(join(p.dataDir, "hooks"));
    expect(hooksPathConfig(fx.dir).out.trim()).toBe(join(p.dataDir, "hooks"));
    const store = openStore(p.dbPath);
    expect(store.getMeta("prev_hooks_path")).toBe(".husky");
    store.close();

    expect(commitFile(fx.dir).code).toBe(0);
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain("husky pre-commit");
    expect(logged).toMatch(/husky commit-msg .*COMMIT_EDITMSG/);
    // The original's exit code still blocks the commit.
    writeFileSync(join(fx.dir, "b.txt"), "b\n");
    git(fx.dir, ["add", "b.txt"]);
    expect(git(fx.dir, ["commit", "-q", "-m", "x"], { PREV_EXIT: "5" }).code).toBe(1);

    // Re-installing must not record our own wrapper dir as the "previous" value.
    install(fx.dir);
    uninstall(fx.dir);
    expect(hooksPathConfig(fx.dir).out.trim()).toBe(".husky");
    expect(existsSync(join(p.dataDir, "hooks"))).toBe(false);
    expect(snapshot(join(fx.dir, ".husky"))).toEqual(huskyBefore);
    expect(snapshot(join(fx.dir, ".git/hooks"))).toEqual(gitHooksBefore);
    expect(readFileSync(join(fx.dir, ".git/config"), "utf8")).toBe(configBefore);
  });

  it("lefthook-style hooks dir (absolute core.hooksPath): round trip", async () => {
    const fx = await fixture();
    const dir = join(tmpRoot, `lefthook-${Math.random().toString(36).slice(2)}`);
    const log = join(tmpRoot, "lefthook.log");
    rmSync(log, { force: true });
    writeHook(join(dir, "pre-commit"), `echo "lefthook pre-commit" >> '${log}'`);
    writeHook(join(dir, "pre-push"), `echo "lefthook pre-push" >> '${log}'`);
    git(fx.dir, ["config", "core.hooksPath", dir]);
    const before = snapshot(dir);
    install(fx.dir);
    expect(commitFile(fx.dir).code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("lefthook pre-commit");
    uninstall(fx.dir);
    expect(hooksPathConfig(fx.dir).out.trim()).toBe(dir);
    expect(snapshot(dir)).toEqual(before);
  });

  it("a hooksPath set only outside the repo is unset again, not copied into local config", async () => {
    const fx = await fixture();
    const globalCfg = join(tmpRoot, "global-gitconfig");
    const outer = join(tmpRoot, "outer-hooks");
    writeHook(join(outer, "pre-commit"), "exit 0");
    writeFileSync(globalCfg, `[core]\n\thooksPath = ${outer}\n`);
    const prevEnv = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    const localEnv = { ...env, GIT_CONFIG_GLOBAL: globalCfg };
    try {
      const p = resolvePaths(fx.dir, localEnv);
      installHooks(p, { cliPath: cli, env: localEnv });
      expect(
        git(fx.dir, ["config", "--local", "--get", "core.hooksPath"], {
          GIT_CONFIG_GLOBAL: globalCfg,
        }).out.trim(),
      ).toBe(join(p.dataDir, "hooks"));
      uninstallHooks(p, localEnv);
      expect(
        git(fx.dir, ["config", "--local", "--get", "core.hooksPath"], { GIT_CONFIG_GLOBAL: globalCfg }).code,
      ).toBe(1);
      expect(
        git(fx.dir, ["config", "--get", "core.hooksPath"], { GIT_CONFIG_GLOBAL: globalCfg }).out.trim(),
      ).toBe(outer);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = prevEnv;
    }
  });

  it("gantry hooks install / uninstall and gantry uninstall [--keep-data] work through the bundled CLI", async () => {
    const fx = await fixture();
    const hooksDir = join(fx.dir, ".git/hooks");
    const before = snapshot(hooksDir);
    const i = gantry(fx.dir, ["hooks", "install"]);
    expect(i.err).toBe("");
    expect(i.code).toBe(0);
    expect(readFileSync(pathsOf(fx.dir).shimPath, "utf8")).toContain(cli);
    expect(git(fx.dir, ["commit", "--allow-empty", "-q", "-m", "t"]).code).toBe(0);
    expect(gantry(fx.dir, ["hooks", "uninstall"]).code).toBe(0);
    expect(snapshot(hooksDir)).toEqual(before);

    gantry(fx.dir, ["hooks", "install"]);
    const p = pathsOf(fx.dir);
    expect(existsSync(p.dataDir)).toBe(true);
    expect(gantry(fx.dir, ["uninstall", "--keep-data"]).code).toBe(0);
    expect(existsSync(p.dataDir)).toBe(true);
    expect(snapshot(hooksDir)).toEqual(before);

    gantry(fx.dir, ["hooks", "install"]);
    expect(gantry(fx.dir, ["uninstall"]).code).toBe(0);
    expect(existsSync(p.dataDir)).toBe(false);
    expect(snapshot(hooksDir)).toEqual(before);
  });
});

describe("fail open and worker guard", () => {
  it("never blocks a commit when plugin/dist/cli.js is gone, errors, or the shim target is missing", async () => {
    const fx = await fixture();
    install(fx.dir);
    const moved = `${cli}.away`;
    renameSync(cli, moved);
    try {
      const c1 = commitFile(fx.dir);
      expect(c1.code).toBe(0);
      expect(c1.err).toBe("");
      // Direct shim call with a missing target: prints nothing, exits 0.
      const direct = sh(fx.dir, pathsOf(fx.dir).shimPath, ["hook", "pre-commit"]);
      expect(direct).toEqual({ code: 0, out: "", err: "" });

      // A CLI that crashes.
      writeFileSync(cli, "throw new Error('boom');\n");
      expect(commitFile(fx.dir).code).toBe(0);
      writeFileSync(cli, "process.exit(3);\n");
      expect(commitFile(fx.dir).code).toBe(0);
    } finally {
      rmSync(cli, { force: true });
      renameSync(moved, cli);
    }
  });

  it("a Gantry error is logged to hooks.log, stdout stays empty and the exit code is 0", async () => {
    const fx = await fixture();
    install(fx.dir);
    const p = pathsOf(fx.dir);
    writeFileSync(p.dbPath, "this is not a sqlite database");
    mkdirSync(join(fx.dir, "src"), { recursive: true });
    writeFileSync(join(fx.dir, "src/a.ts"), "export function a() { return 1; }\n");
    git(fx.dir, ["add", "src/a.ts"]);
    const r = gantry(fx.dir, ["hook", "pre-commit"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(readFileSync(join(p.logsDir, "hooks.log"), "utf8")).toMatch(/pre-commit error:/);
    expect(git(fx.dir, ["commit", "-q", "-m", "x"]).code).toBe(0);
  });

  it("GANTRY_WORKER=1 runs no Gantry code: no output, log untouched, commit and checkout succeed", async () => {
    const fx = await fixture();
    install(fx.dir);
    const p = pathsOf(fx.dir);
    // Corrupt db so any Gantry code that ran would log an error (the control run proves that).
    writeFileSync(p.dbPath, "this is not a sqlite database");
    const log = join(p.logsDir, "hooks.log");
    writeFileSync(join(fx.dir, "w.ts"), "export function w() { return 1; }\n");
    git(fx.dir, ["add", "w.ts"]);

    const worker = git(fx.dir, ["commit", "-q", "-m", "w"], { GANTRY_WORKER: "1" });
    expect(worker.code).toBe(0);
    expect(worker.out + worker.err).toBe("");
    expect(existsSync(log)).toBe(false);
    for (const h of [
      "pre-commit",
      "pre-push",
      "post-checkout",
      "post-merge",
      "post-rewrite",
      "session-start",
    ]) {
      const r = gantry(fx.dir, ["hook", h, "a", "b"], { GANTRY_WORKER: "1" });
      expect(r).toEqual({ code: 0, out: "", err: "" });
    }
    expect(existsSync(log)).toBe(false);
    expect(await runHook("pre-commit", [], fx.dir, { ...env, GANTRY_WORKER: "1" })).toBeUndefined();
    expect(existsSync(log)).toBe(false);

    // Control: without the guard the same commit runs Gantry (and fails open).
    writeFileSync(join(fx.dir, "w2.ts"), "export function w2() { return 2; }\n");
    git(fx.dir, ["add", "w2.ts"]);
    expect(git(fx.dir, ["commit", "-q", "-m", "w2"]).code).toBe(0);
    expect(existsSync(log)).toBe(true);
  });
});

describe("entry points", () => {
  async function indexed() {
    const fx = await fixture("pnpm-turbo");
    expect(gantry(fx.dir, ["init"]).code).toBe(0);
    install(fx.dir);
    return fx;
  }
  const backlog = (p: GantryPaths) => {
    const s = openStore(p.dbPath);
    try {
      return s.db
        .prepare("SELECT content_key, symbol_id, priority, status FROM backlog ORDER BY symbol_id")
        .all() as {
        content_key: string;
        symbol_id: string;
        priority: number;
        status: string;
      }[];
    } finally {
      s.close();
    }
  };
  const workingRows = (p: GantryPaths) => {
    const s = openStore(p.dbPath);
    try {
      return (s.db.prepare("SELECT COUNT(*) AS n FROM files WHERE layer = 'working'").get() as { n: number })
        .n;
    } finally {
      s.close();
    }
  };

  it("pre-commit enqueues functions from the staged content, not the working tree, and prints nothing", async () => {
    const fx = await indexed();
    const p = pathsOf(fx.dir);
    const file = join(fx.dir, "packages/utils/src/staged.ts");
    writeFileSync(
      file,
      "export function stagedFn(a: number) { const b = a + 1; return b; }\nfunction localFn() { const c = 2; return c; }\n",
    );
    git(fx.dir, ["add", "packages/utils/src/staged.ts"]);
    // The working tree moves on after staging.
    writeFileSync(
      file,
      "export function stagedFn(a: number) { const b = a * 1000 + 7; return b; }\nfunction localFn() { const c = 3; return c; }\n",
    );
    const workingBefore = workingRows(p);

    const r = gantry(fx.dir, ["hook", "pre-commit"]);
    expect(r).toEqual({ code: 0, out: "", err: "" });
    const rows = backlog(p).filter((b) => b.symbol_id.includes("staged.ts"));
    expect(rows.map((b) => [b.symbol_id, b.priority, b.status])).toEqual([
      ["sym:packages/utils/src/staged.ts#localFn", 2, "pending"],
      ["sym:packages/utils/src/staged.ts#stagedFn", 0, "pending"],
    ]);
    // Not written to the persisted working layer.
    expect(workingRows(p)).toBe(workingBefore);

    // Ground truth: commit what was staged, heal main from the HEAD blob, compare exact hashes.
    expect(git(fx.dir, ["commit", "-q", "-m", "staged"]).code).toBe(0);
    expect(gantry(fx.dir, ["heal"]).code).toBe(0);
    const s = openStore(p.dbPath);
    const hash = (
      s.db
        .prepare("SELECT exact_hash FROM symbols WHERE layer = 'main' AND id = ?")
        .get("sym:packages/utils/src/staged.ts#stagedFn") as { exact_hash: string }
    ).exact_hash;
    s.close();
    const staged = rows.find((b) => b.symbol_id.endsWith("#stagedFn"));
    expect(staged?.content_key).toBe(`${hash}:p1`);

    // The tree version (what is on disk now) has a different key and was never enqueued.
    git(fx.dir, ["add", "packages/utils/src/staged.ts"]);
    const before = backlog(p).length;
    gantry(fx.dir, ["hook", "pre-commit"]);
    const after = backlog(p);
    expect(after.length).toBe(before + 2);
    expect(after.filter((b) => b.symbol_id.endsWith("#stagedFn")).map((b) => b.content_key)).toContain(
      `${hash}:p1`,
    );
  });

  it("pre-commit skips functions that already have a description", async () => {
    const fx = await indexed();
    const p = pathsOf(fx.dir);
    writeFileSync(
      join(fx.dir, "packages/utils/src/d.ts"),
      "export function describedFn() { const n = 41; return n; }\n",
    );
    git(fx.dir, ["add", "packages/utils/src/d.ts"]);
    gantry(fx.dir, ["hook", "pre-commit"]);
    const key = backlog(p).find((b) => b.symbol_id.endsWith("#describedFn"))?.content_key as string;
    expect(key).toBeTruthy();
    const s = openStore(p.dbPath);
    s.db.prepare("DELETE FROM backlog").run();
    s.db
      .prepare(
        "INSERT INTO descriptions(content_key, behavior, search_terms, name_fits) VALUES (?, 'b', '[]', 1)",
      )
      .run(key);
    s.close();
    gantry(fx.dir, ["hook", "pre-commit"]);
    expect(backlog(p).filter((b) => b.symbol_id.endsWith("#describedFn"))).toEqual([]);
  });

  it("pre-commit describes one-line functions from a template instead of enqueueing them", async () => {
    const fx = await indexed();
    const p = pathsOf(fx.dir);
    writeFileSync(
      join(fx.dir, "packages/utils/src/tiny.ts"),
      "export function tinyFn(a: number) {\n  return a + 1;\n}\nexport function bigFn(a: number) {\n  const b = a + 1;\n  return b;\n}\n",
    );
    git(fx.dir, ["add", "packages/utils/src/tiny.ts"]);
    expect(gantry(fx.dir, ["hook", "pre-commit"])).toEqual({ code: 0, out: "", err: "" });
    expect(backlog(p).map((b) => b.symbol_id)).not.toContain("sym:packages/utils/src/tiny.ts#tinyFn");
    expect(backlog(p).map((b) => b.symbol_id)).toContain("sym:packages/utils/src/tiny.ts#bigFn");
    const s = openStore(p.dbPath);
    const tpl = s.db
      .prepare("SELECT behavior, provenance FROM descriptions WHERE behavior = 'Returns a + 1.'")
      .all();
    s.close();
    expect(tpl).toEqual([{ behavior: "Returns a + 1.", provenance: "template" }]);
  });

  it("pre-commit stays under 1 s for 20 staged files", async () => {
    const fx = await indexed();
    const p = pathsOf(fx.dir);
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(fx.dir, `packages/utils/src/bulk${i}.ts`),
        `export function bulk${i}(x: number) { const y = x + ${i}; return y; }\n`,
      );
    }
    git(fx.dir, ["add", "-A"]);
    const t0 = performance.now();
    const added = await preCommit(p);
    const ms = performance.now() - t0;
    expect(added).toBe(20);
    expect(ms).toBeLessThan(1000);
  });

  it("post-checkout, post-merge and post-rewrite heal the main graph", async () => {
    const fx = await indexed();
    const p = pathsOf(fx.dir);
    git(fx.dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(fx.dir, "packages/utils/src/feat.ts"), "export const feat = 1;\n");
    git(fx.dir, ["add", "-A"]);
    git(fx.dir, ["commit", "-q", "-m", "feat"]);
    const headSha = git(fx.dir, ["rev-parse", "HEAD"]).out.trim();
    const metaHead = () => {
      const s = openStore(p.dbPath);
      try {
        return s.getMeta("head_sha");
      } finally {
        s.close();
      }
    };
    // The commit's post-* hooks do not include post-commit, so main is still behind.
    expect(metaHead()).not.toBe(headSha);
    git(fx.dir, ["checkout", "-q", "main"]);
    git(fx.dir, ["merge", "-q", "--no-ff", "-m", "m", "feature"]);
    expect(metaHead()).toBe(git(fx.dir, ["rev-parse", "HEAD"]).out.trim());
    git(fx.dir, ["commit", "--amend", "-q", "-m", "amended"]);
    expect(metaHead()).toBe(git(fx.dir, ["rev-parse", "HEAD"]).out.trim());
    for (const h of ["post-checkout", "post-merge", "post-rewrite"]) {
      expect(gantry(fx.dir, ["hook", h, "0", "0", "1"])).toEqual({ code: 0, out: "", err: "" });
    }
  });

  it("pre-push heals and warns on stderr (exit 0) when pushed commits have undescribed functions", async () => {
    const fx = await indexed();
    const remote = join(tmpRoot, `remote-${Math.random().toString(36).slice(2)}.git`);
    git(tmpRoot, ["init", "-q", "--bare", remote]);
    git(fx.dir, ["remote", "add", "origin", remote]);
    expect(git(fx.dir, ["push", "-q", "-u", "origin", "main"]).code).toBe(0);

    writeFileSync(
      join(fx.dir, "packages/utils/src/pushme.ts"),
      "export function pushMe() { const n = 9; return n; }\n",
    );
    git(fx.dir, ["add", "-A"]);
    expect(git(fx.dir, ["commit", "-q", "-m", "p"]).code).toBe(0);
    expect(backlog(pathsOf(fx.dir)).some((b) => b.symbol_id.endsWith("#pushMe"))).toBe(true);
    const push = git(fx.dir, ["push", "-q", "origin", "main"]);
    expect(push.code).toBe(0);
    expect(push.err).toMatch(/gantry: 1 function in this push has no description yet/);
    expect(git(remote, ["rev-parse", "main"]).out.trim()).toBe(git(fx.dir, ["rev-parse", "HEAD"]).out.trim());
  });

  it("session-start heals and prints a line only when the index is missing", async () => {
    const fx = await fixture();
    const missing = gantry(fx.dir, ["hook", "session-start"]);
    expect(missing.code).toBe(0);
    expect(missing.out).toMatch(/no index/);
    expect(gantry(fx.dir, ["init"]).code).toBe(0);
    expect(gantry(fx.dir, ["hook", "session-start"])).toEqual({ code: 0, out: "", err: "" });
  });

  it("post-tool-use is a silent no-op for now and unknown names fail open", async () => {
    const fx = await indexed();
    expect(gantry(fx.dir, ["hook", "post-tool-use"])).toEqual({ code: 0, out: "", err: "" });
    expect(gantry(fx.dir, ["hook", "no-such-hook"])).toEqual({ code: 0, out: "", err: "" });
    expect(gantry(tmpdir(), ["hook", "pre-commit"]).out).toBe("");
  });
});

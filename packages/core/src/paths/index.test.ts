import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ensureDataDir,
  NotAGitRepoError,
  orphanedLegacyDataDir,
  pluginDataFromRoot,
  resolvePaths,
} from "./index.js";

let tmp: string;
let repo: string;
let wt: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gantry-paths-")));
  repo = path.join(tmp, "repo");
  wt = path.join(tmp, "wt");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "i");
  git(repo, "worktree", "add", "-q", wt, "-b", "other");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolvePaths", () => {
  const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;

  test("same path twice gives same dir; worktrees differ", () => {
    const a = resolvePaths(repo, env);
    const b = resolvePaths(repo, env);
    const c = resolvePaths(wt, env);
    expect(a).toEqual(b);
    expect(a.worktreeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(c.dataDir).not.toBe(a.dataDir);
    expect(c.root).toBe(wt);
  });

  test("resolves from a subdirectory and via symlink", () => {
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    const link = path.join(tmp, "link");
    fs.symlinkSync(repo, link);
    expect(resolvePaths(sub, env).root).toBe(repo);
    expect(resolvePaths(link, env).dataDir).toBe(resolvePaths(repo, env).dataDir);
  });

  test("default layout under ~/.gantry", () => {
    const p = resolvePaths(repo, env);
    expect(p.dataDir).toBe(`/home/x/.gantry/data/repos/${p.worktreeHash}`);
    expect(p.dbPath).toBe(path.join(p.dataDir, "gantry.db"));
    expect(p.configPath).toBe(path.join(p.dataDir, "config.json"));
    expect(p.catalogDir).toBe(path.join(p.dataDir, "catalog"));
    expect(p.logsDir).toBe(path.join(p.dataDir, "logs"));
    expect(p.globalConfigPath).toBe("/home/x/.gantry/config.json");
    expect(p.shimPath).toBe("/home/x/.gantry/bin/gantry");
  });

  test("CLAUDE_PLUGIN_DATA override wins", () => {
    const p = resolvePaths(repo, { ...env, CLAUDE_PLUGIN_DATA: "/plug" });
    expect(p.dataDir).toBe(`/plug/repos/${p.worktreeHash}`);
  });

  test("derives the plugin data dir from CLAUDE_PLUGIN_ROOT when CLAUDE_PLUGIN_DATA is missing", () => {
    const root = "/home/x/.claude/plugins/cache/gantry-dev/gantry/0.1.0";
    expect(pluginDataFromRoot(root)).toBe("/home/x/.claude/plugins/data/gantry-gantry-dev");
    expect(pluginDataFromRoot("/work/plugin")).toBeUndefined();
    const viaRoot = resolvePaths(repo, { ...env, CLAUDE_PLUGIN_ROOT: root });
    const viaData = resolvePaths(repo, {
      ...env,
      CLAUDE_PLUGIN_DATA: "/home/x/.claude/plugins/data/gantry-gantry-dev",
    });
    expect(viaRoot.dataDir).toBe(viaData.dataDir);
    expect(viaRoot.dataDir).toBe(
      `/home/x/.claude/plugins/data/gantry-gantry-dev/repos/${viaRoot.worktreeHash}`,
    );
    // an explicit CLAUDE_PLUGIN_DATA wins over the root
    expect(
      resolvePaths(repo, { ...env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: "/plug" }).dataDir,
    ).toBe(`/plug/repos/${viaRoot.worktreeHash}`);
  });

  test("a skill shell and the MCP server resolve the same dir; legacy ~/.gantry/data is still found", () => {
    const home = path.join(tmp, "legacyhome");
    const root = path.join(tmp, ".claude/plugins/cache/gantry-dev/gantry/0.1.0");
    const mcpEnv = {
      HOME: home,
      CLAUDE_PLUGIN_DATA: path.join(tmp, ".claude/plugins/data/gantry-gantry-dev"),
    };
    const skillEnv = { HOME: home, CLAUDE_PLUGIN_ROOT: root };
    const hash = resolvePaths(repo, mcpEnv).worktreeHash;
    const legacy = path.join(home, ".gantry/data/repos", hash);
    const plugin = path.join(mcpEnv.CLAUDE_PLUGIN_DATA, "repos", hash);
    // An empty legacy directory (a stray one) never takes over (#147).
    fs.mkdirSync(path.join(legacy, "logs"), { recursive: true });
    expect(resolvePaths(repo, mcpEnv).dataDir).toBe(plugin);
    fs.writeFileSync(path.join(legacy, "gantry.db"), "");
    expect(resolvePaths(repo, mcpEnv).dataDir).toBe(legacy);
    expect(resolvePaths(repo, skillEnv).dataDir).toBe(legacy);
    expect(orphanedLegacyDataDir(resolvePaths(repo, mcpEnv))).toBeUndefined();
    // A plugin data dir without a store (only logs) does not count as its own copy either.
    fs.mkdirSync(path.join(plugin, "logs"), { recursive: true });
    expect(resolvePaths(repo, mcpEnv).dataDir).toBe(legacy);
    // once the plugin data dir has its own store, both entry points move to it together
    fs.writeFileSync(path.join(plugin, "gantry.db"), "");
    expect(resolvePaths(repo, mcpEnv).dataDir).toBe(plugin);
    expect(resolvePaths(repo, skillEnv).dataDir).toBe(resolvePaths(repo, mcpEnv).dataDir);
    // and the old index is reported as an orphan that can be removed
    expect(orphanedLegacyDataDir(resolvePaths(repo, mcpEnv))).toBe(legacy);
    expect(orphanedLegacyDataDir(resolvePaths(repo, { HOME: home }))).toBeUndefined();
  });

  test("bin/gantry exports CLAUDE_PLUGIN_ROOT so a Bash-tool run resolves the plugin data dir", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-bin-"));
    try {
      const root = path.join(bin, ".claude/plugins/cache/gantry-dev/gantry/0.1.0");
      fs.mkdirSync(path.join(root, "bin"), { recursive: true });
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, "../../../../plugin/bin/gantry"),
        path.join(root, "bin/gantry"),
      );
      fs.chmodSync(path.join(root, "bin/gantry"), 0o755);
      fs.writeFileSync(
        path.join(root, "dist/cli.js"),
        "console.log(process.env.CLAUDE_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_DATA ?? '')",
      );
      const clean = { PATH: process.env.PATH ?? "" };
      const run = (extra: Record<string, string>) =>
        spawnSync(path.join(root, "bin/gantry"), [], {
          env: { ...clean, ...extra },
          encoding: "utf8",
        }).stdout.trim();
      expect(run({})).toBe(fs.realpathSync(root));
      expect(run({ CLAUDE_PLUGIN_ROOT: "/elsewhere", CLAUDE_PLUGIN_DATA: "/d" })).toBe("/elsewhere /d");
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  test("throws NotAGitRepoError outside a repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-nogit-"));
    try {
      expect(() => resolvePaths(plain, env)).toThrow(NotAGitRepoError);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("ensureDataDir", () => {
  test("creates dirs with mode 0700", () => {
    const p = resolvePaths(repo, { CLAUDE_PLUGIN_DATA: path.join(tmp, "data") });
    ensureDataDir(p);
    ensureDataDir(p);
    for (const d of [p.dataDir, p.catalogDir, p.logsDir]) {
      expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    }
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ensureDataDir, NotAGitRepoError, resolvePaths } from "./index.js";

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

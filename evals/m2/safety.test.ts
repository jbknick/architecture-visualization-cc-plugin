import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertThrowawayCopy, requireDataDir } from "./safety.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
};
function makeCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "gantry-m2-safety-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("assertThrowawayCopy", () => {
  it("accepts a clean copy under the temp dir", () => {
    expect(() => assertThrowawayCopy(makeCopy())).not.toThrow();
  });
  it("refuses a copy with a modified file or an untracked file", () => {
    const dir = makeCopy();
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    expect(() => assertThrowawayCopy(dir)).toThrow(/local changes/);
    git(dir, "checkout", "--", ".");
    writeFileSync(join(dir, "new.ts"), "");
    expect(() => assertThrowawayCopy(dir)).toThrow(/local changes/);
  });
  it("refuses a path outside the temp dir, however clean it is", () => {
    const dir = makeCopy();
    expect(() => assertThrowawayCopy(dir, [join(tmpdir(), "somewhere-else")])).toThrow(
      /not under the system temp dir/,
    );
  });
  it("accepts a clean copy outside the temp dir when the throwaway flag is given, never a dirty one", () => {
    const dir = makeCopy();
    const elsewhere = [join(tmpdir(), "somewhere-else")];
    expect(() => assertThrowawayCopy(dir, elsewhere, true)).not.toThrow();
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    expect(() => assertThrowawayCopy(dir, elsewhere, true)).toThrow(/local changes/);
  });
  it("refuses a directory that is not a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "gantry-m2-nogit-"));
    dirs.push(dir);
    expect(() => assertThrowawayCopy(dir)).toThrow();
  });
});

describe("requireDataDir", () => {
  it("throws without CLAUDE_PLUGIN_DATA and returns it with", () => {
    const old = process.env.CLAUDE_PLUGIN_DATA;
    try {
      delete process.env.CLAUDE_PLUGIN_DATA;
      expect(() => requireDataDir()).toThrow(/CLAUDE_PLUGIN_DATA/);
      process.env.CLAUDE_PLUGIN_DATA = "/x";
      expect(requireDataDir()).toBe("/x");
    } finally {
      if (old === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = old;
    }
  });
});

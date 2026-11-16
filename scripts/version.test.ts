import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkContent, checkSync, nextVersion, release, VERSION_FILES } from "./version.js";

// Resolve tsx from this repository so the scripts run with a scratch repository as cwd.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function put(root: string, file: string, version: string | null, extra = "") {
  mkdirSync(join(root, file, ".."), { recursive: true });
  const body = version === null ? "" : `  "version": "${version}",\n`;
  writeFileSync(join(root, file), `{\n  "name": "x",\n${body}  "private": true${extra}\n}\n`);
}

/** A scratch repository holding every version file, one commit and no tag. */
function scratch(version = "0.0.1"): string {
  const root = mkdtempSync(join(tmpdir(), "gantry-release-"));
  dirs.push(root);
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  run(root, "config", "commit.gpgsign", "false");
  run(root, "config", "tag.gpgsign", "false");
  for (const f of VERSION_FILES) put(root, f, f === ".claude-plugin/marketplace.json" ? null : version);
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "#1 first change (#2)");
  return root;
}

describe("nextVersion", () => {
  it("bumps and accepts an explicit version", () => {
    expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.9", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.9", "2.3.4")).toBe("2.3.4");
    expect(() => nextVersion("0.1.9", "banana")).toThrow(/unknown bump/);
  });
});

describe("checkSync", () => {
  it("passes when every file equals the root version", () => {
    expect(checkSync(scratch())).toEqual([]);
  });

  it("fails on a mismatch and names the file", () => {
    const root = scratch();
    put(root, "packages/mcp/package.json", "0.0.2");
    expect(checkSync(root)).toEqual([expect.stringContaining("packages/mcp/package.json")]);
  });

  it("fails when plugin.json has no version", () => {
    const root = scratch();
    put(root, "plugin/.claude-plugin/plugin.json", null);
    expect(checkSync(root)[0]).toContain("plugin/.claude-plugin/plugin.json");
  });

  it("makes the check script exit 1 and print the file", () => {
    const root = scratch();
    put(root, "packages/core/package.json", "9.9.9");
    const script = join(import.meta.dirname, "check-version.ts");
    const r = spawnSync(process.execPath, ["--import", tsxLoader, script], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("packages/core/package.json");
  });

  it("holds for this repository", () => {
    expect(checkSync(join(import.meta.dirname, ".."))).toEqual([]);
  });
});

describe("release", () => {
  it("bumps every file, writes the CHANGELOG, commits and tags", () => {
    const root = scratch();
    expect(release(root, "minor", "2026-11-16")).toBe("0.1.0");
    for (const f of VERSION_FILES) {
      if (f === ".claude-plugin/marketplace.json") continue;
      expect(JSON.parse(readFileSync(join(root, f), "utf8")).version).toBe("0.1.0");
    }
    const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(log).toContain("## 0.1.0 - 2026-11-16");
    expect(log).toContain("- #1 first change (#2)");
    expect(run(root, "tag", "--list")).toBe("v0.1.0");
    expect(run(root, "log", "-1", "--pretty=%s")).toBe("Release v0.1.0");
    expect(run(root, "status", "--porcelain")).toBe("");
  });

  it("lists only commits since the last tag in the next section, newest section first", () => {
    const root = scratch();
    release(root, "patch", "2026-11-16");
    writeFileSync(join(root, "a.txt"), "a");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "#3 second change (#4)");
    release(root, "0.2.0", "2026-11-17");
    const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const second = log.slice(log.indexOf("## 0.2.0"), log.indexOf("## 0.0.2"));
    expect(second).toContain("#3 second change");
    expect(second).not.toContain("#1 first change");
    expect(log.indexOf("## 0.2.0")).toBeLessThan(log.indexOf("## 0.0.2"));
  });

  it("refuses a dirty tree, a repeated version and out-of-sync files, and changes nothing", () => {
    const root = scratch();
    writeFileSync(join(root, "dirty.txt"), "x");
    expect(() => release(root, "patch")).toThrow(/not clean/);
    rmSync(join(root, "dirty.txt"));
    expect(() => release(root, "0.0.1")).toThrow(/already/);
    put(root, "packages/cli/package.json", "0.0.5");
    run(root, "commit", "-qam", "drift");
    expect(() => release(root, "patch")).toThrow(/out of sync/);
    expect(run(root, "tag", "--list")).toBe("");
  });

  it("runs as `pnpm release` would, via the script, and never pushes", () => {
    const root = scratch();
    const script = join(import.meta.dirname, "release.ts");
    const r = spawnSync(process.execPath, ["--import", tsxLoader, script, "patch"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(run(root, "tag", "--list")).toBe("v0.0.2");
    expect(run(root, "remote")).toBe("");
  });
});

describe("checkContent", () => {
  it("has no baseline without a tag", () => {
    expect(checkContent(scratch()).status).toBe("no-tag");
  });

  it("flags plugin content changed without a bump, ignores tests, and clears after a bump", () => {
    const root = scratch();
    release(root, "patch", "2026-11-16");
    writeFileSync(join(root, "a.txt"), "a");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "unrelated");
    expect(checkContent(root).status).toBe("ok");

    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    writeFileSync(join(root, "packages/core/src/x.test.ts"), "// t");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "test only");
    expect(checkContent(root).status).toBe("ok");

    writeFileSync(join(root, "packages/core/src/x.ts"), "export {};");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "code");
    const c = checkContent(root);
    expect(c).toMatchObject({ status: "needs-bump", files: ["packages/core/src/x.ts"] });

    release(root, "patch", "2026-11-17");
    expect(checkContent(root).status).toBe("ok");
  });
});

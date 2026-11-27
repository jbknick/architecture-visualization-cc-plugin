import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkContent, checkReleaseDeps, checkSync, nextVersion, release, VERSION_FILES } from "./version.js";

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
  // `release()` runs `pnpm build` in the repository, so the scratch root has one that makes plugin/dist
  put(
    root,
    "package.json",
    version,
    ',\n  "scripts": { "build": "mkdir -p plugin/dist && echo built > plugin/dist/cli.js" }',
  );
  writeFileSync(join(root, ".gitignore"), "dist\n");
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  // a protocol package the release script compiles from its own build config, and another package that must not ship
  put(root, "packages/protocol/package.json", version, ',\n  "type": "module"');
  const protocol = JSON.parse(readFileSync(join(root, "packages/protocol/package.json"), "utf8"));
  protocol.name = "@gantry/protocol";
  writeFileSync(join(root, "packages/protocol/package.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  put(root, "packages/protocol/tsconfig.json", null, "");
  const compilerOptions = {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2023",
    rootDir: "src",
    declaration: true,
  };
  writeFileSync(
    join(root, "packages/protocol/tsconfig.json"),
    JSON.stringify({ compilerOptions, include: ["src"] }),
  );
  writeFileSync(
    join(root, "packages/protocol/tsconfig.build.json"),
    JSON.stringify({ extends: "./tsconfig.json", exclude: ["src/**/*.test.ts"] }),
  );
  mkdirSync(join(root, "packages/protocol/src"), { recursive: true });
  writeFileSync(join(root, "packages/protocol/src/index.ts"), "export const PROTOCOL_VERSION = 1;\n");
  writeFileSync(join(root, "packages/protocol/src/index.test.ts"), "export const t: number = 2;\n");
  mkdirSync(join(root, "packages/other/dist"), { recursive: true });
  writeFileSync(join(root, "packages/other/dist/x.js"), "// not shipped\n");
  mkdirSync(join(root, "packages/protocol/dist"), { recursive: true });
  writeFileSync(join(root, "packages/protocol/dist/stale.js"), "// removed source\n");
  put(root, "scripts/release-deps/package.json", null, ',\n  "dependencies": { "zod": "1.0.0" }');
  writeFileSync(join(root, "scripts/release-deps/package-lock.json"), "{}\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "#1 first change (#2)");
  return root;
}

/** Stands in for `pnpm build`: the packer only needs plugin/dist to exist. */
function fakeBuild(root: string) {
  mkdirSync(join(root, "plugin/dist"), { recursive: true });
  writeFileSync(join(root, "plugin/dist/cli.js"), "// built\n");
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

describe("checkReleaseDeps", () => {
  const rootDeps = (root: string, deps: string) =>
    writeFileSync(join(root, "package.json"), `{ "version": "0.0.1", ${deps} }\n`);
  const releaseDeps = (root: string, version: string) =>
    writeFileSync(
      join(root, "scripts/release-deps/package.json"),
      `{ "name": "gantry-cli", "dependencies": { "zod": "${version}", "other": "9.9.9" } }\n`,
    );

  it("passes on equal versions, drops a range's prefix, and ignores packages the root lacks", () => {
    const root = scratch();
    releaseDeps(root, "4.6.7");
    rootDeps(root, '"dependencies": { "zod": "^4.6.7" }');
    expect(checkReleaseDeps(root)).toEqual([]);
    rootDeps(root, '"devDependencies": { "zod": "4.6.7" }');
    expect(checkReleaseDeps(root)).toEqual([]);
  });

  it("fails and names the package when a version drifted", () => {
    const root = scratch();
    releaseDeps(root, "4.6.6");
    rootDeps(root, '"devDependencies": { "zod": "4.6.7" }');
    expect(checkReleaseDeps(root)).toEqual([
      expect.stringMatching(/zod is 4\.6\.6 but package\.json has 4\.6\.7/),
    ]);
  });
});

describe("release", () => {
  it("bumps every file, writes the CHANGELOG, commits and tags", () => {
    const root = scratch();
    expect(release(root, "minor", "2026-11-16", fakeBuild).version).toBe("0.1.0");
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

  it("packs the tarball after tagging and has no remote to push to", () => {
    const root = scratch();
    const { pack, protocol } = release(root, "minor", "2026-11-16", fakeBuild);
    expect(existsSync(pack.tarball)).toBe(true);
    expect(readFileSync(protocol.sha256File, "utf8")).toBe(`${protocol.sha256}  gantry-protocol-0.1.0.tgz\n`);
    const files = execFileSync("tar", ["-tzf", protocol.tarball], { encoding: "utf8" }).trim().split("\n");
    expect(files).toEqual([
      "package/LICENSE",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/package.json",
    ]);
    const out = mkdtempSync(join(tmpdir(), "gantry-release-unpack-"));
    dirs.push(out);
    execFileSync("tar", ["-xzf", protocol.tarball, "-C", out]);
    const pkg = JSON.parse(readFileSync(join(out, "package/package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "@gantry/protocol", version: "0.1.0" });
    expect(readFileSync(join(out, "package/dist/index.js"), "utf8")).toContain("PROTOCOL_VERSION");
    expect(readFileSync(pack.sha256File, "utf8")).toBe(`${pack.sha256}  gantry-0.1.0.tgz\n`);
    expect(run(root, "remote")).toBe("");
  });

  it("lists only commits since the last tag in the next section, newest section first", () => {
    const root = scratch();
    release(root, "patch", "2026-11-16", fakeBuild);
    writeFileSync(join(root, "a.txt"), "a");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "#3 second change (#4)");
    release(root, "0.2.0", "2026-11-17", fakeBuild);
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
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "gh release create v0.0.2 dist/gantry-0.0.2.tgz dist/gantry-0.0.2.tgz.sha256 dist/gantry-protocol-0.0.2.tgz dist/gantry-protocol-0.0.2.tgz.sha256 --notes-from-tag",
    );
    expect(existsSync(join(root, "dist/gantry-0.0.2.tgz"))).toBe(true);
    expect(existsSync(join(root, "dist/gantry-protocol-0.0.2.tgz.sha256"))).toBe(true);
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
    release(root, "patch", "2026-11-16", fakeBuild);
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

    release(root, "patch", "2026-11-17", fakeBuild);
    expect(checkContent(root).status).toBe("ok");
  });
});

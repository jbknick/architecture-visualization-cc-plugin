import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packProtocol, packRelease } from "./pack.js";
import { checkSync } from "./version.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "gantry-pack-"));
  dirs.push(d);
  return d;
};
const put = (root: string, file: string, text: string, mode?: number) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text, mode === undefined ? undefined : { mode });
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A small fake repository: plugin/ with a "built" dist, release-deps and a LICENSE, committed at a fixed time. */
function fake(): string {
  const root = tmp();
  put(root, "plugin/bin/gantry", "#!/bin/sh\necho gantry\n", 0o755);
  put(root, "plugin/dist/cli.js", "console.log('cli');\n");
  put(root, "plugin/dist/mcp.js", "console.log('mcp');\n");
  put(root, "plugin/dist/prompts/describe.md", "prompt\n");
  put(root, "plugin/agents/describer.md", "agent\n");
  put(root, "plugin/skills/map/SKILL.md", "skill\n");
  put(root, "plugin/hooks/hooks.json", "{}\n");
  put(root, "plugin/.claude-plugin/plugin.json", '{"version":"1.2.3"}\n');
  put(root, "plugin/.mcp.json", "{}\n");
  put(root, "plugin/plugin.test.ts", "not shipped\n");
  put(root, "plugin/node_modules/x/index.js", "not shipped\n");
  put(root, "plugin/dist/.DS_Store", "not shipped\n");
  put(root, "LICENSE", "MIT\n");
  put(
    root,
    "scripts/release-deps/package.json",
    `${JSON.stringify({ name: "gantry-cli", private: true, type: "module", bin: { gantry: "bin/gantry" }, dependencies: { zod: "1.0.0" } }, null, 2)}\n`,
  );
  put(root, "scripts/release-deps/package-lock.json", '{"lockfileVersion":3}\n');
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", "x"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    },
  });
  return root;
}

const listing = (tarball: string) =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");

describe("packRelease", () => {
  it("gives the same sha256 on every run, and the .sha256 line matches shasum", () => {
    const root = fake();
    const a = packRelease(root, "1.2.3");
    const bytes = readFileSync(a.tarball);
    const b = packRelease(root, "1.2.3");
    expect(b.sha256).toBe(a.sha256);
    expect(readFileSync(b.tarball).equals(bytes)).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(a.sha256);
    const line = readFileSync(a.sha256File, "utf8");
    expect(line).toBe(`${a.sha256}  gantry-1.2.3.tgz\n`);
    const shasum = execFileSync("shasum", ["-a", "256", a.tarball], { encoding: "utf8" });
    expect(shasum.split(/\s+/)[0]).toBe(a.sha256);
  });

  it("lists one top directory with the sorted expected paths and nothing else", () => {
    const root = fake();
    const { tarball } = packRelease(root, "1.2.3");
    expect(listing(tarball)).toEqual([
      "gantry/",
      "gantry/.claude-plugin/",
      "gantry/.claude-plugin/plugin.json",
      "gantry/.mcp.json",
      "gantry/LICENSE",
      "gantry/agents/",
      "gantry/agents/describer.md",
      "gantry/bin/",
      "gantry/bin/gantry",
      "gantry/dist/",
      "gantry/dist/cli.js",
      "gantry/dist/mcp.js",
      "gantry/dist/prompts/",
      "gantry/dist/prompts/describe.md",
      "gantry/hooks/",
      "gantry/hooks/hooks.json",
      "gantry/package-lock.json",
      "gantry/package.json",
      "gantry/skills/",
      "gantry/skills/map/",
      "gantry/skills/map/SKILL.md",
    ]);
  });

  it("extracts with the system tar: modes, ownership, mtime and contents", () => {
    const root = fake();
    const { tarball } = packRelease(root, "1.2.3");
    const out = tmp();
    execFileSync("tar", ["-xzf", tarball, "-C", out]);
    expect(statSync(join(out, "gantry/bin/gantry")).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, "gantry/dist/cli.js")).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, "gantry/dist/cli.js")).mtimeMs).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(readFileSync(join(out, "gantry/dist/cli.js"), "utf8")).toBe("console.log('cli');\n");
    expect(readFileSync(join(out, "gantry/package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}\n');
    const verbose = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" });
    expect(verbose).toMatch(/^-rwxr-xr-x +\d+ 0 +0 +\d+ .* gantry\/bin\/gantry$/m);
    const pkg = JSON.parse(readFileSync(join(out, "gantry/package.json"), "utf8"));
    expect(pkg).toEqual({
      name: "gantry-cli",
      version: "1.2.3",
      private: true,
      type: "module",
      bin: { gantry: "bin/gantry" },
      dependencies: { zod: "1.0.0" },
    });
  });

  it("changes when a shipped file changes, and not when an unshipped one does", () => {
    const root = fake();
    const first = packRelease(root, "1.2.3").sha256;
    put(root, "plugin/plugin.test.ts", "still not shipped\n");
    expect(packRelease(root, "1.2.3").sha256).toBe(first);
    put(root, "plugin/dist/cli.js", "console.log('changed');\n");
    expect(packRelease(root, "1.2.3").sha256).not.toBe(first);
  });

  it("uses the committer time of the version's tag when it exists", () => {
    const root = fake();
    const atHead = packRelease(root, "1.2.3").sha256;
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "later"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z",
        GIT_AUTHOR_DATE: "2026-06-01T00:00:00Z",
      },
    });
    git(root, "tag", "-a", "v1.2.3", "-m", "Release v1.2.3", "HEAD~1");
    expect(packRelease(root, "1.2.3").sha256).toBe(atHead);
  });

  it("fails without a built plugin/dist, naming the fix", () => {
    const root = fake();
    rmSync(join(root, "plugin/dist"), { recursive: true });
    expect(() => packRelease(root, "1.2.3")).toThrow("plugin/dist is missing: run pnpm build");
  });
});

const REPO = join(import.meta.dirname, "..");

/** `fake()` plus a built packages/protocol: sources and tests are not shipped, dist and examples are. */
function fakeWithProtocol(): string {
  const root = fake();
  put(
    root,
    "packages/protocol/package.json",
    `${JSON.stringify({ name: "@gantry/protocol", version: "0.0.0", private: true, type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js", "./testing": "./dist/testing/index.js" }, dependencies: { zod: "4.6.7" }, devDependencies: { "@gantry/core": "workspace:*" }, files: ["dist", "examples", "LICENSE"] }, null, 2)}\n`,
  );
  put(root, "packages/protocol/dist/index.js", "export const PROTOCOL_VERSION = 1;\n");
  put(root, "packages/protocol/dist/index.d.ts", "export declare const PROTOCOL_VERSION = 1;\n");
  put(root, "packages/protocol/dist/testing/index.js", "export {};\n");
  put(root, "packages/protocol/dist/testing/index.d.ts", "export {};\n");
  put(root, "packages/protocol/dist/testing/fakeServer.js", "export {};\n");
  put(root, "packages/protocol/dist/testing/fakeServer.d.ts", "export {};\n");
  put(root, "packages/protocol/dist/schemas.test.js", "not shipped\n");
  put(root, "packages/protocol/dist/schemas.test.d.ts", "not shipped\n");
  put(root, "packages/protocol/dist/index.js.map", "not shipped\n");
  put(root, "packages/protocol/dist/tsconfig.tsbuildinfo", "not shipped\n");
  put(root, "packages/protocol/src/index.ts", "not shipped\n");
  put(root, "packages/protocol/examples/view.json", "{}\n");
  put(root, "packages/protocol/examples/main-snapshot.part-1.ndjson.gz", "gz\n");
  put(root, "packages/other/dist/x.js", "not shipped\n");
  git(root, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", "protocol"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    },
  });
  return root;
}

describe("packProtocol", () => {
  it("writes gantry-protocol-<version>.tgz beside the CLI tarball, with a one-line .sha256 that matches", () => {
    const root = fakeWithProtocol();
    const cli = packRelease(root, "1.2.3");
    const p = packProtocol(root, "1.2.3");
    expect(p.tarball).toBe(join(root, "dist/gantry-protocol-1.2.3.tgz"));
    expect(readdirSync(join(root, "dist")).sort()).toEqual([
      "gantry-1.2.3.tgz",
      "gantry-1.2.3.tgz.sha256",
      "gantry-protocol-1.2.3.tgz",
      "gantry-protocol-1.2.3.tgz.sha256",
    ]);
    const line = readFileSync(p.sha256File, "utf8");
    expect(line).toBe(`${p.sha256}  gantry-protocol-1.2.3.tgz\n`);
    const shasum = execFileSync("shasum", ["-a", "256", p.tarball], { encoding: "utf8" });
    expect(shasum.split(/\s+/)[0]).toBe(p.sha256);
    expect(readFileSync(cli.sha256File, "utf8")).toBe(`${cli.sha256}  gantry-1.2.3.tgz\n`);
  });

  it("lists package.json, LICENSE, the examples and the non-test dist files, and nothing else", () => {
    const root = fakeWithProtocol();
    const files = listing(packProtocol(root, "1.2.3").tarball);
    expect(files).toEqual([
      "package/LICENSE",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/dist/testing/fakeServer.d.ts",
      "package/dist/testing/fakeServer.js",
      "package/dist/testing/index.d.ts",
      "package/dist/testing/index.js",
      "package/examples/main-snapshot.part-1.ndjson.gz",
      "package/examples/view.json",
      "package/package.json",
    ]);
    expect(files.filter((f) => /\.test\./.test(f))).toEqual([]);
  });

  it("writes the manifest with the release version and without devDependencies", () => {
    const root = fakeWithProtocol();
    const out = tmp();
    execFileSync("tar", ["-xzf", packProtocol(root, "1.2.3").tarball, "-C", out]);
    const pkg = JSON.parse(readFileSync(join(out, "package/package.json"), "utf8"));
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.name).toBe("@gantry/protocol");
    expect(pkg.dependencies).toEqual({ zod: "4.6.7" });
    expect(pkg).not.toHaveProperty("devDependencies");
    expect(pkg).not.toHaveProperty("private");
    expect(statSync(join(out, "package/dist/index.js")).mtimeMs).toBe(Date.parse("2026-01-02T03:04:05Z"));
  });

  it("gives the same bytes on a second run", () => {
    const root = fakeWithProtocol();
    const a = packProtocol(root, "1.2.3");
    const bytes = readFileSync(a.tarball);
    const b = packProtocol(root, "1.2.3");
    expect(b.sha256).toBe(a.sha256);
    expect(readFileSync(b.tarball).equals(bytes)).toBe(true);
  });

  it("names the missing build when packages/protocol/dist does not exist", () => {
    const root = fake();
    put(root, "packages/protocol/package.json", "{}\n");
    expect(() => packProtocol(root, "1.2.3")).toThrow(/packages\/protocol\/dist is missing/);
  });
});

describe("packages/protocol manifest", () => {
  const read = (file: string) => JSON.parse(readFileSync(join(REPO, file), "utf8"));

  it("carries the root version", () => {
    expect(read("packages/protocol/package.json").version).toBe(read("package.json").version);
    expect(checkSync(REPO)).toEqual([]);
  });

  it("pins zod at the exact version the lockfile resolves", () => {
    const want =
      /^ {2}packages\/protocol:\n {4}dependencies:\n {6}zod:\n {8}specifier: .+\n {8}version: (\S+)$/m.exec(
        readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"),
      )?.[1];
    expect(want).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read("packages/protocol/package.json").dependencies).toEqual({ zod: want });
  });

  it("lists dist, examples and LICENSE in files and exports both entry points", () => {
    const pkg = read("packages/protocol/package.json");
    expect(pkg.files).toEqual(["dist", "examples", "LICENSE"]);
    expect(Object.keys(pkg.exports)).toEqual([".", "./testing"]);
  });

  it("has a build config that leaves the tests out", () => {
    expect(read("packages/protocol/tsconfig.build.json").exclude).toEqual(["src/**/*.test.ts"]);
  });
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packRelease } from "./pack.js";

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

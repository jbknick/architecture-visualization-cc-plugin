import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reposSchema } from "./eval-lib.js";

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const here = fileURLToPath(new URL(".", import.meta.url));
const tiny = join(here, "eval-fixtures/tiny");
const realRepos = join(here, "../evals/oss/repos.json");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "gantry-evaltest-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", tsxLoader, join(here, `${script}.ts`), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("schema", () => {
  const valid = json(realRepos);
  it("validates the real evals/oss/repos.json", () => {
    const r = reposSchema.parse(valid);
    const names = r.repos.map((x) => x.name);
    for (const n of ["formbricks", "node-express-realworld-example-app", "react-tanstarter"])
      expect(names).toContain(n);
  });
  it("rejects a bad sha, a duplicate name and an unknown role", () => {
    const one = valid.repos[0];
    expect(reposSchema.safeParse({ repos: [{ ...one, sha: "abc" }] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [{ ...one, sha: one.sha.toUpperCase() }] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [one, one] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [{ ...one, role: "other" }] }).success).toBe(false);
  });
  it("rejects unsorted entries, a bad url and an empty stack", () => {
    const [a, b] = valid.repos;
    expect(reposSchema.safeParse({ repos: [b, a] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [{ ...a, url: "http://x/y.git" }] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [{ ...a, stack: [] }] }).success).toBe(false);
    expect(reposSchema.safeParse({ repos: [{ ...a, url: "file:///tmp/x" }] }).success).toBe(true);
  });
  it("validates the fixture file", () => {
    expect(reposSchema.safeParse(json(join(tiny, "repos.json"))).success).toBe(true);
  });
});

/** A clone of tiny/src as a git repository and a repos.json for it. */
function scratchCorpus() {
  const root = tmp();
  const clone = join(root, "tiny@");
  mkdirSync(join(root, "src-repo"));
  const src = join(root, "src-repo");
  cpSync(join(tiny, "src"), join(src, "src"), { recursive: true });
  git(src, "init", "-q", "-b", "main");
  git(src, "config", "user.email", "t@example.com");
  git(src, "config", "user.name", "t");
  git(src, "config", "commit.gpgsign", "false");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "tiny");
  const sha = git(src, "rev-parse", "HEAD");
  const repos = {
    repos: [{ name: "tiny", url: `file://${src}`, sha, stack: ["hono"], lang: ["ts"], role: "tuning" }],
  };
  const reposFile = join(root, "repos.json");
  writeFileSync(reposFile, JSON.stringify(repos));
  const oss = join(root, "oss");
  return { root, src, sha, reposFile, oss, clone };
}

describe("clone", () => {
  it("clones, is idempotent, refuses another commit and an invalid file", () => {
    const c = scratchCorpus();
    const env = { GANTRY_OSS_DIR: c.oss };
    const target = join(c.oss, `tiny@${c.sha.slice(0, 7)}`);

    const first = run("eval-clone", ["--repos", c.reposFile], env);
    expect(first.code).toBe(0);
    expect(first.out).toBe(`cloned tiny@${c.sha.slice(0, 7)}\n`);
    expect(git(target, "rev-parse", "HEAD")).toBe(c.sha);

    const second = run("eval-clone", ["--repos", c.reposFile], env);
    expect(second.code).toBe(0);
    expect(second.out).toBe(`ok tiny@${c.sha.slice(0, 7)}\n`);

    git(target, "config", "user.email", "t@example.com");
    git(target, "config", "user.name", "t");
    git(target, "config", "commit.gpgsign", "false");
    git(target, "checkout", "-q", "-b", "other");
    writeFileSync(join(target, "more.txt"), "x");
    git(target, "add", "-A");
    git(target, "commit", "-q", "-m", "more");
    const third = run("eval-clone", ["--repos", c.reposFile], env);
    expect(third.code).toBe(2);
    expect(third.out).toContain("error:");

    writeFileSync(join(c.root, "bad.json"), JSON.stringify({ repos: [{ name: "X" }] }));
    expect(run("eval-clone", ["--repos", join(c.root, "bad.json")], env).code).toBe(2);
  });

  it("reports a dirty tree as exit 2 and a failed clone as exit 1", () => {
    const c = scratchCorpus();
    const env = { GANTRY_OSS_DIR: c.oss };
    run("eval-clone", ["--repos", c.reposFile], env);
    writeFileSync(join(c.oss, `tiny@${c.sha.slice(0, 7)}`, "src", "db.ts"), "dirty");
    expect(run("eval-clone", ["--repos", c.reposFile], env).code).toBe(2);

    const repos = json(c.reposFile);
    repos.repos[0].url = `file://${join(c.root, "nowhere")}`;
    writeFileSync(c.reposFile, JSON.stringify(repos));
    const r = run("eval-clone", ["--repos", c.reposFile], { GANTRY_OSS_DIR: join(c.root, "oss2") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("error:");
    expect(existsSync(join(c.root, "oss2", `tiny@${c.sha.slice(0, 7)}`))).toBe(false);
  });

  it("refuses a target directory inside this repository", () => {
    const r = run("eval-clone", ["--repos", join(tiny, "repos.json")], {
      GANTRY_OSS_DIR: join(here, "..", "oss-clones"),
    });
    expect(r.code).toBe(2);
    expect(existsSync(join(here, "..", "oss-clones"))).toBe(false);
  });
});

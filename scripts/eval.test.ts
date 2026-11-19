import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Dump, keyOf, labelsSchema, normPath, predictionsOf, reposSchema, score } from "./eval-lib.js";

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
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", tsxLoader, join(here, `${script}.ts`), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const tinyArgs = [
  "tiny",
  "--repos",
  join(tiny, "repos.json"),
  "--labels",
  join(tiny, "labels.json"),
  "--dump",
  join(tiny, "dump.json"),
];

describe("schema", () => {
  const valid = json(realRepos);
  it("validates the real evals/oss/repos.json", () => {
    const r = reposSchema.parse(valid);
    expect(r.repos.map((x) => x.name)).toEqual([
      "formbricks",
      "node-express-realworld-example-app",
      "react-tanstarter",
    ]);
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
  it("validates the fixture files", () => {
    expect(reposSchema.safeParse(json(join(tiny, "repos.json"))).success).toBe(true);
    expect(labelsSchema.safeParse(json(join(tiny, "labels.json"))).success).toBe(true);
  });
});

describe("keys", () => {
  it("normalises dynamic segments", () => {
    for (const p of ["/posts/$id", "/posts/[id]", "/posts/{id}", "/posts/:id/", "//posts//:id"])
      expect(normPath(p)).toBe("/posts/:param");
    expect(normPath("/")).toBe("/");
    expect(normPath("")).toBe("/");
  });
  it("builds a key per kind", () => {
    expect(keyOf("route", { path: "/a/$b/", file: "x" })).toBe("/a/:param");
    expect(keyOf("endpoint", { method: "get", path: "/p/{id}", file: "x" })).toBe("GET /p/:param");
    expect(keyOf("endpoint", { rpc: "posts.list", file: "x" })).toBe("rpc posts.list");
    expect(keyOf("endpoint", { fn: "fetchPost", file: "x" })).toBe("fn fetchPost");
    expect(keyOf("table", { name: "Posts" })).toBe("posts");
    expect(keyOf("read", { file: "a.ts", table: "Posts" })).toBe("a.ts|posts");
    expect(keyOf("write", { file: "a.ts", table: "Posts" })).toBe("a.ts|posts");
    expect(keyOf("link", { file: "a.ts", endpoint: "get /api/$x" })).toBe("a.ts|GET /api/:param");
  });
});

describe("predictions and score", () => {
  const dump = json(join(tiny, "dump.json")) as Dump;
  const labels = labelsSchema.parse(json(join(tiny, "labels.json")));

  it("reads predictions from the dump's own records", () => {
    const p = predictionsOf(dump);
    expect(p.route).toEqual(["/"]);
    expect(p.endpoint).toEqual(["GET /posts/:param", "POST /posts", "rpc posts.list"]);
    expect(p.table).toEqual(["posts", "users"]);
    expect(p.read).toEqual(["src/db.ts|posts", "src/db.ts|users"]);
    expect(p.write).toEqual(["src/db.ts|posts"]);
    expect(p.link).toEqual([{ key: "src/app.ts|GET /posts/:param", confidence: "high" }]);
  });

  it("scores the fixture: endpoint recall below the bar, the rest pass", () => {
    const s = score("tiny", labels, dump);
    expect(s.kinds.endpoint).toEqual({
      labelled: 3,
      predicted: 3,
      matched: 2,
      precision: 0.6667,
      recall: 0.6667,
      pass: false,
    });
    expect(s.missed).toEqual({ endpoint: ["DELETE /posts/:param"] });
    expect(s.extra).toEqual({ endpoint: ["rpc posts.list"] });
    for (const k of ["route", "table", "read", "write", "link"]) expect(s.kinds[k]?.pass).toBe(true);
    expect(s.kinds.link?.wrongHigh).toBe(0);
    expect(s.kinds.endpoint).not.toHaveProperty("wrongHigh");
    expect(s.pass).toBe(false);
  });

  it("exits 1 below the bar and prints byte-identical output twice", () => {
    const a = run("eval-score", tinyArgs);
    const b = run("eval-score", tinyArgs);
    expect(a.code).toBe(1);
    expect(sha256(a.out)).toBe(sha256(b.out));
    expect(JSON.parse(a.out).kinds.endpoint.recall).toBeLessThan(0.9);
  });

  it("exits 0 when the labels equal the predictions", () => {
    const p = predictionsOf(dump);
    const dir = tmp();
    const same = {
      repo: "tiny",
      sha: labels.sha,
      labelledBy: "test",
      kinds: ["route", "endpoint", "table", "read", "write", "link"],
      route: p.route.map((path) => ({ path, file: "x" })),
      endpoint: [
        { method: "GET", path: "/posts/:id", file: "x" },
        { method: "POST", path: "/posts", file: "x" },
        { rpc: "posts.list", file: "x" },
      ],
      table: p.table.map((name) => ({ name })),
      read: p.read.map((k) => ({ file: k.split("|")[0], table: k.split("|")[1] })),
      write: p.write.map((k) => ({ file: k.split("|")[0], table: k.split("|")[1] })),
      link: [{ file: "src/app.ts", endpoint: "GET /posts/:id" }],
    };
    writeFileSync(join(dir, "labels.json"), JSON.stringify(same));
    const r = run("eval-score", [
      "tiny",
      "--repos",
      join(tiny, "repos.json"),
      "--labels",
      join(dir, "labels.json"),
      "--dump",
      join(tiny, "dump.json"),
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).pass).toBe(true);
  });

  it("exits 2 on a sha mismatch, an unknown case, missing labels and no dump source", () => {
    const dir = tmp();
    writeFileSync(join(dir, "labels.json"), JSON.stringify({ ...labels, sha: "f".repeat(40) }));
    const args = ["tiny", "--repos", join(tiny, "repos.json"), "--dump", join(tiny, "dump.json")];
    expect(run("eval-score", [...args, "--labels", join(dir, "labels.json")]).code).toBe(2);
    expect(run("eval-score", ["no-such-case"]).code).toBe(2);
    expect(run("eval-score", ["tiny", "--repos", join(tiny, "repos.json")]).code).toBe(2);
    expect(run("eval-score", []).code).toBe(2);
    // Real case, no clone and no build requested through --dump: it needs the clone.
    expect(
      run(
        "eval-score",
        ["tiny", "--repos", join(tiny, "repos.json"), "--labels", join(tiny, "labels.json")],
        { GANTRY_OSS_DIR: dir, GANTRY_EVAL_CLI: join(dir, "missing.js") },
      ).code,
    ).toBe(2);
  });

  it("counts a high-confidence link the labels lack as wrongHigh, and a low one as not", () => {
    const extra = (confidence: string) => ({
      src: "sym:src/app.ts#loadPost",
      dst: "ep:.:POST /posts",
      kind: "requests",
      confidence,
      count: 1,
      evidence: [],
      fileId: "file:src/app.ts",
    });
    const dir = tmp();
    writeFileSync(join(dir, "labels.json"), JSON.stringify({ ...labels, kinds: ["link"] }));
    const linkRun = (confidence: string) => {
      writeFileSync(
        join(dir, "dump.json"),
        JSON.stringify({ ...dump, edges: [...dump.edges, extra(confidence)] }),
      );
      return run("eval-score", [
        "tiny",
        "--repos",
        join(tiny, "repos.json"),
        "--labels",
        join(dir, "labels.json"),
        "--dump",
        join(dir, "dump.json"),
      ]);
    };
    const high = linkRun("high");
    expect(JSON.parse(high.out).kinds.link.wrongHigh).toBe(1);
    expect(high.code).toBe(1);
    const low = linkRun("low");
    expect(JSON.parse(low.out).kinds.link.wrongHigh).toBe(0);
  });
});

/** A clone of tiny/src as a git repository, a repos.json for it and a stand-in CLI. */
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
  const labelsFile = join(root, "labels.json");
  writeFileSync(labelsFile, JSON.stringify({ ...json(join(tiny, "labels.json")), sha }));
  // Stand-in for plugin/dist/cli.js: records what it saw in its cwd, then prints the fixture dump.
  const cli = join(root, "cli.js");
  writeFileSync(
    cli,
    `const fs = require("node:fs");
fs.writeFileSync("cli-ran.txt", fs.existsSync(".gantry/recipe.json") ? "recipe" : "no recipe");
process.stdout.write(fs.readFileSync(${JSON.stringify(join(tiny, "dump.json"))}, "utf8"));
`,
  );
  return { root, src, sha, reposFile, oss, labelsFile, cli, clone };
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

describe("recipe", () => {
  it("writes the recipe only into a temp copy of the clone", () => {
    const c = scratchCorpus();
    const env = { GANTRY_OSS_DIR: c.oss, GANTRY_EVAL_CLI: c.cli };
    expect(run("eval-clone", ["--repos", c.reposFile], env).code).toBe(0);
    const target = join(c.oss, `tiny@${c.sha.slice(0, 7)}`);
    const before = readdirSync(target, { recursive: true }).sort();
    const recipe = join(c.root, "recipe.json");
    writeFileSync(recipe, "{}");
    const r = run(
      "eval-score",
      ["tiny", "--repos", c.reposFile, "--labels", c.labelsFile, "--recipe", recipe],
      env,
    );
    expect(r.code).toBe(1); // the stand-in prints the fixture dump, which is below the bar
    expect(JSON.parse(r.out).case).toBe("tiny");
    expect(readdirSync(target, { recursive: true }).sort()).toEqual(before);
    expect(git(target, "status", "--porcelain")).toBe("");
    // Without --recipe the stand-in runs in the clone itself and sees no recipe.
    run("eval-score", ["tiny", "--repos", c.reposFile, "--labels", c.labelsFile], env);
    expect(readFileSync(join(target, "cli-ran.txt"), "utf8")).toBe("no recipe");
  });
});

describe("recipes", () => {
  it("prints no reference recipes for an empty directory and exits 0", () => {
    const dir = tmp();
    const r = run("eval-recipes", ["--recipes-dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("no reference recipes\n");
  });

  it("scores a case with a reference recipe, one JSON line plus a summary", () => {
    const c = scratchCorpus();
    const env = { GANTRY_OSS_DIR: c.oss, GANTRY_EVAL_CLI: c.cli };
    run("eval-clone", ["--repos", c.reposFile], env);
    const dir = join(c.root, "recipes");
    mkdirSync(dir);
    writeFileSync(join(dir, "tiny.recipe.json"), "{}");
    const labelsDir = join(c.root, "labels");
    mkdirSync(labelsDir);
    cpSync(c.labelsFile, join(labelsDir, "tiny.json"));
    const args = ["--recipes-dir", dir, "--repos", c.reposFile, "--labels-dir", labelsDir];
    const r = run("eval-recipes", args, env);
    expect(r.code).toBe(1); // the stand-in prints the fixture dump, below the bar on endpoints
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).case).toBe("tiny");
    expect(JSON.parse(lines[1] as string)).toEqual({ summary: { cases: 1, passed: 0 } });
    expect(run("eval-recipes", [...args, "--only", "nope"], env).code).toBe(2);
    expect(run("eval-recipes", ["--recipes-dir", dir, "--repos", c.reposFile], env).code).toBe(2); // no labels in evals/oss/labels
  });
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolvePaths } from "../paths/index.js";
import {
  findWorkspaceFile,
  loadWorkspaceFile,
  looksLikeUrl,
  WORKSPACE_FILE,
  WorkspaceFileError,
  WorkspaceFileSchema,
} from "./file.js";

let tmp: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function makeRepo(dir: string, remote?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return fs.realpathSync(dir);
}
const writeFile = (dir: string, content: unknown): string => {
  const file = path.join(dir, WORKSPACE_FILE);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceFileError);
    return (err as Error).message;
  }
  throw new Error("expected a WorkspaceFileError");
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gantry-wsfile-")));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh directory under `tmp` with repos `web` and `api` (the latter has an origin remote) and a file listing both. */
function scene(name: string): { dir: string; web: string; api: string; file: string } {
  const dir = path.join(tmp, name);
  const web = makeRepo(path.join(dir, "web"));
  const api = makeRepo(path.join(dir, "api"), "https://github.com/acme/api.git");
  const file = writeFile(dir, { repos: [{ path: "./web" }, { path: "./api" }] });
  return { dir: fs.realpathSync(dir), web, api, file };
}

describe("the schema", () => {
  test("needs at least one repo, with a path, and an optional repo name", () => {
    expect(WorkspaceFileSchema.safeParse({ repos: [{ path: "./a" }] }).success).toBe(true);
    expect(WorkspaceFileSchema.safeParse({ repos: [{ path: "./a", repo: "acme/a" }] }).success).toBe(true);
    expect(WorkspaceFileSchema.safeParse({ repos: [] }).success).toBe(false);
    expect(WorkspaceFileSchema.safeParse({}).success).toBe(false);
    expect(WorkspaceFileSchema.safeParse({ repos: [{}] }).success).toBe(false);
    expect(WorkspaceFileSchema.safeParse({ repos: [{ path: "./a", extra: 1 }] }).success).toBe(false);
    expect(WorkspaceFileSchema.safeParse({ repos: [{ path: "./a", repo: "a:b" }] }).success).toBe(false);
  });

  test("a value that looks like a URL is not a local path", () => {
    for (const v of ["https://github.com/x/y", "ssh://git@host/x/y", "git@github.com:x/y.git", "file://x"]) {
      expect(looksLikeUrl(v), v).toBe(true);
    }
    for (const v of ["./web", "../api", "/abs/path", "web", "C:\\repos\\web"])
      expect(looksLikeUrl(v), v).toBe(false);
  });
});

describe("loadWorkspaceFile", () => {
  test("reads the repos, names them (override first, else origin, else directory) and sorts by name", () => {
    const s = scene("load-ok");
    writeFile(s.dir, { repos: [{ path: "./web" }, { path: "./api" }] });
    const ws = loadWorkspaceFile(s.file);
    expect(ws.dir).toBe(s.dir);
    expect(ws.repos).toEqual([
      { name: "acme/api", root: s.api },
      { name: "web", root: s.web },
    ]);
    writeFile(s.dir, {
      repos: [
        { path: "./web", repo: "frontend" },
        { path: s.api, repo: "acme/api" },
      ],
    });
    expect(loadWorkspaceFile(s.file).repos.map((r) => r.name)).toEqual(["acme/api", "frontend"]);
  });

  test("rejects a URL as a path, naming the file and the entry, before anything else", () => {
    const s = scene("load-url");
    for (const url of ["https://github.com/x/y", "git@github.com:x/y.git"]) {
      writeFile(s.dir, { repos: [{ path: "./web" }, { path: url }] });
      expect(messageOf(() => loadWorkspaceFile(s.file))).toBe(
        `workspace file ${s.file}: repos[1].path must be a local path, not a URL`,
      );
    }
  });

  test("rejects a path that is not the root of a git repository", () => {
    const s = scene("load-nonroot");
    fs.mkdirSync(path.join(s.web, "src"));
    fs.mkdirSync(path.join(s.dir, "plain"));
    for (const p of ["./web/src", "./plain", "./missing"]) {
      writeFile(s.dir, { repos: [{ path: p }] });
      expect(messageOf(() => loadWorkspaceFile(s.file))).toBe(
        `workspace file ${s.file}: repos[0].path ${p} is not the root of a git repository`,
      );
    }
  });

  test("rejects duplicate repo names and one repo listed twice", () => {
    const s = scene("load-dup");
    writeFile(s.dir, {
      repos: [
        { path: "./web", repo: "same" },
        { path: "./api", repo: "same" },
      ],
    });
    expect(messageOf(() => loadWorkspaceFile(s.file))).toContain(
      "repos[1] and repos[0] have the same repo name same",
    );
    const other = makeRepo(path.join(s.dir, "x", "web"));
    expect(other).not.toBe(s.web);
    writeFile(s.dir, { repos: [{ path: "./web" }, { path: "./x/web" }] });
    expect(messageOf(() => loadWorkspaceFile(s.file))).toContain("have the same repo name web");
    writeFile(s.dir, { repos: [{ path: "./web" }, { path: "./web/../web", repo: "w2" }] });
    expect(messageOf(() => loadWorkspaceFile(s.file))).toContain(
      "repos[1].path lists the same repository as repos[0]",
    );
  });

  test("reports unreadable, malformed and invalid files", () => {
    const s = scene("load-bad");
    expect(messageOf(() => loadWorkspaceFile(path.join(s.dir, "nope.json")))).toContain("cannot read it");
    writeFile(s.dir, "{ not json");
    expect(messageOf(() => loadWorkspaceFile(s.file))).toContain("not valid JSON");
    writeFile(s.dir, { repos: [] });
    expect(messageOf(() => loadWorkspaceFile(s.file))).toContain("repos must list at least one repo");
  });
});

describe("findWorkspaceFile", () => {
  test("walks up from the parent of the repo and takes the file that lists the repo", () => {
    const s = scene("find-up");
    const ws = findWorkspaceFile(s.web);
    expect(ws?.file).toBe(s.file);
    expect(findWorkspaceFile(s.api)?.repos.map((r) => r.name)).toEqual(["acme/api", "web"]);
  });

  test("a file above that does not list the repo is passed over; with no file the answer is undefined", () => {
    const s = scene("find-skip");
    const outsider = makeRepo(path.join(s.dir, "outsider"));
    expect(findWorkspaceFile(outsider)).toBeUndefined();
    // Two files that list the same repo would give it two indexes: an error that names both.
    const inner = path.join(s.dir, "group");
    fs.mkdirSync(inner);
    const nested = makeRepo(path.join(inner, "svc"));
    const outerFile = writeFile(s.dir, { repos: [{ path: "./web" }, { path: "./group/svc" }] });
    expect(findWorkspaceFile(nested)?.file).toBe(outerFile);
    const innerFile = writeFile(inner, { repos: [{ path: "./svc" }] });
    expect(messageOf(() => findWorkspaceFile(nested))).toBe(
      `workspace file ${innerFile}: ${nested} is also listed by ${outerFile}; keep it in one file, or pass --workspace <file>`,
    );
    // The repo only the outer file lists is not affected by the inner file.
    expect(findWorkspaceFile(s.web)?.file).toBe(outerFile);
  });

  test("stops at the home directory", () => {
    const s = scene("find-home");
    const home = path.join(s.dir, "home");
    const below = makeRepo(path.join(home, "work", "app"));
    writeFile(home, { repos: [{ path: "./work/app" }] });
    expect(findWorkspaceFile(below, { home })?.file).toBe(path.join(home, WORKSPACE_FILE));
    // A file above home is never read, even though it lists the repo.
    fs.rmSync(path.join(home, WORKSPACE_FILE));
    writeFile(s.dir, { repos: [{ path: "./home/work/app" }] });
    expect(findWorkspaceFile(below, { home })).toBeUndefined();
    expect(findWorkspaceFile(below, { home: path.join(tmp, "elsewhere") })?.file).toBe(
      path.join(s.dir, WORKSPACE_FILE),
    );
  });

  test("an invalid file on the way up is an error, not a workspace of one", () => {
    const s = scene("find-invalid");
    writeFile(s.dir, { repos: [{ path: "https://github.com/x/y" }] });
    expect(messageOf(() => findWorkspaceFile(s.web))).toContain("must be a local path, not a URL");
  });

  test("finds the file when the repo is reached through a symlink from outside its directory", () => {
    const s = scene("find-link");
    const real = makeRepo(path.join(tmp, "find-link-real", "lib"));
    fs.symlinkSync(real, path.join(s.dir, "lib"));
    writeFile(s.dir, { repos: [{ path: "./web" }, { path: "./lib" }] });
    // From the real root alone the walk finds nothing; from the path the user is in it finds the file.
    expect(findWorkspaceFile(real)).toBeUndefined();
    expect(findWorkspaceFile(real, { startAbove: path.join(s.dir, "lib") })?.file).toBe(
      path.join(s.dir, WORKSPACE_FILE),
    );
    expect(resolvePaths(path.join(s.dir, "lib", "."), { HOME: path.join(tmp, "h") }).workspace.file).toBe(
      path.join(s.dir, WORKSPACE_FILE),
    );
  });
});

describe("resolvePaths with a workspace file", () => {
  const base = (): NodeJS.ProcessEnv => ({
    HOME: path.join(tmp, "home-x"),
    CLAUDE_PLUGIN_DATA: path.join(tmp, "base"),
  });

  test("every repo of the workspace shares one data dir keyed by the file's directory", () => {
    const s = scene("paths-shared");
    const a = resolvePaths(s.web, base());
    const b = resolvePaths(path.join(s.api), base());
    const hash = createHash("sha256").update(s.dir).digest("hex").slice(0, 16);
    expect(a.dataDir).toBe(path.join(tmp, "base", "workspaces", hash));
    expect(b.dataDir).toBe(a.dataDir);
    expect(a.dbPath).toBe(b.dbPath);
    expect(a.repo).toBe("web");
    expect(b.repo).toBe("acme/api");
    expect(a.root).toBe(s.web);
    expect(a.workspace).toEqual({
      file: s.file,
      repos: [
        { name: "acme/api", root: s.api },
        { name: "web", root: s.web },
      ],
    });
  });

  test("a repo with no workspace file is a workspace of one in <base>/repos/<worktreeHash>", () => {
    const lone = makeRepo(path.join(tmp, "lone-dir", "lone"));
    const p = resolvePaths(lone, base());
    expect(p.workspace).toEqual({ file: null, repos: [{ name: "lone", root: lone }] });
    expect(p.dataDir).toBe(path.join(tmp, "base", "repos", p.worktreeHash));
  });

  test("the repo name comes from the file's override when there is one", () => {
    const s = scene("paths-override");
    writeFile(s.dir, { repos: [{ path: "./web", repo: "frontend" }, { path: "./api" }] });
    expect(resolvePaths(s.web, base()).repo).toBe("frontend");
  });

  test("--workspace replaces discovery, and must list the repo", () => {
    const s = scene("paths-flag");
    const elsewhere = path.join(tmp, "paths-flag-elsewhere");
    fs.mkdirSync(elsewhere);
    const mine = makeRepo(path.join(tmp, "paths-flag-mine", "mine"));
    const other = writeFile(elsewhere, { repos: [{ path: mine }, { path: s.web, repo: "w" }] });
    // Discovery alone finds nothing for `mine`; the flag gives it a workspace (a relative path is read from cwd).
    expect(resolvePaths(mine, base()).workspace.file).toBeNull();
    const viaFlag = resolvePaths(mine, base(), { workspaceFile: other });
    expect(viaFlag.workspace.file).toBe(other);
    expect(viaFlag.repo).toBe("mine");
    // For `web` the flag wins over the file next to it.
    const web = resolvePaths(s.web, base(), { workspaceFile: other });
    expect(web.workspace.file).toBe(other);
    expect(web.repo).toBe("w");
    expect(web.dataDir).not.toBe(resolvePaths(s.web, base()).dataDir);
    // A file that does not list the repo is an error.
    expect(messageOf(() => resolvePaths(s.api, base(), { workspaceFile: other }))).toContain(
      "does not list this repository",
    );
    expect(
      messageOf(() => resolvePaths(mine, base(), { workspaceFile: path.join(elsewhere, "missing.json") })),
    ).toContain("cannot read it");
  });
});

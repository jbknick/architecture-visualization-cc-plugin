import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureName =
  | "single-pkg"
  | "pnpm-turbo"
  | "nx"
  | "ts-references"
  | "tsconfig-extends-workspace"
  | "no-workspace-tool"
  | "bundler-aliases"
  | "adapters"
  | "linking"
  | "go-basic"
  | "java-basic"
  | "python-basic"
  | "overlay-groups"
  | "deep-radius"
  | "go-recipes/nethttp"
  | "go-recipes/chi"
  | "go-recipes/gin"
  | "go-recipes/sql";

export interface MaterializeOptions {
  /**
   * Also create branch `feature` from `main` with the files of `fixtures/<name>.feature/` copied over the tree, then
   * check `main` out again. Both commits get a fixed author, committer and date, so their SHAs are the same on every
   * machine.
   */
  feature?: boolean;
  /** Name of the directory the repo is created in, which is the repo name in ids (default: the fixture's name). */
  dirName?: string;
}

export interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

const FIXED_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Gantry Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Gantry Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** Copy a fixture to `<temp dir>/<name>`, `git init -b main`, set a local user, commit everything as "fixture". */
export async function materializeFixture(
  name: FixtureName,
  opts: MaterializeOptions = {},
): Promise<MaterializedFixture> {
  // The repo name of a fixture (no remote) is the basename of its directory, so every run gets the same ids.
  const parent = await mkdtemp(join(tmpdir(), `gantry-fixture-${name.replace("/", "-")}-`));
  return materializeInto(name, join(parent, opts.dirName ?? name.replace(/^.*\//, "")), opts, () =>
    rm(parent, { recursive: true, force: true }),
  );
}

/** `materializeFixture` into `dir` (which must not exist yet), for `scripts/fixture-repo.ts`. */
export async function materializeInto(
  name: FixtureName,
  dir: string,
  opts: MaterializeOptions = {},
  cleanup: () => Promise<void> = async () => {},
): Promise<MaterializedFixture> {
  await cp(join(fixturesRoot, name), dir, { recursive: true });
  const fx = commitAll(dir, cleanup, opts.feature === true);
  if (opts.feature) {
    fx.git(["checkout", "-q", "-b", "feature"]);
    await cp(join(fixturesRoot, `${name}.feature`), dir, { recursive: true });
    fx.git(["add", "-A", "-f"]);
    fx.git(["commit", "-q", "-m", "feature"]);
    fx.git(["checkout", "-q", "main"]);
  }
  return fx;
}

/** Write `files` (path to text) into a fresh temp repo named `repo` and commit them, like `materializeFixture`. */
export async function materializeFiles(
  files: Record<string, string>,
  repo = "repo",
): Promise<MaterializedFixture> {
  const parent = await mkdtemp(join(tmpdir(), "gantry-files-"));
  const dir = join(parent, repo);
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return commitAll(dir, () => rm(parent, { recursive: true, force: true }), false);
}

function commitAll(dir: string, cleanup: () => Promise<void>, fixedDates: boolean): MaterializedFixture {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: fixedDates ? { ...process.env, ...FIXED_COMMIT_ENV } : process.env,
    });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Gantry Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A", "-f"]);
  git(["commit", "-q", "-m", "fixture"]);
  return { dir, git, cleanup };
}

export interface MaterializedLinkingRepos {
  /** The temp directory that holds `gantry-workspace.json` and the three repos (it is not a repo itself). */
  root: string;
  repos: { web: string; "users-api": string; billing: string };
  cleanup(): Promise<void>;
}

/**
 * Copies `fixtures/linking-repos` to a temp dir, makes `web/`, `users-api/` and `billing/` three separate git repos on
 * `main` (fixed author and dates) and writes the `gantry-workspace.json` that lists them, each named like its directory.
 */
export async function materializeLinkingRepos(): Promise<MaterializedLinkingRepos> {
  const root = await mkdtemp(join(tmpdir(), "gantry-fixture-linking-repos-"));
  const names = ["web", "users-api", "billing"] as const;
  const dirs = {
    web: join(root, "web"),
    "users-api": join(root, "users-api"),
    billing: join(root, "billing"),
  };
  for (const name of names) {
    await cp(join(fixturesRoot, "linking-repos", name), dirs[name], { recursive: true });
    commitAll(dirs[name], async () => {}, true);
  }
  await writeFile(
    join(root, "gantry-workspace.json"),
    JSON.stringify({ repos: names.map((name) => ({ path: `./${name}`, repo: name })) }),
  );
  return { root, repos: dirs, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface MaterializedMultirepo {
  /** The temp directory that holds `gantry-workspace.json` and the two repos (it is not a repo itself). */
  root: string;
  repos: { web: string; api: string };
  /** Runs git in one of the two repos. */
  git: (repo: "web" | "api", args: string[]) => string;
  cleanup(): Promise<void>;
}

/**
 * Copies `fixtures/multirepo` to a temp dir and makes `web/` and `api/` two separate git repos on `main`, each with one
 * commit `fixture` (fixed author and dates, so the SHAs are the same on every machine). The temp root is not a repo.
 * The workspace file at the root lists both: `web` is named `web`, `api` is named `acme/api`.
 */
export async function materializeMultirepo(): Promise<MaterializedMultirepo> {
  const root = await mkdtemp(join(tmpdir(), "gantry-fixture-multirepo-"));
  await cp(join(fixturesRoot, "multirepo"), root, { recursive: true });
  const dirs = { web: join(root, "web"), api: join(root, "api") };
  const git = (repo: "web" | "api", args: string[]): string =>
    execFileSync("git", args, {
      cwd: dirs[repo],
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...FIXED_COMMIT_ENV },
    });
  for (const repo of ["web", "api"] as const) {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Gantry Fixture"]);
    git(repo, ["config", "user.email", "fixture@example.invalid"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    git(repo, ["add", "-A", "-f"]);
    git(repo, ["commit", "-q", "-m", "fixture"]);
  }
  return { root, repos: dirs, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

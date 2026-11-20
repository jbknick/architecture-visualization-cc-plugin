import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureName = "single-pkg" | "pnpm-turbo" | "nx" | "adapters" | "go-basic" | "overlay-groups";

export interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

/** Copy a fixture to `<temp dir>/<name>`, `git init -b main`, set a local user, commit everything as "fixture". */
export async function materializeFixture(name: FixtureName): Promise<MaterializedFixture> {
  // The repo name of a fixture (no remote) is the basename of its directory, so every run gets the same ids.
  const parent = await mkdtemp(join(tmpdir(), `gantry-fixture-${name}-`));
  const dir = join(parent, name);
  await cp(join(fixturesRoot, name), dir, { recursive: true });
  return commitAll(parent, dir);
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
  return commitAll(parent, dir);
}

async function commitAll(parent: string, dir: string): Promise<MaterializedFixture> {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Gantry Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A", "-f"]);
  git(["commit", "-m", "fixture"]);
  return { dir, git, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

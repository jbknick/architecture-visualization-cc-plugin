import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

const FIXED = {
  GIT_AUTHOR_NAME: "Gantry Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Gantry Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export interface UploadFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}

/**
 * Copies `fixtures/<name>` to `<temp>/<dirName>`, commits it on `main` with a fixed author and dates (so the commit
 * sha is the same on every machine and run), sets `origin` to `origin` when given, and, when `edit` is given, commits
 * that edit on a branch `branch` (replacing `from` with `to` in `file`).
 */
export async function materializeUploadFixture(
  name: string,
  opts: {
    dirName: string;
    origin?: string;
    branch?: string;
    edit?: { file: string; from: string; to: string };
  },
): Promise<UploadFixture> {
  const parent = await mkdtemp(join(tmpdir(), "gantry-upload-"));
  const dir = join(parent, opts.dirName);
  await cp(join(fixturesRoot, name), dir, { recursive: true });
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...FIXED },
    });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Gantry Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  if (opts.origin !== undefined) git(["remote", "add", "origin", opts.origin]);
  git(["add", "-A", "-f"]);
  git(["commit", "-q", "-m", "fixture"]);
  if (opts.edit !== undefined && opts.branch !== undefined) {
    git(["checkout", "-q", "-b", opts.branch]);
    const file = join(dir, opts.edit.file);
    const text = await readFile(file, "utf8");
    if (!text.includes(opts.edit.from)) throw new Error(`edit target not found in ${opts.edit.file}`);
    await writeFile(file, text.replace(opts.edit.from, opts.edit.to));
    git(["add", "-A", "-f"]);
    git(["commit", "-q", "-m", "edit"]);
    git(["checkout", "-q", "main"]);
  }
  return { dir, git, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

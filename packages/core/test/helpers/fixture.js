import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");
/** Copy a fixture to a temp dir, `git init -b main`, set a local user, commit everything as "fixture". */
export async function materializeFixture(name) {
  const dir = await mkdtemp(join(tmpdir(), `gantry-fixture-${name}-`));
  await cp(join(fixturesRoot, name), dir, { recursive: true });
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Gantry Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A", "-f"]);
  git(["commit", "-m", "fixture"]);
  return { dir, git, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

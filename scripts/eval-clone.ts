// pnpm eval:clone [--only <name>...] [--repos <file>]: clone each pinned repo at its SHA (spec section 13).
// Exit 0: every repo is at its SHA. 1: a clone or checkout failed. 2: invalid repos file, target at another
// commit or dirty, or a target directory inside this repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { InputError, ossDir, readRepos, repoRoot, targetDir } from "./eval-lib.js";

const git = (cwd: string | null, ...args: string[]) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const gitMessage = (err: unknown) => {
  const e = err as { stderr?: string; message: string };
  return (e.stderr?.trim() || e.message).split("\n")[0] ?? "git failed";
};

function parseArgs(argv: string[]): { only: string[]; repos?: string } {
  const only: string[] = [];
  let repos: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repos") repos = argv[++i];
    else if (a === "--only") {
      while (argv[i + 1] && !argv[i + 1]?.startsWith("--")) only.push(argv[++i] as string);
    } else throw new InputError(`unknown argument ${a}`);
  }
  return { only, repos };
}

function main(): number {
  let code = 0;
  try {
    const { only, repos: reposFile } = parseArgs(process.argv.slice(2));
    const all = readRepos(reposFile ? resolve(reposFile) : undefined);
    for (const n of only) if (!all.some((r) => r.name === n)) throw new InputError(`unknown repo ${n}`);
    const base = resolve(ossDir());
    const rel = relative(repoRoot, base);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new InputError(`${base} is inside this repository; set GANTRY_OSS_DIR to a directory outside it`);
    }
    mkdirSync(base, { recursive: true });
    for (const r of all.filter((x) => only.length === 0 || only.includes(x.name))) {
      const target = targetDir(r, base);
      const label = `${r.name}@${r.sha.slice(0, 7)}`;
      if (existsSync(target)) {
        const head = git(target, "rev-parse", "HEAD");
        if (head !== r.sha) {
          console.log(`error: ${label} is at ${head}, not ${r.sha}; remove ${target} or fix repos.json`);
          code = 2;
          continue;
        }
        if (git(target, "status", "--porcelain") !== "") {
          console.log(`error: ${label} has a dirty tree: ${target}`);
          code = 2;
          continue;
        }
        console.log(`ok ${label}`);
        continue;
      }
      try {
        git(null, "clone", "--no-checkout", "-q", r.url, target);
        git(target, "checkout", "-q", "--detach", r.sha);
        console.log(`cloned ${label}`);
      } catch (err) {
        rmSync(target, { recursive: true, force: true });
        console.log(`error: ${label}:${gitMessage(err)}`);
        code = code === 2 ? 2 : 1;
      }
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`eval:clone: ${err.message}`);
    return 2;
  }
  return code;
}

process.exitCode = main();

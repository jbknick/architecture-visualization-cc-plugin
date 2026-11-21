// Local end-to-end run of the pull request comment Action (issue #282), with no network and no GitHub:
// a copy of fixtures/pnpm-turbo gets a branch that adds a copy of `slugify`, the built CLI indexes it, and the built
// Action script (plugin/dist/action.js) runs twice against a fake GitHub API on node:http.
// Expected output: `created`, `updated`, `comments: 1`. Run `pnpm build` first; `pnpm action:e2e [--body]` runs this.
// `pnpm action:e2e --write-pair <dir>` also writes the review and duplicates JSON of that branch (review.json,
// duplicates.json) into <dir>; the commits have fixed dates, so the two files are the same bytes on every run. The
// pair committed under action/testdata/ is made this way and is what the snapshot test renders.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeGithub } from "../action/src/testkit.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "plugin/dist/cli.js");
const action = join(root, "plugin/dist/action.js");
for (const f of [cli, action]) {
  if (!existsSync(f)) {
    console.error(`${f} is missing: run pnpm build first`);
    process.exit(1);
  }
}

const FIXED_DATE = "2026-01-01T00:00:00Z";
const work = mkdtempSync(join(tmpdir(), "gantry-action-e2e-"));
const repo = join(work, "pnpm-turbo");
const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  }).trim();

function runAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [action], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

const fake = await startFakeGithub({ pageSize: 2 });
try {
  cpSync(join(root, "fixtures/pnpm-turbo"), repo, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.name", "Gantry E2E");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A", "-f");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  cpSync(join(repo, "packages/utils/src/slug.ts"), join(repo, "packages/ui/src/slug-copy.ts"));
  git("add", "-A");
  git("commit", "-m", "add a copy of slugify");
  const head = git("rev-parse", "HEAD");

  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  const init = spawnSync("node", [cli, "init"], { cwd: repo, env, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`gantry init failed: ${init.stderr}`);

  const pairFlag = process.argv.indexOf("--write-pair");
  if (pairFlag !== -1) {
    const outDir = process.argv[pairFlag + 1];
    if (!outDir) throw new Error("--write-pair needs a directory");
    mkdirSync(outDir, { recursive: true });
    const json = (args: string[]): string => {
      const r = spawnSync("node", [cli, ...args], { cwd: repo, env, encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new Error(`gantry ${args[0]} failed: ${r.stderr}`);
      return r.stdout;
    };
    writeFileSync(join(outDir, "review.json"), json(["review", `${base}...${head}`, "--json"]));
    writeFileSync(join(outDir, "duplicates.json"), json(["duplicates", "--since", base, "--json"]));
    console.log(`wrote review.json and duplicates.json to ${outDir}`);
  }

  const eventPath = join(work, "event.json");
  const sameRepo = { full_name: "octo/fixture" };
  writeFileSync(
    eventPath,
    JSON.stringify({
      number: 1,
      pull_request: { number: 1, base: { sha: base, repo: sameRepo }, head: { sha: head, repo: sameRepo } },
    }),
  );
  const summaryPath = join(work, "summary.md");
  const actionEnv = {
    ...env,
    GANTRY_BIN: join(root, "plugin/bin/gantry"),
    GANTRY_TOKEN: "test-token",
    GITHUB_API_URL: fake.url,
    GITHUB_REPOSITORY: "octo/fixture",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  };
  const results: string[] = [];
  for (let i = 0; i < 2; i++) {
    // Asynchronous: the fake API answers from this process, so a blocking spawn would deadlock it.
    const r = await runAction(repo, actionEnv);
    if (r.status !== 0) throw new Error(`action.js failed (${r.status}): ${r.stdout}${r.stderr}`);
    const word = /^gantry-action: (created|updated|summary)$/m.exec(r.stdout)?.[1];
    results.push(word ?? "unknown");
  }
  for (const word of results) console.log(word);
  console.log(`comments: ${fake.comments.length}`);
  const body = fake.comments[0]?.body ?? "";
  console.log(`body: ${body.length} characters`);
  if (process.argv.includes("--body")) console.log(`\n${body}`);
  const ok = results[0] === "created" && results[1] === "updated" && fake.comments.length === 1;
  if (!ok) process.exitCode = 1;
} finally {
  await fake.close();
  rmSync(work, { recursive: true, force: true });
}

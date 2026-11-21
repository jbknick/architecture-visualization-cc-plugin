// Local end-to-end run of re-attaching a label to a function renamed in place (issue #349), against the built CLI
// (plugin/dist/cli.js), never a dev or mock server. A copy of fixtures/pnpm-turbo becomes a git repo; the explorer
// (`gantry map`) labels `formatRelativeDate` through PUT /api/overlay/labels; the function is renamed in place to
// `formatRelative` (and its uses) and committed; `hook session-start` runs (it must not touch overlay.db), then
// `gantry heal` re-attaches; GET /api/overlay must show the label on the new id and `unresolved` empty.
// Expected output ends with `ok`. Run `pnpm build` first; `pnpm reattach:e2e` runs this.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const cli = join(root, "plugin/dist/cli.js");
if (!existsSync(cli)) {
  console.error(`${cli} is missing: run pnpm build first`);
  process.exit(1);
}

const DATE = "packages/utils/src/date.ts";
const OLD = `sym:pnpm-turbo:${DATE}#formatRelativeDate`;
const NEW = `sym:pnpm-turbo:${DATE}#formatRelative`;
const TEXT = "Relative date";

const work = mkdtempSync(join(tmpdir(), "gantry-reattach-e2e-"));
const repo = join(work, "pnpm-turbo");
const dataDir = join(work, "data");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(work, "home"), CLAUDE_PLUGIN_DATA: dataDir };
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gantry = (...args: string[]): string => {
  const r = spawnSync("node", [cli, ...args], { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gantry ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const edit = (rel: string, from: string, to: string): void => {
  const file = join(repo, rel);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(from, to));
};

/** Starts `gantry map` and returns its address (`?t=` carries the token) and a way to stop it. */
async function startMap(): Promise<{ base: string; token: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn("node", [cli, "map", "--no-open", "--idle-timeout", "5"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)\?t=(\S+)/.exec(out);
      if (m) resolve(`${m[1]}?t=${m[2]}`);
    });
    child.on("close", () => reject(new Error(`gantry map exited early: ${out}`)));
  });
  const u = new URL(url);
  return {
    base: u.origin,
    token: u.searchParams.get("t") as string,
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners("close");
        child.on("close", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

interface OverlayJson {
  labels: { nodeId: string; text: string }[];
  unresolved: { id: string; reason: string }[];
}

try {
  mkdirSync(dataDir);
  cpSync(join(root, "fixtures/pnpm-turbo"), repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Gantry E2E");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "base");
  gantry("init");

  let map = await startMap();
  const put = await fetch(`${map.base}/api/overlay/labels`, {
    method: "PUT",
    headers: { "x-gantry-token": map.token, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: OLD, text: TEXT }),
  });
  console.log(`label PUT ${OLD}: ${put.status}`);
  await map.stop();
  if (put.status !== 200) throw new Error("the label was not stored");

  // The rename: the function in its file, the barrel and the route that calls it.
  for (const rel of [DATE, "packages/utils/src/index.ts", "apps/web/src/routes/posts.$postId.tsx"]) {
    edit(rel, "formatRelativeDate", "formatRelative");
  }
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "rename formatRelativeDate to formatRelative");

  // The data dir holds one folder per repository; there is exactly one here.
  const overlay = join(
    dataDir,
    readdirSync(dataDir, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith("overlay.db")) ??
      "overlay.db",
  );
  const before = sha256(overlay);
  const hook = spawnSync("node", [cli, "hook", "session-start"], { cwd: repo, env, encoding: "utf8" });
  const hookSame = sha256(overlay) === before;
  console.log(`hook session-start exit ${hook.status}, overlay.db unchanged: ${hookSame}`);
  console.log(gantry("heal"));

  map = await startMap();
  const res = await fetch(`${map.base}/api/overlay`, { headers: { "x-gantry-token": map.token } });
  const body = (await res.json()) as OverlayJson;
  await map.stop();
  console.log(`GET /api/overlay ${res.status}`);
  console.log(`labels: ${JSON.stringify(body.labels)}`);
  console.log(`unresolved: ${JSON.stringify(body.unresolved)}`);

  const ok =
    hook.status === 0 &&
    hookSame &&
    res.status === 200 &&
    body.labels.length === 1 &&
    body.labels[0]?.nodeId === NEW &&
    body.labels[0]?.text === TEXT &&
    body.unresolved.length === 0;
  console.log(ok ? "ok" : "FAILED");
  if (!ok) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Runner: recipe-agent runs on the real engine, through Claude Code headless (`claude -p`, no API key).
//   pnpm tsx docs/spikes/v2-recipe-agent-2/run.ts --repos <name>[,<name>...] [--runs 3] [--jobs 2] [--scratch dir]
// Needs `pnpm build` (plugin/dist/cli.js) and the pinned clones (`pnpm eval:clone`, in GANTRY_OSS_DIR).
// Per run: a fresh copy of the pinned clone (with .git, without node_modules) is the agent's working directory.
// The agent's only command is the product's `gantry recipe check` (the built CLI) on that copy; it writes
// .gantry/recipe.json there. The recipe is then scored with `pnpm eval:score <name> --recipe` against the
// committed labels. Kept (committed): runs/<name>/run<k>/{recipe.json,result.json,final.txt}; results.json
// collects them with sorted keys and no timestamps. The stream-json transcript stays in the scratch directory:
// it contains third-party code and is never committed.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
const cli = path.join(repoRoot, "plugin/dist/cli.js");
const ossDir = process.env.GANTRY_OSS_DIR || path.join(homedir(), "Dev", "gantry-oss");

interface RepoEntry {
  name: string;
  sha: string;
  stack: string[];
  role: string;
}
interface ScoreJson {
  kinds: Record<
    string,
    { labelled: number; predicted: number; matched: number; precision: number; recall: number; pass: boolean }
  >;
  missed: Record<string, string[]>;
  extra: Record<string, string[]>;
  pass: boolean;
}
interface RunResult {
  run: number;
  status: "ok" | "failed";
  failure?: string;
  model: string | null;
  turns: number | null;
  tokens: { input: number; cacheRead: number; cacheCreate: number; output: number } | null;
  costUsdReported: number | null;
  wallMs: number;
  checkRuns: number;
  recipeSha256: string | null;
  score: ScoreJson | null;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = (arg("--repos") ?? "").split(/[ ,]+/).filter(Boolean);
const RUNS = Number(arg("--runs") ?? 3);
const JOBS = Number(arg("--jobs") ?? 2);
const scratch = path.resolve(arg("--scratch") ?? mkdtempSync(path.join(tmpdir(), "recipe-agent-2-")));
mkdirSync(scratch, { recursive: true });

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
const stable = (v: unknown) => `${JSON.stringify(sortKeys(v), null, 2)}\n`;

/** The recipe-format paragraph of docs/SPEC.md section 5, so the agent reads what the engine accepts. */
function recipeFormat(): string {
  const lines = readFileSync(path.join(repoRoot, "docs/SPEC.md"), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("**Recipe (`.gantry/recipe.json`"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("**Built-in excludes:**"));
  if (from < 0 || to < 0) throw new Error("the recipe section of docs/SPEC.md moved: fix recipeFormat()");
  return lines.slice(from, to).join("\n").trim();
}

function agentFile(): string {
  return readFileSync(path.join(here, "agent.md"), "utf8").replace(
    "{{PROMPT}}",
    readFileSync(path.join(here, "prompt.md"), "utf8").replace("{{FORMAT}}", recipeFormat()),
  );
}

interface AgentRun {
  model: string | null;
  turns: number | null;
  tokens: RunResult["tokens"];
  costUsdReported: number | null;
  wallMs: number;
  checkRuns: number;
  final: string;
  error: string | null;
}

async function claudeRun(cwd: string, prompt: string, check: string, transcript: string): Promise<AgentRun> {
  const env = { ...process.env };
  env.ANTHROPIC_API_KEY = undefined;
  env.ANTHROPIC_AUTH_TOKEN = undefined;
  const args = [
    "-p",
    prompt,
    "--agent",
    "recipe-agent",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "Read,Grep,Glob,Write,Bash",
    "--allowedTools",
    `Read Grep Glob Edit(/${cwd}/.gantry/recipe.json) Bash(${check}:*)`,
    "--permission-mode",
    "default",
  ];
  const t0 = Date.now();
  return await new Promise<AgentRun>((resolve) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(transcript, out);
      let model: string | null = null;
      let result: Record<string, unknown> | null = null;
      let checkRuns = 0;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let j: Record<string, unknown>;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = j.message as
          | { model?: string; content?: { type: string; name?: string; input?: { command?: string } }[] }
          | undefined;
        if (j.type === "system" && typeof j.model === "string") model = j.model;
        if (j.type === "assistant" && msg?.model && msg.model !== "<synthetic>") model = msg.model;
        if (j.type === "assistant")
          for (const c of msg?.content ?? [])
            if (c.type === "tool_use" && c.name === "Bash" && c.input?.command?.includes("recipe check"))
              checkRuns++;
        if (j.type === "result") result = j;
      }
      const u = (result?.usage ?? {}) as Record<string, number>;
      resolve({
        model,
        turns: typeof result?.num_turns === "number" ? result.num_turns : null,
        tokens: result
          ? {
              input: u.input_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheCreate: u.cache_creation_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
            }
          : null,
        costUsdReported: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
        wallMs: Date.now() - t0,
        checkRuns,
        final: typeof result?.result === "string" ? result.result : "",
        error:
          result && result.is_error !== true
            ? null
            : `claude exit ${code}: ${result ? String(result.result).slice(0, 300) : err.slice(0, 300) || "no result message"}`,
      });
    });
  });
}

/** `pnpm eval:score <name> --recipe <file>` (exit 1 is a score below the bar, still JSON on stdout). */
function score(name: string, recipe: string): ScoreJson {
  try {
    const out = execFileSync(tsx, [path.join(repoRoot, "scripts/eval-score.ts"), name, "--recipe", recipe], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as ScoreJson;
  } catch (e) {
    const x = e as { status?: number; stdout?: string };
    if (x.status === 1 && x.stdout) return JSON.parse(x.stdout) as ScoreJson;
    throw e;
  }
}

async function oneRun(repo: RepoEntry, k: number): Promise<RunResult> {
  const clone = path.join(ossDir, `${repo.name}@${repo.sha.slice(0, 7)}`);
  const outDir = path.join(here, "runs", repo.name, `run${k}`);
  const resultFile = path.join(outDir, "result.json");
  if (existsSync(resultFile)) return JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
  mkdirSync(outDir, { recursive: true });
  const runDir = path.join(scratch, repo.name, `run${k}`);
  const work = path.join(runDir, "repo");
  rmSync(work, { recursive: true, force: true });
  cpSync(clone, work, { recursive: true, filter: (src) => !/(^|\/)node_modules$/.test(src) });
  mkdirSync(path.join(work, ".claude", "agents"), { recursive: true });
  mkdirSync(path.join(work, ".gantry"), { recursive: true });
  writeFileSync(path.join(work, ".claude", "agents", "recipe-agent.md"), agentFile());
  const check = `node ${cli} recipe check`;
  const prompt = `Write the recipe for this repository (your working directory). Check command: ${check} .gantry/recipe.json . Write the recipe to .gantry/recipe.json with the Write tool.`;
  const run = await claudeRun(work, prompt, check, path.join(runDir, "transcript.jsonl"));
  writeFileSync(path.join(outDir, "final.txt"), `${run.final}\n`);
  const base: RunResult = {
    run: k,
    status: "failed",
    model: run.model,
    turns: run.turns,
    tokens: run.tokens,
    costUsdReported: run.costUsdReported,
    wallMs: run.wallMs,
    checkRuns: run.checkRuns,
    recipeSha256: null,
    score: null,
  };
  let failure = run.error;
  const recipeFile = path.join(work, ".gantry", "recipe.json");
  if (!existsSync(recipeFile)) failure = failure ?? "the agent wrote no .gantry/recipe.json";
  else {
    const text = readFileSync(recipeFile);
    writeFileSync(path.join(outDir, "recipe.json"), text);
    base.recipeSha256 = sha256(text);
    try {
      base.score = score(repo.name, path.join(outDir, "recipe.json"));
    } catch (e) {
      failure = failure ?? `scoring failed: ${String((e as { stderr?: string }).stderr ?? e).slice(0, 300)}`;
    }
  }
  base.status = failure ? "failed" : "ok";
  if (failure) base.failure = failure;
  writeFileSync(resultFile, stable(base));
  console.log(
    `${repo.name} run${k}: ${base.status} pass=${base.score?.pass} turns=${base.turns} ${failure ?? ""}`,
  );
  return base;
}

async function main() {
  const all = (
    JSON.parse(readFileSync(path.join(repoRoot, "evals/oss/repos.json"), "utf8")) as { repos: RepoEntry[] }
  ).repos;
  const tuning = all.filter((r) => r.role === "tuning");
  for (const n of only)
    if (!tuning.some((r) => r.name === n)) throw new Error(`${n} is not a tuning repo in repos.json`);
  const repos = tuning.filter((r) => only.length === 0 || only.includes(r.name));
  if (!existsSync(cli)) throw new Error("plugin/dist/cli.js is missing: run pnpm build");
  const jobs: { repo: RepoEntry; k: number }[] = [];
  for (let k = 1; k <= RUNS; k++) for (const repo of repos) jobs.push({ repo, k });
  let next = 0;
  await Promise.all(
    Array.from({ length: JOBS }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++] as (typeof jobs)[number];
        try {
          await oneRun(j.repo, j.k);
        } catch (e) {
          console.log(`${j.repo.name} run${j.k}: runner error ${(e as Error).message}`);
        }
      }
    }),
  );
  // results.json from every committed run
  const out: unknown[] = [];
  for (const repo of tuning.filter((r) => existsSync(path.join(here, "runs", r.name)))) {
    const runs: RunResult[] = [];
    for (let k = 1; k <= RUNS; k++) {
      const f = path.join(here, "runs", repo.name, `run${k}`, "result.json");
      if (existsSync(f)) runs.push(JSON.parse(readFileSync(f, "utf8")) as RunResult);
    }
    out.push({ name: repo.name, sha: repo.sha, stack: repo.stack, runs });
  }
  writeFileSync(path.join(here, "results.json"), stable({ repos: out }));
}

await main();

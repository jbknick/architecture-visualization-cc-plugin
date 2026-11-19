// Runner: for each repo of the spike, three recipe-agent runs through Claude Code headless (`claude -p`, no API key),
// each from a fresh copy of the pinned clone. Scores every run with `pnpm eval:score` and writes results.json.
//   pnpm tsx docs/spikes/v2-recipe-agent/run.ts [--only name...] [--runs 3] [--jobs 4] [--scratch dir] [--pilot dir]
// Per run it keeps (committed): runs/<name>/run<k>/{recipe.json,dump.json,result.json,final.txt}. The stream-json
// transcript stays in the scratch directory: it contains third-party code and is never committed.
// Clones come from GANTRY_OSS_DIR (default ~/Dev/gantry-oss); nothing is written into them.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
const cli = path.join(here, "cli.ts");
const ossDir = process.env.GANTRY_OSS_DIR || path.join(homedir(), "Dev", "gantry-oss");

interface RepoEntry {
  name: string;
  sha: string;
  stack: string[];
  lang: string[];
  role: string;
}
interface Labels {
  route?: unknown[];
  endpoint?: unknown[];
  table?: unknown[];
  kinds: string[];
}
interface KindScore {
  labelled: number;
  predicted: number;
  matched: number;
  precision: number;
  recall: number;
  pass: boolean;
}
interface ScoreJson {
  kinds: Record<string, KindScore>;
  missed: Record<string, string[]>;
  extra: Record<string, string[]>;
  pass: boolean;
}
export interface RunResult {
  run: number;
  status: "ok" | "failed";
  failure?: string;
  model: string | null;
  turns: number | null;
  tokens: { input: number; cacheRead: number; cacheCreate: number; output: number } | null;
  costUsdReported: number | null;
  wallMs: number;
  recipeSha256: string | null;
  graphSha256: string | null;
  nodes: { route: number; endpoint: number; table: number } | null;
  zeroMatchRules: string[] | null;
  dryRuns: number;
  score: ScoreJson | null;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only: string[] = [];
{
  const i = process.argv.indexOf("--only");
  if (i >= 0)
    for (let j = i + 1; j < process.argv.length && !process.argv[j]?.startsWith("--"); j++)
      only.push(process.argv[j] as string);
}
const RUNS = Number(arg("--runs") ?? 3);
const RUNS_DIR = arg("--runs-dir") ?? "runs";
const RESULTS = arg("--results") ?? "results.json";
const JOBS = Number(arg("--jobs") ?? 4);
const scratch = path.resolve(arg("--scratch") ?? mkdtempSync(path.join(tmpdir(), "recipe-agent-")));
mkdirSync(scratch, { recursive: true });

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The agent definition as the run loads it: agent.md with the prompt and the dry-run command filled in. */
export function agentFile(dryRun: string): string {
  return readFileSync(path.join(here, "agent.md"), "utf8")
    .replace("{{DRYRUN}}", dryRun)
    .replace("{{PROMPT}}", readFileSync(path.join(here, "prompt.md"), "utf8"));
}

/** Copy a tree without `.git`, `node_modules` and build output. */
function freshCopy(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)$/.test(src),
  });
}

function countSource(dir: string, lang: string[]): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === ".git" || e === "dist" || e === "vendor") continue;
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        (lang.includes("ts") && /\.(ts|tsx|mts|cts)$/.test(e) && !/\.d\.ts$/.test(e)) ||
        (lang.includes("go") && e.endsWith(".go"))
      )
        n++;
    }
  };
  walk(dir);
  return n;
}

export interface AgentRun {
  model: string | null;
  turns: number | null;
  tokens: RunResult["tokens"];
  costUsdReported: number | null;
  wallMs: number;
  dryRuns: number;
  final: string;
  error: string | null;
}

/** One `claude -p` run in `cwd`; the stream-json transcript goes to `transcript`. */
export async function claudeRun(
  cwd: string,
  prompt: string,
  dryRun: string,
  transcript: string,
): Promise<AgentRun> {
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
    `Read Grep Glob Edit(/${cwd}/.gantry/recipe.json) Bash(${dryRun}:*)`,
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
      let dryRuns = 0;
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
            if (c.type === "tool_use" && c.name === "Bash" && c.input?.command?.includes("dry-run"))
              dryRuns++;
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
        dryRuns,
        final: typeof result?.result === "string" ? result.result : "",
        error:
          result && result.is_error !== true
            ? null
            : `claude exit ${code}: ${result ? String(result.result).slice(0, 300) : err.slice(0, 300) || "no result message"}`,
      });
    });
  });
}

export function scoreDump(name: string, dumpFile: string): ScoreJson | null {
  try {
    const out = execFileSync(
      tsx,
      [path.join(repoRoot, "scripts/eval-score.ts"), name, "--dump", dumpFile, "--labels", labelsFile(name)],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out) as ScoreJson;
  } catch (e) {
    const x = e as { status?: number; stdout?: string };
    if (x.status === 1 && x.stdout) return JSON.parse(x.stdout) as ScoreJson;
    throw e;
  }
}

/** Hand labels of a repo. Six repos were also labelled by another spike; the labels this spike scored against stay in ./labels. */
export const labelsFile = (name: string): string => {
  const own = path.join(here, "labels", `${name}.json`);
  return existsSync(own) ? own : path.join(repoRoot, "evals/oss/labels", `${name}.json`);
};

export const graphSha = (dump: { adapterNodes: { kind: string; data: Record<string, unknown> }[] }): string =>
  sha256(
    dump.adapterNodes
      .map((n) => `${n.kind} ${JSON.stringify(n.data)}`)
      .sort()
      .join("\n"),
  );

async function oneRun(repo: RepoEntry, k: number): Promise<RunResult> {
  const clone = path.join(ossDir, `${repo.name}@${repo.sha.slice(0, 7)}`);
  const outDir = path.join(here, RUNS_DIR, repo.name, `run${k}`);
  const result = path.join(outDir, "result.json");
  if (existsSync(result)) return JSON.parse(readFileSync(result, "utf8")) as RunResult;
  mkdirSync(outDir, { recursive: true });
  const work = path.join(scratch, repo.name, `run${k}`, "repo");
  freshCopy(clone, work);
  mkdirSync(path.join(work, ".claude", "agents"), { recursive: true });
  mkdirSync(path.join(work, ".gantry"), { recursive: true });
  const dryRun = `${tsx} ${cli} dry-run`;
  writeFileSync(path.join(work, ".claude", "agents", "recipe-agent.md"), agentFile(dryRun));
  const prompt = `Write the recipe for this repository (your working directory). Dry-run command: ${dryRun} --root . --recipe .gantry/recipe.json . Write the recipe to .gantry/recipe.json with the Write tool.`;
  const run = await claudeRun(
    work,
    prompt,
    dryRun,
    path.join(scratch, repo.name, `run${k}`, "transcript.jsonl"),
  );
  writeFileSync(path.join(outDir, "final.txt"), `${run.final}\n`);
  const recipeFile = path.join(work, ".gantry", "recipe.json");
  const base: RunResult = {
    run: k,
    status: "failed",
    model: run.model,
    turns: run.turns,
    tokens: run.tokens,
    costUsdReported: run.costUsdReported,
    wallMs: run.wallMs,
    recipeSha256: null,
    graphSha256: null,
    nodes: null,
    zeroMatchRules: null,
    dryRuns: run.dryRuns,
    score: null,
  };
  let failure = run.error;
  const emptyDump = { files: [], edges: [], adapterNodes: [] };
  const dumpFile = path.join(outDir, "dump.json");
  if (!existsSync(recipeFile)) failure = failure ?? "the agent wrote no .gantry/recipe.json";
  else {
    const text = readFileSync(recipeFile);
    writeFileSync(path.join(outDir, "recipe.json"), text);
    base.recipeSha256 = sha256(text);
    try {
      execFileSync(
        tsx,
        [
          cli,
          "index",
          "--root",
          work,
          "--recipe",
          recipeFile,
          "--dump",
          dumpFile,
          "--out",
          path.join(scratch, repo.name, `run${k}`, "engine-output.json"),
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (e) {
      const x = e as { stdout?: string };
      failure =
        failure ??
        `the final recipe is not accepted: ${(x.stdout ?? "").split("\n").slice(0, 3).join(" ").slice(0, 300)}`;
    }
  }
  if (!existsSync(dumpFile)) writeFileSync(dumpFile, `${JSON.stringify(emptyDump)}\n`);
  const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as {
    adapterNodes: { kind: string; data: Record<string, unknown> }[];
  };
  base.graphSha256 = graphSha(dump);
  base.nodes = {
    route: dump.adapterNodes.filter((n) => n.kind === "route").length,
    endpoint: dump.adapterNodes.filter((n) => n.kind === "endpoint").length,
    table: dump.adapterNodes.filter((n) => n.kind === "table").length,
  };
  const eo = path.join(scratch, repo.name, `run${k}`, "engine-output.json");
  if (existsSync(eo))
    base.zeroMatchRules = (
      JSON.parse(readFileSync(eo, "utf8")) as { zeroMatchRules: string[] }
    ).zeroMatchRules;
  base.score = scoreDump(repo.name, dumpFile);
  base.status = failure ? "failed" : "ok";
  if (failure) base.failure = failure;
  writeFileSync(result, `${JSON.stringify(base, null, 2)}\n`);
  console.log(
    `${repo.name} run${k}: ${base.status} pass=${base.score?.pass} turns=${base.turns} ${failure ?? ""}`,
  );
  return base;
}

async function main() {
  const repos = (
    JSON.parse(readFileSync(path.join(repoRoot, "evals/oss/repos.json"), "utf8")) as { repos: RepoEntry[] }
  ).repos.filter((r) => r.role === "tuning" && (only.length === 0 || only.includes(r.name)));
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
  const all = JSON.parse(readFileSync(path.join(repoRoot, "evals/oss/repos.json"), "utf8")) as {
    repos: RepoEntry[];
  };
  const out: unknown[] = [];
  for (const repo of all.repos.filter(
    (r) => r.role === "tuning" && existsSync(path.join(here, RUNS_DIR, r.name)),
  )) {
    const labels = JSON.parse(readFileSync(labelsFile(repo.name), "utf8")) as Labels;
    const clone = path.join(ossDir, `${repo.name}@${repo.sha.slice(0, 7)}`);
    const runs: RunResult[] = [];
    for (let k = 1; k <= RUNS; k++) {
      const f = path.join(here, RUNS_DIR, repo.name, `run${k}`, "result.json");
      if (existsSync(f)) runs.push(JSON.parse(readFileSync(f, "utf8")) as RunResult);
    }
    out.push({
      name: repo.name,
      sha: repo.sha,
      stack: repo.stack,
      files: countSource(clone, repo.lang),
      labels: {
        route: labels.route?.length ?? 0,
        endpoint: labels.endpoint?.length ?? 0,
        table: labels.table?.length ?? 0,
      },
      kinds: labels.kinds,
      runs,
    });
  }
  writeFileSync(path.join(here, RESULTS), `${JSON.stringify({ jobs: JOBS, repos: out }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

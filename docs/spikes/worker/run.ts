// Spike for issue #2: can Gantry call Haiku through the user's Claude Code login with a locked-down `claude -p`?
// Usage: pnpm tsx docs/spikes/worker/run.ts [--n 10] [--claude <path>] [--model haiku] [--effort low]
//        pnpm tsx docs/spikes/worker/run.ts --matrix | --timing | --effort-env | --recursion | --version
// Default mode runs the spec section 16 recipe once on N synthetic fact sheets and prints the parsed
// descriptions plus token counts. Fact sheets are synthetic; nothing from a private repo is used.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArgs,
  makeFactSheets,
  mdTable,
  median,
  type Outcome,
  type ParsedRun,
  parseInit,
  parseRun,
  RESULTS_SCHEMA,
  type RecipeFlag,
  renderFactSheets,
  SYSTEM_PROMPT,
  shellQuote,
  validateResults,
} from "./lib.js";

const TIMEOUT_MS = 120_000;

interface Cli {
  n: number;
  claude: string;
  model: string;
  effort: string;
  reps: number;
  mode: "recipe" | "matrix" | "timing" | "effort-env" | "recursion" | "version";
}

function parseCli(argv: string[]): Cli {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (["matrix", "timing", "effort-env", "recursion", "version"] as const).find((m) =>
    argv.includes(`--${m}`),
  );
  return {
    n: Number(get("--n") ?? 3),
    claude: get("--claude") ?? process.env.GANTRY_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? "claude",
    model: get("--model") ?? "haiku",
    effort: get("--effort") ?? "low",
    reps: Number(get("--reps") ?? 3),
    mode: mode ?? "recipe",
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
}

/** Spawn with stdin piped and a 120 s timeout. Never logs env values. */
function run(
  bin: string,
  args: string[],
  stdin: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      stderr += String(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, wallMs: Math.round(performance.now() - t0) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** The env the worker gets: guard on, effort override removed (spec section 16). */
function workerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GANTRY_WORKER: "1", ...extra };
  if (!("CLAUDE_CODE_EFFORT_LEVEL" in extra)) delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}

/** A scratch dir with a project MCP server, a CLAUDE.md and a project skill, so leaks are visible. */
function makeScratch(): { dir: string; promptFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "gantry-worker-spike-"));
  const server = join(dir, "stub-mcp.mjs");
  writeFileSync(
    server,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "spike-stub", version: "0.0.1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "spike_ping", description: "ping", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
  );
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "spike-stub": { command: "node", args: [server] } } }),
  );
  writeFileSync(join(dir, "CLAUDE.md"), "# Scratch project\nSpike scratch dir.\n");
  const skillDir = join(dir, ".claude", "skills", "spike-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: spike-skill\ndescription: scratch skill used to detect customization leaks\n---\nNothing.\n",
  );
  const promptFile = join(dir, "system-prompt.txt");
  writeFileSync(promptFile, SYSTEM_PROMPT);
  return { dir, promptFile };
}

function authStatus(bin: string): { loggedIn: boolean; authMethod: string } {
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8", env: workerEnv() });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: j.loggedIn === true, authMethod: String(j.authMethod ?? "unknown") };
  } catch {
    return { loggedIn: false, authMethod: "unparseable" };
  }
}

function version(bin: string): string {
  return spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
}

async function recipeOnce(
  cli: Cli,
  n: number,
  scratch: { dir: string; promptFile: string },
  drop: ReadonlySet<RecipeFlag> = new Set(),
  env: NodeJS.ProcessEnv = workerEnv(),
): Promise<{ raw: RunResult; parsed: ParsedRun; keys: string[] }> {
  const sheets = makeFactSheets(n);
  const args = buildArgs({
    model: cli.model,
    effort: cli.effort,
    systemPromptFile: scratch.promptFile,
    schema: RESULTS_SCHEMA,
    drop,
  });
  const raw = await run(cli.claude, args, renderFactSheets(sheets), { cwd: scratch.dir, env });
  return {
    raw,
    parsed: parseRun(raw.stdout, raw.stderr, raw.timedOut),
    keys: sheets.map((s) => s.contentKey),
  };
}

const fmtMs = (ms: number) => (Number.isNaN(ms) ? "n/a" : `${Math.round(ms)} ms`);

async function modeRecipe(cli: Cli): Promise<number> {
  const auth = authStatus(cli.claude);
  console.log(`claude ${version(cli.claude)}; auth loggedIn=${auth.loggedIn} method=${auth.authMethod}`);
  if (!auth.loggedIn) {
    console.error(
      "Not logged in: `claude auth status` reports loggedIn=false. Run `claude auth login` in a terminal, then re-run.",
    );
    return 2;
  }
  const scratch = makeScratch();
  const { raw, parsed, keys } = await recipeOnce(cli, cli.n, scratch);
  console.log(`outcome=${parsed.outcome} wall=${fmtMs(raw.wallMs)} api=${fmtMs(parsed.apiMs ?? Number.NaN)}`);
  if (parsed.outcome !== "ok") {
    console.error(parsed.resultText ?? raw.stderr.split("\n")[0] ?? "");
    return 1;
  }
  const check = validateResults(parsed.structured, keys);
  for (const r of (parsed.structured as { results: Array<{ content_key: string; description: unknown }> })
    .results) {
    console.log(`${r.content_key}  ${JSON.stringify(r.description)}`);
  }
  const u = parsed.usage;
  console.log(
    `tokens: input=${u?.inputTokens} output=${u?.outputTokens} cache_creation=${u?.cacheCreationTokens} cache_read=${u?.cacheReadTokens} cost_usd=${parsed.costUsd}`,
  );
  if (u && cli.n > 0) {
    console.log(
      `per function: output=${(u.outputTokens / cli.n).toFixed(1)} input=${(u.inputTokens / cli.n).toFixed(1)}`,
    );
  }
  console.log(`schema/length checks: ${check.ok ? "pass" : `FAIL ${check.problems.join("; ")}`}`);
  return check.ok ? 0 : 1;
}

/** Flag matrix: init probe (offline-safe, shows what loads) plus a live run (needs login). */
async function modeMatrix(cli: Cli): Promise<number> {
  const scratch = makeScratch();
  const auth = authStatus(cli.claude);
  const variants: Array<{ label: string; drop: RecipeFlag[] }> = [
    { label: "full recipe", drop: [] },
    { label: "drop --safe-mode", drop: ["safe-mode"] },
    { label: "drop --strict-mcp-config", drop: ["strict-mcp-config"] },
    { label: "drop --json-schema", drop: ["json-schema"] },
    { label: "drop --safe-mode and --strict-mcp-config", drop: ["safe-mode", "strict-mcp-config"] },
    { label: "drop --tools ''", drop: ["tools"] },
    { label: "drop --disallowedTools", drop: ["disallowedTools"] },
    { label: "drop --no-session-persistence", drop: ["no-session-persistence"] },
  ];
  const rows: string[][] = [];
  for (const v of variants) {
    const drop = new Set(v.drop);
    const probeArgs = buildArgs({
      model: cli.model,
      effort: cli.effort,
      systemPromptFile: scratch.promptFile,
      schema: RESULTS_SCHEMA,
      drop,
      outputFormat: "stream-json",
    });
    const probe = await run(cli.claude, probeArgs, "x\n", { cwd: scratch.dir, env: workerEnv() });
    const init = parseInit(probe.stdout);
    const probeErr = init ? "" : ((probe.stderr || probe.stdout).split("\n")[0]?.slice(0, 80) ?? "");
    let live = "pending (not logged in)";
    let structured = "pending";
    if (auth.loggedIn) {
      const outcomes: Outcome[] = [];
      for (let i = 0; i < cli.reps; i++)
        outcomes.push((await recipeOnce(cli, 3, scratch, drop)).parsed.outcome);
      live = outcomes.join(",");
      structured = `${outcomes.filter((o) => o === "ok").length}/${cli.reps}`;
    }
    rows.push([
      v.label,
      init ? "accepted" : `rejected: ${probeErr}`,
      init ? String(init.tools.length) : "-",
      init ? init.mcpServers.join(",") || "none" : "-",
      init ? `${init.skills} / ${init.slashCommands}` : "-",
      structured,
      live,
    ]);
  }
  console.log(
    mdTable(
      [
        "Variant",
        "CLI parse",
        "tools loaded",
        "MCP servers loaded",
        "skills / slash cmds",
        "structured_output ok",
        "live outcomes",
      ],
      rows,
    ),
  );
  return 0;
}

async function modeTiming(cli: Cli): Promise<number> {
  const auth = authStatus(cli.claude);
  if (!auth.loggedIn) {
    console.error(
      "Not logged in: timing needs live calls. Run `claude auth login`, then re-run with --timing.",
    );
    return 2;
  }
  const scratch = makeScratch();
  const cold: number[] = [];
  for (let i = 0; i < 5; i++) cold.push((await recipeOnce(cli, 1, scratch)).raw.wallMs);
  console.log(`cold start (n=1, 5 runs): ${cold.join(", ")} ms; median ${fmtMs(median(cold))}`);
  const rows: string[][] = [];
  for (const n of [1, 10, 40]) {
    const walls: number[] = [];
    let last: ParsedRun | undefined;
    let valid = "";
    for (let i = 0; i < 3; i++) {
      const r = await recipeOnce(cli, n, scratch);
      walls.push(r.raw.wallMs);
      last = r.parsed;
      if (r.parsed.outcome === "ok")
        valid = validateResults(r.parsed.structured, r.keys).ok ? "pass" : "FAIL";
      else valid = r.parsed.outcome;
    }
    const u = last?.usage;
    rows.push([
      String(n),
      fmtMs(median(walls)),
      String(u?.inputTokens ?? "-"),
      String(u?.outputTokens ?? "-"),
      u ? (u.outputTokens / n).toFixed(1) : "-",
      u ? ((u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens) / n).toFixed(1) : "-",
      valid,
    ]);
  }
  console.log(
    mdTable(
      [
        "fact sheets",
        "median wall (3 runs)",
        "input_tokens",
        "output_tokens",
        "output/fn",
        "all input/fn",
        "checks",
      ],
      rows,
    ),
  );
  return 0;
}

/** Does CLAUDE_CODE_EFFORT_LEVEL override --effort? Observable through output tokens and the CLI's own validation. */
async function modeEffortEnv(cli: Cli): Promise<number> {
  const scratch = makeScratch();
  const auth = authStatus(cli.claude);
  // Offline-observable: an invalid --effort value, with and without a valid env override.
  const bad = ["-p", "--model", cli.model, "--effort", "not-a-level", "--output-format", "json"];
  for (const [label, env] of [
    ["--effort invalid, env unset", workerEnv()],
    ["--effort invalid, env=high", workerEnv({ CLAUDE_CODE_EFFORT_LEVEL: "high" })],
  ] as const) {
    const r = await run(cli.claude, bad, "x\n", { cwd: scratch.dir, env });
    console.log(
      `${label}: exit=${r.exitCode} first line: ${(r.stderr || r.stdout).split("\n")[0]?.slice(0, 140)}`,
    );
  }
  if (!auth.loggedIn) {
    console.error("Live comparison pending: not logged in.");
    return 2;
  }
  const rows: string[][] = [];
  for (const [label, env] of [
    ["--effort low, env unset", workerEnv()],
    ["--effort low, env=max", workerEnv({ CLAUDE_CODE_EFFORT_LEVEL: "max" })],
  ] as const) {
    const outs: number[] = [];
    const walls: number[] = [];
    for (let i = 0; i < cli.reps; i++) {
      const r = await recipeOnce(cli, 3, scratch, new Set(), env);
      outs.push(r.parsed.usage?.outputTokens ?? Number.NaN);
      walls.push(r.raw.wallMs);
    }
    rows.push([label, outs.join(", "), fmtMs(median(walls))]);
  }
  console.log(mdTable(["Variant", "output_tokens per run", "median wall"], rows));
  return 0;
}

/**
 * Recursion check. A scratch repo has a stub "Gantry hook" registered as a Claude Code SessionStart hook
 * and as a git pre-commit hook. The stub honours GANTRY_WORKER=1 (spec section 1) and otherwise appends to a log.
 * The worker is started from inside the git pre-commit hook, with and without --safe-mode and the guard.
 */
async function modeRecursion(cli: Cli): Promise<number> {
  const scratch = makeScratch();
  const repo = scratch.dir;
  const log = join(repo, "hook.log");
  const stub = join(repo, "gantry-stub-hook.sh");
  writeFileSync(
    stub,
    `#!/bin/sh
# Stand-in for a Gantry hook entry point: guard first (spec section 1), then "do work" (log a line).
[ "$GANTRY_WORKER" = "1" ] && { echo "guard-exit $1" >> "${log}.guard"; exit 0; }
echo "fired $1" >> "${log}"
exit 0
`,
  );
  chmodSync(stub, 0o755);
  const sh = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
  sh(["init", "-q"]);
  sh(["config", "user.email", "spike@example.invalid"]);
  sh(["config", "user.name", "spike"]);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${stub} session-start` }] }] },
    }),
  );
  const workerCmd = (flags: string, guard: boolean): string =>
    `echo x | ${guard ? "GANTRY_WORKER=1 " : ""}${shellQuote([cli.claude])} -p --model ${cli.model} ${flags} --system-prompt-file ${shellQuote([scratch.promptFile])} --output-format json > /dev/null 2>&1`;
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const cases: Array<{ label: string; guard: boolean; flags: string }> = [
    { label: "no guard, no --safe-mode (positive control)", guard: false, flags: "--no-session-persistence" },
    { label: "GANTRY_WORKER=1, no --safe-mode", guard: true, flags: "--no-session-persistence" },
    { label: "GANTRY_WORKER=1, --safe-mode", guard: true, flags: "--safe-mode --no-session-persistence" },
  ];
  const rows: string[][] = [];
  for (const c of cases) {
    // The commit itself runs without the guard, as it would when a Claude Code session makes the commit.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GANTRY_WORKER;
    // The pre-commit hook runs the stub (the "real" hook, unguarded), then the worker.
    // Only the worker's own SessionStart hook line is the thing under test.
    const before = { fired: read(log), guarded: read(`${log}.guard`) };
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\nGANTRY_WORKER= ${stub} outer-pre-commit >/dev/null 2>&1\n${workerCmd(c.flags, c.guard)}\nexit 0\n`,
    );
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    writeFileSync(join(repo, "f.txt"), `${c.label}\n`);
    sh(["add", "f.txt"], env);
    sh(["commit", "-q", "-m", "spike"], env);
    const fired = read(log) - before.fired;
    rows.push([c.label, String(fired - 1), String(read(`${log}.guard`) - before.guarded)]);
  }
  console.log(
    mdTable(
      [
        "Worker invocation (inside git pre-commit)",
        "worker-side hook runs that did work",
        "worker-side guard exits",
      ],
      rows,
    ),
  );
  console.log("The outer pre-commit stub call is excluded from the counts (one log line per commit).");
  return 0;
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  switch (cli.mode) {
    case "version": {
      console.log(`claude ${version(cli.claude)}`);
      const a = authStatus(cli.claude);
      console.log(`auth loggedIn=${a.loggedIn} method=${a.authMethod}`);
      return 0;
    }
    case "matrix":
      return modeMatrix(cli);
    case "timing":
      return modeTiming(cli);
    case "effort-env":
      return modeEffortEnv(cli);
    case "recursion":
      return modeRecursion(cli);
    default:
      return modeRecipe(cli);
  }
}

process.exit(await main());

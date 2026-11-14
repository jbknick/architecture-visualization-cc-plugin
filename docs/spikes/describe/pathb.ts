// Path B for issue #6: a describer-style subagent draining the labelled set through a temporary MCP stub.
//   pnpm tsx docs/spikes/describe/pathb.ts --write-agent       regenerate describer.md from system-prompt.md
//   pnpm tsx docs/spikes/describe/pathb.ts --headless          headless approximation (one `claude -p` session)
//   pnpm tsx docs/spikes/describe/pathb.ts --finalize          turn evals/private/describe-out/path-b/events.jsonl
//                                                              into path-b/call-0.json (also used after an operator run)
// Raw events and descriptions stay under evals/private/ (git-ignored).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallRecord, here, labelledFile, loadLabelled, outDir, writeJson } from "./store.js";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const claude = process.env.GANTRY_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? "claude";
const pbDir = join(outDir, "path-b");
const SERVER = "gantrystub";
const TOOLS = [`mcp__${SERVER}__claim_batch`, `mcp__${SERVER}__submit`];

const LOOP = `
Work loop. You have exactly two tools. Make ONE tool call per turn: never call claim_batch twice without a submit in between, and never call tools in parallel.
1. Call claim_batch. If it returns QUEUE EMPTY, stop and reply "queue empty".
2. Describe every fact sheet in the batch and call submit once with { "results": [ { "content_key": "<key from the header>", "description": { "behavior", "searchTerms", "nameFits", "suggestedName"? } } ] }.
3. If submit reports rejected keys, fix exactly those descriptions and submit again.
4. Go back to step 1.
Reply with nothing but "queue empty" when finished.
`;

export function agentFile(): string {
  const prompt = readFileSync(join(here, "system-prompt.md"), "utf8").replace(
    /Return exactly one entry per fact sheet[^\n]*\n/,
    "Describe every fact sheet in the batch you claimed; submit one entry per fact sheet with content_key set to the key in its header and a description object.\n",
  );
  return `---
name: describer
description: Describes batches of function fact sheets claimed from the Gantry queue. Use to drain the description queue.
model: haiku
effort: low
maxTurns: 60
tools: ${TOOLS.join(", ")}
---
${prompt}${LOOP}`;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; wallMs: number; timedOut: boolean }>((resolve) => {
    const t0 = performance.now();
    const child = spawn(claude, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, wallMs: Math.round(performance.now() - t0), timedOut });
    });
  });
}

interface Ev {
  t: string;
  ev: string;
  key?: string;
  description?: unknown;
  n?: number;
  accepted?: number;
  rejected?: number;
}

/** Build path-b/call-0.json from the stub's event log. Throughput runs from the first claim to the last accepted submit. */
export function finalize(
  extra: Partial<Pick<CallRecord, "usage" | "costUsd">> & {
    modelUsage?: unknown;
    sessionWallMs?: number;
  } = {},
): void {
  const file = join(pbDir, "events.jsonl");
  if (!existsSync(file)) throw new Error("no events.jsonl: nothing was claimed");
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
  const accepts = events.filter((e) => e.ev === "accept");
  const first = events.find((e) => e.ev === "claim");
  const last = [...events].reverse().find((e) => e.ev === "submit");
  if (!first || !last) throw new Error("no claim/submit events");
  const spanMs = Date.parse(last.t) - Date.parse(first.t);
  const rows = loadLabelled();
  const rec: CallRecord & {
    functionsPerMinute: number;
    claims: number;
    submits: number;
    rejections: number;
  } = {
    label: "path-b describer subagent",
    model: "haiku",
    effort: "low",
    startedAt: first.t,
    endedAt: last.t,
    wallMs: spanMs,
    apiMs: 0,
    outcome: "ok",
    keys: rows.map((r) => r.factSheet.contentKey),
    structured: {
      results: accepts.map((e) => ({ content_key: e.key, description: e.description })),
    },
    functionsPerMinute: accepts.length / (spanMs / 60000),
    claims: events.filter((e) => e.ev === "claim").length,
    submits: events.filter((e) => e.ev === "submit").length,
    rejections: events.filter((e) => e.ev === "submit").reduce((a, e) => a + (e.rejected ?? 0), 0),
    ...extra,
  };
  writeJson(join(pbDir, "call-0.json"), rec);
  console.log(
    `path-b: ${accepts.length} accepted in ${(spanMs / 1000).toFixed(1)} s = ${rec.functionsPerMinute.toFixed(1)} functions/min; ${rec.claims} claims, ${rec.submits} submits, ${rec.rejections} rejected`,
  );
}

async function headless(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "gantry-pathb-"));
  mkdirSync(join(scratch, ".claude", "agents"), { recursive: true });
  writeFileSync(join(scratch, ".claude", "agents", "describer.md"), agentFile());
  const stub = join(here, "mcp-stub.mjs");
  const cfg = join(scratch, "mcp.json");
  mkdirSync(pbDir, { recursive: true });
  // Keep earlier attempts: move a stale event log aside instead of deleting it.
  if (existsSync(join(pbDir, "events.jsonl")))
    renameSync(join(pbDir, "events.jsonl"), join(pbDir, `events-${Date.now()}.jsonl`));
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        [SERVER]: {
          command: "node",
          args: [stub],
          env: { STUB_DATA: labelledFile, STUB_OUT: pbDir, STUB_BATCH: "40" },
        },
      },
    }),
  );
  const prompt =
    "Use the describer subagent to drain the description queue: invoke it with the prompt 'Drain the queue.' and, if it stops before reporting 'queue empty', invoke it again. Do not describe anything yourself. When the subagent reports 'queue empty', reply with the single word done.";
  const args = [
    "-p",
    prompt,
    "--model",
    "haiku",
    "--effort",
    "low",
    "--mcp-config",
    cfg,
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--allowedTools",
    `Agent,Task,${TOOLS.join(",")}`,
    "--no-session-persistence",
    "--output-format",
    "json",
    "--max-budget-usd",
    "5",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, GANTRY_WORKER: "1" };
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  const r = await run(args, scratch, env, 20 * 60_000);
  console.log(`claude exited; wall ${(r.wallMs / 1000).toFixed(1)} s${r.timedOut ? " (TIMED OUT)" : ""}`);
  let usage: CallRecord["usage"];
  let modelUsage: unknown;
  let costUsd: number | undefined;
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    const u = (j.usage ?? {}) as Record<string, number>;
    usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    };
    modelUsage = j.modelUsage;
    costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
    console.log(
      `result: is_error=${String(j.is_error)} turns=${String(j.num_turns)} subtype=${String(j.subtype)}`,
    );
  } catch {
    console.log(`stdout was not JSON; stderr starts: ${r.stderr.split("\n")[0]}`);
  }
  rmSync(scratch, { recursive: true, force: true });
  finalize({ usage, costUsd, modelUsage, sessionWallMs: r.wallMs });
}

if (flag("--write-agent")) {
  writeFileSync(join(here, "describer.md"), agentFile());
  console.log("wrote describer.md");
} else if (flag("--headless")) await headless();
else if (flag("--finalize")) finalize();
else console.error("usage: pathb.ts --write-agent | --headless | --finalize");

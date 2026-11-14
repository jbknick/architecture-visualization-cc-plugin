// Spike for issue #6: Haiku description quality via the headless worker recipe (Path A), Sonnet grading and the
// Sonnet retry of the worst items. Every step stores its raw output under evals/private/describe-out/ and skips
// work that is already stored, so a re-run never spends a model call twice.
//
// Usage (GANTRY_CLAUDE_BIN or --claude points at the binary):
//   pnpm tsx docs/spikes/describe/run.ts --path-a                 5 Haiku/low calls of 40 functions
//   pnpm tsx docs/spikes/describe/run.ts --grade a                Sonnet/low grading, 5 calls of 40
//   pnpm tsx docs/spikes/describe/run.ts --retry                  Sonnet/low rewrite of the 20 worst, 1 call
//   pnpm tsx docs/spikes/describe/run.ts --grade retry            grade the 20 retried items, 1 call
//   pnpm tsx docs/spikes/describe/run.ts --grade b                grade Path B output (see pathb.ts)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, parseRun, RESULTS_SCHEMA } from "../worker/lib.js";
import {
  chunk,
  GRADER_PROMPT,
  GRADES_SCHEMA,
  type LabelledRow,
  renderBatch,
  renderGradingBatch,
  summarize,
  worstKeys,
} from "./lib.js";
import {
  type CallRecord,
  descriptionsFrom,
  gradesFrom,
  here,
  loadCalls,
  loadLabelled,
  outDir,
  readJson,
  writeJson,
} from "./store.js";

const TIMEOUT_MS = 240_000;
const BATCH = 40;

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const claude =
  opt("--claude") ?? process.env.GANTRY_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? "claude";

function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GANTRY_WORKER: "1" };
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}

interface Raw {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
}

function spawnClaude(args: string[], stdin: string, cwd: string): Promise<Raw> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(claude, args, { cwd, env: workerEnv(), stdio: ["pipe", "pipe", "pipe"] });
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
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, wallMs: Math.round(performance.now() - t0) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

const scratch = mkdtempSync(join(tmpdir(), "gantry-describe-spike-"));
const graderFile = join(scratch, "grader-prompt.txt");
writeFileSync(graderFile, GRADER_PROMPT);
const describeFile = join(here, "system-prompt.md");

/** One locked-down recipe call (spec section 16). Stores and returns the record. */
async function call(opts: {
  label: string;
  model: string;
  systemPromptFile: string;
  schema: unknown;
  stdin: string;
  keys: string[];
  file: string;
}): Promise<CallRecord> {
  const args = buildArgs({
    model: opts.model,
    effort: "low",
    systemPromptFile: opts.systemPromptFile,
    schema: opts.schema,
  });
  const startedAt = new Date().toISOString();
  const raw = await spawnClaude(args, opts.stdin, scratch);
  const parsed = parseRun(raw.stdout, raw.stderr, raw.timedOut);
  const rec: CallRecord = {
    label: opts.label,
    model: opts.model,
    effort: "low",
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: raw.wallMs,
    apiMs: parsed.apiMs ?? 0,
    outcome: parsed.outcome,
    usage: parsed.usage,
    costUsd: parsed.costUsd,
    keys: opts.keys,
    structured: parsed.structured,
  };
  console.log(
    `${opts.label}: outcome=${rec.outcome} wall=${rec.wallMs} ms out=${rec.usage?.outputTokens ?? "n/a"} tokens`,
  );
  if (parsed.outcome === "ok") writeJson(opts.file, rec);
  else console.error(`not stored (${parsed.outcome}); fix and re-run the same step`);
  return rec;
}

function rowsByKey(rows: LabelledRow[]): Map<string, LabelledRow> {
  return new Map(rows.map((r) => [r.factSheet.contentKey, r]));
}

async function pathA(rows: LabelledRow[]): Promise<void> {
  const dir = join(outDir, "path-a");
  const batches = chunk(rows, BATCH);
  for (const [i, b] of batches.entries()) {
    const file = join(dir, `call-${i}.json`);
    if (existsSync(file)) {
      console.log(`path-a batch ${i}: stored, skipped`);
      continue;
    }
    await call({
      label: `path-a batch ${i}`,
      model: "haiku",
      systemPromptFile: describeFile,
      schema: RESULTS_SCHEMA,
      stdin: renderBatch(b.map((r) => r.factSheet)),
      keys: b.map((r) => r.factSheet.contentKey),
      file,
    });
  }
}

/** Items to grade for one path: the stored descriptions (with behavior) joined to their rows. */
function gradingTargets(
  which: string,
  rows: LabelledRow[],
): { items: LabelledRow[]; descs: Map<string, unknown> } {
  if (which === "a")
    return { items: rows, descs: descriptionsFrom(loadCalls(join(outDir, "path-a"), "call")) };
  if (which === "b") {
    const subs = readJson<CallRecord>(join(outDir, "path-b", "call-0.json"));
    return { items: rows, descs: descriptionsFrom(subs ? [subs] : []) };
  }
  const calls = loadCalls(join(outDir, "retry"), "call");
  const descs = descriptionsFrom(calls);
  const byKey = rowsByKey(rows);
  return { items: [...descs.keys()].map((k) => byKey.get(k)).filter((r): r is LabelledRow => !!r), descs };
}

async function grade(which: string, rows: LabelledRow[]): Promise<void> {
  const dir = join(outDir, which === "retry" ? "retry" : `path-${which}`);
  const { items, descs } = gradingTargets(which, rows);
  const withText = items.map((row) => {
    const d = descs.get(row.factSheet.contentKey) as { behavior?: unknown } | undefined;
    const candidate = typeof d?.behavior === "string" ? d.behavior : "(no description produced)";
    return { row, candidate };
  });
  for (const [i, b] of chunk(withText, BATCH).entries()) {
    const file = join(dir, `grade-${i}.json`);
    if (existsSync(file)) {
      console.log(`grade ${which} batch ${i}: stored, skipped`);
      continue;
    }
    await call({
      label: `grade ${which} batch ${i}`,
      model: "sonnet",
      systemPromptFile: graderFile,
      schema: GRADES_SCHEMA,
      stdin: renderGradingBatch(b),
      keys: b.map((x) => x.row.factSheet.contentKey),
      file,
    });
  }
}

async function retry(rows: LabelledRow[]): Promise<void> {
  const file = join(outDir, "retry", "call-0.json");
  if (existsSync(file)) {
    console.log("retry: stored, skipped");
    return;
  }
  const descs = descriptionsFrom(loadCalls(join(outDir, "path-a"), "call"));
  const grades = gradesFrom(loadCalls(join(outDir, "path-a"), "grade"));
  const s = summarize(rows, descs, grades);
  const worst = worstKeys(s.items, 20);
  const byKey = rowsByKey(rows);
  const sheets = worst.map((k) => (byKey.get(k) as LabelledRow).factSheet);
  await call({
    label: "retry worst 20 (sonnet)",
    model: "sonnet",
    systemPromptFile: describeFile,
    schema: RESULTS_SCHEMA,
    stdin: renderBatch(sheets),
    keys: worst,
    file,
  });
}

async function main(): Promise<void> {
  const rows = loadLabelled();
  if (flag("--path-a")) await pathA(rows);
  else if (flag("--retry")) await retry(rows);
  else if (opt("--grade")) await grade(opt("--grade") as string, rows);
  else {
    console.error("usage: run.ts --path-a | --grade a|b|retry | --retry");
    process.exitCode = 2;
  }
}

await main();
